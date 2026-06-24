/**
 * Engine Core — 确定性状态机引擎核心
 *
 * 单流水线架构：8 个阶段 + 1 个条件分支阶段（fix），一个 runId。
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

import { readFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync, readdirSync } from "node:fs"
import { safeWriteFile } from "./cross-platform"
import { join } from "node:path"
import { z } from "zod"
import { validRefNameSet, parseQualified, pkgOf, refOf } from "./refname"

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** D2: fix 循环双层 exhausted 上限 */
export const FIX_LIMITS = {
  globalMax: 5,   // 全局 fix 上限
  phaseMax: 5,    // 单阶段 fix 上限
} as const

/** L3: Quality gate thresholds — 确定性数值门控阈值 */
export const QUALITY_GATE_THRESHOLDS = {
  /** G1: 翻译完成率下限（completedSubprograms / totalSubprograms） */
  COMPLETION_RATIO: 0.8,
  /** G3: review 通过的最低分数 */
  REVIEW_PASS_SCORE: 70,
  /** G6: 测试通过率下限（passedTests / totalTests） */
  TEST_PASS_RATIO: 0.7,
} as const

/** 完成哨兵 */
export const DONE_SENTINEL = "__done__" as const

/** 格式化 Zod 校验错误为可读字符串（供 engine-core 和 plugin 共用） */
export function formatZodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((i) => `  - ${i.path.map(String).join(".")}: ${i.message}`)
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
  needsCrossSchemaValidation?: boolean          // 为 true 时 advance 后执行跨 Schema 校验
  maxPackagesPerShard?: number                  // 分片大小，不设置或 0 表示不分片
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
    targetPackages: string[]                    // 增量模式：只处理这些包（analyze/review 包级分片）
    targetUnits?: string[]                      // translate PROCEDURE 级分片：只处理这些 unit id（PKG.refName）
    shardIndex?: number                         // 分片模式：当前分片序号（0-based）
    totalShards?: number                        // 分片模式：总分片数
    previousFindings?: Array<{                  // 增量 review：上次 review 的 mustFix，供 reviewer 核对是否已修复
      packageName: string
      file: string
      line?: number | null
      issue: string
    }>
  }
}

/** 分片计划 — 首次 dispatch 可分片阶段时计算，持久化到 run.metadata */
export interface ShardPlan {
  phase: string                                 // "translate" 等可分片阶段
  shards: string[][]                            // shards[0] = ["CONST_PKG"]（包级）或 ["PKG.p1"]（translate unit 级）
  completedShards: number[]                     // 已完成的分片序号
  /** true = translate PROCEDURE 级分片（shards 元素是 unit id `PKG.refName`，dispatch 注入 targetUnits）；
   *  false/缺省 = 包级分片（analyze/review，或无 procedureOrder 回退的 translate，注入 targetPackages）。 */
  unitMode?: boolean
}

/** 跨 Schema 校验发现项（D9 扩展：支持 blocking / warning 两级严重度） */
export interface CrossSchemaFinding {
  message: string
  severity: "blocking" | "warning"
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
  warningPending?: boolean                      // [deprecated] 不再阻断，warning 自动放行
  crossSchemaWarnings?: string[]                // 跨 schema warning 消息列表
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
    shardIndex: z.number().optional(),
    totalShards: z.number().optional(),
    previousFindings: z.array(z.object({
      packageName: z.string(),
      file: z.string(),
      line: z.number().nullable().optional(),
      issue: z.string(),
    })).optional(),
  }).optional(),
})

