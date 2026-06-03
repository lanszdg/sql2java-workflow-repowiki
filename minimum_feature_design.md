# sql2java 端到端转译 MVP 方案（最终版）

## Context

**核心架构**：TypeScript 插件实现确定性状态机引擎 + Agent 定义为 .md prompt 文件 + 命令驱动的入口。LLM 通过 `workflow` 工具操作状态机，每个阶段自动切换对应 Agent 的 system prompt。

**输入**：一组 PL/SQL 文件（.sql / .pks / .pkb）
**输出**：可编译的 Java 项目（Spring Boot + MyBatis + Lombok） + 转译过程记录（artifacts）

---

## 整体架构

```
/sql2java <path>
  │
  ▼
┌──────────────────────────────────────────────────┐
│  command/sql2java.md                              │
│  参数解析 → 路由分发 → workflow 工具调用            │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│  预扫描（确定性，不占 LLM 上下文）                   │
│  @griffithswaite/ts-plsql-parser (AST)            │
│  安装失败 → regex 降级                             │
│  产出：inventory-index.json                       │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
  inventory → analyze → plan（人工确认）→ scaffold → translate → review → verify → 完成
                                                               │            │
                                                               ↓ (failed)   ↓ (failed)
                                                               fix ←────────┘
                                                               │
                                                               └→ 增量回到触发阶段（review 或 verify）
```

单流水线，7 个阶段 + 1 个条件分支阶段（fix），一个 runId，无条件前进 + review/verify 失败时进入 fix 循环（增量重做）。

---

## 项目结构

```
sql2java-workflow/
├── command/
│   └── sql2java.md                 # /sql2java 命令入口
├── agent/
│   ├── sql-analyst.md              # inventory + analyze 阶段
│   ├── java-architect.md           # plan + scaffold 阶段
│   ├── translator.md               # translate + fix 阶段
│   └── reviewer.md                 # review + verify 阶段
├── workflow/
│   ├── engine-core.ts              # 状态机核心
│   ├── workflow-definitions.ts     # 工作流定义 + TransitionRule
│   ├── artifact-schemas.ts         # Artifact Zod Schemas（独立文件）
│   ├── plsql-scanner.ts            # PL/SQL AST/regex 预扫描器
│   └── type-mappings.ts            # Oracle → Java 类型映射表
├── plugin/
│   └── workflow-engine.ts          # 插件入口（workflow 工具 + hooks）
└── README.md
```

---

## 设计决策汇总

### D1: advance condition 判定

LLM 传入 `result: "passed" | "failed"`（可选，见 D8 自动推导）。引擎根据 `result` 值匹配 TransitionRule。`condition: "always"` 阶段（inventory、analyze、plan、scaffold、translate）advance 时忽略 result 参数，失败走 retry/abort 路径。fix 阶段 result 必填（D3）。

### D2: fix 循环双层 exhausted 策略

- 从 `phaseHistory` 实时计算 fix 次数（过滤 `phase === "fix"` 的 entries）
- `globalMax = 3`（宽松），`phaseMax = 2`（严格）
- 任一达限即 exhausted → `completed_with_issues`
- 单一数据源，无状态漂移风险
- **已知限制**：当前仅计迭代次数，不检测 fix 是否产生实际变更（LLM 可能重复提交相同代码耗尽配额）；后续迭代可在 advanceFromFix 时比较 Java 文件内容哈希，检测无效修复

### D3: fix 增量重做

- fix 完成后只重审 fix 修改过的包，不全量重做
- fix 阶段产出 `FixArtifact { fixedPackages }`
- fix 契约：必须修复全部 mustFix 项
- **fix 失败处理**：修不完时 advance(result="failed") → 引擎标记当前 entry 为 failed，检查 isFixExhausted；未 exhausted 时返回 fixFailed=true + rejectionReason（区别于 Zod/D8/D12 的 rejected=true，fixFailed 明确告知 LLM 调用 retry() 重试）；exhausted 时 → completed_with_issues。注意：fix-failed 时插件跳过 artifact Zod 校验，因为 agent 可能无法写出有效的 fix.json
- 引擎通过 `incrementalContext.targetPackages` 传递给 review/verify
- 未修改包的 review.json / verify.json 保持不变
- **已知限制**：增量 review 不检测 fix 对未修改包的间接影响（如修改被其他包依赖的 shared utility）；verify 阶段的全局编译作为兜底校验此类跨包回归

### D4: confirm 时序（B 方案）

- advance 返回 `waitingForConfirmation=true` 时，**不激活 agent**，不切换 system prompt
- 用户调用 confirm 后，状态从 paused → running，此时才切换 system prompt 并激活 agent
- 第一个 phase（inventory）不需要 confirm，start 后直接激活
- `--phases` 连续 advance 时自动 confirm `requiresConfirmation` 阶段

### D5: artifact 写入

- **agent 自己写 artifact 文件**，用 write 工具写入指定路径
- advance 时 workflow 工具从磁盘读取并做 Zod 校验
- per-package artifact（translation.json / review.json / verify.json）逐包写入，支持崩溃恢复
- 顶层 artifact 同样由 agent 写入，保持一致性

### D6: 持久化

- `run.json` 全量单文件存储在 `.workflow-artifacts/{runId}/run.json`
- 每次 advance / retry / confirm / abort 都写入
- 从 JSON 重建 WorkflowRun 对象，字段完备可直接反序列化

### D7: fix transition 动态路由

- fix 的 `to` 不在 TransitionRule 中写死
- 引擎从 `phaseHistory` 中最后 fix entry 的 `branchedFrom` 动态取目标阶段
- advanceFromFix 完成后 **early-return**，不走 TransitionRule 匹配

### D8: advance 流程 result 校验

- review/verify 阶段 advance 时，引擎从 summary 的 `allPassed` **自动推导 result**：`allPassed ? 'passed' : 'failed'`
- LLM 传入的 `result` 为可选参数，若传入则作为防御性校验：与 `allPassed` 不一致时拒绝 advance
- `result === "passed"` 且 `allPassed === false` → 拒绝 advance
- `result === "failed"` 且 `allPassed === true` → 拒绝 advance（避免 mustFix 为空时浪费 fix 循环配额）
- **与 per-package ReviewSchema / VerifySchema refine 的关系**：per-package 的 `passed=false` 要求 `mustFix` 非空（双向约束），确保每个标记为失败的包都有具体问题；`allPassed=true` 意味着所有包 passed=true（mustFix 全为空），此时 result 应为 "passed"，若为 "failed" 则是 LLM 判断矛盾，应拒绝让 LLM 重新评估

### D9: 跨 Schema 校验时机

- inventory 完成后：plugin 层 `validateInventoryPackages` 校验 inventory-index ↔ inventory.packageNames 一致（在 Zod 校验阶段完成，提前发现不一致）
- analyze 完成后：校验 inventory ↔ analysis 包名一致
- plan 完成后：校验 inventory ↔ analysis ↔ plan 映射完整
- 校验失败记录 warning 到 `_events.log`，不阻塞流程
- **双格式兼容**：inventory 侧从 `packageNames`（新格式）或 `packages[].name`（旧格式回退）取包名；analysis 侧同样 `packageNames` 优先、`packages[].name` 回退。确保新旧格式的 artifact 都能正确校验

### D10: SCC 循环依赖处理

- SCC 组只在 `translationOrder` 中体现为同层数组（如 `["pkgA", "pkgB"]`）
- 各包保持独立目录结构和数据模型，不使用合成名
- translator 遇到同层多包时按顺序依次翻译，SCC 只影响翻译顺序约束

### D11: system prompt 精确注入

- plugin 构建时只 slice 当前 phase 对应的 `## Phase: xxx` section
- 保留文件头的角色定义和通用规则
- 不注入其他 phase 分节，避免 LLM 执行错误指令

### D12: FixArtifact 包名校验

- fix 阶段产出的 `fixedPackages` 值必须使用 inventory 中的 Oracle 包名（如 `INVENTORY_PKG`）
- 引擎在 advanceFromFix 时校验每个值是否存在于 `inventory.packageNames`（新格式优先，旧格式回退 `inventory.packages[].name`）
- **校验失败直接拒绝 advance**（视为 fix failed，走 retry 路径），不使用 filter+warn 策略——若 fix agent 连包名都搞不对，说明 prompt 不够清晰或 fix 工作本身有问题，应暴露出来让 agent 重试
- **校验 fixedPackages 为触发阶段失败包的超集**：从触发阶段的 summary 中提取 `passed=false` 的包名集合，`fixedPackages` 必须包含该集合（允许修复额外包，但不能遗漏失败包）；校验失败同样拒绝 advance
- 防止 fix agent 使用 Java 风格包名或遗漏失败包导致增量审查跳过实际有问题的包

### D13: FSD 文档生成策略（路径 A：轻量集成）

