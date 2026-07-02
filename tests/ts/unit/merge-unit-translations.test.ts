/**
 * merge-unit-translations.test.ts — translate PROCEDURE 级 per-unit → 聚合 translation.json 合并测试
 *
 * 验证：mergeUnitTranslations 读 translations/{pkg}/*.json（排除 translation.json），合并出聚合
 * translation.json（subprogramMethods 去重、units rollup、status 按 procedureOrder 期望单元判定）。
 *
 * 新形状：procedureOrder 由 buildDependencyGraph 从 subprograms.directCalls 按需推导；
 * totalSubprograms 取 subprograms/{pkg}.*.json 数量（parseInventoryPackage）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mergeUnitTranslations } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "merge-unit-"))
})

interface Sub { name: string; type: "PROCEDURE" | "FUNCTION"; directCalls?: Array<{ package: string; name: string; line: number; kind: "function" | "procedure" }> }

/** 写 packages/{pkg}.json + subprograms/{pkg}.{name}.json */
function writePkgSubs(art: string, pkg: string, subs: Sub[]) {
  mkdirSync(join(art, "packages"), { recursive: true })
  mkdirSync(join(art, "subprograms"), { recursive: true })
  const procedures = subs.filter(s => s.type === "PROCEDURE").map(s => s.name)
  const functions = subs.filter(s => s.type === "FUNCTION").map(s => s.name)
  writeFileSync(join(art, "packages", `${pkg}.json`), JSON.stringify({
    packageName: pkg, absolutePaths: [], headerPath: null, bodyPath: null,
    constants: [], variables: [], exceptions: [], types: [], functions, procedures, estimatedLoc: 0,
  }), "utf-8")
  for (const s of subs) {
    writeFileSync(join(art, "subprograms", `${pkg}.${s.name}.json`), JSON.stringify({
      name: s.name, type: s.type, belongToPackage: pkg, overloadIndex: null, isPrivate: false,
      headerLocation: null, bodyLocation: { absolutePath: `${pkg}.sql`, lineRange: [1, 1] },
      parameters: [], returnType: s.type === "FUNCTION" ? "VARCHAR2" : null, loc: 1,
      directCalls: s.directCalls ?? [],
    }), "utf-8")
  }
}

describe("mergeUnitTranslations", () => {
  it("合并多 unit 的 subprogramMethods + units rollup", () => {
    const art = join(dir, "a")
    const pkgDir = join(art, "translations", "PKG_A")
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(art, { recursive: true })
    // p1 调 f1（FUNCTION）→ f1 归属 p1，procedureOrder 的 PKG_A unit = {p1, p2}（f1 折叠）
    writePkgSubs(art, "PKG_A", [
      { name: "p1", type: "PROCEDURE", directCalls: [{ package: "PKG_A", name: "f1", line: 1, kind: "function" }] },
      { name: "p2", type: "PROCEDURE" },
      { name: "f1", type: "FUNCTION" },
    ])
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
    expect(agg.totalSubprograms).toBe(3) // subprograms 文件数（p1/p2/f1）
  })

  it("缺 unit → status=partial", () => {
    const art = join(dir, "b")
    const pkgDir = join(art, "translations", "PKG_B")
    mkdirSync(pkgDir, { recursive: true })
    mkdirSync(art, { recursive: true })
    writePkgSubs(art, "PKG_B", [
      { name: "p1", type: "PROCEDURE" },
      { name: "p2", type: "PROCEDURE" },
    ])
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
    writePkgSubs(art, "PKG_C", [{ name: "p1", type: "PROCEDURE" }])
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
    // PKG_X 有 unit（使 procedureOrder 非空）；PKG_NONE 无任何 subprogram → 空包
    writePkgSubs(art, "PKG_X", [{ name: "p1", type: "PROCEDURE" }])
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
    writePkgSubs(art, "PKG_E", [{ name: "p1", type: "PROCEDURE" }])
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
