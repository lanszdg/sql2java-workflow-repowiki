/**
 * narrow-upstream-for-incremental.test.ts — 增量回环（fix→review/verify，非分片）upstream 收窄测试
 *
 * 核心回归点：fix 之后的 review/verify 只重审 fixedPackages，worker 不应再读到全量包的
 * analysis-packages / translations / verify.json——压缩可见视野，省 LLM token。
 * 第一次 review（主线，无 targetPackages）不收窄，保持全量。
 */

import { describe, it, expect } from "vitest"
import { narrowUpstreamForIncremental } from "@plugins/workflow-engine"
import { UPSTREAM_ARTIFACTS } from "@workflow/workflow-definitions"

describe("narrowUpstreamForIncremental", () => {
  it("fix(review 触发): analysis-packages + translations + verify.json 收窄到 fixedPackages，全局 artifact 保留", () => {
    // 本函数只负责 per-package glob 收窄；review/verify-summary 的二选一过滤由 dispatch 层在
    // 调用前完成（见 workflow-engine.ts fix 阶段 branchedFrom 过滤）。此处用原始 fix upstream 验证
    // per-package glob 行为，两个 summary 都在原样保留之列。
    const upstream = UPSTREAM_ARTIFACTS.fix
    const result = narrowUpstreamForIncremental(upstream, ["COSTING", "INVENTORY"])

    // per-package glob 展开为 fixedPackages 各包
    expect(result).toContain("analysis-packages/COSTING.json")
    expect(result).toContain("analysis-packages/INVENTORY.json")
    expect(result).toContain("translations/COSTING/translation.json")
    expect(result).toContain("translations/INVENTORY/translation.json")
    expect(result).toContain("translations/COSTING/verify.json")
    expect(result).toContain("translations/INVENTORY/verify.json")

    // glob 已消除
    expect(result).not.toContain("analysis-packages/*.json")
    expect(result).not.toContain("translations/*/translation.json")
    expect(result).not.toContain("translations/*/verify.json")

    // 不含其他包
    expect(result).not.toContain("analysis-packages/PRICING.json")
    expect(result).not.toContain("translations/PRICING/translation.json")
    expect(result).not.toContain("translations/PRICING/verify.json")

    // 全局只读 artifact 原样保留
    expect(result).toContain("plan.json")
    expect(result).toContain("scaffold.json")
    expect(result).toContain("dedup.json")
    expect(result).toContain("review-static.json")
    expect(result).toContain("review.json")
    expect(result).toContain("review-summary.json")
  })

  it("fix(verify 触发): verify-summary.json 由 dispatch 层保留，per-package glob 仍收窄", () => {
    // 模拟 dispatch 层已剔除 review-summary.json 后的 fix upstream
    const upstream = UPSTREAM_ARTIFACTS.fix.filter(a => a !== "review-summary.json")
    const result = narrowUpstreamForIncremental(upstream, ["COSTING"])

    expect(result).toContain("verify-summary.json")
    expect(result).toContain("translations/COSTING/verify.json")
    expect(result).toContain("analysis-packages/COSTING.json")
    expect(result).not.toContain("translations/*/verify.json")
    expect(result).not.toContain("review-summary.json")
  })

  it("review 增量: analysis-packages + translations 收窄，review-static.json 保留（项目级单文件）", () => {
    const upstream = UPSTREAM_ARTIFACTS.review
    const result = narrowUpstreamForIncremental(upstream, ["COSTING"])

    expect(result).toContain("analysis-packages/COSTING.json")
    expect(result).toContain("translations/COSTING/translation.json")
    expect(result).not.toContain("analysis-packages/*.json")
    expect(result).not.toContain("translations/*/translation.json")
    expect(result).not.toContain("analysis-packages/PRICING.json")
    // 项目级单文件不动
    expect(result).toContain("review-static.json")
    expect(result).toContain("plan.json")
    expect(result).toContain("dedup.json")
  })

  it("verify 增量: translations 收窄到 fixedPackages", () => {
    const upstream = UPSTREAM_ARTIFACTS.verify
    const result = narrowUpstreamForIncremental(upstream, ["COSTING", "INVENTORY"])

    expect(result).toContain("translations/COSTING/translation.json")
    expect(result).toContain("translations/INVENTORY/translation.json")
    expect(result).not.toContain("translations/*/translation.json")
    expect(result).not.toContain("translations/PRICING/translation.json")
    // 全局 artifact 保留
    expect(result).toContain("plan.json")
    expect(result).toContain("scaffold.json")
    expect(result).toContain("dedup.json")
  })

  it("fixedPackages 空 → 原样返回（防御，不收窄）", () => {
    const upstream = UPSTREAM_ARTIFACTS.fix
    expect(narrowUpstreamForIncremental(upstream, [])).toEqual(upstream)
    expect(narrowUpstreamForIncremental(upstream, ["", "  "] as unknown as string[])).toEqual(upstream)
  })

  it("多个 per-package glob 共存时各自独立展开", () => {
    const upstream = [
      "plan.json",
      "analysis-packages/*.json",
      "translations/*/translation.json",
      "translations/*/verify.json",
      "dedup.json",
    ]
    const result = narrowUpstreamForIncremental(upstream, ["A", "B"])
    expect(result).toEqual([
      "plan.json",
      "analysis-packages/A.json",
      "analysis-packages/B.json",
      "translations/A/translation.json",
      "translations/B/translation.json",
      "translations/A/verify.json",
      "translations/B/verify.json",
      "dedup.json",
    ])
  })
})
