/**
 * verify-summary-schema.coverage.test.ts — VerifySummarySchema coverage refine 测试
 *
 * 验证单向蕴含规则：覆盖率未达标（coverage.passed=false）时 allPassed 必须为 false；
 * 覆盖率达标或跳过（coverage.passed=true）时 allPassed 由 packageResults 决定（可真可假）。
 */

import { describe, it, expect } from "vitest"
import { VerifySummarySchema } from "@workflow/artifact-schemas"

function baseSummary(overrides: Record<string, any> = {}) {
  return {
    allPassed: true,
    compilation: { success: true },
    packageResults: [{ packageName: "PKG_A", passed: true, mybatisValid: true }],
    testExecution: { executed: true, testFiles: [], totalTests: 1, passedTests: 1, failedTests: 0 },
    totalTodosRemaining: 0,
    coverage: {
      executed: true,
      lineRate: 1,
      branchRate: 1,
      lineThreshold: 0.9,
      branchThreshold: 0.75,
      passed: true,
      packageCoverage: [],
    },
    ...overrides,
  }
}

describe("VerifySummarySchema coverage refine", () => {
  it("coverage.passed=true + allPassed=true → 通过", () => {
    expect(VerifySummarySchema.safeParse(baseSummary()).success).toBe(true)
  })

  it("coverage.passed=true + allPassed=false（测试失败）→ 通过（单向蕴含允许）", () => {
    const data = baseSummary({
      allPassed: false,
      packageResults: [{ packageName: "PKG_A", passed: false, mybatisValid: true }],
    })
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("coverage.passed=false + allPassed=false + 对应包 passed=false → 通过", () => {
    const data = baseSummary({
      allPassed: false,
      packageResults: [{ packageName: "PKG_A", passed: false, mybatisValid: true }],
      coverage: { executed: true, lineRate: 0.5, branchRate: 0.5, lineThreshold: 0.9, branchThreshold: 0.75, passed: false, packageCoverage: [{ packageName: "PKG_A", lineRate: 0.5, branchRate: 0.5, passed: false, gaps: [] }] },
    })
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("coverage.passed=false + allPassed=true → 报错（覆盖率未达标却 allPassed）", () => {
    const data = baseSummary({
      allPassed: true,
      coverage: { executed: true, lineRate: 0.5, branchRate: 0.5, lineThreshold: 0.9, branchThreshold: 0.75, passed: false, packageCoverage: [] },
    })
    const r = VerifySummarySchema.safeParse(data)
    expect(r.success).toBe(false)
  })

  it("coverage 跳过（executed=false, passed=true）不阻断 allPassed=true", () => {
    const data = baseSummary({
      coverage: { executed: false, skipReason: "无 jacoco.xml", lineThreshold: 0.9, branchThreshold: 0.75, passed: true, packageCoverage: [] },
    })
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })
})
