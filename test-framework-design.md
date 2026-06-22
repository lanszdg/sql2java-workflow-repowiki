# sql2java 测试框架设计方案

> 状态：待审核 · 2026-06-13
> 范围：定义如何对 `.opencode` 目录下的工作流（代码、运行机制、agent、规约）进行系统化测试
> 关联：本方案与 `todo-tracking-design.md` 体例一致

---

## 1. 背景与目标

`.opencode` 是一套 TS 代码驱动的多阶段工作流（`inventory → analyze → plan → scaffold → translate → dedup → review → verify`，含 `fix` 回环），每个阶段由对应 agent（sql-analyst / java-architect / translator / reviewer）按注入的 Java 代码规约执行。它本质是一个**长程任务**。

> 注：审查清单已从 15 类扩展为 18 类（新增 version-compliance / test-completeness / test-correctness），verify 阶段从"单元测试生成"改为"测试执行"（testExecution 替代 testGeneration）。

本方案的目标：为这套长程工作流建立一套测试框架，使其具备两类测试能力——

| # | 测试类型 | 测什么 | 手段 |
|---|---------|--------|------|
| ① | 代码与运行机制测试 | TS 代码驱动的状态机、路由、前置校验、持久化等确定性逻辑 | 纯代码单测/集成测试 |
| ② | 逻辑正确性测试 | 各 agent 在特定功能点上是否满足规约要求（如异常映射、审查能力） | 执行点测试 + LLM-as-Judge |

**核心约束**：测试的对象必须是 `.opencode` 目录下的内容，保证**测试与运行同源**。测试只能"提供输入"和"判定结果"，不能在测试目录里另造一个转译/审查的临时实现——否则测的不是 `.opencode` 插件本身。

> 门禁（静态检查 → 动态测试 → 提交）属于开发者个人流程，**不在本框架范围内**。本框架只负责"动态测试"这一步，并提供 `exit code` 供外部流程消费。

---

## 2. 设计原则

| 原则 | 含义 |
|------|------|
| **同源** | 被测对象（agent / engine / command / 规约）一律取自 `.opencode`，测试不另造实现 |
| **输入可造** | 测试输入（最小 SQL/Java 片段、前置 artifact fixture）允许现造，属"准备用例" |
| **Oracle 可写** | 判定准则（assertion / judge rubric）是验证手段，可写；但 rubric 必须**引用 `.opencode` 规约条款**（如 java-code-spec "(九)13 禁止空 catch"），不自创新规范 |
| **单点聚焦** | 用最小 fixture 让一个 phase 的产出聚焦在单一功能点上，实现"单点特性任务" |
| **执行点 = phase 边界** | 不为"功能点级触发"另造机制，复用 `.opencode` 原生 `--phases`，靠最小 fixture 达到功能点聚焦 |

---

## 3. 测试分层架构

```
L0  代码单元测试      tests/ts/unit            纯 TS 确定性逻辑（已有，健康）
L1  代码集成测试      tests/ts/integration     状态机/fix循环/persistence（已有，健康）
L2  执行点 LLM 测试   tests/llm/cases          单 phase × 单功能点（核心新增）  ← 本方案重点
L3  端到端工作流      tests/llm/e2e（可选）     完整 /sql2java 全流程
```

- **L0/L1**：现状健康，仅需补少量地基性测试（见 §5）。
- **L2**：本方案核心，`tests/llm/` 现有 harness 骨架正确但需重定位（见 §6、§9）。
- **L3**：可选，后续再议；本方案不展开。

---

## 4. 执行点测试模型（核心概念）

### 4.1 什么是"执行点"

把长程任务拆解为可独立观测、独立测试的环节。**执行点 = 一个 phase**（`.opencode` 原生 `--phases` 的边界）：

```
执行点 = { 目标 phase } × { 精心设计的最小输入 fixture }
```

- 测 translator 异常映射 → 执行点 = `translate` phase + 只含一个 EXCEPTION 块的 SQL
- 测 reviewer 发现缺陷 → 执行点 = `review` phase + 含已知缺陷的 Java

### 4.2 单点聚焦原理

