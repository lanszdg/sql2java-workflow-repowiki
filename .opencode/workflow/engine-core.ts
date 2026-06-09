/**
 * Engine Core — 确定性状态机引擎核心
 *
 * 单流水线架构：7 个阶段 + 1 个条件分支阶段（fix），一个 runId。
 * 无条件前进 + review/verify 失败时进入 fix 循环（增量重做）。
 *
 * 设计决策索引：
 *   D1: advance condition 判定
 *   D2: fix 循环双层 exhausted 策略
 *   D3: fix 增量重做
 *   D4: confirm 时序（B 方案）
 *   D6: 持久化（run.json）
 *   D7: fix transition 动态路由
 *   D8: advance 流程 result 校验
 *   D9: 跨 Schema 校验
 *   D12: FixArtifact 包名校验
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync, readdirSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** D2: fix 循环双层 exhausted 上限 */
export const FIX_LIMITS = {
  globalMax: 3,   // 全局 fix 上限（宽松）
  phaseMax: 2,    // 单阶段 fix 上限（严格）
} as const

/** 完成哨兵 */
export const DONE_SENTINEL = "__done__" as const

/** 格式化 Zod 校验错误为可读字符串（供 engine-core 和 plugin 共用） */
export function formatZodIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n")
}

/** 引擎错误类型，用于区分预期错误（如 not found）和真实错误（如 corrupted JSON） */
export class WorkflowEngineError extends Error {
  readonly code: "NOT_FOUND" | "CORRUPTED" | "VALIDATION_FAILED" | "INVALID_STATE" | "INVALID_DEFINITION"
  constructor(message: string, code: "NOT_FOUND" | "CORRUPTED" | "VALIDATION_FAILED" | "INVALID_STATE" | "INVALID_DEFINITION") {
    super(message)
    this.name = "WorkflowEngineError"
    this.code = code
  }
}

// ── 核心类型 ──────────────────────────────────────────────────────────────────

/** 单阶段配置 */
export interface PhaseConfig {
  name: string
  agentFile: string                             // 对应的 agent .md 文件路径
  temperature: number
  maxRetries: number
  requiresConfirmation?: boolean                // 为 true 时 advance 后暂停等待确认
  isFixPhase?: boolean                          // 标记 fix 阶段，引擎特殊处理
  tools: string[]                               // 允许的工具列表
  description?: string                          // 阶段中文描述，用于输出 banner
}

/** 条件转移规则 */
export interface TransitionRule {
  from: string
  condition: "always" | "passed" | "failed"
  to: string                                    // 目标阶段名，DONE_SENTINEL 表示完成
}

/** 工作流定义 */
export interface WorkflowDefinition {
  id: string
  phases: PhaseConfig[]
  transitions: TransitionRule[]
}

/** 一次工作流运行 */
export interface WorkflowRun {
  runId: string
  definitionId: string
  currentPhase: string | null
  status: "running" | "paused" | "completed" | "completed_with_issues" | "aborted"
  phaseHistory: PhaseHistoryEntry[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** 单次执行中一个阶段的历史记录 */
export interface PhaseHistoryEntry {
  phase: string
  status: "pending" | "in_progress" | "completed" | "failed" | "completed_with_issues"
  artifactPath?: string
  startedAt: string
  completedAt?: string
  retryCount: number                            // 每次 retry 递增，与 PhaseConfig.maxRetries 比较
  branchedFrom?: string                         // fix 记录触发阶段；fix 回来的 entry 记录 "fix"
  incrementalContext?: {
    targetPackages: string[]                    // 增量模式：只处理这些包
  }
}

/** advance 返回结构 */
export interface AdvanceResult {
  run: WorkflowRun
  nextPhase: PhaseConfig | null
  finished: boolean
  waitingForConfirmation: boolean               // D4: true 时不激活 agent
  rejected: boolean                             // 校验被拒绝时为 true（Zod/D8/D12），LLM 应修正后重新 advance
  fixFailed?: boolean                           // fix 失败但未 exhausted，LLM 应调用 retry()（仅 fix 阶段设置）
  rejectionReason?: string                      // 拒绝/失败原因
}

/** retry 返回结构 */
export interface RetryResult {
  run: WorkflowRun
  retryCount: number
  exhausted: boolean
  terminalState?: "completed_with_issues"       // fix 阶段 retry exhausted 时的终止状态
}

// ── Zod Schema（用于 loadFromDisk 校验）───────────────────────────────────────

const PhaseHistoryEntrySchema = z.object({
  phase: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "completed_with_issues"]),
  artifactPath: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  retryCount: z.number(),
  branchedFrom: z.string().optional(),
  incrementalContext: z.object({
    targetPackages: z.array(z.string()),
  }).optional(),
})

