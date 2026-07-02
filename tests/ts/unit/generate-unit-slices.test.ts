/**
 * generate-unit-slices.test.ts — 引擎预切 per-unit 切片测试（Phase 1 硬输入边界）
 *
 * 验证 generateUnitSlices 为每个 targetUnit 落盘 source.sql + inventory-slice.json + meta.json，
 * 源码片段按 bodyLocation.lineRange 抽取（绝对路径 / 相对 sourcePath / standalone 虚拟包），analysis-slice 容错。
 *
 * 新形状：packages/{pkg}.json + subprograms/{pkg}.{ref}.json（bodyLocation.lineRange）；
 * functionOwnership 由 buildDependencyGraph 从 subprograms.directCalls 按需推导（不再读 dependency-graph.json）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateUnitSlices, unitSliceRelPaths } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gen-slices-"))
})

interface SubSpec {
  name: string
  type: "PROCEDURE" | "FUNCTION"
  lineRange?: [number, number]
  directCalls?: Array<{ package: string; name: string; line: number; kind: "function" | "procedure" }>
}

/** 写 packages/{pkg}.json + subprograms/{pkg}.{name}.json（bodyLocation.lineRange = lineRange） */
function writePkg(art: string, pkg: string, bodyPath: string, subs: SubSpec[]) {
  mkdirSync(join(art, "packages"), { recursive: true })
  mkdirSync(join(art, "subprograms"), { recursive: true })
  const procedures = subs.filter(s => s.type === "PROCEDURE").map(s => s.name)
  const functions = subs.filter(s => s.type === "FUNCTION").map(s => s.name)
  writeFileSync(join(art, "packages", `${pkg}.json`), JSON.stringify({
    packageName: pkg, absolutePaths: [bodyPath], headerPath: bodyPath, bodyPath,
    constants: [], variables: [], exceptions: [], types: [],
    functions, procedures, estimatedLoc: 0,
  }), "utf-8")
  for (const s of subs) {
    const loc = s.lineRange ? { absolutePath: bodyPath, lineRange: s.lineRange } : null
    writeFileSync(join(art, "subprograms", `${pkg}.${s.name}.json`), JSON.stringify({
      name: s.name, type: s.type, belongToPackage: pkg, overloadIndex: null, isPrivate: false,
      headerLocation: loc, bodyLocation: loc,
      parameters: [], returnType: s.type === "FUNCTION" ? "VARCHAR2" : null, loc: 1,
      directCalls: s.directCalls ?? [],
    }), "utf-8")
  }
}

