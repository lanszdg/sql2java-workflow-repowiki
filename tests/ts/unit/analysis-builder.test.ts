/**
 * analysis-builder.test.ts — analyze reduce（代码）核心逻辑测试
 *
 * 验证：① tiny fixture 上 analysis.json 产出正确（callGraph/packageDependency/
 * translationOrder/sccGroups/complexity）；② Tarjan SCC 算法（含环）；③ refName 索引（重载）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { scanSource } from "@workflow/plsql-scanner"
import { buildAnalysisFromIndex, tarjanSCC, buildRefNameIndex, assignFunctionOwnership, buildProcedureOrder } from "@workflow/analysis-builder"
import { AnalysisMetaSchema, AnalysisPackageSchema } from "@workflow/artifact-schemas"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "analysis-build-"))
  const index = await scanSource(FIXTURE_TINY)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
}, 60000)

describe("buildAnalysisFromIndex (tiny fixture)", () => {
  it("生成 analysis.json 并过 AnalysisMetaSchema 校验", () => {
    const r = buildAnalysisFromIndex(dir)
    expect(r.packageCount).toBe(3)
    const a = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf-8"))
    expect(AnalysisMetaSchema.safeParse(a).success).toBe(true)
  })

  it("packageNames 覆盖全部包", () => {
    const a = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf-8"))
    // 含独立函数 fn_abc_class 注入的虚拟包
    expect(a.packageNames.sort()).toEqual(["BASE_PKG", "CORE_PKG", "__STANDALONE_FN_ABC_CLASS__"])
  })

  it("packageDependency 捕获跨包常量引用（CORE_PKG→BASE_PKG）", () => {
    const a = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf-8"))
    // core_pkg 用 base_pkg.c_dir_in（常量），包级依赖须包含
    expect(a.packageDependency["CORE_PKG"]).toContain("BASE_PKG")
    expect(a.packageDependency["BASE_PKG"]).toEqual([])
  })

  it("translationOrder 依赖在前：BASE_PKG 先于 CORE_PKG", () => {
    const a = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf-8"))
    // 含独立函数虚拟包；CORE_PKG 依赖 BASE_PKG，故 BASE_PKG 必在前
    const order = a.translationOrder.flat()
    expect(order).toEqual(expect.arrayContaining(["BASE_PKG", "CORE_PKG", "__STANDALONE_FN_ABC_CLASS__"]))
    expect(order.indexOf("BASE_PKG")).toBeLessThan(order.indexOf("CORE_PKG"))
  })

  it("sccGroups：无环时为空", () => {
    const a = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf-8"))
    expect(a.sccGroups).toEqual([])
  })

  it("callGraph 仅含跨包子程序调用（本 fixture 无，故为空对象）", () => {
    const a = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf-8"))
    // base_pkg 无子程序；core_pkg 的跨包引用是 base_pkg.c_dir_in（常量，非子程序）→ 不进 callGraph
    expect(a.callGraph).toEqual({})
  })

  it("complexity 启发式：BASE_PKG 低分，CORE_PKG 高分 + 模式", () => {
    const a = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf-8"))
    expect(a.complexity["BASE_PKG"].riskLevel).toBe("low")
    expect(a.complexity["BASE_PKG"].score).toBeLessThanOrEqual(3)
    expect(a.complexity["CORE_PKG"].riskLevel).toBe("high")
    expect(a.complexity["CORE_PKG"].score).toBe(10) // clamp 上限
    // core_pkg 含这些模式
    const pats = a.complexity["CORE_PKG"].patterns
    expect(pats).toContain("dynamic-sql")
    expect(pats).toContain("bulk-collect")
    expect(pats).toContain("connect-by")
    expect(pats).toContain("pipelined")
  })

  it("无子程序包写空 analysis-packages/{PKG}.json（过 AnalysisPackageSchema）", () => {
    const base = JSON.parse(readFileSync(join(dir, "analysis-packages", "BASE_PKG.json"), "utf-8"))
    expect(base).toEqual({ packageName: "BASE_PKG", subprograms: [] })
    expect(AnalysisPackageSchema.safeParse(base).success).toBe(true)
    // 有子程序的包此处不写（由 analyze map 阶段填充）
    expect(existsSync(join(dir, "analysis-packages", "CORE_PKG.json"))).toBe(false)
  })
})

describe("tarjanSCC", () => {
  it("无环：依赖在前拓扑序", () => {
    // A→B（A 依赖 B），C→B
    const nodes = ["A", "B", "C"]
    const edges = new Map([["A", new Set(["B"])], ["B", new Set()], ["C", new Set(["B"])]])
    const sccs = tarjanSCC(nodes, edges)
    // B（sink）先输出，A/C 之后
    expect(sccs[0]).toEqual(["B"])
    expect(sccs.slice(1).map(c => c[0]).sort()).toEqual(["A", "C"])
    // 每个 SCC 单元素
    expect(sccs.every(c => c.length === 1)).toBe(true)
  })

  it("有环：SCC 组归为同组，且组内成员一起", () => {
    // A↔B（环），B→C
    const nodes = ["A", "B", "C"]
    const edges = new Map([
      ["A", new Set(["B"])],
      ["B", new Set(["A", "C"])],
      ["C", new Set()],
    ])
    const sccs = tarjanSCC(nodes, edges)
    // {A,B} 是一个 SCC，C 单独
    const cyclic = sccs.find(c => c.length > 1)!
    expect(cyclic.sort()).toEqual(["A", "B"])
    expect(sccs.find(c => c.length === 1 && c[0] === "C")).toBeTruthy()
    // C（依赖最深的 sink）应在 {A,B} 之前输出
    const cIdx = sccs.findIndex(c => c.includes("C"))
    const abIdx = sccs.findIndex(c => c.length > 1)
    expect(cIdx).toBeLessThan(abIdx)
  })

  it("自环不构成多元素 SCC", () => {
    const nodes = ["A"]
    const edges = new Map([["A", new Set(["A"])]])
    const sccs = tarjanSCC(nodes, edges)
    expect(sccs).toEqual([["A"]])
  })
})

describe("buildRefNameIndex", () => {
  it("非重载→裸名；重载→{name}__{i}（1-based，全部带序号）", () => {
    const pkgs = [{
      name: "P",
      procedures: [
        { name: "get_param", type: "procedure" },
        { name: "get_param", type: "procedure" },
        { name: "unique_fn", type: "function" },
      ],
    }]
    const idx = buildRefNameIndex(pkgs)
    const info = idx.get("P")!
    expect(info.subprograms.map(s => s.refName)).toEqual(["get_param__1", "get_param__2", "unique_fn"])
    expect(info.procNameToRefNames.get("GET_PARAM")).toEqual(["get_param__1", "get_param__2"])
    expect(info.procNameToRefNames.get("UNIQUE_FN")).toEqual(["unique_fn"])
  })
})

// ── PROCEDURE 级下沉：FUNCTION 属主归属 + 单元级 procedureOrder ──────────────
/** 构造 refIndex 辅助：procs 用小写名（refName=原名） */
function makeRefIndex(pkgs: { name: string; procs: { name: string; type: "procedure" | "function" }[] }[]) {
  return buildRefNameIndex(pkgs.map(p => ({
    name: p.name,
    procedures: p.procs.map(c => ({ name: c.name, type: c.type })),
  })))
}

