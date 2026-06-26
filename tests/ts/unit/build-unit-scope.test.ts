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
  it("analyze：切片目录 + cargo FSD 输出路径（Phase 1 切片模式，不再 sed -n）", () => {
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
    // 切片目录引用（取代 sed -n）
    expect(out).toContain("shard-inputs/PKG_A/proc1/")
    expect(out).toContain("source.sql + inventory-slice.json + meta.json")
    // 输出路径仍精确枚举（含 cargo FSD）
    expect(out).toContain("analysis-packages/PKG_A/proc1.json")
    expect(out).toContain("fsd/PKG_A/proc1.md")
    expect(out).toContain("fsd/PKG_A/calc_total.md")
    expect(out).not.toContain("{cargoRef}")
    // analyze 切片模式不再出现 sed -n / translate 专属的 FSD 输入
    expect(out).not.toContain("sed -n")
    expect(out).not.toContain("FSD 输入")
  })

  it("重载子程序：refName __序号 切片目录对齐", () => {
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
    expect(out1).toContain("shard-inputs/PKG_A/get__1/")
    expect(out1).not.toContain("get__2")
    const out2 = buildUnitScopeBlock(art, ["PKG_A.get__2"], "analyze", [])
    expect(out2).toContain("shard-inputs/PKG_A/get__2/")
  })

  it("translate：切片目录 + FSD 输入 + 输出 + 依赖签名引用（Phase 2 切片模式）", () => {
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
    // 切片目录（取代 sed -n / 整包）
    expect(out).toContain("shard-inputs/PKG_A/proc1/")
    expect(out).toContain("analysis-slice.json")
    expect(out).toContain("FSD 输入")
    expect(out).toContain("fsd/PKG_A/proc1.md")
    // per-unit 输出
    expect(out).toContain("translations/PKG_A/proc1.json")
    // 依赖签名引用预注入块（不再列 translation.json 路径）
    expect(out).toContain("依赖签名")
    expect(out).not.toContain("sed -n")
    expect(out).not.toContain("依赖聚合 translation")
  })

  it("translate：清单不再列 translation.json 路径（依赖签名由预注入块提供）", () => {
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
    expect(out).not.toContain("translations/PKG_A/translation.json")
    expect(out).toContain("依赖签名")  // 引用预注入块
  })

  it("非 unit 阶段 / 空 targetUnits → 返回空串", () => {
    const art = join(dir, "e")
    mkdirSync(art, { recursive: true })
    expect(buildUnitScopeBlock(art, [], "analyze", [])).toBe("")
    expect(buildUnitScopeBlock(art, ["PKG_A.p1"], "review", [])).toBe("")
  })

  it("translate：清单始终引用依赖签名预注入块（跨包依赖大小写匹配移至 buildDependencySignaturesBlock 测试）", () => {
    const art = join(dir, "f")
    mkdirSync(art, { recursive: true })
    writeFileSync(join(art, "analysis.json"), JSON.stringify({
      procedureOrder: [["PKG_A.proc1"]],
      functionOwnership: {},
      callGraph: { "PKG_A.proc1": ["PKG_B.other"] },
    }), "utf-8")
    writeInvPkg(art, "PKG_A", "/src/PKG_A_BODY.sql", [{ name: "proc1", lineRange: [10, 20] }])

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "translate", ["pkg_b.other"])
    // 清单只引用预注入块，不列 translation.json 路径（大小写匹配由预注入函数负责）
    expect(out).toContain("依赖签名")
    expect(out).not.toContain("translations/PKG_B/translation.json")
  })

  it("analyze 切片模式：清单引用切片目录，不泄漏相对 bodyFile 路径", () => {
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
    // 切片模式：清单只引用切片目录，不出现 sed -n / 相对 bodyFile（源码已由引擎抽进 source.sql）
    expect(out).toContain("shard-inputs/PKG_A/proc1/")
    expect(out).not.toContain("sed -n")
    expect(out).not.toContain("subdir/PKG_A_BODY.sql")
  })
})
