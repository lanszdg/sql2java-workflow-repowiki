/**
 * workflow-logger.test.ts — 日志模块单元测试
 *
 * 测试 initLogger / getLogger / destroyLogger 的行为。
 *
 * TODO: 补充具体输入 → 预期输出
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { initLogger, getLogger, destroyLogger, type WorkflowLogger } from "@workflow/workflow-logger"

describe("workflow-logger", () => {
  afterEach(() => {
    destroyLogger()
  })

  describe("getLogger()", () => {
    it("返回 logger 实例（未初始化时不抛错）", () => {
      const logger = getLogger()
      expect(logger).toBeDefined()
      expect(logger.info).toBeTypeOf("function")
      expect(logger.warn).toBeTypeOf("function")
      expect(logger.error).toBeTypeOf("function")
    })

    it("未初始化时 info/warn/error 不抛错（静默忽略）", () => {
      const logger = getLogger()
      expect(() => {
        logger.info("TAG", "test message")
        logger.warn("TAG", "warn message")
        logger.error("TAG", "error message")
      }).not.toThrow()
    })
  })

  describe("initLogger() + 写入", () => {
    it("初始化后日志文件存在", () => {
      // TODO: 需要 mock ARTIFACT_DIR 或使用 temp dir
      // initLogger("test-run-001")
      // 验证 .workflow-artifacts/test-run-001/logs/workflow.log 存在
    })

    it("info 日志格式包含 [INFO] + tag + msg", () => {
      // TODO: 初始化后写入，读取文件验证格式
      // 预期格式: [ISO时间] [INFO] TAG message
    })

    it("warn 日志格式包含 [WARN]", () => {
      // TODO
    })

    it("error 日志格式包含 [ERROR]", () => {
      // TODO
    })
  })

  describe("destroyLogger()", () => {
    it("销毁后日志写入静默忽略", () => {
      // TODO
    })
  })
})
