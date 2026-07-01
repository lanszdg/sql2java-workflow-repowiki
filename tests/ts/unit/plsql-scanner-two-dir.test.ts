/**
 * plsql-scanner-two-dir.test.ts — 双目录源码扫描单测
 *
 * 验证 scanSource({ headerPath, bodyPath })：
 * - header/body 分两个目录，按包名跨目录配对
 * - headerPath 先于 bodyPath 处理 → body-only 私有过程（check_balance_sufficient）被捕获
 * - headerFile 相对 headerPath、bodyFile 绝对路径（下游 readSource/absSrc 已兼容绝对）
 */

import { describe, it, expect } from "vitest"
import { scanSource, type InventoryIndex } from "@workflow/plsql-scanner"
import { resolve, isAbsolute } from "node:path"

const FIXTURE = resolve(import.meta.dirname, "../fixtures/sql/two-dir")
const HEADER_DIR = resolve(FIXTURE, "header")
const BODY_DIR = resolve(FIXTURE, "body")

describe("scanSource 双目录模式", () => {
  it("header/body 分两目录，按包名配对，body-only 私有过程被捕获（header 先处理）", async () => {
    const index = await scanSource({ headerPath: HEADER_DIR, bodyPath: BODY_DIR }) as InventoryIndex

    // 双目录模式：sourcePath = headerPath（主路径）
    expect(index.sourcePath).toBe(HEADER_DIR)

    const pkg = index.packages.find(p => p.name.toUpperCase() === "ACCOUNT_MANAGEMENT_PKG")
    expect(pkg, "account_management_pkg 应被跨目录配对").toBeDefined()
    if (!pkg) return

    // headerFile 相对 headerPath、bodyFile 绝对路径
    expect(pkg.headerFile).toBe("acct.sql")
    expect(pkg.bodyFile).toBeDefined()
    expect(isAbsolute(pkg.bodyFile!)).toBe(true)
    expect(pkg.bodyFile).toBe(resolve(BODY_DIR, "acct.sql"))

    // 公开过程 transfer_money：4 参数，p_status_msg 为 OUT
    const transfer = pkg.procedures.find(p => p.name === "transfer_money")
    expect(transfer, "transfer_money 应在 procedures 中").toBeDefined()
    if (transfer) {
      expect(transfer.type).toBe("procedure")
      expect(transfer.params?.length).toBe(4)
      const outParam = transfer.params?.find(p => p.name === "p_status_msg")
      expect(outParam?.direction).toBe("OUT")
    }

    // body-only 私有函数 check_balance_sufficient：header 未声明，靠 body 后补捕获
    // （若 header 后处理覆盖 body，此函数会丢失 —— 此断言验证 header-first 顺序）
    // 注：纯 body 文件走 regexFallbackForFile（非 AST），故只验 name/type/lineRange，
    // params 由 body 源码签名在 translate 阶段读取（regex 不抽 params，现有路由策略）。
    const checkBal = pkg.procedures.find(p => p.name === "check_balance_sufficient")
    expect(checkBal, "body-only 私有函数应被捕获（证明 header 先于 body 处理）").toBeDefined()
    if (checkBal) {
      expect(checkBal.type).toBe("function")
      expect(checkBal.lineRange).toBeDefined()
    }
  })

  it("单目录模式（string 入参，向后兼容）：headerFile/bodyFile 相对 sourcePath", async () => {
    // 用 header 目录作单目录（仅含声明，无 body）—— 验证 string 入参仍工作
    const index = await scanSource(HEADER_DIR) as InventoryIndex
    expect(index.sourcePath).toBe(HEADER_DIR)
    const pkg = index.packages.find(p => p.name.toUpperCase() === "ACCOUNT_MANAGEMENT_PKG")
    expect(pkg).toBeDefined()
    if (pkg) {
      // 单目录模式：headerFile 相对 sourcePath（非绝对）
      expect(pkg.headerFile).toBe("acct.sql")
      expect(isAbsolute(pkg.headerFile!)).toBe(false)
    }
  })
})
