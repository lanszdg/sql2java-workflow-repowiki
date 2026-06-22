/**
 * engine-fix-loop.test.ts — Fix 循环机制集成测试
 *
 * 测试 fix 循环的状态转换、双层 exhausted 策略、fixContinue 重置。
 *
 * TODO: 补充具体输入 → 预期输出
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { WorkflowEngine, FIX_LIMITS } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"
import { makeReviewSummary, makeVerifySummary, makeFixArtifact, makeInventory } from "../helpers/artifact-factory"

/** 推进到 review 阶段并写入 review-summary（自动接受跨 schema warning） */
function setupAtReview(ctx: ReturnType<typeof createEngineWithTempDir>, runId: string) {
  ctx.engine.start("sql2java", runId)
  const phases = ["inventory", "analyze", "plan", "scaffold", "translate", "dedup"]
  for (const _ of phases) {
    let r = ctx.engine.advance(runId)
    if (r.rejected && r.warningPending) {
      r = ctx.engine.advance(runId, { acceptWarnings: true })
    }
    if (r.rejected) throw new Error(`Advance rejected: ${r.rejectionReason}`)
  }
}

/** 推进到 fix 阶段 (review failed → fix)，同时写入 inventory 供 D12 校验 */
function setupAtFix(ctx: ReturnType<typeof createEngineWithTempDir>, runId: string) {
  setupAtReview(ctx, runId)
  // inventory.json 供 D12 包名校验
  writeArtifact(ctx.dir, runId, "inventory.json", makeInventory())
  writeArtifact(ctx.dir, runId, "review-summary.json", makeReviewSummary({
    allPassed: false,
    packageResults: [{ packageName: "CORE_PKG", passed: false, score: 50, mustFixCount: 2 }],
    totalMustFix: 2,
    totalTodosRemaining: 1,
  }))
  ctx.engine.advance(runId) // → fix
}

describe("engine-fix-loop", () => {
  describe("fix passed → review（循环）", () => {
    it("fix 后 fixArtifact 有效 → review", () => {
      const ctx = createEngineWithTempDir()
      try {
        setupAtFix(ctx, "fix-001")
        const run = ctx.engine.status("fix-001")!
        expect(run.currentPhase).toBe("fix")

        writeArtifact(ctx.dir, "fix-001", "fix.json", makeFixArtifact())
        // fix 阶段必须传 result: "passed"
        const result = ctx.engine.advance("fix-001", { result: "passed" })
        expect(result.rejected).toBe(false)
        expect(result.run.currentPhase).toBe("review")
      } finally {
        ctx.cleanup()
      }
    })
  })

  describe("fix 校验拒绝", () => {
    it("fix 无 fix.json 被拒绝", () => {
      // TODO: 到 fix 阶段不写 fix.json，advance 应被拒绝
    })

    it("fix fixedPackages 为空被拒绝", () => {
      // TODO: fix.json 的 fixedPackages 为空
    })

    it("fixedPackages 不覆盖所有失败包被拒绝", () => {
      // TODO: review 说 CORE_PKG + UTIL_PKG 失败，fix 只修了 CORE_PKG
    })
  })

  describe("双层 exhausted 策略 (D2)", () => {
    it("globalMax 和 phaseMax 默认值正确", () => {
      expect(FIX_LIMITS.globalMax).toBe(5)
      expect(FIX_LIMITS.phaseMax).toBe(5)
    })

    it("isFixExhausted: 未超限时返回 false", () => {
      // TODO
    })

    it("isFixExhausted: global 超限返回 true", () => {
      // TODO: 模拟 5 次 global fix
    })

    it("isFixExhausted: phase 超限返回 true", () => {
      // TODO: 模拟 review 阶段 5 次 fix
    })
  })

  describe("fixContinue", () => {
    it("completed_with_issues 状态可 fixContinue", () => {
      // TODO: exhausted 后状态变为 completed_with_issues
      // fixContinue 重置计数器，创建新 fix entry
    })

    it("非 completed_with_issues 状态抛 INVALID_STATE", () => {
      // TODO
    })

    it("fixContinue 重置 epoch 计数器", () => {
      // TODO
    })
  })

  describe("incrementalContext (D3)", () => {
    it("fix 后下一阶段 incrementalContext.targetPackages 设置", () => {
      // TODO: fix 回到 review 时，review entry 应有 incrementalContext
    })
  })

  describe("fix failed + exhausted", () => {
    it("fix failed + 未耗尽 → fixFailed=true", () => {
      // TODO
    })

    it("fix failed + 已耗尽 → completed_with_issues", () => {
      // TODO
    })
  })
})
