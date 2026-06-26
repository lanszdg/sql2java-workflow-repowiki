/**
 * harness/assertions.ts — 执行点测试的确定性断言库
 *
 * 断言是 test oracle（验证手段，如同单测的 expect()）。它判的是 .opencode agent 的真实产出，
 * rubric/断言点引用 .opencode 已有规约条款，不自创新规范（同源原则）。
 *
 * 注意：reviewer 的 mustFix[] 只有 {file,line,issue}，没有 category/severity ——
 * 这两个字段在 procedureReviews[].checks[] 里（见 artifact-schemas.ts:401-418）。
 * 所以「reviewer 是否抓到某类缺陷」要查 checks[]，不是 mustFix[]。
 */

import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AssertionResult, CaseContext } from "./types"

// ── 严重级别排序 ──────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  info: 1,
}

/** 严重级别转数值，未知级别返回 0 */
export function severityRank(severity: string | undefined): number {
  if (!severity) return 0
  return SEVERITY_RANK[severity.toLowerCase()] ?? 0
}

// ── agent 产出的轻量类型（避免 bun 解析器对嵌套内联泛型 as 断言的解析问题） ──

interface ReviewCheck {
  category?: string
  passed?: boolean
  severity?: string
  detail?: string
}
interface ReviewArtifact {
  procedureReviews?: Array<{ procedure?: string; checks?: ReviewCheck[] }>
}
interface TranslationArtifact {
  decisions?: Array<{ oracleConstruct?: string; javaConstruct?: string }>
}

// ── glob（自实现，避免新增依赖） ─────────────────────────────

/**
 * 将 glob 模式（支持 ** 和 *）转为正则。
 * 用占位符分阶段替换，避免后一步误处理前一步插入的字符（如路径前缀片段中的星号）。
 */
