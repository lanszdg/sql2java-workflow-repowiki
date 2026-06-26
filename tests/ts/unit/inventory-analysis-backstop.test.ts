/**
 * inventory-analysis-backstop.test.ts — inventory advance 缺 analysis.json 时引擎兜底生成
 *
 * 真实执行中 inventory worker 偶发漏调 generateAnalysis → analysis.json 缺失 →
 * validateArtifactOnDisk(inventory) 卡住 advance。修复后引擎在该 gate 兜底调用
 * buildAnalysisFromIndex（零 LLM 确定性），缺失自动生成；生成失败才报错。
 *
 * 注：validateArtifactOnDisk 用插件常量 ARTIFACT_DIR=".workflow-artifacts"（相对 cwd），
 * 无法重定向到 tmpdir，故在 cwd 下用唯一 runId 建临时 artifact 目录，测后清理。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { AnalysisMetaSchema } from "@workflow/artifact-schemas"
import { validateArtifactOnDisk } from "@plugins/workflow-engine"
import type { WorkflowRun } from "@workflow/engine-core"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
// 唯一 runId，避免与其他测试/真实 run 冲突
const RUN_ID = `test-analysis-backstop-${process.pid}`

// validateArtifactOnDisk 读 .workflow-artifacts/{runId}/（cwd 相对，硬编码常量）
const ARTIFACTS_DIR = join(".workflow-artifacts", RUN_ID)

beforeAll(async () => {
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  // 1) prescan → inventory-index.json
  const index = await scanSource(FIXTURE_TINY)
  writeFileSync(join(ARTIFACTS_DIR, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
  // 2) 纯代码生成 inventory-packages + inventory.json（不生成 analysis.json —— 模拟 worker 漏调）
  buildInventoryFromIndex(ARTIFACTS_DIR)
}, 60000)

afterAll(() => {
  try { rmSync(ARTIFACTS_DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
})

function makeRun(phase: string): WorkflowRun {
  return { runId: RUN_ID, currentPhase: phase } as unknown as WorkflowRun
}

describe("inventory analysis.json 缺失兜底", () => {
  it("缺 analysis.json → 引擎兜底生成，validateArtifactOnDisk 返回 null（放行 advance）", () => {
    expect(existsSync(join(ARTIFACTS_DIR, "analysis.json"))).toBe(false)
    const err = validateArtifactOnDisk(makeRun("inventory"))
    expect(err).toBeNull()
    // 兜底生成后 analysis.json 存在且过 Zod
    expect(existsSync(join(ARTIFACTS_DIR, "analysis.json"))).toBe(true)
    const a = JSON.parse(readFileSync(join(ARTIFACTS_DIR, "analysis.json"), "utf-8"))
    expect(AnalysisMetaSchema.safeParse(a).success).toBe(true)
  })

  it("analysis.json 已存在 → 不再报缺失（幂等，第二次校验直接放行）", () => {
    const err = validateArtifactOnDisk(makeRun("inventory"))
    expect(err).toBeNull()
  })

  it("inventory-index.json 损坏 → 兜底生成失败，返回明确错误（不抛错）", () => {
    const tmpRun = `test-analysis-backstop-bad-${process.pid}`
    const tmpDir = join(".workflow-artifacts", tmpRun)
    mkdirSync(tmpDir, { recursive: true })
    // 只写一个损坏的 inventory-index.json + 最小 inventory-packages（让 validateInventoryPackages 通过或前置失败）
    writeFileSync(join(tmpDir, "inventory-index.json"), "{ not valid json", "utf-8")
    writeFileSync(join(tmpDir, "inventory.json"), JSON.stringify({ packageNames: [] }), "utf-8")
    try {
      const err = validateArtifactOnDisk({ runId: tmpRun, currentPhase: "inventory" } as unknown as WorkflowRun)
      // 兜底生成失败应返回错误字符串（而非 null），且不抛异常
      expect(err).not.toBeNull()
      expect(typeof err).toBe("string")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
