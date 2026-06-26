/**
 * build-sharded-worker-order.test.ts — analyze/translate worker workOrder 端到端渲染
 *
 * 用真实 fixture（tiny）生成 inventory + analysis，构造 unitMode 分片 run，调用
 * buildShardedWorkerOrder 验证 .md 模板渲染产物含分片硬约束 + targetUnits + 切片目录 +
 * 上游 + 无残留占位符，且落盘 dispatch-logs/。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildAnalysisFromIndex } from "@workflow/analysis-builder"
import { buildShardedWorkerOrder } from "@plugins/workflow-engine"
import type { WorkflowRun } from "@workflow/engine-core"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sharded-wo-"))
}, 60000)

function makeRun(runId: string, phase: string, ic: Record<string, unknown>): WorkflowRun {
  return {
    runId,
    currentPhase: phase,
    status: "running",
    phaseHistory: [{ phase, status: "in_progress", startedAt: "t", retryCount: 0, incrementalContext: ic }],
    metadata: { sourcePath: FIXTURE_TINY },
    createdAt: "t",
    updatedAt: "t",
  } as unknown as WorkflowRun
}

describe("buildShardedWorkerOrder — analyze", () => {
  let art: string
  beforeAll(async () => {
    const runId = "test-wo-analyze"
    art = join(dir, runId)
    mkdirSync(art, { recursive: true })
    const index = await scanSource(FIXTURE_TINY)
    writeFileSync(join(art, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
    buildInventoryFromIndex(art)
    buildAnalysisFromIndex(art) // 产出 analysis.json（含 procedureOrder/functionOwnership）
  }, 60000)

  it("渲染 analyze shard 0 workOrder：含分片硬约束 + targetUnits + 切片目录 + 落盘", () => {
    const runId = "test-wo-analyze"
    const run = makeRun(runId, "analyze", {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 13,
    })
    const currentEntry = (run as any).phaseHistory[0]
    const wo = buildShardedWorkerOrder(run, currentEntry, art, null)

    // 分片硬约束 + targetUnits
    expect(wo).toContain("分片范围硬约束")
    expect(wo).toContain("CORE_PKG.get_item")
    expect(wo).toContain("分片 1/13")
    // 切片目录（generateUnitSlices 已落盘 + scopeBlock 引用）
    expect(wo).toContain("shard-inputs/CORE_PKG/get_item/")
    expect(existsSync(join(art, "shard-inputs", "CORE_PKG", "get_item", "source.sql"))).toBe(true)
    // 上游 artifact
    expect(wo).toContain("inventory.json")
    // 无残留占位符
    expect(wo).not.toContain("{{")
    // 落盘 dispatch-logs
    expect(existsSync(join(art, "dispatch-logs", "analyze-shard0.workOrder.md"))).toBe(true)
    expect(readFileSync(join(art, "dispatch-logs", "analyze-shard0.workOrder.md"), "utf-8")).toBe(wo)
    // analyze 在 plan 之前，无 projectRoot
    expect(wo).not.toContain("projectRoot")
  })
})

describe("buildShardedWorkerOrder — translate", () => {
  let art: string
  beforeAll(async () => {
    const runId = "test-wo-translate"
    art = join(dir, runId)
    mkdirSync(art, { recursive: true })
    const index = await scanSource(FIXTURE_TINY)
    writeFileSync(join(art, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
    buildInventoryFromIndex(art)
    buildAnalysisFromIndex(art)
    // translate 在 plan 之后，需 plan.json（给 projectRoot）+ analysis-packages 聚合（analysis-slice）
    writeFileSync(join(art, "plan.json"), JSON.stringify({
      targetProject: { artifactId: "testapp" }, projectRoot: "/tmp/gen/testapp",
    }), "utf-8")
    // analysis-packages 聚合（buildAnalysisFromIndex 已为无子程序包写空文件；CORE_PKG 有子程序需聚合）
    // buildAnalysisFromIndex 不写有子程序包的聚合——由 analyze 阶段产。这里手写一个最小聚合供 analysis-slice。
    mkdirSync(join(art, "analysis-packages"), { recursive: true })
    writeFileSync(join(art, "analysis-packages", "CORE_PKG.json"), JSON.stringify({
      packageName: "CORE_PKG",
      subprograms: [{ name: "get_item", blocks: [], variables: [], cursors: [], exceptionHandlers: [], translationNotes: [] }],
    }), "utf-8")
  }, 60000)

  it("渲染 translate shard workOrder：含依赖签名块 + projectRoot + analysis-slice", () => {
    const runId = "test-wo-translate"
    const run = makeRun(runId, "translate", {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 13,
    })
    const currentEntry = (run as any).phaseHistory[0]
    const wo = buildShardedWorkerOrder(run, currentEntry, art, null)

    expect(wo).toContain("translate Worker 任务")
    expect(wo).toContain("分片范围硬约束")
    expect(wo).toContain("CORE_PKG.get_item")
    // translate 有 projectRoot（plan 之后）
    expect(wo).toContain("projectRoot")
    // analysis-slice.json 引用
    expect(wo).toContain("analysis-slice.json")
    expect(existsSync(join(art, "shard-inputs", "CORE_PKG", "get_item", "analysis-slice.json"))).toBe(true)
    // 无残留占位符
    expect(wo).not.toContain("{{")
    // 落盘
    expect(existsSync(join(art, "dispatch-logs", "translate-shard0.workOrder.md"))).toBe(true)
  })
})
