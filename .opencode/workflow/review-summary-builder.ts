/**
 * Review Summary Builder — 把分片产出的 per-package `translations/{pkg}/review.json`
 * 聚合成顶层 `review-summary.json`（确定性 reduce，零 LLM）。
 *
 * review 阶段按包分片后，每个分片 Worker 只审查本分片的包、写各自的 review.json，
 * 没有任何单个 agent 看得到全部包，无法手写完整的 review-summary。故 summary 的聚合
 * 下沉为代码：读取所有 per-package review.json → 汇总 allPassed / packageResults /
 * totalMustFix / totalTodosRemaining → Zod 校验后写盘。
 *
 * 与 analyze 的 buildAnalysisFromIndex 同构：由 reviewer agent 调
 * `workflow({action:"generateReviewSummary", runId})` 触发，advance 据其结果推导 D8。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ReviewSchema, ReviewSummarySchema } from "./artifact-schemas"
import { formatZodIssues } from "./engine-core"
import { getLogger } from "./workflow-logger"

export function buildReviewSummary(artifactsDir: string): {
  packageCount: number
  allPassed: boolean
  totalMustFix: number
  warnings: string[]
} {
  const warnings: string[] = []
  const translationsDir = join(artifactsDir, "translations")
  const packageResults: Array<{
    packageName: string
    passed: boolean
    score: number
    mustFixCount: number
  }> = []
  let totalMustFix = 0
  let totalTodosRemaining = 0

  if (existsSync(translationsDir)) {
    for (const entry of readdirSync(translationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const reviewPath = join(translationsDir, entry.name, "review.json")
      if (!existsSync(reviewPath)) continue // 该包尚未审查（其它分片未完成 / 无翻译产物）
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(reviewPath, "utf-8"))
      } catch (e: any) {
        warnings.push(`translations/${entry.name}/review.json 解析失败: ${e.message}`)
        continue
      }
      const r = ReviewSchema.safeParse(raw)
      if (!r.success) {
        warnings.push(`translations/${entry.name}/review.json 校验失败:\n${formatZodIssues(r.error)}`)
        continue
      }
      const mustFixCount = r.data.mustFix.length
      packageResults.push({
        packageName: r.data.packageName,
        passed: r.data.passed,
        score: r.data.overallScore,
        mustFixCount,
      })
      totalMustFix += mustFixCount
      totalTodosRemaining += r.data.todoRemainingCount
    }
  }

  // 无任何可聚合的 review.json：无法构造有意义的 summary（agent 应先写 review.json 再调本 action）。
  // 抛错让 action 失败 → 编排者重新 dispatch，workOrder 带错误提示 agent 补审查。
  if (packageResults.length === 0) {
    throw new Error("未找到任何 translations/{pkg}/review.json，无法聚合 review-summary。请先完成至少一个包的审查并写入 review.json。")
  }

  // allPassed 须与 packageResults.every(passed) 严格一致（ReviewSummarySchema 的 allPassedRefine）
  const allPassed = packageResults.every(p => p.passed)
  const summary = {
    allPassed,
    packageResults,
    totalMustFix,
    totalTodosRemaining,
  }
  const validated = ReviewSummarySchema.safeParse(summary)
  if (!validated.success) {
    throw new Error(`review-summary 聚合结果校验失败:\n${formatZodIssues(validated.error)}`)
  }
  writeFileSync(join(artifactsDir, "review-summary.json"), JSON.stringify(validated.data, null, 2), "utf-8")
  getLogger().info(
    "[review-summary]",
    `聚合 ${packageResults.length} 包: allPassed=${allPassed}, totalMustFix=${totalMustFix}, totalTodosRemaining=${totalTodosRemaining}`,
  )
  return { packageCount: packageResults.length, allPassed, totalMustFix, warnings }
}
