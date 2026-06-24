/**
 * merge-unit-translations.test.ts — translate PROCEDURE 级 per-unit → 聚合 translation.json 合并测试
 *
 * 验证：mergeUnitTranslations 读 translations/{pkg}/*.json（排除 translation.json），合并出聚合
 * translation.json（subprogramMethods 去重、units rollup、status 按 procedureOrder 期望单元判定）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mergeUnitTranslations } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "merge-unit-"))
})

describe("mergeUnitTranslations", () => {
  it("合并多 unit 的 subprogramMethods + units rollup", () => {
    const art = join(dir, "a")
    const pkgDir = join(art, "translations", "PKG_A")
    mkdirSync(pkgDir, { recursive: true })
    // analysis.json：procedureOrder 含 PKG_A 的两个 unit
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.p1"], ["PKG_A.p2"]],
      functionOwnership: {},
    }), "utf-8")
    // inventory-packages/PKG_A.json：3 个子程序（含一个 cargo func）
    mkdirSync(join(art, "inventory-packages"), { recursive: true }); writeFileSync(join(art, "inventory-packages", "PKG_A.json"), JSON.stringify({
      packageName: "PKG_A",
      procedures: [
        { name: "p1", type: "procedure" },
        { name: "p2", type: "procedure" },
        { name: "f1", type: "function" },
      ],
    }) , "utf-8")
    // per-unit 文件
    writeFileSync(join(pkgDir, "p1.json"), JSON.stringify({
      unitRefName: "p1", packageName: "PKG_A", status: "completed",
      completedSubprograms: ["p1"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "p1", javaClass: "com.x.AService", javaMethod: "p1" }],
    }), "utf-8")
    writeFileSync(join(pkgDir, "p2.json"), JSON.stringify({
      unitRefName: "p2", packageName: "PKG_A", status: "completed",
      completedSubprograms: ["p2"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "p2", javaClass: "com.x.AService", javaMethod: "p2" }],
    }), "utf-8")

    const err = mergeUnitTranslations(art, "PKG_A")
    expect(err).toBeNull()
    const agg = JSON.parse(readFileSync(join(pkgDir, "translation.json"), "utf-8"))
    expect(agg.packageName).toBe("PKG_A")
    expect(agg.status).toBe("completed")
    expect(agg.units.map((u: any) => u.refName).sort()).toEqual(["p1", "p2"])
    expect(agg.completedSubprograms.sort()).toEqual(["p1", "p2"])
    expect(agg.subprogramMethods.map((m: any) => m.oracleName).sort()).toEqual(["p1", "p2"])
    expect(agg.totalSubprograms).toBe(3) // inventory-packages procedures 数
  })

  it("缺 unit → status=partial", () => {
    const art = join(dir, "b")
    const pkgDir = join(art, "translations", "PKG_B")
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_B.p1"], ["PKG_B.p2"]],
      functionOwnership: {},
    }), "utf-8")
    mkdirSync(join(art, "inventory-packages"), { recursive: true }); writeFileSync(join(art, "inventory-packages", "PKG_B.json"), JSON.stringify({
      packageName: "PKG_B", procedures: [{ name: "p1", type: "procedure" }, { name: "p2", type: "procedure" }],
    }), "utf-8")
    // 只写了 p1，p2 缺失
    writeFileSync(join(pkgDir, "p1.json"), JSON.stringify({
      unitRefName: "p1", packageName: "PKG_B", status: "completed",
      completedSubprograms: ["p1"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "p1", javaClass: "com.x.BService", javaMethod: "p1" }],
    }), "utf-8")

    const err = mergeUnitTranslations(art, "PKG_B")
    expect(err).toBeNull()
    const agg = JSON.parse(readFileSync(join(pkgDir, "translation.json"), "utf-8"))
    expect(agg.status).toBe("partial")
    expect(agg.subprogramMethods.map((m: any) => m.oracleName)).toEqual(["p1"])
  })

  it("per-unit 文件 Zod 校验失败 → 返回错误", () => {
    const art = join(dir, "c")
    const pkgDir = join(art, "translations", "PKG_C")
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({ procedureOrder: [["PKG_C.p1"]] }), "utf-8")
    // 缺 unitRefName（必填）→ Zod 失败
    writeFileSync(join(pkgDir, "p1.json"), JSON.stringify({
      packageName: "PKG_C", status: "completed",
    }), "utf-8")
    const err = mergeUnitTranslations(art, "PKG_C")
    expect(err).toBeTruthy()
    expect(err).toContain("Zod validation failed")
  })

  it("空包（procedureOrder 无其 unit）→ 写 completed 空 stub（保证下游可读）", () => {
    const art = join(dir, "d")
    mkdirSync(art, { recursive: true })
    // analysis.json 有 procedureOrder 但不含 PKG_NONE 的 unit（空包）
    writeFileSync(join(art, "analysis.json"), JSON.stringify({ procedureOrder: [["PKG_X.p1"]] }), "utf-8")
    expect(mergeUnitTranslations(art, "PKG_NONE")).toBeNull()
    const agg = JSON.parse(readFileSync(join(art, "translations", "PKG_NONE", "translation.json"), "utf-8"))
    expect(agg.status).toBe("completed")
    expect(agg.totalSubprograms).toBe(0)
    expect(agg.subprogramMethods).toEqual([])
  })

  it("非单元产物（review.json/verify.json）被白名单排除，不误当 per-unit 解析", () => {
    const art = join(dir, "e")
    const pkgDir = join(art, "translations", "PKG_E")
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({ procedureOrder: [["PKG_E.p1"]] }), "utf-8")
    // 合法 per-unit 文件
    writeFileSync(join(pkgDir, "p1.json"), JSON.stringify({
      unitRefName: "p1", packageName: "PKG_E", status: "completed",
      completedSubprograms: ["p1"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "p1", javaClass: "com.x.EService", javaMethod: "p1" }],
    }), "utf-8")
    // 同目录的 review.json（fix 阶段会存在）——形状是 ReviewSchema，非 UnitTranslationSchema
    writeFileSync(join(pkgDir, "review.json"), JSON.stringify({
      packageName: "PKG_E", passed: true, mustFix: [], score: 8,
    }), "utf-8")
    // review.json 不在期望 unit 集合（{p1}）→ 被排除，不触发 Zod 失败
    const err = mergeUnitTranslations(art, "PKG_E")
    expect(err).toBeNull()
    const agg = JSON.parse(readFileSync(join(pkgDir, "translation.json"), "utf-8"))
    expect(agg.status).toBe("completed")
    expect(agg.subprogramMethods.map((m: any) => m.oracleName)).toEqual(["p1"])
  })
})
