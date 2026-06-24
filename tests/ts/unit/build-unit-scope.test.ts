/**
 * build-unit-scope.test.ts — 分片「单元读取清单」生成测试
 *
 * 验证 buildUnitScopeBlock 按 inventory-packages lineRange + analysis.functionOwnership/callGraph
 * 为每个 targetUnit 输出精准的 sed -n 源码片段 + cargo FUNCTION + FSD/依赖路径。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildUnitScopeBlock } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unit-scope-"))
})

function writeInvPkg(art: string, pkg: string, bodyFile: string, procs: Array<{ name: string; lineRange: [number, number] }>) {
  mkdirSync(join(art, "inventory-packages"), { recursive: true })
  writeFileSync(join(art, "inventory-packages", `${pkg}.json`), JSON.stringify({
    packageName: pkg, bodyFile, procedures: procs,
  }), "utf-8")
}

describe("buildUnitScopeBlock", () => {
  it("analyze：根 + cargo FUNCTION 的 sed -n 片段 + 输出路径", () => {
    const art = join(dir, "a")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.proc1"]],
      functionOwnership: { "PKG_A.calc_total": "PKG_A.proc1" },
      callGraph: {},
    }), "utf-8")
    writeInvPkg(art, "PKG_A", "/src/PKG_A_BODY.sql", [
      { name: "proc1", lineRange: [10, 20] },
      { name: "calc_total", lineRange: [30, 40] },
    ])

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "analyze", [])
    expect(out).toContain("PKG_A.proc1")
    expect(out).toContain("sed -n '10,20p' '/src/PKG_A_BODY.sql'")
    expect(out).toContain("cargo FUNCTION calc_total")
    expect(out).toContain("sed -n '30,40p' '/src/PKG_A_BODY.sql'")
    expect(out).toContain("analysis-packages/PKG_A/proc1.json")
    expect(out).toContain("fsd/PKG_A/proc1.md")
    // cargo FUNCTION FSD 精确枚举（用 func 所属包，与 validator 一致）
    expect(out).toContain("fsd/PKG_A/calc_total.md")
    expect(out).not.toContain("{cargoRef}")
    // analyze 不应出现 translate 专属的 FSD 输入/依赖 translation
    expect(out).not.toContain("FSD 输入")
  })

  it("重载子程序：refName __序号 与 inventory 顺序对齐", () => {
    const art = join(dir, "b")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.get__1"], ["PKG_A.get__2"]],
      functionOwnership: {},
      callGraph: {},
    }), "utf-8")
    writeInvPkg(art, "PKG_A", "/src/PKG_A_BODY.sql", [
      { name: "get", lineRange: [1, 5] },
      { name: "get", lineRange: [6, 10] },
    ])

    const out1 = buildUnitScopeBlock(art, ["PKG_A.get__1"], "analyze", [])
    expect(out1).toContain("sed -n '1,5p'")
    expect(out1).not.toContain("sed -n '6,10p'")
    const out2 = buildUnitScopeBlock(art, ["PKG_A.get__2"], "analyze", [])
    expect(out2).toContain("sed -n '6,10p'")
  })

  it("translate：FSD 输入 + 已完成跨包依赖聚合 translation", () => {
    const art = join(dir, "c")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_B.other"], ["PKG_A.proc1"]],
      functionOwnership: {},
      callGraph: { "PKG_A.proc1": ["PKG_B.other"] },
    }), "utf-8")
    writeInvPkg(art, "PKG_A", "/src/PKG_A_BODY.sql", [{ name: "proc1", lineRange: [10, 20] }])
    writeInvPkg(art, "PKG_B", "/src/PKG_B_BODY.sql", [{ name: "other", lineRange: [5, 9] }])

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "translate", ["PKG_B.other"])
    expect(out).toContain("FSD 输入")
    expect(out).toContain("fsd/PKG_A/proc1.md")
    expect(out).toContain("translations/PKG_B/translation.json")
    // 同包聚合也列出（同包跨单元调用对接）
    expect(out).toContain("translations/PKG_A/translation.json")
    expect(out).toContain("sed -n '10,20p'")
  })

  it("translate：未完成的跨包依赖不进清单（仅已完成的）", () => {
    const art = join(dir, "d")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.proc1"]],
      functionOwnership: {},
      callGraph: { "PKG_A.proc1": ["PKG_C.unfinished"] },
    }), "utf-8")
    writeInvPkg(art, "PKG_A", "/src/PKG_A_BODY.sql", [{ name: "proc1", lineRange: [10, 20] }])

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "translate", []) // PKG_C 未完成
    expect(out).not.toContain("translations/PKG_C/translation.json")
    expect(out).toContain("translations/PKG_A/translation.json") // 本包聚合仍列
  })

  it("非 unit 阶段 / 空 targetUnits → 返回空串", () => {
    const art = join(dir, "e")
    mkdirSync(art, { recursive: true })
    expect(buildUnitScopeBlock(art, [], "analyze", [])).toBe("")
    expect(buildUnitScopeBlock(art, ["PKG_A.p1"], "review", [])).toBe("")
  })

  it("translate：跨包依赖匹配大小写不敏感（completedUnitIds 与 callGraph 大小写不一致仍命中）", () => {
    const art = join(dir, "f")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.proc1"]],
      functionOwnership: {},
      callGraph: { "PKG_A.proc1": ["PKG_B.other"] }, // callGraph 用大写 PKG_B
    }), "utf-8")
    writeInvPkg(art, "PKG_A", "/src/PKG_A_BODY.sql", [{ name: "proc1", lineRange: [10, 20] }])

    // completedUnitIds 用小写 pkg_b（模拟 scanner 大小写变体）——大小写不敏感应仍命中
    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "translate", ["pkg_b.other"])
    expect(out).toContain("translations/PKG_B/translation.json")
  })

  it("相对 bodyFile + sourcePath → sed 用绝对路径（消除 worker cwd 依赖）", () => {
    const art = join(dir, "g")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.proc1"]],
      functionOwnership: {},
      callGraph: {},
    }), "utf-8")
    // inventory-packages 的 bodyFile 是相对 sourcePath 的路径（scanner 实际产出形态）
    writeInvPkg(art, "PKG_A", "subdir/PKG_A_BODY.sql", [{ name: "proc1", lineRange: [10, 20] }])

    const sourcePath = "/proj/plsql-src"
    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "analyze", [], sourcePath)
    // sed 命令须用绝对路径，否则 worker subagent（cwd=项目根 ≠ sourcePath）找不到文件
    expect(out).toContain("sed -n '10,20p' '/proj/plsql-src/subdir/PKG_A_BODY.sql'")
    expect(out).not.toContain("sed -n '10,20p' 'subdir/PKG_A_BODY.sql'")
  })
})
