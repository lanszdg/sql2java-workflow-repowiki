/**
 * scope-computer.test.ts — 过程级入口闭包计算纯函数测试（feat/proc-entry-scope）
 *
 * 覆盖：parseMainEntry 解析、resolveEntry 重载消歧/subdir 校验、computeClosure BFS
 * （跨包、环、const-only 包、owned FUNCTION 入口）、readScope/constOnlyScopePkgs 辅助。
 */
import { describe, it, expect } from "vitest"
import {
  parseMainEntry, resolveEntry, computeClosure, readScope, constOnlyScopePkgs,
  type AnalysisLike, type InventoryPackageLike,
} from "@workflow/scope-computer"

// ── parseMainEntry ──────────────────────────────────────────────────────────

describe("parseMainEntry", () => {
  it("subdir/PKG.refName 三段", () => {
    expect(parseMainEntry("subdir1/ORDER_PKG.process_order")).toEqual({
      subdir: "subdir1", pkg: "ORDER_PKG", refName: "process_order",
    })
  })
  it("PKG.refName 无 subdir", () => {
    expect(parseMainEntry("ORDER_PKG.process_order")).toEqual({
      subdir: null, pkg: "ORDER_PKG", refName: "process_order",
    })
  })
  it("refName 含重载序号 __N", () => {
    expect(parseMainEntry("sub/PKG.get_param__2")).toEqual({
      subdir: "sub", pkg: "PKG", refName: "get_param__2",
    })
  })
  it("纯包名（无点）→ null（非过程级）", () => {
    expect(parseMainEntry("ORDER_PKG")).toBeNull()
  })
  it("subdir/纯包名（无点）→ null", () => {
    expect(parseMainEntry("subdir1/ORDER_PKG")).toBeNull()
  })
  it("空串/非串 → null", () => {
    expect(parseMainEntry("")).toBeNull()
    expect(parseMainEntry(null)).toBeNull()
    expect(parseMainEntry(undefined)).toBeNull()
  })
  it("trim 空白", () => {
    expect(parseMainEntry("  subdir/PKG.proc  ")).toEqual({
      subdir: "subdir", pkg: "PKG", refName: "proc",
    })
  })
})

// ── resolveEntry ────────────────────────────────────────────────────────────

const ENTRY_PKG: InventoryPackageLike = {
  packageName: "ORDER_PKG",
  bodyPath: "subdir1/order_pkg_body.sql",
  headerPath: "subdir1/order_pkg_spec.sql",
  procedures: [
    { name: "process_order", type: "PROCEDURE", overloadIndex: null },
    { name: "calc_total", type: "FUNCTION", overloadIndex: null },
    { name: "get_param", type: "PROCEDURE", overloadIndex: 1 },
    { name: "get_param", type: "PROCEDURE", overloadIndex: 2 },
  ],
}

describe("resolveEntry", () => {
  it("裸名非重载 → 命中唯一 refName", () => {
    const r = resolveEntry(ENTRY_PKG, parseMainEntry("subdir1/ORDER_PKG.process_order")!)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entrySubprogram).toBe("ORDER_PKG.process_order")
      expect(r.entryUnit).toBe("ORDER_PKG.process_order")
    }
  })
  it("裸名撞重载 → 报错要求显式 refName", () => {
    const r = resolveEntry(ENTRY_PKG, parseMainEntry("ORDER_PKG.get_param")!)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/重载/)
  })
  it("显式 refName 消歧重载 → 命中", () => {
    const r = resolveEntry(ENTRY_PKG, parseMainEntry("ORDER_PKG.get_param__2")!)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entrySubprogram).toBe("ORDER_PKG.get_param__2")
  })
  it("subdir 不匹配文件前缀 → 报错", () => {
    const r = resolveEntry(ENTRY_PKG, parseMainEntry("wrong_dir/ORDER_PKG.process_order")!)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不在子目录/)
  })
  it("subdir=null 跳过路径校验", () => {
    const r = resolveEntry(ENTRY_PKG, parseMainEntry("ORDER_PKG.process_order")!)
    expect(r.ok).toBe(true)
  })
  it("子程序不存在 → 报错", () => {
    const r = resolveEntry(ENTRY_PKG, parseMainEntry("ORDER_PKG.no_such_proc")!)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不在包/)
  })
  it("包不存在（entryPkg=undefined）→ 报错", () => {
    const r = resolveEntry(undefined, parseMainEntry("MISSING_PKG.proc")!)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不在 inventory/)
  })
  it("大小写不敏感包名匹配", () => {
    const r = resolveEntry(ENTRY_PKG, parseMainEntry("order_pkg.process_order")!)
    expect(r.ok).toBe(true)
  })
})

// ── computeClosure ──────────────────────────────────────────────────────────

