/**
 * ensure-deps.test.ts — 依赖自动安装守卫单元测试
 *
 * 测试 findOpencodeDir / ensureDeps 的逻辑。
 * 不实际执行 npm install，mock child_process。
 *
 * TODO: 补充具体输入 → 预期输出
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { findOpencodeDir } from "@workflow/ensure-deps"

describe("ensure-deps", () => {
  describe("findOpencodeDir()", () => {
    it("返回 .opencode/ 目录路径", () => {
      const dir = findOpencodeDir()
      expect(dir).toContain(".opencode")
      // 结果是 .opencode/ 本身，不应以 workflow/ 子目录结尾
      expect(dir.endsWith(".opencode")).toBe(true)
    })
  })

  describe("ensureDeps()", () => {
    it("依赖已安装时直接返回", async () => {
      // TODO: mock checkAllInstalled 返回 true
      // 验证不调用 npm install
    })

    it("依赖缺失时自动安装", async () => {
      // TODO: mock checkAllInstalled 返回 false
      // 验证调用 npm install
    })

    it("npm 不可用时尝试 bun", async () => {
      // TODO
    })

    it("都不可用时抛错", async () => {
      // TODO
    })

    it("安装后仍不完整时抛错", async () => {
      // TODO
    })

    it("并发调用共享同一个 Promise", async () => {
      // TODO
    })
  })
})