phase 级触发会处理整个包，但**最小 fixture 让产出天然聚焦在单一功能点**：

```
fixture = 一个仅含 EXCEPTION WHEN OTHERS 块的子程序
触发   = opencode run "/sql2java translate <workDir>"     ← 走 .opencode 真实 translator
产出   = translation.json（decisions）+ 一段 Java
判定   = 该段 Java 是否把 EXCEPTION 正确映射为 try-catch（且不吞异常）
```

无需为"功能点级"另造触发机制——`--phases` 已是 `.opencode` 的单点执行能力，"单点特性"由最小 fixture 实现。这正是"sql2java 工作流能支持仅执行单点特性的任务"的落地方式。

### 4.3 颗粒度控制：phase 不是最细粒度

**触发颗粒度（phase）≠ 测试有效颗粒度。** `/sql2java <phase>` 是"执行"的最小可控单元，这是 `.opencode` 的设计，无法也不必打破；但"测试的有效颗粒度"可以一路压到**单个构造级**（如"EXCEPTION WHEN OTHERS → catch(Exception)"这一个映射），靠的是触发层之外的三层。

```
测试有效颗粒度 = 触发层(phase)  ∩  输入聚焦(fixture)  ∩  判定切片(oracle)
                    ↑ 粗的硬边界        ↑ 把产出压窄          ↑ 只取目标片段
```

触发层固定在 phase，后两层把交集压到特性级甚至构造级。

**四层手段（从粗到细）：**

| 层 | 手段 | 作用 | 同源 |
|---|------|------|------|
| ① 触发 | `/sql2java <phase>` | 执行边界（硬约束） | ✅ |
| ② 处理范围 | **`targetPackages` 增量模式**（生产已有） | 把 phase 从"全量包"缩到"单包" | ✅ |
| ③ 输入聚焦 | **最小 fixture** | 输入只含被测构造，产出天然被限制 | ✅ 输入可造 |
| ④ 判定切片 | **oracle 局部取片段** | 产出有耦合也只判目标特性那段 | ✅ oracle 可写 |

> **② 是常被忽略的点**：translator/reviewer 都支持 `incrementalContext.targetPackages`（引擎注入），是 `.opencode` **生产就有**的细粒度能力，测试可直接复用——把处理范围从全量包缩到单包，不是为测试新造的。

**范式：测 translate 的"异常映射"这个细特性**

```
① 触发    opencode run "/sql2java translate <workDir>"   ← phase 级，走真实 translator
② 范围    targetPackages = ["EXC_PKG"]                    ← 只处理这一个包（生产增量能力）
③ 输入    fixture/EXC_PKG.pkb 只含一个 EXCEPTION WHEN OTHERS 块，无游标/无复杂类型
          → translator 产出的 Java 几乎只有这一处 catch
④ 判定    translation.json.decisions 里找到 oracleConstruct="EXCEPTION"
            → 取其 line → 切出 Java 对应 catch 片段
          断言：catch 块非空（正则）
          judge：只把这段 catch 喂给 LLM，rubric 引用 java-code-spec (九)13
```

第 ④ 层是关键：**即便 translator 顺带处理了别的构造，oracle 用 `decisions[].line` 精确定位、只切被测特性的片段**，产出耦合不影响判定聚焦。

**子场景再拆：多 case 矩阵**

一个特性内的多个子场景，拆成多个极小 case，每个一个最小 fixture，用 case 数量换颗粒度：

```
cases/
  translate-exception-no-data-found/     ← EXCEPTION WHEN NO_DATA_FOUND
  translate-exception-too-many-rows/      ← EXCEPTION WHEN TOO_MANY_ROWS
  translate-exception-others/             ← EXCEPTION WHEN OTHERS
  translate-raise-app-error/              ← RAISE_APPLICATION_ERROR → BusinessException
```

**诚实边界：什么时候 phase 触发真的不够**

只有当被测特性依赖 **agent 的"选择性行为"**（在多个合法选项中选哪个）且该选择依赖**无法靠 fixture 构造的上下文**时，phase 触发才力不从心。但规约类特性（异常映射、类型映射、命名、注释语言、reviewer 的 18 类清单）都是"给定输入，产出应符合规约"，**四层手段足够测到构造级**。