- FSD（Functional Specification Document）作为 **analyze 阶段的副产物**，由 sql-analyst 在逐包解析子程序结构时同步生成
- 格式为 Markdown，不参与 Zod 校验，不参与 advance 流程
- **粒度**：per-subprogram（每个子程序一个 FSD），因为 6 板块模板围绕单个子程序设计；复杂包可能有 10+ 子程序，per-package 会产生过长的单一文件
- 存储路径：`.workflow-artifacts/{runId}/fsd/{package}/{subprogram}.md`
- `plan` 和 `translate` 阶段可参考 FSD，但不强制消费
- **消解规则**：当 FSD 内容与 `analysis.json` / `inventory.json` 不一致时，以 JSON artifact 为准（FSD 是派生文档）
- FSD 的价值：将 `analysis.json` 中散落的翻译注意事项集中、结构化成人类可读的文档
- **后续演进**：验证 FSD 格式实用性后，可升级为正式阶段（路径 B），新增 `fsd` phase + Zod Schema 校验

---

## Agent 定义（4 个）

**多阶段分发机制**：一个 agent .md 覆盖多个阶段（如 sql-analyst 覆盖 inventory + analyze）。plugin 在 phase 变更时构建 system prompt，将 `currentPhase` 作为 Runtime Context 注入。agent .md 按 `## Phase: inventory` / `## Phase: analyze` 分节编写，由注入的 phase 名决定执行哪部分。

### 1. sql-analyst（结构分析）

**对应阶段**：inventory、analyze
**温度**：0.1
**工具**：read、bash、write、workflow
- 基于 `inventory-index.json`（预扫描索引）分批读取源码
- 逐包补充 AST 无法提取的语义细节（参数类型、默认值、type 定义、变量、常量）
- **分批处理**：每批 2-3 个包，只读当前批次的源码，处理完立即写入磁盘
- 产出 `inventory-packages/{PKG}.json`（逐包）+ `inventory.json`（索引 + DDL 数据）
- **预扫描由引擎在 start 时自动执行**（确定性扫描，不占 LLM 上下文）

**analyze 职责**：
- 基于 inventory 构建调用依赖图
- 拓扑排序确定翻译顺序
- SCC 循环依赖检测 → 归为同层数组（如 `["pkgA", "pkgB"]`），各包保持独立
- 复杂度评估（1-10 分）
- **逐包解析子程序内部结构**：语句块（loop / cursor / if-else / exception / SQL / assignment / call）、变量作用域、游标定义、异常处理器 + 翻译注意事项
- **内部分步（三轮）**：第一轮产出全局依赖图和拓扑排序（轻量）；第二轮逐包子程序结构解析（blocks / variables / cursors），每完成一个子程序立即写入 analysis.json；第三轮逐子程序生成 FSD 文档，每完成一个立即写入磁盘（详见 FSD 文档设计章节）
- 产出 `analysis.json` + `analysis-packages/{pkg}.json`（逐包）
- **副产物：逐子程序生成 FSD 文档**（`fsd/{package}/{subprogram}.md`），与子程序结构解析同步产出，每处理完一个子程序立即写入，避免中途崩溃丢失（D13）

### 2. java-architect（架构设计）

**对应阶段**：plan、scaffold
**温度**：0.2
**工具**：read、bash、write、edit、workflow

**plan 职责**：
- 根据 `inventory-index.json`（全局视图）+ `inventory-packages/{PKG}.json`（按需细节）+ `analysis.json` 规划 Java 项目结构
- 确定 Spring Boot 版本、MyBatis 类型、包命名
- 设计类型映射规则、异常策略（默认 `custom-business`）、命名约定
- 引用 analysis.json 中的 translationOrder 确定翻译顺序
- 产出 `plan.json`（含 CONVENTIONS 规则）

**scaffold 职责**：
- 生成 Maven 项目骨架（pom.xml、目录结构）
- 生成 common 模块（类型映射工具类、异常体系、基础配置）
- 生成 Entity 类（从 `inventory.json` 中的 tables + `inventory-packages` 中的 types）
- 生成空的 Mapper 接口和 Service 壳
- 产出 `scaffold.json`（含 `basedOnPlanHash` 关联 plan 版本）+ 实际 Java 文件

### 3. translator（转译执行）

**对应阶段**：translate、fix
**温度**：0.1
**工具**：read、bash、write、edit、workflow

**translate 职责**：
- 读取 `inventory-index.json` 获取全局包名和依赖顺序，读取 `analysis.json` 中的 `translationOrder`，按拓扑序逐包翻译
- 根据 `plan.json` 中的映射规则和 CONVENTIONS
- 需要包细节时读取 `inventory-packages/{当前包}.json`
- 逐个子程序翻译为 Java 代码（Mapper 接口 + XML + Service + DTO）
- **逐包持久化**：每翻译完一个包，立即将结果写入 `translations/{package}/translation.json` + Java 文件到项目目录
- **中断恢复**：retry 时检查已有 `translation.json`，跳过 status=completed 的包；对 status=partial 的包，读取 `completedSubprograms` 跳过已完成的子程序，只翻译剩余子程序
- 记录翻译决策和 TODO 标记

**fix 职责**：
- 根据 review/verify 的 mustFix 列表修复对应包的翻译问题
- **修复范围**：修全部 mustFix 项（可能跨多个包）
- 不改变整体结构，只修正具体错误
- 产出更新后的 Java 文件 + 更新对应包的 translation.json
- **产出 fix.json**：`{ fixedPackages: string[] }`，写入 `${artifactsDir}/fix.json`，遵循 D5 统一管线（agent 写磁盘 → advance 磁盘读取 Zod 校验）
- **契约**：必须修复全部 mustFix 项，修不完则 advance result="failed" 走 retry

**翻译五原则**：
1. 不重构 — 保持原有逻辑结构
2. 不优化 — 游标循环就是 for-each
3. 不合并 — 分立的 SELECT 保持独立
4. 不省略 — 每条 PL/SQL 都要有对应 Java
5. 不猜测 — 不确定的标 `// TODO: [translate]`

### 4. reviewer（审核验证）

**对应阶段**：review、verify
**温度**：0.1
**工具**：read、bash、write、workflow

**review 职责**：
- **按包独立审查，逐包持久化**：每审完一个包立即写入 `translations/{package}/review.json`，避免中途崩溃丢失已完成结果
- 对照 `analysis-packages/{pkg}.json` 中的子程序结构检查翻译逻辑完整性
- 10 类审查清单：逻辑等价、SQL 完整性、空值处理、类型映射、异常映射、事务边界、游标映射、参数方向、命名一致性、TODO 残留统计
- 全部包审完后产出顶层 `review-summary.json`
- **增量模式支持**：当 `incrementalContext.targetPackages` 存在时，只审查指定包，未修改包的 review.json 保持不变
- **增量 summary 合并**：增量模式下，review-summary.json 必须合并所有包的结果——读取未修改包的已有 review.json，与本次新审查的包结果合并后生成 summary，确保 `allPassed` 反映全部包的真实状态

**verify 职责**：
- **全局编译验证**：`mvn compile` 全局执行一次，结果归入 `verify-summary.json`
- **按包独立校验，逐包持久化**：每校完一个包立即写入 `translations/{package}/verify.json`
- 每包校验内容：MyBatis XML 校验（namespace 匹配、statement id 匹配）、TODO 残留统计
- **编译错误归因**：将 mvn compile 错误归因到具体包和文件，填入 per-package 的 `mustFix`
- 全部包校完后产出顶层 `verify-summary.json`（含编译结果 + 测试骨架生成）
- 生成测试骨架（仅生成，不执行）
- **增量模式支持**：同 review，增量 summary 合并策略同上（合并已有 verify.json 结果到 verify-summary.json）

---

## 工作流定义

### 单流水线

```
inventory → analyze → plan（confirm 后激活）→ scaffold → translate → review → verify → 完成
                                                                  │            │
                                                                  ↓ (failed)   ↓ (failed)
                                                                  fix ←────────┘
                                                                  │
                                                                  └→ 增量回到触发阶段
```

| 阶段 | Agent | 温度 | 最大重试 | 说明 |
|------|-------|------|---------|------|
| inventory | sql-analyst | 0.1 | 2 | 扫描编目 |
| analyze | sql-analyst | 0.1 | 2 | 依赖分析 + 拓扑排序 + 子程序结构解析（三轮分步）+ 逐子程序 FSD 生成 |
| plan | java-architect | 0.2 | 1 | 架构规划（需人工确认，confirm 后 agent 才激活） |
| scaffold | java-architect | 0.2 | 1 | 项目骨架生成 |
| translate | translator | 0.1 | 3 | 按拓扑序逐包翻译，逐包持久化 |
| review | reviewer | 0.1 | 1 | 按包独立审查，逐包持久化 |
| verify | reviewer | 0.1 | 2 | 全局编译 + 按包独立校验，逐包持久化 |
| fix | translator | 0.1 | 3 | 根据反馈修复所有 mustFix 项，产出 FixArtifact |

**无条件前进**：inventory → analyze → plan → scaffold → translate → review → verify → 完成

**条件分支**（review / verify failed）：
- review: LLM 判定 result="passed" → verify, result="failed" → fix
- verify: LLM 判定 result="passed" → 完成, result="failed" → fix
- fix 完成后增量回到触发阶段（只重审 fix 修改过的包）
- fix exhausted 双层策略：globalMax=3, phaseMax=2, 任一达限 → `completed_with_issues`

---

## Workflow Engine 核心接口

### 核心类型

