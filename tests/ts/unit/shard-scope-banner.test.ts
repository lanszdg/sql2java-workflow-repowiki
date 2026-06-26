/**
 * shard-scope-banner.test.ts — worker 系统提示分片硬约束 banner 测试
 *
 * 确定性兜底：编排者可能自撰通用任务提示（"处理所有子程序"），与分片隔离冲突。
 * buildShardScopeBanner 注入 worker 系统提示最前，明确 targetUnits 是唯一工作清单，
 * 并显式声明忽略任务提示中的全量措辞。
 */

import { describe, it, expect } from "vitest"
import { buildShardScopeBanner } from "@plugins/workflow-engine"
import type { WorkflowRun } from "@workflow/engine-core"

function makeRun(ic: Record<string, unknown> | undefined): WorkflowRun {
  return {
    runId: "test-banner",
    currentPhase: "analyze",
    status: "running",
    phaseHistory: [{
      phase: "analyze",
      status: "in_progress",
      startedAt: "t",
      retryCount: 0,
      incrementalContext: ic,
    }],
    metadata: {},
    createdAt: "t",
    updatedAt: "t",
  } as unknown as WorkflowRun
}

describe("buildShardScopeBanner", () => {
  it("unit 模式（targetUnits）：banner 含 targetUnits + 切片读取 + 忽略全量措辞", () => {
    const banner = buildShardScopeBanner(makeRun({
      targetUnits: ["CORE_PKG.get_bom_components"], shardIndex: 4, totalShards: 13,
    }))
    expect(banner).toContain("分片范围硬约束")
    expect(banner).toContain('PROCEDURE 单元 ["CORE_PKG.get_bom_components"]')
    expect(banner).toContain("分片 5/13")
    expect(banner).toContain("shard-inputs/{pkg}/{ref}/")
    expect(banner).toContain("禁止 read 整包 body/spec")
    // 显式声明忽略任务提示的全量措辞
    expect(banner).toContain("任务提示")
    expect(banner).toContain("一律忽略")
  })

  it("包级模式（targetPackages）：banner 含包列表", () => {
    const banner = buildShardScopeBanner(makeRun({
      targetPackages: ["PKG_A", "PKG_B"], shardIndex: 0, totalShards: 3,
    }))
    expect(banner).toContain('包 ["PKG_A","PKG_B"]')
    expect(banner).toContain("分片 1/3")
    expect(banner).not.toContain("shard-inputs") // 包级不引导切片
  })

  it("无 incrementalContext / targetUnits 与 targetPackages 均空 → 返回空串", () => {
    expect(buildShardScopeBanner(makeRun(undefined))).toBe("")
    expect(buildShardScopeBanner(makeRun({ shardIndex: 0, totalShards: 2 }))).toBe("")
    expect(buildShardScopeBanner(makeRun({ targetUnits: [], targetPackages: [] }))).toBe("")
  })
})