describe("assignFunctionOwnership（FUNCTION 属主归属）", () => {
  it("单属主：func 仅被 1 个 proc 调用 → 归它", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "f1", type: "function" },
    ] }])
    const callGraph = { "P.p1": ["P.f1"] }
    const own = assignFunctionOwnership(callGraph, ref)
    expect(own.get("P.f1")).toBe("P.p1")
  })

  it("多调用者等距：取 refName 字典序最小", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "p2", type: "procedure" },
      { name: "f1", type: "function" },
    ] }])
    const callGraph = { "P.p1": ["P.f1"], "P.p2": ["P.f1"] }
    const own = assignFunctionOwnership(callGraph, ref)
    expect(own.get("P.f1")).toBe("P.p1")
  })

  it("多调用者不同距：取最近（最直接）属主", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "p2", type: "procedure" },
      { name: "f1", type: "function" }, { name: "f2", type: "function" },
    ] }])
    // p1→f1→f2（p1 到 f2 距离 2）；p2→f2（距离 1）→ owner p2
    const callGraph = { "P.p1": ["P.f1"], "P.f1": ["P.f2"], "P.p2": ["P.f2"] }
    const own = assignFunctionOwnership(callGraph, ref)
    expect(own.get("P.f1")).toBe("P.p1")
    expect(own.get("P.f2")).toBe("P.p2")
  })

  it("孤儿：func 无任何 proc 调用 → 不入 ownership", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "f1", type: "function" },
    ] }])
    const callGraph = {}
    const own = assignFunctionOwnership(callGraph, ref)
    expect(own.has("P.f1")).toBe(false)
  })

  it("仅跨包调用不建立属主：func 在 P 仅被 Q 的 proc 调用 → P 中孤儿", () => {
    const ref = makeRefIndex([
      { name: "P", procs: [{ name: "f1", type: "function" }] },
      { name: "Q", procs: [{ name: "q1", type: "procedure" }] },
    ])
    const callGraph = { "Q.q1": ["P.f1"] }
    const own = assignFunctionOwnership(callGraph, ref)
    expect(own.has("P.f1")).toBe(false)
  })

  it("经 function 链传递归属：p1→f1→f2，f2 归 p1（传递）", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" },
      { name: "f1", type: "function" }, { name: "f2", type: "function" },
    ] }])
    const callGraph = { "P.p1": ["P.f1"], "P.f1": ["P.f2"] }
    const own = assignFunctionOwnership(callGraph, ref)
    expect(own.get("P.f1")).toBe("P.p1")
    expect(own.get("P.f2")).toBe("P.p1")
  })
})