```typescript
// ── 常量 ──
const FIX_LIMITS = {
  globalMax: 3,     // 全局 fix 上限（宽松）
  phaseMax: 2,      // 单阶段 fix 上限（严格）
} as const

const DONE_SENTINEL = "__done__" as const

interface WorkflowDefinition {
  id: string
  phases: PhaseConfig[]
  transitions: TransitionRule[]
}

interface PhaseConfig {
  name: string
  agentFile: string                            // 对应的 agent .md 文件路径
  temperature: number
  maxRetries: number
  requiresConfirmation?: boolean               // 为 true 时 advance 后暂停等待确认
  isFixPhase?: boolean                         // 标记 fix 阶段，引擎特殊处理
  tools: string[]                              // 允许的工具列表
}

interface TransitionRule {
  from: string
  condition: "always" | "passed" | "failed"
  to: string                                   // 目标阶段名，"__done__" 表示完成
}

interface WorkflowRun {
  runId: string
  definitionId: string
  currentPhase: string | null
  status: "running" | "paused" | "completed" | "completed_with_issues" | "aborted"
  phaseHistory: PhaseHistoryEntry[]
  // fixTracking 已移除，从 phaseHistory 实时计算（过滤 phase === "fix" 的 entries）
  metadata: Record<string, any>
  createdAt: string
  updatedAt: string
}

interface PhaseHistoryEntry {
  phase: string
  status: "pending" | "in_progress" | "completed" | "failed" | "completed_with_issues"
  artifactPath?: string
  startedAt: string
  completedAt?: string
  retryCount: number                            // 每次 retry 递增，与 PhaseConfig.maxRetries 比较；retry 不创建新 entry
  branchedFrom?: string                        // fix 记录触发阶段；fix 回来的 entry 记录 "fix"
  incrementalContext?: {
    targetPackages: string[]                   // 增量模式：只处理这些包
  }
}
```

### WorkflowEngine

```typescript
class WorkflowEngine {
  private definitions = new Map<string, WorkflowDefinition>()

  // ── 注册 ──
  registerDefinition(def: WorkflowDefinition): void       // 注册工作流定义，start 通过 defId 查找

  // ── 生命周期 ──
  start(defId: string, runId: string, metadata?: Record<string, any>): WorkflowRun  // 内部通过 this.definitions.get(defId) 查找定义
  advance(runId: string, input: {
    result?: "passed" | "failed"               // D1/D8: 可选。review/verify 阶段引擎从 allPassed 自动推导；condition: "always" 阶段忽略；fix 阶段必填（D1）
  }): {
    run: WorkflowRun
    nextPhase: PhaseConfig | null
    finished: boolean
    waitingForConfirmation: boolean            // D4: true 时不激活 agent
    rejected: boolean                          // 校验被拒绝时为 true（Zod/D8/D12），LLM 应修正后重新调用 advance
    fixFailed: boolean                         // fix 失败但未 exhausted（D3），LLM 应调用 retry()，不与 rejected 同时为 true
    rejectionReason?: string                   // 拒绝/失败原因，指导 LLM 修正或重试
  }
  confirm(runId: string): WorkflowRun          // D4: confirm 后 run.status paused → running，entry.status pending → in_progress
  retry(runId: string): {
    run: WorkflowRun
    retryCount: number
    exhausted: boolean
    terminalState?: "completed_with_issues"   // fix 阶段 retry exhausted 时的终止状态
  }
  // retry 行为说明：
  // - 重置当前 phaseHistory entry 的 status 为 "in_progress"，递增 entry.retryCount
  // - 不创建新 entry，因此不影响 isFixExhausted 计数（isFixExhausted 基于 entry 数量，非 retry 次数）
  // - 检查 retryCount 是否超过 PhaseConfig.maxRetries → exhausted=true
  // - fix 阶段 retry exhausted 时：terminalState="completed_with_issues"，引擎直接标记 run 为 completed_with_issues，
  //   避免与 isFixExhausted 形成死循环（retry exhausted 但 fix entry 未 exhausted 时，LLM 无法 break 循环）
  // - 非 fix 阶段 retry exhausted 时：LLM 应调用 abort() 终止工作流
  abort(runId: string): WorkflowRun
  status(runId: string): WorkflowRun | null
  listRuns(): WorkflowRun[]

  // ── 持久化 ──
  loadFromDisk(runId: string): WorkflowRun     // D6: 从 run.json 恢复
}
```

插件注册的 workflow 工具 action：`start`、`advance`、`confirm`、`retry`、`status`、`abort`、`list`

### advance 核心流程

```
advance(runId, { result, artifact? })
  │
  ├─ 1. 查找当前 run，验证 status === "running"
  │
  ├─ 2. 当前 phase 的 artifact 磁盘 Zod 校验
  │     └─ 校验失败 → rejected=true, rejectionReason=Zod 错误详情，不标记 completed
  │
  ├─ 3. 跨 Schema 校验（D9）
  │     ├─ inventory-index ↔ inventory 包名一致性由 plugin 层 validateInventoryPackages 在 Zod 校验阶段完成（Step 2）
  │     ├─ analyze 完成 → 校验 inventory ↔ analysis 包名一致 + translationOrder 覆盖
  │     └─ plan 完成 → 校验 inventory ↔ analysis ↔ plan 映射完整
  │     └─ 失败：记录 warning 到 _events.log，不阻塞流程
  │
  ├─ 4. 当前 phase 是 fix？→ 分支处理
  │     ├─ result === undefined → rejected=true, rejectionReason="fix 阶段 result 必填（D1/D3）"
  │     ├─ result === "failed"（fix 无法完成）→ 标记当前 entry 为 failed
  │     │   ├─ isFixExhausted(preCreate=false)? → completed_with_issues, finished=true
  │     │   └─ 未 exhausted → fixFailed=true, rejectionReason 提示 LLM 调用 retry
  │     ├─ result === "passed" → advanceFromFix（D3/D7）
  │     │   ├─ 从 branchedFrom 取触发阶段
  │     │   ├─ 从磁盘读取 fix.json，取 fixedPackages → 校验（D12）
  │     │   │   ├─ 每个值必须存在于 inventory.packageNames（新格式优先，旧格式回退 inventory.packages[].name）→ 否则 rejected=true
  │     │   │   └─ fixedPackages 必须包含触发阶段 summary 中所有 passed=false 的包 → 否则 rejected=true
  │     │   │   └─ 拒绝时 rejectionReason 包含具体校验失败信息
  │     │   ├─ 校验通过 → 完成当前 phaseHistory entry（设 completedAt）
  │     │   ├─ incrementalContext.targetPackages = fixedPackages
  │     │   ├─ 创建触发阶段新 entry（in_progress）
  │     │   └─ return（不走后续 TransitionRule 匹配）
  │     └─ fix 阶段结束，early-return
  │
  ├─ 5. review / verify 阶段 → 从 summary.allPassed 推导 result（D8）
  │     ├─ effectiveResult = result ?? (allPassed ? 'passed' : 'failed')
  │     ├─ result 传入时做防御性校验：与 allPassed 不一致 → rejected=true
  │     │   ├─ result === "passed" 且 allPassed === false → rejected=true
  │     │   └─ result === "failed" 且 allPassed === true → rejected=true
  │     └─ 拒绝时 rejectionReason 指导 LLM 修正（如 "allPassed=true，请将 result 改为 passed 或为失败包添加 mustFix"）
  │
  ├─ 6. 所有校验通过 → 完成当前 phaseHistory entry（设 completedAt）
  │
  ├─ 7. condition: "always" 阶段 → 忽略 result 参数（失败走 retry/abort）
  │
  ├─ 8. 匹配 TransitionRule（D1: 根据 result 匹配 condition）
  │
  ├─ 9. to === "__done__" → 标记 completed, finished=true
  │
  ├─ 10. 目标是 fix phase？
        ├─ 检查 isFixExhausted(preCreate=true)（D2: 从 phaseHistory 实时计算，+1 预判新 entry）
        │   └─ exhausted → completed_with_issues, finished=true
        └─ 新 entry.branchedFrom = 触发阶段名

  ├─ 11. 目标 phase requiresConfirmation？
  │     ├─ 创建新 phaseHistory entry（status="pending"）
  │     ├─ 更新 currentPhase
  │     ├─ run.status = "paused", waitingForConfirmation=true（D4）
  │     ├─ 不切换 system prompt，不激活 agent
  │     └─ confirm() 时 entry.status → "in_progress"

  └─ 12. 正常前进（非 requiresConfirmation 阶段）
        ├─ 创建新 phaseHistory entry（in_progress）
        ├─ 更新 currentPhase
        └─ 返回 nextPhase + phaseChanged 信号
```

### isFixExhausted 双层判定（从 phaseHistory 实时计算）

```typescript
// preCreate: true 表示 fix entry 尚未创建（step 10 调用），+1 预判创建后数量
//            false 表示 fix entry 已在 phaseHistory 中（step 4 调用），直接检查达限
function isFixExhausted(run: WorkflowRun, triggerPhase: string, preCreate: boolean): boolean {
  const fixEntries = run.phaseHistory.filter(e => e.phase === "fix")
  const globalCount = fixEntries.length
  const phaseCount = fixEntries.filter(e => e.branchedFrom === triggerPhase).length
  if (preCreate) {
    // 创建前检查：当前数量 + 1 超过上限时阻止创建
    if (globalCount + 1 > FIX_LIMITS.globalMax) return true
    if (phaseCount + 1 > FIX_LIMITS.phaseMax) return true
  } else {
    // 创建后检查：当前数量已达上限时触发 exhausted
    if (globalCount >= FIX_LIMITS.globalMax) return true
    if (phaseCount >= FIX_LIMITS.phaseMax) return true
  }
  return false
}
```

