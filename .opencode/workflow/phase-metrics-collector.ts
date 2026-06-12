/**
 * Phase Metrics Collector — 工作流阶段指标采集与报告生成
 *
 * 在 plugin 层采集 LLM API 调用指标（tokens/cost/工具调用），
 * 并从 artifact JSON 提取业务数据，生成结构化报告。
 *
 * 设计约束：
 *   - 不修改 engine-core.ts
 *   - SDK timestamp 是 epoch 毫秒 number
 *   - session.next.tool.success 不提供 duration，从 timestamp 差值计算
 *   - session.next.step.failed 不提供 cost/tokens，记录零值
 *   - extractBusinessData 每个字段独立 try-catch
 */

import {
  readFileSync, existsSync, mkdirSync,
  readdirSync, statSync,
} from "node:fs"
import { join } from "node:path"
import { safeWriteFile } from "./cross-platform"
import type { PhaseHistoryEntry, WorkflowRun } from "./engine-core"
import { getLogger } from "./workflow-logger"

// ── Type Definitions ──────────────────────────────────────────────────────────

/** 展平的 token 用量（SDK tokens.cache.read → cacheRead） */
interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number     // ← from SDK tokens.cache.read
  cacheWrite: number    // ← from SDK tokens.cache.write
  total?: number        // ← SDK 可选字段
}

/** 单次 LLM API 调用记录 */
interface StepRecord {
  cost: number
  tokens: TokenUsage
  reason: string        // "tool-calls" | "end-turn" | "error: ..."
}

/** 单次工具调用记录 */
interface ToolCallRecord {
  tool: string
  state: "completed" | "error"
  durationMs?: number   // 自行计算：tool.success/failed timestamp − tool.called timestamp
}

/** 每阶段指标 */
interface PhaseMetrics {
  phase: string
  runId: string
  fixIndex?: number
  startedAt: string
  completedAt?: string
  wallDurationMs?: number

  // ── LLM 层 ──
  apiCallCount: number
  apiCalls: StepRecord[]
  totalCost: number
  totalTokens: TokenUsage

  // ── 工具调用 ──
  toolCallStats: Record<string, { count: number; errors: number }>
  toolCallDetails: ToolCallRecord[]
  totalToolCallCount: number

  // ── 业务数据 ──
  business?: PhaseBusinessData

  /** 标记异常终止（abort/retry-exhausted），generateRunMetrics 可据此区分 */
  incomplete?: boolean
}

/** 每阶段业务数据（从 artifact JSON 提取，全 optional） */
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

  // translate
  translatedPackageCount?: number
  completedSubprogramCount?: number
  totalSubprogramCount?: number
  generatedJavaFileCount?: number
  todoCount?: number

  // review
  allPassed?: boolean
  totalMustFix?: number
  totalTodosRemaining?: number
  averageScore?: number
  reviewedPackageCount?: number
  passedPackageCount?: number

  // verify
  compilationSuccess?: boolean
  compilationErrorCount?: number
  mybatisValidCount?: number
  testFileCount?: number

  // fix
  fixedPackageCount?: number
  fixedPackageNames?: string[]

  // dedup
  dedupPackagesScanned?: number
  dedupFilesScanned?: number
  dedupDuplicateGroups?: number
  dedupExtractedModules?: number
  dedupFilesExtracted?: number
  dedupFilesModified?: number
  dedupLinesRemoved?: number
  dedupLinesAdded?: number
}

/** 最终汇总 */
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

/** 运行级业务汇总 */
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

/** getSnapshot() 返回类型 */
interface MetricsSnapshot {
  apiCallCount: number
  totalCost: number
  totalTokens: TokenUsage
  totalToolCallCount: number
  toolCallStats: Record<string, { count: number; errors: number }>
}

// ── Utility Helpers ───────────────────────────────────────────────────────────

/** 零值 TokenUsage 工厂 */
function zeroTokenUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

/** 累加 token 字段（就地修改 target） */
function addTokenUsage(target: TokenUsage, source: TokenUsage): void {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

/** 防御性 JSON 读取，失败返回 null */
function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 安全数值转换（缺失返回 0，用于 LLM 层指标汇总） */
function safeNumber(val: unknown): number {
  return typeof val === "number" ? val : 0
}

/** 可选数值转换（非 number 时返回 undefined，用于业务数据提取，避免缺失字段误报为 0） */
function optionalNumber(val: unknown): number | undefined {
  return typeof val === "number" ? val : undefined
}

/** 递归统计目录下指定扩展名文件数 */
function countFilesRecursive(dir: string, ext: string): number {
  if (!existsSync(dir)) return 0
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      count += countFilesRecursive(full, ext)
    } else if (entry.name.endsWith(ext)) {
      count++
    }
  }
  return count
}