**为什么不在 `.opencode` 造"特性级触发"**

不建议给 `/sql2java` 加 `translate --feature exception-mapping` 之类的特性级触发：

- 会让 agent md 变复杂，且测的是"被限制的 agent"而非真实 agent，**违背同源原则**
- 除非该细粒度能力**生产本身就需要**（如 `targetPackages`），否则不为测试污染生产代码

### 4.4 执行点矩阵（示例，非穷尽）

| Phase | 被测 agent | 功能点 case | 判定材料（.opencode 产出） |
|-------|-----------|------------|--------------------------|
| translate | translator | 异常映射（EXCEPTION→try-catch） | Java 代码 + `translation.json.decisions` |
| translate | translator | 类型映射（NUMBER→BigDecimal） | `decisions[].javaConstruct` |
| translate | translator | 游标映射（FOR rec IN → for-each） | Java + Mapper |
| translate | translator | 事务边界（AUTONOMOUS_TRANSACTION→REQUIRES_NEW） | Java 注解 |
| review | **reviewer（被测）** | 能否发现"吞异常"缺陷 | `review.json.mustFix`（category=collection-exception） |
| review | reviewer | 能否发现英文注释（应 major） | `mustFix[].severity` |
| review | reviewer | 能否发现版本合规问题（critical） | `mustFix[].category=version-compliance` |
| verify | reviewer | MyBatis namespace 校验 | `verify.json.mybatisValidation` |

### 4.5 数据流

```
┌─────────────────────────────────────────────────────────────────┐
│  tests/llm/cases/<case>/                                        │
│    fixture/        ← 最小输入（SQL/Java），测试提供              │
│    artifacts/      ← 预置前置 artifact，让 --phases 跳到目标 phase│
│    case.config.ts  ← { phase, trigger, assertions[], rubric }    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ case-loader 加载
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  runTest（harness）                                              │
│    1. 拷 fixture + 预置 artifact 到 workDir/.workflow-artifacts  │
│    2. opencode run "/sql2java <phase> <workDir>"                │
│       └─ 走 .opencode 真实 command → 真实 agent → 真实 engine     │
│    3. 解析该 phase 产出的 artifact + 生成的代码                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ 实际产出
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  判定 Oracle                                                     │
│    确定性断言：读 artifact 结构化字段 / Java 正则·AST            │
│    LLM judge  ：读具体产出 + case rubric（引用规约条款）         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ pass/fail
                               ▼
                          report（exit code 0/1）
```

---

## 5. 需求①：代码与运行机制测试

`tests/ts` 已覆盖 engine-core / workflow-definitions / plsql-scanner / artifact-schemas / type-mappings / constants。补两块**地基性**测试——它们是 L2 执行点测试可信的前提：

| 待补测试 | 文件 | 为什么必要 |
|---------|------|-----------|
| `--phases` 路由 + `PHASE_PREREQUISITES` 前置校验 | `tests/ts/unit/` | 执行点触发靠它；校验错则执行点跳错 phase |
| `transitions` 状态机（review/verify failed → fix → review 回环） | `tests/ts/integration/` | 保证执行点能正确停在目标 phase |

这部分纯 vitest，**不需要动 `.opencode`**。

---

## 6. 需求②：逻辑正确性测试（核心）

### 6.1 判定 Oracle：断言 + judge 配合

| 判定方式 | 适用场景 | 读取对象 |
|---------|---------|---------|
| **确定性断言** | 可机械验证：文件存在、类型映射字段、mustFix 含某 category、catch 块非空（正则/AST） | phase 产出的结构化 artifact + 生成的 Java 源码 |
| **LLM judge** | 需语义判断：异常处理是否逻辑等价、SQL 完整性 | **该执行点 agent 的具体产出** + case rubric（引用规约条款） |

两者都判定 `.opencode` agent 的**真实产出**，不是临时实现。可机械验证的优先用断言（快、稳）；需语义的用 judge。

### 6.2 judge 的角色与改造