describe("buildProcedureOrder（单元级拓扑序）", () => {
  it("被拥有 FUNCTION 折叠进 owner 单元，不独立成 unit", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "f1", type: "function" },
    ] }])
    const callGraph = { "P.p1": ["P.f1"] }
    const own = assignFunctionOwnership(callGraph, ref)
    const order = buildProcedureOrder(callGraph, ref, own)
    expect(order.flat()).toEqual(["P.p1"]) // f1 折叠，不独立
  })

  it("孤儿 FUNCTION 独立成 unit", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "f1", type: "function" },
    ] }])
    const own = assignFunctionOwnership({}, ref)
    const order = buildProcedureOrder({}, ref, own)
    expect(order.flat()).toEqual(["P.f1"])
  })

  it("跨包调用：被依赖 unit 在前", () => {
    const ref = makeRefIndex([
      { name: "P", procs: [{ name: "f1", type: "function" }] },
      { name: "Q", procs: [{ name: "q1", type: "procedure" }] },
    ])
    const callGraph = { "Q.q1": ["P.f1"] } // q1 调用 P.f1（孤儿）→ Q.q1 依赖 P.f1
    const own = assignFunctionOwnership(callGraph, ref)
    const order = buildProcedureOrder(callGraph, ref, own).flat()
    expect(order.indexOf("P.f1")).toBeLessThan(order.indexOf("Q.q1"))
  })

  it("单元间 SCC（互调用 proc）归同层", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "p2", type: "procedure" },
    ] }])
    const callGraph = { "P.p1": ["P.p2"], "P.p2": ["P.p1"] }
    const own = assignFunctionOwnership(callGraph, ref)
    const order = buildProcedureOrder(callGraph, ref, own)
    expect(order.length).toBe(1)
    expect(order[0].sort()).toEqual(["P.p1", "P.p2"])
  })

  it("同包跨单元调用：被依赖 unit 在前（多调用者归属后）", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "p2", type: "procedure" },
      { name: "f1", type: "function" },
    ] }])
    // p1→f1, p2→f1：f1 归 p1（字典序）；p2→f1 折叠为 p2→p1 依赖边 → p1 在前
    const callGraph = { "P.p1": ["P.f1"], "P.p2": ["P.f1"] }
    const own = assignFunctionOwnership(callGraph, ref)
    const order = buildProcedureOrder(callGraph, ref, own).flat()
    expect(order.indexOf("P.p1")).toBeLessThan(order.indexOf("P.p2"))
  })
})

