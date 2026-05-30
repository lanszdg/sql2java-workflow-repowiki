# sql2java 端到端转译 MVP 方案

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
  inventory → analyze → plan（人工确认）→ scaffold → translate → review → verify → 完成
                                                               │            │
                                                               ↓ (failed)   ↓ (failed)
                                                               fix ←────────┘
                                                               │
                                                               └→ 回到触发阶段（review 或 verify）
```

单流水线，7 个阶段，一个 runId，无条件前进 + review/verify 失败时进入 fix 循环。

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
│   └── workflow-definitions.ts     # 工作流定义 + Artifact Schema
├── plugin/
│   └── workflow-engine.ts          # 插件入口（workflow 工具 + hooks）
└── README.md
```

---

## Agent 定义（4 个）

**多阶段分发机制**：一个 agent .md 覆盖多个阶段（如 sql-analyst 覆盖 inventory + analyze）。engine 在调用 advance 时，将 `currentPhase` 作为上下文参数注入到 prompt 中。agent .md 按 `## Phase: inventory` / `## Phase: analyze` 分节编写，由注入的 phase 名决定执行哪部分。

### 1. sql-analyst（结构分析）

**对应阶段**：inventory、analyze
**温度**：0.1
**工具**：read、bash（只读）

**inventory 职责**：
- 扫描 SQL 源码目录
- 编目所有 Package、Procedure、Function、Type、Table
- 提取每个子程序的签名、参数、行号范围
- 产出 `inventory.json`（Zod Schema 校验）

**analyze 职责**：
- 基于 inventory 构建调用依赖图
- 拓扑排序确定翻译顺序
- SCC 循环依赖检测 → 简单坍缩为整体
- 复杂度评估（1-10 分）
- **逐包解析子程序内部结构**：语句块（loop / cursor / if-else / exception / SQL / assignment / call）、变量作用域、游标定义、异常处理器 + 翻译注意事项
- **内部分步**：先产出全局依赖图和拓扑排序（轻量），再逐包补充子程序结构解析，避免单次输出过大导致上下文溢出
- 产出 `analysis.json`

### 2. java-architect（架构设计）

**对应阶段**：plan、scaffold
**温度**：0.2
**工具**：read、bash、write、edit
**需人工确认**：plan 阶段完成后

**plan 职责**：
- 根据 inventory + analysis 规划 Java 项目结构
- 确定 Spring Boot 版本、MyBatis 类型、包命名
- 设计类型映射规则、异常策略、命名约定
- 引用 analysis.json 中的 translationOrder 确定翻译顺序
- 产出 `plan.json`（含 CONVENTIONS 规则）

**scaffold 职责**：
- 生成 Maven 项目骨架（pom.xml、目录结构）
- 生成 common 模块（类型映射工具类、异常体系、基础配置）
- 生成 Entity 类（从 DDL 或 inventory 中的表结构）
- 生成空的 Mapper 接口和 Service 壳
- 产出 `scaffold.json` + 实际 Java 文件

### 3. translator（转译执行）

**对应阶段**：translate、fix
**温度**：0.1
**工具**：read、bash、write、edit

**translate 职责**：
- 读取 `analysis.json` 中的 `translationOrder`，按拓扑序逐包翻译
- 根据 `plan.json` 中的映射规则和 CONVENTIONS
- 逐个子程序翻译为 Java 代码（Mapper 接口 + XML + Service + DTO）
- **逐包持久化**：每翻译完一个包，立即将结果写入 `translations/{package}/translation.json` + Java 文件到项目目录
- **中断恢复**：retry 时检查已有 `translation.json`，跳过 status=completed 的包，只翻译剩余包
- 记录翻译决策和 TODO 标记

**fix 职责**：
- 根据 review/verify 的 mustFix 列表修复对应包的翻译问题
- **修复范围**：修全部 mustFix 项（可能跨多个包）
- 不改变整体结构，只修正具体错误
- 产出更新后的 Java 文件 + 更新对应包的 translation.json

**翻译五原则**：
1. 不重构 — 保持原有逻辑结构
2. 不优化 — 游标循环就是 for-each
3. 不合并 — 分立的 SELECT 保持独立
4. 不省略 — 每条 PL/SQL 都要有对应 Java
5. 不猜测 — 不确定的标 `// TODO: [translate]`

### 4. reviewer（审核验证）

