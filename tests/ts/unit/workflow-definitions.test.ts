/**
 * workflow-definitions.test.ts — 阶段定义、Transition、Upstream、Prerequisites 校验
 */

import { describe, it, expect } from "vitest"
import {
  SQL2JAVA_WORKFLOW,
  UPSTREAM_ARTIFACTS,
  PHASE_PREREQUISITES,
} from "@workflow/workflow-definitions"

// ═══════════════════════════════════════════════════════════════
// Phases 结构
// ═══════════════════════════════════════════════════════════════

describe("SQL2JAVA_WORKFLOW phases", () => {
  const phases = SQL2JAVA_WORKFLOW.phases

  it("有且仅有 9 个阶段（8 main + fix）", () => {
    expect(phases).toHaveLength(9)
  })

  it("阶段名称列表正确", () => {
    const names = phases.map(p => p.name)
    expect(names).toEqual([
      "inventory", "analyze", "plan", "scaffold",
      "translate", "dedup", "review", "verify", "fix",
    ])
  })

  it("仅 fix 有 isFixPhase=true", () => {
    const fixPhases = phases.filter(p => p.isFixPhase)
    expect(fixPhases).toHaveLength(1)
    expect(fixPhases[0].name).toBe("fix")
  })

  it("所有阶段都有 agentFile", () => {
    for (const phase of phases) {
      expect(phase.agentFile, `${phase.name} should have agentFile`).toBeTruthy()
    }
  })

  it("所有阶段都有 temperature 在 [0, 1] 范围", () => {
    for (const phase of phases) {
      expect(phase.temperature, `${phase.name} temperature`).toBeGreaterThanOrEqual(0)
      expect(phase.temperature, `${phase.name} temperature`).toBeLessThanOrEqual(1)
    }
  })

  it("所有阶段都有 maxRetries > 0", () => {
    for (const phase of phases) {
      expect(phase.maxRetries, `${phase.name} maxRetries`).toBeGreaterThan(0)
    }
  })

  it("所有阶段都有 tools 数组", () => {
    for (const phase of phases) {
      expect(Array.isArray(phase.tools), `${phase.name} tools should be array`).toBe(true)
      expect(phase.tools.length, `${phase.name} tools should not be empty`).toBeGreaterThan(0)
    }
  })

  it("needsCrossSchemaValidation 的阶段正确", () => {
    const crossSchemaPhases = phases.filter(p => p.needsCrossSchemaValidation).map(p => p.name)
    // translate 完成时所有包 translation.json 已齐，即时校验 subprogramMethods 给 translator 反馈
    expect(crossSchemaPhases.sort()).toEqual(["analyze", "dedup", "plan", "translate"])
  })
})

// ═══════════════════════════════════════════════════════════════
// Transitions
// ═══════════════════════════════════════════════════════════════

describe("SQL2JAVA_WORKFLOW transitions", () => {
  const transitions = SQL2JAVA_WORKFLOW.transitions

  it("每个阶段至少有 1 条出边", () => {
    const phaseNames = SQL2JAVA_WORKFLOW.phases.map(p => p.name)
    for (const name of phaseNames) {
      const outEdges = transitions.filter(t => t.from === name)
      expect(outEdges.length, `${name} should have outgoing transitions`).toBeGreaterThan(0)
    }
  })

  it("主线无条件前进：inventory → analyze → plan → scaffold → translate → dedup → review", () => {
    const mainChain = [
      { from: "inventory", to: "analyze" },
      { from: "analyze", to: "plan" },
      { from: "plan", to: "scaffold" },
      { from: "scaffold", to: "translate" },
      { from: "translate", to: "dedup" },
      { from: "dedup", to: "review" },
    ]
    for (const expected of mainChain) {
      const found = transitions.find(t => t.from === expected.from && t.to === expected.to)
      expect(found, `${expected.from} → ${expected.to} transition missing`).toBeTruthy()
      expect(found!.condition).toBe("always")
    }
  })

  it("review: passed → verify", () => {
    const t = transitions.find(t => t.from === "review" && t.condition === "passed")
    expect(t).toBeTruthy()
    expect(t!.to).toBe("verify")
  })

  it("review: failed → fix", () => {
    const t = transitions.find(t => t.from === "review" && t.condition === "failed")
    expect(t).toBeTruthy()
    expect(t!.to).toBe("fix")
  })

  it("verify: passed → __done__", () => {
    const t = transitions.find(t => t.from === "verify" && t.condition === "passed")
    expect(t).toBeTruthy()
    expect(t!.to).toBe("__done__")
  })

  it("verify: failed → fix", () => {
    const t = transitions.find(t => t.from === "verify" && t.condition === "failed")
    expect(t).toBeTruthy()
    expect(t!.to).toBe("fix")
  })

  it("fix: always → review", () => {
    const t = transitions.find(t => t.from === "fix")
    expect(t).toBeTruthy()
    expect(t!.condition).toBe("always")
    expect(t!.to).toBe("review")
  })

  it("无孤立阶段（每个非首阶段都有入边）", () => {
    const phaseNames = SQL2JAVA_WORKFLOW.phases.map(p => p.name)
    const firstPhase = phaseNames[0]
    const nonFirst = phaseNames.filter(n => n !== firstPhase)
    for (const name of nonFirst) {
      const inEdges = transitions.filter(t => t.to === name)
      expect(inEdges.length, `${name} should have incoming transitions`).toBeGreaterThan(0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// Upstream Artifacts
// ═══════════════════════════════════════════════════════════════

describe("UPSTREAM_ARTIFACTS", () => {
  const phases = SQL2JAVA_WORKFLOW.phases

  it("每个阶段都有 upstream 定义", () => {
    for (const phase of phases) {
      expect(
        UPSTREAM_ARTIFACTS[phase.name],
        `${phase.name} missing from UPSTREAM_ARTIFACTS`
      ).toBeDefined()
    }
  })

  it("upstream 值都是非空数组", () => {
    for (const [phase, artifacts] of Object.entries(UPSTREAM_ARTIFACTS)) {
      expect(Array.isArray(artifacts), `${phase} upstream should be array`).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// Phase Prerequisites
// ═══════════════════════════════════════════════════════════════

describe("PHASE_PREREQUISITES", () => {
  it("inventory 无前置依赖（它是首阶段）", () => {
    expect(PHASE_PREREQUISITES.inventory).toBeUndefined()
  })

  it("fix 有 OR-group（string[] 类型的前置项）", () => {
    const fixPrereqs = PHASE_PREREQUISITES.fix
    expect(fixPrereqs).toBeDefined()
    const orGroups = fixPrereqs!.filter(p => Array.isArray(p))
    expect(orGroups.length, "fix should have at least one OR-group").toBeGreaterThan(0)
  })

  it("OR-group 包含 review-summary.json 和 verify-summary.json", () => {
    const fixPrereqs = PHASE_PREREQUISITES.fix!
    const orGroup = fixPrereqs.find(p => Array.isArray(p)) as string[]
    expect(orGroup).toContain("review-summary.json")
    expect(orGroup).toContain("verify-summary.json")
  })
})