### fix 循环场景推演

```
路径1: 一路顺风
  inventory → analyze → plan(paused) → [confirm] → scaffold → translate → review(passed) → verify(passed) → done ✓

路径2: review 发现问题，修一轮就好
  ... → review(failed) → fix → review(passed, 只审 fix 修改的包)
      → verify(passed) → done ✓

路径3: review 和 verify 各触发一次 fix
  ... → review(failed) → fix → review(passed)
      → verify(failed) → fix → verify(passed) → done ✓

路径4: review 反复失败，阶段级 exhausted
  ... → review(failed) → fix → review(failed)
      → fix → review(failed, phaseMax=2 达限)
      → exhausted → completed_with_issues

路径5: 全局 exhausted
  ... → review(failed) → fix ×2 → review(passed)
      → verify(failed) → fix ×1 → verify(failed, globalMax=3 达限)
      → exhausted → completed_with_issues
```

---

## Workflow 定义配置

```typescript
export const SQL2JAVA_WORKFLOW: WorkflowDefinition = {
  id: "sql2java",
  phases: [
    {
      name: "inventory",
      agentFile: "agent/sql-analyst.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "analyze",
      agentFile: "agent/sql-analyst.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "plan",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 1,
      requiresConfirmation: true,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "scaffold",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 1,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "translate",
      agentFile: "agent/translator.md",
      temperature: 0.1,
      maxRetries: 3,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "review",
      agentFile: "agent/reviewer.md",
      temperature: 0.1,
      maxRetries: 1,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "verify",
      agentFile: "agent/reviewer.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "fix",
      agentFile: "agent/translator.md",
      temperature: 0.1,
      maxRetries: 3,
      isFixPhase: true,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
  ],

  transitions: [
    // ── 主线：无条件前进 ──
    { from: "inventory",  condition: "always",  to: "analyze" },
    { from: "analyze",    condition: "always",  to: "plan" },
    { from: "plan",       condition: "always",  to: "scaffold" },
    { from: "scaffold",   condition: "always",  to: "translate" },
    { from: "translate",  condition: "always",  to: "review" },
    // ── review 分支 ──
    { from: "review",     condition: "passed",  to: "verify" },
    { from: "review",     condition: "failed",  to: "fix" },
    // ── verify 分支 ──
    { from: "verify",     condition: "passed",  to: "__done__" },
    { from: "verify",     condition: "failed",  to: "fix" },
    // ── fix 回环：D7 动态路由，不在此写死 ──
  ],
}
```

---

## Artifact Schema（Zod 定义）

### 跨 Schema 约定

- Zod 只做结构校验，语义校验（lineRange 范围、参数重复名等）留给 review 阶段
- 引擎层 `validateCrossSchema()` 负责跨 Schema 语义校验（包名覆盖、映射完整等）
- 引擎对 Oracle 类型做大小写 normalize

### inventory-index.json（预扫描索引，machine-generated）

由引擎在 start 时通过 `plsql-scanner.ts`（AST 或 regex）自动生成，不占 LLM 上下文。

```typescript
export const InventoryIndexSchema = z.object({
  sourcePath: z.string(),
  scannedAt: z.string(),
  scannerUsed: z.enum(["ast", "regex"]),

  packages: z.array(z.object({
    name: z.string(),
    specFile: z.string().optional(),
    bodyFile: z.string().optional(),
    procedures: z.array(z.object({
      name: z.string(),
      type: z.enum(["procedure", "function"]),
      lineRange: z.tuple([z.number(), z.number()]).optional(),
    })),
    estimatedLoc: z.number(),
  })),

  tables: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
  })),

  triggers: z.array(z.object({
    name: z.string(),
    sourceFile: z.string(),
  })),

  views: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
  })),

  sequences: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
  })),

  standaloneProcedures: z.array(z.object({
    name: z.string(),
    type: z.enum(["procedure", "function"]),
    sourceFile: z.string(),
  })),

  callGraph: z.record(z.array(z.string())).optional(),
})
```

### inventory-packages/{PKG}.json（逐包 inventory，LLM enriched）

LLM agent 分批读取源码后补充完整语义细节，每包一个文件。

```typescript
export const InventoryPackageSchema = z.object({
  packageName: z.string(),
  specFile: z.string().optional(),
  bodyFile: z.string().optional(),
  procedures: z.array(z.object({
    name: z.string(),
    type: z.enum(["procedure", "function"]),
    params: z.array(z.object({
      name: z.string(),
      oracleType: z.string(),
      direction: z.enum(["IN", "OUT", "IN OUT"]),
    })),
    returnType: z.string().optional(),
    lineRange: z.tuple([z.number(), z.number()]),
    loc: z.number(),
  })),
  types: z.array(z.object({
    name: z.string(),
    kind: z.string(),
    definition: z.string(),
  })),
  variables: z.array(z.object({
    name: z.string(),
    type: z.string(),
    defaultValue: z.string().optional(),
  })),
  constants: z.array(z.object({
    name: z.string(),
    type: z.string(),
    value: z.string(),
  })),
}).refine(
  pkg => pkg.procedures.length === 0 || (pkg.bodyFile !== undefined && pkg.bodyFile.length > 0),
  { message: "有 procedures 的包必须有非空的 bodyFile（procedure 实现体在 body 中）" }
)
```

### inventory.json（索引 + DDL 数据）

packages 拆分为 per-package 文件后，此文件只保留索引（sourcePath + packageNames）和 DDL 数据（tables/triggers/views/sequences/standaloneProcedures）。

```typescript
export const InventorySchema = z.object({
  sourcePath: z.string(),
  packageNames: z.array(z.string()),

  tables: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
    columns: z.array(z.object({
      name: z.string(),
      oracleType: z.string(),
      nullable: z.boolean(),
      isPrimaryKey: z.boolean(),
      defaultValue: z.string().optional(),
    })),
  })),

  standaloneProcedures: z.array(z.object({
    name: z.string(),
    type: z.enum(["procedure", "function"]),
    params: z.array(z.object({
      name: z.string(),
      oracleType: z.string(),
      direction: z.enum(["IN", "OUT", "IN OUT"]),
    })),
    returnType: z.string().optional(),
    sourceFile: z.string(),
    lineRange: z.tuple([z.number(), z.number()]),
  })),

  triggers: z.array(z.object({
    name: z.string(),
    timing: z.enum(["before", "after", "instead-of", "compound"]),
    level: z.enum(["statement", "row"]),
    targetTable: z.string(),
    events: z.array(z.enum(["insert", "update", "delete"])),
    sourceFile: z.string(),
    lineRange: z.tuple([z.number(), z.number()]),
    condition: z.string().optional(),
  })),

  views: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
    sourceFile: z.string().optional(),
    columns: z.array(z.string()),
    underlyingTables: z.array(z.string()).optional(),
  })),

  sequences: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
    startWith: z.number().optional(),
    incrementBy: z.number().optional(),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    cycle: z.boolean().optional(),
  })),
})
```

### analysis.json（全局元数据）

packages 子程序数据拆分为 per-package 文件后，此文件只保留全局元数据。

```typescript
export const AnalysisMetaSchema = z.object({
  callGraph: z.record(z.array(z.string())),
  packageDependency: z.record(z.array(z.string())),
  translationOrder: z.array(z.array(z.string())),     // SCC 组为同层数组如 ["order_proc", "order_util"]，非 SCC 为单元素数组
  complexity: z.record(z.object({
    score: z.number().min(1).max(10),
    patterns: z.array(z.string()),
    riskLevel: z.enum(["low", "medium", "high"]),
  })),
  sccGroups: z.array(z.array(z.string())),
  packageNames: z.array(z.string()),
})
```

### analysis-packages/{pkg}.json（逐包子程序结构）

```typescript
export const AnalysisPackageSchema = z.object({
  packageName: z.string(),
  subprograms: z.array(z.object({
    name: z.string(),
    blocks: z.array(z.object({
      type: z.enum([
        "loop", "cursor", "if-else", "exception-block",
        "sql-statement", "assignment", "call"
      ]),
      oracleLine: z.number(),
      description: z.string(),
      dependencies: z.array(z.string()),
    })),
    variables: z.array(z.object({
      name: z.string(),
      type: z.string(),
      scope: z.string(),
    })),
    cursors: z.array(z.object({
      name: z.string(),
      query: z.string(),
      fetchMode: z.enum(["BULK", "ONE_BY_ONE", "FOR_UPDATE", "OTHER"]),
    })),
    exceptionHandlers: z.array(z.object({
      name: z.string(),
      actions: z.array(z.string()),
    })),
    translationNotes: z.string(),
  })),
})
```

### plan.json

