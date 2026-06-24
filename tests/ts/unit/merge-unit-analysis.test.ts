/**
 * merge-unit-analysis.test.ts — analyze PROCEDURE 级 per-unit → 聚合 analysis-packages/{pkg}.json 合并测试
 *
 * 验证：mergeUnitAnalysis 读 analysis-packages/{pkg}/*.json（白名单按 procedureOrder 本包 unit），
 * 合并出聚合 analysis-packages/{pkg}.json（{packageName, subprograms}，兼容 AnalysisPackageSchema）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mergeUnitAnalysis } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "merge-analysis-"))
})

const sub = (name: string) => ({
  name, blocks: [], variables: [], cursors: [], exceptionHandlers: [], translationNotes: [],
})

describe("mergeUnitAnalysis", () => {
  it("合并多 unit 的 subprograms 到聚合 analysis-packages/{pkg}.json", () => {
    const art = join(dir, "a")
    const pkgSub = join(art, "analysis-packages", "PKG_A")
    mkdirSync(pkgSub, { recursive: true })
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.p1"], ["PKG_A.p2"]],
      functionOwnership: { "PKG_A.f1": "PKG_A.p1" },
    }), "utf-8")
    // p1 含根 p1 + cargo FUNCTION f1
    writeFileSync(join(pkgSub, "p1.json"), JSON.stringify({
      unitRefName: "p1", packageName: "PKG_A", subprograms: [sub("p1"), sub("f1")],
    }), "utf-8")
    writeFileSync(join(pkgSub, "p2.json"), JSON.stringify({
      unitRefName: "p2", packageName: "PKG_A", subprograms: [sub("p2")],
    }), "utf-8")

    const err = mergeUnitAnalysis(art, "PKG_A")
    expect(err).toBeNull()
    const agg = JSON.parse(readFileSync(join(art, "analysis-packages", "PKG_A.json"), "utf-8"))
    expect(agg.packageName).toBe("PKG_A")
    expect(agg.subprograms.map((s: any) => s.name).sort()).toEqual(["f1", "p1", "p2"])
  })

  it("单 unit 也能正常聚合", () => {
    const art = join(dir, "b")
    const pkgSub = join(art, "analysis-packages", "PKG_B")
    mkdirSync(pkgSub, { recursive: true })
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_B.p1"]], functionOwnership: {},
    }), "utf-8")
    writeFileSync(join(pkgSub, "p1.json"), JSON.stringify({
      unitRefName: "p1", packageName: "PKG_B", subprograms: [sub("p1")],
    }), "utf-8")

    expect(mergeUnitAnalysis(art, "PKG_B")).toBeNull()
    const agg = JSON.parse(readFileSync(join(art, "analysis-packages", "PKG_B.json"), "utf-8"))
    expect(agg.subprograms.map((s: any) => s.name)).toEqual(["p1"])
  })

  it("per-unit 文件 Zod 校验失败 → 返回错误", () => {
    const art = join(dir, "c")
    const pkgSub = join(art, "analysis-packages", "PKG_C")
    mkdirSync(pkgSub, { recursive: true })
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({ procedureOrder: [["PKG_C.p1"]] }), "utf-8")
    // 缺 unitRefName（必填）→ Zod 失败
    writeFileSync(join(pkgSub, "p1.json"), JSON.stringify({
      packageName: "PKG_C", subprograms: [sub("p1")],
    }), "utf-8")
    const err = mergeUnitAnalysis(art, "PKG_C")
    expect(err).toBeTruthy()
    expect(err).toContain("Zod validation failed")
  })

  it("白名单排除非期望 unit 的杂散文件", () => {
    const art = join(dir, "d")
    const pkgSub = join(art, "analysis-packages", "PKG_D")
    mkdirSync(pkgSub, { recursive: true })
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({ procedureOrder: [["PKG_D.p1"]] }), "utf-8")
    writeFileSync(join(pkgSub, "p1.json"), JSON.stringify({
      unitRefName: "p1", packageName: "PKG_D", subprograms: [sub("p1")],
    }), "utf-8")
    // 杂散文件（不在期望 unit 集合 {p1}）→ 排除，不触发 Zod 失败
    writeFileSync(join(pkgSub, "stray.json"), JSON.stringify({ bogus: true }), "utf-8")
    const err = mergeUnitAnalysis(art, "PKG_D")
    expect(err).toBeNull()
    const agg = JSON.parse(readFileSync(join(art, "analysis-packages", "PKG_D.json"), "utf-8"))
    expect(agg.subprograms.map((s: any) => s.name)).toEqual(["p1"])
  })

  it("空包（procedureOrder 无其 unit，子目录不存在）→ 返回 null 不抛错", () => {
    const art = join(dir, "e")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({ procedureOrder: [["PKG_X.p1"]] }), "utf-8")
    // PKG_NONE 无 unit，子目录不存在；聚合空文件由 analysis-builder 预写（此处不模拟）
    expect(mergeUnitAnalysis(art, "PKG_NONE")).toBeNull()
  })
})
