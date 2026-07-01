/**
 * plsql-scanner-fields.test.ts — AST 结构抽取字段覆盖率测试
 *
 * 验证 ts-plsql-parser 的 AST 模式能确定性抽出 inventory 所需的全部结构字段
 *（params / returnType / types / variables / constants / columns / trigger / sequence / standalone / overload），
 * 即 inventory 阶段可下沉到 prescan、无需 LLM 的依据。
 *
 * fixture: tests/ts/fixtures/sql/tiny（覆盖 header-only 包、重载、%ROWTYPE、UDT 列/参数、
 * 对象类型、PK/FK/CHECK 约束、复合 PK、分区表、序列、触发器 WHEN、视图）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { scanWithAST, type InventoryIndex } from "@workflow/plsql-scanner"
import { resolve } from "node:path"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")

let result: InventoryIndex | null = null
let parserAvailable = true

beforeAll(async () => {
  try {
    result = await scanWithAST([FIXTURE_TINY], FIXTURE_TINY)
  } catch {
    // 测试环境未安装 ts-plsql-parser 时跳过（AST 字段抽取仅在 parser 可用时生效）
    parserAvailable = false
  }
}, 60000)

// 无 parser 时跳过全部 AST 字段测试
const itAst = parserAvailable ? it : it.skip

describe("plsql-scanner AST 字段抽取 (tiny fixture)", () => {
  itAst("扫描器使用 AST 模式", () => {
    expect(result!.scannerUsed).toBe("ast")
  })

  // ── Package: header-only 包（base_pkg，只有常量）──
  describe("BASE_PKG (header-only)", () => {
    itAst("识别为 header-only 包：无 procedures，有 5 个常量", () => {
      const pkg = result!.packages.find(p => p.name === "BASE_PKG")!
      expect(pkg.procedures).toHaveLength(0)
      expect(pkg.constants).toHaveLength(5)
      expect(pkg.bodyFile).toBeUndefined()
      expect(pkg.headerFile).toBeTruthy()
    })

    itAst("常量抽取：name / type / value", () => {
      const pkg = result!.packages.find(p => p.name === "BASE_PKG")!
      const byName = Object.fromEntries(pkg.constants!.map(c => [c.name, c]))
      expect(byName.c_err_item_not_found).toEqual({
        name: "c_err_item_not_found", type: "VARCHAR2(16)", value: "'M1001'",
      })
      expect(byName.c_dir_in.type).toBe("CHAR(1)")
      expect(byName.c_lot_available.value).toBe("'AVAILABLE'")
    })
  })

  // ── Package: 全构造包（core_pkg）──
  describe("CORE_PKG (全构造)", () => {
    itAst("procedures 数量 = 12（11 个声明 + create_item 重载 2 版）", () => {
      const pkg = result!.packages.find(p => p.name === "CORE_PKG")!
      expect(pkg.procedures).toHaveLength(12)
    })

    itAst("重载 create_item 保留为两条独立记录，参数数量不同", () => {
      const pkg = result!.packages.find(p => p.name === "CORE_PKG")!
      const overloads = pkg.procedures.filter(p => p.name === "create_item")
      expect(overloads).toHaveLength(2)
      const paramCounts = overloads.map(p => p.params!.length).sort()
      expect(paramCounts).toEqual([4, 5])
    })

    itAst("FUNCTION 抽取 returnType（含 %ROWTYPE）+ params", () => {
      const pkg = result!.packages.find(p => p.name === "CORE_PKG")!
      const getItem = pkg.procedures.find(p => p.name === "get_item")!
      expect(getItem.type).toBe("function")
      expect(getItem.returnType).toBe("t_item%ROWTYPE")
      expect(getItem.params).toEqual([
        { name: "p_id", oracleType: "NUMBER", direction: "IN" },
      ])
    })

    itAst("params direction：IN / OUT / IN OUT 正确", () => {
      const pkg = result!.packages.find(p => p.name === "CORE_PKG")!
      const createItem = pkg.procedures.find(p => p.name === "create_item" && p.params!.length === 4)!
      const pId = createItem.params!.find(p => p.name === "p_id")!
      expect(pId.direction).toBe("OUT")
      expect(createItem.params!.find(p => p.name === "p_code")!.direction).toBe("IN")
    })

    itAst("UDT 参数类型保留（t_recv_tab / SYS_REFCURSOR）", () => {
      const pkg = result!.packages.find(p => p.name === "CORE_PKG")!
      const bulk = pkg.procedures.find(p => p.name === "bulk_receive")!
      expect(bulk.params!.find(p => p.name === "p_lines")!.oracleType).toBe("t_recv_tab")
      const listBom = pkg.procedures.find(p => p.name === "list_bom")!
      expect(listBom.params!.find(p => p.name === "p_cur")!.oracleType).toBe("SYS_REFCURSOR")
    })

    itAst("package 级 types 抽取（RECORD / TABLE）", () => {
      const pkg = result!.packages.find(p => p.name === "CORE_PKG")!
      const byName = Object.fromEntries(pkg.types!.map(t => [t.name, t.kind]))
      expect(byName.t_recv_line).toBe("RECORD")
      expect(byName.t_recv_tab).toBe("TABLE")
    })

    itAst("package 级变量抽取（含类型）", () => {
      const pkg = result!.packages.find(p => p.name === "CORE_PKG")!
      expect(pkg.variables).toEqual([{ name: "g_biz_date", type: "DATE", defaultValue: null }])
    })
  })

  // ── Table 列定义 ──
  describe("tables columns", () => {
    itAst("T_ITEM 10 列（排除外联 CHECK 约束伪列）", () => {
      const t = result!.tables.find(x => x.name === "T_ITEM")!
      expect(t.columns).toHaveLength(10)
    })

    itAst("列类型规范化（含精度 / UDT）", () => {
      const t = result!.tables.find(x => x.name === "T_ITEM")!
      const byName = Object.fromEntries(t.columns!.map(c => [c.name, c]))
      expect(byName.item_id.oracleType).toBe("NUMBER(18)")
      expect(byName.std_cost.oracleType).toBe("NUMBER(20,6)")
      expect(byName.dim.oracleType).toBe("t_dimension")   // UDT 列
      expect(byName.tags.oracleType).toBe("t_tag_varray") // UDT 列
    })

    itAst("nullable / isPrimaryKey / defaultValue", () => {
      const t = result!.tables.find(x => x.name === "T_ITEM")!
      const byName = Object.fromEntries(t.columns!.map(c => [c.name, c]))
      expect(byName.item_id).toMatchObject({ nullable: false, isPrimaryKey: true, defaultValue: null })
      expect(byName.item_code).toMatchObject({ nullable: false, isPrimaryKey: false })
      expect(byName.std_cost).toMatchObject({ nullable: true, defaultValue: "0" })
      expect(byName.status).toMatchObject({ nullable: true, defaultValue: "'ACTIVE'" })
    })

    itAst("外联 PRIMARY KEY 标记对应列（含复合 PK）", () => {
      const txn = result!.tables.find(x => x.name === "T_INVENTORY_TXN")!
      const byName = Object.fromEntries(txn.columns!.map(c => [c.name, c]))
      expect(byName.txn_id.isPrimaryKey).toBe(true)
      expect(byName.txn_date.isPrimaryKey).toBe(true)   // 复合 PK
      expect(byName.txn_id.nullable).toBe(false)
      expect(byName.item_id.isPrimaryKey).toBe(false)
    })
  })

  // ── Sequence ──
  describe("sequences", () => {
    itAst("4 个序列，属性抽取（startWith / incrementBy / cycle）", () => {
      expect(result!.sequences).toHaveLength(4)
      const byName = Object.fromEntries(result!.sequences.map(s => [s.name, s]))
      expect(byName.SEQ_ITEM_ID).toMatchObject({ startWith: 10000, incrementBy: 1, cycle: false })
      expect(byName.SEQ_INV_TXN_ID.startWith).toBe(800000)
    })
  })

  // ── Standalone procedure/function ──
  describe("standalone procedures", () => {
    itAst("独立函数 fn_abc_class：params + returnType", () => {
      expect(result!.standaloneProcedures).toHaveLength(1)
      const fn = result!.standaloneProcedures[0]
      expect(fn.name).toBe("fn_abc_class")
      expect(fn.type).toBe("function")
      expect(fn.returnType).toBe("VARCHAR2")
      expect(fn.params).toHaveLength(3)
      expect(fn.params!.map(p => p.name)).toEqual(["p_cum_pct", "p_a_pct", "p_b_pct"])
    })

    itAst("standalone 注入虚拟包 __STANDALONE_FN_ABC_CLASS__（含 lineRange/bodyFile）", () => {
      const pkg = result!.packages.find(p => p.name === "__STANDALONE_FN_ABC_CLASS__")
      expect(pkg).toBeTruthy()
      expect(pkg!.headerFile).toBeUndefined()
      expect(pkg!.bodyFile).toBeTruthy()
      expect(pkg!.procedures).toHaveLength(1)
      const proc = pkg!.procedures[0]
      expect(proc.name).toBe("fn_abc_class")
      expect(proc.type).toBe("function")
      expect(proc.lineRange).toBeTruthy()
      expect(proc.lineRange![0]).toBeGreaterThanOrEqual(1)
      expect(proc.lineRange![1]).toBeGreaterThan(proc.lineRange![0])
    })
  })

  // ── Trigger ──
  describe("triggers", () => {
    itAst("触发器 timing / level / events / targetTable / condition", () => {
      expect(result!.triggers).toHaveLength(1)
      const trg = result!.triggers[0]
      expect(trg.name).toBe("TRG_ITEM_AUDIT")
      expect(trg.timing).toBe("after")
      expect(trg.level).toBe("row")
      expect(trg.events).toEqual(["update"]) // 仅 UPDATE，不含触发体内的 INSERT
      expect(trg.targetTable).toBe("T_ITEM")
      expect(trg.condition).toBe("OLD.std_cost <> NEW.std_cost")
    })
  })

  // ── View ──
  describe("views", () => {
    itAst("视图名 + 依赖表", () => {
      expect(result!.views).toHaveLength(1)
      const v = result!.views[0]
      expect(v.name).toBe("V_ITEM_FULL")
      expect(v.underlyingTables).toEqual(["T_ITEM"])
      expect(v.columns!.length).toBeGreaterThan(0)
    })
  })
})
