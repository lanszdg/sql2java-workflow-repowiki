/**
 * Schema Hint Renderer — 将 Zod schema + enrichments 渲染为紧凑的人类可读文本
 *
 * 核心流程：
 *   1. 从 artifact-schemas.ts 获取当前阶段的 Zod schema
 *   2. 用 Zod v4 的 toJSONSchema() 转为 JSON Schema
 *   3. jsonSchemaToCompactText() 递归渲染为 pseudo-TypeScript 紧凑格式
 *   4. buildEnrichments() 追加 refine 约束、非 Zod 规则、质量门控、跨 Schema 规则
 *   5. renderSchemaHint() 组装最终输出
 *
 * 设计目标：
 *   - 每阶段输出 ~400-600 tokens（紧凑但完整）
 *   - 枚举值内联、可选字段标 ?、数字范围内联
 *   - 超过 3 层嵌套用 ... 省略自描述结构
 */

import { toJSONSchema } from "zod/v4/core"
import type { ZodType } from "zod"
import {
  getSchemaForPhase, getPerPackageSchema, getPerUnitSchema, getSummarySchema,
  getArtifactFilename,
} from "./artifact-schemas"
import {
  REFINE_CONSTRAINTS, NON_ZOD_VALIDATION_RULES,
  QUALITY_GATE_HINTS, CROSS_SCHEMA_HINTS, COMMON_PITFALLS,
} from "./schema-hint-enrichments"
import { SQL2JAVA_WORKFLOW } from "./workflow-definitions"

// ═══════════════════════════════════════════════════════════════
// JSON Schema → 紧凑 pseudo-TypeScript 渲染
// ═══════════════════════════════════════════════════════════════

/** 最大嵌套深度（超过此深度用 ... 省略，但含枚举的对象始终展开） */
const MAX_DEPTH = 5

/**
 * 递归将 JSON Schema 对象渲染为紧凑 pseudo-TypeScript 格式
 *
 * @param schema - JSON Schema 片段
 * @param indent - 当前缩进级别
 * @param depth  - 当前嵌套深度
 */
function jsonSchemaToCompactText(schema: Record<string, unknown>, indent = 0, depth = 0): string {
  const pad = "  ".repeat(indent)

  // ── 联合类型（anyOf/oneOf）── 必须在 type 分支之前判断：z.nullable()/z.union()/
  // discriminatedUnion 在 toJSONSchema 中产出 anyOf（顶层无 type），否则会穿透到回退 any。
  if (schema.anyOf || schema.oneOf) {
    const subs = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[]
    const parts = subs.map(s => jsonSchemaToCompactText(s, indent, depth))
    return parts.join(" | ")
  }

  // ── 基本类型 ──
  if (schema.type === "string") {
    if (schema.enum && Array.isArray(schema.enum)) {
      return (schema.enum as string[]).map(v => `"${v}"`).join(" | ")
    }
    const c: string[] = []
    if (schema.minLength !== undefined) c.push(`minLen ${schema.minLength}`)
    if (schema.maxLength !== undefined) c.push(`maxLen ${schema.maxLength}`)
    if (typeof schema.pattern === "string") c.push(`/${schema.pattern}/`)
    return c.length ? `string (${c.join(", ")})` : "string"
  }
  if (schema.type === "boolean") return "boolean"
  if (schema.type === "number" || schema.type === "integer") {
    const parts: string[] = [schema.type === "integer" ? "integer" : "number"]
    const constraints: string[] = []
    if (schema.minimum !== undefined) constraints.push(String(schema.minimum))
    if (schema.maximum !== undefined) constraints.push(String(schema.maximum))
    if (constraints.length > 0) parts.push(`(${constraints.join("-")})`)
    return parts.join(" ")
  }
  if (schema.type === "null") return "null"

  // ── 数组 ──
  if (schema.type === "array") {
    const items = schema.items as Record<string, unknown> | undefined
    const prefixItems = schema.prefixItems as Record<string, unknown>[] | undefined

    // Tuple (z.tuple)
    if (prefixItems && prefixItems.length > 0) {
      const elements = prefixItems.map(i => jsonSchemaToCompactText(i, 0, depth))
      return `[${elements.join(", ")}]`
    }

    // 普通数组
    if (items && typeof items === "object") {
      // 深度控制：超过最大深度时省略嵌套对象
      if (depth >= MAX_DEPTH && items.type === "object") {
        return "[{ ... }]"
      }
      const inner = jsonSchemaToCompactText(items, indent + 1, depth + 1)
      // 如果内层是简单类型或短单行，内联为 T[]
      if (!inner.includes("\n") && inner.length < 60) {
        const suffix = schema.minItems ? ` (min ${schema.minItems})` : ""
        return `${inner}[]${suffix}`
      }
      // 多行对象：展开为 [{ key: value, ... }]
      // 把多行内容合并到一行，去掉内部换行
      const oneLine = inner.split("\n").map(l => l.trim()).filter(l => l).join(" ")
      return `[{ ${oneLine} }]`
    }

    const suffix = schema.minItems ? ` (min ${schema.minItems})` : ""
    return `any[]${suffix}`
  }

  // ── 对象（有显式 properties） ──
  // 注意：必须在 Record 分支之前判断。z.object(...).passthrough() 在 toJSONSchema 中会同时产出
  // `properties`（已声明字段）与 `additionalProperties: {}`（允许额外字段）；若先命中 Record 分支，
  // 已声明字段（含枚举、可选标记）会被整体折叠为 `Record<string, any>`，LLM 拿不到字段级指引。
  if (schema.type === "object" && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>
    const required = new Set(schema.required as string[] ?? [])
    const entries = Object.entries(props)

    // 深度控制：含枚举字段的对象始终展开（枚举值对 LLM 最重要）
    const hasEnum = entries.some(([, v]) => v.enum && Array.isArray(v.enum) && (v.enum as unknown[]).length > 0)
    if (depth >= MAX_DEPTH && !hasEnum) {
      return "{ ... }"
    }

    const lines = entries.map(([key, value]) => {
      const optional = required.has(key) ? "" : "?"
      const valueText = jsonSchemaToCompactText(value, indent + 1, depth + 1)
      if (!valueText.includes("\n")) {
        return `${pad}  ${key}${optional}: ${valueText}`
      }
      // 多行值压缩为单行（保持紧凑）
      const oneLine = valueText.split("\n").map(l => l.trim()).filter(l => l).join(" ")
      return `${pad}  ${key}${optional}: ${oneLine}`
    })

    // passthrough（additionalProperties 允许额外字段）时追加提示，不折叠已声明字段
    const allowsExtras = schema.additionalProperties !== undefined && schema.additionalProperties !== false
    const suffix = allowsExtras ? "  // + 允许额外字段（.passthrough）" : ""
    return `{\n${lines.join(",\n")}\n${pad}}${suffix}`
  }

  // ── Record（JSON Schema: type=object + additionalProperties，无显式 properties） ──
  // 仅对真正的 z.record(...)（无 properties，只有 additionalProperties）走此分支。
  if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const valueSchema = schema.additionalProperties as Record<string, unknown>
    const valueText = jsonSchemaToCompactText(valueSchema, indent, depth + 1)
    // 简单值类型内联
    if (!valueText.includes("\n") && valueText.length < 60) {
      return `Record<string, ${valueText}>`
    }
    return `Record<string, { ${valueText.trim()} }>`
  }

  // ── 未知/回退 ──
  return "any"
}