judge 是 **test oracle**（验证手段），不是被测对象。它判的是 `.opencode` agent 的真实产出，**保留 judge**，但当前实现三处需改造：

| 维度 | 当前（错） | 执行点范式（对） |
|------|-----------|----------------|
| 粒度 | 对整个 workflow 打综合分 | 针对单个执行点的产出判定 |
| 喂料 | artifact **文件名列表** + stdout 尾部 | 该 phase agent 的**具体产出**（Java 片段 / decisions 数组 / mustFix 列表） |
| rubric | 写死的通用维度 | **case 专项 rubric**，引用 java-code-spec 条款号（如"(九)13"） |

> 说明：写判定 rubric 不违反"同源"原则——rubric 是 oracle（如同单测的 `expect().toBe()`），描述"被测 agent 产出应该是什么样"；只要它判的是 `.opencode` agent 的真实产出即可。rubric 应引用 `.opencode` 已有规约条款，不自创新规范。

### 6.3 reviewer 作为被测对象（重点）

reviewer 不是判定 oracle，而是**被测对象**。范式：

```
构造含已知缺陷的 Java fixture（故意写一个空 catch 块）
  → opencode run "/sql2java review <workDir>"      ← 走 .opencode 真实 reviewer
  → 读 review.json.mustFix
  → 断言：mustFix 中是否存在 category=collection-exception 且 severity∈{critical,major} 的项
       抓到 = reviewer 审查能力有效
       漏判 = reviewer 有漏洞（这是 .opencode 的 bug，正是测试要发现的）
```

这真正测的是"`.opencode` 的审查能力"，而不是任何自写判定逻辑。reviewer.md 已内置 18 类审查清单 + java-code-spec.md 规约，断言可直接对应清单编号（#5 exception-mapping、#15 collection-exception 等）。

### 6.4 前置 artifact fixture 来源（执行点最大成本）

`translate`/`review`/`verify` 有前置依赖。`--phases` 的设计正是"前置 artifact 存在则跳到目标 phase"（见 `PHASE_PREREQUISITES`）。所以前置 artifact 作为**测试输入 fixture**，三种获取方式分层：

| 方式 | 适用 | 成本 |
|------|------|------|
| **手写最小 fixture** | 纯功能点测试（异常映射）—— 手写最小 inventory/analysis/plan/scaffold.json | 低 |
| **复用 artifact-factory** | `tests/ts/helpers/artifact-factory.ts` 已有 `makePlan`/`makeScaffold`/`makeTranslation`/`makeReviewSummary` 等 10 个工厂，程序化构造 | 中 |
| **baseline 提取** | review/verify 等重依赖 phase —— 从一次全流程跑的产物提取 baseline artifact 入库复用 | 高（一次性） |

---

## 7. 需求③：`.opencode` 需要的调整

诚实评估：`.opencode` 现状已为执行点测试打好大部分地基，真正要动的比预想少。

### 7.1 已具备（不用改）✅

- **`--phases` 单阶段执行**（`sql2java.md` 分支 3 + `PHASE_PREREQUISITES`）—— 已是单点执行能力
- **结构化产出**：
  - `translation.json.decisions`：`{ line, oracleConstruct, javaConstruct, reason, confidence }` —— 绝佳的判别材料
  - `review.json.mustFix`：`{ category, severity, file, line, issue }`
  - `verify.json.mybatisValidation`
- **规约自动注入**：java-code-spec.md 由引擎注入 agent prompt（reviewer.md L27、translator.md L29）
- **artifact 工厂**：`tests/ts/helpers/artifact-factory.ts` 已有 10 个构造函数

### 7.2 调整 A：测试模式 / 确定性控制（最关键 gap）⚠️

默认流程有真实副作用，测试需确定性：

| 副作用 | 现状 | 测试需求 | 方案 |
|--------|------|---------|------|
| 数据库连接 | 有 db.xml 则连库拉 schema | translate/review 执行点不应连库 | 测试 workDir 不放 db.xml（已可跳过） |
| verify 阶段 mvn | 跑真实 `mvn compile/test` | 执行点测试可能无 JDK/Maven 环境 | 加测试模式开关 `SQL2JAVA_TEST_MODE=1`，verify 的 mvn 降级为"仅 MyBatis XML 静态校验" |
| runId 带时间戳 | `run-{YYYYMMDD-HHmmss}` | 不影响（`findLatestRunDir` 已定位最新） | 不改 |