**对应阶段**：review、verify
**温度**：0.1
**工具**：read、bash、write

**review 职责**：
- **按包独立审查，逐包持久化**：每审完一个包立即写入 `translations/{package}/review.json`，避免中途崩溃丢失已完成结果
- 对照 analysis 中的子程序结构检查翻译逻辑完整性
- 10 类审查清单：逻辑等价、SQL 完整性、空值处理、类型映射、异常映射、事务边界、游标映射、参数方向、命名一致性、TODO 残留统计
- 全部包审完后产出顶层 `review-summary.json`

**verify 职责**：
- **全局编译验证**：`mvn compile` 全局执行一次，结果归入 `verify-summary.json`
- **按包独立校验，逐包持久化**：每校完一个包立即写入 `translations/{package}/verify.json`
- 每包校验内容：MyBatis XML 校验（namespace 匹配、statement id 匹配）、TODO 残留统计
- 全部包校完后产出顶层 `verify-summary.json`（含编译结果 + 测试骨架生成）
- 生成测试骨架（仅生成，不执行）

---

## 工作流定义

### 单流水线

```
inventory → analyze → plan（人工确认）→ scaffold → translate → review → verify → 完成
                                                               │            │
                                                               ↓ (failed)   ↓ (failed)
                                                               fix ←────────┘
                                                               │
                                                               └→ 回到触发阶段（review 或 verify）
```

| 阶段 | Agent | 温度 | 最大重试 | 说明 |
|------|-------|------|---------|------|
| inventory | sql-analyst | 0.1 | 2 | 扫描编目 |
| analyze | sql-analyst | 0.1 | 2 | 依赖分析 + 拓扑排序 + 子程序结构解析（分步输出） |
| plan | java-architect | 0.2 | 1 | 架构规划（需人工确认） |
| scaffold | java-architect | 0.2 | 1 | 项目骨架生成 |
| translate | translator | 0.1 | 3 | 按拓扑序逐包翻译，逐包持久化 |
| review | reviewer | 0.1 | 1 | 按包独立审查，逐包持久化 |
| verify | reviewer | 0.1 | 2 | 全局编译 + 按包独立校验，逐包持久化 |
| fix | translator | 0.1 | 3 | 根据反馈修复所有 mustFix 项 |

**无条件前进**：inventory → analyze → plan → scaffold → translate → review → verify → 完成

**条件分支**（review / verify failed）：
- review: 所有包 `review.passed === true` → verify, 任一包 `passed === false` → fix
- verify: 所有包 `verify.passed === true` → 完成, 任一包 `passed === false` → fix
- fix 修复全部 mustFix 项后，回到触发它的阶段全量重审
- fix 最多调用 2 次（即最多经历 2 轮 review/verify → fix → review/verify）
- exhausted 后标记 `completed_with_issues`，记录未解决问题到 verify-summary

---

## Artifact Schema（MVP 简化版）

### inventory.json
```typescript
{
  sourcePath: string                            // SQL 源码目录路径
  packages: Array<{
    name: string
    specFile?: string
    bodyFile: string
    procedures: Array<{
      name: string
      type: "procedure" | "function"
      params: Array<{ name: string; oracleType: string; direction: "IN"|"OUT"|"INOUT" }>
      returnType?: string
      lineRange: [number, number]
      loc: number
    }>
    types: Array<{ name: string; kind: string; definition: string }>
    variables: Array<{ name: string; type: string; defaultValue?: string }>
    constants: Array<{ name: string; type: string; value: string }>
  }>
  tables: Array<{
    name: string
    ddlFile?: string                            // DDL 所在文件
    columns: Array<{
      name: string
      oracleType: string
      nullable: boolean
      isPrimaryKey: boolean
      defaultValue?: string
    }>
  }>
  standaloneProcedures: Array<{
    name: string
    type: "procedure" | "function"
    params: Array<{ name: string; oracleType: string; direction: "IN"|"OUT"|"INOUT" }>
    returnType?: string
    sourceFile: string
    lineRange: [number, number]
  }>
}
```