/** 安全获取数组的 length */
function safeArrayLen(val: unknown): number {
  return Array.isArray(val) ? val.length : 0
}

// ── PhaseMetricsCollector Class ───────────────────────────────────────────────

class PhaseMetricsCollector {
  private metrics: PhaseMetrics
  private runningTools = new Map<string, { toolName: string; startMs: number }>()
  private metricsDir: string

  constructor(phase: string, runId: string, artifactsDir: string, fixIndex?: number) {
    this.metrics = {
      phase,
      runId,
      fixIndex,
      startedAt: new Date().toISOString(),
      apiCallCount: 0,
      apiCalls: [],
      totalCost: 0,
      totalTokens: zeroTokenUsage(),
      toolCallStats: {},
      toolCallDetails: [],
      totalToolCallCount: 0,
    }
    this.metricsDir = join(artifactsDir, "metrics")
    if (!existsSync(this.metricsDir)) {
      mkdirSync(this.metricsDir, { recursive: true })
    }
    const reportsDir = join(artifactsDir, "reports")
    if (!existsSync(reportsDir)) {
      mkdirSync(reportsDir, { recursive: true })
    }
  }

  /** 记录 step-finish 事件 → 展平 cache 并累加 */
  recordStepFinish(input: {
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache?: { read: number; write: number }
      total?: number
    }
    reason: string
  }): void {
    const flatTokens: TokenUsage = {
      input: safeNumber(input.tokens.input),
      output: safeNumber(input.tokens.output),
      reasoning: safeNumber(input.tokens.reasoning),
      cacheRead: safeNumber(input.tokens.cache?.read),
      cacheWrite: safeNumber(input.tokens.cache?.write),
      total: input.tokens.total,
    }
    this.metrics.apiCallCount++
    this.metrics.apiCalls.push({ cost: input.cost, tokens: flatTokens, reason: input.reason })
    this.metrics.totalCost += input.cost
    addTokenUsage(this.metrics.totalTokens, flatTokens)
  }

  /** 记录 tool.called 事件 → 存入 runningTools Map */
  recordToolCalled(callID: string, toolName: string, timestamp: number): void {
    // 防御 undefined/NaN timestamp：若 SDK 事件缺失 start 字段，存入 0 标记为未知
    this.runningTools.set(callID, { toolName, startMs: typeof timestamp === "number" && isFinite(timestamp) ? timestamp : 0 })
  }

  /** 记录 tool.success/failed 事件 → 计算 duration 并归档 */
  recordToolCompleted(callID: string, state: "completed" | "error", endTimestamp: number): void {
    const entry = this.runningTools.get(callID)
    if (!entry) return // 跨阶段边界或事件丢失，静默忽略

    // startMs 为 0 表示原始 timestamp 缺失，不计算 duration
    const durationMs = entry.startMs > 0 && typeof endTimestamp === "number" && isFinite(endTimestamp)
      ? endTimestamp - entry.startMs
      : undefined
    this.metrics.toolCallDetails.push({ tool: entry.toolName, state, durationMs })
    this.metrics.totalToolCallCount++

    if (!this.metrics.toolCallStats[entry.toolName]) {
      this.metrics.toolCallStats[entry.toolName] = { count: 0, errors: 0 }
    }
    this.metrics.toolCallStats[entry.toolName].count++
    if (state === "error") {
      this.metrics.toolCallStats[entry.toolName].errors++
    }
    this.runningTools.delete(callID)
  }

  /** 阶段结束时调用：设置权威时间戳 + 提取业务数据 */
  finalize(phaseEntry: PhaseHistoryEntry, artifactsDir: string): PhaseMetrics {
    // 用 PhaseHistoryEntry 的时间戳覆盖（权威数据源）
    this.metrics.startedAt = phaseEntry.startedAt
    this.metrics.completedAt = phaseEntry.completedAt

    if (phaseEntry.completedAt && phaseEntry.startedAt) {
      this.metrics.wallDurationMs =
        new Date(phaseEntry.completedAt).getTime() - new Date(phaseEntry.startedAt).getTime()
    }

    // 提取业务数据
    this.metrics.business = extractBusinessData(this.metrics.phase, artifactsDir)

    // 清理 runningTools 残留项（跨阶段边界遗漏的 tool 调用）
    if (this.runningTools.size > 0) {
      const orphaned = [...this.runningTools.keys()]
      getLogger().warn("[metrics]", `清理 ${orphaned.length} 个未完成的工具调用: ${orphaned.join(", ")}`)
      this.runningTools.clear()
    }

    return { ...this.metrics }
  }

  /** 返回 collector 所属的 runId（用于 runId 匹配校验） */
  get runId(): string {
    return this.metrics.runId
  }

  /** 返回当前累计数据快照（不触发 persist） */
  getSnapshot(): MetricsSnapshot {
    return {
      apiCallCount: this.metrics.apiCallCount,
      totalCost: this.metrics.totalCost,
      totalTokens: { ...this.metrics.totalTokens },
      totalToolCallCount: this.metrics.totalToolCallCount,
      toolCallStats: Object.fromEntries(
        Object.entries(this.metrics.toolCallStats).map(([k, v]) => [k, { ...v }]),
      ),
    }
  }

  /** 原子写入 metrics JSON（使用 safeWriteFile 统一错误处理） */
  persist(): void {
    const filename = this.metrics.fixIndex != null
      ? `fix-${this.metrics.fixIndex}.json`
      : `${this.metrics.phase}.json`
    const filePath = join(this.metricsDir, filename)
    safeWriteFile(filePath, JSON.stringify(this.metrics, null, 2), (e) => {
      getLogger().warn("[metrics]", `persist 失败: ${e.message}`)
    })
  }

  /**
   * 异常终止时调用：尽力填充 completedAt/wallDurationMs，标记 incomplete，
   * 然后 persist。用于 abort / retry-exhausted 等无 PhaseHistoryEntry 的场景。
   */
  persistAsIncomplete(): void {
    this.metrics.incomplete = true
    const now = new Date().toISOString()
    this.metrics.completedAt = now
    if (this.metrics.startedAt) {
      this.metrics.wallDurationMs =
        new Date(now).getTime() - new Date(this.metrics.startedAt).getTime()
    }
    this.persist()
  }
}

