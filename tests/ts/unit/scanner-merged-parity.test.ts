import { describe, it, expect } from "vitest"
import { scanSource, type InventoryIndex } from "@workflow/plsql-scanner"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "../../..")
const RES = resolve(ROOT, "resources")

/**
 * 回归守卫：header+body 合并文件格式（pkg/<name>.sql 同时含包头与包体）下，
 * scanWithAST 必须仍走 AST 抽取结构，不能因 grammar 缺口整文件降级。
 *
 * 修复前症状：合并文件 → 降级 → 子程序 parameters 全 undefined、types/vars/consts 全 0、
 * 重载过程被去重少算。本测试用真实资源项目 mfg_erp_sql / mfg_erp_sql_tiny（均为合并格式）锁定这些字段。
 *
 * 新形状：packages.procedures/functions 仅为名字数组，详情在 inv.subprograms（parameters/bodyLocation/returnType）。
 */
describe("scanner 合并包文件格式支持(header+body 同文件)", () => {
  it("合并格式下每个子程序 parameters 被 AST 抽取(非 undefined)", async () => {
    for (const dir of ["mfg_erp_sql_tiny", "mfg_erp_sql"]) {
      const inv = await scanSource(resolve(RES, dir))
      expect(inv.scannerUsed, `${dir} 应走 AST`).toBe("ast")
      for (const sub of inv.subprograms) {
        expect(Array.isArray(sub.parameters), `${dir}/${sub.belongToPackage}.${sub.name} parameters 应被 AST 抽取`).toBe(true)
      }
    }
  }, 120000)

  it("tiny: CORE_PKG 重载过程不被去重(含 create_item 两个版本)，bodyLocation.lineRange 指向真实行", async () => {
    const inv = await scanSource(resolve(RES, "mfg_erp_sql_tiny"))
    const coreSubs = inv.subprograms.filter(s => s.belongToPackage === "CORE_PKG")
    // 12 = header 中声明的 11 个 + create_item 重载第 2 版；修复前降级去重为 11
    expect(coreSubs.length).toBe(12)
    const file = readFileSync(resolve(RES, "mfg_erp_sql_tiny/pkg/core_pkg.sql"), "utf-8").split("\n")
    for (const sub of coreSubs) {
      expect(sub.bodyLocation?.lineRange, `${sub.name} 应有 bodyLocation.lineRange`).toBeDefined()
      const [s] = sub.bodyLocation!.lineRange
      // lineRange 起始行落在合并文件中该过程定义处（验证 body 段行号偏移正确）
      expect(file[s - 1]).toMatch(new RegExp(`\\b${sub.name}\\b`, "i"))
    }
  })

  it("tiny: 合并格式抽取完整结构(types/vars/consts/returnType)", async () => {
    const inv = await scanSource(resolve(RES, "mfg_erp_sql_tiny"))
    const core = inv.packages.find(p => p.packageName === "CORE_PKG")!
    expect(core.types?.length).toBe(2)        // t_recv_line RECORD + t_recv_tab TABLE
    expect(core.variables?.length).toBe(1)    // g_biz_date
    const coreSubs = inv.subprograms.filter(s => s.belongToPackage === "CORE_PKG")
    expect(coreSubs.filter(s => s.returnType != null).length).toBe(5) // 5 个 FUNCTION
    const base = inv.packages.find(p => p.packageName === "BASE_PKG")!
    expect(base.constants?.length).toBe(5)    // 修复前 consts 全 0
  })

  it("big: 业务包 bodyLocation.lineRange 指向合并文件真实行(抽样 costing_pkg)", async () => {
    const inv: InventoryIndex = await scanSource(resolve(RES, "mfg_erp_sql"))
    const costingSubs = inv.subprograms.filter(s => s.belongToPackage === "COSTING_PKG")
    expect(costingSubs.length).toBeGreaterThan(0)
    const file = readFileSync(resolve(RES, "mfg_erp_sql/pkg/costing_pkg.sql"), "utf-8").split("\n")
    for (const sub of costingSubs) {
      expect(sub.bodyLocation?.lineRange, `${sub.name} 应有 bodyLocation.lineRange`).toBeDefined()
      const [s] = sub.bodyLocation!.lineRange
      expect(file[s - 1]).toMatch(new RegExp(`\\b${sub.name}\\b`, "i"))
    }
  }, 120000)
})
