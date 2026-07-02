/**
 * phase-prerequisites.test.ts — PHASE_PREREQUISITES 数据完整性（§5 地基测试）
 *
 * 执行点测试靠 --phases / resume 跳到目标 phase，前置校验错则跳错 phase。
 * 此处校验 PHASE_PREREQUISITES（.opencode/workflow/workflow-definitions.ts:159）的完整性
 * 与结构正确性，与现有 workflow-definitions.test.ts 的 inventory/fix 用例互补。
 */

import { describe, it, expect } from "vitest"
import { PHASE_PREREQUISITES, SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"

/** 非首个阶段（inventory 无前置） */
const PHASES_WITH_PREREQS = SQL2JAVA_WORKFLOW.phases.map(p => p.name).filter(n => n !== "inventory")

describe("PHASE_PREREQUISITES 完整性", () => {
  it("inventory 无前置依赖", () => {
    expect(PHASE_PREREQUISITES.inventory).toBeUndefined()
  })

  it("除 inventory 外每个阶段都有前置项", () => {
    for (const phase of PHASES_WITH_PREREQS) {
      expect(PHASE_PREREQUISITES[phase], `阶段 ${phase} 应有前置项`).toBeDefined()
      expect(PHASE_PREREQUISITES[phase].length, `阶段 ${phase} 前置项非空`).toBeGreaterThan(0)
    }
  })

  it("每个前置项是 string 或 string[]（OR-group）", () => {
    for (const phase of PHASES_WITH_PREREQS) {
      for (const item of PHASE_PREREQUISITES[phase]) {
        const ok = typeof item === "string" || (Array.isArray(item) && item.every(x => typeof x === "string"))
        expect(ok, `${phase} 的前置项 ${JSON.stringify(item)} 应为 string 或 string[]`).toBe(true)
      }
    }
  })
})

describe("PHASE_PREREQUISITES OR-group（fix 的 summary 二选一）", () => {
  it("fix 的前置含 [review-summary.json, verify-summary.json] OR-group", () => {
    const fixPrereqs = PHASE_PREREQUISITES.fix!
    const orGroup = fixPrereqs.find(
      item => Array.isArray(item) && item.includes("review-summary.json") && item.includes("verify-summary.json"),
    )
    expect(orGroup, "fix 应有 review-summary|verify-summary OR-group").toBeDefined()
  })
})

describe("PHASE_PREREQUISITES 关键前置项", () => {
  it("review 依赖 plan + scaffold + analysis", () => {
    const review = PHASE_PREREQUISITES.review!
    expect(review).toContain("plan.json")
    expect(review).toContain("scaffold.json")
    expect(review).toContain("analysis-packages")
  })

  it("verify 依赖 plan + scaffold", () => {
    const verify = PHASE_PREREQUISITES.verify!
    expect(verify).toContain("plan.json")
    expect(verify).toContain("scaffold.json")
  })

  it("translate 依赖 inventory + analysis + plan + scaffold", () => {
    const translate = PHASE_PREREQUISITES.translate!
    expect(translate).toContain("inventory.json")
    expect(translate).toContain("packages")
    expect(translate).toContain("subprograms")
    expect(translate).toContain("analysis-packages")
    expect(translate).toContain("plan.json")
    expect(translate).toContain("scaffold.json")
  })
})
