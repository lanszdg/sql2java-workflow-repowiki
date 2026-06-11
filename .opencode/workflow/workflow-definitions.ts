/**
 * Workflow Definitions — SQL2JAVA 单流水线工作流定义
 *
 * 7 个阶段 + 1 个条件分支阶段（fix），一个 runId。
 * 无条件前进 + review/verify 失败时进入 fix 循环（增量重做）。
 */

import type { WorkflowDefinition } from "./engine-core"

// ============================================================================
// SQL2JAVA 单流水线工作流
// ============================================================================

export const SQL2JAVA_WORKFLOW: WorkflowDefinition = {
  id: "sql2java",
  phases: [
    {
      name: "inventory",
      description: "源码扫描编目",
      agentFile: "agent/sql-analyst.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "analyze",
      description: "依赖分析 + 子程序结构解析 + FSD 生成",
      agentFile: "agent/sql-analyst.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "plan",
      description: "Java 架构规划",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 1,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "scaffold",
      description: "Spring Boot 项目骨架生成",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 1,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "translate",
      description: "PL/SQL → Java/MyBatis 逐包翻译",
      agentFile: "agent/translator.md",
      temperature: 0.1,
      maxRetries: 3,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "review",
      description: "翻译质量审查",
      agentFile: "agent/reviewer.md",
      temperature: 0.1,
      maxRetries: 1,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "verify",
      description: "编译验证 + MyBatis 校验 + 测试执行",
      agentFile: "agent/reviewer.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "fix",
      description: "修复审查/验证发现的问题",
      agentFile: "agent/translator.md",
      temperature: 0.1,
      maxRetries: 3,
      isFixPhase: true,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
  ],

  transitions: [
    // ── 主线：无条件前进 ──
    { from: "inventory",  condition: "always",  to: "analyze" },
    { from: "analyze",    condition: "always",  to: "plan" },
    { from: "plan",       condition: "always",  to: "scaffold" },
    { from: "scaffold",   condition: "always",  to: "translate" },
    { from: "translate",  condition: "always",  to: "review" },
    // ── review 分支 ──
    { from: "review",     condition: "passed",  to: "verify" },
    { from: "review",     condition: "failed",  to: "fix" },
    // ── verify 分支 ──
    { from: "verify",     condition: "passed",  to: "__done__" },
    { from: "verify",     condition: "failed",  to: "fix" },
    // ── fix 回环：D7 动态路由，不在此写死 ──
  ],
}

// ============================================================================
// Upstream Artifacts 映射
// ============================================================================

/** 每个 phase 需要读取的上游 artifact 路径模板 */
export const UPSTREAM_ARTIFACTS: Record<string, string[]> = {
  inventory: ["inventory-index.json"],
  analyze: ["inventory-index.json", "inventory.json", "inventory-packages/*.json"],
  plan: ["inventory-index.json", "inventory.json", "inventory-packages/*.json", "analysis.json", "analysis-packages/*.json", "fsd/*/*.md"],
  scaffold: ["plan.json", "inventory-index.json", "inventory.json", "inventory-packages/*.json"],
  translate: ["inventory-index.json", "inventory.json", "inventory-packages/*.json", "plan.json", "analysis.json", "analysis-packages/*.json", "scaffold.json", "fsd/*/*.md"],
  review: ["plan.json", "scaffold.json", "analysis.json", "analysis-packages/*.json", "translations/*/translation.json"],
  verify: ["plan.json", "scaffold.json", "translations/*/translation.json"],
  fix: [
    "analysis.json", "analysis-packages/*.json", "plan.json", "scaffold.json",
    // 动态路径：取决于触发阶段（review 或 verify），plugin 注入时需根据 branchedFrom 拼接
    "review-summary.json", "verify-summary.json",
    "translations/*/translation.json", "translations/*/review.json", "translations/*/verify.json",
  ],
}

// ============================================================================
// --phases 前置依赖校验表
// ============================================================================

/**
 * 前置依赖项：
 *   - string: 必须存在
 *   - string[]: OR 组，至少一个存在即可
 */
export type PrerequisiteItem = string | string[]

/** 目标阶段 → 必须存在的 artifact 文件名（string=必须，string[]=OR组） */
export const PHASE_PREREQUISITES: Record<string, PrerequisiteItem[]> = {
  analyze: ["inventory-index.json", "inventory.json", "inventory-packages"],
  plan: ["inventory-index.json", "inventory.json", "inventory-packages", "analysis.json", "analysis-packages"],
  scaffold: ["plan.json", "inventory-index.json", "inventory.json", "inventory-packages"],
  translate: ["inventory-index.json", "inventory.json", "inventory-packages", "analysis.json", "analysis-packages", "plan.json", "scaffold.json"],
  review: ["plan.json", "scaffold.json", "analysis.json", "analysis-packages"],
  verify: ["plan.json", "scaffold.json"],
  fix: [
    "analysis.json", "analysis-packages", "plan.json", "scaffold.json",
    // 触发阶段的 summary：review-summary.json 或 verify-summary.json，至少一个
    ["review-summary.json", "verify-summary.json"],
    "translations",
  ],
}
