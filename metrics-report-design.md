# 阶段报告 + 最终报告 — Metrics 采集与展示方案

## Context

当前工作流 9 个阶段的报告只有两个维度：Agent 输出的纯文本 📋 阶段小结（格式松散、LLM 自由发挥）、以及 review/verify 两个阶段的结构化 `*-summary.json`。缺少：
- **Agent/LLM 运行数据**：工具调用次数、LLM API 调用次数、token 消耗（input/output/cache）、费用、耗时
- **结构化的业务报告**：每阶段完成时自动从 artifact JSON 提取业务数据，不依赖 LLM 输出

OpenCode SDK 已在 `StepStartPart`/`StepFinishPart`（每次 API 调用的 tokens/cost）和 `ToolPart`（工具调用状态）中暴露了完整数据，但当前 plugin 没有注册 `event` hook，全部未接入。

## 设计原则

1. **不修改 engine-core.ts** — metrics 采集完全在 plugin 层 + 新文件完成
2. **持久化到 `.workflow-artifacts/{runId}/metrics/`** — 机器可读 JSON + 人类可读文本
3. **自动采集、零侵入** — 注册 `event` hook 监听 SDK 事件，无需 agent 配合
4. **业务数据从 artifact JSON 提取** — 不依赖 agent 输出文本，直接读磁盘上的 JSON
5. **报告不污染 agent 上下文** — 阶段报告文本写入 `metadata.report`，不放入 `output`

## SDK 事件模型

OpenCode 的 LLM 交互模型如下：

```
User Message
  └─ Step 1 (step-start → [tool calls] → step-finish)  ← 1 次 API 调用
  └─ Step 2 (step-start → [tool calls] → step-finish)  ← 1 次 API 调用
  └─ ...
  └─ Step N (step-start → step-finish, reason="end-turn")
```

- **`step-start`** = 一次 LLM API 调用开始
- **`step-finish`** = 一次 LLM API 调用完成，携带 `tokens` + `cost`
- 一个 User Message 可能产生多个 step（tool use 循环）

因此：**count `step-start` 事件 = LLM API 调用次数**，`step-finish` 的 tokens/cost 汇总 = 总消耗。

ToolPart 的状态变化：
- `ToolStatePending` → `ToolStateRunning`（`time.start`）→ `ToolStateCompleted`（`time.start + time.end`）/ `ToolStateError`
- 每次状态变化都会触发 `message.part.updated` 事件

## 数据结构

### TokenUsage

> **设计说明**：SDK `StepFinishPart.tokens` 的 cache 字段为嵌套结构 `cache: { read, write }`，此处有意展平为平铺字段，便于消费和汇总。`recordStepFinish()` 内部负责从 `part.tokens.cache.read` → `cacheRead` 的显式转换。`total` 为 SDK 可选字段，记录后可用于校验 input+output+reasoning 之和。

```typescript
interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number    // ← from SDK tokens.cache.read（展平）
  cacheWrite: number   // ← from SDK tokens.cache.write（展平）
  total?: number       // ← from SDK tokens.total（可选）
}
```

### StepRecord（单次 API 调用记录）

```typescript
interface StepRecord {
  cost: number
  tokens: TokenUsage
  reason: string  // "tool-calls" | "end-turn" | "error" | ...
}
```

### ToolCallRecord（单次工具调用记录）

```typescript
interface ToolCallRecord {
  tool: string
  state: "completed" | "error"
  durationMs?: number  // 自行计算：tool.success/failed timestamp − tool.called timestamp
}
```

### PhaseMetrics（每阶段指标）

```typescript
interface PhaseMetrics {
  phase: string
  runId: string
  fixIndex?: number               // fix 阶段序号（1, 2, ...），非 fix 阶段无此字段
  startedAt: string               // PhaseHistoryEntry.startedAt
  completedAt?: string            // PhaseHistoryEntry.completedAt
  wallDurationMs?: number         // completedAt - startedAt

  // ── LLM 层 ──
  apiCallCount: number            // step-start 计数 = LLM API 调用次数
  apiCalls: StepRecord[]          // 每次 API 调用的详细记录（from step-finish）
  totalCost: number
  totalTokens: TokenUsage

  // ── 工具调用 ──
  toolCallStats: Record<string, { count: number; errors: number }>
  toolCallDetails: ToolCallRecord[]  // 每次调用的详细记录（含耗时）
  totalToolCallCount: number

  // ── 业务数据 ──
  business: PhaseBusinessData | undefined
}
```