### analysis.json
```typescript
{
  // 限定名格式："packageName.subprogramName"，避免跨包同名冲突
  callGraph: Record<string, string[]>           // 限定名 → 调用的限定名列表
  packageDependency: Record<string, string[]>   // 包名 → 依赖的包名列表（从 callGraph 聚合）
  translationOrder: string[][]                  // 包名的拓扑分层（同层可并行）
  complexity: Record<string, { score: number; patterns: string[]; riskLevel: string }>
  sccGroups: string[][]                         // SCC 坍缩组（限定名列表）
  packages: Array<{                             // 逐包子程序结构解析
    name: string
    subprograms: Array<{
      name: string
      blocks: Array<{
        type: "loop" | "cursor" | "if-else" | "exception-block" | "sql-statement" | "assignment" | "call"
        oracleLine: number
        description: string
        dependencies: string[]                  // 依赖的其他子程序/表（限定名）
      }>
      variables: Array<{ name: string; type: string; scope: string }>
      cursors: Array<{ name: string; query: string; fetchMode: string }>
      exceptionHandlers: Array<{ name: string; actions: string[] }>
      translationNotes: string
    }>
  }>
}
```

### plan.json
```typescript
{
  targetProject: {
    groupId: string
    artifactId: string
    packageBase: string
    javaVersion: string
    springBootVersion: string
  }
  packageMappings: Array<{
    oraclePackage: string
    javaPackage: string
    mapperInterface: string
    serviceClass: string
    serviceImplClass: string
  }>
  rules: {
    namingConvention: "keep-oracle" | "camelCase" | "mixed"
    nullHandling: "optional" | "nullable" | "throw-empty"
    exceptionStrategy: "spring-data" | "custom-business" | "oracle-mirror"
    logFramework: "slf4j" | "log4j2"
  }
  typeMappings: Record<string, string>         // Oracle → Java 类型映射
  manualReviewList: Array<{ procedure: string; reason: string }>
}
```

### scaffold.json
```typescript
{
  projectRoot: string                           // 生成的 Java 项目根目录
  structure: {
    directories: string[]
    pomXml: string
  }
  generated: {
    entities: Array<{ file: string; tableName: string }>
    mapperInterfaces: Array<{ file: string; oraclePackage: string }>
    serviceShells: Array<{ file: string; oraclePackage: string }>
    commonClasses: Array<{ file: string; purpose: string }>
  }
  conventions: string
}
```

### translation.json（每包一个）
```typescript
{
  packageName: string
  status: "completed" | "partial"               // partial: 翻译中断，后续可续传
  completedSubprograms: string[]                // 已翻译的子程序列表
  totalSubprograms: number                      // 该包子程序总数（用于进度判断）
  files: Array<{                                // 只记录路径和角色，不存文件内容
    path: string                                // Java 项目中的相对路径
    role: "mapper-interface" | "mapper-xml" | "service" | "service-impl" | "dto" | "exception"
  }>
  decisions: Array<{
    line: number
    oracleConstruct: string
    javaConstruct: string
    reason: string
    confidence: "high" | "medium" | "low"
  }>
  todos: Array<{ file: string; issue: string; oracleLine: number; suggestion: string }>
}
```

### review.json（每包一个）
```typescript
{
  packageName: string
  passed: boolean
  overallScore: number
  procedureReviews: Array<{
    procedure: string
    checks: Array<{ category: string; passed: boolean; detail: string; severity: string }>
  }>
  mustFix: Array<{ file: string; line?: number; issue: string }>
  suggestions: string[]
  todoRemainingCount: number
}
```

### review-summary.json（顶层汇总）
```typescript
{
  allPassed: boolean
  packageResults: Array<{
    packageName: string
    passed: boolean
    score: number
    mustFixCount: number
  }>
  totalMustFix: number
  totalTodosRemaining: number
}
```

### verify.json（每包一个，只含包级校验）
```typescript
{
  packageName: string
  passed: boolean
  mybatisValidation: { mapperXmlValid: boolean; statementIdsMatch: boolean }
  todoRemainingCount: number
}
```

### verify-summary.json（顶层汇总，含全局编译）
```typescript
{
  allPassed: boolean
  compilation: {                                // 全局 mvn compile 结果
    success: boolean
    errors?: Array<{ file: string; line: number; message: string }>
  }
  packageResults: Array<{
    packageName: string
    passed: boolean
    mybatisValid: boolean
  }>
  testGeneration: {                             // 仅生成骨架，不执行
    generated: boolean
    testFiles: string[]
  }
  totalTodosRemaining: number
  completedWithIssues: boolean                  // fix exhausted 后标记
  unresolvedIssues?: Array<{                    // exhausted 时记录
    packageName: string
    issue: string
  }>
}
```