> runId 不固定不是阻塞：`run-test.ts` 的 `findLatestRunDir` 已处理"找最新 run 目录"。

### 7.3 调整 B：触发契约标准化（轻量）⚠️

`opencode run "<prompt>"` 需稳定可复现。当前 `run-test.ts` 用环境变量 `SQL2JAVA_SOURCE_PATH` 暗传 sourcePath，与 `/sql2java` 的 `$ARGUMENTS` 解析（命令行 `<path>`）不一致。

**统一为命令行参数形式**（与 sql2java.md 路由一致）：

```
opencode run "/sql2java <phase> <workDir>"
```

在 `.opencode` 文档里固化"执行点测试调用契约"，避免每个 case 各写一套 prompt 逻辑。

### 7.4 调整 C：产出可判别性补强（可选）⚠️

确认 translator 的异常处理决策确实落到 `decisions[]`（含 `javaConstruct="try-catch"`）。若个别功能点产出未结构化，可在 agent md 要求该决策落字段，让 judge/断言能精确引用。**先观察样板 case 产出再决定是否需要**，不预判。

> 结论：`.opencode` 的实质改动主要是**调整 A（测试模式开关）**，B 是文档/契约固化，C 视样板结果而定。

---

## 8. 测试目录结构

```
tests/llm/
  run-tests.sh                    ← 入口（改造：支持 case 粒度）
  case-loader.ts                  ← 新：从 cases/<name>/ 加载 → CaseConfig
  harness/
    run-test.ts                   ← 改造：phase 级触发 + 预置 artifact
    judge.ts                      ← 改造：单执行点 oracle
    assertions.ts                 ← 扩展：phase 产出内容断言 + glob
    report.ts                     ← 保持
    index.ts                      ← 导出更新
  cases/                          ← 一个用例 = 一个子目录
    <case-name>/
      fixture/                    ← 最小输入（SQL / 含缺陷的 Java）—— 测试提供
      artifacts/                  ← 预置前置 artifact，让 --phases 跳到目标 phase
      case.config.ts              ← { phase, trigger, assertions[], rubric }
      run.sh                      ← opencode run "/sql2java <phase> <workDir>"
```

---

## 9. harness 模块详细设计

### 9.1 CaseConfig（执行点用例定义）

```typescript
/** 一个执行点测试用例 */
export interface CaseConfig {
  /** 用例名（= 目录名） */
  name: string
  /** 目标执行点 phase：translate / review / verify / ... */
  phase: PhaseName
  /** 触发命令（走 .opencode 真实 command） */
  trigger: string                  // 如 `/sql2java translate <workDir>`
  /** 工作目录（独立隔离，避免 case 间污染） */
  workDir: string
  /** 确定性断言（可机械验证的点） */
  assertions: Array<(ctx: CaseContext) => AssertionResult>
  /** LLM judge 配置（需语义判断的点；可选） */
  judge?: {
    /** 判定 rubric，引用 .opencode 规约条款 */
    rubric: string                 // 如 "判断生成的 Java 是否符合 java-code-spec (九)13：禁止空 catch、禁止丢弃堆栈"
    /** 喂给 judge 的产出选择器（从 CaseContext 取具体内容） */
    targetSelector: (ctx: CaseContext) => string
    /** 达标阈值 */
    threshold?: number
  }
  /** 超时（默认 600_000） */
  timeout?: number
}

/** 执行点上下文：runTest 产出后供断言/judge 引用 */
export interface CaseContext {
  /** 该 phase 产出的结构化 artifact */
  artifacts: Record<string, unknown>
  /** 生成的 Java 源码（按文件路径） */
  generatedFiles: Record<string, string>
  /** opencode run 的 stdout */
  stdout: string
  /** workDir */
  workDir: string
}
```

### 9.2 case-loader（新）