### PhaseBusinessData（每阶段业务数据，从 artifact JSON 提取）

```typescript
interface PhaseBusinessData {
  // inventory
  packageCount?: number
  tableCount?: number
  triggerCount?: number
  viewCount?: number
  sequenceCount?: number
  standaloneProcedureCount?: number
  totalProcedureCount?: number

  // analyze
  subprogramCount?: number
  sccGroupCount?: number
  fsdFileCount?: number

  // plan
  javaPackageCount?: number
  packageMappingsCount?: number

  // scaffold
  generatedFiles?: number

  // translate（字段名对齐 TranslationSchema：files, completedSubprograms, totalSubprograms, todos）
  translatedPackageCount?: number
  completedSubprogramCount?: number  // ← from TranslationSchema.completedSubprograms.length（汇总所有包）
  totalSubprogramCount?: number      // ← from TranslationSchema.totalSubprograms（汇总所有包）
  generatedJavaFileCount?: number    // ← sum(TranslationSchema.files.length)
  todoCount?: number

  // dedup（字段名对齐 DedupSchema）
  duplicateGroupsFound?: number       // ← from DedupSchema.scanStats.duplicateGroupsFound
  extractedModuleCount?: number        // ← from DedupSchema.extractedModules.length
  affectedPackageCount?: number        // ← count(unique DedupSchema.packageChanges[].packageName)
  filesExtracted?: number              // ← from DedupSchema.metrics.filesExtracted
  filesModified?: number               // ← from DedupSchema.metrics.filesModified

  // review（averageScore 为计算值：sum(packageResults[].score) / packageResults.length）
  allPassed?: boolean
  totalMustFix?: number
  totalTodosRemaining?: number
  averageScore?: number          // ← 计算值，非直接字段
  reviewedPackageCount?: number

  // verify（compilation.errors 为 optional；testExecution 为必填）
  compilationSuccess?: boolean
  compilationErrorCount?: number   // ← compilation.success?0:compilation.errors?.length??0
  mybatisValidCount?: number       // ← count(packageResults[].mybatisValid===true)
  testFileCount?: number           // ← testExecution.testFiles.length
  testExecuted?: boolean           // ← testExecution.executed
  totalTests?: number              // ← testExecution.totalTests
  passedTests?: number             // ← testExecution.passedTests
  failedTests?: number             // ← testExecution.failedTests

  // fix
  fixedPackageCount?: number
  fixedPackageNames?: string[]
}
```

### RunMetrics（最终汇总）

```typescript
interface RunMetrics {
  runId: string
  status: string
  createdAt: string
  completedAt?: string
  totalWallDurationMs?: number

  // LLM 汇总
  totalApiCallCount: number
  totalCost: number
  totalTokens: TokenUsage

  // 工具汇总
  totalToolCallCount: number
  toolCallStats: Record<string, { count: number; errors: number }>

  // 各阶段
  phases: PhaseMetrics[]

  // 业务汇总
  business: RunBusinessData
}

interface RunBusinessData {
  sourcePath?: string
  oraclePackageCount?: number
  oracleProcedureCount?: number
  oracleTableCount?: number
  javaFileCount?: number
  reviewAverageScore?: number
  reviewPassedRate?: number
  compilationSuccess?: boolean
  testFileCount?: number
  totalTodosRemaining?: number
  fixCyclesCount?: number
}
```

## 文件布局

```
.workflow-artifacts/{runId}/
  metrics/
    inventory.json           # 每阶段一个 JSON（首次）
    analyze.json
    plan.json
    scaffold.json
    translate.json
    dedup.json
    review.json
    verify.json
    fix-1.json               # fix 可能多次，用序号区分
    fix-2.json
    run-metrics.json         # 最终汇总 JSON
  reports/
    inventory-report.txt     # 每阶段文本报告
    analyze-report.txt
    ...
    dedup-report.txt
    fix-1-report.txt         # fix 多次时对应序号
    fix-2-report.txt
    final-report.txt         # 最终文本报告
```

## 修改文件清单

### 1. 新建 `.opencode/workflow/phase-metrics-collector.ts`

核心模块，包含：

