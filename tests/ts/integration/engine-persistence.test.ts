/**
 * engine-persistence.test.ts — 持久化集成测试
 *
 * 测试 run.json 磁盘读写、artifactCache、_events.log。
 *
 * TODO: 补充具体输入 → 预期输出
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { WorkflowEngine } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

describe("engine-persistence", () => {
  describe("run.json 持久化", () => {
    it("start 后 run.json 存在且内容有效", () => {
      const ctx = createEngineWithTempDir()
      try {
        ctx.engine.start("sql2java", "persist-001")
        const runPath = join(ctx.dir, "persist-001", "run.json")
        expect(existsSync(runPath)).toBe(true)

        const parsed = JSON.parse(readFileSync(runPath, "utf-8"))
        expect(parsed.runId).toBe("persist-001")
        expect(parsed.status).toBe("running")
      } finally {
        ctx.cleanup()
      }
    })

    it("advance 后 run.json 更新", () => {
      // TODO: advance 后验证磁盘上的 run.json 反映新阶段
    })

    it("abort 后 run.json 反映 aborted 状态", () => {
      // TODO
    })

    it("completed 后 run.json 反映 completed 状态", () => {
      // TODO
    })
  })

  describe("loadFromDisk", () => {
    it("有效 JSON 加载成功，字段完整", () => {
      // TODO: 已在 engine-core.test.ts 覆盖，此处补充深度校验
    })

    it("无效 JSON 抛 CORRUPTED", () => {
      // TODO: 已在 engine-core.test.ts 覆盖
    })

    it("文件不存在抛 NOT_FOUND", () => {
      // TODO: 已在 engine-core.test.ts 覆盖
    })

    it("schema 不匹配抛 VALIDATION_FAILED", () => {
      // TODO: 已在 engine-core.test.ts 覆盖
    })
  })

  describe("artifactCache", () => {
    it("同一 advance 周期内缓存命中", () => {
      // TODO: 已在 engine-core.test.ts 覆盖
    })

    it("advance 之间缓存清除", () => {
      // TODO: 已在 engine-core.test.ts 覆盖
    })
  })

  describe("_events.log", () => {
    it("START 事件格式正确", () => {
      const ctx = createEngineWithTempDir()
      try {
        ctx.engine.start("sql2java", "event-001")
        const logPath = join(ctx.dir, "event-001", "_events.log")
        expect(existsSync(logPath)).toBe(true)
        const content = readFileSync(logPath, "utf-8")
        expect(content).toContain("[START]")
      } finally {
        ctx.cleanup()
      }
    })

    it("ADVANCE 事件包含阶段信息", () => {
      // TODO
    })

    it("ABORT 事件记录", () => {
      // TODO
    })
  })
})