// ── extractBusinessData ───────────────────────────────────────────────────────

/** 从磁盘 artifact JSON 提取业务数据，每字段独立 try-catch */
function extractBusinessData(phase: string, artifactsDir: string): PhaseBusinessData {
  const data: PhaseBusinessData = {}

  switch (phase) {
    case "inventory":
      extractInventoryData(data, artifactsDir)
      break
    case "analyze":
      extractAnalyzeData(data, artifactsDir)
      break
    case "plan":
      extractPlanData(data, artifactsDir)
      break
    case "scaffold":
      extractScaffoldData(data, artifactsDir)
      break
    case "translate":
      extractTranslateData(data, artifactsDir)
      break
    case "review":
      extractReviewData(data, artifactsDir)
      break
    case "verify":
      extractVerifyData(data, artifactsDir)
      break
    case "fix":
      extractFixData(data, artifactsDir)
      break
    case "dedup":
      extractDedupData(data, artifactsDir)
      break
  }

  return data
}

function extractInventoryData(data: PhaseBusinessData, dir: string): void {
  const json = readJsonSafe(join(dir, "inventory-index.json"))
  if (!json) return

  try { data.packageCount = safeArrayLen(json.packages) } catch { /* skip */ }
  try { data.tableCount = safeArrayLen(json.tables) } catch { /* skip */ }
  try { data.triggerCount = safeArrayLen(json.triggers) } catch { /* skip */ }
  try { data.viewCount = safeArrayLen(json.views) } catch { /* skip */ }
  try { data.sequenceCount = safeArrayLen(json.sequences) } catch { /* skip */ }
  try { data.standaloneProcedureCount = safeArrayLen(json.standaloneProcedures) } catch { /* skip */ }

  // totalProcedureCount = sum(packages[].procedures.length) + standaloneProcedures.length
  try {
    const pkgs = json.packages
    if (Array.isArray(pkgs)) {
      const procInPackages = pkgs.reduce(
        (sum: number, pkg: unknown) => sum + safeArrayLen((pkg as Record<string, unknown>).procedures),
        0,
      )
      data.totalProcedureCount = procInPackages + (data.standaloneProcedureCount ?? 0)
    }
  } catch { /* skip */ }
}

