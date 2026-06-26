/**
 * review-summary-builder.test.ts — buildReviewSummary 聚合逻辑测试
 *
 * review 改项目级单文件：reviewer 写一个 artifactsDir/review.json（packages[] 覆盖全部包），
 * summary 由代码合并 review.json（语义）+ review-static.json（静态）聚合成 review-summary.json。
 * 验证：allPassed 取与、totalMustFix 求和、packageResults 映射、空集抛错、
 * 产出 review-summary.json 通过 ReviewSummarySchema（含 allPassedRefine 一致性）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildReviewSummary } from "@workflow/review-summary-builder"
import { ReviewSummarySchema } from "@workflow/artifact-schemas"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-summary-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface PkgSpec { pkg: string; passed: boolean; score: number; mustFixCount: number; todos: number }

/** 写项目级 review.json：{ packages: [...] }，packages[] 覆盖给定包 */
function writeProjectReview(specs: PkgSpec[]) {
  const packages = specs.map(s => {
    const mustFix = Array.from({ length: s.mustFixCount }, (_, i) => ({
      file: `${s.pkg}.java`,
      line: 10 + i,
      issue: `issue ${i}`,
    }))
    // passed 与 mustFix 一致性（passedMustFixRefine）：passed=true 必须 mustFix 空
    return {
      packageName: s.pkg,
      passed: s.passed,
      overallScore: s.score,
      procedureReviews: [],
      mustFix: s.passed ? [] : mustFix,
      suggestions: [],
      todoRemainingCount: s.todos,
    }
  })
  writeFileSync(join(dir, "review.json"), JSON.stringify({ packages }), "utf-8")
}

describe("buildReviewSummary", () => {
  it("全包 passed → allPassed=true，totalMustFix=0", () => {
    writeProjectReview([
      { pkg: "PKG_A", passed: true, score: 95, mustFixCount: 0, todos: 1 },
      { pkg: "PKG_B", passed: true, score: 100, mustFixCount: 0, todos: 2 },
    ])
    const r = buildReviewSummary(dir)
    expect(r.packageCount).toBe(2)
    expect(r.allPassed).toBe(true)
    expect(r.totalMustFix).toBe(0)
  })

  it("存在 failed 包 → allPassed=false，totalMustFix 求和", () => {
    writeProjectReview([
      { pkg: "PKG_A", passed: true, score: 95, mustFixCount: 0, todos: 0 },
      { pkg: "PKG_B", passed: false, score: 72, mustFixCount: 2, todos: 3 },
    ])
    const r = buildReviewSummary(dir)
    expect(r.allPassed).toBe(false)
    expect(r.totalMustFix).toBe(2)
  })

  it("packageResults 映射 packageName/passed/score/mustFixCount，totalTodosRemaining 求和", () => {
    writeProjectReview([{ pkg: "PKG_A", passed: false, score: 60, mustFixCount: 1, todos: 4 }])
    const r = buildReviewSummary(dir)
    const summary = JSON.parse(readFileSync(join(dir, "review-summary.json"), "utf-8"))
    expect(summary.packageResults).toEqual([
      { packageName: "PKG_A", passed: false, staticPassed: true, score: 60, mustFixCount: 1 },
    ])
    expect(summary.totalTodosRemaining).toBe(4)
    expect(r.packageCount).toBe(1)
  })

  it("产出的 review-summary.json 通过 ReviewSummarySchema（allPassedRefine 一致）", () => {
    writeProjectReview([
      { pkg: "PKG_A", passed: true, score: 90, mustFixCount: 0, todos: 0 },
      { pkg: "PKG_B", passed: false, score: 55, mustFixCount: 3, todos: 1 },
    ])
    buildReviewSummary(dir)
    const raw = JSON.parse(readFileSync(join(dir, "review-summary.json"), "utf-8"))
    expect(ReviewSummarySchema.safeParse(raw).success).toBe(true)
    // allPassed 必须等于 packageResults.every(passed && staticPassed)
    expect(raw.allPassed).toBe(raw.packageResults.every((p: { passed: boolean; staticPassed?: boolean }) => p.passed && (p.staticPassed ?? true)))
  })

  it("无 review.json → 抛错（不应放行空 summary）", () => {
    expect(() => buildReviewSummary(dir)).toThrow(/review\.json/)
    expect(existsSync(join(dir, "review-summary.json"))).toBe(false)
  })

  it("跳过 packages[] 中校验失败的条目并记 warning，其余正常聚合", () => {
    // 先写一个合法 PKG_A，再追加一个非法 PKG_BAD（缺字段，passed/mustFix 不一致）
    writeProjectReview([{ pkg: "PKG_A", passed: true, score: 88, mustFixCount: 0, todos: 0 }])
    const raw = JSON.parse(readFileSync(join(dir, "review.json"), "utf-8"))
    raw.packages.push({ packageName: "PKG_BAD" }) // 非法条目
    writeFileSync(join(dir, "review.json"), JSON.stringify(raw), "utf-8")
    const r = buildReviewSummary(dir)
    expect(r.packageCount).toBe(1) // 只聚合法包
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toContain("PKG_BAD")
  })
})