```typescript
export const PlanSchema = z.object({
  targetProject: z.object({
    groupId: z.string(),
    artifactId: z.string(),
    packageBase: z.string(),
    javaVersion: z.string(),
    springBootVersion: z.string(),
  }),

  packageMappings: z.array(z.object({
    oraclePackage: z.string(),
    javaPackage: z.string(),
    mapperInterface: z.string(),
    serviceClass: z.string(),
    serviceImplClass: z.string(),
  })),

  rules: z.object({
    namingConvention: z.enum(["keep-oracle", "camelCase", "mixed"]),
    nullHandling: z.enum(["optional", "nullable", "throw-empty"]),
    exceptionStrategy: z.enum(["spring-data", "custom-business", "oracle-mirror"]),  // 默认 custom-business
    logFramework: z.enum(["slf4j", "log4j2"]),
  }),

  typeMappings: z.record(z.string()),
  manualReviewList: z.array(z.object({
    procedure: z.string(),
    reason: z.string(),
  })),

  conventions: z.string(),                      // 编码约定，作为后续 translator/reviewer 的翻译指导
})
```

### scaffold.json

```typescript
export const ScaffoldSchema = z.object({
  projectRoot: z.string(),
  structure: z.object({
    directories: z.array(z.string()),
    pomXml: z.string(),
  }),
  generated: z.object({
    entities: z.array(z.object({
      file: z.string(),
      tableName: z.string(),
    })),
    mapperInterfaces: z.array(z.object({
      file: z.string(),
      oraclePackage: z.string(),
    })),
    serviceShells: z.array(z.object({
      file: z.string(),
      oraclePackage: z.string(),
    })),
    commonClasses: z.array(z.object({
      file: z.string(),
      purpose: z.string(),
    })),
  }),
  conventions: z.string(),
  basedOnPlanHash: z.string().optional(),              // 关联 plan 版本
})
```

### translation.json（每包一个）

```typescript
export const TranslationSchema = z.object({
  packageName: z.string(),
  status: z.enum(["completed", "partial"]),
  completedSubprograms: z.array(z.string()),
  totalSubprograms: z.number(),

  files: z.array(z.object({
    path: z.string(),
    role: z.enum([
      "mapper-interface", "mapper-xml", "service",
      "service-impl", "dto", "exception"
    ]),
  })),

  decisions: z.array(z.object({
    line: z.number(),
    oracleConstruct: z.string(),
    javaConstruct: z.string(),
    reason: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),

  todos: z.array(z.object({
    file: z.string(),
    issue: z.string(),
    oracleLine: z.number(),
    suggestion: z.string(),
  })),
})
```

### review.json（每包一个）

```typescript
export const ReviewSchema = z.object({
  packageName: z.string(),
  passed: z.boolean(),
  overallScore: z.number().min(0).max(100),
  procedureReviews: z.array(z.object({
    procedure: z.string(),
    checks: z.array(z.object({
      category: z.enum([
        "logic-equivalence", "sql-completeness", "null-handling",
        "type-mapping", "exception-mapping", "transaction-boundary",
        "cursor-mapping", "parameter-direction", "naming-consistency",
        "todo-remaining"
      ]),
      passed: z.boolean(),
      detail: z.string(),
      severity: z.enum(["critical", "major", "minor", "info"]),
    })),
  })),
  mustFix: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    issue: z.string(),
  })),
  suggestions: z.array(z.string()),
  todoRemainingCount: z.number(),
}).refine(
  data => (data.passed === true) === (data.mustFix.length === 0),
  { message: "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空" }
)
```

### review-summary.json（顶层汇总）

```typescript
export const ReviewSummarySchema = z.object({
  allPassed: z.boolean(),
  packageResults: z.array(z.object({
    packageName: z.string(),
    passed: z.boolean(),
    score: z.number(),
    mustFixCount: z.number(),
  })),
  totalMustFix: z.number(),
  totalTodosRemaining: z.number(),
}).refine(
  data => data.allPassed === data.packageResults.every(p => p.passed),
  { message: "allPassed 应与 packageResults 一致" }
)
```

### verify.json（每包一个）

```typescript
export const VerifySchema = z.object({
  packageName: z.string(),
  passed: z.boolean(),
  mybatisValidation: z.object({
    mapperXmlValid: z.boolean(),
    statementIdsMatch: z.boolean(),
  }),
  todoRemainingCount: z.number(),
  mustFix: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    issue: z.string(),
  })),
}).refine(
  data => (data.passed === true) === (data.mustFix.length === 0),
  { message: "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空" }
)
```

### verify-summary.json（顶层汇总）

```typescript
export const VerifySummarySchema = z.object({
  allPassed: z.boolean(),
  compilation: z.object({
    success: z.boolean(),
    errors: z.array(z.object({
      file: z.string(),
      line: z.number(),
      message: z.string(),
    })).optional(),
  }),
  packageResults: z.array(z.object({
    packageName: z.string(),
    passed: z.boolean(),
    mybatisValid: z.boolean(),
  })),
  testGeneration: z.object({
    generated: z.boolean(),
    testFiles: z.array(z.string()),
  }),
  totalTodosRemaining: z.number(),
  unresolvedIssues: z.array(z.object({
    packageName: z.string(),
    issue: z.string(),
  })).optional(),
}).refine(
  data => data.allPassed === data.packageResults.every(p => p.passed),
  { message: "allPassed 应与 packageResults 一致" }
).refine(
  data => data.compilation.success === true || (data.compilation.errors !== undefined && data.compilation.errors.length > 0),
  { message: "compilation.success=false 时 errors 必须非空" }
)
```

### fix.json（fix 阶段产出，遵循 D5 写入磁盘）

```typescript
export const FixArtifactSchema = z.object({
  fixedPackages: z.array(z.string().min(1)),
}).refine(
  // 包名校验（inventory 包名枚举 + 触发阶段失败包超集）在引擎 advanceFromFix 中执行，
  // 因需要运行时访问 inventory 数据和触发阶段的 summary
  data => data.fixedPackages.length > 0,
  { message: "fixedPackages 不能为空，fix 必须至少修复一个包" }
)
```

### 跨 Schema 语义校验

```typescript
function validateCrossSchema(run: WorkflowRun, completedPhase: string): string[] {
  const warnings: string[] = []
  const inventory = loadArtifact(run, "inventory")
  const analysis  = loadArtifact(run, "analysis")

  // 防御性检查：artifact 不存在时只返回 warning，不崩溃
  if (!inventory || !analysis) {
    warnings.push(`跨 Schema 校验跳过：缺少必要的 artifact（inventory: ${!!inventory}, analysis: ${!!analysis}）`)
    return warnings
  }

  // inventory-index ↔ inventory 包名一致性由 plugin 层 validateInventoryPackages 在 inventory 阶段 Zod 校验时完成，此处不重复

  // inventory ↔ analysis 包名（双向）
  const invNames = inventory.packageNames
    ? new Set(inventory.packageNames)
    : new Set((inventory.packages ?? []).map(p => p.name))
  // 新格式优先：analysis.packageNames；旧格式回退：analysis.packages[].name
  const anaNames = analysis.packageNames
    ? new Set(analysis.packageNames)
    : new Set((analysis.packages ?? []).map(p => p.name))
  for (const name of invNames) {
    if (!anaNames.has(name)) warnings.push(`analysis 缺少包: ${name}`)
  }
  for (const name of anaNames) {
    if (!invNames.has(name)) warnings.push(`inventory 缺少包: ${name}（analysis 中存在但 inventory 中不存在）`)
  }

  // translationOrder 覆盖校验
  const orderedNames = new Set(analysis.translationOrder.flat())
  for (const name of anaNames) {
    if (!orderedNames.has(name)) warnings.push(`translationOrder 缺少包: ${name}`)
  }

  // plan 映射覆盖（仅 plan 完成后校验）
  if (completedPhase === "plan") {
    const plan = loadArtifact(run, "plan")
    if (!plan) {
      warnings.push('plan 映射校验跳过：plan artifact 不存在')
      return warnings
    }
    const mappedNames = new Set(plan.packageMappings.map(m => m.oraclePackage))
    for (const name of invNames) {
      if (!mappedNames.has(name)) warnings.push(`plan 未映射包: ${name}`)
    }
  }

  return warnings
}
```

---

## Artifact 存储

```
.workflow-artifacts/
└── {runId}/
    ├── run.json                             # WorkflowRun 持久化
    ├── inventory-index.json                 # 预扫描索引（machine-generated，start 时生成）
    ├── inventory-packages/                  # 逐包 inventory（LLM enriched）
    │   ├── PKG_ORDER.json
    │   └── PKG_UTIL.json
    ├── inventory.json                       # 索引 + DDL 数据（tables/triggers/views/sequences）
    ├── analysis-packages/                   # 逐包子程序结构
    │   ├── exc_pkg.json
    │   └── util_pkg.json
    ├── analysis.json                        # 全局元数据（callGraph + topology + complexity）
    ├── plan.json
    ├── scaffold.json
    ├── fix.json                             # fix 阶段产出（每次 fix 覆盖）
    ├── fsd/                                 # FSD 文档（analyze 阶段副产物）
    │   └── {package}/
    │       ├── {subprogram-a}.md            # 每个子程序一份功能规格文档
    │       └── {subprogram-b}.md
    ├── translations/
    │   ├── {package-a}/
    │   │   ├── translation.json
    │   │   ├── review.json
    │   │   └── verify.json
    │   └── {package-b}/
    │       ├── translation.json
    │       ├── review.json
    │       └── verify.json
    ├── review-summary.json
    ├── verify-summary.json
    └── _events.log                          # append-only 事件日志
```