```typescript
/** 从 tests/llm/cases/<name>/ 加载用例 */
export async function loadCase(name: string): Promise<CaseConfig>
/** 扫描 cases/ 下所有用例 */
export async function loadAllCases(): Promise<CaseConfig[]>
```

职责：读取子目录的 `case.config.ts`（动态 import）、`fixture/`、`artifacts/`，组装成 `CaseConfig`。

### 9.3 runTest 改造

```typescript
export interface RunTestOptions {
  phase: PhaseName
  trigger: string                  // 标准化：/sql2java <phase> <workDir>
  workDir: string
  preloadedArtifactsDir?: string   // 预置前置 artifact 目录，拷入 workDir/.workflow-artifacts
  timeout?: number
}

export async function runExecutionPoint(opts: RunTestOptions): Promise<CaseContext>
```

改造点：
1. prompt 标准化为 `/sql2java <phase> <workDir>`（命令行参数，不用环境变量暗传）
2. 执行前把 `preloadedArtifactsDir` 拷入 `workDir/.workflow-artifacts/`（满足 `PHASE_PREREQUISITES`）
3. 每个 case 用独立 `workDir`（隔离污染）
4. 返回 `CaseContext`（含 `generatedFiles`：读取生成的 Java 源码，供断言/judge）

### 9.4 judge 改造

```typescript
export interface JudgeExecutionPointOptions {
  rubric: string                   // case 专项 rubric（引用规约条款）
  target: string                   // 该执行点 agent 的具体产出（Java 片段 / decisions / mustFix）
  phase: PhaseName
  threshold?: number               // 默认 70
}

export async function judgeExecutionPoint(opts: JudgeExecutionPointOptions): Promise<JudgeResult>
```

改造点：粒度变单执行点、喂料变具体产出（`target`）、rubric 由 case 提供。废弃旧的"整体 workflow 综合分"逻辑。

### 9.5 assertions 扩展

新增断言函数（在现有存在性/schema 断言基础上）：

```typescript
/** 断言生成的 Java 文件存在（支持 glob） */
assertGeneratedFileExists(ctx, globPattern): AssertionResult
/** 断言生成的 Java 内容匹配正则（如 catch 块非空） */
assertJavaMatches(ctx, globPattern, regex): AssertionResult
/** 断言 translation.json.decisions 含特定 oracleConstruct→javaConstruct 映射 */
assertDecision(ctx, oracleConstruct, javaConstruct): AssertionResult
/** 断言 review.json.mustFix 含特定 category 且 severity 达标（用于测 reviewer） */
assertMustFixFound(ctx, category, minSeverity): AssertionResult
```

### 9.6 report

保持现状（断言 + judge 汇总，失败 `exit 1`）。补充 case 维度的报告分组。

---

## 10. 样板 case 详细设计

两个样板代表两类执行点测试，跑通即验证框架闭环。

### 10.1 Case A：translator 异常映射（agent 产出正确性）

**目标**：测 translator 面对含 EXCEPTION 块的 SQL，能否正确映射为不吞异常的 try-catch。

```
tests/llm/cases/translate-exception-mapping/
  fixture/
    pkg/EXC_PKG.pkb               ← 最小输入：只含一个 EXCEPTION WHEN OTHERS 块的子程序
  artifacts/                       ← 预置前置（用 artifact-factory 构造）
    inventory-index.json
    inventory.json
    inventory-packages/EXC_PKG.json
    analysis.json
    analysis-packages/EXC_PKG.json
    plan.json
    scaffold.json
  case.config.ts
  run.sh                           ← opencode run "/sql2java translate <workDir>"
```

**判定**：
- 断言 `assertGeneratedFileExists(ctx, "**/ExcPkgServiceImpl.java")`
- 断言 `assertJavaMatches(ctx, "**/ExcPkgServiceImpl.java", /catch\s*\([^)]+\)\s*\{[\s\S]*\}/)` —— catch 块存在且非空
- judge rubric："判断生成的 Java 是否符合 java-code-spec (九)13：EXCEPTION WHEN OTHERS 应映射为 try-catch，catch 块不得空、不得仅 `e.getMessage()` 丢弃堆栈，必须包装重抛或 `log.error(\"...\", e)`。参考 translator.md 异常映射表。"
  - target：`ctx.generatedFiles["**/ExcPkgServiceImpl.java"]` 的相关片段