---

## Artifact 存储

```
.workflow-artifacts/
└── {runId}/
    ├── inventory.json
    ├── analysis.json
    ├── plan.json
    ├── scaffold.json
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
    └── _events.log                            # append-only 事件日志
```

### _events.log 格式

```
[ISO8601] [EVENT_TYPE] [runId] [phase] message
```

事件类型：`START`、`ADVANCE`、`RETRY`、`FAIL`、`COMPLETE`、`ABORT`、`CONFIRM`

示例：
```
[2026-05-30T10:00:00Z] [START] [run-001] - workflow started
[2026-05-30T10:01:23Z] [ADVANCE] [run-001] inventory artifact written
[2026-05-30T10:02:45Z] [ADVANCE] [run-001] analyze artifact written
[2026-05-30T10:03:10Z] [ADVANCE] [run-001] plan artifact written, waiting for confirmation
[2026-05-30T10:05:00Z] [CONFIRM] [run-001] plan confirmed by user
```

---

## Workflow Engine 核心接口

### 核心类型

```typescript
interface WorkflowDefinition {
  id: string
  phases: PhaseConfig[]
  transitions: TransitionRule[]                // 条件转移规则
}

interface PhaseConfig {
  name: string
  agentFile: string                            // 对应的 agent .md 文件路径
  temperature: number
  maxRetries: number
  requiresConfirmation?: boolean               // 为 true 时 advance 后等待人工确认
  tools: string[]                              // 允许的工具列表
}

interface TransitionRule {
  from: string
  condition: "always" | "passed" | "failed"
  to: string                                   // 目标阶段名
}

interface WorkflowRun {
  runId: string
  definitionId: string
  currentPhase: string | null
  status: "running" | "paused" | "completed" | "completed_with_issues" | "aborted"
  phaseHistory: PhaseHistoryEntry[]
  metadata: Record<string, any>
  createdAt: string
  updatedAt: string
}
```

### PhaseHistoryEntry

```typescript
interface PhaseHistoryEntry {
  phase: string
  status: "pending" | "in_progress" | "completed" | "failed" | "completed_with_issues"
  artifactPath?: string
  startedAt: string
  completedAt?: string
  retryCount: number
  branchedFrom?: string                        // fix 阶段记录从哪个阶段触发（review 或 verify）
}
```

### WorkflowEngine

```typescript
class WorkflowEngine {
  start(def: WorkflowDefinition, runId: string, metadata?: Record<string, any>): WorkflowRun
  advance(runId: string, artifact?: any): {
    run: WorkflowRun
    nextPhase: PhaseConfig | null
    finished: boolean
    waitingForConfirmation: boolean             // requiresConfirmation=true 且未确认时返回 true
  }
  confirm(runId: string): WorkflowRun           // 人工确认当前阶段，推进到下一阶段
  retry(runId: string): { run: WorkflowRun; retryCount: number; branchedTo?: string; exhausted: boolean }
  abort(runId: string): WorkflowRun
  status(runId: string): WorkflowRun | null
  listRuns(): WorkflowRun[]
}
```

插件注册的 workflow 工具 action：`start`、`advance`、`confirm`、`retry`、`status`、`abort`、`list`

---

## /sql2java 命令入口

```
/sql2java <path>                        # 端到端全流程
/sql2java --status                      # 查看工作流状态
/sql2java --resume                      # 断点续传
/sql2java --phases plan,scaffold <path> # 指定阶段执行
```

### resume 断点续传策略

1. 读取最新 runId 的 PhaseHistoryEntry
2. 找到最后一个 `completed` 状态的阶段
3. 从下一个阶段继续推进
4. translate 阶段恢复：检查 `translations/{package}/translation.json`，跳过 status=completed 的包
5. review/verify 阶段恢复：同理跳过已有 review.json/verify.json 的包
6. 如果最后阶段是 fix 且 exhausted，标记 `completed_with_issues` 并结束

---

## 与远景方案的裁剪对照

