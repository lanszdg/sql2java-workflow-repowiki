import { describe, it, expect } from "vitest"
import { scanSource, type InventoryIndex } from "@workflow/plsql-scanner"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "../../..")
const RES = resolve(ROOT, "resources")

/**
 * 回归守卫：header+body 合并文件格式（pkg/<name>.sql 同时含包头与包体）下，
 * scanWithAST 必须仍走 AST 抽取结构，不能因 classifyFile 命中 PACKAGE BODY 而整文件降级 regex。
 *
 * 修复前症状：合并文件 → regex 降级 → procedures 的 params 全 undefined、types/vars/consts 全 0、
 * 重载过程被去重少算。本测试用真实资源项目 mfg_erp_sql / mfg_erp_sql_tiny（均为合并格式）锁定这些字段。
 */
describe("scanner 合并包文件格式支持(header+body 同文件)", () => {
  it("合并格式下每个过程 params 被 AST 抽取(非 undefined)", async () => {
    for (const dir of ["mfg_erp_sql_tiny", "mfg_erp_sql"]) {
      const inv = await scanSource(resolve(RES, dir))
      expect(inv.scannerUsed, `${dir} 应走 AST`).toBe("ast")
      for (const pkg of inv.packages) {
        for (const pr of pkg.procedures) {
          expect(Array.isArray(pr.params), `${dir}/${pkg.name}.${pr.name} params 应被 AST 抽取`).toBe(true)
        }
      }
    }
  }, 120000)

  it("tiny: CORE_PKG 重载过程不被去重(含 create_item 两个版本)，lineRange 指向真实行", async () => {
    const inv = await scanSource(resolve(RES, "mfg_erp_sql_tiny"))
    const core = inv.packages.find(p => p.name === "CORE_PKG")!
    // 12 = header 中声明的 12 个过程（create_item 重载两个都保留）；修复前 regex 去重为 11
    expect(core.procedures.length).toBe(12)
    const file = readFileSync(resolve(RES, "mfg_erp_sql_tiny/pkg/core_pkg.sql"), "utf-8").split("\n")
    for (const pr of core.procedures) {
      expect(pr.lineRange, `${pr.name} 应有 lineRange`).toBeDefined()
      // lineRange 起始行落在合并文件中该过程定义处（验证 body 段行号偏移正确）
      expect(file[pr.lineRange![0] - 1]).toMatch(new RegExp(`\\b${pr.name}\\b`, "i"))
    }
  })

  it("tiny: 合并格式抽取完整结构(types/vars/consts/returnType)", async () => {
    const inv = await scanSource(resolve(RES, "mfg_erp_sql_tiny"))
    const core = inv.packages.find(p => p.name === "CORE_PKG")!
    expect(core.types?.length).toBe(2)        // t_recv_line RECORD + t_recv_tab TABLE
    expect(core.variables?.length).toBe(1)    // g_biz_date
    expect(core.procedures.filter(p => p.returnType != null).length).toBe(5) // 5 个 FUNCTION
    const base = inv.packages.find(p => p.name === "BASE_PKG")!
    expect(base.constants?.length).toBe(5)    // 修复前 consts 全 0
  })

  it("big: 业务包 lineRange 指向合并文件真实行(抽样 costing_pkg)", async () => {
    const inv: InventoryIndex = await scanSource(resolve(RES, "mfg_erp_sql"))
    const costing = inv.packages.find(p => p.name === "COSTING_PKG")!
    const file = readFileSync(resolve(RES, "mfg_erp_sql/pkg/costing_pkg.sql"), "utf-8").split("\n")
    for (const pr of costing.procedures) {
      expect(pr.lineRange, `${pr.name} 应有 lineRange`).toBeDefined()
      expect(file[pr.lineRange![0] - 1]).toMatch(new RegExp(`\\b${pr.name}\\b`, "i"))
    }
  }, 120000)
})