describe("callGraph 真实跨包调用（合成 fixture）", () => {
  let synthDir: string
  let synthArtifacts: string

  beforeAll(async () => {
    synthDir = mkdtempSync(join(tmpdir(), "analysis-synth-"))
    // pkg_b：被调用方
    writeFileSync(join(synthDir, "pkg_b.pks"), `
CREATE OR REPLACE PACKAGE pkg_b AS
  PROCEDURE p2(p IN NUMBER);
END pkg_b;
/
`, "utf-8")
    writeFileSync(join(synthDir, "pkg_b.pkb"), `
CREATE OR REPLACE PACKAGE BODY pkg_b AS
  PROCEDURE p2(p IN NUMBER) IS
  BEGIN
    NULL;
  END;
END pkg_b;
/
`, "utf-8")
    // pkg_a：调用 pkg_b.p2
    writeFileSync(join(synthDir, "pkg_a.pks"), `
CREATE OR REPLACE PACKAGE pkg_a AS
  PROCEDURE p1(p IN NUMBER);
END pkg_a;
/
`, "utf-8")
    writeFileSync(join(synthDir, "pkg_a.pkb"), `
CREATE OR REPLACE PACKAGE BODY pkg_a AS
  PROCEDURE p1(p IN NUMBER) IS
  BEGIN
    pkg_b.p2(p);
  END;
END pkg_a;
/
`, "utf-8")

    const index = await scanSource(synthDir)
    synthArtifacts = mkdtempSync(join(tmpdir(), "analysis-synth-art-"))
    writeFileSync(join(synthArtifacts, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
    buildAnalysisFromIndex(synthArtifacts)
  }, 60000)

  it("callGraph 捕获跨包子程序调用 PKG_A.p1 → PKG_B.p2", () => {
    const a = JSON.parse(readFileSync(join(synthArtifacts, "analysis.json"), "utf-8"))
    expect(a.callGraph["PKG_A.p1"]).toContain("PKG_B.p2")
  })

  it("packageDependency: PKG_A → PKG_B", () => {
    const a = JSON.parse(readFileSync(join(synthArtifacts, "analysis.json"), "utf-8"))
    expect(a.packageDependency["PKG_A"]).toContain("PKG_B")
    expect(a.packageDependency["PKG_B"]).toEqual([])
  })

  it("translationOrder: PKG_B（依赖）先于 PKG_A", () => {
    const a = JSON.parse(readFileSync(join(synthArtifacts, "analysis.json"), "utf-8"))
    const order = a.translationOrder.flat()
    expect(order.indexOf("PKG_B")).toBeLessThan(order.indexOf("PKG_A"))
  })

  it("常量引用不进 callGraph 但进 packageDependency", async () => {
    // 重写 pkg_a body：调用 pkg_b 常量（非子程序）→ 不进 callGraph，但进 packageDependency
    writeFileSync(join(synthDir, "pkg_a.pkb"), `
CREATE OR REPLACE PACKAGE BODY pkg_a AS
  PROCEDURE p1(p IN NUMBER) IS
    v NUMBER;
  BEGIN
    v := pkg_b.c_const;
  END;
END pkg_a;
/
`, "utf-8")
    // pkg_b 加常量
    writeFileSync(join(synthDir, "pkg_b.pks"), `
CREATE OR REPLACE PACKAGE pkg_b AS
  c_const CONSTANT NUMBER := 1;
  PROCEDURE p2(p IN NUMBER);
END pkg_b;
/
`, "utf-8")
    const index2 = await scanSource(synthDir)
    const art2 = mkdtempSync(join(tmpdir(), "analysis-synth-art2-"))
    writeFileSync(join(art2, "inventory-index.json"), JSON.stringify(index2, null, 2), "utf-8")
    buildAnalysisFromIndex(art2)
    const a = JSON.parse(readFileSync(join(art2, "analysis.json"), "utf-8"))
    expect(a.callGraph).toEqual({}) // 常量引用不进 callGraph
    expect(a.packageDependency["PKG_A"]).toContain("PKG_B") // 但进包依赖
  })
})