| 远景方案特性 | MVP 状态 | 理由 |
|---|---|---|
| 增量翻译（Wf3） | 不做 | 先做全量 |
| 超大文件分轮 | 不做 | 先假设单文件可单轮处理（上限 500 行 PL/SQL，超出需分块，后续迭代） |
| SCC 循环依赖 | 简单坍缩 | 检测到就合并为一个翻译单元 |
| common_gap 兜底 | 不做 | 遇到缺失标 TODO |
| translator 并行 | 串行 | translate 阶段内部按拓扑序逐包处理 |
| 业务画像独立阶段 | 不做 | 嵌入 analyze 阶段的子程序摘要 |
| IR 中间表示 | analyze artifact 的 packages 字段 | MVP 阶段 JSON artifact 即 IR |
| 详细大纲文件 | 不做 | 子程序结构嵌入 analysis.json |
| 两层工作流编排 | 不做 | 单流水线，translate 内部自行按序处理 |

---

## 技术栈

- **Workflow Engine**：TypeScript（@opencode-ai/plugin 或 Claude Code hooks）
- **Schema 校验**：Zod
- **Agent 定义**：Markdown + YAML frontmatter
- **LLM**：Claude API
- **SQL 解析**：LLM 驱动（sql-analyst Agent 内部用正则 + LLM 提取结构；后续可引入 node-sql-parser 等辅助解析）
- **目标 Java 框架**：Spring Boot + MyBatis + Lombok + Maven

---

## 实现步骤

### Step 1: 项目脚手架
- 初始化 TypeScript 项目
- 创建目录结构（command/、agent/、workflow/、plugin/）

### Step 2: engine-core.ts
- 实现 WorkflowDefinition、WorkflowRun、PhaseConfig、PhaseHistoryEntry 类型
- 实现 WorkflowEngine 类（start / advance / confirm / retry / abort / status / listRuns）
- advance 处理 requiresConfirmation 逻辑
- retry 处理 branchedFrom 追踪和 exhausted 判定

### Step 3: workflow-definitions.ts
- 定义唯一的 WorkflowDefinition（7 阶段 + fix 条件分支 + plan requiresConfirmation）
- 定义 TransitionRule（review/verify failed → fix）
- 定义 Artifact Schema（Zod）
- 定义类型映射表（ORACLE_TO_JAVA / ORACLE_TO_JDBC）

### Step 4: agent .md 文件
- 每个 agent .md 按 `## Phase: xxx` 分节编写
- sql-analyst.md（inventory + analyze，analyze 内部分步输出）
- java-architect.md（plan + scaffold）
- translator.md（translate + fix，translate 逐包持久化）
- reviewer.md（review + verify，按包独立产出 + 逐包持久化）

### Step 5: plugin/workflow-engine.ts
- 注册 workflow 工具（7 个 action，新增 confirm）
- 实现 artifact 存储和摘要
- 实现 system prompt 切换 hook（按阶段加载对应 agent .md + 注入 currentPhase 上下文）
- 实现温度控制 hook
- 实现 _events.log 追加写入

### Step 6: command/sql2java.md
- 参数解析和路由（--status / --resume / --phases / 默认全流程）
- 端到端全流程调度逻辑
- resume 断点续传逻辑（含 translate/review/verify 跳过已有包）

### Step 7: 端到端验证
- 用小样本（bank_core_sql 中 2-3 个有依赖关系的包）跑通全流程
- 检查每个阶段的 artifact 格式正确
- 检查生成的 Java 项目可 mvn compile
- 模拟 translate 中断后 resume 验证跳过逻辑
- 模拟 plan 阶段人工确认流程

---

## 验证方式

1. **单元验证**：WorkflowEngine 的 start/advance/confirm/retry 流转正确（含 branchedFrom 追踪、requiresConfirmation 暂停）
2. **Artifact 验证**：每个阶段的产物符合 Zod Schema
3. **端到端验证**：
   - `/sql2java /path/to/bank_core_sql` 跑通全流程
   - inventory.json 包含所有包和子程序
   - analysis.json 依赖图（限定名）和包级拓扑排序正确
   - plan 阶段暂停等待确认，确认后继续 scaffold
   - Java 项目可 `mvn compile`
   - review-summary.json 汇总所有包的审查结果
4. **产物完整性**：.workflow-artifacts/ 目录下 artifact 文件齐全
5. **中断恢复验证**：translate/review 中途 abort 后 resume，验证已处理包被跳过
6. **事件日志验证**：_events.log 记录每个阶段的启动、完成、失败、确认事件
