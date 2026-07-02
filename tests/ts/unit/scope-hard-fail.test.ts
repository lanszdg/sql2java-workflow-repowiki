/**
 * scope-hard-fail.test.ts — 过程级 mainEntry 不可解析时硬失败回归（P2-1）
 *
 * 修复前：ensureRunScope 对坏 mainEntry（拼写错/包不存在/子程序不存在/subdir 不匹配）仅 warn
 * 后返回 null → scope 不激活 → 静默回退**全项目**翻译，用户意图被吞。
 * 修复后：inventory advance 校验时 ensureRunScope 返回 {ok:false} → validateArtifactOnDisk
 * 返回明确错误字符串 → advance 被拒，用户收到提示。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraphFromIndex } from "@workflow/analysis-builder"
import { validateArtifactOnDisk } from "@plugins/workflow-engine"
import type { WorkflowRun } from "@workflow/engine-core"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
const RUN_ID = `test-scope-hardfail-${process.pid}`
const ARTIFACTS_DIR = join(".workflow-artifacts", RUN_ID)

beforeAll(async () => {
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const index = await scanSource(FIXTURE_TINY)
  writeFileSync(join(ARTIFACTS_DIR, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
  buildInventoryFromIndex(ARTIFACTS_DIR)
  buildDependencyGraphFromIndex(ARTIFACTS_DIR) // inventory advance 校验前 complexity/兜底须就绪
}, 60000)

afterAll(() => {
  try { rmSync(ARTIFACTS_DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
})

function makeRun(mainEntry: string | undefined): WorkflowRun {
  return {
    runId: RUN_ID,
    currentPhase: "inventory",
    metadata: mainEntry === undefined ? {} : { mainEntry },
  } as unknown as WorkflowRun
}

describe("过程级 mainEntry 不可解析 → 硬失败（P2-1）", () => {
  it("包不存在 → validateArtifactOnDisk 返回错误（不静默放行）", () => {
    const err = validateArtifactOnDisk(makeRun("MISSING_PKG.no_such_proc"))
    expect(err).not.toBeNull()
    expect(typeof err).toBe("string")
    expect(err).toMatch(/mainEntry 校验失败/)
    expect(err).toMatch(/不在 inventory|不匹配|不在包/)
  })

  it("子程序不存在 → 返回错误", () => {
    // CORE_PKG 存在于 tiny fixture，但 no_such_proc 不是其子程序
    const err = validateArtifactOnDisk(makeRun("CORE_PKG.no_such_proc"))
    expect(err).not.toBeNull()
    expect(err).toMatch(/mainEntry 校验失败/)
  })

  it("无 mainEntry → 返回 null（全量翻译，合法）", () => {
    const err = validateArtifactOnDisk(makeRun(undefined))
    expect(err).toBeNull()
  })

  it("纯包名 mainEntry（非过程级）→ 返回 null（旧门面包语义，全量）", () => {
    const err = validateArtifactOnDisk(makeRun("CORE_PKG"))
    expect(err).toBeNull()
  })
})
