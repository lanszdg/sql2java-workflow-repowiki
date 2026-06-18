/**
 * inventory-builder.test.ts — 验证 prescan index → 下游 inventory artifacts 的纯代码转换
 *
 * inventory 阶段零 LLM 的核心：scanSource 产出 inventory-index.json（全字段）后，
 * buildInventoryFromIndex 直接生成 inventory-packages/{PKG}.json + inventory.json，
 * 产物须通过 InventoryPackageSchema / InventorySchema 校验，且下游可消费。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { InventoryPackageSchema, InventorySchema } from "@workflow/artifact-schemas"
import { resolve } from "node:path"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "inv-builder-"))
  // 复刻 start 的前半段：prescan → 写 inventory-index.json
  const index = await scanSource(FIXTURE_TINY)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
}, 60000)

afterAll(() => {
  // tmpdir 由 OS 清理，略
})

describe("buildInventoryFromIndex", () => {
  it("生成 inventory-packages/ 逐包文件 + inventory.json", () => {
    const r = buildInventoryFromIndex(dir)
    expect(r.packageCount).toBe(2)
    expect(r.tableCount).toBe(6)
    const pkgFiles = readdirSync(join(dir, "inventory-packages")).filter(f => f.endsWith(".json"))
    expect(pkgFiles.map(f => f.replace(".json", "")).sort()).toEqual(["BASE_PKG", "CORE_PKG"])
    expect(existsSync(join(dir, "inventory.json"))).toBe(true)
  })

  it("inventory-packages 文件通过 InventoryPackageSchema 校验", () => {
    const pkgDir = join(dir, "inventory-packages")
    for (const f of readdirSync(pkgDir)) {
      const parsed = JSON.parse(readFileSync(join(pkgDir, f), "utf-8"))
      expect(InventoryPackageSchema.safeParse(parsed).success, `${f} 校验失败`).toBe(true)
    }
  })

  it("inventory.json 通过 InventorySchema 校验", () => {
    const inv = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf-8"))
    expect(InventorySchema.safeParse(inv).success).toBe(true)
  })

  it("inventory.json packageNames 覆盖所有包", () => {
    const inv = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf-8"))
    expect(inv.packageNames.sort()).toEqual(["BASE_PKG", "CORE_PKG"])
  })

  it("CORE_PKG 逐包文件含 procedures（含重载）+ types + variables", () => {
    const core = JSON.parse(readFileSync(join(dir, "inventory-packages", "CORE_PKG.json"), "utf-8"))
    expect(core.procedures.length).toBe(12)
    expect(core.procedures.filter((p: any) => p.name === "create_item").length).toBe(2)
    expect(core.types.length).toBe(2)
    expect(core.variables.length).toBe(1)
    // 参数 + returnType 已从 prescan 带过来
    const getItem = core.procedures.find((p: any) => p.name === "get_item")
    expect(getItem.returnType).toBe("t_item%ROWTYPE")
    expect(getItem.params[0]).toEqual({ name: "p_id", oracleType: "NUMBER", direction: "IN" })
  })

  it("BASE_PKG 逐包文件：spec-only，5 常量、0 procedure", () => {
    const base = JSON.parse(readFileSync(join(dir, "inventory-packages", "BASE_PKG.json"), "utf-8"))
    expect(base.procedures).toHaveLength(0)
    expect(base.constants).toHaveLength(5)
    expect(base.bodyFile).toBeNull()
  })

  it("inventory.json 含 tables columns + triggers + sequences + standalone", () => {
    const inv = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf-8"))
    const tItem = inv.tables.find((t: any) => t.name === "T_ITEM")
    expect(tItem.columns.length).toBe(10)
    expect(tItem.columns.find((c: any) => c.name === "item_id")).toMatchObject({ isPrimaryKey: true, nullable: false })
    expect(inv.triggers[0]).toMatchObject({ timing: "after", level: "row", targetTable: "T_ITEM", events: ["update"] })
    expect(inv.sequences.length).toBe(4)
    expect(inv.standaloneProcedures[0]).toMatchObject({ name: "fn_abc_class", type: "function", returnType: "VARCHAR2" })
  })
})
