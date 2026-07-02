/**
 * inventory-zero-llm.test.ts — 验证 inventory 阶段代码生成的核心接线
 *
 * inventory 由 sql-analyst agent 调 `generateInventory` action（内部跑 buildInventoryFromIndex）
 * 生成产物，编排者再调 advance 推进。本测试在 engine-core 层复刻该代码路径：
 * prescan → buildInventoryFromIndex（= generateInventory 内部）→ engine.start →
 * engine.advance(inventory→analyze)，确认产物过 schema、advance 无需 Worker 即可推进。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { WorkflowEngine } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { PackageArtifactSchema, InventorySchema } from "@workflow/artifact-schemas"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let engine: WorkflowEngine
let dir: string
const runId = "test-inv-zero-llm"

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "inv-zero-llm-"))
  engine = new WorkflowEngine()
  ;(engine as any).artifactsRoot = dir
  engine.registerDefinition(SQL2JAVA_WORKFLOW)

  // 1) prescan → 写 inventory-index.json
  const artifactsDir = join(dir, runId)
  mkdirSync(artifactsDir, { recursive: true })
  const index = await scanSource(FIXTURE_TINY)
  writeFileSync(join(artifactsDir, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")

  // 2) 纯代码生成 inventory-packages + inventory.json
  buildInventoryFromIndex(artifactsDir)
}, 60000)

afterAll(() => { try { /* OS 清理 tmpdir */ } catch {} })

describe("inventory 零 LLM 接线", () => {
  it("prescan + builder 产出的 inventory 产物通过 schema 校验", () => {
    const artifactsDir = join(dir, runId)
    const inv = JSON.parse(readFileSync(join(artifactsDir, "inventory.json"), "utf-8"))
    expect(InventorySchema.safeParse(inv).success).toBe(true)
    for (const f of ["BASE_PKG", "CORE_PKG"]) {
      const pkg = JSON.parse(readFileSync(join(artifactsDir, "packages", `${f}.json`), "utf-8"))
      expect(PackageArtifactSchema.safeParse(pkg).success, `${f} 校验失败`).toBe(true)
    }
  })

  it("engine.start 后 currentPhase = inventory", () => {
    engine.start("sql2java", runId, { sourcePath: FIXTURE_TINY })
    const run = engine.status(runId)!
    expect(run.currentPhase).toBe("inventory")
  })

  it("engine.advance 无需 Worker 即可推进 inventory → analyze", () => {
    const adv = engine.advance(runId, { result: "passed" })
    expect(adv.rejected).toBe(false)
    expect(adv.run.currentPhase).toBe("analyze")
  })

  it("analyze 阶段能读到 inventory 产物（下游可消费）", () => {
    const artifactsDir = join(dir, runId)
    expect(existsSync(join(artifactsDir, "inventory.json"))).toBe(true)
    expect(existsSync(join(artifactsDir, "packages", "CORE_PKG.json"))).toBe(true)
    const run = engine.status(runId)!
    expect(run.currentPhase).toBe("analyze")
  })
})