function extractAnalyzeData(data: PhaseBusinessData, dir: string): void {
  // 全局元数据
  const meta = readJsonSafe(join(dir, "analysis.json"))
  if (meta) {
    try { data.sccGroupCount = safeArrayLen(meta.sccGroups) } catch { /* skip */ }
  }

  // 逐包子程序聚合
  try {
    const pkgDir = join(dir, "analysis-packages")
    if (existsSync(pkgDir)) {
      let total = 0
      for (const f of readdirSync(pkgDir)) {
        if (!f.endsWith(".json")) continue
        const pkgJson = readJsonSafe(join(pkgDir, f))
        if (pkgJson) total += safeArrayLen(pkgJson.subprograms)
      }
      data.subprogramCount = total
    }
  } catch { /* skip */ }

  // FSD 文件数
  try {
    data.fsdFileCount = countFilesRecursive(join(dir, "fsd"), ".md")
  } catch { /* skip */ }
}

function extractPlanData(data: PhaseBusinessData, dir: string): void {
  const json = readJsonSafe(join(dir, "plan.json"))
  if (!json) return

  try {
    const count = safeArrayLen(json.packageMappings)
    data.packageMappingsCount = count
    data.javaPackageCount = count
  } catch { /* skip */ }
}

function extractScaffoldData(data: PhaseBusinessData, dir: string): void {
  const json = readJsonSafe(join(dir, "scaffold.json"))
  if (!json) return

  try {
    const gen = json.generated as Record<string, unknown> | undefined
    if (gen) {
      data.generatedFiles =
        safeArrayLen(gen.entities) +
        safeArrayLen(gen.mapperInterfaces) +
        safeArrayLen(gen.serviceShells) +
        safeArrayLen(gen.commonClasses)
    }
  } catch { /* skip */ }
}