### _events.log 格式

```
[ISO8601] [EVENT_TYPE] [runId] [phase] message
```

事件类型：`START`、`ADVANCE`、`RETRY`、`FAIL`、`COMPLETE`、`ABORT`、`CONFIRM`

示例：
```
[2026-05-30T10:00:00Z] [START] [run-001] - workflow started
[2026-05-30T10:01:23Z] [ADVANCE] [run-001] inventory → analyze
[2026-05-30T10:02:45Z] [ADVANCE] [run-001] analyze → plan, waiting for confirmation
[2026-05-30T10:05:00Z] [CONFIRM] [run-001] plan confirmed by user
[2026-05-30T10:10:00Z] [ADVANCE] [run-001] review(failed) → fix
[2026-05-30T10:12:00Z] [ADVANCE] [run-001] fix → review (incremental, packages: pkg_order,pkg_payment)
```

---

## Plugin Hook 机制

### 注册点

| Hook | 触发时机 | 作用 |
|------|---------|------|
| phaseChange | advance / confirm 后 phase 变更时 | 构建 system prompt（agent .md + Runtime Context） |
| beforeLlmCall | 每次 LLM 调用前 | 温度控制 + 工具过滤 |
| advance | advance action 执行前 | 从磁盘校验 artifact（D5），校验失败拒绝 advance |

### System Prompt 构建

phase 变更时，plugin 构建新的 system prompt：

```
1. 读取 agent .md 全文
2. 解析 ## Phase: xxx 分节边界
3. 提取通用部分（文件头到第一个 ## Phase: 之前的内容：角色定义 + 通用规则）
4. 提取当前 phase 对应的 section
5. 拼接：
   [通用规则]
   [当前 Phase section]
   [Runtime Context]
```

Runtime Context：
  - currentPhase
  - runId
  - sourcePath
  - artifactsDir
  - incrementalContext（targetPackages，增量模式时存在）
  - upstreamArtifacts（当前阶段需要读取的上游 artifact 路径列表）

注：只注入当前 phase 的 section，不注入其他 phase 分节，避免 LLM 执行错误指令。

每个 phase 的 upstreamArtifacts：