// ── 静态 finding 合并（staticPassed 维度）── 验证 review 静态重构关键修正：
// 语义干净(passed=true) + 静态 critical → staticPassed=false, allPassed=false，
// 且专属 refine 通过（不抛错，避免 D8 死循环）。静态 finding 不进 review.json。
function writeStaticFindings(findings: any[]) {
  writeFileSync(join(dir, "review-static.json"), JSON.stringify({
    findings,
    toolSkipped: { checkstyle: false, pmd: false },
    scanMode: "full",
    generatedAt: "2026-06-24T00:00:00.000Z",
    scanStats: { totalPackages: 1, totalFilesScanned: 1 },
  }), "utf-8")
}

describe("buildReviewSummary 静态合并", () => {
  it("语义干净 + 静态 critical → staticPassed=false, allPassed=false, refine 不抛错", () => {
    writeProjectReview([{ pkg: "PKG_A", passed: true, score: 90, mustFixCount: 0, todos: 0 }]) // 语义干净
    writeStaticFindings([{
      file: "src/PKG_A/Foo.java", line: 12, rule: "java9-plus-api",
      severity: "critical", category: "version-compliance", tool: "java9api",
      packageName: "PKG_A", message: "List.of (Java 9+)",
    }])
    const r = buildReviewSummary(dir)
    expect(r.allPassed).toBe(false)
    expect(r.totalStaticFindings).toBe(1)
    const summary = JSON.parse(readFileSync(join(dir, "review-summary.json"), "utf-8"))
    expect(summary.packageResults[0].staticPassed).toBe(false)
    expect(summary.packageResults[0].passed).toBe(true) // 语义仍 passed
    expect(summary.allPassed).toBe(false)
    expect(ReviewSummarySchema.safeParse(summary).success).toBe(true)
  })

  it("语义干净 + 无静态 finding → staticPassed=true, allPassed=true", () => {
    writeProjectReview([{ pkg: "PKG_B", passed: true, score: 95, mustFixCount: 0, todos: 0 }])
    writeStaticFindings([])
    const r = buildReviewSummary(dir)
    expect(r.allPassed).toBe(true)
    const summary = JSON.parse(readFileSync(join(dir, "review-summary.json"), "utf-8"))
    expect(summary.packageResults[0].staticPassed).toBe(true)
  })

  it("静态 minor(非 blocking) 不压低 staticPassed", () => {
    writeProjectReview([{ pkg: "PKG_C", passed: true, score: 88, mustFixCount: 0, todos: 0 }])
    writeStaticFindings([{
      file: "src/PKG_C/Foo.java", line: 5, rule: "LineLength",
      severity: "minor", category: "code-format", tool: "checkstyle",
      packageName: "PKG_C", message: "line too long",
    }])
    const r = buildReviewSummary(dir)
    expect(r.allPassed).toBe(true) // minor 不阻断
    expect(r.totalStaticFindings).toBe(1)
  })

  it("无 review-static.json 时向后兼容：staticPassed 缺省 true", () => {
    writeProjectReview([{ pkg: "PKG_E", passed: true, score: 80, mustFixCount: 0, todos: 0 }])
    // 不写 review-static.json
    const r = buildReviewSummary(dir)
    expect(r.allPassed).toBe(true)
    expect(r.totalStaticFindings).toBe(0)
    const summary = JSON.parse(readFileSync(join(dir, "review-summary.json"), "utf-8"))
    expect(summary.packageResults[0].staticPassed).toBe(true)
  })
})

describe("buildReviewSummary 完整性", () => {
  it("review.json packages[] 缺包（对照 inventory）→ throw，供 reviewer session 内自愈", () => {
    writeProjectReview([{ pkg: "PKG_A", passed: true, score: 90, mustFixCount: 0, todos: 0 }])
    // inventory 声明两个包，review.json 只有 PKG_A
    writeFileSync(join(dir, "inventory.json"), JSON.stringify({ packageNames: ["PKG_A", "PKG_B"] }), "utf-8")
    expect(() => buildReviewSummary(dir)).toThrow(/PKG_B/)
  })

  it("无 inventory.json 时不做完整性检查（向后兼容，由 validateArtifactOnDisk 兜底）", () => {
    writeProjectReview([{ pkg: "PKG_A", passed: true, score: 90, mustFixCount: 0, todos: 0 }])
    // 不写 inventory.json
    expect(() => buildReviewSummary(dir)).not.toThrow()
  })
})