function extractTranslateData(data: PhaseBusinessData, dir: string): void {
  const translationsDir = join(dir, "translations")
  if (!existsSync(translationsDir)) return

  let translatedPackageCount = 0
  let completedSubprogramCount = 0
  let totalSubprogramCount = 0
  let generatedJavaFileCount = 0
  let todoCount = 0

  try {
    for (const entry of readdirSync(translationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const tJson = readJsonSafe(join(translationsDir, entry.name, "translation.json"))
      if (!tJson) continue
      translatedPackageCount++

      // completedSubprograms（Zod schema）→ fallback subprograms.length（旧版）
      try {
        completedSubprogramCount += tJson.completedSubprograms != null
          ? safeArrayLen(tJson.completedSubprograms)
          : safeArrayLen(tJson.subprograms)
      } catch { /* skip */ }

      // totalSubprograms（Zod schema number）→ fallback subprograms.length
      try {
        totalSubprogramCount += typeof tJson.totalSubprograms === "number"
          ? tJson.totalSubprograms
          : safeArrayLen(tJson.subprograms)
      } catch { /* skip */ }

      // files（Zod schema）→ fallback translatedFiles（旧版）
      try {
        generatedJavaFileCount += tJson.files != null
          ? safeArrayLen(tJson.files)
          : safeArrayLen(tJson.translatedFiles)
      } catch { /* skip */ }

      // todos（Zod schema）→ fallback issues（旧版）
      try {
        todoCount += tJson.todos != null
          ? safeArrayLen(tJson.todos)
          : safeArrayLen(tJson.issues)
      } catch { /* skip */ }
    }

    data.translatedPackageCount = translatedPackageCount
    data.completedSubprogramCount = completedSubprogramCount
    data.totalSubprogramCount = totalSubprogramCount
    data.generatedJavaFileCount = generatedJavaFileCount
    data.todoCount = todoCount
  } catch { /* skip */ }
}

function extractReviewData(data: PhaseBusinessData, dir: string): void {
  const json = readJsonSafe(join(dir, "review-summary.json"))
  if (!json) return

  try { data.allPassed = json.allPassed as boolean | undefined } catch { /* skip */ }
  try { data.totalMustFix = optionalNumber(json.totalMustFix) } catch { /* skip */ }
  try { data.totalTodosRemaining = optionalNumber(json.totalTodosRemaining) } catch { /* skip */ }

  try {
    const results = json.packageResults
    if (Array.isArray(results)) {
      data.reviewedPackageCount = results.length
      const scores = results.map((r: unknown) => safeNumber((r as Record<string, unknown>).score))
      if (scores.length > 0) {
        data.averageScore = Math.round((scores.reduce((a: number, b: number) => a + b, 0) / scores.length) * 10) / 10
      }
      // 逐包统计通过数（score >= 80 视为通过）
      data.passedPackageCount = results.filter(
        (r: unknown) => safeNumber((r as Record<string, unknown>).score) >= 80,
      ).length
    }
  } catch { /* skip */ }
}

function extractVerifyData(data: PhaseBusinessData, dir: string): void {
  const json = readJsonSafe(join(dir, "verify-summary.json"))
  if (!json) return

  try {
    const comp = json.compilation as Record<string, unknown> | undefined
    if (comp) {
      data.compilationSuccess = comp.success as boolean | undefined
      data.compilationErrorCount = comp.success
        ? 0
        : Array.isArray(comp.errors) ? comp.errors.length : optionalNumber(comp.errors) ?? 0
    }
  } catch { /* skip */ }

  try {
    const results = json.packageResults
    if (Array.isArray(results)) {
      data.mybatisValidCount = results.filter(
        (r: unknown) => (r as Record<string, unknown>).mybatisValid === true,
      ).length
    }
  } catch { /* skip */ }

  try {
    const te = json.testExecution as Record<string, unknown> | undefined
    if (te && te.executed) {
      data.testFileCount = safeArrayLen(te.testFiles)
    }
  } catch { /* skip */ }
}

function extractFixData(data: PhaseBusinessData, dir: string): void {
  const json = readJsonSafe(join(dir, "fix.json"))
  if (!json) return

  try {
    data.fixedPackageCount = safeArrayLen(json.fixedPackages)
    if (Array.isArray(json.fixedPackages)) {
      data.fixedPackageNames = (json.fixedPackages as unknown[]).map((p: unknown): string =>
        typeof p === "string" ? p
        : typeof p === "object" && p !== null && "name" in p ? String((p as Record<string, unknown>).name)
        : String(p)
      )
    }
  } catch { /* skip */ }
}

function extractDedupData(data: PhaseBusinessData, dir: string): void {
  const json = readJsonSafe(join(dir, "dedup.json"))
  if (!json) return

  try {
    const stats = json.scanStats as Record<string, unknown> | undefined
    if (stats) {
      data.dedupPackagesScanned = optionalNumber(stats.totalPackages)
      data.dedupFilesScanned = optionalNumber(stats.totalFilesScanned)
      data.dedupDuplicateGroups = optionalNumber(stats.duplicateGroupsFound)
    }
  } catch { /* skip */ }

  try {
    data.dedupExtractedModules = safeArrayLen(json.extractedModules)
  } catch { /* skip */ }

  try {
    const metrics = json.metrics as Record<string, unknown> | undefined
    if (metrics) {
      data.dedupFilesExtracted = optionalNumber(metrics.filesExtracted)
      data.dedupFilesModified = optionalNumber(metrics.filesModified)
      data.dedupLinesRemoved = optionalNumber(metrics.linesRemoved)
      data.dedupLinesAdded = optionalNumber(metrics.linesAdded)
    }
  } catch { /* skip */ }
}

// ── generateRunMetrics ────────────────────────────────────────────────────────

/** 加载所有 metrics/*.json，汇总为 RunMetrics */
function generateRunMetrics(runId: string, run: WorkflowRun, artifactsDir: string): RunMetrics {
  const metricsDir = join(artifactsDir, "metrics")

  // 加载阶段 metrics（校验基本字段，跳过不合规文件）
  const phases: PhaseMetrics[] = []
  if (existsSync(metricsDir)) {
    for (const f of readdirSync(metricsDir)) {
      if (!f.endsWith(".json") || f === "run-metrics.json") continue
      const m = readJsonSafe(join(metricsDir, f))
      if (m && typeof m.startedAt === "string" && typeof m.phase === "string") {
        phases.push(m as unknown as PhaseMetrics)
      } else if (m) {
        getLogger().warn("[metrics]", `跳过不合规 metrics 文件: ${f}`)
      }
    }
  }
  phases.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  // 汇总 LLM
  let totalApiCallCount = 0
  let totalCost = 0
  const totalTokens = zeroTokenUsage()
  let totalToolCallCount = 0
  const toolCallStats: Record<string, { count: number; errors: number }> = {}

  for (const p of phases) {
    totalApiCallCount += p.apiCallCount
    totalCost += p.totalCost
    addTokenUsage(totalTokens, p.totalTokens)
    totalToolCallCount += p.totalToolCallCount

    for (const [tool, stat] of Object.entries(p.toolCallStats)) {
      if (!toolCallStats[tool]) toolCallStats[tool] = { count: 0, errors: 0 }
      toolCallStats[tool].count += stat.count
      toolCallStats[tool].errors += stat.errors
    }
  }

  // RunBusinessData
  const business = buildRunBusinessData(phases, run)

  // 时间数据：累加各阶段实际耗时（不含阶段间空闲等待）
  const createdAt = run.createdAt
  const completedAt = run.updatedAt
  const totalWallDurationMs = phases.reduce(
    (sum, p) => sum + (p.wallDurationMs ?? 0), 0,
  ) || undefined

  return {
    runId,
    status: run.status,
    createdAt,
    completedAt,
    totalWallDurationMs,
    totalApiCallCount,
    totalCost,
    totalTokens,
    totalToolCallCount,
    toolCallStats,
    phases,
    business,
  }
}

function buildRunBusinessData(phases: PhaseMetrics[], run: WorkflowRun): RunBusinessData {
  const biz: RunBusinessData = {}

  // sourcePath
  try { biz.sourcePath = run.metadata?.sourcePath as string | undefined } catch { /* skip */ }

  // 从各阶段 business 提取
  const inventory = phases.find(p => p.phase === "inventory" && !p.fixIndex)
  const translate = phases.find(p => p.phase === "translate" && !p.fixIndex)
  const review = phases.find(p => p.phase === "review" && !p.fixIndex)
  const verify = phases.find(p => p.phase === "verify" && !p.fixIndex)

  if (inventory?.business) {
    biz.oraclePackageCount = inventory.business.packageCount
    biz.oracleProcedureCount = inventory.business.totalProcedureCount
    biz.oracleTableCount = inventory.business.tableCount
  }
  if (translate?.business) {
    biz.javaFileCount = translate.business.generatedJavaFileCount
  }
  if (review?.business) {
    biz.reviewAverageScore = review.business.averageScore
    biz.totalTodosRemaining = review.business.totalTodosRemaining
    if (review.business.reviewedPackageCount && review.business.reviewedPackageCount > 0) {
      // 用逐包通过数计算实际通过率，而非二元 allPassed
      const passedCount = review.business.passedPackageCount
        ?? (review.business.allPassed ? review.business.reviewedPackageCount : 0)
      biz.reviewPassedRate = Math.round((passedCount / review.business.reviewedPackageCount) * 100)
    }
  }
  if (verify?.business) {
    biz.compilationSuccess = verify.business.compilationSuccess
    biz.testFileCount = verify.business.testFileCount
  }

  // fixCyclesCount: 从 phaseHistory 统计 fix 条目数
  biz.fixCyclesCount = run.phaseHistory.filter(e => e.phase === "fix").length

  return biz
}

// ── Report Formatters ─────────────────────────────────────────────────────────

/** 格式化毫秒时长 → "3m 42s" / "1h 12m 30s" / "45s" */
function formatDuration(ms: number): string {
  if (ms <= 0) return "0s"
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

/** 千分位格式化数字 → "45,230" */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US")
}

/** 生成阶段报告文本 */
function formatPhaseReport(m: PhaseMetrics): string {
  const lines: string[] = []

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  lines.push(`📊 ${m.phase}${m.fixIndex != null ? ` (fix-${m.fixIndex})` : ""} 阶段报告`)
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

  // 耗时
  if (m.wallDurationMs != null) {
    lines.push(``)
    lines.push(`⏱ 耗时: ${formatDuration(m.wallDurationMs)}`)
  }

  // LLM 使用
  lines.push(``)
  lines.push(`🤖 LLM 使用`)
  lines.push(`  API 调用: ${formatNumber(m.apiCallCount)} 次`)

  const failedSteps = m.apiCalls.filter(r => r.reason.startsWith("error")).length
  if (failedSteps > 0) {
    lines.push(`  ⚠️ 含 ${failedSteps} 次失败 step（cost/tokens 记为 0）`)
  }

  lines.push(`  费用: $${m.totalCost.toFixed(4)}`)
  lines.push(`  Token 消耗:`)
  lines.push(`    输入:  ${formatNumber(m.totalTokens.input).padStart(10)}  (缓存命中: ${formatNumber(m.totalTokens.cacheRead)})`)
  lines.push(`    输出:  ${formatNumber(m.totalTokens.output).padStart(10)}`)
  if (m.totalTokens.reasoning > 0) {
    lines.push(`    推理:  ${formatNumber(m.totalTokens.reasoning).padStart(10)}`)
  }

  // 工具调用
  lines.push(``)
  lines.push(`🔧 工具调用 (共 ${formatNumber(m.totalToolCallCount)} 次)`)
  const sortedTools = Object.entries(m.toolCallStats).sort((a, b) => b[1].count - a[1].count)
  for (const [tool, stat] of sortedTools) {
    const errSuffix = stat.errors > 0 ? ` (${stat.errors} errors)` : ""
    lines.push(`  ${tool.padEnd(16)} ${formatNumber(stat.count)} 次${errSuffix}`)
  }

  // 业务数据
  if (m.business) {
    lines.push(``)
    lines.push(`📦 业务数据`)
    const bizLines = formatBusinessLines(m.phase, m.business)
    for (const bl of bizLines) lines.push(bl)
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  return lines.join("\n")
}

/** 阶段业务数据格式化 */
function formatBusinessLines(phase: string, biz: PhaseBusinessData): string[] {
  const lines: string[] = []
  const fmt = (label: string, val: unknown) => {
    if (val == null) return
    const display = typeof val === "boolean" ? (val ? "PASS" : "FAIL") : String(val)
    lines.push(`  ${label.padEnd(18)} ${display}`)
  }

  switch (phase) {
    case "inventory":
      fmt("Oracle 包:", biz.packageCount)
      fmt("表:", biz.tableCount)
      fmt("触发器:", biz.triggerCount)
      fmt("视图:", biz.viewCount)
      fmt("序列:", biz.sequenceCount)
      fmt("独立子程序:", biz.standaloneProcedureCount)
      fmt("子程序总数:", biz.totalProcedureCount)
      break
    case "analyze":
      fmt("子程序:", biz.subprogramCount)
      fmt("SCC 分组:", biz.sccGroupCount)
      fmt("FSD 文件:", biz.fsdFileCount)
      break
    case "plan":
      fmt("Java 包:", biz.javaPackageCount)
      fmt("包映射:", biz.packageMappingsCount)
      break
    case "scaffold":
      fmt("生成文件:", biz.generatedFiles)
      break
    case "translate":
      fmt("翻译包:", biz.translatedPackageCount)
      fmt("完成子程序:", biz.completedSubprogramCount)
      fmt("子程序总数:", biz.totalSubprogramCount)
      fmt("Java 文件:", biz.generatedJavaFileCount)
      fmt("TODO:", biz.todoCount)
      break
    case "review":
      fmt("全部通过:", biz.allPassed)
      fmt("Must-Fix:", biz.totalMustFix)
      fmt("剩余 TODO:", biz.totalTodosRemaining)
      fmt("平均分:", biz.averageScore)
      fmt("审查包:", biz.reviewedPackageCount)
      break
    case "verify":
      fmt("编译:", biz.compilationSuccess)
      fmt("编译错误:", biz.compilationErrorCount)
      fmt("MyBatis 有效:", biz.mybatisValidCount)
      fmt("测试文件:", biz.testFileCount)
      break
    case "fix":
      fmt("修复包数:", biz.fixedPackageCount)
      if (biz.fixedPackageNames && biz.fixedPackageNames.length > 0) {
        lines.push(`  修复包:  ${biz.fixedPackageNames.join(", ")}`)
      }
      break
    case "dedup":
      fmt("扫描包:", biz.dedupPackagesScanned)
      fmt("扫描文件:", biz.dedupFilesScanned)
      fmt("重复组:", biz.dedupDuplicateGroups)
      fmt("抽取模块:", biz.dedupExtractedModules)
      fmt("抽取文件:", biz.dedupFilesExtracted)
      fmt("修改文件:", biz.dedupFilesModified)
      fmt("删除行:", biz.dedupLinesRemoved)
      fmt("新增行:", biz.dedupLinesAdded)
      break
  }

  return lines
}

/** 生成最终报告文本（动态列宽，不依赖硬编码 padding） */
function formatFinalReport(rm: RunMetrics): string {
  const lines: string[] = []
  const sep = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  lines.push(sep)
  lines.push("🏁 工作流最终报告")
  lines.push(sep)
  lines.push("")
  lines.push(`Run ID: ${rm.runId}`)
  lines.push(`状态:   ${rm.status}`)
  if (rm.totalWallDurationMs != null) {
    lines.push(`总耗时: ${formatDuration(rm.totalWallDurationMs)}`)
  }
  lines.push("")

  // LLM 总用量
  lines.push("🤖 LLM 总用量")
  lines.push(`  API 调用: ${formatNumber(rm.totalApiCallCount)} 次`)
  lines.push(`  总费用:   $${rm.totalCost.toFixed(4)}`)
  lines.push("  Token 消耗:")
  lines.push(`    输入:  ${formatNumber(rm.totalTokens.input)}  (缓存命中: ${formatNumber(rm.totalTokens.cacheRead)})`)
  lines.push(`    输出:  ${formatNumber(rm.totalTokens.output)}`)
  if (rm.totalTokens.reasoning > 0) {
    lines.push(`    推理:  ${formatNumber(rm.totalTokens.reasoning)}`)
  }
  lines.push("")

  // 工具调用总计
  lines.push(`🔧 工具调用总计: ${formatNumber(rm.totalToolCallCount)} 次`)
  const sortedTools = Object.entries(rm.toolCallStats).sort((a, b) => b[1].count - a[1].count)
  const toolParts = sortedTools.map(([t, s]) => `${t}: ${formatNumber(s.count)}`)
  for (let i = 0; i < toolParts.length; i += 3) {
    lines.push(`  ${toolParts.slice(i, i + 3).join("  ")}`)
  }
  lines.push("")

  // 各阶段详情 — 动态列宽
  const phaseRows = rm.phases.map(p => ({
    name: p.fixIndex != null ? `${p.phase}-${p.fixIndex}` : p.phase,
    dur: p.wallDurationMs != null ? formatDuration(p.wallDurationMs) : "—",
    api: String(p.apiCallCount),
    cost: "$" + p.totalCost.toFixed(3),
    tools: String(p.totalToolCallCount),
  }))
  const wN = Math.max(10, ...phaseRows.map(r => r.name.length))
  const wD = Math.max(7, ...phaseRows.map(r => r.dur.length))
  const wA = Math.max(4, ...phaseRows.map(r => r.api.length))
  const wC = Math.max(7, ...phaseRows.map(r => r.cost.length))
  const wT = Math.max(4, ...phaseRows.map(r => r.tools.length))

  lines.push("⏱ 各阶段详情")
  lines.push(`  ${"阶段".padEnd(wN + 1)}${"耗时".padEnd(wD + 1)}${"API".padEnd(wA + 1)}${"费用".padEnd(wC + 1)}工具`)
  lines.push(`  ${"─".repeat(wN)} ${"─".repeat(wD)} ${"─".repeat(wA)} ${"─".repeat(wC)} ${"─".repeat(wT)}`)
  for (const r of phaseRows) {
    lines.push(`  ${r.name.padEnd(wN + 1)}${r.dur.padEnd(wD + 1)}${r.api.padEnd(wA + 1)}${r.cost.padEnd(wC + 1)}${r.tools}`)
  }
  lines.push("")

  // 业务汇总
  const b = rm.business
  lines.push("📦 业务汇总")
  const bizLine = (l: string, v: unknown) => {
    if (v == null) return
    const d = typeof v === "boolean" ? (v ? "PASS" : "FAIL") : String(v)
    lines.push(`  ${l.padEnd(14)} ${d}`)
  }
  if (b.oraclePackageCount != null) bizLine("Oracle 包:", b.oraclePackageCount)
  if (b.oracleProcedureCount != null) bizLine("子程序:", b.oracleProcedureCount)
  if (b.oracleTableCount != null) bizLine("表:", b.oracleTableCount)
  if (b.javaFileCount != null) bizLine("Java 文件:", b.javaFileCount)
  if (b.reviewAverageScore != null) bizLine("Review 均分:", b.reviewAverageScore)
  if (b.reviewPassedRate != null) bizLine("通过率:", b.reviewPassedRate + "%")
  if (b.compilationSuccess != null) bizLine("编译:", b.compilationSuccess)
  if (b.testFileCount != null) bizLine("测试文件:", b.testFileCount)
  if (b.totalTodosRemaining != null) bizLine("TODO:", b.totalTodosRemaining)
  if (b.fixCyclesCount != null) bizLine("Fix 循环:", b.fixCyclesCount)
  lines.push("")
  lines.push(sep)

  return lines.join("\n")
}

// ── Exports ───────────────────────────────────────────────────────────────────

export {
  PhaseMetricsCollector,
  type PhaseMetrics,
  generateRunMetrics,
  formatPhaseReport,
  formatFinalReport,
  formatDuration,
}