### 10.2 Case B：reviewer 发现吞异常缺陷（reviewer 审查能力）⭐ 推荐先做

**目标**：测 reviewer 能否发现一段故意写错的（吞异常）Java 代码。最能体现"测 `.opencode` 本身能力"。

```
tests/llm/cases/review-detect-swallowed-exception/
  fixture/
    generated/.../BadServiceImpl.java   ← 故意写一个空 catch 块（吞异常）
  artifacts/                            ← 预置前置（让 --phases review 可跳过前面阶段）
    plan.json
    scaffold.json
    analysis.json
    analysis-packages/<pkg>.json
    translations/<pkg>/translation.json
  case.config.ts
  run.sh                                ← opencode run "/sql2java review <workDir>"
```

**判定**（纯断言，无需 judge）：
- 断言 `assertMustFixFound(ctx, "collection-exception", "major")` —— reviewer 的 mustFix 必须抓到 category=collection-exception 且 severity≥major
- 断言 `assertMustFixFound` 的 issue 文本包含缺陷文件/行号定位
- **不需要 judge**：reviewer 的结构化 mustFix 即结论。reviewer 是被测对象，其产出就是判定材料。

---

## 11. 落地路线

1. **样板 case 闭环**（先做 Case B reviewer 缺陷发现）
   - 搭 `case-loader` + `runExecutionPoint` 最小可用版
   - 构造 Case B 的 fixture + 预置 artifact（用 artifact-factory）
   - 跑通：fixture → `opencode run "/sql2java review <workDir>"` → 读 review.json → `assertMustFixFound` → 报告
   - 一个跑通，框架立住
2. **harness 改造定型**：judge 执行点化、assertions 扩展、report 分组
3. **`.opencode` 调整 A**：测试模式开关 `SQL2JAVA_TEST_MODE`（verify 的 mvn 降级）—— 等样板遇到真实副作用阻断时再加，不预判
4. **扩展执行点矩阵**：往 `cases/` 填真实用例（对应"用例梳理"）

---

## 12. 范围边界（明确不做的事）

- ❌ 提交门禁 / pre-commit / CI —— 属开发者个人流程
- ❌ 自写转译/审查 prompt 绕过 `.opencode` agent —— 违反同源原则
- ❌ 用 judge 替代 reviewer 做整体审查 —— reviewer 是被测对象，不是 oracle
- ❌ L3 端到端全流程测试 —— 可选，后续再议
- ❌ 现阶段为所有 8 个 phase 全量铺 case —— 先样板验证，再逐步扩展

---

## 13. 风险与权衡

| 风险 | 影响 | 缓解 |
|------|------|------|
| 预置 artifact fixture 构造成本高 | 阻碍 case 扩展 | 三层来源（手写/factory/baseline）；artifact-factory 已有 10 个工厂 |
| `opencode run` 触发 `/sql2java` 不稳定 | 执行点不可信 | 调整 B 固化契约；样板阶段先验证 |
| LLM 产出非确定性 | 同一 case 多次结果不一 | translator/reviewer 已设低 temperature（0.1）；断言优先于 judge；judge 设阈值容忍 |
| verify 依赖真实 Maven 环境 | 执行点跑不动 | 调整 A 测试模式开关降级 mvn |
| judge 自身判定不稳 | 误报/漏报 | judge 仅用于语义点，rubric 引用规约条款降低主观性；关键判定尽量用断言 |

---

## 14. 如何添加测试用例（操作指南）

> 本节是操作手册：把分散在 §4 / §6 / §8 / §9 / §10 的设计串成"加一个用例"的步骤。完整可照抄的样例见 §10。

### 14.1 用例五要素

一个用例 = 一个子目录，含 5 个要素（目录结构详见 §8）：

| 要素 | 文件/位置 | 来源 | 参见 |
|------|----------|------|------|
| 用例定义 | `case.config.ts` | 编写（核心） | §9.1 |
| 触发脚本 | `run.sh` | 编写 | §9.3 |
| 最小输入 | `fixture/` | 测试提供 | §4.3 第③层 |
| 前置 artifact | `artifacts/` | artifact-factory 构造 | §6.4 |
| 判定 | `assertions` / `judge` | 编写 | §6.1 |

