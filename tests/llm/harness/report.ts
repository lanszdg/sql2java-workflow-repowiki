/**
 * harness/report.ts — 执行点测试结果报告生成器
 *
 * 汇总多个 case 的结果，按 case 维度输出可读报告，保留 exit 0/1 契约供外部流程消费。
 */

import type { AssertionResult, JudgeResult } from "./types"

/** 单个 case 的完整结果 */
export interface CaseReport {
  name: string
  phase: string
  durationMs: number
  assertions: AssertionResult[]
  judge?: JudgeResult
  /** runExecutionPoint 抛错时的错误信息（此时 assertions 为空） */
  error?: string
}

/** 测试套件报告 */
export interface SuiteReport {
  suiteName: string
  results: CaseReport[]
  totalDurationMs: number
}

/** 判定单个 case 是否通过 */
export function casePassed(report: CaseReport): boolean {
  if (report.error) return false
  const allAssertionsPassed = report.assertions.every(a => a.passed)
  const judgePassed = report.judge ? report.judge.pass : true
  return allAssertionsPassed && judgePassed
}

/** 生成测试报告并输出到 stdout，返回文本 */
export function printReport(report: SuiteReport): string {
  const lines: string[] = []
  lines.push("")
  lines.push("═".repeat(70))
  lines.push(`  ${report.suiteName}`)
  lines.push("═".repeat(70))
  lines.push("")

  let passed = 0
  let failed = 0

  for (const item of report.results) {
    const ok = casePassed(item)
    if (ok) passed++
    else failed++

    const icon = ok ? "✅" : "❌"
    lines.push(`${icon} ${item.name} [${item.phase}] (${formatDuration(item.durationMs)})`)

    if (item.error) {
      lines.push(`   💥 执行失败: ${item.error}`)
    }
    for (const assertion of item.assertions) {
      if (!assertion.passed) lines.push(`   ❌ ${assertion.name}: ${assertion.message}`)
    }
    if (item.judge) {
      const judgeIcon = item.judge.pass ? "✅" : "❌"
      lines.push(`   ${judgeIcon} Judge: ${item.judge.score}/100 — ${item.judge.reasoning}`)
    }
    lines.push("")
  }

  lines.push("─".repeat(70))
  lines.push(`  总计: ${report.results.length}  通过: ${passed}  失败: ${failed}`)
  lines.push(`  耗时: ${formatDuration(report.totalDurationMs)}`)
  lines.push("─".repeat(70))
  lines.push("")

  const output = lines.join("\n")
  console.log(output)
  return output
}

/** 生成 JSON 报告（供 CI/外部流程消费） */
export function generateJsonReport(report: SuiteReport): string {
  return JSON.stringify(
    {
      suite: report.suiteName,
      totalDurationMs: report.totalDurationMs,
      total: report.results.length,
      passed: report.results.filter(casePassed).length,
      failed: report.results.filter(r => !casePassed(r)).length,
      results: report.results.map(r => ({
        name: r.name,
        phase: r.phase,
        passed: casePassed(r),
        durationMs: r.durationMs,
        error: r.error ?? null,
        assertions: r.assertions,
        judge: r.judge ?? null,
      })),
    },
    null,
    2,
  )
}

/** 格式化毫秒为可读时间 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = ((ms % 60_000) / 1000).toFixed(1)
  return `${min}m ${sec}s`
}
