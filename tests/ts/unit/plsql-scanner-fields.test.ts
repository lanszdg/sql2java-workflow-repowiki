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

// ═══════════════════════════════════════════════════════════════
// 大小写不敏感关键字（真实项目常用小写关键字 create/package/procedure）
// grammar 声明 caseInsensitive=true 但 antlr4ts 4.7.2 忽略；scanner 用 UpperCaseCharStream
// 包装 lexer 输入（只转 LA，保留原文）实现大小写不敏感匹配。
// ═══════════════════════════════════════════════════════════════

describe("plsql-scanner 大小写不敏感关键字", () => {
  it("小写关键字 + 小写字符串值：结构抽取正常，字符串原文保留", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-lower-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/lower_pkg.sql`, `create or replace package body lower_pkg as
  c_msg constant varchar2(20) := 'hello world';
  procedure entry_proc is
  begin
    helper_proc('test');
  end;
  procedure helper_proc(p_msg varchar2) is begin null; end;
end;
/`, "utf-8")
    try {
      const inv = await scanWithAST([tmp], tmp)
      expect(inv.scannerUsed).toBe("ast")
      const pkg = inv.packages.find(p => p.packageName === "LOWER_PKG")
      expect(pkg, "小写关键字包应被识别").toBeDefined()
      // 字符串常量值原文保留（getText 取原文，仅 LA 转大写）
      const c = pkg!.constants.find(x => x.name === "C_MSG")
      expect(c?.value).toBe("'hello world'")
      // 同包裸名调用边
      const entry = inv.subprograms.find(s => s.name === "ENTRY_PROC")
      expect(entry?.directCalls.some(d => d.name === "HELPER_PROC")).toBe(true)
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})

describe("plsql-scanner standalone CREATE directCalls 捕获", () => {
  it("standalone CREATE PROCEDURE 体内的跨包调用被捕获进 directCalls（不再恒空）", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-standalone-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/pkgs.sql`, `CREATE OR REPLACE PACKAGE etl_pkg AS
  PROCEDURE run(p_id NUMBER);
END etl_pkg;
/
CREATE OR REPLACE PACKAGE BODY etl_pkg AS
  PROCEDURE run(p_id NUMBER) IS BEGIN NULL; END;
END etl_pkg;
/
CREATE OR REPLACE PACKAGE other_pkg AS
  PROCEDURE helper(p_id NUMBER);
END other_pkg;
/
CREATE OR REPLACE PACKAGE BODY other_pkg AS
  PROCEDURE helper(p_id NUMBER) IS BEGIN NULL; END;
END other_pkg;
/`, "utf-8")
    writeFileSync(`${tmp}/standalone.sql`, `CREATE OR REPLACE PROCEDURE do_migrate(p_id IN NUMBER) IS
BEGIN
  etl_pkg.run(p_id);
  other_pkg.helper(p_id);
END do_migrate;
/`, "utf-8")
    try {
      const inv = await scanWithAST([tmp], tmp)
      const sub = inv.subprograms.find(s => s.belongToPackage === "__STANDALONE_DO_MIGRATE__")
      expect(sub, "standalone 虚拟包子程序应存在").toBeDefined()
      // 修复前 directCalls 恒空（enterCreate_procedure_body 不压 subprogramStack，体内调用被早退丢弃）
      expect(sub!.directCalls.map(d => `${d.package}.${d.name}`).sort()).toEqual(
        ["ETL_PKG.RUN", "OTHER_PKG.HELPER"]
      )
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})

describe("plsql-scanner 嵌套局部过程不泄漏为包级", () => {
  it("过程体内嵌套定义的局部过程不注册为包级子程序，其调用卷回外层", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-nested-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/pkg.sql`, `CREATE OR REPLACE PACKAGE outer_pkg AS
  PROCEDURE main_proc(p_id NUMBER);
  PROCEDURE real_proc(p_id NUMBER);
END outer_pkg;
/
CREATE OR REPLACE PACKAGE BODY outer_pkg AS
  PROCEDURE real_proc(p_id NUMBER) IS BEGIN NULL; END;
  PROCEDURE main_proc(p_id NUMBER) IS
    PROCEDURE local_helper(x NUMBER) IS
    BEGIN
      real_proc(x);
    END;
  BEGIN
    local_helper(p_id);
  END main_proc;
END outer_pkg;
/`, "utf-8")
    try {
      const inv = await scanWithAST([tmp], tmp)
      const pkgSubs = inv.subprograms.filter(s => s.belongToPackage === "OUTER_PKG")
      const names = pkgSubs.map(s => s.name).sort()
      // 修复前 local_helper 被注册为包级子程序（污染）；修复后仅 main_proc + real_proc
      expect(names).toEqual(["MAIN_PROC", "REAL_PROC"])
      // local_helper 体内的 real_proc 调用应卷回 main_proc（不是丢失，也不是 local_helper 节点）
      const main = pkgSubs.find(s => s.name === "MAIN_PROC")!
      expect(main.directCalls.some(d => d.name === "REAL_PROC")).toBe(true)
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})

describe("plsql-scanner 表列提取：SQL*Plus 关键字列名 + 块注释", () => {
  it("CREATE TABLE 中以 EXIT/SET 命名的列不被 SQL*Plus strip 误剥；块注释不产幻影列", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-cols-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/tab.sql`, `SET SERVEROUTPUT ON
CREATE TABLE t_meta (
  id NUMBER NOT NULL,
  /* 这是 EXIT 列，非 SQL*Plus EXIT 命令
     多行注释中间行 col_phantom NUMBER 不应成列 */
  EXIT VARCHAR2(10),
  SET_FLAG NUMBER,
  name VARCHAR2(40)
);
/
EXIT`, "utf-8")
    try {
      const inv = await scanWithAST([tmp], tmp)
      const tab = inv.tables.find(t => t.name === "T_META")!
      expect(tab, "表应被提取").toBeDefined()
      const colNames = tab.columns.map(c => c.name).sort()
      expect(colNames).toEqual(["EXIT", "ID", "NAME", "SET_FLAG"])
      // 块注释中间行 col_phantom 不应成幻影列
      expect(tab.columns.find(c => c.name === "COL_PHANTOM")).toBeUndefined()
      // 顶层 SET SERVEROUTPUT ON / EXIT 仍被 strip（不影响表体外的 SQL*Plus 命令）
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})
