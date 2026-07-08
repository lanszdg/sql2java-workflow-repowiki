/**
 * shard-advance-unit-mode.test.ts — 分片推进 incrementalContext 字段回归测试
 *
 * bug：engine.advance 推进到下一分片时，新 entry 的 incrementalContext 硬编码 targetPackages，
 *   即使 unitMode=true（analyze/translate PROCEDURE 级）。导致 shard 1+ 的 targetUnits 为空 →
 *   下游 narrowUpstreamForShard / generateUnitSlices / 写入边界全部跳过 → 硬隔离对 shard 1+ 失效。
 *   真实 run-20260625-110945 数据确认：shard 0 targetUnits 正确，shard 1+ 误存 targetPackages。
 * 修复：unitMode 时写 targetUnits，包级才写 targetPackages。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { WorkflowEngine } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraphFromIndex } from "@workflow/analysis-builder"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let engine: WorkflowEngine
let dir: string
const runId = "test-shard-advance-unit"

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shard-adv-"))
  engine = new WorkflowEngine()
  ;(engine as any).artifactsRoot = dir
  engine.registerDefinition(SQL2JAVA_WORKFLOW)

  const artifactsDir = join(dir, runId)
  mkdirSync(artifactsDir, { recursive: true })
  const index = await scanSource(FIXTURE_TINY)
  buildInventoryFromIndex(artifactsDir, index)
  buildDependencyGraphFromIndex(artifactsDir) // 产出 dependency-graph.json（含 procedureOrder）
}, 60000)

describe("engine.advance 分片推进 — unitMode 字段", () => {
  it("analyze：unitMode shardPlan 推进下一分片时写 targetUnits（非 targetPackages）", () => {
    engine.start("sql2java", runId, { sourcePath: FIXTURE_TINY })
    // inventory → analyze
    let adv = engine.advance(runId, { result: "passed" })
    if (adv.rejected && (adv as any).warningPending) {
      adv = engine.advance(runId, { result: "passed", acceptWarnings: true } as any)
    }
    expect(adv.rejected).toBe(false)
    expect(adv.run.currentPhase).toBe("analyze")

    // 注入 unitMode shardPlan（模拟 dispatch 阶段计算的分片计划）+ shard 0 的 incrementalContext
    const run = engine.status(runId)!
    run.metadata.shardPlan = {
      phase: "analyze",
      unitMode: true,
      shards: [["CORE_PKG.get_item"], ["CORE_PKG.get_item_obj"]],
      completedShards: [],
    }
    const entry = engine.findCurrentEntry(run)!
    entry.incrementalContext = { targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 2 }
    engine.persist(run)

    // 推进 shard 0 → shard 1
    const adv2 = engine.advance(runId, { result: "passed" })
    expect(adv2.rejected).toBe(false)
    expect(adv2.run.currentPhase).toBe("analyze") // 同阶段分片推进，不切阶段

    const run2 = engine.status(runId)!
    const nextEntry = engine.findCurrentEntry(run2)!
    expect(nextEntry.incrementalContext?.shardIndex).toBe(1)
    expect(nextEntry.incrementalContext?.totalShards).toBe(2)
    // ★ 核心断言：unitMode 下用 targetUnits，不是 targetPackages
    expect(nextEntry.incrementalContext?.targetUnits).toEqual(["CORE_PKG.get_item_obj"])
    expect(nextEntry.incrementalContext?.targetPackages).toBeUndefined()
  })

  it("translate：unitMode shardPlan 推进下一分片时写 targetUnits（非 targetPackages）", () => {
    const txRunId = "test-shard-advance-translate"
    // 复制 analyze 测试的产物到 translate run（inventory + analysis）
    const txArtifactsDir = join(dir, txRunId)
    mkdirSync(txArtifactsDir, { recursive: true })
    const srcArtifactsDir = join(dir, runId)
    cpSync(srcArtifactsDir, txArtifactsDir, { recursive: true })

    engine.start("sql2java", txRunId, { sourcePath: FIXTURE_TINY })
    // 推进到 translate（inventory→analyze→plan→scaffold→translate），acceptWarnings 绕过 engine-core 的轻量校验
    const phases = ["inventory", "analyze", "plan", "scaffold"]
    for (const _ of phases) {
      let r = engine.advance(txRunId, { result: "passed" })
      if (r.rejected && (r as any).warningPending) {
        r = engine.advance(txRunId, { result: "passed", acceptWarnings: true } as any)
      }
      if (r.rejected) throw new Error(`Advance rejected: ${r.rejectionReason}`)
    }
    const runAtTranslate = engine.status(txRunId)!
    expect(runAtTranslate.currentPhase).toBe("translate")

    // 注入 unitMode shardPlan + shard 0 的 incrementalContext
    runAtTranslate.metadata.shardPlan = {
      phase: "translate",
      unitMode: true,
      shards: [["CORE_PKG.get_item"], ["CORE_PKG.get_item_obj"]],
      completedShards: [],
    }
    const entry = engine.findCurrentEntry(runAtTranslate)!
    entry.incrementalContext = { targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 2 }
    engine.persist(runAtTranslate)

    // 写 shard 0 的 per-unit translation（G1-unit 要求 status=completed）
    mkdirSync(join(txArtifactsDir, "translations", "CORE_PKG"), { recursive: true })
    writeFileSync(join(txArtifactsDir, "translations", "CORE_PKG", "get_item.json"), JSON.stringify({
      unitRefName: "get_item", packageName: "CORE_PKG", status: "completed",
      completedSubprograms: ["get_item"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "get_item", javaClass: "com.x.ItemAccessIntf", javaMethod: "getItem" }],
    }), "utf-8")

    // 推进 shard 0 → shard 1（G1-unit 校验 + 跨 schema warning 自动接受）
    let adv2 = engine.advance(txRunId, { result: "passed" })
    if (adv2.rejected && (adv2 as any).warningPending) {
      adv2 = engine.advance(txRunId, { result: "passed", acceptWarnings: true } as any)
    }
    expect(adv2.rejected).toBe(false)
    expect(adv2.run.currentPhase).toBe("translate") // 同阶段分片推进

    const run2 = engine.status(txRunId)!
    const nextEntry = engine.findCurrentEntry(run2)!
    expect(nextEntry.incrementalContext?.shardIndex).toBe(1)
    // ★ 核心断言：translate unitMode 下用 targetUnits，不是 targetPackages
    expect(nextEntry.incrementalContext?.targetUnits).toEqual(["CORE_PKG.get_item_obj"])
    expect(nextEntry.incrementalContext?.targetPackages).toBeUndefined()
  })
})
