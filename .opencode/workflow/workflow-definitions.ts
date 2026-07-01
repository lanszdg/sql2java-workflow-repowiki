/**
 * Workflow Definitions — SQL2JAVA 单流水线工作流定义
 *
 * 8 个阶段 + 1 个条件分支阶段（fix），一个 runId。
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
      // dependency-graph.json（含 callGraph）现由 inventory 阶段代码产出，需在 inventory advance
      // 时运行 validateCrossSchema：校验 analysis↔inventory 包名一致 + callGraph refName 合法性。
      needsCrossSchemaValidation: true,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "analyze",
      description: "子程序结构解析 + FSD 生成（分片 map；依赖图 meta 已由 inventory 代码产出）",
      agentFile: "agent/sql-analyst.md",
      temperature: 0.1,
      maxRetries: 2,
      needsCrossSchemaValidation: true,
      maxPackagesPerShard: 1,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "plan",
      description: "Java 架构规划",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 1,
      needsCrossSchemaValidation: true,
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
      needsCrossSchemaValidation: true,
      maxPackagesPerShard: 1,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "dedup",
      description: "跨包重复代码检测 + 公共模块抽取",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 2,
      needsCrossSchemaValidation: true,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "review",
      description: "静态审核(项目级单次)：Step A 工具确定性扫描(checkstyle+pmd+grep, 全项目一次, 零 LLM) + Step B LLM 聚焦语义审查；reviewer 写一个项目级 review.json(packages[]覆盖全部包)，summary 由 generateReviewSummary 合并静态+语义",
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
      maxRetries: 5,
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
    { from: "translate",  condition: "always",  to: "dedup" },
    { from: "dedup",      condition: "always",  to: "review" },
    // ── review 分支 ──
    { from: "review",     condition: "passed",  to: "verify" },
    { from: "review",     condition: "failed",  to: "fix" },
    // ── verify 分支 ──
    { from: "verify",     condition: "passed",  to: "__done__" },
    { from: "verify",     condition: "failed",  to: "fix" },
    // ── fix 回环：fix → review → verify ──
    { from: "fix",        condition: "always",  to: "review" },
  ],
}

// ============================================================================
// Upstream Artifacts 映射
// ============================================================================

// 共享 artifact 路径常量，避免跨阶段重复声明时遗漏
// inventory-index.json 是预扫描源，仅 inventory 阶段代码生成（generateInventory/
// generateDependencyGraph）+ 边界校验消费，不注入任何下游 worker（其内容已精炼到
// inventory.json / inventory-packages / dependency-graph.json，下游读那些即可）。
const _INV_BASE = ["inventory.json", "inventory-packages/*.json"] as const
const _ANALYSIS = ["dependency-graph.json", "analysis-packages/*.json"] as const
const _PLAN = ["plan.json"] as const
const _SCAFFOLD = ["scaffold.json"] as const
const _DEDUP = ["dedup.json"] as const
const _TRANSLATIONS = ["translations/*/translation.json"] as const
const _FSD = ["fsd/*/*.md"] as const

/** 每个 phase 需要读取的上游 artifact 路径模板 */
export const UPSTREAM_ARTIFACTS: Record<string, string[]> = {
  // inventory-index.json 现由 inventory worker 第 0 步调 workflow({action:"scan"}) 自产，
  // 不再是 start 预生成的 upstream。generateInventory 从 artifactsDir 自行读取。
  inventory: [],
  // analyze 不注入 inventory-index.json：本包源码路径从 inventory-packages/{PKG}.json 的
  // specFile/bodyFile 取（已收窄到本分片）；表结构从 inventory.json，callGraph 从 dependency-graph.json。
  analyze: ["inventory.json", "inventory-packages/*.json", "dependency-graph.json"],
  // plan 是框架设计（包映射/类型映射/规则/约定/manualReviewList），不做逐过程翻译，
  // 不需要 FSD（FSD 是 per-procedure 业务翻译说明书，给 translate 用）。manualReviewList
  // 的高风险项来自 analysis-packages.translationNotes，不依赖 FSD。
  plan: [..._INV_BASE, ..._ANALYSIS],
  scaffold: [..._PLAN, ..._INV_BASE],
  // translate 同样不注入 inventory-index.json（同 analyze 理由：避免全量包源码路径泄漏）。
  // fsd/*/*.md 会在分片模式下被 narrowUpstreamForShard 收窄到 fsd/{pkg}/*.md（本包 FSD）。
  translate: ["inventory.json", "inventory-packages/*.json", ..._PLAN, ..._ANALYSIS, ..._SCAFFOLD, ..._FSD],
  dedup: [..._PLAN, ..._SCAFFOLD, ..._INV_BASE, ..._ANALYSIS, ..._TRANSLATIONS, "dedup-duplicates.json"],
  // TODO (F9): translations/*/translation.json 在 dedup/review/verify 三阶段重复读取，
  // artifactCache 每次 advance 清空导致无法跨阶段缓存。考虑支持只读 artifact 的跨阶段缓存。
  // review-static.json：dispatch 前 engine 写入的项目级静态扫描产物；顶层文件不被 narrowUpstreamForShard 收窄。
  review: [..._PLAN, ..._SCAFFOLD, ..._ANALYSIS, ..._DEDUP, ..._TRANSLATIONS, "review-static.json"],
  verify: [..._PLAN, ..._SCAFFOLD, ..._DEDUP, ..._TRANSLATIONS],
  fix: [
    ..._ANALYSIS, ..._PLAN, ..._SCAFFOLD, ..._DEDUP,
    // 动态路径：取决于触发阶段（review 或 verify），plugin 注入时需根据 branchedFrom 拼接
    "review-summary.json", "verify-summary.json",
    // review 改项目级单文件：fix 读 review.json(语义 mustFix) + review-static.json(静态 finding)
    "review.json",
    "review-static.json",
    ..._TRANSLATIONS, "translations/*/verify.json",
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
  analyze: ["inventory-index.json", "inventory.json", "inventory-packages", "dependency-graph.json"],
  plan: ["inventory-index.json", "inventory.json", "inventory-packages", "dependency-graph.json", "analysis-packages"],
  scaffold: ["plan.json", "inventory-index.json", "inventory.json", "inventory-packages"],
  translate: ["inventory-index.json", "inventory.json", "inventory-packages", "dependency-graph.json", "analysis-packages", "plan.json", "scaffold.json"],
  dedup: ["inventory.json", "plan.json", "scaffold.json", "dependency-graph.json", "translations"],
  review: ["plan.json", "scaffold.json", "dependency-graph.json", "analysis-packages"],
  verify: ["plan.json", "scaffold.json", "dedup.json"],
  fix: [
    "dependency-graph.json", "analysis-packages", "plan.json", "scaffold.json", "dedup.json",
    // 触发阶段的 summary：review-summary.json 或 verify-summary.json，至少一个
    ["review-summary.json", "verify-summary.json"],
    "translations",
  ],
}