function globToRegex(pattern: string): RegExp {
  const DS = "DS" // **/ 占位
  const D = "D" // ** 占位
  const S = "S" // * 占位
  let p = pattern
    .replace(/\*\*\//g, DS) // **/ → 占位
    .replace(/\*\*/g, D) // **  → 占位
    .replace(/\*/g, S) // *   → 占位
  // 转义正则特殊字符（占位符为 +字母，不含特殊字符，安全）
  p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  // 还原占位符为正则片段（还原后不再处理 *，避免污染）
  p = p
    .replace(new RegExp(DS, "g"), "(?:.*/)?") // **/ → 可选任意深度前缀（也匹配根）
    .replace(new RegExp(D, "g"), ".*") // **  → 任意
    .replace(new RegExp(S, "g"), "[^/]*") // *   → 单段
  return new RegExp("^" + p + "$")
}

/** 在一组键中找出匹配 glob 的键 */
function matchKeys(keys: string[], pattern: string): string[] {
  const re = globToRegex(pattern)
  return keys.filter(k => re.test(k))
}

// ── Artifact 存在性 / 字段断言 ───────────────────────────────

/** 校验 artifact（按相对 run 目录的路径键）存在 */
export function assertArtifactExists(ctx: CaseContext, key: string): AssertionResult {
  const exists = key in ctx.artifacts
  return {
    name: `artifact:${key}:exists`,
    passed: exists,
    message: exists ? "OK" : `artifact ${key} 不存在`,
  }
}

/** 校验 artifact JSON 中指定字段的值（点号路径） */
export function assertArtifactField(
  ctx: CaseContext,
  key: string,
  fieldPath: string,
  expectedValue: unknown,
): AssertionResult {
  const artifact = ctx.artifacts[key]
  if (!artifact) {
    return { name: `artifact:${key}:${fieldPath}`, passed: false, message: `artifact ${key} 不存在` }
  }
  const value = getNestedValue(artifact as Record<string, unknown>, fieldPath)
  const match = JSON.stringify(value) === JSON.stringify(expectedValue)
  return {
    name: `artifact:${key}:${fieldPath}`,
    passed: match,
    message: match ? "OK" : `期望 ${JSON.stringify(expectedValue)}，实际 ${JSON.stringify(value)}`,
  }
}

/** 校验 artifact JSON 中指定字段匹配正则 */
export function assertArtifactFieldMatches(
  ctx: CaseContext,
  key: string,
  fieldPath: string,
  pattern: RegExp,
): AssertionResult {
  const artifact = ctx.artifacts[key]
  if (!artifact) {
    return { name: `artifact:${key}:${fieldPath}:matches`, passed: false, message: `artifact ${key} 不存在` }
  }
  const value = String(getNestedValue(artifact as Record<string, unknown>, fieldPath) ?? "")
  const match = pattern.test(value)
  return {
    name: `artifact:${key}:${fieldPath}:matches`,
    passed: match,
    message: match ? "OK" : `${value} 不匹配 ${pattern}`,
  }
}

/** 校验 run.json 的 status 字段 */
export function assertRunStatus(ctx: CaseContext, expected: string): AssertionResult {
  return assertArtifactField(ctx, "run.json", "status", expected)
}

/** 校验 workflow 完成状态（completed / completed_with_issues） */
export function assertRunCompleted(ctx: CaseContext): AssertionResult {
  const run = ctx.artifacts["run.json"] as Record<string, unknown> | undefined
  if (!run) return { name: "run:completed", passed: false, message: "run.json 不存在" }
  const status = run.status as string
  const completed = status === "completed" || status === "completed_with_issues"
  return {
    name: "run:completed",
    passed: completed,
    message: completed ? `状态: ${status}` : `期望 completed/completed_with_issues，实际 ${status}`,
  }
}

// ── 生成的源码断言 ───────────────────────────────────────────

/** 断言生成的文件存在（glob，匹配 ctx.generatedFiles 的键） */
export function assertGeneratedFileExists(ctx: CaseContext, globPattern: string): AssertionResult {
  const matches = matchKeys(Object.keys(ctx.generatedFiles), globPattern)
  return {
    name: `generated:${globPattern}:exists`,
    passed: matches.length > 0,
    message: matches.length > 0 ? `命中 ${matches.length} 个文件` : `未找到匹配 ${globPattern} 的生成文件`,
  }
}

/**
 * 断言生成的源码内容匹配正则（任一匹配文件命中即通过）。
 * 例：catch 块存在且非空 → /catch\s*\([^)]+\)\s*\{[\s\S]*?\}/
 */
export function assertJavaMatches(ctx: CaseContext, globPattern: string, regex: RegExp): AssertionResult {
  const matches = matchKeys(Object.keys(ctx.generatedFiles), globPattern)
  if (matches.length === 0) {
    return { name: `generated:${globPattern}:matches`, passed: false, message: `未找到匹配 ${globPattern} 的文件` }
  }
  const hit = matches.some(k => regex.test(ctx.generatedFiles[k]))
  return {
    name: `generated:${globPattern}:matches`,
    passed: hit,
    message: hit ? `命中正则（共 ${matches.length} 个文件）` : `${matches.length} 个文件均不匹配 ${regex}`,
  }
}

// ── translator 产出断言（translation.json.decisions） ────────

/**
 * 断言 translation.json.decisions 含某映射（oracleConstruct 必含，javaConstruct 可选，模糊匹配）。
 * 跨所有包的 translation.json 聚合判定。
 */
export function assertDecision(
  ctx: CaseContext,
  oracleConstruct: string,
  javaConstruct?: string,
): AssertionResult {
  const found: string[] = []
  for (const [key, val] of Object.entries(ctx.artifacts)) {
    if (!key.endsWith("/translation.json") && key !== "translation.json") continue
    const decisions = (val as TranslationArtifact).decisions ?? []
    for (const d of decisions) {
      const oc = d.oracleConstruct ?? ""
      const jc = d.javaConstruct ?? ""
      if (oc.includes(oracleConstruct) && (!javaConstruct || jc.includes(javaConstruct))) {
        found.push(`${key}: ${oc} → ${jc}`)
      }
    }
  }
  return {
    name: `decision:${oracleConstruct}`,
    passed: found.length > 0,
    message: found.length > 0 ? `命中 ${found.length} 处: ${found[0]}` : `decisions 未含 oracleConstruct~${oracleConstruct}${javaConstruct ? ` → ${javaConstruct}` : ""}`,
  }
}

// ── reviewer 能力断言（checks[]，被测对象是 reviewer） ───────

/**
 * 断言 reviewer 抓到了某类缺陷：在 procedureReviews[].checks[] 中存在
 *   category === 目标 && passed === false && severity 级别 ≥ minSeverity。
 * 跨所有包的 review.json 聚合判定。
 *
 * 语义：命中 = reviewer 审查能力有效；漏判 = reviewer 有漏洞（.opencode 的 bug，正是测试要发现的）。
 */
export function assertCheckFound(
  ctx: CaseContext,
  category: string,
  minSeverity: "critical" | "major" | "minor" | "info",
): AssertionResult {
  const minRank = severityRank(minSeverity)
  const found: Array<{ key: string; procedure: string; severity: string; detail: string }> = []
  for (const [key, val] of Object.entries(ctx.artifacts)) {
    if (!key.endsWith("/review.json") && key !== "review.json") continue
    const review = val as ReviewArtifact
    // review 改项目级单文件：review.json = { packages: [{ procedureReviews, ... }] }。
    // 兼容旧 per-package 形状（直接 procedureReviews）。
    const pkgReviews = (review as any).packages
      ? ((review as any).packages as Array<{ procedureReviews?: ReviewArtifact["procedureReviews"] }>).flatMap(p => p.procedureReviews ?? [])
      : (review.procedureReviews ?? [])
    for (const pr of pkgReviews) {
      for (const c of pr.checks ?? []) {
        if (c.category === category && c.passed === false && severityRank(c.severity) >= minRank) {
          found.push({ key, procedure: pr.procedure ?? "?", severity: c.severity ?? "?", detail: c.detail ?? "" })
        }
      }
    }
  }
  return {
    name: `check:${category}:${minSeverity}`,
    passed: found.length > 0,
    message:
      found.length > 0
        ? `命中 ${found.length} 处（${found[0].key} / ${found[0].procedure} / ${found[0].severity}）`
        : `reviewer 未抓到 category=${category} 且 severity≥${minSeverity} 的缺陷（漏判 = reviewer 能力漏洞）`,
  }
}

// ── 文件 / stdout 断言 ───────────────────────────────────────

/** 校验 workDir 下指定相对路径的文件存在 */
export function assertFileExists(workDir: string, relativePath: string): AssertionResult {
  const fullPath = join(resolve(workDir), relativePath)
  const exists = existsSync(fullPath)
  return { name: `file:${relativePath}:exists`, passed: exists, message: exists ? "OK" : `文件不存在: ${fullPath}` }
}

/** 校验 workDir 下某目录包含 ≥ minCount 个指定扩展名文件 */
export function assertFilesExist(
  workDir: string,
  dir: string,
  extension: string,
  minCount: number,
): AssertionResult {
  const fullDir = join(resolve(workDir), dir)
  if (!existsSync(fullDir)) {
    return { name: `files:${dir}/*.${extension}`, passed: false, message: `目录不存在: ${fullDir}` }
  }
  const files = readdirSync(fullDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(`.${extension}`))
    .map(e => e.name)
  const enough = files.length >= minCount
  return {
    name: `files:${dir}/*.${extension}`,
    passed: enough,
    message: enough ? `找到 ${files.length} 个 .${extension} 文件` : `期望 ≥${minCount}，实际 ${files.length}`,
  }
}

/** 校验 stdout 包含指定文本/正则（字符串入参按字面匹配，需正则语义请传 RegExp） */
export function assertStdoutContains(ctx: CaseContext, pattern: string | RegExp): AssertionResult {
  // 字符串入参按字面子串匹配：转义正则元字符，避免 "GET_ITEM(?)" 等让 new RegExp 抛
  // SyntaxError 而把整个 case 炸成 opaque error（而非正常的断言失败）。
  const regex =
    typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : pattern
  const match = regex.test(ctx.stdout)
  return { name: `stdout:${String(pattern)}`, passed: match, message: match ? "OK" : `stdout 不包含 ${pattern}` }
}

// ── 工具函数 ─────────────────────────────────────────────────

/** 按点号路径获取嵌套值 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".")
  let current: unknown = obj
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

// ── 批量断言 ─────────────────────────────────────────────────

/** 运行一组断言，返回所有结果 */
export function runAssertions(ctx: CaseContext, assertions: Array<(c: CaseContext) => AssertionResult>): AssertionResult[] {
  return assertions.map(fn => fn(ctx))
}