| Phase | 上游 Artifact |
|-------|-------------|
| inventory | inventory-index.json |
| analyze | inventory-index.json + inventory.json + inventory-packages/*.json |
| plan | inventory-index.json + inventory.json + inventory-packages/*.json + analysis.json + analysis-packages/*.json + fsd/*/*.md（可选参考） |
| scaffold | plan.json + inventory-index.json + inventory.json + inventory-packages/*.json |
| translate | inventory-index.json + inventory.json + inventory-packages/*.json + plan.json + analysis.json + analysis-packages/*.json + scaffold.json + fsd/*/*.md（可选参考） |
| review | plan.json + scaffold.json + analysis.json + analysis-packages/*.json + translations/*/translation.json |
| verify | plan.json + scaffold.json + translations/*/translation.json |
| fix | analysis.json + analysis-packages/*.json + plan.json + scaffold.json + 触发阶段的 summary + 相关包的 per-package artifact |

### 工具权限矩阵

| Phase | read | bash | write | edit | workflow |
|-------|------|------|-------|------|----------|
| inventory | ✓ | ✓ | ✓ | | ✓ |
| analyze | ✓ | ✓ | ✓ | | ✓ |
| plan | ✓ | ✓ | ✓ | ✓ | ✓ |
| scaffold | ✓ | ✓ | ✓ | ✓ | ✓ |
| translate | ✓ | ✓ | ✓ | ✓ | ✓ |
| review | ✓ | ✓ | ✓ | | ✓ |
| verify | ✓ | ✓ | ✓ | | ✓ |
| fix | ✓ | ✓ | ✓ | ✓ | ✓ |

### Artifact 校验（advance 时）

agent 自己写 artifact 文件（D5），advance 时 workflow 工具从磁盘读取并做 Zod 校验（校验在标记 phase completed 之前执行）：

1. plugin 根据 phase name 查找对应 Zod Schema
2. 从磁盘读取 artifact 文件，执行 `schema.safeParse()`
3. 校验失败：**拒绝 advance**（rejected=true），返回具体 Zod 错误信息，LLM 应修正 artifact 后重新调用 advance
4. 校验成功：引擎完成状态流转，更新 phaseHistory entry 的 artifactPath

### 完整生命周期时序

```
用户: /sql2java /path/to/sql
  │
  ├─ command/sql2java.md 解析参数
  ├─ workflow({ action: "start", runId, metadata })
  │   ├─ 预扫描：scanSource(sourcePath) → AST 或 regex
  │   ├─ 写入 inventory-index.json（machine-generated）
  │   ├─ engine.start() → run { currentPhase: "inventory", status: "running" }
  │   └─ hook: system prompt ← sql-analyst.md + Phase: inventory
  │
  ▼ agent(sql-analyst) 执行 inventory（分批处理）
  │   产出 inventory-packages/{PKG}.json（逐包）+ inventory.json（索引 + DDL）
  ├─ workflow({ action: "advance", runId, result: "passed" })
  │   ├─ engine.advance() → analyze
  │   ├─ validate artifact on disk（含 per-package 校验）
  │   └─ hook: system prompt ← sql-analyst.md + Phase: analyze
  │
  ▼ agent(sql-analyst) 执行 analyze
  ├─ workflow({ action: "advance", runId, result: "passed" })
  │   ├─ engine.advance() → plan (paused, waitingForConfirmation=true)
  │   └─ 不切换 system prompt，不激活 agent（D4）
  │
  ▼ 用户确认
  ├─ workflow({ action: "confirm", runId })
  │   ├─ engine.confirm() → status: running
  │   └─ hook: system prompt ← java-architect.md + Phase: plan
  │
  ▼ agent(java-architect) 执行 plan
  ├─ ...后续类似...
  │
  ▼ review 阶段
  ├─ workflow({ action: "advance", runId, result: "failed" })
  │   ├─ engine.advance() → fix
  │   └─ hook: system prompt ← translator.md + Phase: fix
  │
  ▼ agent(translator) 执行 fix
  ├─ workflow({ action: "advance", runId, result: "passed" })
  │   │   # fix.json 已由 agent 写入磁盘，引擎从磁盘读取校验（D5）
  │   ├─ advanceFromFix() → review (incremental)
  │   ├─ incrementalContext: { targetPackages: ["pkg_order"] }
  │   └─ hook: system prompt ← reviewer.md + Phase: review + incrementalContext
```

---

## Agent .md 结构

### 通用结构

每个 agent .md 按 `## Phase: xxx` 分节编写，结构如下：

```markdown
# Agent: {name}

角色定义和通用规则

---

## Phase: {phase-a}

### 目标
### 输入（upstreamArtifacts 路径）
### 输出（artifact 路径 + 格式要求）
### 工作步骤
### 质量检查

---

## Phase: {phase-b}

（同上结构）
```

### 4 个 Agent 的职责摘要

| Agent | Phase | 核心职责 | 关键产出 |
|-------|-------|---------|---------|
| sql-analyst | inventory | 基于预扫描索引分批补充语义细节 | inventory-packages/{PKG}.json + inventory.json |
| sql-analyst | analyze | 依赖图 + 拓扑排序 + 子程序结构（分步）+ FSD 生成 | analysis.json + analysis-packages/{pkg}.json + fsd/{pkg}/{sp}.md |
| java-architect | plan | 架构规划 → 暂停等待确认 | plan.json |
| java-architect | scaffold | 项目骨架 + Entity + Mapper/Service 壳 | scaffold.json + Java 文件 |
| translator | translate | 按拓扑序逐包翻译，逐包持久化 | translations/{pkg}/translation.json + Java 文件 |
| translator | fix | 修复 mustFix 项，产出 FixArtifact | 更新 Java 文件 + FixArtifact |
| reviewer | review | 10 类审查清单，逐包持久化 | translations/{pkg}/review.json + review-summary.json |
| reviewer | verify | mvn compile + MyBatis 校验，逐包持久化 | translations/{pkg}/verify.json + verify-summary.json |

### agent .md 中的关键指令

所有 agent .md 包含的通用指令：

1. **阶段完成**：工作完成后调用 `workflow({ action: "advance", runId, result })`
2. **artifact 写入**：所有 artifact 写入 `${artifactsDir}/` 下的指定路径（D5）
3. **逐包持久化**（inventory / analyze / translate / review / verify）：每处理完一个包立即写入，避免崩溃丢失
4. **增量模式**（review / verify）：当 `incrementalContext.targetPackages` 存在时，只处理指定包
5. **中断恢复**（inventory / analyze / translate）：启动时检查已有 per-package artifact，跳过已完成的包
6. **分批处理**（inventory / analyze）：禁止一次性读取所有源码文件，每批 2-3 个包，处理完立即写入磁盘
7. **FSD 生成**（analyze）：逐子程序解析结构时同步生成 `fsd/{package}/{subprogram}.md`，每完成一个立即写入（D13）

---

## FSD 文档设计

### 概述

FSD（Functional Specification Document）是基于 `outline.md`（`f_format_amount` 转换大纲）的实践格式，标准化为 6 板块结构，为 `plan` 和 `translate` 阶段提供业务级转译指导。

`analyze` 阶段产出的 `analysis.json` 侧重于**结构化解析**（调用图、拓扑排序、语句块分类），但 `translator` 在翻译前还需要更**面向业务语义**的信息——表结构映射、校验规则、业务逻辑流程、特殊语法转化规约。FSD 就是把这些散落在 `analysis.json` 的 `translationNotes`、`inventory.json` 的表定义和源码本身中的信息，集中成一份"翻译说明书"。

### 6 板块结构

```
FSD 文档
├── 1. 概览（Overview）
│   ├── 存储过程名、签名、功能摘要
│   ├── 参数清单 + Java 类型映射（IN/OUT/IN OUT）
│   ├── 返回值说明
│   └── 转换策略概述（设计模式选择、命名方向）
│
├── 2. 表结构映射（Table-Entity Mapping）
│   ├── 涉及的表清单 + 操作类型（SELECT/INSERT/UPDATE/DELETE）
│   ├── 每张表的列 → DO 字段映射
│   ├── 跨表关系（JOIN、外键引用）
│   └── 特殊列处理（LOB、虚拟列、自增列）
│
├── 3. 依赖分析（Dependencies）
│   ├── 调用的其他包/函数/过程（含已解析的 Java 方法）
│   ├── 被其他包调用的入口标记
│   ├── 共享类型/变量依赖
│   └── 跨包调用 → Service 注入关系
│
├── 4. 业务规则（Business Rules）
│   ├── 校验规则（参数、状态、唯一性）
│   ├── 计算逻辑（公式、折扣、金额）
│   ├── 状态流转
│   └── 边界条件（空值、零值、溢出、并发）
│
├── 5. 控制流与异常（Control Flow & Exceptions）
│   ├── Mermaid 流程图
│   ├── 分支条件及对应处理
│   ├── 循环结构（游标 LOOP → Java for-each）
│   └── 异常处理路径（WHEN OTHERS → try-catch）
│
└── 6. 特殊语法转化规约（Special Syntax Conventions）
    ├── Oracle 专有构造 → Java/MyBatis 等价写法
    ├── 事务边界说明
    └── 需手动审查的构造清单（标记 TODO）
```

### 各板块与 workflow 数据源的对应关系

| 板块 | 对应 workflow 数据源 |
|------|---------------------|
| 1. 概览 | inventory-packages/{PKG}.json（签名）+ analysis-packages/{pkg}.json（translationNotes） |
| 2. 表结构映射 | inventory.json（tables、columns）+ analysis-packages/{pkg}.json（blocks 中引用的表） |
| 3. 依赖分析 | analysis.json（callGraph、packageDependency） |
| 4. 业务规则 | analysis-packages/{pkg}.json（blocks + 源码分析） |
| 5. 控制流与异常 | analysis-packages/{pkg}.json（blocks、loops、exceptionHandlers） |
| 6. 特殊语法转化规约 | analysis-packages/{pkg}.json（translationNotes）+ 源码分析 |

### 各板块格式规范

详细的 6 板块格式模板和完整示例见 `sp-to-fsd-design.md`（Part 1 结构定义 + Part 2 完整示例）。以下为各板块的要点概述和生成策略：

#### 板块 1：概览（Overview）

子程序名、签名、功能摘要 + 参数清单与 Java 类型映射 + 转换策略（服务映射、参数封装、设计模式）。

**数据来源**：inventory-packages/{PKG}.json（签名）+ analysis-packages/{pkg}.json（translationNotes）

#### 板块 2：表结构映射（Table-Entity Mapping）

**生成策略**：只列出本子程序涉及的操作类型（SELECT/INSERT/UPDATE/DELETE）和**与 inventory.json 定义的差异或需特别注意的列**（如特殊列处理、跨表关系）。完整的列 → DO 字段映射已在 inventory.json 中，不逐列重复。

**数据来源**：inventory.json（tables）+ analysis-packages/{pkg}.json（blocks 中引用的表）

#### 板块 3：依赖分析（Dependencies）

**生成策略**：列出本子程序调用的其他子程序及已解析的 Java 方法、跨包调用 → Service 注入关系。完整的 callGraph 已在 analysis.json 中，此处聚焦于**翻译 implications**（哪些依赖已就绪、哪些待翻译）。

**数据来源**：analysis.json（callGraph、packageDependency）

#### 板块 4：业务规则（Business Rules）

校验规则（参数/状态/唯一性）、计算逻辑（公式/金额）、状态流转、边界条件（空值/零值/溢出/并发）。这是 FSD 的核心增量价值——从源码中提炼 analysis.json 的 blocks 不直接表达的业务语义。

**数据来源**：analysis-packages/{pkg}.json（blocks）+ 源码分析

#### 板块 5：控制流与异常（Control Flow & Exceptions）

分支逻辑（条件 → 真假分支）、循环结构（游标 LOOP → Java for-each）、异常处理路径。Mermaid 流程图为可选（复杂子程序建议生成，简单子程序可省略）。

**数据来源**：analysis-packages/{pkg}.json（blocks、cursors、exceptionHandlers）

#### 板块 6：特殊语法转化规约（Special Syntax Conventions）

Oracle 专有构造 → Java/MyBatis 等价写法、事务边界说明、需手动审查的构造清单。与 analysis-packages/{pkg}.json 的 translationNotes 有重叠，但 FSD 版本更具体（给出具体的 Java 等价写法而非描述）。

**数据来源**：analysis-packages/{pkg}.json（translationNotes）+ 源码分析

### 生成规则

- **生成时机**：analyze 阶段逐子程序生成，与子程序结构解析同步进行（第三轮分步，见下）
- **存储路径**：`.workflow-artifacts/{runId}/fsd/{package}/{subprogram}.md`
- **命名**：`{package}` 使用 inventory 中的 Oracle 包名，`{subprogram}` 使用子程序名（小写 snake_case）
- **不参与 Zod 校验**：FSD 为 Markdown 格式，作为人类可读的辅助参考，不参与 advance 流程校验
- **消解规则**：当 FSD 内容与 `analysis-packages/{pkg}.json` / `inventory.json` 不一致时，以 JSON artifact 为准（FSD 是派生文档，JSON 是 primary source）
- **plan / translate 阶段可参考**：upstreamArtifacts 中列出 FSD 路径，agent 自行决定是否参考
- **板块 2/3 策略**：不逐列/逐调用重复 inventory.json 和 analysis-packages/{pkg}.json 的已有数据，只列出差异和翻译 implications，控制 FSD 文件体积

### analyze 阶段 FSD 生成分步策略

analyze 阶段的"内部分步"扩展为三轮：

1. **第一轮**：全局依赖图 + 拓扑排序 + SCC 检测 + 复杂度评估（轻量，产出 analysis.json 的顶层字段）
2. **第二轮**：逐包子程序结构解析（blocks / variables / cursors / exceptionHandlers），每完成一个包立即写入 analysis-packages/{pkg}.json（分批处理，每批 2-3 个包）
3. **第三轮**：逐子程序生成 FSD 文档（基于第二轮已解析的结构），每完成一个立即写入 `fsd/{package}/{subprogram}.md`

三轮分离的好处：
- 第二轮和第三轮的输出分开，避免单次输出过大导致上下文溢出
- 第三轮（FSD 生成）不影响 analysis-packages 的完整性——即使 FSD 生成被截断，per-package 文件已在第二轮完成
- 每个子程序的 FSD 独立写入，崩溃恢复时跳过已存在的文件

---

## /sql2java 命令入口

```
/sql2java <path>                        # 端到端全流程
/sql2java --status                      # 查看工作流状态
/sql2java --resume                      # 断点续传
/sql2java --phases plan,scaffold <path> # 指定阶段执行
```

### 路由逻辑

#### 分支 1：--status

1. 调用 `workflow({ action: "list" })`
2. 展示最近一次 run 的状态和 phaseHistory
3. 结束

#### 分支 2：--resume（断点续传）

1. 调用 `workflow({ action: "list" })` 找到最近的 run
2. `loadFromDisk(runId)` 恢复状态（D6）
3. 根据 run.status 决定行为：

| 状态 | 行为 |
|------|------|
| completed | 输出 "Already completed"，结束 |
| completed_with_issues | 输出未解决问题，结束 |
| paused（plan 等待确认） | 提示用户 confirm，结束 |
| running + 最后 entry 是 in_progress | 中断恢复：利用已有 per-package artifact 跳过 |
| aborted | 确认后恢复，同上 |

4. 根据当前阶段注入 system prompt，继续推进
5. 阶段内恢复策略：
   - **inventory**：检查 inventory-packages/*.json，跳过已完成的包
   - **analyze**：检查 analysis-packages/*.json，跳过已完成的包
   - **translate**：检查 translations/*/translation.json，跳过 status=completed 的包
   - **review / verify**：检查已有的 per-package artifact，跳过已完成包
   - **其他阶段**：直接重新执行

#### 分支 3：--phases

1. 校验阶段名合法且按工作流顺序排列
2. 校验前置依赖 artifact 存在：