### 14.2 命名约定

目录名 = `<phase>-<被测特性>-<场景>`：

- `translate-exception-mapping-others`
- `review-detect-swallowed-exception`
- `verify-mybatis-namespace-mismatch`

### 14.3 添加步骤

**Step 1 · 建目录**：`tests/llm/cases/<name>/`

**Step 2 · 写 `case.config.ts`**（通用骨架，照抄后填）：

```typescript
import type { CaseConfig } from "../../harness"
import { /* 按需引入断言函数 */ } from "../../harness"

const config: CaseConfig = {
  name: "<case-name>",
  phase: "<target-phase>",                 // translate / review / verify / ...
  trigger: "/sql2java <phase> <workDir>",  // 走 .opencode 真实 command
  assertions: [
    // (ctx) => assertXxx(ctx, ...),        // 能机械验证的优先用断言
  ],
  // judge: {                                // 仅需语义判断时才填
  //   rubric: "引用 java-code-spec 条款，如 (九)13 禁止空 catch",
  //   targetSelector: (ctx) => <取出该执行点的具体产出片段>,
  //   threshold: 70,
  // },
  timeout: 600_000,
}

export default config
```

字段填写规范见 §9.1。

**Step 3 · 准备 `fixture/`**：最小输入，只含被测构造（§4.3 第③层输入聚焦）。fixture 是测试输入，允许现造。

**Step 4 · 准备 `artifacts/`**：用 `tests/ts/helpers/artifact-factory.ts`（`makePlan` / `makeScaffold` / `makeAnalysisMeta` 等）构造前置 artifact，让 `--phases` 跳到目标 phase（§6.4 三层来源）。

**Step 5 · 选判定方式**：

| 情况 | 用什么 | 例 |
|------|--------|-----|
| 产出有结构化字段（mustFix / decisions） | **断言** | reviewer 抓缺陷、类型映射字段 |
| 产出是代码、需语义判断 | **judge**（rubric 引用规约条款） | 异常处理是否逻辑等价 |
| 能用正则/AST 机械验证 | **断言** | catch 块非空、命名规约 |

原则：**能断言就断言**（快、稳、不依赖 LLM），judge 仅用于语义点（详见 §6.1）。

**Step 6 · 本地验证**：

```bash
cd tests/llm/cases/<name> && bash run.sh      # 先单独跑，看 .opencode 产出
bash tests/llm/run-tests.sh <name>            # 再跑 harness 断言 + 报告
```

### 14.4 完整样例参考

直接参考 §10 的两个样板，二者覆盖了判定方式的两种典型：

- **§10.1** translator 异常映射 —— agent 产出正确性，**断言 + judge** 配合
- **§10.2** reviewer 发现吞异常缺陷 —— reviewer 审查能力，**纯断言** ⭐ 推荐照此起步

---

## 附：与现状的改动对照

| 模块 | 现状 | 本方案 |
|------|------|--------|
| `tests/ts/{unit,integration}` | 健康 | 补 `--phases` 路由 + transitions 地基测试 |
| `tests/llm/harness/run-test.ts` | 整体触发 + 环境变量暗传 sourcePath | 改为 phase 级触发 + 命令行参数 + 预置 artifact + 返回 CaseContext |
| `tests/llm/harness/judge.ts` | 整体综合分 + 文件名喂料 + 写死 rubric | 重定位为单执行点 oracle（具体产出 + case rubric） |
| `tests/llm/harness/assertions.ts` | 存在性/schema | 扩展 phase 产出内容断言 + glob + Java 匹配 |
| `tests/llm/suites/*.test.ts` | 8 个 TODO 占位 | 废弃，改为 `cases/<name>/` 子目录结构 |
| `tests/llm/case-loader.ts` | 不存在 | 新增 |
| `.opencode` | `--phases` + 结构化 artifact 已具备 | 调整 A（测试模式开关）+ B（触发契约文档化） |