export const WorkflowRunSchema = z.object({
  runId: z.string(),
  definitionId: z.string(),
  currentPhase: z.string().nullable(),
  status: z.enum(["running", "paused", "completed", "completed_with_issues", "aborted"]),
  phaseHistory: z.array(PhaseHistoryEntrySchema),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// ── 引擎 ──────────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private definitions = new Map<string, WorkflowDefinition>()
  private runs = new Map<string, WorkflowRun>()
  private artifactsRoot = ".workflow-artifacts"
  /** 一次 advance 周期内的 artifact 缓存，advance 结束后清除 */
  private artifactCache = new Map<string, Record<string, unknown> | null>()

  /** 清除 artifact 缓存（每次 advance 开始时调用） */
  clearArtifactCache(): void {
    this.artifactCache.clear()
  }

  // ── 注册 ──

  registerDefinition(def: WorkflowDefinition): void {
    this.definitions.set(def.id, def)
  }

  // ── 生命周期 ──

  start(defId: string, runId: string, metadata?: Record<string, unknown>): WorkflowRun {
    const def = this.definitions.get(defId)
    if (!def) throw new WorkflowEngineError(`Workflow definition "${defId}" not found`, "INVALID_DEFINITION")
    const firstPhase = def.phases[0]
    if (!firstPhase) throw new WorkflowEngineError(`Workflow "${defId}" has no phases`, "INVALID_DEFINITION")

    const now = new Date().toISOString()
    const run: WorkflowRun = {
      runId,
      definitionId: defId,
      currentPhase: firstPhase.name,
      status: "running",
      phaseHistory: [{
        phase: firstPhase.name,
        status: "in_progress",
        startedAt: now,
        retryCount: 0,
      }],
      metadata: metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(runId, run)
    this.persist(run)
    this.appendEvent(runId, "START", "", "workflow started")
    return run
  }

  advance(runId: string, input: { result?: "passed" | "failed" } = {}): AdvanceResult {
    this.artifactCache.clear()  // 每次 advance 开始时清除缓存
    const run = this.getRun(runId)
    const def = this.getDefinition(run.definitionId)
    const now = new Date().toISOString()

    // ── Step 1: 验证 status === "running" ──
    if (run.status !== "running") {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: `Cannot advance: run status is "${run.status}", expected "running"`,
      }
    }

    const currentEntry = this.findCurrentEntry(run)
    if (!currentEntry) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: "No current in_progress phase entry found",
      }
    }

    // ── Step 2-3: 跨 Schema 校验 (D9) ──
    // inventory-index ↔ inventory 包名一致性校验由 plugin 层 validateInventoryPackages 完成，此处不重复
    // analyze/plan 完成后：校验 inventory ↔ analysis ↔ plan 包名一致性
    if (run.currentPhase === "analyze" || run.currentPhase === "plan") {
      const crossSchemaWarnings = this.validateCrossSchema(run, run.currentPhase!)
      for (const w of crossSchemaWarnings) {
        this.appendEvent(runId, "ADVANCE", run.currentPhase ?? "", `[cross-schema-warning] ${w}`)
      }
    }

    // ── Step 4: fix 阶段特殊处理 ──
    const currentPhaseConfig = def.phases.find(p => p.name === run.currentPhase)
    if (currentPhaseConfig?.isFixPhase) {
      return this.handleFixAdvance(run, def, currentEntry, input, now)
    }

    // ── Step 5: review / verify 阶段 → 从 summary.allPassed 推导 result (D8) ──
    if (run.currentPhase === "review" || run.currentPhase === "verify") {
      const derivedResult = this.deriveReviewResult(run, input.result)
      if (derivedResult.rejected) {
        return {
          run,
          nextPhase: null,
          finished: false,
          waitingForConfirmation: false,
          rejected: true,
          rejectionReason: derivedResult.rejectionReason,
        }
      }
      input.result = derivedResult.effectiveResult
    }

    // ── Step 7: condition: "always" 阶段 → 显式忽略 result (D1) ──
    // 检查当前 phase 的所有 transition 是否都是 "always"，是则丢弃 result
    const phaseTransitions = def.transitions.filter(t => t.from === run.currentPhase)
    const isAlwaysOnly = phaseTransitions.length > 0 && phaseTransitions.every(t => t.condition === "always")
    const resultForMatching = isAlwaysOnly ? "passed" : (input.result ?? "passed")

    // ── Step 8: 匹配 TransitionRule (D1) ──
    const matchedRule = this.matchTransitionRule(def, run.currentPhase!, resultForMatching)

    if (!matchedRule) {
      // 注意：Step 6 (标记 entry completed) 尚未执行，entry 保持 in_progress
      // 确保 rejected 后 LLM 可以重试 advance 而不会因 entry 被篡改为 completed 而卡死
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: `No transition rule found for phase "${run.currentPhase}" with result "${resultForMatching}"`,
      }
    }

    // ── Step 6: 完成当前 phaseHistory entry（移到 Step 8 成功之后，避免 rejected 时 entry 被篡改）──
    currentEntry.status = "completed"
    currentEntry.completedAt = now
    run.updatedAt = now

    // ── Step 9: to === DONE_SENTINEL → 完成 ──
    if (matchedRule.to === DONE_SENTINEL) {
      const completedPhase = run.currentPhase! // 保存 phase 名用于日志（下面设为 null）
      run.status = "completed"
      run.currentPhase = null
      run.updatedAt = now
      this.persist(run)
      this.appendEvent(runId, "COMPLETE", completedPhase, "workflow completed")
      return {
        run,
        nextPhase: null,
        finished: true,
        waitingForConfirmation: false,
        rejected: false,
      }
    }

    // ── Step 10: 目标是 fix phase？检查 exhausted ──
    const targetPhaseConfig = def.phases.find(p => p.name === matchedRule.to)
    if (targetPhaseConfig?.isFixPhase) {
      if (this.isFixExhausted(run, run.currentPhase!, true)) {
        run.status = "completed_with_issues"
        run.currentPhase = null
        run.updatedAt = now
        this.persist(run)
        this.appendEvent(runId, "COMPLETE", "", "completed_with_issues (fix exhausted)")
        return {
          run,
          nextPhase: null,
          finished: true,
          waitingForConfirmation: false,
          rejected: false,
        }
      }
    }

    // ── Step 11: 目标 phase requiresConfirmation？(D4) ──
    if (targetPhaseConfig?.requiresConfirmation) {
      const newEntry: PhaseHistoryEntry = {
        phase: matchedRule.to,
        status: "pending",
        startedAt: now,
        retryCount: 0,
      }
      run.phaseHistory.push(newEntry)
      run.currentPhase = matchedRule.to
      run.status = "paused"
      run.updatedAt = now
      this.persist(run)
      this.appendEvent(runId, "ADVANCE", matchedRule.to, "waiting for confirmation")
      return {
        run,
        nextPhase: targetPhaseConfig,
        finished: false,
        waitingForConfirmation: true,
        rejected: false,
      }
    }

    // ── Step 12: 正常前进 ──
    const newEntry: PhaseHistoryEntry = {
      phase: matchedRule.to,
      status: "in_progress",
      startedAt: now,
      retryCount: 0,
      branchedFrom: targetPhaseConfig?.isFixPhase ? run.currentPhase! : undefined,
    }
    run.phaseHistory.push(newEntry)
    const prevPhase = run.currentPhase
    run.currentPhase = matchedRule.to
    run.updatedAt = now
    this.persist(run)
    this.appendEvent(runId, "ADVANCE", matchedRule.to, `${prevPhase} → ${matchedRule.to}`)

    return {
      run,
      nextPhase: targetPhaseConfig ?? null,
      finished: false,
      waitingForConfirmation: false,
      rejected: false,
    }
  }

  confirm(runId: string): WorkflowRun {
    const run = this.getRun(runId)
    if (run.status !== "paused") {
      throw new WorkflowEngineError(`Cannot confirm: run status is "${run.status}", expected "paused"`, "INVALID_STATE")
    }
    const currentEntry = this.findCurrentEntry(run)
    if (!currentEntry) {
      throw new WorkflowEngineError("No current phase entry found", "INVALID_STATE")
    }
    const now = new Date().toISOString()
    currentEntry.status = "in_progress"
    run.status = "running"
    run.updatedAt = now
    this.persist(run)
    this.appendEvent(runId, "CONFIRM", run.currentPhase!, "confirmed by user")
    return run
  }

  retry(runId: string): RetryResult {
    const run = this.getRun(runId)
    const def = this.getDefinition(run.definitionId)
    const currentEntry = this.findCurrentEntry(run)
    if (!currentEntry) throw new WorkflowEngineError("No current active phase entry to retry (expected in_progress, pending, or failed)", "INVALID_STATE")

    const phaseConfig = def.phases.find(p => p.name === run.currentPhase)

    // 重置 entry status 为 in_progress（设计要求）
    currentEntry.status = "in_progress"
    currentEntry.completedAt = undefined    // 清除之前 fix-failed 设置的 completedAt
    currentEntry.retryCount++

    // fix 阶段 retry 时清理残留的 fix.json，避免 agent retry 后读到上次的畸形文件
    if (phaseConfig?.isFixPhase) {
      const fixFilePath = join(this.artifactsRoot, run.runId, "fix.json")
      if (existsSync(fixFilePath)) {
        try { unlinkSync(fixFilePath) } catch { /* 删除失败不阻塞 retry */ }
      }
    }
    const maxRetries = phaseConfig?.maxRetries ?? 2

    if (currentEntry.retryCount >= maxRetries) {
      // fix 阶段 retry exhausted → completed_with_issues
      if (phaseConfig?.isFixPhase) {
        run.status = "completed_with_issues"
        run.currentPhase = null
        currentEntry.status = "failed"
        currentEntry.completedAt = new Date().toISOString()
        run.updatedAt = new Date().toISOString()
        this.persist(run)
        this.appendEvent(runId, "FAIL", "", "fix retry exhausted → completed_with_issues")
        return {
          run,
          retryCount: currentEntry.retryCount,
          exhausted: true,
          terminalState: "completed_with_issues",
        }
      }
      // 非 fix 阶段 exhausted：标记 entry 为 failed + run 为 aborted
      // 避免僵尸状态（run.status="running" 但无 in_progress entry 可操作）
      currentEntry.status = "failed"
      currentEntry.completedAt = new Date().toISOString()
      run.status = "aborted"
      run.updatedAt = new Date().toISOString()
      this.persist(run)
      this.appendEvent(runId, "FAIL", run.currentPhase!, "retry exhausted → aborted")
      return {
        run,
        retryCount: currentEntry.retryCount,
        exhausted: true,
      }
    }

    run.updatedAt = new Date().toISOString()
    this.persist(run)
    this.appendEvent(runId, "RETRY", run.currentPhase!, `retry #${currentEntry.retryCount}`)
    return {
      run,
      retryCount: currentEntry.retryCount,
      exhausted: false,
    }
  }

  abort(runId: string): WorkflowRun {
    const run = this.getRun(runId)
    const now = new Date().toISOString()
    const currentEntry = this.findCurrentEntry(run)
    if (currentEntry) {
      currentEntry.status = "failed"
      currentEntry.completedAt = now
    }
    run.status = "aborted"
    run.updatedAt = now
    this.persist(run)
    this.appendEvent(runId, "ABORT", run.currentPhase ?? "", "workflow aborted")
    return run
  }

  status(runId: string): WorkflowRun | null {
    return this.runs.get(runId) ?? null
  }

  listRuns(): WorkflowRun[] {
    // 内存中有 run 直接返回（避免不必要的磁盘 I/O）
    if (this.runs.size > 0) {
      return Array.from(this.runs.values())
    }

    // 内存为空（新 session）→ 扫描磁盘恢复
    if (!existsSync(this.artifactsRoot)) {
      return []
    }

    try {
      const entries = readdirSync(this.artifactsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const runJsonPath = join(this.artifactsRoot, entry.name, "run.json")
        if (!existsSync(runJsonPath)) continue
        try {
          this.loadFromDisk(entry.name)
        } catch {
          // 跳过损坏的 run，不阻塞其他 run 的列举
        }
      }
    } catch {
      // artifactsRoot 不可读
    }

    return Array.from(this.runs.values())
  }

  // ── 持久化 (D6) ──

  loadFromDisk(runId: string): WorkflowRun {
    const filePath = join(this.artifactsRoot, runId, "run.json")
    if (!existsSync(filePath)) {
      throw new WorkflowEngineError(`Run file not found: ${filePath}`, "NOT_FOUND")
    }
    const raw = readFileSync(filePath, "utf-8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e: any) {
      throw new WorkflowEngineError(`Run file corrupted (invalid JSON): ${filePath}: ${e.message}`, "CORRUPTED")
    }
    const validationResult = WorkflowRunSchema.safeParse(parsed)
    if (!validationResult.success) {
      const issues = formatZodIssues(validationResult.error)
      throw new WorkflowEngineError(`Run file schema validation failed: ${filePath}\n${issues}`, "VALIDATION_FAILED")
    }
    const run = validationResult.data as WorkflowRun
    this.runs.set(runId, run)
    return run
  }

  // ── inventory-index ↔ inventory 包名一致性校验 ──
  // inventory 完成后独立触发，不依赖 analysis artifact
  validateInventoryIndexConsistency(run: WorkflowRun): string[] {
    const warnings: string[] = []
    const artifactsDir = join(this.artifactsRoot, run.runId)

    const inventoryIndex = this.loadArtifactJson(artifactsDir, "inventory-index")
    const inventory = this.loadArtifactJson(artifactsDir, "inventory")

    if (!inventory) {
      warnings.push("inventory-index ↔ inventory 校验跳过：inventory.json 不存在或无法解析")
      return warnings
    }
    if (!inventoryIndex) {
      warnings.push("inventory-index ↔ inventory 校验跳过：inventory-index.json 不存在（预扫描可能失败）")
      return warnings
    }

    const indexNames = new Set(
      ((inventoryIndex.packages as Array<{ name: string }>) ?? []).map((p) => p.name)
    )
    const invNames = this.extractPackageNames(inventory)
    for (const name of indexNames) {
      if (!invNames.has(name)) warnings.push(`inventory.packageNames 缺少包: ${name}（index 中存在）`)
    }
    for (const name of invNames) {
      if (!indexNames.has(name)) warnings.push(`inventory-index 缺少包: ${name}（inventory.packageNames 中存在）`)
    }
    return warnings
  }

  // ── 跨 Schema 校验 (D9) ──
  // 返回 warnings 数组（不阻塞流程）

  validateCrossSchema(run: WorkflowRun, completedPhase: string): string[] {
    const warnings: string[] = []
    const artifactsDir = join(this.artifactsRoot, run.runId)

    const inventory = this.loadArtifactJson(artifactsDir, "inventory")
    const analysis = this.loadArtifactJson(artifactsDir, "analysis")

    if (!inventory || !analysis) {
      warnings.push(
        `跨 Schema 校验跳过：缺少必要的 artifact（inventory: ${!!inventory}, analysis: ${!!analysis}）`
      )
      return warnings
    }

    // inventory-index ↔ inventory 一致性已在 inventory 阶段完成时独立校验，此处不重复

    // inventory 包名 ↔ analysis 包名（双向）
    const invNames = this.extractPackageNames(inventory)
    const anaNames = this.extractPackageNames(analysis)
    for (const name of invNames) {
      if (!anaNames.has(name)) warnings.push(`analysis 缺少包: ${name}`)
    }
    for (const name of anaNames) {
      if (!invNames.has(name)) warnings.push(`inventory 缺少包: ${name}（analysis 中存在但 inventory 中不存在）`)
    }

    // translationOrder 覆盖校验
    const orderedNames = new Set(
      ((analysis.translationOrder as string[][]) ?? []).flat()
    )
    for (const name of anaNames) {
      if (!orderedNames.has(name)) warnings.push(`translationOrder 缺少包: ${name}`)
    }

    // plan 映射覆盖（仅 plan 完成后校验）
    if (completedPhase === "plan") {
      const plan = this.loadArtifactJson(artifactsDir, "plan")
      if (!plan) {
        warnings.push("plan 映射校验跳过：plan artifact 不存在")
        return warnings
      }
      const mappedNames = new Set(
        (plan.packageMappings as Array<{ oraclePackage: string }>).map((m) => m.oraclePackage)
      )
      for (const name of invNames) {
        if (!mappedNames.has(name)) warnings.push(`plan 未映射包: ${name}`)
      }
    }

    return warnings
  }

  // ── D2: isFixExhausted 双层判定 ──

  isFixExhausted(run: WorkflowRun, triggerPhase: string, preCreate: boolean): boolean {
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

  // ── 私有方法 ──

  private getRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId)
    if (!run) throw new WorkflowEngineError(`Workflow run "${runId}" not found`, "NOT_FOUND")
    return run
  }

  private getDefinition(defId: string): WorkflowDefinition {
    const def = this.definitions.get(defId)
    if (!def) throw new WorkflowEngineError(`Workflow definition "${defId}" not found`, "INVALID_DEFINITION")
    return def
  }

  findCurrentEntry(run: WorkflowRun): PhaseHistoryEntry | undefined {
    // 找最后一个当前 phase 的 entry（含 failed，用于 fix failed 后 retry 能找到）
    for (let i = run.phaseHistory.length - 1; i >= 0; i--) {
      const entry = run.phaseHistory[i]
      if (entry.phase === run.currentPhase && (entry.status === "in_progress" || entry.status === "pending" || entry.status === "failed")) {
        return entry
      }
    }
    return undefined
  }

  /** 从 artifact JSON 提取包名集合（兼容 new/old 格式） */
  extractPackageNames(
    artifact: Record<string, unknown>,
    toUpperCase = false,
  ): Set<string> {
    let names: string[]
    if (artifact.packageNames) {
      names = (artifact.packageNames as string[])
    } else if (artifact.packages) {
      names = ((artifact.packages as Array<{ name: string }>) ?? []).map((p) => p.name)
    } else {
      names = []
    }
    if (toUpperCase) {
      names = names.map((n) => n.toUpperCase())
    }
    return new Set(names)
  }

  /** 匹配 TransitionRule (D1: 根据 result 匹配 condition) */
  private matchTransitionRule(
    def: WorkflowDefinition,
    fromPhase: string,
    result: "passed" | "failed",
  ): TransitionRule | null {
    // 先匹配 condition 为 result 的规则，再匹配 always
    const exact = def.transitions.find(
      t => t.from === fromPhase && t.condition === result
    )
    if (exact) return exact
    const always = def.transitions.find(
      t => t.from === fromPhase && t.condition === "always"
    )
    return always ?? null
  }

  /** D8: review/verify result 推导 */
  private deriveReviewResult(
    run: WorkflowRun,
    explicitResult?: "passed" | "failed",
  ): { rejected: boolean; effectiveResult: "passed" | "failed"; rejectionReason?: string } {
    const artifactsDir = join(this.artifactsRoot, run.runId)
    const summaryFileName = run.currentPhase === "review"
      ? "review-summary.json"
      : "verify-summary.json"
    const summary = this.loadArtifactJson(artifactsDir, summaryFileName.replace(".json", ""))

    if (!summary) {
      // summary 不存在：所有 result 都拒绝（无 summary 进 fix 会导致 handleFixAdvance 死锁）
      return {
        rejected: true,
        effectiveResult: explicitResult ?? "passed",
        rejectionReason: `${summaryFileName} not found. Agent must write the summary artifact before advancing.`,
      }
    }

    const allPassed = (summary as { allPassed?: boolean }).allPassed ?? false

    if (explicitResult !== undefined) {
      // 防御性校验：与 allPassed 不一致时拒绝
      if (explicitResult === "passed" && !allPassed) {
        return {
          rejected: true,
          effectiveResult: "passed",
          rejectionReason: `result="passed" but allPassed=false in ${summaryFileName}. Fix the failing packages or add mustFix items.`,
        }
      }
      if (explicitResult === "failed" && allPassed) {
        return {
          rejected: true,
          effectiveResult: "failed",
          rejectionReason: `result="failed" but allPassed=true in ${summaryFileName}. No issues found — please set result="passed".`,
        }
      }
      return { rejected: false, effectiveResult: explicitResult }
    }

    // 自动推导
    return { rejected: false, effectiveResult: allPassed ? "passed" : "failed" }
  }

  /** D3/D7/D12: fix 阶段 advance 处理 */
  private handleFixAdvance(
    run: WorkflowRun,
    def: WorkflowDefinition,
    currentEntry: PhaseHistoryEntry,
    input: { result?: "passed" | "failed" },
    now: string,
  ): AdvanceResult {
    // fix 阶段 result 必填 (D1/D3)
    if (input.result === undefined) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: "fix 阶段 result 必填（D1/D3）。请传入 result: 'passed' 或 'failed'。",
      }
    }

    // fix failed：修不完 — D3 要求标记 entry 为 failed
    if (input.result === "failed") {
      currentEntry.status = "failed"
      currentEntry.completedAt = now
      run.updatedAt = now

      if (this.isFixExhausted(run, currentEntry.branchedFrom ?? "", false)) {
        // exhausted → 终态：run 为 completed_with_issues
        run.status = "completed_with_issues"
        run.currentPhase = null
        this.persist(run)
        this.appendEvent(run.runId, "COMPLETE", "fix", "completed_with_issues (fix failed + exhausted)")
        return {
          run,
          nextPhase: null,
          finished: true,
          waitingForConfirmation: false,
          rejected: false,
        }
      }

      // 未 exhausted → fixFailed，LLM 应调用 retry()（retry 会将 entry 从 failed 重置为 in_progress）
      this.persist(run)
      this.appendEvent(run.runId, "FAIL", "fix", "fix failed but not exhausted, awaiting retry")
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: false,
        fixFailed: true,
        rejectionReason: "fix failed but not exhausted. Please call retry() to try again.",
      }
    }

    // fix passed → advanceFromFix (D3/D7)
    const triggerPhase = currentEntry.branchedFrom
    if (!triggerPhase) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: "fix entry missing branchedFrom. Cannot determine trigger phase.",
      }
    }

    // D12: 校验 fixedPackages
    const artifactsDir = join(this.artifactsRoot, run.runId)
    const fixArtifact = this.loadArtifactJson(artifactsDir, "fix")
    if (!fixArtifact) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: "fix.json not found. Agent must write fix.json before advancing.",
      }
    }

    const fixedPackages = (fixArtifact as { fixedPackages?: string[] }).fixedPackages ?? []
    if (fixedPackages.length === 0) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: "fix.json: fixedPackages is empty. Must fix at least one package.",
      }
    }

    // D12: 校验包名存在于 inventory（新格式 packageNames 优先，旧格式 packages[].name 回退）
    const inventory = this.loadArtifactJson(artifactsDir, "inventory")
    if (inventory) {
      const invPackageNames = this.extractPackageNames(inventory, true)
      const invalidPackages = fixedPackages.filter(
        p => !invPackageNames.has(p.toUpperCase())
      )
      if (invalidPackages.length > 0) {
        return {
          run,
          nextPhase: null,
          finished: false,
          waitingForConfirmation: false,
          rejected: true,
          rejectionReason: `fix.json: invalid package names not in inventory: ${invalidPackages.join(", ")}`,
        }
      }
    }

    // D12: 校验 fixedPackages 包含触发阶段所有失败包
    const summaryFileName = triggerPhase === "review"
      ? "review-summary.json"
      : "verify-summary.json"
    const summary = this.loadArtifactJson(artifactsDir, summaryFileName.replace(".json", ""))
    if (!summary) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: `${summaryFileName} not found. Cannot validate D12 fixedPackages coverage. Ensure the trigger phase (${triggerPhase}) produced its summary artifact.`,
      }
    }
    const pkgResults = (summary as { packageResults?: Array<{ packageName: string; passed: boolean }> }).packageResults ?? []
    const failedPackages = new Set(
      pkgResults.filter(p => !p.passed).map(p => p.packageName.toUpperCase())
    )
    const fixedUpper = new Set(fixedPackages.map(p => p.toUpperCase()))
    const missingPackages = Array.from(failedPackages).filter(p => !fixedUpper.has(p))
    if (missingPackages.length > 0) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: `fix.json: missing failed packages: ${missingPackages.join(", ")}. fixedPackages must cover all failed packages.`,
      }
    }

    // 校验通过 → 完成当前 fix entry
    currentEntry.status = "completed"
    currentEntry.completedAt = now

    // 创建触发阶段新 entry（增量模式）
    const newEntry: PhaseHistoryEntry = {
      phase: triggerPhase,
      status: "in_progress",
      startedAt: now,
      retryCount: 0,
      branchedFrom: "fix",
      incrementalContext: {
        targetPackages: fixedPackages,
      },
    }
    run.phaseHistory.push(newEntry)
    const prevPhase = run.currentPhase
    run.currentPhase = triggerPhase
    run.updatedAt = now

    const triggerPhaseConfig = def.phases.find(p => p.name === triggerPhase) ?? null
    this.persist(run)
    this.appendEvent(
      run.runId, "ADVANCE", triggerPhase,
      `fix → ${triggerPhase} (incremental, packages: ${fixedPackages.join(",")})`
    )

    return {
      run,
      nextPhase: triggerPhaseConfig,
      finished: false,
      waitingForConfirmation: false,
      rejected: false,
    }
  }

  /** 从磁盘加载 artifact JSON（防御性，不存在返回 null；单次 advance 内缓存；plugin 层也可调用） */
  loadArtifactJson(artifactsDir: string, name: string): Record<string, unknown> | null {
    const cacheKey = `${artifactsDir}/${name}`
    if (this.artifactCache.has(cacheKey)) {
      return this.artifactCache.get(cacheKey)!
    }
    // 尝试多个路径
    const candidates = [
      join(artifactsDir, `${name}.json`),
      join(artifactsDir, "translations", name, "translation.json"),
    ]
    for (const filePath of candidates) {
      if (existsSync(filePath)) {
        try {
          const result = JSON.parse(readFileSync(filePath, "utf-8"))
          this.artifactCache.set(cacheKey, result)
          return result
        } catch {
          this.artifactCache.set(cacheKey, null)
          return null
        }
      }
    }
    this.artifactCache.set(cacheKey, null)
    return null
  }

  /** D6: 持久化 run.json（原子写入：tmp → rename） */
  private persist(run: WorkflowRun): void {
    const dir = join(this.artifactsRoot, run.runId)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const filePath = join(dir, "run.json")
    const tmpPath = filePath + ".tmp"
    writeFileSync(tmpPath, JSON.stringify(run, null, 2), "utf-8")
    renameSync(tmpPath, filePath)
  }

  /** 追加事件日志 */
  private appendEvent(runId: string, eventType: string, phase: string, message: string): void {
    const dir = join(this.artifactsRoot, runId)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const logPath = join(dir, "_events.log")
    const now = new Date().toISOString()
    const line = `[${now}] [${eventType}] [${runId}] [${phase}] ${message}\n`
    appendFileSync(logPath, line, "utf-8")
  }
}
