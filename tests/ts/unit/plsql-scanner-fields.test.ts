/**
 * plsql-scanner-fields.test.ts — AST 结构抽取字段覆盖率测试
 *
 * 验证 antlr4ts listener 能确定性抽出 inventory 所需的全部结构字段
 *（parameters / returnType / types / variables / constants / columns / trigger / sequence / standalone / overload），
 * 即 inventory 阶段可下沉到 prescan、无需 LLM 的依据。
 *
 * scanner InventoryIndex 新形状：packages（packageName/headerPath/bodyPath + procedures/functions 名字数组 +
 * constants/variables/exceptions/types）+ 独立 subprograms 数组（含 parameters/bodyLocation/directCalls 等详情）。
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
    // 测试环境未安装 antlr4ts 运行时时跳过
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
    itAst("识别为 header-only 包：无 procedures/functions，有 5 个常量", () => {
      const pkg = result!.packages.find(p => p.packageName === "BASE_PKG")!
      expect(pkg.procedures).toHaveLength(0)
      expect(pkg.functions).toHaveLength(0)
      expect(pkg.constants).toHaveLength(5)
      expect(pkg.bodyPath).toBeNull()
      expect(pkg.headerPath).toBeTruthy()
    })

    itAst("常量抽取：name / type / value", () => {
      const pkg = result!.packages.find(p => p.packageName === "BASE_PKG")!
      const byName = Object.fromEntries(pkg.constants!.map(c => [c.name, c]))
      expect(byName.C_ERR_ITEM_NOT_FOUND).toEqual({
        name: "C_ERR_ITEM_NOT_FOUND", type: "VARCHAR2(16)", value: "'M1001'",
      })
      expect(byName.C_DIR_IN.type).toBe("CHAR(1)")
      expect(byName.C_LOT_AVAILABLE.value).toBe("'AVAILABLE'")
    })
  })

  // ── Package: 全构造包（core_pkg）──
  describe("CORE_PKG (全构造)", () => {
    itAst("子程序数量 = 12（11 个声明 + create_item 重载 2 版）", () => {
      const subs = result!.subprograms.filter(s => s.belongToPackage === "CORE_PKG")
      expect(subs).toHaveLength(12)
    })

    itAst("重载 create_item 保留为两条独立记录，参数数量不同", () => {
      const overloads = result!.subprograms.filter(s => s.belongToPackage === "CORE_PKG" && s.name === "CREATE_ITEM")
      expect(overloads).toHaveLength(2)
      const paramCounts = overloads.map(s => s.parameters.length).sort()
      expect(paramCounts).toEqual([4, 5])
    })

    itAst("FUNCTION 抽取 returnType（含 %ROWTYPE）+ parameters", () => {
      const getItem = result!.subprograms.find(s => s.belongToPackage === "CORE_PKG" && s.name === "GET_ITEM")!
      expect(getItem.type).toBe("FUNCTION")
      expect(getItem.returnType).toBe("t_item%ROWTYPE")
      expect(getItem.parameters).toEqual([
        { name: "P_ID", type: "NUMBER", mode: "IN", defaultExpression: null },
      ])
    })

    itAst("parameters mode：IN / OUT / IN OUT 正确", () => {
      const createItem = result!.subprograms.find(
        s => s.belongToPackage === "CORE_PKG" && s.name === "CREATE_ITEM" && s.parameters.length === 4,
      )!
      const pId = createItem.parameters.find(p => p.name === "P_ID")!
      expect(pId.mode).toBe("OUT")
      expect(createItem.parameters.find(p => p.name === "P_CODE")!.mode).toBe("IN")
    })

    itAst("UDT 参数类型保留（t_recv_tab / SYS_REFCURSOR）", () => {
      const bulk = result!.subprograms.find(s => s.belongToPackage === "CORE_PKG" && s.name === "BULK_RECEIVE")!
      expect(bulk.parameters.find(p => p.name === "P_LINES")!.type).toBe("t_recv_tab")
      const listBom = result!.subprograms.find(s => s.belongToPackage === "CORE_PKG" && s.name === "LIST_BOM")!
      expect(listBom.parameters.find(p => p.name === "P_CUR")!.type).toBe("SYS_REFCURSOR")
    })

    itAst("package 级 types 抽取（RECORD / TABLE）", () => {
      const pkg = result!.packages.find(p => p.packageName === "CORE_PKG")!
      const byName = Object.fromEntries(pkg.types!.map(t => [t.name, t.kind]))
      expect(byName.T_RECV_LINE).toBe("RECORD")
      expect(byName.T_RECV_TAB).toBe("TABLE")
    })

    itAst("package 级变量抽取（含类型）", () => {
      const pkg = result!.packages.find(p => p.packageName === "CORE_PKG")!
      expect(pkg.variables).toEqual([{ name: "G_BIZ_DATE", type: "DATE", defaultValue: null }])
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
      expect(byName.ITEM_ID.oracleType).toBe("NUMBER(18)")
      expect(byName.STD_COST.oracleType).toBe("NUMBER(20,6)")
      expect(byName.DIM.oracleType).toBe("t_dimension")   // UDT 列
      expect(byName.TAGS.oracleType).toBe("t_tag_varray") // UDT 列
    })

    itAst("nullable / isPrimaryKey / defaultValue", () => {
      const t = result!.tables.find(x => x.name === "T_ITEM")!
      const byName = Object.fromEntries(t.columns!.map(c => [c.name, c]))
      expect(byName.ITEM_ID).toMatchObject({ nullable: false, isPrimaryKey: true, defaultValue: null })
      expect(byName.ITEM_CODE).toMatchObject({ nullable: false, isPrimaryKey: false })
      expect(byName.STD_COST).toMatchObject({ nullable: true, defaultValue: "0" })
      expect(byName.STATUS).toMatchObject({ nullable: true, defaultValue: "'ACTIVE'" })
    })

    itAst("外联 PRIMARY KEY 标记对应列（含复合 PK）", () => {
      const txn = result!.tables.find(x => x.name === "T_INVENTORY_TXN")!
      const byName = Object.fromEntries(txn.columns!.map(c => [c.name, c]))
      expect(byName.TXN_ID.isPrimaryKey).toBe(true)
      expect(byName.TXN_DATE.isPrimaryKey).toBe(true)   // 复合 PK
      expect(byName.TXN_ID.nullable).toBe(false)
      expect(byName.ITEM_ID.isPrimaryKey).toBe(false)
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
    itAst("独立函数 fn_abc_class：parameters + returnType", () => {
      expect(result!.standaloneProcedures).toHaveLength(1)
      const fn = result!.standaloneProcedures[0]
      expect(fn.name).toBe("FN_ABC_CLASS")
      expect(fn.type).toBe("FUNCTION")
      expect(fn.returnType).toBe("VARCHAR2")
      expect(fn.parameters).toHaveLength(3)
      expect(fn.parameters!.map(p => p.name)).toEqual(["P_CUM_PCT", "P_A_PCT", "P_B_PCT"])
    })

    itAst("standalone 注入虚拟包 __STANDALONE_FN_ABC_CLASS__（含 bodyLocation）", () => {
      const pkg = result!.packages.find(p => p.packageName === "__STANDALONE_FN_ABC_CLASS__")
      expect(pkg).toBeTruthy()
      expect(pkg!.headerPath).toBeNull()
      expect(pkg!.bodyPath).toBeTruthy()
      const sub = result!.subprograms.find(s => s.belongToPackage === "__STANDALONE_FN_ABC_CLASS__")!
      expect(sub.name).toBe("FN_ABC_CLASS")
      expect(sub.type).toBe("FUNCTION")
      expect(sub.bodyLocation).toBeTruthy()
      expect(sub.bodyLocation!.lineRange[0]).toBeGreaterThanOrEqual(1)
      expect(sub.bodyLocation!.lineRange[1]).toBeGreaterThan(sub.bodyLocation!.lineRange[0])
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
