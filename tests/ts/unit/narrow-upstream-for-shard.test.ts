/**
 * narrow-upstream-for-shard.test.ts — 分片模式 upstream 收窄测试
 *
 * 核心回归点：分片 worker 只应拿到本分片包的 per-package 文件，不能拿到全量 glob，
 * 否则会读所有包、顺手写出其他包的产物（analyze FSD / translate / review 的 per-package 文件）。
 */

import { describe, it, expect } from "vitest"
import { narrowUpstreamForShard } from "@plugins/workflow-engine"

describe("narrowUpstreamForShard", () => {
  it("analyze: inventory-packages/*.json 收窄到本分片包，全局只读 artifact 保留", () => {
    const upstream = ["inventory-index.json", "inventory.json", "inventory-packages/*.json", "analysis.json"]
    const result = narrowUpstreamForShard(upstream, "analyze", ["PKG_A"], [])
    expect(result).toContain("inventory-index.json")
    expect(result).toContain("inventory.json")
    expect(result).toContain("analysis.json")
    // 收窄到本分片包，不再有 glob
    expect(result).toContain("inventory-packages/PKG_A.json")
    expect(result).not.toContain("inventory-packages/*.json")
    // 不包含其他包
    expect(result).not.toContain("inventory-packages/PKG_B.json")
  })

  it("analyze: 多包分片都保留（SCC 共处场景），但仍不含本分片外的包", () => {
    const upstream = ["inventory-packages/*.json", "analysis.json"]
    const result = narrowUpstreamForShard(upstream, "analyze", ["PKG_A", "PKG_B"], [])
    expect(result).toEqual(expect.arrayContaining(["inventory-packages/PKG_A.json", "inventory-packages/PKG_B.json"]))
    expect(result).not.toContain("inventory-packages/PKG_C.json")
  })

  it("translate: inventory-packages + analysis-packages + fsd 都收窄到本分片包", () => {
    const upstream = [
      "inventory.json", "inventory-packages/*.json",
      "plan.json", "analysis.json", "analysis-packages/*.json", "scaffold.json",
      "fsd/*/*.md",
    ]
    const result = narrowUpstreamForShard(upstream, "translate", ["PKG_A"], [])
    expect(result).toContain("inventory-packages/PKG_A.json")
    expect(result).toContain("analysis-packages/PKG_A.json")
    expect(result).toContain("fsd/PKG_A/*.md")
    expect(result).not.toContain("inventory-packages/*.json")
    expect(result).not.toContain("analysis-packages/*.json")
    expect(result).not.toContain("fsd/*/*.md")
    // 全局只读 artifact 保留
    expect(result).toContain("plan.json")
    expect(result).toContain("scaffold.json")
  })

  it("translate: 追加已完成分片的 translation.json（跨包调用依赖）", () => {
    const upstream = ["inventory-packages/*.json", "analysis-packages/*.json", "plan.json"]
    const result = narrowUpstreamForShard(upstream, "translate", ["PKG_C"], ["PKG_A", "PKG_B"])
    expect(result).toContain("translations/PKG_A/translation.json")
    expect(result).toContain("translations/PKG_B/translation.json")
    // 本分片包的 per-package 收窄
    expect(result).toContain("inventory-packages/PKG_C.json")
    expect(result).toContain("analysis-packages/PKG_C.json")
    // 不收窄到已完成分片包的 per-package（那些用 translation.json 即可）
    expect(result).not.toContain("inventory-packages/PKG_A.json")
  })

  it("review: analysis-packages/*.json 收窄到本分片包，translations/* 收窄到本分片包（不展开已完成分片）", () => {
    // cf4ca26 后：review 只审本分片包翻译，translations/* 收窄到 targetPkgs 而非 completedPkgs，
    // 避免第一分片 completedPkgs=[] 时 glob 保留导致 worker 全审所有包。
    const upstream = ["plan.json", "scaffold.json", "analysis.json", "analysis-packages/*.json", "dedup.json", "translations/*/translation.json"]
    const result = narrowUpstreamForShard(upstream, "review", ["PKG_B"], ["PKG_A"])
    expect(result).toContain("analysis-packages/PKG_B.json")
    expect(result).not.toContain("analysis-packages/*.json")
    expect(result).toContain("translations/PKG_B/translation.json")
    expect(result).not.toContain("translations/PKG_A/translation.json")
    expect(result).not.toContain("translations/*/translation.json")
  })

  it("非分片（targetPkgs 空）：glob 原样保留，不收窄", () => {
    const upstream = ["inventory-packages/*.json", "analysis-packages/*.json", "analysis.json"]
    const result = narrowUpstreamForShard(upstream, "analyze", [], [])
    expect(result).toEqual(upstream)
  })

  it("无 glob 的 upstream 原样返回", () => {
    const upstream = ["plan.json", "scaffold.json", "dedup.json"]
    const result = narrowUpstreamForShard(upstream, "verify", ["PKG_A"], [])
    expect(result).toEqual(upstream)
  })

  it("回归核心：analyze 分片不再把全量 inventory-packages 交给 worker", () => {
    // 修复前：upstream 含 inventory-packages/*.json → worker 读全部包 → 写出其他包的 FSD
    const upstream = ["inventory.json", "inventory-packages/*.json", "analysis.json"]
    const result = narrowUpstreamForShard(upstream, "analyze", ["ONLY_THIS_PKG"], [])
    const perPkgEntries = result.filter(a => a.startsWith("inventory-packages/"))
    expect(perPkgEntries).toEqual(["inventory-packages/ONLY_THIS_PKG.json"])
  })
})

