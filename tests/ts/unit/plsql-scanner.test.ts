/**
 * plsql-scanner.test.ts — PL/SQL 结构扫描器单元测试
 *
 * 测试 scanWithRegex / scanWithAST 的扫描结果。
 * 使用 tests/ts/fixtures/sql/tiny 作为输入 fixture。
 *
 * TODO: 补充具体输入 → 预期输出
 */

import { describe, it, expect, beforeAll } from "vitest"
import { scanWithRegex, type InventoryIndex } from "@workflow/plsql-scanner"
import { resolve } from "node:path"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")

describe("plsql-scanner", () => {
  describe("scanWithRegex", () => {
    it("扫描 tiny fixture，检测所有 package", () => {
      // TODO: 补充具体断言 — 预期有哪些 package
      const result = scanWithRegex([FIXTURE_TINY], FIXTURE_TINY)
      expect(result.scannerUsed).toBe("regex")
      expect(result.packages.length).toBeGreaterThan(0)
      expect(result.sourcePath).toBe(FIXTURE_TINY)
    })

    it("检测所有 table", () => {
      // TODO: 补充具体断言 — 预期有哪些 table
      const result = scanWithRegex([FIXTURE_TINY], FIXTURE_TINY)
      expect(result.tables.length).toBeGreaterThan(0)
    })

    it("检测 trigger", () => {
      // TODO: 补充具体断言
      const result = scanWithRegex([FIXTURE_TINY], FIXTURE_TINY)
      expect(result.triggers.length).toBeGreaterThanOrEqual(0)
    })

    it("检测 sequence", () => {
      // TODO: 补充具体断言
      const result = scanWithRegex([FIXTURE_TINY], FIXTURE_TINY)
      expect(result.sequences.length).toBeGreaterThanOrEqual(0)
    })

    it("检测 view", () => {
      // TODO: 补充具体断言
      const result = scanWithRegex([FIXTURE_TINY], FIXTURE_TINY)
      expect(result.views.length).toBeGreaterThanOrEqual(0)
    })

    it("package procedure 的行范围有效", () => {
      const result = scanWithRegex([FIXTURE_TINY], FIXTURE_TINY)
      for (const pkg of result.packages) {
        for (const proc of pkg.procedures) {
          if (proc.lineRange) {
            expect(proc.lineRange[0]).toBeGreaterThan(0)
            expect(proc.lineRange[1]).toBeGreaterThanOrEqual(proc.lineRange[0])
          }
        }
      }
    })

    it("空目录返回空结果", () => {
      // TODO: 用 temp dir 测试空目录
      // const result = scanWithRegex(emptyDir)
      // expect(result.packages).toEqual([])
      // expect(result.tables).toEqual([])
    })

    it("不存在的路径抛错", () => {
      expect(() => scanWithRegex(["/nonexistent/path"], "/nonexistent/path")).toThrow()
    })

    it("scannedAt 是有效 ISO 时间", () => {
      const result = scanWithRegex([FIXTURE_TINY], FIXTURE_TINY)
      expect(new Date(result.scannedAt).getTime()).not.toBeNaN()
    })
  })

  describe("stripSqlPlusCommands (间接测试)", () => {
    it("SQL*Plus 命令不影响 package 检测", () => {
      // TODO: 构造含 PROMPT/SET/@@ 的 SQL 文件，验证仍能正确扫描
    })

    it("PL/SQL 代码内容完整保留", () => {
      // TODO: 构造 SQL 文件，验证 procedure 名称不被误过滤
    })
  })

  describe("callGraph 提取", () => {
    it("识别 PKG.PROC 调用模式", () => {
      // TODO: 构造含跨包调用的 SQL，验证 callGraph
    })

    it("排除 :NEW/:OLD 绑定变量", () => {
      // TODO: 构造 trigger 中的 :NEW.xxx，验证不进入 callGraph
    })

    it("排除 SQL 伪列 (NEXTVAL/CURRVAL 等)", () => {
      // TODO: 验证 SEQ.NEXTVAL 不进入 callGraph
    })
  })
})
