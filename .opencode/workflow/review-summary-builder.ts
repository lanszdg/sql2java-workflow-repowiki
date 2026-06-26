/**
 * Review Summary Builder — 合并项目级 `review.json`（语义）+ `review-static.json`（静态）
 * 成顶层 `review-summary.json`（确定性 reduce，零 LLM）。
 *
 * review 项目级单次审核：reviewer 写一个 artifactsDir/review.json（packages[] 覆盖全部包，
 * 纯语义）。本 builder 读其 packages[] + review-static.json 的静态 finding（按 packageName 归因），
 * 汇总 allPassed（passed && staticPassed）/ packageResults（含 staticPassed）/ totalMustFix（语义）/
 * totalStaticFindings / totalTodosRemaining → Zod 校验后写盘。
 *
 * 由 reviewer agent 调 `workflow({action:"generateReviewSummary", runId})` 触发，advance 据其 allPassed 推导 D8。
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ReviewSchema, ReviewSummarySchema, ReviewStaticSchema } from "./artifact-schemas"
import { formatZodIssues } from "./engine-core"
import { getLogger } from "./workflow-logger"

interface StaticFindingLite {
  file: string
  line?: number | null
  rule: string
  severity: string
  category: string
  tool: string
  packageName: string
  message: string
}

/** 读取 review-static.json（Step A 确定性扫描产物）；不存在/校验失败 → 返回空（不阻断） */
function loadStaticFindings(artifactsDir: string): StaticFindingLite[] {
  const p = join(artifactsDir, "review-static.json")
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"))
    const r = ReviewStaticSchema.safeParse(raw)
    if (!r.success) {
      getLogger().warn("[review-summary]", `review-static.json 校验失败，按 raw findings 容错读取: ${JSON.stringify(r.error.issues).slice(0, 200)}`)
      return Array.isArray((raw as any)?.findings) ? (raw as any).findings as StaticFindingLite[] : []
    }
    return r.data.findings as StaticFindingLite[]
  } catch (e: any) {
    getLogger().warn("[review-summary]", `读取 review-static.json 失败: ${e.message}`)
    return []
  }
}

const BLOCKING_SEVERITY = new Set(["critical", "major"])

/** 对照 inventory.json.packageNames 检查 review.json 是否覆盖全部包；缺则返回缺失列表（大小写不敏感） */
function findMissingPackages(artifactsDir: string, presentPackages: string[]): string[] {
  const invPath = join(artifactsDir, "inventory.json")
  if (!existsSync(invPath)) return [] // inventory 缺失时不阻断（由 prerequisite/validateArtifactOnDisk 兜底）
  try {
    const inv = JSON.parse(readFileSync(invPath, "utf-8")) as { packageNames?: unknown }
    const expected = Array.isArray(inv.packageNames)
      ? inv.packageNames.filter((n): n is string => typeof n === "string" && n.length > 0)
      : []
    if (expected.length === 0) return []
    const presentUpper = new Set(presentPackages.map(p => p.toUpperCase()))
    return expected.filter(p => !presentUpper.has(p.toUpperCase()))
  } catch { return [] }
}

