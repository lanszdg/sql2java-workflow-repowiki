/**
 * harness/judge.ts — 单执行点 LLM-as-a-Judge（test oracle）
 *
 * judge 是验证手段，不是被测对象。它判的是 .opencode agent 的真实产出片段（target），
 * rubric 由 case 提供、引用 .opencode 规约条款（如 java-code-spec "(九)13"）。
 * 通过 opencode run 调用 LLM 返回结构化 JSON 评分。
 *
 * 改造自旧版「整体 workflow 综合分」：粒度变单执行点、喂料变具体产出、rubric 由 case 提供。
 */

import { execSync } from "node:child_process"
import type { JudgeExecutionPointOptions, JudgeResult } from "./types"

/**
 * 用 LLM-as-a-Judge 对单个执行点的具体产出做语义判定。
 */
export async function judgeExecutionPoint(opts: JudgeExecutionPointOptions): Promise<JudgeResult> {
  const { rubric, target, phase, threshold = 70, model } = opts
  const prompt = buildJudgePrompt(rubric, target, phase, threshold)

  try {
    const modelFlag = model ? ` --model ${model}` : ""
    const output = execSync(`opencode run${modelFlag} "${prompt.replace(/"/g, '\\"')}"`, {
      timeout: 120_000,
      encoding: "utf-8",
    })
    return parseJudgeOutput(output, threshold)
  } catch {
    return { pass: false, score: 0, reasoning: "Judge 执行失败（opencode 不可用或超时）", suggestions: [] }
  }
}

/** 构造 judge prompt（rubric 引用规约条款，target 是具体产出片段） */
function buildJudgePrompt(rubric: string, target: string, phase: PhaseNameLike, threshold: number): string {
  return `You are a quality judge evaluating ONE execution point of a PL/SQL → Java/MyBatis workflow.

Phase under test: ${phase}
Passing threshold: ${threshold}/100

Judging rubric (references the project's java-code-spec):
${rubric}

Concrete artifact produced by the .opencode agent for this execution point:
"""
${target}
"""

Evaluate ONLY whether this concrete output satisfies the rubric.
Respond with ONLY a JSON object:
{
  "score": <0-100>,
  "reasoning": "<brief explanation tied to the rubric>",
  "suggestions": ["<improvement 1>", ...]
}

No other text, just the JSON.`
}

type PhaseNameLike = string

/**
 * 从输出中提取首个含 "score" 字段的 JSON 对象。
 *
 * 用平衡括号扫描（正确处理嵌套对象与字符串内的 { }），而非贪婪正则 ——
 * 后者 /\{[\s\S]*"score"[\s\S]*\}/ 会从首个 { 一路匹配到末个 }，LLM 在 JSON 之后
 * 输出任何含 } 的文字（说明性括号、第二段代码块）都会让匹配越界、JSON.parse 失败，
 * 把合格高分判成 0。
 */
function extractJudgeJson(output: string): Record<string, unknown> | null {
  for (let i = output.indexOf("{"); i >= 0; i = output.indexOf("{", i + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < output.length; j++) {
      const ch = output[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === "\\") esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') {
        inStr = true
      } else if (ch === "{") {
        depth++
      } else if (ch === "}") {
        depth--
        if (depth === 0) {
          try {
            const obj = JSON.parse(output.slice(i, j + 1))
            if (obj && typeof obj === "object" && "score" in obj) return obj
          } catch {
            // 该起始 { 不是合法 JSON 对象，尝试下一个 {
          }
          break
        }
      }
    }
  }
  return null
}

/** 从 judge 输出解析 JSON 评分 */
export function parseJudgeOutput(output: string, threshold: number): JudgeResult {
  const parsed = extractJudgeJson(output)
  if (!parsed) {
    return { pass: false, score: 0, reasoning: "无法解析 Judge 输出", suggestions: [] }
  }
  const rawScore = parsed.score
  // number 直接用（不再被 || 0 吞掉合法的 0）；字符串数字（"85"）兼容转换。
  const score = typeof rawScore === "number" ? rawScore : Number(rawScore) || 0
  return {
    pass: score >= threshold,
    score,
    reasoning: String(parsed.reasoning ?? ""),
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
  }
}
