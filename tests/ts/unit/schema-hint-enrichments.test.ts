/**
 * schema-hint-enrichments.test.ts — enrichments 数据与实际 schema/常量的一致性校验
 *
 * 防漂移测试：确保手动维护的 enrichments 与 Zod schema、质量门控常量等保持同步。
 */

import { describe, it, expect } from "vitest"
import {
  REFINE_CONSTRAINTS, NON_ZOD_VALIDATION_RULES,
  QUALITY_GATE_HINTS, CROSS_SCHEMA_HINTS, COMMON_PITFALLS,
} from "@workflow/schema-hint-enrichments"
import { QUALITY_GATE_THRESHOLDS } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import {
  TranslationSchema,
  ReviewSchema,
  ReviewSummarySchema,
  VerifySchema,
  VerifySummarySchema,
  FixArtifactSchema,
} from "@workflow/artifact-schemas"

// ═══════════════════════════════════════════════════════════════

describe("REFINE_CONSTRAINTS 一致性", () => {
  // 从 artifact-schemas.ts 中提取的 refine message 列表
  const EXPECTED_REFINE_MESSAGES: Record<string, string[]> = {
    inventory: [
      "有子程序的包应有 bodyPath",
    ],
    translate: [
      "subprogramMethods.oracleName 必须唯一",
    ],
    review: [
      "passed 与 mustFix 必须一致",
      "allPassed 应与 packageResults 一致",
    ],
    verify: [
      "passed 与 mustFix 必须一致",
      "allPassed 应与 packageResults 一致",
      "compilation.success=false 时 errors 必须非空",
    ],
    fix: [
      "fixedPackages 不能为空",
    ],
  }

  it("REFINE_CONSTRAINTS 覆盖所有有 refine 的 phase", () => {
    const phasesWithRefine = Object.keys(EXPECTED_REFINE_MESSAGES)
    const phasesInEnrichments = Object.keys(REFINE_CONSTRAINTS)
    for (const phase of phasesWithRefine) {
      expect(phasesInEnrichments, `phase=${phase} 应在 REFINE_CONSTRAINTS 中`).toContain(phase)
    }
  })

  it("REFINE_CONSTRAINTS 不包含无 refine 的 phase", () => {
    // plan 和 scaffold 没有 refine
    expect(REFINE_CONSTRAINTS["plan"]).toBeUndefined()
    expect(REFINE_CONSTRAINTS["scaffold"]).toBeUndefined()
  })

  it("每个 constraint 包含对应 refine message 的关键词", () => {
    for (const [phase, expectedKeywords] of Object.entries(EXPECTED_REFINE_MESSAGES)) {
      const constraints = REFINE_CONSTRAINTS[phase]
      expect(constraints, `phase=${phase}`).toBeDefined()
      for (const keyword of expectedKeywords) {
        // 检查至少一个 constraint 包含该关键词
        const found = constraints!.some(c => c.includes(keyword))
        expect(found, `phase=${phase}: 关键词 "${keyword}" 未在 REFINE_CONSTRAINTS 中找到`).toBe(true)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════

describe("QUALITY_GATE_HINTS 一致性", () => {
  it("阈值与 QUALITY_GATE_THRESHOLDS 一致", () => {
    // G1: 80% completion ratio
    expect(QUALITY_GATE_HINTS.translate[0]).toContain(String(Math.round(QUALITY_GATE_THRESHOLDS.COMPLETION_RATIO * 100)))
    // G3: review pass score
    expect(QUALITY_GATE_HINTS.review[0]).toContain(String(QUALITY_GATE_THRESHOLDS.REVIEW_PASS_SCORE))
    // G6: test pass ratio
    expect(QUALITY_GATE_HINTS.verify[1]).toContain(String(Math.round(QUALITY_GATE_THRESHOLDS.TEST_PASS_RATIO * 100)))
  })

  it("只包含有质量门控的阶段", () => {
    const phasesWithGates = Object.keys(QUALITY_GATE_HINTS)
    // translate, review, verify 应有门控
    expect(phasesWithGates).toContain("translate")
    expect(phasesWithGates).toContain("review")
    expect(phasesWithGates).toContain("verify")
    // 其他阶段不应有门控
    expect(phasesWithGates).not.toContain("inventory")
    expect(phasesWithGates).not.toContain("analyze")
    expect(phasesWithGates).not.toContain("plan")
    expect(phasesWithGates).not.toContain("scaffold")
  })

  it("每个 gate 描述包含编号（G1-G6）", () => {
    for (const [phase, gates] of Object.entries(QUALITY_GATE_HINTS)) {
      for (const gate of gates) {
        expect(gate, `phase=${phase}: gate="${gate}"`).toMatch(/^G\d+/)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════

describe("CROSS_SCHEMA_HINTS 一致性", () => {
  it("key 与 needsCrossSchemaValidation=true 的 phase 列表一致", () => {
    const crossSchemaPhases = SQL2JAVA_WORKFLOW.phases
      .filter(p => p.needsCrossSchemaValidation)
      .map(p => p.name)
    const hintPhases = Object.keys(CROSS_SCHEMA_HINTS)

    // 每个 needsCrossSchemaValidation=true 的 phase 都应有条目
    for (const phase of crossSchemaPhases) {
      expect(hintPhases, `phase=${phase} 应在 CROSS_SCHEMA_HINTS 中`).toContain(phase)
    }

    // CROSS_SCHEMA_HINTS 不应包含 needsCrossSchemaValidation=false 的 phase
    for (const phase of hintPhases) {
      expect(crossSchemaPhases, `phase=${phase} 不应在 CROSS_SCHEMA_HINTS 中（无跨 Schema 校验）`).toContain(phase)
    }
  })

  it("每个 phase 至少有一条规则", () => {
    for (const [phase, rules] of Object.entries(CROSS_SCHEMA_HINTS)) {
      expect(rules.length, `phase=${phase}`).toBeGreaterThanOrEqual(1)
    }
  })
})

// ═══════════════════════════════════════════════════════════════

describe("NON_ZOD_VALIDATION_RULES 覆盖性", () => {
  it("每个有引擎级校验的 phase 都有对应条目", () => {
    const coveredPhases = new Set<string>()
    for (const rule of NON_ZOD_VALIDATION_RULES) {
      for (const p of rule.phases) {
        coveredPhases.add(p)
      }
    }
    // 应包含有额外校验的阶段
    expect(coveredPhases).toContain("inventory")
    expect(coveredPhases).toContain("analyze")
    expect(coveredPhases).toContain("scaffold")
    expect(coveredPhases).toContain("translate")
    expect(coveredPhases).toContain("verify")
    expect(coveredPhases).toContain("dedup")
  })

  it("每条规则的 message 非空且描述具体", () => {
    for (const rule of NON_ZOD_VALIDATION_RULES) {
      expect(rule.message.length, `phases=${rule.phases.join(",")}`).toBeGreaterThan(10)
      expect(rule.phases.length, `message="${rule.message}"`).toBeGreaterThanOrEqual(1)
    }
  })
})

// ═══════════════════════════════════════════════════════════════

describe("COMMON_PITFALLS 一致性", () => {
  /** 所有有 Zod schema 的 phase（应有 pitfall 提示） */
  const ALL_SCHEMA_PHASES = [
    "inventory-index", "inventory", "analyze", "plan", "scaffold",
    "translate", "review", "verify", "dedup", "fix",
  ]

  it("COMMON_PITFALLS 覆盖所有有 Zod schema 的 phase", () => {
    for (const phase of ALL_SCHEMA_PHASES) {
      expect(COMMON_PITFALLS[phase], `phase=${phase} 应在 COMMON_PITFALLS 中`).toBeDefined()
      expect(COMMON_PITFALLS[phase]!.length, `phase=${phase} 应至少有一条 pitfall`).toBeGreaterThan(0)
    }
  })

  it("COMMON_PITFALLS 不包含不存在的 phase", () => {
    const pitfallPhases = Object.keys(COMMON_PITFALLS)
    for (const phase of pitfallPhases) {
      expect(ALL_SCHEMA_PHASES, `phase=${phase} 不应是未定义的 phase`).toContain(phase)
    }
  })

  it("每条 pitfall 非空且描述具体（长度 ≥ 10）", () => {
    for (const [phase, pitfalls] of Object.entries(COMMON_PITFALLS)) {
      for (const pitfall of pitfalls) {
        expect(pitfall.length, `phase=${phase}: "${pitfall}"`).toBeGreaterThanOrEqual(10)
      }
    }
  })

  it("inventory 阶段包含 mode 大写提示", () => {
    const pitfalls = COMMON_PITFALLS["inventory"]
    expect(pitfalls).toBeDefined()
    const hasMode = pitfalls!.some(p => p.includes("mode") && p.includes("IN"))
    expect(hasMode, "inventory pitfall 应包含 mode 大写提示").toBe(true)
  })

  it("inventory 阶段包含 optional 不写 null 提示", () => {
    const pitfalls = COMMON_PITFALLS["inventory"]
    expect(pitfalls).toBeDefined()
    const hasNull = pitfalls!.some(p => p.includes("optional") && p.includes("null"))
    expect(hasNull, "inventory pitfall 应包含 optional 不写 null 提示").toBe(true)
  })

  it("inventory 阶段包含 trigger 枚举提示", () => {
    const pitfalls = COMMON_PITFALLS["inventory"]
    expect(pitfalls).toBeDefined()
    const hasTrigger = pitfalls!.some(p => p.includes("timing") || p.includes("events"))
    expect(hasTrigger, "inventory pitfall 应包含 trigger 枚举提示").toBe(true)
  })

  it("analyze 阶段包含 translationNotes 类型提示", () => {
    const pitfalls = COMMON_PITFALLS["analyze"]
    expect(pitfalls).toBeDefined()
    const hasTranslationNotes = pitfalls!.some(p => p.includes("translationNotes") && p.includes("string[]"))
    expect(hasTranslationNotes, "analyze pitfall 应包含 translationNotes string[] 类型提示").toBe(true)
  })

  it("review 阶段包含 passed/mustFix 一致性提示", () => {
    const pitfalls = COMMON_PITFALLS["review"]
    expect(pitfalls).toBeDefined()
    const hasPassedMustFix = pitfalls!.some(p => p.includes("passed") && p.includes("mustFix"))
    expect(hasPassedMustFix, "review pitfall 应包含 passed/mustFix 一致性提示").toBe(true)
  })

  it("translate 阶段包含 oracleName 重载提示", () => {
    const pitfalls = COMMON_PITFALLS["translate"]
    expect(pitfalls).toBeDefined()
    const hasOracleName = pitfalls!.some(p => p.includes("oracleName") && p.includes("__"))
    expect(hasOracleName, "translate pitfall 应包含 oracleName 重载序号提示").toBe(true)
  })

  it("plan 阶段包含枚举推荐值提示", () => {
    const pitfalls = COMMON_PITFALLS["plan"]
    expect(pitfalls).toBeDefined()
    const hasRecommendation = pitfalls!.some(p => p.includes("推荐值"))
    expect(hasRecommendation, "plan pitfall 应包含枚举推荐值提示").toBe(true)
  })
})