describe("generateUnitSlices — analyze", () => {
  it("根 + cargo：source.sql 按 bodyLocation.lineRange 抽片段 + inventory-slice.json + meta.json", () => {
    const art = join(dir, "a")
    mkdirSync(art, { recursive: true })
    // 源码文件：10 行 proc1，30-40 行 calc_total
    const src = join(art, "PKG_A_BODY.sql")
    writeFileSync(src, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"), "utf-8")
    // proc1 调 calc_total（FUNCTION）→ buildDependencyGraph 推导 calc_total 归属 proc1（cargo）
    writePkg(art, "PKG_A", src, [
      { name: "proc1", type: "PROCEDURE", lineRange: [10, 20], directCalls: [{ package: "PKG_A", name: "calc_total", line: 12, kind: "function" }] },
      { name: "calc_total", type: "FUNCTION", lineRange: [30, 40] },
    ])

    const generated = generateUnitSlices(art, ["PKG_A.proc1"], "analyze", "")
    // 返回切片相对路径
    expect(generated).toEqual(expect.arrayContaining(unitSliceRelPaths("PKG_A.proc1", "analyze")))

    const sliceDir = join(art, "shard-inputs", "PKG_A", "proc1")
    expect(existsSync(join(sliceDir, "source.sql"))).toBe(true)
    expect(existsSync(join(sliceDir, "inventory-slice.json"))).toBe(true)
    expect(existsSync(join(sliceDir, "meta.json"))).toBe(true)

    const sql = readFileSync(join(sliceDir, "source.sql"), "utf-8")
    // 根片段：line 10-20
    expect(sql).toContain("line 10")
    expect(sql).toContain("line 20")
    expect(sql).not.toContain("line 21")
    // cargo 片段：line 30-40
    expect(sql).toContain("line 30")
    expect(sql).toContain("line 40")
    expect(sql).toContain("calc_total")

    const inv = JSON.parse(readFileSync(join(sliceDir, "inventory-slice.json"), "utf-8"))
    expect(inv.unitId).toBe("PKG_A.proc1")
    expect(inv.root.ref).toBe("proc1")
    expect(inv.cargo[0].ref).toBe("calc_total")

    const meta = JSON.parse(readFileSync(join(sliceDir, "meta.json"), "utf-8"))
    expect(meta.unitId).toBe("PKG_A.proc1")
    expect(meta.cargoFuncs).toEqual([{ ref: "calc_total", pkg: "PKG_A" }])
    expect(meta.analysisMissing).toBe(false)
  })

  it("相对 bodyPath + sourcePath → 用绝对路径抽源码", () => {
    const art = join(dir, "b")
    mkdirSync(art, { recursive: true })
    const sourcePath = art // 源码就放在 art 下
    mkdirSync(join(sourcePath, "subdir"), { recursive: true })
    writeFileSync(join(sourcePath, "subdir", "BODY.sql"), Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n"), "utf-8")
    writePkg(art, "PKG_A", "subdir/BODY.sql", [
      { name: "proc1", type: "PROCEDURE", lineRange: [5, 9] },
    ])

    generateUnitSlices(art, ["PKG_A.proc1"], "analyze", sourcePath)
    const sql = readFileSync(join(art, "shard-inputs", "PKG_A", "proc1", "source.sql"), "utf-8")
    expect(sql).toContain("L5")
    expect(sql).toContain("L9")
    expect(sql).not.toContain("L10")
  })

  it("standalone 虚拟包：bodyPath=源文件，切片正常", () => {
    const art = join(dir, "c")
    mkdirSync(art, { recursive: true })
    const src = join(art, "standalone_proc.sql")
    writeFileSync(src, Array.from({ length: 8 }, (_, i) => `s${i + 1}`).join("\n"), "utf-8")
    writePkg(art, "__STANDALONE_X__", src, [
      { name: "do_thing", type: "PROCEDURE", lineRange: [2, 6] },
    ])

    generateUnitSlices(art, ["__STANDALONE_X__.do_thing"], "analyze", "")
    const sql = readFileSync(join(art, "shard-inputs", "__STANDALONE_X__", "do_thing", "source.sql"), "utf-8")
    expect(sql).toContain("s2")
    expect(sql).toContain("s6")
    expect(sql).not.toContain("s7")
  })

  it("lineRange 缺失：source.sql 标注警告，不抛错", () => {
    const art = join(dir, "d")
    mkdirSync(art, { recursive: true })
    writePkg(art, "PKG_A", "/nonexistent/BODY.sql", [
      { name: "proc1", type: "PROCEDURE" /* 无 lineRange */ },
    ])

    expect(() => generateUnitSlices(art, ["PKG_A.proc1"], "analyze", "")).not.toThrow()
    const sql = readFileSync(join(art, "shard-inputs", "PKG_A", "proc1", "source.sql"), "utf-8")
    expect(sql).toMatch(/lineRange 缺失|源码文件不存在/)
  })
})

describe("generateUnitSlices — translate", () => {
  it("analysis-slice.json 从 analysis-packages 聚合按 name 过滤", () => {
    const art = join(dir, "t1")
    mkdirSync(art, { recursive: true })
    const src = join(art, "BODY.sql")
    writeFileSync(src, Array.from({ length: 20 }, (_, i) => `x${i + 1}`).join("\n"), "utf-8")
    writePkg(art, "PKG_A", src, [
      { name: "proc1", type: "PROCEDURE", lineRange: [1, 5] },
      { name: "proc2", type: "PROCEDURE", lineRange: [6, 10] },
    ])
    // 聚合 analysis-packages（含两个 subprogram，结构不同以便区分）
    mkdirSync(join(art, "analysis-packages"), { recursive: true })
    writeFileSync(join(art, "analysis-packages", "PKG_A.json"), JSON.stringify({
      packageName: "PKG_A",
      subprograms: [
        { name: "proc1", blocks: [{ kind: "loop" }], variables: [{ name: "v1" }] },
        { name: "proc2", blocks: [{ kind: "if-else" }], variables: [] },
      ],
    }), "utf-8")

    generateUnitSlices(art, ["PKG_A.proc1"], "translate", "")
    const sliceDir = join(art, "shard-inputs", "PKG_A", "proc1")
    expect(existsSync(join(sliceDir, "analysis-slice.json"))).toBe(true)
    expect(existsSync(join(sliceDir, "inventory-slice.json"))).toBe(false) // translate 不产 inventory-slice

    const ana = JSON.parse(readFileSync(join(sliceDir, "analysis-slice.json"), "utf-8"))
    // 只含 proc1 的 subprogram，不含 proc2（硬隔离）
    expect(ana.subprograms).toHaveLength(1)
    expect(ana.subprograms[0].name).toBe("proc1")
  })

  it("analysis-packages 聚合缺失：analysis-slice.json 写空 + meta.analysisMissing=true", () => {
    const art = join(dir, "t2")
    mkdirSync(art, { recursive: true })
    const src = join(art, "BODY.sql")
    writeFileSync(src, Array.from({ length: 10 }, (_, i) => `y${i + 1}`).join("\n"), "utf-8")
    writePkg(art, "PKG_A", src, [
      { name: "proc1", type: "PROCEDURE", lineRange: [1, 5] },
    ])
    // 不写 analysis-packages 聚合

    generateUnitSlices(art, ["PKG_A.proc1"], "translate", "")
    const sliceDir = join(art, "shard-inputs", "PKG_A", "proc1")
    const ana = JSON.parse(readFileSync(join(sliceDir, "analysis-slice.json"), "utf-8"))
    expect(ana.subprograms).toEqual([])
    const meta = JSON.parse(readFileSync(join(sliceDir, "meta.json"), "utf-8"))
    expect(meta.analysisMissing).toBe(true)
  })
})

describe("generateUnitSlices — 边界", () => {
  it("空 targetUnits / 非 analyze|translate → 返回空数组", () => {
    const art = join(dir, "e")
    mkdirSync(art, { recursive: true })
    expect(generateUnitSlices(art, [], "analyze", "")).toEqual([])
    expect(generateUnitSlices(art, ["PKG_A.p1"], "review", "")).toEqual([])
  })
})
