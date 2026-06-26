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

  // review 静态重构后：静态失败(staticPassed=false)的包也必须进 fix 范围（D12），
  // 否则语义干净但静态有问题的包永不修复+不重扫→死循环。
  describe("D12 staticPassed=false 包纳入 fix 范围", () => {
    it("包 passed=true 但 staticPassed=false → fixedPackages 漏它则拒绝", () => {
      const ctx = createEngineWithTempDir()
      try {
        setupAtReview(ctx, "fix-static-001")
        writeArtifact(ctx.dir, "fix-static-001", "inventory.json", makeInventory())
        // 语义干净(passed=true) 但静态失败(staticPassed=false) → allPassed=false
        writeArtifact(ctx.dir, "fix-static-001", "review-summary.json", makeReviewSummary({
          allPassed: false,
          packageResults: [{ packageName: "CORE_PKG", passed: true, staticPassed: false, score: 90, mustFixCount: 0 }],
          totalMustFix: 0,
          totalTodosRemaining: 0,
        }))
        ctx.engine.advance("fix-static-001") // → fix

        // fix.json 含 BASE_PKG(合法) 但漏掉 staticPassed=false 的 CORE_PKG → D12 应拒绝
        writeArtifact(ctx.dir, "fix-static-001", "fix.json", makeFixArtifact({ fixedPackages: ["BASE_PKG"] }))
        const rejected = ctx.engine.advance("fix-static-001", { result: "passed" })
        expect(rejected.rejected).toBe(true)
        expect(rejected.rejectionReason).toMatch(/missing failed packages/)
      } finally {
        ctx.cleanup()
      }
    })

    it("包 passed=true 但 staticPassed=false → fixedPackages 含它则 D12 通过且重扫覆盖", () => {
      const ctx = createEngineWithTempDir()
      try {
        setupAtReview(ctx, "fix-static-002")
        writeArtifact(ctx.dir, "fix-static-002", "inventory.json", makeInventory())
        writeArtifact(ctx.dir, "fix-static-002", "review-summary.json", makeReviewSummary({
          allPassed: false,
          packageResults: [{ packageName: "CORE_PKG", passed: true, staticPassed: false, score: 90, mustFixCount: 0 }],
          totalMustFix: 0,
          totalTodosRemaining: 0,
        }))
        ctx.engine.advance("fix-static-002") // → fix

        // fix.json 含 CORE_PKG → D12 通过，且 review entry 的 targetPackages 含它（重扫覆盖）
        writeArtifact(ctx.dir, "fix-static-002", "fix.json", makeFixArtifact({ fixedPackages: ["CORE_PKG"] }))
        const result = ctx.engine.advance("fix-static-002", { result: "passed" })
        expect(result.rejected).toBe(false)
        expect(result.run.currentPhase).toBe("review")
        const reviewEntry = result.run.phaseHistory[result.run.phaseHistory.length - 1]
        expect(reviewEntry.incrementalContext?.targetPackages).toEqual(["CORE_PKG"])
      } finally {
        ctx.cleanup()
      }
    })
  })
})
