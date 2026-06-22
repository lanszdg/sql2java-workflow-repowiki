/**
 * workflow-transitions.test.ts — 完整转移图集成测试（§5 地基测试）
 *
 * 执行点测试需要执行能正确停在/回到目标 phase。此处驱动真实引擎覆盖完整转移图：
 * 主线 happy path（inventory→…→verify passed→done）、review/verify failed→fix→review 回环。
 * 与现有 engine-fix-loop.test.ts（fix 机制细节）互补。
 */

import { describe, it, expect } from "vitest"
import { join } from "node:path"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"
import { makeReviewSummary, makeVerifySummary, makeFixArtifact, makeInventory } from "../helpers/artifact-factory"
import { advanceToPhase } from "../helpers/phase-helpers"

/** start 并推进到指定 phase（跨出 review/verify 前补通过的 summary —— 核心逻辑由公共 advanceToPhase 处理） */
function advanceTo(ctx: ReturnType<typeof createEngineWithTempDir>, runId: string, phase: string) {
  ctx.engine.start("sql2java", runId)
  advanceToPhase(ctx.engine, runId, phase, join(ctx.dir, runId))
}

describe("workflow-transitions 主线 happy path", () => {
  it("inventory → … → verify passed → 完成", () => {
    const ctx = createEngineWithTempDir()
    try {
      advanceTo(ctx, "happy-001", "verify")
      expect(ctx.engine.status("happy-001")!.currentPhase).toBe("verify")

      // verify passed → 完成
      writeArtifact(ctx.dir, "happy-001", "verify-summary.json", makeVerifySummary({ allPassed: true }))
      const r = ctx.engine.advance("happy-001")
      expect(r.finished).toBe(true)
      expect(r.run.status).toBe("completed")
      expect(r.run.currentPhase).toBeNull()
    } finally {
      ctx.cleanup()
    }
  })
})

describe("workflow-transitions review 回环", () => {
  it("review failed → fix → review（增量回环）", () => {
    const ctx = createEngineWithTempDir()
    try {
      advanceTo(ctx, "loop-001", "review")
      writeArtifact(ctx.dir, "loop-001", "inventory.json", makeInventory())

      // review failed → fix
      writeArtifact(ctx.dir, "loop-001", "review-summary.json", makeReviewSummary({
        allPassed: false,
        packageResults: [{ packageName: "CORE_PKG", passed: false, score: 50, mustFixCount: 1 }],
        totalMustFix: 1,
        totalTodosRemaining: 0,
      }))
      let r = ctx.engine.advance("loop-001")
      expect(r.run.currentPhase).toBe("fix")

      // fix passed → review（增量）
      writeArtifact(ctx.dir, "loop-001", "fix.json", makeFixArtifact())
      r = ctx.engine.advance("loop-001", { result: "passed" })
      expect(r.rejected).toBe(false)
      expect(r.run.currentPhase).toBe("review")
      // 回环的 review entry 应带 incrementalContext.targetPackages
      const entry = r.run.phaseHistory[r.run.phaseHistory.length - 1]
      expect(entry.incrementalContext?.targetPackages).toContain("CORE_PKG")
    } finally {
      ctx.cleanup()
    }
  })
})

describe("workflow-transitions verify 回环", () => {
  it("verify failed → fix → review", () => {
    const ctx = createEngineWithTempDir()
    try {
      advanceTo(ctx, "loop-002", "verify")
      writeArtifact(ctx.dir, "loop-002", "inventory.json", makeInventory())

      // verify failed → fix（verify-summary packageResults 须用 packageName，供 D12 覆盖校验）
      writeArtifact(ctx.dir, "loop-002", "verify-summary.json", makeVerifySummary({
        allPassed: false,
        packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      }))
      let r = ctx.engine.advance("loop-002")
      expect(r.run.currentPhase).toBe("fix")

      writeArtifact(ctx.dir, "loop-002", "fix.json", makeFixArtifact())
      r = ctx.engine.advance("loop-002", { result: "passed" })
      expect(r.rejected).toBe(false)
      // F2: fix 后路由到 review（不再经 dedup）
      expect(r.run.currentPhase).toBe("review")
    } finally {
      ctx.cleanup()
    }
  })
})

describe("workflow-transitions dedup 衔接", () => {
  it("dedup → review（always 直进）", () => {
    const ctx = createEngineWithTempDir()
    try {
      advanceTo(ctx, "dedup-001", "dedup")
      expect(ctx.engine.status("dedup-001")!.currentPhase).toBe("dedup")
      // dedup 有 needsCrossSchemaValidation，无 artifact 触发 warning → acceptWarnings
      const r = ctx.engine.advance("dedup-001", { acceptWarnings: true })
      expect(r.rejected).toBe(false)
      expect(r.run.currentPhase).toBe("review")
    } finally {
      ctx.cleanup()
    }
  })
})