| 目标阶段 | 必须存在的 artifact |
|---------|-------------------|
| analyze | inventory-index.json + inventory.json + inventory-packages/ |
| plan | inventory-index.json + inventory.json + inventory-packages/ + analysis.json + analysis-packages/ |
| scaffold | plan.json + inventory-index.json + inventory.json + inventory-packages/ |
| translate | inventory-index.json + inventory.json + inventory-packages/ + analysis.json + analysis-packages/ + plan.json + scaffold.json |
| review | plan.json + scaffold.json + analysis.json + analysis-packages/ + translations/*/translation.json |
| verify | plan.json + scaffold.json + translations/*/translation.json |
| fix | analysis.json + analysis-packages/ + plan.json + scaffold.json + review-summary.json 或 verify-summary.json + 相关包的 per-package artifact（review.json / verify.json） |

> 注：此表与上方 "upstreamArtifacts 表" 的核心依赖一致，upstreamArtifacts 额外包含可选参考文件（如 fsd/*/*.md）。两表需同步维护。

3. 缺少前置 → 报错退出
4. start → 连续 advance 跳过前面的阶段 → 激活第一个指定阶段
5. 连续 advance 过程中，遇到 `requiresConfirmation: true` 的阶段自动调用 `confirm()`（--phases 语义等价于用户隐式确认）

#### 分支 4：默认全流程

1. 校验 path 存在且包含 .sql / .pks / .pkb 文件
2. 生成 runId：`run-{YYYYMMDD-HHmmss}`
3. 创建 `.workflow-artifacts/{runId}/`
4. `workflow({ action: "start", runId, metadata: { sourcePath } })`
5. 进入 inventory 阶段，后续由 agent + workflow 工具自动推进

---

## 与远景方案的裁剪对照

| 远景方案特性 | MVP 状态 | 理由 |
|---|---|---|
| 增量翻译（Wf3） | 不做 | 先做全量 |
| 超大文件分轮 | per-package 拆分 | inventory/analyze 阶段通过 per-package 文件拆分 + 分批处理解决上下文限制 |
| SCC 循环依赖 | 同层数组 | 检测到循环归为 translationOrder 同层，各包保持独立翻译 |
| common_gap 兜底 | 不做 | 遇到缺失标 TODO |
| translator 并行 | 串行 | translate 阶段内部按拓扑序逐包处理 |
| 业务画像独立阶段 | 不做 | 嵌入 analyze 阶段的子程序摘要 |
| IR 中间表示 | analysis-packages/{pkg}.json | MVP 阶段 per-package JSON artifact 即 IR |
| 详细大纲文件 | 不做 | 子程序结构嵌入 analysis.json |
| 两层工作流编排 | 不做 | 单流水线，translate 内部自行按序处理 |
| FSD 独立阶段 | 路径 A（副产物） | analyze 阶段同步生成 fsd.md，不增加工作流阶段 |
| FSD Zod Schema 校验 | 不做 | FSD 为 Markdown 格式，质量依赖 agent 自觉，后续升级为路径 B 时再加 |

---

## 技术栈

- **Workflow Engine**：TypeScript（@opencode-ai/plugin 或 Claude Code hooks）
- **Schema 校验**：Zod
- **Agent 定义**：Markdown（按 `## Phase: xxx` 分节）
- **LLM**：Claude API
- **SQL 解析**：AST 预扫描（`@griffithswaite/ts-plsql-parser`，ANTLR4 TypeScript 生成）+ regex 降级 + LLM 语义补充
- **目标 Java 框架**：Spring Boot + MyBatis + Lombok + Maven

---

## 实现步骤

### Step 1: 项目脚手架
- 初始化 TypeScript 项目（tsconfig.json、package.json）
- 创建目录结构（command/、agent/、workflow/、plugin/）
- 安装依赖：zod

### Step 2: engine-core.ts
- 实现所有核心类型（WorkflowDefinition、WorkflowRun、PhaseConfig、PhaseHistoryEntry、TransitionRule）
- 实现 WorkflowEngine 类
  - start：创建 run，进入第一个 phase
  - advance：完成当前 phase → 匹配 TransitionRule → 推进（D1/D3/D4/D7）
  - confirm：paused → running，激活 agent（D4）
  - retry：重试当前 phase，达 maxRetries 则 abort
  - abort：终止工作流
  - status / listRuns：查询
  - loadFromDisk：从 run.json 恢复（D6）
- 实现 fix 特殊处理：
  - isFixExhausted 双层判定（D2）
  - advanceFromFix 增量回环（D3）
  - branchedFrom 追踪（D7）
- 实现 persist：每次状态变更写 run.json（D6）
- 实现 _events.log 追加写入

### Step 3: plsql-scanner.ts + artifact-schemas.ts + type-mappings.ts
- 实现 PL/SQL 预扫描器（AST + regex 双模式，自动检测/安装 `@griffithswaite/ts-plsql-parser`）
  - regex 降级模式：BEGIN/END 深度追踪排除 `END IF` / `END LOOP` / `END CASE` 等非块结束关键字
  - regex 降级模式：过程检测支持无参过程（`PROCEDURE init IS`，无括号）
- 定义所有 Zod Schema（InventoryIndexSchema + InventoryPackageSchema + InventorySchema + AnalysisMetaSchema + AnalysisPackageSchema + PlanSchema + ScaffoldSchema + TranslationSchema + ReviewSchema + ReviewSummarySchema + VerifySchema + VerifySummarySchema + FixArtifactSchema + refine 约束）
- 定义类型映射表（ORACLE_TO_JAVA / ORACLE_TO_JDBC）
- 实现 validateCrossSchema()

### Step 4: agent .md 文件
- sql-analyst.md（inventory：基于 inventory-index.json 分批处理 + analyze：三轮分步 + 逐子程序 FSD 生成）
- java-architect.md（plan：读 inventory-index + per-package + analysis + scaffold：读 inventory DDL + per-package types）
- translator.md（translate + fix，translate 逐包持久化，fix 产出 FixArtifact）
- reviewer.md（review + verify，按包独立产出 + 逐包持久化 + 增量模式支持）

### Step 5: plugin/workflow-engine.ts
- 注册 workflow 工具（7 个 action：start / advance / confirm / retry / abort / status / list）
- start action 中集成预扫描：`scanSource(sourcePath)` → 写入 `inventory-index.json`
- 实现 phaseChange hook：system prompt 构建（agent .md + Runtime Context + upstreamArtifacts）
- 实现 beforeLlmCall hook：温度控制 + 工具过滤
- 实现 advance 时 artifact 磁盘校验（含 per-package 校验：inventory-packages/ + analysis-packages/）
- 实现 _events.log 追加写入

### Step 6: command/sql2java.md
- 参数解析和路由（--status / --resume / --phases / 默认全流程）
- --resume 断点续传逻辑（含 run.json 恢复 + per-package 跳过）
- --phases 前置依赖校验 + 连续 advance 跳过

### Step 7: 端到端验证
- 用小样本（bank_core_sql 中 2-3 个有依赖关系的包）跑通全流程
- 检查每个阶段的 artifact 格式符合 Zod Schema
- 检查生成的 Java 项目可 `mvn compile`
- 模拟 translate 中断后 resume 验证跳过逻辑
- 模拟 plan 阶段人工确认流程
- 模拟 review → fix → review 增量重做流程

---

## 验证方式

1. **单元验证**：WorkflowEngine 的 start/advance/confirm/retry 流转正确（含 branchedFrom 追踪、requiresConfirmation 暂停、fix exhausted 双层判定、incrementalContext 构建）
2. **Artifact 验证**：每个阶段的产物符合 Zod Schema（含 refine 约束）
3. **跨 Schema 验证**：validateCrossSchema() 正确检测包名缺失、映射不完整
4. **端到端验证**：
   - `/sql2java /path/to/bank_core_sql` 跑通全流程
   - 预扫描正确生成 inventory-index.json（AST 或 regex）
   - inventory-packages/ 逐包文件覆盖所有包
   - inventory.json 包含完整 DDL 数据（tables/triggers/views/sequences）
   - analysis-packages/ 逐包文件覆盖所有包
   - analysis.json 依赖图（限定名）和包级拓扑排序正确
   - plan 阶段暂停等待确认，confirm 后继续 scaffold
   - Java 项目可 `mvn compile`
   - review-summary.json 汇总所有包的审查结果
5. **产物完整性**：.workflow-artifacts/ 目录下 artifact 文件齐全（含 run.json + inventory-index.json + per-package 文件）
6. **中断恢复验证**：inventory/analyze/translate/review 中途 abort 后 resume，验证已处理包被跳过
7. **事件日志验证**：_events.log 记录每个阶段的启动、完成、失败、确认事件
8. **fix 循环验证**：review(failed) → fix → review(增量) 验证只重审修改过的包
9. **exhausted 验证**：fix 超限后正确标记 completed_with_issues
10. **parser 降级验证**：模拟 parser 安装失败，确认 regex 降级正常工作
11. **regex 精度验证**：含 `END IF` / `END LOOP` 的包体行号范围正确；无参过程（`PROCEDURE init IS`）被正确检测
12. **跨 Schema 兼容验证**：旧格式（`inventory.packages[].name`）和新格式（`inventory.packageNames`）的 artifact 都能通过 validateCrossSchema 校验