const ANALYSIS: AnalysisLike = {
  // 子程序级调用图：caller → callees
  callGraph: {
    "ORDER_PKG.process_order": ["ORDER_PKG.calc_total", "ORDER_PKG.helper", "INVENTORY_PKG.deduct"],
    "ORDER_PKG.helper": [],                                     // 仅引用 COMMON_PKG 常量（非调用，进 packageDependency）
    "INVENTORY_PKG.deduct": [],
    "ORPHAN_PKG.lonely": [],                                    // 不被入口可达
  },
  // 包级引用图（含常量/类型/跨包调用）
  packageDependency: {
    ORDER_PKG: ["COMMON_PKG", "INVENTORY_PKG"],
    INVENTORY_PKG: ["COMMON_PKG"],
    COMMON_PKG: [],          // 仅常量/类型被引用，无 unit 被调用（const-only）
    ORPHAN_PKG: [],
  },
  functionOwnership: {
    "ORDER_PKG.calc_total": "ORDER_PKG.process_order", // owned FUNCTION → 折叠进 owner unit
  },
}

describe("computeClosure", () => {
  const closure = computeClosure(ANALYSIS, "ORDER_PKG.process_order")

  it("scopeUnits = 入口 unit + 调用可达 unit（owned FUNCTION 折叠进 owner）", () => {
    // process_order 调 calc_total(owned→process_order unit) + helper + INVENTORY_PKG.deduct
    // calc_total 折叠进 process_order，故 unit 不重复
    expect(closure.scopeUnits.sort()).toEqual([
      "INVENTORY_PKG.deduct",
      "ORDER_PKG.helper",
      "ORDER_PKG.process_order",
    ])
  })

  it("entryUnit = 入口自身（PROCEDURE）", () => {
    expect(closure.entryUnit).toBe("ORDER_PKG.process_order")
  })

  it("scopePackages = scopeUnits 所属包 ∪ packageDependency 可达包（含 const-only COMMON_PKG）", () => {
    expect(closure.scopePackages.sort()).toEqual([
      "COMMON_PKG",
      "INVENTORY_PKG",
      "ORDER_PKG",
    ])
  })

  it("const-only 包（COMMON_PKG）在 scopePackages 但不在 scopeUnits", () => {
    expect(closure.scopePackages).toContain("COMMON_PKG")
    expect(closure.scopeUnits.some(u => u.startsWith("COMMON_PKG."))).toBe(false)
  })

  it("不可达包（ORPHAN_PKG）不在闭包", () => {
    expect(closure.scopePackages).not.toContain("ORPHAN_PKG")
    expect(closure.scopeUnits.some(u => u.startsWith("ORPHAN_PKG."))).toBe(false)
  })

  it("入口为 owned FUNCTION → entryUnit 取 owner unit", () => {
    const c = computeClosure(ANALYSIS, "ORDER_PKG.calc_total")
    expect(c.entryUnit).toBe("ORDER_PKG.process_order") // calc_total 折叠进 owner
    expect(c.scopeUnits).toContain("ORDER_PKG.process_order")
  })

  it("环不导致死循环（visited 防环）", () => {
    const cyclic: AnalysisLike = {
      callGraph: {
        "A.p1": ["A.p2"],
        "A.p2": ["A.p1", "B.q1"],
        "B.q1": [],
      },
      packageDependency: { A: ["B"], B: [] },
      functionOwnership: {},
    }
    const c = computeClosure(cyclic, "A.p1")
    expect(c.scopeUnits.sort()).toEqual(["A.p1", "A.p2", "B.q1"])
  })

  it("入口无出边 → 闭包仅含入口 unit + 其包", () => {
    const c = computeClosure(ANALYSIS, "ORPHAN_PKG.lonely")
    expect(c.scopeUnits).toEqual(["ORPHAN_PKG.lonely"])
    expect(c.scopePackages).toEqual(["ORPHAN_PKG"])
    expect(c.warnings.some(w => w.includes("无出边"))).toBe(true)
  })
})

// ── readScope / constOnlyScopePkgs ──────────────────────────────────────────

describe("readScope", () => {
  it("完整 metadata → 读出", () => {
    const md = { scopeUnits: ["A.p1"], scopePackages: ["A", "B"], entryUnit: "A.p1" }
    expect(readScope(md)).toEqual({ scopeUnits: ["A.p1"], scopePackages: ["A", "B"], entryUnit: "A.p1" })
  })
  it("缺字段 → null（全量回退）", () => {
    expect(readScope({})).toBeNull()
    expect(readScope(undefined)).toBeNull()
    expect(readScope({ scopeUnits: [], scopePackages: [], entryUnit: "" })).toBeNull()
  })
})

describe("constOnlyScopePkgs", () => {
  it("scopePackages \\ pkgsOf(targetUnits)", () => {
    const scope = { scopeUnits: ["A.p1", "B.q1"], scopePackages: ["A", "B", "C"], entryUnit: "A.p1" }
    // targetUnits = [A.p1] → pkgsOf = {A} → const-only = [B, C]
    expect(constOnlyScopePkgs(scope, ["A.p1"])!.sort()).toEqual(["B", "C"])
  })
  it("无 scope → undefined", () => {
    expect(constOnlyScopePkgs(null, ["A.p1"])).toBeUndefined()
  })
})