// ═══════════════════════════════════════════════════════════════
// Zod Schema → 紧凑文本（主入口）
// ═══════════════════════════════════════════════════════════════

/**
 * 将单个 Zod schema 渲染为紧凑 pseudo-TypeScript 文本
 */
function renderZodSchema(schema: ZodType): string {
  try {
    const jsonSchema = toJSONSchema(schema as any) as Record<string, unknown>
    return jsonSchemaToCompactText(jsonSchema)
  } catch (e: any) {
    // toJSONSchema 失败时回退到简单提示（不阻断流程）
    return "(schema 渲染失败 — 请参考 agent .md 中的格式说明)"
  }
}

// ═══════════════════════════════════════════════════════════════
// Enrichments 组装
// ═══════════════════════════════════════════════════════════════

/**
 * 组装当前阶段的补充校验信息：
 *   - 常见被拒原因（最高优先级，LLM 最先看到）
 *   - Refine 约束
 *   - 引擎级校验（非 Zod）
 *   - 质量门控
 *   - 跨 Schema 校验
 */
function buildEnrichments(phase: string): string {
  const sections: string[] = []

  // 0. 常见被拒原因（最高优先级）
  const pitfalls = COMMON_PITFALLS[phase]
  if (pitfalls && pitfalls.length > 0) {
    sections.push("--- ⚡ 常见被拒原因 ---\n" + pitfalls.map(p => `- ${p}`).join("\n"))
  }

  // 1. Refine 约束
  const refines = REFINE_CONSTRAINTS[phase]
  if (refines && refines.length > 0) {
    sections.push("--- 约束 ---\n" + refines.map(r => `- ${r}`).join("\n"))
  }

  // 2. 非 Zod 校验
  const nonZod = NON_ZOD_VALIDATION_RULES
    .filter(r => r.phases.includes(phase))
    .map(r => `- ${r.message}`)
  if (nonZod.length > 0) {
    sections.push("--- 引擎级校验 ---\n" + nonZod.join("\n"))
  }

  // 3. 质量门控
  const gates = QUALITY_GATE_HINTS[phase]
  if (gates && gates.length > 0) {
    sections.push("--- 质量门控 ---\n" + gates.map(g => `- ${g}`).join("\n"))
  }

  // 4. 跨 Schema 校验
  const crossSchema = CROSS_SCHEMA_HINTS[phase]
  if (crossSchema && crossSchema.length > 0) {
    sections.push("--- 跨 Schema 校验 ---\n" + crossSchema.map(c => `- ${c}`).join("\n"))
  }

  return sections.join("\n\n")
}

