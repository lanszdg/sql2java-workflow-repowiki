/**
 * shard-plan.test.ts — computeShardPlan 切分策略单元测试
 *
 * 锁定两条关键不变量：
 * 1. SCC 组（length > 1 的层）原子不可分——绝不拆到不同分片
 * 2. 独立单包按拓扑序贪心打包到 maxPackagesPerShard 上限
 */

import { describe, it, expect } from "vitest"
import { WorkflowEngine } from "@workflow/engine-core"

function plan(order: string[][][], max: number) {
  const engine = new WorkflowEngine()
  // computeShardPlan 是纯函数（不依赖实例状态），直接调用
  return (engine as any).computeShardPlan(order, max, "translate")
}

function shardsFor(order: string[][], max: number, phase: string) {
  const engine = new WorkflowEngine()
  const eff = (engine as any).shardOrderForPhase(order, phase)
  return (engine as any).computeShardPlan(eff, max, phase).shards as string[][]
}

describe("computeShardPlan", () => {
  it("独立单包按 maxPackagesPerShard 贪心打包", () => {
    // 6 个独立包（各为单元素层），max=3 → 两个分片各 3 包
    const order = [["A"], ["B"], ["C"], ["D"], ["E"], ["F"]]
    const p = plan(order, 3)
    expect(p.shards).toEqual([["A", "B", "C"], ["D", "E", "F"]])
    expect(p.completedShards).toEqual([])
    expect(p.phase).toBe("translate")
  })

  it("SCC 组不被拆分：超过 max 的 SCC 整组作为超大分片", () => {
    // 5 包 SCC 组，max=3 → 不可拆，整组一个分片
    const order = [["A", "B", "C", "D", "E"]]
    const p = plan(order, 3)
    expect(p.shards).toEqual([["A", "B", "C", "D", "E"]])
  })

  it("SCC 组与相邻独立包可同分片（不超限时不强制拆）", () => {
    // A 独立 + [X,Y] SCC，1+2=3 ≤ max=3 → 同分片
    const order = [["A"], ["X", "Y"]]
    const p = plan(order, 3)
    expect(p.shards).toEqual([["A", "X", "Y"]])
  })

  it("SCC 组放不下剩余容量时整组移到新分片，不拆", () => {
    // [A,B] SCC + [X,Y,Z] SCC，2+3=5 > max=3 → 第一分片 [A,B]，第二分片 [X,Y,Z]
    const order = [["A", "B"], ["X", "Y", "Z"]]
    const p = plan(order, 3)
    expect(p.shards).toEqual([["A", "B"], ["X", "Y", "Z"]])
  })

  it("混合：独立包打包 + SCC 组原子，拓扑序保持", () => {
    // A,B 独立 → [A,B]（2 包）；[X,Y] SCC 加入会超 3 → 整组移到新分片；
    // C 独立，2+1=3 ≤ max → 并入 [X,Y,C]；D,E 独立 → [D,E]
    const order = [["A"], ["B"], ["X", "Y"], ["C"], ["D"], ["E"]]
    const p = plan(order, 3)
    expect(p.shards).toEqual([["A", "B"], ["X", "Y", "C"], ["D", "E"]])
    // SCC 组 [X,Y] 始终在同一分片内，未被拆分
    expect(p.shards.flat()).toEqual(["A", "B", "X", "Y", "C", "D", "E"])
  })

  it("单包项目（总包数 ≤ max）只产生一个分片", () => {
    const order = [["A"], ["B"]]
    const p = plan(order, 3)
    expect(p.shards).toEqual([["A", "B"]])
  })

  it("空层被跳过", () => {
    const order = [["A"], [], ["B"]]
    const p = plan(order, 3)
    expect(p.shards).toEqual([["A", "B"]])
  })

  it("保留拓扑序：分片内与分片间均按 translationOrder 顺序", () => {
    const order = [["A"], ["B"], ["C"], ["D"], ["E"]]
    const p = plan(order, 2)
    // max=2 → [A,B],[C,D],[E]
    expect(p.shards).toEqual([["A", "B"], ["C", "D"], ["E"]])
    // 扁平化后应与原始拓扑序一致
    expect(p.shards.flat()).toEqual(["A", "B", "C", "D", "E"])
  })
})

describe("shardOrderForPhase（analyze/review 拍平 SCC，translate 保留）", () => {
  // 含一个 5 包 SCC 组 + 一个 2 包 SCC 组 + 若干独立包（取自真实 13 包项目 translationOrder）
  const order = [
    ["CONST"], ["UTIL"],
    ["ITEM", "BOM", "PRICING", "FORECAST", "REPORT"],
    ["INVENTORY"],
    ["COSTING", "PROCUREMENT"],
    ["MRP"],
  ]

  it("analyze: 拍平 SCC → 每包一个分片，0 多包分片", () => {
    const shards = shardsFor(order, 1, "analyze")
    expect(shards.length).toBe(11)
    expect(shards.every(s => s.length === 1)).toBe(true)
    // 拓扑序保留（SCC 组内成员按原顺序逐个成片）
    expect(shards.flat()).toEqual(order.flat())
  })

  it("review: 同 analyze，拍平 SCC → 每包一个分片", () => {
    const shards = shardsFor(order, 1, "review")
    expect(shards.length).toBe(11)
    expect(shards.every(s => s.length === 1)).toBe(true)
  })

  it("translate: 保留 SCC 共处 → 2 个多包分片（5 包组 + 2 包组）", () => {
    const shards = shardsFor(order, 1, "translate")
    const multi = shards.filter(s => s.length > 1)
    expect(multi).toEqual([
      ["ITEM", "BOM", "PRICING", "FORECAST", "REPORT"],
      ["COSTING", "PROCUREMENT"],
    ])
  })
})

describe("shardOrderForPhase（analyze PROCEDURE 级：unit 拍平）", () => {
  // analyze 下沉到 PROCEDURE 级后，dispatch 传入 procedureOrder（unit id `PKG.refName`）。
  // shardOrderForPhase 对 analyze 拍平 → 每 unit 一分片（同包多 unit 也拆开，FSD 独立产出可拆 SCC）。
  const unitOrder = [
    ["PKG_A.p1"],
    ["PKG_A.p2", "PKG_A.p3"], // 同包 SCC 组（互递归 unit）
    ["PKG_B.q1"],
  ]

  it("analyze: unit 级拍平 → 每 unit 一分片，SCC 组内 unit 也拆开", () => {
    const shards = shardsFor(unitOrder, 1, "analyze")
    expect(shards.length).toBe(4)
    expect(shards.every(s => s.length === 1)).toBe(true)
    expect(shards.flat()).toEqual(["PKG_A.p1", "PKG_A.p2", "PKG_A.p3", "PKG_B.q1"])
  })
})
