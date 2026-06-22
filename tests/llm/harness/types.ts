/**
 * harness/types.ts — L2 执行点测试的类型定义
 *
 * 设计参见 test-framework-design.md §9.1。
 * 本文件无运行时依赖，可被 tsx（case-loader/case.config.ts）与 vitest（oracle 自测）安全加载。
 */

/** 工作流阶段名（与 .opencode/workflow/workflow-definitions.ts 同源） */
export type PhaseName =
  | "inventory"
  | "analyze"
  | "plan"
  | "scaffold"
  | "translate"
  | "dedup"
  | "review"
  | "verify"
  | "fix"

/** 单条断言的判定结果（oracle 语义） */
export interface AssertionResult {
  name: string
  passed: boolean
  message: string
}

/**
 * 执行点上下文：runExecutionPoint 产出后供断言 / judge 引用。
 *  - artifacts：该 phase 产出的结构化 artifact，按「相对 run 目录的路径」为键
 *    （如 "review-summary.json"、"translations/BAD_PKG/review.json"）
 *  - generatedFiles：生成的源码（按工作目录相对路径为键 → 文件内容）
 */
export interface CaseContext {
  artifacts: Record<string, unknown>
  generatedFiles: Record<string, string>
  stdout: string
  workDir: string
  runId: string
}

/** LLM-as-Judge（单执行点 oracle）配置 */
export interface JudgeExecutionPointOptions {
  /** case 专项 rubric，引用 .opencode 规约条款（如 java-code-spec "(九)13"） */
  rubric: string
  /** 喂给 judge 的具体产出片段（Java catch 段 / decisions 数组 / mustFix 列表） */
  target: string
  phase: PhaseName
  /** 达标阈值，默认 70 */
  threshold?: number
  /** 指定模型（可选，用 opencode 默认） */
  model?: string
}

/** Judge 判定结果 */
export interface JudgeResult {
  pass: boolean
  score: number
  reasoning: string
  suggestions: string[]
}

/**
 * 一个执行点测试用例。
 * 用例 = 一个子目录（case.config.ts），由 case-loader 加载。
 */
export interface CaseConfig {
  /** 用例名（= 目录名） */
  name: string
  /** 目标执行点 phase */
  phase: PhaseName
  /**
   * 触发命令。默认 "/sql2java resume" —— 复用 harness 预置的 run（status=running 停在目标 phase），
   * 走 .opencode 真实 command → 真实 agent（同源）。agent 永远真跑。
   */
  trigger?: string
  /** 确定性断言（可机械验证的优先用断言，快、稳） */
  assertions: Array<(ctx: CaseContext) => AssertionResult>
  /** LLM judge（仅语义判断点；可选） */
  judge?: {
    rubric: string
    targetSelector: (ctx: CaseContext) => string
    threshold?: number
    /** 指定 judge 用的模型（可选，默认用 opencode 默认模型） */
    model?: string
  }
  /**
   * 预置上游 artifact：接收 run artifact 目录的绝对路径，写入上游 artifact。
   * 可用 artifact-factory 造 mock 桩，或写真实/baseline 数据（按 case 需要，见 Mock 策略表）。
   */
  prepareArtifacts?: (artifactsDir: string) => void
  /** 预置真实输入（最小 SQL / 含缺陷 Java）到 workDir */
  prepareFixture?: (workDir: string) => void
  /** translate 用：PL/SQL 源码目录（相对 workDir） */
  sourcePath?: string
  /** 超时毫秒，默认 600_000 */
  timeout?: number
}
