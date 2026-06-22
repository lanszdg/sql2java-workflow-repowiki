/**
 * run.ts — L2 执行点测试 runner
 *
 * 流程：加载用例 → 每个 case 独立 workDir → runExecutionPoint（真实 agent）→ 断言 → 可选 judge → 报告。
 *
 * 用法（由 run-tests.sh 调用，或直接）：
 *   bun tests/llm/run.ts                # 跑全部用例
 *   bun tests/llm/run.ts <case>...      # 跑指定用例
 *   ENABLE_JUDGE=1 bun tests/llm/run.ts # 启用 LLM-as-Judge
 *
 * 退出码：全部通过 0，否则 1（供外部流程消费）。
 */

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { safeRm } from "../../.opencode/workflow/cross-platform"
import {
  runExecutionPoint,
  runAssertions,
  judgeExecutionPoint,
  printReport,
  casePassed,
  type CaseReport,
  type SuiteReport,
} from "./harness"
import { loadAllCases, loadCase } from "./case-loader"
import type { CaseConfig } from "./harness"

const LLM_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\//, process.platform === "win32" ? "" : "/"))
const WORKSPACE_ROOT = join(LLM_DIR, ".workspace")

async function main() {
  const argv = process.argv.slice(2)
  const enableJudge = process.env.ENABLE_JUDGE === "1"

  const cases: CaseConfig[] = argv.length > 0
    ? await Promise.all(argv.map(n => loadCase(n)))
    : await loadAllCases()

  if (cases.length === 0) {
    console.error("未找到任何用例（tests/llm/cases/<name>/case.config.ts）")
    process.exit(1)
  }

  const reports: CaseReport[] = []
  let totalDurationMs = 0

  for (const cfg of cases) {
    const workDir = join(WORKSPACE_ROOT, cfg.name)
    // 隔离：每个 case 开始前清空独立 workDir（safeRm：Windows 瞬时锁定重试）
    safeRm(workDir)
    mkdirSync(workDir, { recursive: true })

    console.log(`\n▶ ${cfg.name} [${cfg.phase}]`)
    const startMs = Date.now()

    let report: CaseReport
    try {
      const { ctx, durationMs } = await runExecutionPoint({
        workDir,
        phase: cfg.phase,
        sourcePath: cfg.sourcePath,
        prepareArtifacts: cfg.prepareArtifacts,
        prepareFixture: cfg.prepareFixture,
        trigger: cfg.trigger,
        timeout: cfg.timeout,
      })
      totalDurationMs += durationMs

      const assertions = runAssertions(ctx, cfg.assertions)

      let judge
      if (enableJudge && cfg.judge) {
        const target = safeSelect(cfg.judge.targetSelector, ctx)
        judge = await judgeExecutionPoint({
          rubric: cfg.judge.rubric,
          target,
          phase: cfg.phase,
          threshold: cfg.judge.threshold,
          model: cfg.judge.model,
        })
      }

      report = { name: cfg.name, phase: cfg.phase, durationMs, assertions, judge }
    } catch (e: any) {
      totalDurationMs += Date.now() - startMs
      report = { name: cfg.name, phase: cfg.phase, durationMs: Date.now() - startMs, assertions: [], error: e?.message ?? String(e) }
    }

    reports.push(report)
  }

  const suite: SuiteReport = {
    suiteName: "sql2java-workflow L2 执行点测试",
    results: reports,
    totalDurationMs,
  }
  printReport(suite)

  const anyFailed = reports.some(r => !casePassed(r))
  process.exit(anyFailed ? 1 : 0)
}

/** 安全调用 targetSelector，选择器抛错时退化为占位文本 */
function safeSelect(selector: (ctx: any) => string, ctx: any): string {
  try {
    return selector(ctx)
  } catch (e: any) {
    return `(targetSelector 执行失败: ${e?.message ?? e})`
  }
}

main().catch(e => {
  console.error("runner 执行失败:", e)
  process.exit(2)
})
