/**
 * metrics-collector.test.ts — 阶段指标采集器集成测试
 *
 * 测试 PhaseMetricsCollector 的 token/cost 累计、工具调用统计、
 * finalize 业务数据提取、报告格式化。
 *
 * TODO: 补充具体输入 → 预期输出
 */

import { describe, it, expect } from "vitest"
// import { PhaseMetricsCollector, generateRunMetrics, formatPhaseReport, formatFinalReport, formatDuration } from "@workflow/phase-metrics-collector"

describe("metrics-collector", () => {
  describe("PhaseMetricsCollector", () => {
    describe("recordStepFinish", () => {
      it("记录一次 API 调用的 cost 和 tokens", () => {
        // TODO: 创建 collector，调用 recordStepFinish
        // 验证 getSnapshot().apiCallCount === 1
        // 验证 totalCost / totalTokens 累计正确
      })

      it("多次调用累计叠加", () => {
        // TODO
      })

      it("cache token 正确展平 (cache.read → cacheRead)", () => {
        // TODO
      })
    })

    describe("recordToolCalled / recordToolCompleted", () => {
      it("记录工具调用和完成", () => {
        // TODO: recordToolCalled → recordToolCompleted
        // 验证 toolCallStats[toolName].count === 1
        // 验证 durationMs 正确
      })

      it("error 状态计入 errors 计数", () => {
        // TODO
      })

      it("未知 callID 的 completed 静默忽略", () => {
        // TODO
      })
    })

    describe("finalize", () => {
      it("提取 inventory 业务数据", () => {
        // TODO: 写 inventory artifact JSON 到 temp dir
        // finalize 时提取 packageCount, tableCount 等
      })

      it("提取 review 业务数据", () => {
        // TODO
      })

      it("artifact 不存在时 business 为 undefined", () => {
        // TODO
      })

      it("计算 wallDurationMs", () => {
        // TODO
      })
    })

    describe("persist", () => {
      it("持久化 metrics JSON 到磁盘", () => {
        // TODO
      })

      it("persistAsIncomplete 标记 incomplete=true", () => {
        // TODO
      })
    })
  })

  describe("generateRunMetrics", () => {
    it("汇总所有阶段指标", () => {
      // TODO
    })

    it("计算 totalWallDurationMs", () => {
      // TODO
    })
  })

  describe("报告格式化", () => {
    it("formatDuration: 毫秒转换为可读格式", () => {
      // TODO: 1000 → "1.0s", 65000 → "1m 5.0s" 等
    })

    it("formatPhaseReport 包含关键指标", () => {
      // TODO
    })

    it("formatFinalReport 包含总汇信息", () => {
      // TODO
    })
  })
})
