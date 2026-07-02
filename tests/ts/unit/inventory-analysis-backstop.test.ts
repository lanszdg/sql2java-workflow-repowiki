/**
 * inventory-analysis-backstop.test.ts — inventory advance 缺 reduce 时引擎兜底生成
 *
 * 真实执行中 inventory worker 偶发漏调 generateDependencyGraph → complexity 未写 / 无子程序包
 * analysis-packages 缺失 → validateArtifactOnDisk(inventory) 兜底调用 buildDependencyGraphFromIndex
 *（零 LLM 确定性）：complexity 写入 packages/{PKG}.json + 无子程序包空 analysis-packages。
 *
 * 注：validateArtifactOnDisk 用插件常量 ARTIFACT_DIR=".workflow-artifacts"（相对 cwd），
 * 无法重定向到 tmpdir，故在 cwd 下用唯一 runId 建临时 artifact 目录，测后清理。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
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
  // 2) 纯代码生成 packages/+subprograms/+tables/+inventory.json（不调 generateDependencyGraph —— 模拟 worker 漏调）
  buildInventoryFromIndex(ARTIFACTS_DIR)
}, 60000)

afterAll(() => {
  try { rmSync(ARTIFACTS_DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
})

function makeRun(phase: string): WorkflowRun {
  return { runId: RUN_ID, currentPhase: phase } as unknown as WorkflowRun
}

describe("inventory reduce 缺失兜底", () => {
  it("缺 reduce → 引擎兜底：complexity 写入 packages + 空包 analysis-packages，validateArtifactOnDisk 返回 null", () => {
    // 兜底前：packages/CORE_PKG.json 无 complexity；analysis-packages/BASE_PKG.json 不存在
    const coreBefore = JSON.parse(readFileSync(join(ARTIFACTS_DIR, "packages", "CORE_PKG.json"), "utf-8"))
    expect(coreBefore.complexity).toBeUndefined()
    expect(existsSync(join(ARTIFACTS_DIR, "analysis-packages", "BASE_PKG.json"))).toBe(false)

    const err = validateArtifactOnDisk(makeRun("inventory"))
    expect(err).toBeNull()

    // 兜底后：complexity 已写入；无子程序包 BASE_PKG 空聚合已生成
    const coreAfter = JSON.parse(readFileSync(join(ARTIFACTS_DIR, "packages", "CORE_PKG.json"), "utf-8"))
    expect(coreAfter.complexity).toBeDefined()
    expect(coreAfter.complexity.riskLevel).toBe("high")
    const base = JSON.parse(readFileSync(join(ARTIFACTS_DIR, "analysis-packages", "BASE_PKG.json"), "utf-8"))
    expect(base).toEqual({ packageName: "BASE_PKG", subprograms: [] })
  })

  it("reduce 已生成 → 幂等，第二次校验直接放行", () => {
    const err = validateArtifactOnDisk(makeRun("inventory"))
    expect(err).toBeNull()
  })

  it("inventory.json 缺失 → validateArtifactOnDisk 返回明确错误（不抛错）", () => {
    const tmpRun = `test-analysis-backstop-bad-${process.pid}`
    const tmpDir = join(".workflow-artifacts", tmpRun)
    mkdirSync(tmpDir, { recursive: true })
    // 不写 inventory.json（validateInventoryPackages 第一步即失败）
    try {
      const err = validateArtifactOnDisk({ runId: tmpRun, currentPhase: "inventory" } as unknown as WorkflowRun)
      expect(err).not.toBeNull()
      expect(typeof err).toBe("string")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