**(A) 类型定义** — `TokenUsage`、`StepRecord`、`ToolCallRecord`、`PhaseMetrics`、`PhaseBusinessData`、`RunMetrics`、`RunBusinessData`

**(B) `PhaseMetricsCollector` 类** — 每阶段一个实例，在内存中累计：

```
构造(phase, runId, artifactsDir, fixIndex?)
  → 初始化 metrics 对象，创建 metrics/ 和 reports/ 目录

recordStepStart()
  → apiCallCount++

recordStepFinish(part: { cost, tokens: { input, output, reasoning, cache: { read, write }, total? }, reason })
  → push 到 apiCalls[]，累加 totalTokens（展平 cache.read→cacheRead, cache.write→cacheWrite）+ totalCost

recordToolCalled(callID, toolName, timestamp)
  → 记录 callID→{ toolName, startMs: timestamp } 映射到 runningTools Map

recordToolCompleted(callID, state: "completed" | "error", endTimestamp)
  → 从 runningTools 取出 { toolName, startMs }，计算 durationMs = endTimestamp − startMs
  → push 到 toolCallDetails[]，累加 toolCallStats[toolName].count，error 时 .errors++

finalize(phaseEntry, artifactsDir): PhaseMetrics
  → 设 completedAt、算 wallDurationMs、调用 extractBusinessData() 提取业务数据

getSnapshot(): { apiCallCount: number; totalCost: number; totalTokens: TokenUsage; totalToolCallCount: number; toolCallStats: Record<string, { count: number; errors: number }> }
  → 返回当前累计数据的只读快照（不触发 persist），用于 status 实时查询

getRunningToolCount(): number
  → 返回当前尚未结束的工具调用数量（用于调试）

persist(): void
  → 写 metrics/{phase}.json（fix 阶段为 metrics/fix-{fixIndex}.json）
```

**关于工具耗时采集**：SDK V2 事件 `session.next.tool.success` **不提供** `duration` 字段，需自行从事件 timestamp 差值计算。`recordToolCalled` 记录 `tool.called` 事件的 timestamp 到 `runningTools Map`，`recordToolCompleted` 用 `tool.success`/`tool.failed` 的 timestamp 减去开始时间戳得到 `durationMs`。若 `runningTools` 中无对应 callID（跨阶段边界或事件丢失），`durationMs` 为 undefined。

**(C) `extractBusinessData(phase, artifactsDir)`** — 从磁盘 artifact JSON 提取业务数据：

