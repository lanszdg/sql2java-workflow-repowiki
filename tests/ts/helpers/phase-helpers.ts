/**
 * phase-helpers.ts — 工作流阶段推进辅助（测试共享）
 *
 * advanceToPhase：把 run 线性推进到目标 phase，跨出 review/verify 前补一份通过的 summary
 * （引擎从 summary.allPassed 推导 result）。供 L2 harness 预置（workspace.ts）与 L1 集成测试
 * （workflow-transitions.test.ts）共用，避免两处重复维护推进 + summary 补桩逻辑。
 *
 * 注意：被 tsx（harness）与 vitest（集成测试）双重加载，故对 .opencode/workflow 用相对路径引入
 * （@workflow 别名只在 vitest 生效）。
 */

import type { WorkflowEngine } from "../../../.opencode/workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "../../../.opencode/workflow/workflow-definitions"
import { makeReviewSummary, makeVerifySummary, writeArtifactJson } from "./artifact-factory"

/** 主线阶段顺序（fix 为分支阶段，不在线性推进路径上） */
const LINEAR_PHASES: readonly string[] = SQL2JAVA_WORKFLOW.phases.map(p => p.name).filter(n => n !== "fix")

/**
 * 从 inventory 线性推进 run 到 targetPhase（run 须已 start）。
 * 跨出 review/verify 前向 runArtifactsDir 补一份 allPassed=true 的 summary（仅推进用，与被测产出无关）。
 *
 * @param engine 已注册 SQL2JAVA_WORKFLOW 的引擎
 * @param runId 已 start 的 runId
 * @param targetPhase 目标 phase（fix 不支持）
 * @param runArtifactsDir 该 run 的 artifact 目录（summary 写入处）
 */
export function advanceToPhase(
  engine: WorkflowEngine,
  runId: string,
  targetPhase: string,
  runArtifactsDir: string,
): void {
  if (targetPhase === "fix") {
    throw new Error("不支持直接推进到 fix（分支阶段）；请以 review/verify 为执行点触发")
  }
  const targetIdx = LINEAR_PHASES.indexOf(targetPhase)
  if (targetIdx < 0) throw new Error(`未知目标 phase: ${targetPhase}`)

  for (let i = 0; i < targetIdx; i++) {
    const run = engine.status(runId)!
    // 跨出 review/verify 前补一份通过的 summary（仅推进用，与被测产出无关）
    if (run.currentPhase === "review") {
      writeArtifactJson(runArtifactsDir, "review-summary.json", makeReviewSummary({ allPassed: true }))
    } else if (run.currentPhase === "verify") {
      writeArtifactJson(runArtifactsDir, "verify-summary.json", makeVerifySummary({ allPassed: true }))
    }
    const r = engine.advance(runId)
    if (r.rejected) {
      // warning pending：测试辅助只需推进到目标阶段，自动接受 warning
      if (r.warningPending) {
        const r2 = engine.advance(runId, { acceptWarnings: true })
        if (r2.rejected) {
          throw new Error(`advance 被拒绝（离开 ${run.currentPhase}）: ${r2.rejectionReason}`)
        }
        continue
      }
      throw new Error(`advance 被拒绝（离开 ${run.currentPhase}）: ${r.rejectionReason}`)
    }
  }

  const run = engine.status(runId)!
  if (run.currentPhase !== targetPhase) {
    throw new Error(`推进后 currentPhase=${run.currentPhase}，期望 ${targetPhase}`)
  }
}
