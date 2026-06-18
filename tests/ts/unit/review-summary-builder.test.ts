/**
 * review-summary-builder.test.ts — buildReviewSummary 聚合逻辑测试
 *
 * review 按包分片后，summary 由代码聚合所有 per-package review.json（零 LLM）。
 * 验证：allPassed 取与、totalMustFix 求和、packageResults 映射、空集抛错、
 * 产出 review-summary.json 通过 ReviewSummarySchema（含 allPassedRefine 一致性）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildReviewSummary } from "@workflow/review-summary-builder"
import { ReviewSummarySchema } from "@workflow/artifact-schemas"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-summary-"))
  mkdirSync(join(dir, "translations"), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeReview(pkg: string, passed: boolean, score: number, mustFixCount: number, todos: number) {
  mkdirSync(join(dir, "translations", pkg), { recursive: true })
  const mustFix = Array.from({ length: mustFixCount }, (_, i) => ({
    file: `${pkg}.java`,
    line: 10 + i,
    issue: `issue ${i}`,
  }))
  // passed 与 mustFix 一致性（passedMustFixRefine）：passed=true 必须 mustFix 空
  const review = {
    packageName: pkg,
    passed,
    overallScore: score,
    procedureReviews: [],
    mustFix: passed ? [] : mustFix,
    suggestions: [],
    todoRemainingCount: todos,
  }
  writeFileSync(join(dir, "translations", pkg, "review.json"), JSON.stringify(review), "utf-8")
}

describe("buildReviewSummary", () => {
  it("全包 passed → allPassed=true，totalMustFix=0", () => {
    writeReview("PKG_A", true, 95, 0, 1)
    writeReview("PKG_B", true, 100, 0, 2)
    const r = buildReviewSummary(dir)
    expect(r.packageCount).toBe(2)
    expect(r.allPassed).toBe(true)
    expect(r.totalMustFix).toBe(0)
  })

  it("存在 failed 包 → allPassed=false，totalMustFix 求和", () => {
    writeReview("PKG_A", true, 95, 0, 0)
    writeReview("PKG_B", false, 72, 2, 3)
    const r = buildReviewSummary(dir)
    expect(r.allPassed).toBe(false)
    expect(r.totalMustFix).toBe(2)
  })

  it("packageResults 映射 packageName/passed/score/mustFixCount，totalTodosRemaining 求和", () => {
    writeReview("PKG_A", false, 60, 1, 4)
    const r = buildReviewSummary(dir)
    const summary = JSON.parse(readFileSync(join(dir, "review-summary.json"), "utf-8"))
    expect(summary.packageResults).toEqual([
      { packageName: "PKG_A", passed: false, score: 60, mustFixCount: 1 },
    ])
    expect(summary.totalTodosRemaining).toBe(4)
    expect(r.packageCount).toBe(1)
  })

  it("产出的 review-summary.json 通过 ReviewSummarySchema（allPassedRefine 一致）", () => {
    writeReview("PKG_A", true, 90, 0, 0)
    writeReview("PKG_B", false, 55, 3, 1)
    buildReviewSummary(dir)
    const raw = JSON.parse(readFileSync(join(dir, "review-summary.json"), "utf-8"))
    expect(ReviewSummarySchema.safeParse(raw).success).toBe(true)
    // allPassed 必须等于 packageResults.every(passed)
    expect(raw.allPassed).toBe(raw.packageResults.every((p: { passed: boolean }) => p.passed))
  })

  it("无任何 review.json → 抛错（不应放行空 summary）", () => {
    expect(() => buildReviewSummary(dir)).toThrow(/未找到任何/)
    expect(existsSync(join(dir, "review-summary.json"))).toBe(false)
  })

  it("跳过解析/校验失败的 review.json 并记 warning，其余正常聚合", () => {
    writeReview("PKG_A", true, 88, 0, 0)
    // 写一个非法 review.json（缺字段，passed/mustFix 不一致）
    mkdirSync(join(dir, "translations", "PKG_BAD"), { recursive: true })
    writeFileSync(join(dir, "translations", "PKG_BAD", "review.json"), JSON.stringify({ packageName: "PKG_BAD" }), "utf-8")
    const r = buildReviewSummary(dir)
    expect(r.packageCount).toBe(1) // 只聚合法包
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toContain("PKG_BAD")
  })
})