| 阶段 | 读取文件 | 提取字段 |
|------|---------|---------|
| inventory | `inventory-index.json` | packageCount=packages.length, tableCount=tables.length, triggerCount=triggers.length, viewCount=views.length, sequenceCount=sequences.length, standaloneProcedureCount=standaloneProcedures.length **(计算值)**, totalProcedureCount=sum(packages[].procedures.length)+standaloneProcedures.length **(计算值)** |
| analyze | `analysis.json` + `analysis-packages/*.json` + `fsd/` 目录 | subprogramCount **(需聚合: sum(analysis-packages/*.json 的 subprograms.length)**, sccGroupCount=analysis.json.sccGroups.length, fsdFileCount **(需递归扫描 fsd/ 目录下 .md 文件数)** |
| plan | `plan.json` | javaPackageCount, packageMappingsCount |
| scaffold | `scaffold.json` | generatedFiles=generated.entities.length+generated.mapperInterfaces.length+generated.serviceShells.length+generated.commonClasses.length |
| translate | `translations/*/translation.json`（逐包聚合） | translatedPackageCount=目录数, completedSubprogramCount=sum(completedSubprograms.length), totalSubprogramCount=sum(totalSubprograms), generatedJavaFileCount=sum(files.length), todoCount=sum(todos.length) |
| dedup | `dedup.json` | duplicateGroupsFound=scanStats.duplicateGroupsFound, extractedModuleCount=extractedModules.length, affectedPackageCount=count(unique packageChanges[].packageName), filesExtracted=metrics.filesExtracted, filesModified=metrics.filesModified |
| review | `review-summary.json` | allPassed, totalMustFix, totalTodosRemaining, averageScore **(计算值: sum(packageResults[].score) / length)**, reviewedPackageCount=packageResults.length |
| verify | `verify-summary.json` | compilationSuccess=compilation.success, compilationErrorCount=compilation.success?0:compilation.errors?.length??0, mybatisValidCount=count(packageResults[].mybatisValid===true), testFileCount=testExecution.testFiles.length, testExecuted=testExecution.executed, totalTests=testExecution.totalTests, passedTests=testExecution.passedTests, failedTests=testExecution.failedTests |
| fix | `fix.json` | fixedPackageCount=fixedPackages.length, fixedPackageNames=fixedPackages |

**dedup 阶段容错**：`dedup.json` 可能不存在（项目无重复代码时 dedup 跳过抽取），extractedModules/packageChanges 为空数组时不报错。

**容错设计**：`extractBusinessData` 对每个阶段的提取逻辑独立 try-catch，单个字段提取失败返回 `undefined`（`PhaseBusinessData` 所有字段均为 optional），不影响其他阶段。对旧版 artifact（字段名与 Zod schema 不一致时）做 fallback 映射：
- translate：先读 `completedSubprograms`（Zod schema），fallback 到 `subprograms`（旧版 JSON）
- translate：先读 `files`（Zod schema），fallback 到 `translatedFiles`（旧版 JSON）
- translate：先读 `todos`（Zod schema），fallback 到 `issues`（旧版 JSON）

**(D) `generateRunMetrics(runId, run)`** — 加载所有 `metrics/*.json`，汇总为 RunMetrics，提取 RunBusinessData

**(E) 文本报告格式化器**

- `formatPhaseReport(m: PhaseMetrics): string`
- `formatFinalReport(rm: RunMetrics, run: WorkflowRun): string`
- `formatDuration(ms: number): string` — 如 `"3m 42s"`、`"1h 12m 30s"`
- `formatNumber(n: number): string` — 千分位格式 `"45,230"`

### 2. 修改 `.opencode/plugins/workflow-engine.ts`

**(A) 新增导入**

```typescript
import {
  PhaseMetricsCollector,
  generateRunMetrics, formatPhaseReport, formatFinalReport,
  formatDuration,
} from "../workflow/phase-metrics-collector"
```

**(B) 新增模块级变量**

```typescript
let activeCollector: PhaseMetricsCollector | null = null

/** fix 阶段序号追踪（同一 runId 内递增） */
const fixPhaseIndexMap = new Map<string, number>()

/**
 * 跨 session 恢复 fixIndex：从 metrics/ 目录下已有的 fix-*.json 文件数推导序号。
 * 在 setWorkflowContext 检测到 fix 阶段且 fixPhaseIndexMap 中无记录时调用。
 */
function recoverFixIndex(runId: string): number {
  const metricsDir = join(ARTIFACT_DIR, runId, "metrics")
  if (!existsSync(metricsDir)) return 0
  const existing = readdirSync(metricsDir).filter(f => /^fix-\d+\.json$/.test(f))
  return existing.length
}
```

**(C) 修改 `setWorkflowContext()`** — 创建 collector

```typescript
function setWorkflowContext(run: WorkflowRun): void {
  // ...existing code...
  const artifactsDir = join(ARTIFACT_DIR, run.runId)
  const isFix = SQL2JAVA_WORKFLOW.phases.find(p => p.name === run.currentPhase)?.isFixPhase
  let fixIndex: number | undefined
  if (isFix) {
    const existing = fixPhaseIndexMap.get(run.runId)
    fixIndex = existing !== undefined ? existing + 1 : recoverFixIndex(run.runId) + 1
    fixPhaseIndexMap.set(run.runId, fixIndex)
  }
  activeCollector = new PhaseMetricsCollector(
    run.currentPhase ?? "unknown", run.runId, artifactsDir, fixIndex,
  )
}
```

**(D) 修改 `clearWorkflowContext()`** — 清理 collector

```typescript
function clearWorkflowContext(): void {
  currentWorkflowContext = null
  activeCollector = null       // 新增
  _cachedJavaCodeSpec = null
  _cachedSpecMtime = null
}
```

**(E) 新增 `event` hook** — 注册到 plugin 返回对象

> **设计选择**：使用 SDK V2 事件（`session.next.*`）而非 `message.part.updated`。V2 事件更结构化，且 `session.next.tool.success`/`.failed` 提供 timestamp，可配合 `tool.called` 的 timestamp 计算耗时。两种事件类型对同一操作都会触发，**只监听 V2 事件以避免重复计数**。

```
event hook 逻辑：
  1. 检查 currentWorkflowContext 和 activeCollector 非空 → 否则 return
  2. 根据 event.type 分发：

     "session.next.step.started"
       → activeCollector.recordStepStart()

     "session.next.step.ended"
       → activeCollector.recordStepFinish({
           cost: event.properties.cost,
           tokens: event.properties.tokens,   // { input, output, reasoning, cache: { read, write }, total? }
           reason: event.properties.finish,
         })

     "session.next.step.failed"
       → activeCollector.recordStepFinish({
           cost: 0,
           tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
           reason: "error: " + event.properties.error?.message ?? "unknown",
         })
       → ⚠️ SDK 不提供 failed step 的 cost/tokens，记零值，在报告中标注为"含 N 次失败 step"

     "session.next.tool.called"
       → activeCollector.recordToolCalled(event.properties.callID, event.properties.tool, event.properties.timestamp)

     "session.next.tool.success"
       → activeCollector.recordToolCompleted(event.properties.callID, "completed", event.properties.timestamp)

     "session.next.tool.failed"
       → activeCollector.recordToolCompleted(event.properties.callID, "error", event.properties.timestamp)

     其他事件 → 忽略
```

⚠️ **关于事件与阶段的对应关系**：

event hook 收到的所有事件都**属于当前 session 的整个对话**，并非仅限当前阶段。需要通过 `currentWorkflowContext` 来区分——只有当 `currentWorkflowContext` 非空时（即某个阶段正在执行中），才将事件归入当前 collector。阶段之间的间隙（如用户确认、人工干预）中 `currentWorkflowContext` 为 null，事件会被忽略，这正是预期行为。

但存在一个**边界问题**：阶段的第一个 `step-start` 可能在 `setWorkflowContext()` 之前就已触发（例如 start action 返回后，LLM 立即开始调用，event 和 tool output 几乎同时产生）。这意味着第一批事件可能被遗漏。

**解决方案**：不依赖"不遗漏"，而是在 `finalize()` 时用 `PhaseHistoryEntry.startedAt/completedAt` 计算准确的时间数据。LLM 指标（tokens/cost）来自 `AssistantMessage` 的累计值——在 `finalize()` 时从 `EventMessageUpdated` 中读取该阶段所有 assistant message 的 `cost` 和 `tokens` 字段，作为**校验基线**。如果 collector 累计值与 assistant message 累计值不一致，以 assistant message 为准并在日志中记录偏差。

实际实现中，为简化第一版，可以先不做 assistant message 校验，而是在报告格式化器中标注 `metrics` 数据为"采集值"而非"精确值"，避免用户误解。后续迭代再增加校准机制。

**(F) 修改 `advance` case** — 阶段结束时 finalize + persist + 生成报告

在 `engine.advance()` 返回后、return 之前，按分支处理：

```
let phaseReportText: string | undefined

if (activeCollector && 阶段成功 completed) {
  const entry = adv.run.phaseHistory 中找到刚完成的 entry
  const metrics = activeCollector.finalize(entry, artifactsDir)
  activeCollector.persist()  // 写 metrics/{phase}.json 或 fix-{fixIndex}.json
  phaseReportText = formatPhaseReport(metrics)
  写 reports/{phase}-report.txt 或 fix-{fixIndex}-report.txt
}

if (adv.finished) {
  generateRunMetrics() + 写 metrics/run-metrics.json
  const finalText = formatFinalReport(...)
  写 reports/final-report.txt
  return { title, output: existingOutput, metadata: { ..., report: phaseReportText + finalText } }
}

if (adv.waitingForConfirmation) {
  return { title, output: existingOutput, metadata: { ..., report: phaseReportText } }
}

// 正常前进到下一阶段
if (!adv.rejected && !adv.fixFailed) {
  setWorkflowContext(adv.run)  // 内部创建新 collector
  return { title, output: existingOutput, metadata: { ..., report: phaseReportText } }
}

// rejected/fixFailed → collector 保持活跃，不 finalize，不生成报告
```

**关键：报告文本放在 `metadata.report` 中，不追加到 `output`。**

原因：`output` 会进入 agent 的上下文（作为 tool call 返回值），追加大段报告会：
- 浪费 token（每次 LLM 调用都要读这些历史文本）
- 干扰 agent 对 tool 返回值的理解

`metadata` 由 OpenCode 框架处理，可用于 TUI 展示但不进入 LLM 上下文。当前代码中所有 advance 分支的 return 都带有 `metadata` 字段，追加 `report` 键不会影响现有逻辑。

⚠️ **待验证**：实现前需确认 OpenCode 框架确实不会将 `metadata` 序列化到 LLM 上下文中。若验证发现 `metadata` 会进入上下文，则改用"metadata 只放报告文件路径、报告全文仅写磁盘"方案。

⚠️ **报告拼接**：`adv.finished` 时不要将阶段报告与最终报告拼接为单一字符串（过长）。改为 `metadata.report = phaseReportText`，`metadata.finalReport = finalText`，分别传递。

**(G) 修改 `retry` case** — retry 成功时重置 collector

```typescript
case "retry": {
  // ...existing engine.retry()...
  if (!ret.exhausted) {
    // 重置 collector：retry 创建新 PhaseHistoryEntry，从零开始累计
    if (currentWorkflowContext) {
      const artifactsDir = join(ARTIFACT_DIR, currentWorkflowContext.runId)
      activeCollector = new PhaseMetricsCollector(
        currentWorkflowContext.phase, currentWorkflowContext.runId, artifactsDir,
      )
    }
    return { ... }
  }
}
```

**(H) 修改 `formatPhaseEndBanner` 调用** — 传入 duration

从 PhaseHistoryEntry 的 startedAt/completedAt 计算：

```typescript
function computeDurationFromHistory(run: WorkflowRun, phaseName: string): string | undefined {
  // 找最后一个 completed 的该阶段 entry
  const entries = run.phaseHistory.filter(
    e => e.phase === phaseName && e.status === "completed" && e.startedAt && e.completedAt
  )
  const entry = entries[entries.length - 1]
  if (!entry) return undefined
  const ms = new Date(entry.completedAt!).getTime() - new Date(entry.startedAt).getTime()
  return formatDuration(ms)
}
```

advance case 中所有 `formatPhaseEndBanner(prevPhase)` 调用改为：
```typescript
const duration = adv.run ? computeDurationFromHistory(adv.run, prevPhase) : undefined
const endBanner = formatPhaseEndBanner(prevPhase, duration)
```

**(I) 修改 `status` case** — 增强展示当前阶段的实时 metrics

```typescript
case "status": {
  // ...existing code...
  // 如果 run 正在运行且有 activeCollector，附加实时 metrics 摘要
  const liveMetrics = activeCollector?.getSnapshot()
  return {
    title: r.status,
    output: JSON.stringify({ ...existingOutput, liveMetrics }, null, 2),
    metadata: { runId: r.runId, liveMetrics },
  }
}
```

`getSnapshot()` 返回当前 collector 的累计数据（不 finalize），让用户可以通过 `workflow({action:"status"})` 实时看到当前阶段的 LLM 用量和工具调用情况。

### 3. 不修改 `.opencode/workflow/engine-core.ts`

WorkflowRun 类型不变，PhaseHistoryEntry 类型不变。所有 metrics 采集在 plugin 层完成。

## 报告格式

### 阶段报告示例（文本）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 inventory 阶段报告
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⏱ 耗时: 3m 42s

🤖 LLM 使用
  API 调用: 8 次
  费用: $0.0342
  Token 消耗:
    输入:       45,230  (缓存命中: 38,100)
    输出:       12,450
    推理:        1,200

🔧 工具调用 (共 45 次)
  read:    24 次
  write:   13 次
  bash:     8 次

📦 业务数据
  Oracle 包:     13
  表:            28
  触发器:         5
  子程序总数:    89
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 最终报告示例（文本）

```
╔══════════════════════════════════════════════╗
║          🏁 工作流最终报告                     ║
╚══════════════════════════════════════════════╝

Run ID: run-20260605-013119
状态:   completed
总耗时: 42m 15s

┌─ 🤖 LLM 总用量 ──────────────────────────────┐
│  API 调用:  87 次                              │
│  总费用:    $0.4231                            │
│  Token 消耗:                                  │
│    输入:     520,340  (缓存命中: 412,200)      │
│    输出:     145,670                           │
│    推理:      23,100                           │
└──────────────────────────────────────────────┘

┌─ 🔧 工具调用总计: 312 次 ─────────────────────┐
│  read:    156    write:   78                   │
│  bash:     52    edit:    26                   │
└──────────────────────────────────────────────┘

┌─ ⏱ 各阶段详情 ───────────────────────────────┐
│  阶段         耗时     API   费用     工具     │
│  ────────── ─────── ───── ─────── ───────     │
│  inventory   3m 42s     8  $0.034      45     │
│  analyze    12m 18s    23  $0.089     112     │
│  plan        4m 05s     9  $0.041      32     │
│  scaffold    2m 30s     5  $0.022      18     │
│  translate  15m 22s    32  $0.187      89     │
│  review      3m 15s     7  $0.038      28     │
│  verify      1m 03s     3  $0.012      12     │
└──────────────────────────────────────────────┘

┌─ 📦 业务汇总 ────────────────────────────────┐
│  Oracle 包:      13    子程序:    89           │
│  表:             28    Java 文件:  67          │
│  Review 均分:   96.2  通过率:  100%            │
│  编译:          PASS   TODO:      3           │
│  Fix 循环:       0                              │
└──────────────────────────────────────────────┘
```

## 边缘情况处理

| 场景 | 处理方式 |
|------|---------|
| inventory/analyze/translate 分批处理，多次 API 调用 | collector 累计所有 step-start/step-finish/tool 事件 |
| advance rejected（Zod 校验失败） | collector 保持活跃，继续累计，LLM 修正后重试 |
| fix 循环多次 | 每次 fix 的 metrics 用序号区分（`fix-1.json`、`fix-2.json`），fixPhaseIndexMap 追踪序号 |
| retry 重试阶段 | 重置 collector，从零开始累计新 entry 的数据 |
| 跨 session 恢复 | metrics/ 目录持久化在磁盘，恢复后新 collector 从头累计当次执行 |
| 工作流完成但无 metrics | `generateRunMetrics` 容错：metrics/ 目录不存在时只包含 phaseHistory 中的时间数据 |
| resume 恢复已有 run | `setWorkflowContext(existing)` 创建新 collector，从恢复点开始累计 |
| 工作流 aborted | `clearWorkflowContext()` 清理 collector，不生成报告 |
| 工作流 completed_with_issues（fix exhausted） | `adv.finished === true`，仍正常 finalize 最后阶段 + 生成 run-metrics.json + final-report.txt，status 字段如实记录为 "completed_with_issues"，fixCyclesCount 从 phaseHistory 中统计 fix 条目数 |
| 阶段首尾事件遗漏 | finalize 以 PhaseHistoryEntry 的时间戳为准；LLM metrics 为采集值，第一版不校准 |
| step failed（API 调用异常） | `recordStepFinish` 记录零值 cost/tokens + reason="error: ..."，报告中标注"含 N 次失败 step" |
| 旧版 artifact 字段名不一致 | `extractBusinessData` 内做 fallback 映射（详见容错设计段落） |
| tool.called 后无对应 success/failed 事件（跨阶段边界） | `runningTools Map` 中残留条目，finalize 时清理不计入 toolCallDetails |

## 实现顺序

1. **创建 `phase-metrics-collector.ts`**：类型定义 + Collector 类 + extractBusinessData + 报告格式化器 + generateRunMetrics
2. **修改 `workflow-engine.ts`**：event hook + collector 生命周期 + advance 中 finalize/persist + metadata 传递 + status 增强
3. **修改 `formatPhaseEndBanner` 调用**：传入 duration
4. **回放测试**：用现有 `.workflow-artifacts/run-20260605-013119/` 数据验证 extractBusinessData 字段提取

## 验证方式

1. **单元验证**：用现有 artifact 数据调用 `extractBusinessData()`，确认每个阶段的字段正确提取
2. **集成验证**：启动一次完整工作流（或从某个阶段开始），观察：
   - `metrics/` 目录下每阶段 JSON 是否正确生成（apiCallCount、tokens、cost 等）
   - `reports/` 目录下每阶段文本报告格式是否正确
   - 工作流完成时 `run-metrics.json` 和 `final-report.txt` 汇总是否正确
   - `metadata.report` 中包含报告文本，`output` 中不包含报告文本
3. **拒绝场景**：故意触发 Zod 校验失败，确认 collector 不被清理、重试后数据正确累计
4. **fix 循环**：触发 review 失败 → fix → review → 如再次失败 → fix-2，确认序号递增