// ═══════════════════════════════════════════════════════════════
// 主入口：renderSchemaHint
// ═══════════════════════════════════════════════════════════════

/** 阶段中文描述映射 */
const PHASE_DESCRIPTIONS: Record<string, string> = {
  inventory: "源码扫描编目",
  analyze: "依赖分析 + 子程序结构解析 + FSD 生成",
  plan: "Java 架构规划",
  scaffold: "Spring Boot 项目骨架生成",
  translate: "PL/SQL → Java/MyBatis 逐包翻译",
  dedup: "跨包重复代码检测 + 公共模块抽取",
  review: "翻译质量审查",
  verify: "编译验证 + MyBatis 校验 + 测试执行",
  fix: "修复审查/验证发现的问题",
}

/**
 * 渲染当前阶段的完整 Schema 校验要求提示。
 *
 * 输出格式：
 *   ## 📋 Schema 校验要求（{phase} 阶段）
 *
 *   ### Top-Level: {filename}.json
 *   {紧凑 schema}
 *
 *   ### Per-Package: {path}
 *   {紧凑 schema}
 *
 *   --- 约束 ---
 *   - ...
 *
 *   --- 引擎级校验 ---
 *   - ...
 *
 * @param phase - 当前阶段名（如 "inventory", "review" 等）
 * @returns 完整的 schema hint 文本，无 schema 时返回空字符串
 */
export function renderSchemaHint(phase: string | null | undefined): string {
  if (!phase) return ""

  const parts: string[] = []
  const desc = PHASE_DESCRIPTIONS[phase] ?? phase
  parts.push(`## 📋 Schema 校验要求（${phase} 阶段 — ${desc}）`)
  parts.push("")
  parts.push("> advance 时引擎会严格校验以下结构。请确保产出符合要求，否则会被拒绝。")
  parts.push(">")
  parts.push("> ⚠️ **optional 字段（标 ? 的）不要写 `null`，无值时直接省略该键。** `z.string().optional()` 接受缺键，拒绝 `null`。")
  parts.push("")

  // ── 顶层 schema ──
  // analyze 阶段跳过：analysis.json 由 inventory 阶段 generateAnalysis 代码产出（非 worker 手写），
  // 其格式由 inventory 边界校验 + CROSS_SCHEMA_HINTS.analyze 文字覆盖，不在此渲染。
  const topLevelSchema = getSchemaForPhase(phase)
  if (topLevelSchema && phase !== "analyze") {
    const filename = getArtifactFilename(phase)
    parts.push(`### ${filename}.json`)
    parts.push(renderZodSchema(topLevelSchema))
    parts.push("")
  }

  // ── Per-unit / per-package schema ──
  // hint 只渲染 worker 手写的产物：
  //   - analyze：PROCEDURE 级 per-unit analysis-packages/{pkg}/{unitRef}.json（UnitAnalysisSchema）；
  //     聚合 analysis-packages/{pkg}.json 由 engine merge（非 agent 手写），不渲染。
  //   - translate：PROCEDURE 级 per-unit translations/{pkg}/{unitRef}.json（UnitTranslationSchema）；
  //     聚合 translation.json 由 engine merge，不渲染。
  //   - inventory 的 inventory-packages/{PKG}.json 由 generateInventory 代码生成（非 worker 手写），不渲染。
  //   - review/verify：per-package 产物。
  const perUnitSchema = (phase === "translate" || phase === "analyze") ? getPerUnitSchema(phase) : null
  const perPackageSchema = perUnitSchema ? null : getPerPackageSchema(phase)
  if (perUnitSchema) {
    const unitDir = phase === "analyze" ? "analysis-packages" : "translations"
    parts.push(`### Per-Unit: ${unitDir}/{pkg}/{unitRef}.json`)
    parts.push(renderZodSchema(perUnitSchema))
    parts.push("")
  } else if (perPackageSchema) {
    const pkgFileName = getArtifactFilename(phase)
    parts.push(`### Per-Package: translations/{pkg}/${pkgFileName}.json`)
    parts.push(renderZodSchema(perPackageSchema))
    parts.push("")
  }

  // ── Summary schema ──
  const summaryPhase = `${phase}-summary`
  const summarySchema = getSummarySchema(summaryPhase)
  if (summarySchema) {
    parts.push(`### Summary: ${summaryPhase}.json`)
    parts.push(renderZodSchema(summarySchema))
    parts.push("")
  }

  // ── Enrichments ──
  const enrichments = buildEnrichments(phase)
  if (enrichments) {
    parts.push(enrichments)
    parts.push("")
  }

  return parts.join("\n")
}