export function buildReviewSummary(artifactsDir: string): {
  packageCount: number
  allPassed: boolean
  totalMustFix: number
  totalStaticFindings: number
  warnings: string[]
} {
  const warnings: string[] = []
  const reviewPath = join(artifactsDir, "review.json")
  const packageResults: Array<{
    packageName: string
    passed: boolean
    staticPassed: boolean
    score: number
    mustFixCount: number
  }> = []
  let totalMustFix = 0
  let totalTodosRemaining = 0

  // review 改项目级单文件：读 artifactsDir/review.json 的 packages[]（语义），不再扫 translations/*/review.json
  if (!existsSync(reviewPath)) {
    throw new Error(`未找到 ${reviewPath}，无法聚合 review-summary。reviewer 必须写项目级 review.json（packages[] 覆盖全部包）后再调本 action。`)
  }
  let reviewRaw: any
  try {
    reviewRaw = JSON.parse(readFileSync(reviewPath, "utf-8"))
  } catch (e: any) {
    throw new Error(`解析 review.json 失败: ${e.message}`)
  }
  const packages = Array.isArray(reviewRaw?.packages) ? reviewRaw.packages : []
  for (const pkg of packages) {
    const r = ReviewSchema.safeParse(pkg)
    if (!r.success) {
      const name = (pkg as any)?.packageName ?? "?"
      warnings.push(`review.json packages[${name}] 校验失败:\n${formatZodIssues(r.error)}`)
      continue
    }
    const mustFixCount = r.data.mustFix.length
    packageResults.push({
      packageName: r.data.packageName,
      passed: r.data.passed,
      staticPassed: true, // 占位，下方按静态 finding 覆盖
      score: r.data.overallScore,
      mustFixCount,
    })
    totalMustFix += mustFixCount
    totalTodosRemaining += r.data.todoRemainingCount
  }

  // 无任何可聚合的包：无法构造有意义的 summary（agent 应先写 review.json 再调本 action）。
  if (packageResults.length === 0) {
    throw new Error("review.json packages[] 为空或全部校验失败，无法聚合 review-summary。请完成至少一个包的审查并写入 review.json。")
  }

  // 完整性：review.json packages[] 必须覆盖 inventory 全部包（缺包/条目校验失败都算缺）。
  // 让 generateReviewSummary action 在 reviewer session 内失败（而非等到 advance 被 validateArtifactOnDisk
  // 拒绝再重 dispatch）——reviewer 看到 action 报错可直接补写缺失/修正非法条目后重试。
  const missing = findMissingPackages(artifactsDir, packageResults.map(p => p.packageName))
  if (missing.length > 0) {
    throw new Error(`review.json packages[] 缺失或非法包: ${missing.join(", ")}。review 是项目级单次审核，packages[] 必须覆盖 inventory 全部包（fix 回环时须保留非目标包的现有条目，只更新目标包）。`)
  }

  // 合并静态 finding：按 packageName 归因（finding 在 scanner 已归因），per-package staticPassed
  // = 无 critical/major 静态 finding。归因失败(packageName="UNKNOWN")的 finding 计入总数但不归属
  // 任何包——rare（buildFileIndex 覆盖所有 translation.json 文件），不压低 allPassed（避免与
  // allPassedRefine 冲突）；UNKNOWN finding 仍经 fix workOrder 静态段注入供修复。
  const staticFindings = loadStaticFindings(artifactsDir)
  const blockingByPkg = new Map<string, number>()
  for (const f of staticFindings) {
    if (!BLOCKING_SEVERITY.has(String(f.severity).toLowerCase())) continue
    const key = f.packageName ?? "UNKNOWN"
    blockingByPkg.set(key, (blockingByPkg.get(key) ?? 0) + 1)
  }
  for (const pr of packageResults) {
    const blocking = blockingByPkg.get(pr.packageName) ?? blockingByPkg.get(pr.packageName.toUpperCase()) ?? 0
    pr.staticPassed = blocking === 0
  }

  // allPassed 须与 packageResults.every(passed && staticPassed) 严格一致（ReviewSummarySchema 专属 refine）
  const allPassed = packageResults.every(p => p.passed && p.staticPassed)
  const summary = {
    allPassed,
    packageResults,
    totalMustFix,
    totalTodosRemaining,
    totalStaticFindings: staticFindings.length,
  }
  const validated = ReviewSummarySchema.safeParse(summary)
  if (!validated.success) {
    throw new Error(`review-summary 聚合结果校验失败:\n${formatZodIssues(validated.error)}`)
  }
  writeFileSync(join(artifactsDir, "review-summary.json"), JSON.stringify(validated.data, null, 2), "utf-8")
  getLogger().info(
    "[review-summary]",
    `聚合 ${packageResults.length} 包: allPassed=${allPassed}, totalMustFix=${totalMustFix}, totalStaticFindings=${staticFindings.length}, totalTodosRemaining=${totalTodosRemaining}`,
  )
  return { packageCount: packageResults.length, allPassed, totalMustFix, totalStaticFindings: staticFindings.length, warnings }
}
