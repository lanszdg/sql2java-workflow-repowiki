/**
 * generated-root.test.ts — 跨 run 目标目录撞库检测
 *
 * 验证 resolveGeneratedRoot / claimGeneratedRoot：不同 runId 撞同一 artifactId 时
 * 改用 <artifactId>-<runId> 目录，避免旧 run 产物堆积污染新 run（实测：com.example 与
 * com.icbc 两套基础包名并存于 generated/mfg-erp/，verify 时全归因 GLOBAL）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveGeneratedRoot, claimGeneratedRoot } from "@plugins/workflow-engine"

const MARKER = ".sql2java-run-id"
let repo: string

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "gen-root-")) })
afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

describe("resolveGeneratedRoot / claimGeneratedRoot", () => {
  it("目录不存在 → 返回默认 base；claim 建目录并写本 run 标记", () => {
    const root = claimGeneratedRoot("run-A", "mfg-erp", repo)
    expect(root).toBe(join(repo, "generated", "mfg-erp"))
    expect(existsSync(join(root, MARKER))).toBe(true)
    expect(readFileSync(join(root, MARKER), "utf-8")).toBe("run-A")
  })

  it("同 runId resume → 复用 base，不换目录不覆盖标记", () => {
    claimGeneratedRoot("run-A", "mfg-erp", repo)
    const root = resolveGeneratedRoot("run-A", "mfg-erp", repo)
    expect(root).toBe(join(repo, "generated", "mfg-erp"))
    // claim 再次调用不覆盖
    claimGeneratedRoot("run-A", "mfg-erp", repo)
    expect(readFileSync(join(repo, "generated", "mfg-erp", MARKER), "utf-8")).toBe("run-A")
  })

  it("不同 runId 撞同一 artifactId → 改用 <artifactId>-<runId>，旧目录不动", () => {
    claimGeneratedRoot("run-A", "mfg-erp", repo)
    const rootB = resolveGeneratedRoot("run-B", "mfg-erp", repo)
    expect(rootB).toBe(join(repo, "generated", "mfg-erp-run-B"))
    const claimedB = claimGeneratedRoot("run-B", "mfg-erp", repo)
    expect(claimedB).toBe(join(repo, "generated", "mfg-erp-run-B"))
    expect(readFileSync(join(claimedB, MARKER), "utf-8")).toBe("run-B")
    // run-A 目录与标记未被破坏
    expect(readFileSync(join(repo, "generated", "mfg-erp", MARKER), "utf-8")).toBe("run-A")
  })

  it("无标记的遗留目录（旧 run 残留）→ 视为他 run 占用，换目录", () => {
    const legacy = join(repo, "generated", "mfg-erp")
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "stale.java"), "old com.example leftover", "utf-8")
    const root = resolveGeneratedRoot("run-A", "mfg-erp", repo)
    expect(root).toBe(join(repo, "generated", "mfg-erp-run-A"))
    // 遗留文件原样保留（不删除、不污染）
    expect(existsSync(join(legacy, "stale.java"))).toBe(true)
  })
})