export const WorkflowRunSchema = z.object({
  runId: z.string(),
  definitionId: z.string(),
  currentPhase: z.string().nullable(),
  status: z.enum(["running", "paused", "completed", "completed_with_issues", "aborted"]),
  phaseHistory: z.array(PhaseHistoryEntrySchema),
  metadata: z.record(z.string(), z.unknown()),
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

  advance(runId: string, input: { result?: "passed" | "failed"; acceptWarnings?: boolean } = {}): AdvanceResult {
    this.artifactCache.clear()  // 每次 advance 开始时清除缓存
    const run = this.getRun(runId)
    const def = this.getDefinition(run.definitionId)
    const now = new Date().toISOString()
    let crossSchemaWarnings: string[] | undefined

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

    // ── Step 2: 查找当前阶段配置 ──
    const currentPhaseConfig = def.phases.find(p => p.name === run.currentPhase)

    // ── Step 3a: 确定性数值质量门控 (L3) — 所有阶段 ──
    const qualityFindings = this.validateQualityGates(run, run.currentPhase!)
    for (const f of qualityFindings) {
      this.appendEvent(runId, "ADVANCE", run.currentPhase ?? "", `[quality-gate-${f.severity}] ${f.message}`)
    }

    // ── Step 3b: 跨 Schema 校验 (D9) — 仅 needsCrossSchemaValidation 阶段 ──
    // inventory-index ↔ inventory 包名一致性作为 warning 在 advance 中检查（plugin 层不再 blocking 校验此项）
    let crossSchemaFindings: CrossSchemaFinding[] = []
    if (currentPhaseConfig?.needsCrossSchemaValidation) {
      crossSchemaFindings = this.validateCrossSchema(run, run.currentPhase!)
      for (const f of crossSchemaFindings) {
        this.appendEvent(runId, "ADVANCE", run.currentPhase ?? "", `[cross-schema-${f.severity}] ${f.message}`)
      }
    }

    // inventory 阶段：包名一致性作为 warning（不阻断，但要求确认）
    if (run.currentPhase === "inventory") {
      const invWarnings = this.validateInventoryIndexConsistency(run)
      for (const w of invWarnings) {
        crossSchemaFindings.push({ message: w, severity: "warning" })
        this.appendEvent(runId, "ADVANCE", run.currentPhase ?? "", `[inventory-consistency-warning] ${w}`)
      }
    }

    // ── Step 3c: 合并 findings → 三路分支 ──
    const allFindings = [...qualityFindings, ...crossSchemaFindings]
    const blockingFindings = allFindings.filter(f => f.severity === "blocking")
    const warningFindings = allFindings.filter(f => f.severity === "warning")

    // 路径 A：阻断级 → 拒绝 advance（D16：达 REJECTION_BOUND 次后降级为 warning 放行）
    if (blockingFindings.length > 0) {
      // fix 阶段走自有 maxRetries→completed_with_issues 机制，不参与降级
      const isFixPhase = currentPhaseConfig?.isFixPhase === true
      if (!isFixPhase && this.rejectionBoundExceeded(run)) {
        // 降级：连续达到上限，blocking 问题转 warning 放行，不阻断流程
        this.appendEvent(runId, "ADVANCE", run.currentPhase ?? "",
          `[rejection-bound-exceeded] 阶段 ${run.currentPhase} 已连续 ${this.getRejectionCount(run)} 次拒绝，达到上限(${WorkflowEngine.REJECTION_BOUND})，blocking 问题降级为 warning 放行：\n${blockingFindings.map(f => `  - ${f.message}`).join("\n")}`)
        // 不 return，继续走下方放行/推进逻辑（shard advance 或 phase transition）
      } else {
        if (!isFixPhase) this.bumpRejectionCount(run)
        return {
          run,
          nextPhase: null,
          finished: false,
          waitingForConfirmation: false,
          rejected: true,
          rejectionReason: `校验失败（阻塞级）：\n${blockingFindings.map(f => `  - ${f.message}`).join("\n")}`,
          crossSchemaWarnings: warningFindings.length > 0 ? warningFindings.map(f => f.message) : undefined,
        }
      }
    }

    // 路径 B：warning 不阻断，直接放行并在结果中附带醒目警告
    // 不再要求 acceptWarnings 确认——LLM 遗漏包名等常见偏差不应卡住流程
    crossSchemaWarnings = warningFindings.length > 0 ? warningFindings.map(f => f.message) : undefined
    if (warningFindings.length > 0) {
      this.appendEvent(runId, "ADVANCE", run.currentPhase ?? "",
        `[warnings-auto-accepted] ${warningFindings.length} 个校验警告（含 quality-gate 和 cross-schema），已自动放行：\n${warningFindings.map(f => `  - ${f.message}`).join("\n")}`)
    }

    // ── Step 4: fix 阶段特殊处理 ──
    if (currentPhaseConfig?.isFixPhase) {
      return this.handleFixAdvance(run, def, currentEntry, input, now, crossSchemaWarnings)
    }

    // ── Step 3.5: 分片 advance — 分片未全部完成时切换到下一分片 ──
    const shardPlan = this.getShardPlan(run)
    if (shardPlan) {
      const currentShardIndex = currentEntry.incrementalContext?.shardIndex ?? 0
      const totalShards = shardPlan.shards.length

      // 标记当前分片完成
      if (!shardPlan.completedShards.includes(currentShardIndex)) {
        shardPlan.completedShards.push(currentShardIndex)
      }

      // 查找下一个未完成的分片。completedShards 由本函数顺序 push，恒为紧凑 [0..k]，
      // 故“第一个未完成”即等于“当前分片之后的下一个”；无需额外 fallback。
      const nextShardIndex = shardPlan.shards.findIndex(
        (_, i) => !shardPlan.completedShards.includes(i),
      )

      if (nextShardIndex >= 0) {
        // 还有未完成的分片 → 完成当前 entry，创建新 entry（同阶段，新分片）
        currentEntry.status = "completed"
        currentEntry.completedAt = now
        run.updatedAt = now

        const nextShard = shardPlan.shards[nextShardIndex]
        const newEntry: PhaseHistoryEntry = {
          phase: run.currentPhase!,
          status: "in_progress",
          startedAt: now,
          retryCount: 0,
          incrementalContext: {
            targetPackages: nextShard,
            shardIndex: nextShardIndex,
            totalShards,
          },
        }
        run.phaseHistory.push(newEntry)
        run.metadata.shardPlan = shardPlan
        this.persist(run)
        this.appendEvent(runId, "SHARD_ADVANCE", run.currentPhase!,
          `分片 ${currentShardIndex + 1}/${totalShards} 完成 → 分片 ${nextShardIndex + 1}/${totalShards} (包: ${nextShard.join(", ")})`)

        return {
          run,
          nextPhase: currentPhaseConfig ?? null,
          finished: false,
          waitingForConfirmation: false,
          rejected: false,
          crossSchemaWarnings,
        }
      }

      // 全部分片完成 → 删除 shardPlan，继续走下方原有 advance 逻辑（transition）。
      // 注意：质量门控（G1/G2）与跨 Schema 校验已在 Step 3a/3b 执行——它们是 per-package
      // 的，每个分片 advance 时各自检查了该分片的包，故全量覆盖在分片推进过程中已完成，
      // 此处无需也不应重跑。清除 incrementalContext 仅是为了让最终 transition 不携带
      // 分片作用域上下文（避免下游误以为仍是增量模式）。
      delete run.metadata.shardPlan
      currentEntry.incrementalContext = undefined
      this.persist(run)
      this.appendEvent(runId, "SHARD_COMPLETE", run.currentPhase!,
        `所有分片已完成 (${totalShards} 个)，执行阶段推进`)
      // 注意：不 return，继续走下方原有 advance 逻辑
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
          crossSchemaWarnings,
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
        crossSchemaWarnings,
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
        crossSchemaWarnings,
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
          crossSchemaWarnings,
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
        crossSchemaWarnings,
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
      crossSchemaWarnings,
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

    // 两者都存在时才比对；缺任一文件说明不是完整的 workflow 运行场景，不产生 warning
    if (!inventory || !inventoryIndex) {
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
  // 返回 CrossSchemaFinding 数组（blocking 级由 advance() 决定是否阻断）

  validateCrossSchema(run: WorkflowRun, completedPhase: string): CrossSchemaFinding[] {
    const findings: CrossSchemaFinding[] = []
    // 整体 try/catch：校验对象是 LLM 产出的 raw JSON（未经 schema），结构异常时降级为 warning，
    // 绝不抛出——保住"validateCrossSchema 内部异常降级为 warning"的安全网。
    // blocking/warning 的阻断决策由 advance() 根据严重度决定，而非此函数本身。
    try {
    const artifactsDir = join(this.artifactsRoot, run.runId)

    const inventory = this.loadArtifactJson(artifactsDir, "inventory")
    const analysis = this.loadArtifactJson(artifactsDir, "analysis")

    if (!inventory || !analysis) {
      findings.push({
        message: `跨 Schema 校验跳过：缺少必要的 artifact（inventory: ${!!inventory}, analysis: ${!!analysis}）`,
        severity: "warning",
      })
      return findings
    }

    // inventory-index ↔ inventory 一致性已在 inventory 阶段完成时独立校验，此处不重复

    // inventory 包名 ↔ analysis 包名（双向，大小写不敏感）
    const invNames = this.extractPackageNames(inventory)
    const anaNames = this.extractPackageNames(analysis)
    const invUpper = new Set([...invNames].map((n) => n.toUpperCase()))
    const anaUpper = new Set([...anaNames].map((n) => n.toUpperCase()))
    for (const name of invNames) {
      if (!anaUpper.has(name.toUpperCase())) findings.push({ message: `analysis 缺少包: ${name}`, severity: "warning" })
    }
    for (const name of anaNames) {
      if (!invUpper.has(name.toUpperCase())) findings.push({ message: `inventory 缺少包: ${name}（analysis 中存在但 inventory 中不存在）`, severity: "warning" })
    }

    // translationOrder 覆盖校验（大小写不敏感）
    const orderedUpper = new Set(
      ((analysis.translationOrder as string[][]) ?? []).flat()
        .filter((n): n is string => typeof n === "string" && n.length > 0)
        .map((n) => n.toUpperCase())
    )
    for (const name of anaNames) {
      if (!orderedUpper.has(name.toUpperCase())) findings.push({ message: `translationOrder 缺少包: ${name}`, severity: "warning" })
    }

    // callGraph refName 一致性校验（仅 inventory 完成后；analysis.json 现由 inventory 阶段代码产出）
    // analysis.json.callGraph 的 key/value 须为 PKG.refName，refName 须落在该包 inventory-packages
    // 推导出的合法集合内（非重载=裸名，重载={name}__序号，全部带序号）。
    if (completedPhase === "inventory") {
      const callGraph = (analysis.callGraph as Record<string, string[]>) ?? {}
      const refNameByPkg = this.buildRefNameIndex(artifactsDir, anaNames)
      const refs: Array<[string, "key" | "value"]> = []
      for (const [k, vs] of Object.entries(callGraph)) {
        refs.push([k, "key"])
        if (Array.isArray(vs)) {
          for (const v of vs) refs.push([v, "value"])
        } else {
          findings.push({ message: `callGraph["${k}"] 的值应为字符串数组，实际为 ${vs === null ? "null" : typeof vs}，已跳过该调用边`, severity: "warning" })
        }
      }
      for (const [qualified, kind] of refs) {
        const parsed = parseQualified(qualified)
        if (!parsed) {
          findings.push({ message: `callGraph ${kind} 非法的限定名格式（应为 PKG.refName）: ${qualified}`, severity: "warning" })
          continue
        }
        const [pkg, ref] = parsed
        const valid = refNameByPkg.get(pkg.toUpperCase())
        if (valid && !valid.has(ref.toUpperCase())) {
          findings.push({
            message: `callGraph ${kind} 的 refName "${ref}" 不在 ${pkg} 的合法 refName 集合内（重载子程序应为 {name}__序号，禁用裸名）: ${qualified}`,
            severity: "warning",
          })
        }
      }
    }

    // plan 映射覆盖（仅 plan 完成后校验）
    if (completedPhase === "plan") {
      const plan = this.loadArtifactJson(artifactsDir, "plan")
      if (!plan) {
        findings.push({ message: "plan 映射校验跳过：plan artifact 不存在", severity: "warning" })
        return findings
      }
      const mappedNames = new Set(
        (plan.packageMappings as Array<{ oraclePackage: string }>)
          .map((m) => m.oraclePackage)
          .filter((n): n is string => typeof n === "string" && n.length > 0)
      )
      for (const name of invNames) {
        if (!mappedNames.has(name)) findings.push({ message: `plan 未映射包: ${name}`, severity: "warning" })
      }
    }

    // translation.json.subprogramMethods refName + 唯一性校验
    // oracleName 须唯一、且落在该包合法 refName 集合内（重载带 {name}__序号）。
    // translate 完成时所有包 translation.json 已齐 → 即时校验给 translator 反馈；dedup 再校验一次（幂等）。
    if (completedPhase === "translate" || completedPhase === "dedup") {
      const refNameByPkg = this.buildRefNameIndex(artifactsDir, anaNames)
      for (const pkg of anaNames) {
        const trans = this.loadArtifactJson(artifactsDir, pkg) // → translations/{pkg}/translation.json
        if (!trans) {
          findings.push({ message: `${pkg}: translation.json 未找到（translations/${pkg}/translation.json 路径或大小写不匹配），跳过 subprogramMethods 校验`, severity: "warning" })
          continue
        }
        const valid = refNameByPkg.get(pkg.toUpperCase())
        const methods = Array.isArray(trans.subprogramMethods) ? (trans.subprogramMethods as Array<{ oracleName: string }>) : []
        const seen = new Set<string>()
        for (const m of methods) {
          const key = (m.oracleName ?? "").toUpperCase()
          if (!key) {
            findings.push({ message: `${pkg}: subprogramMethods 存在空 oracleName`, severity: "warning" })
            continue
          }
          if (seen.has(key)) findings.push({ message: `${pkg}: subprogramMethods 重复 oracleName: ${m.oracleName}`, severity: "warning" })
          seen.add(key)
          if (valid && !valid.has(key)) {
            findings.push({
              message: `${pkg}: subprogramMethods.oracleName "${m.oracleName}" 不在合法 refName 集合内（重载子程序应为 {name}__序号）`,
              severity: "warning",
            })
          }
        }
      }
    }

    // dedup 跨包引用校验（仅 dedup 完成后校验）
    if (completedPhase === "dedup") {
      const dedup = this.loadArtifactJson(artifactsDir, "dedup")
      if (!dedup) {
        findings.push({ message: "dedup 校验跳过：dedup artifact 不存在", severity: "warning" })
        return findings
      }

      // 校验 affectedPackages 引用有效包名
      const moduleRefs = (
        (dedup.extractedModules as Array<{ affectedPackages?: string[] }>) ?? []
      ).flatMap((m) => (m.affectedPackages ?? []))
      this.validatePackageRefs(moduleRefs, invNames, "dedup: affectedPackages", findings)

      // 校验 packageChanges 引用有效包名
      const changePkgs = (
        (dedup.packageChanges as Array<{ packageName: string }>) ?? []
      ).map((c) => c.packageName)
      this.validatePackageRefs(changePkgs, invNames, "dedup: packageChanges", findings)
    }
    } catch (e) {
      findings.push({
        message: `跨 Schema 校验内部异常（已降级为 warning，不阻塞流程）: ${e instanceof Error ? e.message : String(e)}`,
        severity: "warning",
      })
    }
    return findings
  }

  // ── L3: 确定性数值质量门控 ──
  // 返回 CrossSchemaFinding 数组（与 validateCrossSchema 同类型，复用三路分支管道）

  validateQualityGates(run: WorkflowRun, completedPhase: string): CrossSchemaFinding[] {
    const findings: CrossSchemaFinding[] = []
    // 整体 try/catch 安全网：校验对象是 LLM 产出的 raw JSON，结构异常时降级为 warning
    try {
    const artifactsDir = join(this.artifactsRoot, run.runId)

    switch (completedPhase) {
      case "translate": {
        // G1 + G2: 翻译质量检查
        const inventory = this.loadArtifactJson(artifactsDir, "inventory")
        if (!inventory) break
        const pkgNames = this.extractPackageNames(inventory)
        const currentEntry = this.findCurrentEntry(run)
        const targetPkgs = currentEntry?.incrementalContext?.targetPackages
        const targetUnits = currentEntry?.incrementalContext?.targetUnits

        // PROCEDURE 级（unit 模式）：按 unit 校验，不按整包完成率（包可能跨多分片、中途必然 partial）。
        // 每个 targetUnit 的 per-unit 文件须 status=completed，且 subprogramMethods 覆盖其 completedSubprograms。
        if (targetUnits && targetUnits.length > 0) {
          for (const u of targetUnits) {
            const pkg = pkgOf(u)
            const ref = refOf(u)
            const unit = this.loadArtifactJson(join(artifactsDir, "translations", pkg), ref) as any
            if (!unit) continue // 缺失由 validateArtifactOnDisk 完整性检查覆盖
            const completed = (unit.completedSubprograms as string[]) ?? []
            // G1-unit: 单元必须 completed（根 + cargo 全译）
            if (unit.status !== "completed") {
              findings.push({
                message: `${pkg}.${ref}: unit status="${unit.status}" 非 completed。本分片单元须全部完成`,
                severity: "blocking",
              })
            }
            // G2-unit: subprogramMethods 覆盖本单元已完成子程序
            const methods = (unit.subprogramMethods as unknown[]) ?? []
            if (methods.length < completed.length) {
              findings.push({
                message: `${pkg}.${ref}: subprogramMethods 数量 (${methods.length}) 少于 completedSubprograms (${completed.length})，可能缺少跨包调用映射`,
                severity: "warning",
              })
            }
          }
          break
        }

        // 包级模式（含 procedureOrder 缺失的回退）：原有 G1/G2 整包完成率检查
        const pkgsToCheck = targetPkgs?.length ? new Set(targetPkgs) : pkgNames

        for (const pkg of pkgsToCheck) {
          const trans = this.loadArtifactJson(artifactsDir, pkg) // → translations/{pkg}/translation.json
          if (!trans) continue // 缺失由 Zod 校验覆盖
          const completed = (trans.completedSubprograms as string[]) ?? []
          const total = (trans.totalSubprograms as number) ?? 0
          // G1: 翻译完成率
          if (total > 0 && completed.length / total < QUALITY_GATE_THRESHOLDS.COMPLETION_RATIO) {
            const ratio = completed.length / total
            findings.push({
              message: `${pkg}: 翻译完成率 ${(ratio * 100).toFixed(1)}% (${completed.length}/${total}) 低于阈值 ${QUALITY_GATE_THRESHOLDS.COMPLETION_RATIO * 100}%。请重新审视翻译过程，确保更多子程序被完整翻译`,
              severity: "blocking",
            })
          }
          // G2: subprogramMethods 覆盖
          const methods = (trans.subprogramMethods as unknown[]) ?? []
          if (methods.length < completed.length) {
            findings.push({
              message: `${pkg}: subprogramMethods 数量 (${methods.length}) 少于 completedSubprograms 数量 (${completed.length})。可能缺少跨包调用映射，建议补充`,
              severity: "warning",
            })
          }
        }
        break
      }

      case "review": {
        // G3 + G4: review quality checks（基于 review-summary.json，无需 per-package review.json）
        const summary = this.loadArtifactJson(artifactsDir, "review-summary")
        if (!summary) break

        // 增量模式：只检查目标包
        const reviewEntry = this.findCurrentEntry(run)
        const reviewTargetPkgs = reviewEntry?.incrementalContext?.targetPackages
        const reviewPkgsToCheck = reviewTargetPkgs?.length
          ? new Set(reviewTargetPkgs.filter((p): p is string => typeof p === "string" && p.length > 0).map(p => p.toUpperCase()))
          : null

        // G3: per-package score check
        const packageResults = (summary.packageResults as Array<{ packageName: string; passed: boolean; score: number }>) ?? []
        for (const pr of packageResults) {
          // 跳过 packageName 无效的条目（LLM 产出的 raw JSON 可能缺字段）
          if (typeof pr.packageName !== "string" || !pr.packageName) continue
          // 增量模式下跳过非目标包
          if (reviewPkgsToCheck && !reviewPkgsToCheck.has(pr.packageName.toUpperCase())) continue
          if (pr.passed && pr.score < QUALITY_GATE_THRESHOLDS.REVIEW_PASS_SCORE) {
            findings.push({
              message: `${pr.packageName}: review passed=true 但 score=${pr.score} 低于阈值 ${QUALITY_GATE_THRESHOLDS.REVIEW_PASS_SCORE}。低分不应通过审查，请补充审查或修正评分`,
              severity: "blocking",
            })
          }
        }

        // G4: allPassed + totalMustFix 逻辑矛盾
        const allPassed = (summary as { allPassed?: boolean }).allPassed ?? false
        const totalMustFix = (summary as { totalMustFix?: number }).totalMustFix ?? 0
        if (allPassed && totalMustFix > 0) {
          findings.push({
            message: `review-summary: allPassed=true 但 totalMustFix=${totalMustFix} > 0，逻辑矛盾。存在 mustFix 项时 allPassed 应为 false`,
            severity: "blocking",
          })
        }
        break
      }

      case "verify": {
        // G5 + G6: verify quality checks（基于 verify-summary.json）
        const summary = this.loadArtifactJson(artifactsDir, "verify-summary")
        if (!summary) break

        // G5: compilation.success vs allPassed
        const comp = (summary as { compilation?: { success?: boolean } }).compilation
        const allPassed = (summary as { allPassed?: boolean }).allPassed ?? false
        if (comp && comp.success === false && allPassed) {
          findings.push({
            message: `verify-summary: compilation.success=false 但 allPassed=true。编译失败的代码不应通过验证`,
            severity: "blocking",
          })
        }

        // G6: test pass ratio
        const te = (summary as { testExecution?: { executed?: boolean; totalTests?: number; passedTests?: number } }).testExecution
        if (te && te.executed && te.totalTests && te.totalTests > 0) {
          const passedTests = te.passedTests ?? 0
          const ratio = passedTests / te.totalTests
          if (ratio < QUALITY_GATE_THRESHOLDS.TEST_PASS_RATIO) {
            findings.push({
              message: `verify-summary: 测试通过率 ${(ratio * 100).toFixed(1)}% (${passedTests}/${te.totalTests}) 低于阈值 ${QUALITY_GATE_THRESHOLDS.TEST_PASS_RATIO * 100}%。大量测试失败可疑，请确认测试结果`,
              severity: "warning",
            })
          }
        }
        break
      }
    }

    } catch (e) {
      findings.push({
        message: `质量门禁内部异常（已降级为 warning，不阻塞流程）: ${e instanceof Error ? e.message : String(e)}`,
        severity: "warning" as const,
      })
    }
    return findings
  }

  // ── D2: isFixExhausted 双层判定 ──
  // 支持 epoch 重置：fixEpoch 之后的 fix entry 才计入计数

  isFixExhausted(run: WorkflowRun, triggerPhase: string, preCreate: boolean): boolean {
    const epoch = Number(run.metadata.fixEpoch) || 0
    const fixEntries = run.phaseHistory.filter((e, i) => e.phase === "fix" && i >= epoch)
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

  /**
   * fixContinue — 用户选择继续 fix 时重置计数器并恢复运行
   * 将 fixEpoch 设为当前 phaseHistory 长度（忽略之前的 fix entry），
   * 恢复 status=running，创建新 fix entry 指向原始触发阶段。
   */
  fixContinue(runId: string): WorkflowRun {
    const run = this.getRun(runId)
    if (run.status !== "completed_with_issues") {
      throw new WorkflowEngineError(`Cannot fixContinue: run status is "${run.status}", expected "completed_with_issues"`, "INVALID_STATE")
    }

    // 找到最后一个 fix entry 的 branchedFrom 作为触发阶段
    const fixEntries = run.phaseHistory.filter(e => e.phase === "fix")
    const lastFix = fixEntries[fixEntries.length - 1]
    const triggerPhase = lastFix?.branchedFrom
    if (!triggerPhase) {
      throw new WorkflowEngineError("Cannot fixContinue: no fix entry found with branchedFrom", "INVALID_STATE")
    }

    const now = new Date().toISOString()

    // 重置计数器：epoch 设为当前长度
    run.metadata.fixEpoch = run.phaseHistory.length

    // 恢复运行状态
    run.status = "running"

    // 创建新 fix entry
    const newEntry: PhaseHistoryEntry = {
      phase: "fix",
      status: "in_progress",
      startedAt: now,
      retryCount: 0,
      branchedFrom: triggerPhase,
    }
    run.phaseHistory.push(newEntry)
    run.currentPhase = "fix"
    run.updatedAt = now

    this.persist(run)
    this.appendEvent(runId, "FIX_CONTINUE", "fix", `fix counters reset, resuming fix for trigger: ${triggerPhase}`)
    return run
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

  // ── 拒绝次数上限（D16）──────────────────────────────────────────────────────
  // 非 fix 阶段的 blocking 拒绝（Zod 结构 / 质量门控 / 跨 schema）共享一个计数器，
  // 达 REJECTION_BOUND 次后降级为 warning 放行，避免无限 round-trip 烧 LLM。
  // fix 阶段有自有的 maxRetries→completed_with_issues 机制，不走此路径。
  // 计数按 "phase:shardIndex" 分桶：分片阶段每个分片独立计数，互不连累。

  /** 拒绝上限：达到此次数后，本目标的 blocking 问题降级为 warning 放行 */
  static readonly REJECTION_BOUND = 3

  /** 当前 dispatch 目标（phase + shardIndex）的计数键 */
  private rejectionKey(run: WorkflowRun): string {
    const entry = this.findCurrentEntry(run)
    const shard = entry?.incrementalContext?.shardIndex
    return `${run.currentPhase ?? "?"}:${shard ?? "-"}`
  }

  /** 读取当前目标的拒绝次数 */
  getRejectionCount(run: WorkflowRun): number {
    const counts = (run.metadata.rejectionCounts as Record<string, number>) ?? {}
    return counts[this.rejectionKey(run)] ?? 0
  }

  /** 递增当前目标的拒绝次数并持久化，返回递增后的值 */
  bumpRejectionCount(run: WorkflowRun): number {
    const counts = ((run.metadata.rejectionCounts as Record<string, number>) ?? {}) as Record<string, number>
    const key = this.rejectionKey(run)
    counts[key] = (counts[key] ?? 0) + 1
    run.metadata.rejectionCounts = counts
    this.persist(run)
    return counts[key]
  }

  /** 当前目标是否已达拒绝上限（应降级为 warning 放行而非再次拒绝） */
  rejectionBoundExceeded(run: WorkflowRun): boolean {
    return this.getRejectionCount(run) >= WorkflowEngine.REJECTION_BOUND
  }

  /** 公共事件日志入口（供 plugin 层降级时记录 warning） */
  logEvent(runId: string, eventType: string, phase: string, message: string): void {
    this.appendEvent(runId, eventType, phase, message)
  }

  /**
   * 根据 analysis.json 的 translationOrder 计算分片计划。
   *
   * translationOrder 的每个内层数组要么是单包（独立包），要么是 SCC 组
   *（强连通循环依赖包，必须同 session 翻译以解析循环引用，见 sql-analyst.md）。
   *
   * 切分策略：按拓扑序贪心打包到 maxPackagesPerShard 上限的分片，跨层合并独立包
   *（独立包互不依赖，同分片内按 translationOrder 顺序处理仍安全）。关键不变量：
   * **SCC 组（length > 1 的层）原子不可分**——绝不拆到不同分片，否则组内循环引用
   * 会因被依赖包尚未翻译而沦为 TODO 占位（review/fix 才能兜底）。单个 SCC 组超过
   * maxPackagesPerShard 时，作为超大分片整组发出。
   */

  /**
   * 按阶段决定分片所用的序列：analyze/review 拍平 SCC 组（每元素一层，真正一元素一分片），
   * translate 保留入参原貌（SCC 互依赖组必须共处）。
   *
   * 入参语义随阶段而异：analyze 传单元级 procedureOrder（`PKG.refName`，PROCEDURE 为 unit，
   * FUNCTION 跟随属主——下沉到 PROCEDURE 级后由 dispatch 注入）；review 传包级 translationOrder；
   * translate 传单元级 procedureOrder。三者都是 string[][] 拓扑层，本函数仅按阶段决定是否拍平，
   * 不关心元素是包名还是 unit id。
   *
   * 为什么 analyze/review 可拆 SCC：analyze 现下沉到 PROCEDURE 级，每 procedure 的子程序结构 / FSD
   * 独立产出，跨包/跨单元调用关系（callGraph）已由 inventory 代码预算，不依赖同组其它单元的在 session
   * 产物；review 每包审查独立。为什么 translate 不可拆：互依赖 unit 翻译时需同 session 拿到对方的
   * Java 方法签名，拆开会让循环引用沦为 TODO 占位。
   */
  shardOrderForPhase(translationOrder: string[][], phase: string): string[][] {
    if (phase === "analyze" || phase === "review") {
      return translationOrder
        .flat()
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map(p => [p])
    }
    return translationOrder
  }

  computeShardPlan(
    translationOrder: string[][],
    maxPackagesPerShard: number,
    phase: string,
  ): ShardPlan {
    const shards: string[][] = []
    let current: string[] = []
    for (const layer of translationOrder) {
      if (!layer || layer.length === 0) continue
      // 当前分片非空且加入本层会超限 → 先 flush（本层作为新分片开头）
      if (current.length > 0 && current.length + layer.length > maxPackagesPerShard) {
        shards.push(current)
        current = []
      }
      current.push(...layer)
      // 单个 SCC 组本身就超限（current 仅含本层）→ 整组作为超大分片立即 flush
      if (current.length > maxPackagesPerShard && current.length === layer.length) {
        shards.push(current)
        current = []
      }
    }
    if (current.length > 0) shards.push(current)
    return { phase, shards, completedShards: [] }
  }

  /**
   * 从 run.metadata 获取当前阶段的分片计划。
   * 返回 null 表示不分片或非当前阶段。
   */
  getShardPlan(run: WorkflowRun): ShardPlan | null {
    const sp = run.metadata.shardPlan as ShardPlan | undefined
    // metadata 是 z.record(z.unknown())，shardPlan 形状无 schema 约束；
    // 防御性校验：结构异常（外部篡改/旧版残留）时丢弃而非让 advance 误用。
    if (!sp
      || typeof sp.phase !== "string"
      || sp.phase !== run.currentPhase
      || !Array.isArray(sp.shards)
      || !Array.isArray(sp.completedShards)
    ) return null
    return sp
  }

  /** 从 artifact JSON 提取包名集合（兼容 new/old 格式） */
  extractPackageNames(
    artifact: Record<string, unknown>,
    toUpperCase = false,
  ): Set<string> {
    let names: string[]
    if (artifact.packageNames) {
      names = (artifact.packageNames as string[]).filter((n): n is string => typeof n === "string" && n.length > 0)
    } else if (artifact.packages) {
      names = ((artifact.packages as Array<{ name: string }>) ?? [])
        .map((p) => p.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0)
    } else {
      names = []
    }
    if (toUpperCase) {
      names = names.map((n) => n.toUpperCase())
    }
    return new Set(names)
  }

  /** 校验包名引用列表是否全部在有效包名集合中（大小写不敏感），无效引用追加到 findings */
  private validatePackageRefs(
    refs: string[],
    validNames: Set<string>,
    label: string,
    findings: CrossSchemaFinding[],
    severity: "blocking" | "warning" = "warning",
  ): void {
    const upperValid = new Set([...validNames].map((n) => n.toUpperCase()))
    const validRefs = refs.filter((p): p is string => typeof p === "string" && p.length > 0)
    const invalid = validRefs.filter((p) => !upperValid.has(p.toUpperCase()))
    if (invalid.length > 0) {
      findings.push({ message: `${label} 引用了不存在的包: ${[...new Set(invalid)].join(", ")}`, severity })
    }
  }

  /**
   * 构建各包（包名大写）→ 合法 refName 集合（大写）的索引，供 callGraph / subprogramMethods
   * 一致性校验复用。refName 推导依据 inventory-packages/{PKG}.json 的 procedures 数组顺序与重复次数。
   */
  private buildRefNameIndex(
    artifactsDir: string,
    packageNames: Iterable<string>,
  ): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>()
    for (const pkg of packageNames) {
      const invPkg = this.loadArtifactJson(artifactsDir, `inventory-packages/${pkg}`)
      const procs = ((invPkg?.procedures as Array<{ name: string }>) ?? []).map((p) => p.name)
      // 空包 / 缺失 inventory-packages 文件也建索引（validRefNameSet([]) → 空 Set）：该包的任何
      // refName 引用都会被判非法并告警，而非因 valid 为 undefined 被 `if (valid && ...)` 静默跳过。
      index.set(pkg.toUpperCase(), validRefNameSet(procs))
    }
    return index
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
    crossSchemaWarnings: string[] | undefined,
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
        crossSchemaWarnings,
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
          crossSchemaWarnings,
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
        crossSchemaWarnings,
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
        crossSchemaWarnings,
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
        crossSchemaWarnings,
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
        crossSchemaWarnings,
      }
    }

    // D12: 校验包名存在于 inventory（新格式 packageNames 优先，旧格式 packages[].name 回退）
    const inventory = this.loadArtifactJson(artifactsDir, "inventory")
    if (inventory) {
      const invPackageNames = this.extractPackageNames(inventory, true)
      const invalidPackages = fixedPackages
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .filter(p => !invPackageNames.has(p.toUpperCase()))
      if (invalidPackages.length > 0) {
        return {
          run,
          nextPhase: null,
          finished: false,
          waitingForConfirmation: false,
          rejected: true,
          rejectionReason: `fix.json: invalid package names not in inventory: ${invalidPackages.join(", ")}`,
          crossSchemaWarnings,
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
        crossSchemaWarnings,
      }
    }
    const pkgResults = (summary as { packageResults?: Array<{ packageName: string; passed: boolean }> }).packageResults ?? []
    const failedPackages = new Set(
      pkgResults
        .filter(p => !p.passed && typeof p.packageName === "string" && p.packageName)
        .map(p => p.packageName.toUpperCase())
    )
    const fixedUpper = new Set(
      fixedPackages.filter((p): p is string => typeof p === "string" && p.length > 0).map(p => p.toUpperCase())
    )
    const missingPackages = Array.from(failedPackages).filter(p => !fixedUpper.has(p))
    if (missingPackages.length > 0) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: `fix.json: missing failed packages: ${missingPackages.join(", ")}. fixedPackages must cover all failed packages.`,
        crossSchemaWarnings,
      }
    }

    // 校验通过 → 完成当前 fix entry
    currentEntry.status = "completed"
    currentEntry.completedAt = now

    // F2: fix 后直接路由到 review（不再经过 dedup）。
    // review 不依赖 dedup.json 内容，跳过 dedup 减少循环开销。
    // dedup 只在主线 translate 后执行一次。
    // 直接查找 condition:"always" 规则，避免 matchTransitionRule 的 exact-match-then-fallback
    // 在未来添加 condition:"passed" 的 fix transition 时匹配到错误规则。
    const fixAlwaysRule = def.transitions.find(t => t.from === "fix" && t.condition === "always")
    const nextPhase = fixAlwaysRule?.to
    if (!nextPhase) {
      return {
        run,
        nextPhase: null,
        finished: false,
        waitingForConfirmation: false,
        rejected: true,
        rejectionReason: "fix 完成后无可用 transition（缺少 { from: 'fix', condition: 'always' } 规则）",
        crossSchemaWarnings,
      }
    }
    // B-minimal: 增量 review 时把上次 review 的 mustFix 注入 previousFindings，
    // 让 reviewer 先核对旧问题是否修复（机制化核对，保证 fix 没修好的问题不被遗忘）。
    let previousFindings: Array<{ packageName: string; file: string; line?: number | null; issue: string }> | undefined
    if (nextPhase === "review" && triggerPhase === "review") {
      const collected: Array<{ packageName: string; file: string; line?: number | null; issue: string }> = []
      for (const pkg of fixedPackages) {
        const reviewPath = join(artifactsDir, "translations", pkg, "review.json")
        try {
          const raw = JSON.parse(readFileSync(reviewPath, "utf-8")) as {
            mustFix?: Array<{ file?: unknown; line?: unknown; issue?: unknown }>
          }
          for (const f of raw.mustFix ?? []) {
            if (f && typeof f.file === "string" && typeof f.issue === "string") {
              collected.push({
                packageName: pkg,
                file: f.file,
                line: typeof f.line === "number" ? f.line : null,
                issue: f.issue,
              })
            }
          }
        } catch { /* review.json 不存在或解析失败：跳过该包，无 previousFindings 不阻断 */ }
      }
      previousFindings = collected.length > 0 ? collected : undefined
    }

    const newEntry: PhaseHistoryEntry = {
      phase: nextPhase,
      status: "in_progress",
      startedAt: now,
      retryCount: 0,
      branchedFrom: triggerPhase, // 记录原始触发阶段(review/verify)，而非 "fix"
      incrementalContext: {
        targetPackages: fixedPackages,
        ...(previousFindings ? { previousFindings } : {}),
      },
    }
    run.phaseHistory.push(newEntry)
    run.currentPhase = nextPhase
    run.updatedAt = now

    const nextPhaseConfig = def.phases.find(p => p.name === nextPhase) ?? null
    this.persist(run)
    this.appendEvent(
      run.runId, "ADVANCE", nextPhase,
      `fix → ${nextPhase} (incremental, packages: ${fixedPackages.join(",")})`
    )

    return {
      run,
      nextPhase: nextPhaseConfig,
      finished: false,
      waitingForConfirmation: false,
      rejected: false,
      crossSchemaWarnings,
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
    const filePath = join(dir, "run.json")
    safeWriteFile(filePath, JSON.stringify(run, null, 2))
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
    try { appendFileSync(logPath, line, "utf-8") } catch (e: any) { /* 日志写入失败不阻塞主流程 */ if (typeof process !== "undefined" && process.stderr) process.stderr.write(`[engine-core] appendEvent failed: ${e.message}\n`) }
  }
}
