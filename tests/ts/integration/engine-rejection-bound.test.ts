/**
 * engine-rejection-bound.test.ts — D16 拒绝次数上限降级测试
 *
 * 非 fix 阶段的 blocking 拒绝（Zod / 质量门控 / 跨 schema）共享一个计数器，
 * 达 REJECTION_BOUND(3) 次后降级为 warning 放行，避免无限 round-trip。
 *
 * 这里用 engine.advance 的质量门控 G1（translate 完成率 < 80% → blocking）触发，
 * 验证：前 3 次拒绝、计数递增；第 4 次降级放行（rejected=false，推进到下一阶段）。
 * fix 阶段走自有 maxRetries，不参与降级（单测计数器方法 + per-shard 分桶）。
 */

import { describe, it, expect, afterEach } from "vitest"
import { WorkflowEngine } from "@workflow/engine-core"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"

const RUN_ID = "run-rejection-bound"

function pushToPhase(engine: any, phase: string) {
  const run = engine.runs.get(RUN_ID)
  run.currentPhase = phase
  run.status = "running"
  run.phaseHistory = [
    { phase: "inventory", status: "completed", startedAt: "2026-06-15T00:00:00.000Z", completedAt: "2026-06-15T00:01:00.000Z", retryCount: 0 },
    { phase, status: "in_progress", startedAt: "2026-06-15T00:01:00.000Z", retryCount: 0 },
  ]
  engine.persist(run)
}

/** 写一份完成率 0% 的 translation（触发 G1 blocking）+ 干净的 inventory/analysis */
function writeLowCompletionTranslate(ctx: ReturnType<typeof createEngineWithTempDir>) {
  writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
    sourcePath: "src", packageNames: ["CORE_PKG"], tables: [],
    standaloneProcedures: [], triggers: [], views: [], sequences: [],
  })
  writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
    callGraph: {}, packageDependency: {},
    translationOrder: [["CORE_PKG"]],
    complexity: {}, sccGroups: [],
    packageNames: ["CORE_PKG"],
  })
  writeArtifact(ctx.dir, RUN_ID, "translations/CORE_PKG/translation.json", {
    packageName: "CORE_PKG", status: "partial",
    completedSubprograms: [], totalSubprograms: 5, // 0% < 80% → G1 blocking
    files: [], decisions: [], todos: [], subprogramMethods: [],
  })
}

// ═══════════════════════════════════════════════════════════════
// 计数器方法单元测试
// ═══════════════════════════════════════════════════════════════

describe("rejection-bound 计数器方法", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("初始计数为 0，bump 递增并持久化", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "translate")
    const run = engine.status(RUN_ID)!

    expect(engine.getRejectionCount(run)).toBe(0)
    expect(engine.bumpRejectionCount(run)).toBe(1)
    expect(engine.bumpRejectionCount(run)).toBe(2)
    expect(engine.bumpRejectionCount(run)).toBe(3)
    expect(engine.rejectionBoundExceeded(run)).toBe(true)

    // 持久化生效：重新加载后计数仍在
    const reloaded = engine.loadFromDisk(RUN_ID)
    expect(engine.getRejectionCount(reloaded)).toBe(3)
  })

  it("按 phase:shardIndex 分桶——不同分片互不连累", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    const run = engine.status(RUN_ID)!
    run.currentPhase = "translate"
    run.status = "running"
    run.phaseHistory = [
      { phase: "translate", status: "in_progress", startedAt: "t", retryCount: 0,
        incrementalContext: { targetPackages: ["A"], shardIndex: 0, totalShards: 3 } },
    ]
    engine.persist(run)

    expect(engine.bumpRejectionCount(run)).toBe(1) // shard 0 → 1
    expect(engine.bumpRejectionCount(run)).toBe(2) // shard 0 → 2

    // 切到 shard 1：新桶，从 0 开始
    run.phaseHistory[0].incrementalContext!.shardIndex = 1
    expect(engine.getRejectionCount(run)).toBe(0)
    expect(engine.bumpRejectionCount(run)).toBe(1) // shard 1 → 1

    // 回到 shard 0：原计数保留
    run.phaseHistory[0].incrementalContext!.shardIndex = 0
    expect(engine.getRejectionCount(run)).toBe(2)
  })

  it("REJECTION_BOUND = 3", () => {
    expect(WorkflowEngine.REJECTION_BOUND).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════════
// advance() 降级放行集成测试
// ═══════════════════════════════════════════════════════════════

describe("advance() — blocking 拒绝达上限后降级放行", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("G1 blocking：前 3 次拒绝，第 4 次降级放行推进到 dedup", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "translate")
    writeLowCompletionTranslate(ctx)

    const run0 = engine.status(RUN_ID)!

    // 第 1 次：拒绝，计数 0→1
    let r = engine.advance(RUN_ID)
    expect(r.rejected, "1st advance should reject").toBe(true)
    expect(r.rejectionReason).toContain("翻译完成率")
    expect(engine.getRejectionCount(run0)).toBe(1)

    // 第 2 次：拒绝，计数 1→2
    r = engine.advance(RUN_ID)
    expect(r.rejected, "2nd advance should reject").toBe(true)
    expect(engine.getRejectionCount(run0)).toBe(2)

    // 第 3 次：拒绝，计数 2→3
    r = engine.advance(RUN_ID)
    expect(r.rejected, "3rd advance should reject").toBe(true)
    expect(engine.getRejectionCount(run0)).toBe(3)

    // 第 4 次：达上限，降级放行 → 推进到 dedup
    r = engine.advance(RUN_ID)
    expect(r.rejected, "4th advance should be demoted (not rejected)").toBe(false)
    expect(r.run.currentPhase).toBe("dedup")
    // 降级不 bump：translate 桶计数仍为 3（未递增到 4）。阶段已推进到 dedup，
    // 故 getRejectionCount 读的是 dedup 桶(0)，需直接读 translate 桶。
    const counts = (run0.metadata.rejectionCounts as Record<string, number>) ?? {}
    expect(counts["translate:-"]).toBe(3)
  })

  it("降级事件记录到 _events.log", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "translate")
    writeLowCompletionTranslate(ctx)

    // 跑满 3 次拒绝 + 1 次降级
    engine.advance(RUN_ID)
    engine.advance(RUN_ID)
    engine.advance(RUN_ID)
    engine.advance(RUN_ID)

    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const log = readFileSync(join(ctx.dir, RUN_ID, "_events.log"), "utf-8")
    expect(log).toContain("[rejection-bound-exceeded]")
    expect(log).toContain("降级为 warning 放行")
  })
})