describe("narrowUpstreamForShard — translate PROCEDURE 级（unit 模式）", () => {
  const baseUpstream = [
    "inventory.json", "inventory-packages/*.json",
    "plan.json", "analysis.json", "analysis-packages/*.json", "scaffold.json",
    "fsd/*/*.md", "translations/*/translation.json",
  ]

  it("targetUnits → per-unit 切片 + 根 FSD；整包 inventory/analysis-packages 不再注入", () => {
    const result = narrowUpstreamForShard(baseUpstream, "translate", [], [], {
      targetUnits: ["PKG_A.create_order", "PKG_A.cancel_order"],
      functionOwnership: {},
    })
    // per-unit 切片（source.sql + analysis-slice.json + meta.json）
    expect(result).toContain("shard-inputs/PKG_A/create_order/source.sql")
    expect(result).toContain("shard-inputs/PKG_A/create_order/analysis-slice.json")
    expect(result).toContain("shard-inputs/PKG_A/cancel_order/source.sql")
    // 根 FSD
    expect(result).toContain("fsd/PKG_A/create_order.md")
    expect(result).toContain("fsd/PKG_A/cancel_order.md")
    // 整包不再注入（硬隔离）
    expect(result).not.toContain("inventory-packages/PKG_A.json")
    expect(result).not.toContain("analysis-packages/PKG_A.json")
    expect(result).not.toContain("inventory-packages/*.json")
    expect(result).not.toContain("fsd/*/*.md")
  })

  it("cargo FUNCTION 的 FSD 按 functionOwnership 展开", () => {
    // create_order 拥有 calc_total；cancel_order 无 cargo
    const result = narrowUpstreamForShard(baseUpstream, "translate", [], [], {
      targetUnits: ["PKG_A.create_order", "PKG_A.cancel_order"],
      functionOwnership: { "PKG_A.calc_total": "PKG_A.create_order" },
    })
    expect(result).toContain("fsd/PKG_A/create_order.md")
    expect(result).toContain("fsd/PKG_A/calc_total.md") // cargo 展开
    expect(result).toContain("fsd/PKG_A/cancel_order.md")
  })

  it("跨包 unit：切片覆盖多个包", () => {
    const result = narrowUpstreamForShard(baseUpstream, "translate", [], [], {
      targetUnits: ["PKG_A.p1", "PKG_B.p2"],
      functionOwnership: {},
    })
    expect(result).toContain("shard-inputs/PKG_A/p1/source.sql")
    expect(result).toContain("shard-inputs/PKG_B/p2/source.sql")
    expect(result).toContain("fsd/PKG_A/p1.md")
    expect(result).toContain("fsd/PKG_B/p2.md")
  })

  it("translations/*/translation.json 在 translate unit 模式下清空（依赖签名预注入）", () => {
    // 依赖改由 buildDependencySignaturesBlock 预注入，translations glob 清空
    const result = narrowUpstreamForShard(baseUpstream, "translate", [], ["PKG_A.p0", "PKG_B.q0"], {
      targetUnits: ["PKG_C.p1"],
      functionOwnership: {},
    })
    expect(result).not.toContain("translations/PKG_A/translation.json")
    expect(result).not.toContain("translations/PKG_B/translation.json")
    expect(result).not.toContain("translations/PKG_C/translation.json")
    expect(result).not.toContain("translations/*/translation.json")
  })

  it("无 targetUnits：回退包级模式（原逻辑）", () => {
    const result = narrowUpstreamForShard(baseUpstream, "translate", ["PKG_A"], ["PKG_B"])
    expect(result).toContain("inventory-packages/PKG_A.json")
    expect(result).toContain("fsd/PKG_A/*.md")
    expect(result).toContain("translations/PKG_B/translation.json")
  })
})

describe("narrowUpstreamForShard — analyze PROCEDURE 级（unit 模式，Phase 1 切片）", () => {
  const baseUpstream = ["inventory.json", "inventory-packages/*.json", "analysis.json"]

  it("targetUnits → inventory-packages/*.json 替换为 per-unit 切片文件", () => {
    const result = narrowUpstreamForShard(baseUpstream, "analyze", [], [], {
      targetUnits: ["PKG_A.proc1", "PKG_A.proc2"],
      functionOwnership: {},
    })
    // 每个 unit 的切片三件套
    expect(result).toContain("shard-inputs/PKG_A/proc1/source.sql")
    expect(result).toContain("shard-inputs/PKG_A/proc1/inventory-slice.json")
    expect(result).toContain("shard-inputs/PKG_A/proc1/meta.json")
    expect(result).toContain("shard-inputs/PKG_A/proc2/source.sql")
    // 整包 inventory-packages 不再注入（硬隔离：worker 看不到同包其他 proc）
    expect(result).not.toContain("inventory-packages/PKG_A.json")
    expect(result).not.toContain("inventory-packages/*.json")
    // 全局只读 artifact 保留（表 DDL + callGraph meta）
    expect(result).toContain("inventory.json")
    expect(result).toContain("analysis.json")
  })

  it("跨包 unit：切片覆盖多个包", () => {
    const result = narrowUpstreamForShard(baseUpstream, "analyze", [], [], {
      targetUnits: ["PKG_A.p1", "PKG_B.p2"],
      functionOwnership: {},
    })
    expect(result).toContain("shard-inputs/PKG_A/p1/source.sql")
    expect(result).toContain("shard-inputs/PKG_B/p2/source.sql")
  })
})
