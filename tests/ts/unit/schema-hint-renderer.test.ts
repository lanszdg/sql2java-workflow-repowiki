/**
 * schema-hint-renderer.test.ts — renderSchemaHint 渲染逻辑测试
 */

import { describe, it, expect } from "vitest"
import { renderSchemaHint } from "@workflow/schema-hint-renderer"
import { REFINE_CONSTRAINTS, QUALITY_GATE_HINTS, CROSS_SCHEMA_HINTS, COMMON_PITFALLS } from "@workflow/schema-hint-enrichments"

// ═══════════════════════════════════════════════════════════════

describe("renderSchemaHint", () => {
  const ALL_PHASES = ["inventory", "analyze", "plan", "scaffold", "translate", "dedup", "review", "verify", "fix"]

  it("每个 phase 都产出非空提示", () => {
    for (const phase of ALL_PHASES) {
      const hint = renderSchemaHint(phase)
      expect(hint.length, `phase=${phase}`).toBeGreaterThan(0)
    }
  })

  it("包含标题和警告行", () => {
    for (const phase of ALL_PHASES) {
      const hint = renderSchemaHint(phase)
      expect(hint).toContain("📋 Schema 校验要求")
      expect(hint).toContain("advance 时引擎会严格校验")
    }
  })

  it("包含 optional 字段不写 null 的通用提示", () => {
    for (const phase of ALL_PHASES) {
      const hint = renderSchemaHint(phase)
      expect(hint, `phase=${phase}`).toContain("optional")
      expect(hint, `phase=${phase}`).toContain("不要写")
      expect(hint, `phase=${phase}`).toContain("null")
    }
  })

  it("null/undefined phase 返回空字符串", () => {
    expect(renderSchemaHint(null)).toBe("")
    expect(renderSchemaHint(undefined)).toBe("")
  })

  // ── 关键枚举值抽查 ──

  it("inventory 阶段包含 direction 枚举值", () => {
    const hint = renderSchemaHint("inventory")
    expect(hint).toContain('"IN"')
    expect(hint).toContain('"OUT"')
    expect(hint).toContain('"IN OUT"')
  })

  it("inventory 阶段包含 procedure/function 枚举", () => {
    const hint = renderSchemaHint("inventory")
    expect(hint).toContain('"procedure"')
    expect(hint).toContain('"function"')
  })

  it("review 阶段包含 severity 枚举", () => {
    const hint = renderSchemaHint("review")
    expect(hint).toContain('"critical"')
    expect(hint).toContain('"major"')
    expect(hint).toContain('"minor"')
    expect(hint).toContain('"info"')
  })

  it("analyze 阶段不渲染 riskLevel 枚举（complexity.riskLevel 属代码生成的 analysis.json，已从 hint 去掉）", () => {
    const hint = renderSchemaHint("analyze")
    // riskLevel 在 AnalysisMetaSchema.complexity（analysis.json，代码生成），非 worker 手写，不渲染
    expect(hint).not.toContain('"low"')
    expect(hint).not.toContain('"high"')
    // 但 per-package 的 subprograms 结构仍渲染
    expect(hint).toContain("subprograms")
  })

  it("plan 阶段 namingConvention 在 pitfall 中有推荐值", () => {
    const hint = renderSchemaHint("plan")
    // schema 已放开为 string，不再包含枚举值，但 pitfall 仍推荐 camelCase
    expect(hint).toContain("camelCase")
  })

  it("translate 阶段包含 status 枚举", () => {
    const hint = renderSchemaHint("translate")
    expect(hint).toContain('"completed"')
    expect(hint).toContain('"partial"')
  })

  // ── Per-Package schema ──

  it("inventory 阶段不渲染 per-package schema（InventoryPackageSchema 由代码生成，worker 不写）", () => {
    const hint = renderSchemaHint("inventory")
    // 不渲染 per-package schema 块（注意：字符串 "inventory-packages/{PKG}.json" 仍出现在引擎级校验文字中，故只断言 schema 块头）
    expect(hint).not.toContain("### Per-Package: inventory-packages/{PKG}.json")
    // 顶层 inventory.json schema 仍渲染
    expect(hint).toContain("### inventory.json")
  })

  it("analyze 阶段包含 per-unit schema（UnitAnalysisSchema，PROCEDURE 级下沉）", () => {
    const hint = renderSchemaHint("analyze")
    expect(hint).toContain("analysis-packages/{pkg}/{unitRef}.json")
    expect(hint).toContain("unitRefName")
    // 聚合 analysis-packages/{pkg}.json 由 engine merge（非 agent 手写），不渲染
    expect(hint).not.toContain("Per-Package: analysis-packages/{pkg}.json")
  })

  it("translate/review/verify 阶段包含 per-package schema", () => {
    for (const phase of ["translate", "review", "verify"]) {
      const hint = renderSchemaHint(phase)
      expect(hint, `phase=${phase}`).toContain("translations/{pkg}/")
    }
  })

  // ── Summary schema ──

  it("review 阶段包含 summary schema", () => {
    const hint = renderSchemaHint("review")
    expect(hint).toContain("review-summary.json")
  })

  it("verify 阶段包含 summary schema", () => {
    const hint = renderSchemaHint("verify")
    expect(hint).toContain("verify-summary.json")
  })

  // ── Refine 约束 ──

  it("review 阶段包含 passed/mustFix 约束", () => {
    const hint = renderSchemaHint("review")
    expect(hint).toContain("passed")
    expect(hint).toContain("mustFix")
  })

  it("translate 阶段包含 subprogramMethods 唯一性约束", () => {
    const hint = renderSchemaHint("translate")
    expect(hint).toContain("subprogramMethods")
    expect(hint).toContain("唯一")
  })

  it("fix 阶段包含 fixedPackages 不能为空约束", () => {
    const hint = renderSchemaHint("fix")
    expect(hint).toContain("fixedPackages")
    expect(hint).toContain("不能为空")
  })

  // ── 质量门控 ──

  it("translate 阶段包含质量门控 G1", () => {
    const hint = renderSchemaHint("translate")
    expect(hint).toContain("G1")
    expect(hint).toContain("80%")
  })

  it("review 阶段包含质量门控 G3", () => {
    const hint = renderSchemaHint("review")
    expect(hint).toContain("G3")
    expect(hint).toContain("70")
  })

  it("verify 阶段包含质量门控 G5/G6", () => {
    const hint = renderSchemaHint("verify")
    expect(hint).toContain("G5")
    expect(hint).toContain("G6")
  })

  it("inventory 阶段不包含质量门控", () => {
    const hint = renderSchemaHint("inventory")
    expect(hint).not.toContain("--- 质量门控 ---")
  })

  // ── 跨 Schema 校验 ──

  it("analyze 阶段包含跨 Schema 校验（needsCrossSchemaValidation=true）", () => {
    const hint = renderSchemaHint("analyze")
    expect(hint).toContain("--- 跨 Schema 校验 ---")
  })

  it("plan 阶段包含跨 Schema 校验", () => {
    const hint = renderSchemaHint("plan")
    expect(hint).toContain("--- 跨 Schema 校验 ---")
  })

  it("inventory 阶段包含跨 Schema 校验（analysis.json 由 inventory 产出，需校验 callGraph refName）", () => {
    const hint = renderSchemaHint("inventory")
    expect(hint).toContain("--- 跨 Schema 校验 ---")
  })

  // ── 引擎级校验 ──

  it("inventory 阶段包含 packageName/文件名一致性", () => {
    const hint = renderSchemaHint("inventory")
    expect(hint).toContain("packageName")
    expect(hint).toContain("文件名一致")
  })

  it("scaffold 阶段包含 projectRoot 格式要求", () => {
    const hint = renderSchemaHint("scaffold")
    expect(hint).toContain("projectRoot")
    expect(hint).toContain("generated/{artifactId}")
  })

  // ── Token 预算 ──

  it("每个 phase 的输出长度 < 3500 字符", () => {
    for (const phase of ALL_PHASES) {
      const hint = renderSchemaHint(phase)
      expect(hint.length, `phase=${phase}: ${hint.length} chars`).toBeLessThan(3500)
    }
  })

  // ── 可选字段标记 ──

  it("inventory 阶段包含可选字段标记 ?", () => {
    const hint = renderSchemaHint("inventory")
    // specFile/bodyFile 是 per-package 字段（已不渲染）；顶层 tables[].ddlFile 是 nullable optional
    expect(hint).toContain("ddlFile?:")
  })

  // ── 数字范围 ──

  it("review 阶段包含 overallScore 数字范围", () => {
    const hint = renderSchemaHint("review")
    expect(hint).toContain("0-100")
  })
})

// ═══════════════════════════════════════════════════════════════

describe("renderSchemaHint — 与 enrichments 一致性", () => {
  it("所有 REFINE_CONSTRAINTS 的 phase 都在输出中出现对应约束", () => {
    for (const [phase, constraints] of Object.entries(REFINE_CONSTRAINTS)) {
      const hint = renderSchemaHint(phase)
      for (const c of constraints) {
        // 检查约束的关键词（不要求完全匹配，但核心词应出现）
        const keywords = c.split(/[：，、]/).filter(w => w.length >= 2).slice(0, 3)
        for (const kw of keywords) {
          expect(hint, `phase=${phase}, constraint="${c}", keyword="${kw}"`).toContain(kw)
        }
      }
    }
  })

  it("所有 QUALITY_GATE_HINTS 的 phase 都在输出中出现门控", () => {
    for (const phase of Object.keys(QUALITY_GATE_HINTS)) {
      const hint = renderSchemaHint(phase)
      expect(hint).toContain("--- 质量门控 ---")
      for (const gate of QUALITY_GATE_HINTS[phase]) {
        // G1, G2, G3 等编号必须出现
        const gateId = gate.match(/^G\d+/)?.[0]
        if (gateId) {
          expect(hint, `phase=${phase}, gate=${gateId}`).toContain(gateId)
        }
      }
    }
  })

  it("所有 CROSS_SCHEMA_HINTS 的 phase 都在输出中出现跨 Schema 校验", () => {
    for (const phase of Object.keys(CROSS_SCHEMA_HINTS)) {
      const hint = renderSchemaHint(phase)
      expect(hint, `phase=${phase}`).toContain("--- 跨 Schema 校验 ---")
    }
  })
})

// ═══════════════════════════════════════════════════════════════

describe("renderSchemaHint — 常见被拒原因 (COMMON_PITFALLS)", () => {
  const PHASES_WITH_PITFALLS = Object.keys(COMMON_PITFALLS)

  it("所有有 pitfall 的 phase 输出包含 ⚡ 常见被拒原因 section", () => {
    for (const phase of PHASES_WITH_PITFALLS) {
      const hint = renderSchemaHint(phase)
      expect(hint, `phase=${phase}`).toContain("--- ⚡ 常见被拒原因 ---")
    }
  })

  it("pitfalls section 出现在约束 section 之前", () => {
    for (const phase of PHASES_WITH_PITFALLS) {
      const hint = renderSchemaHint(phase)
      const pitfallIdx = hint.indexOf("--- ⚡ 常见被拒原因 ---")
      const constraintIdx = hint.indexOf("--- 约束 ---")
      // 如果有约束 section，pitfall 应在它之前
      if (constraintIdx !== -1) {
        expect(pitfallIdx, `phase=${phase}: pitfalls 应在约束之前`).toBeLessThan(constraintIdx)
      }
    }
  })

  it("inventory 阶段 pitfalls 包含 direction 大写关键词", () => {
    const hint = renderSchemaHint("inventory")
    expect(hint).toContain("⚡ 常见被拒原因")
    expect(hint).toContain("direction")
    expect(hint).toContain('"IN"')
  })

  it("review 阶段 pitfalls 包含 passed/mustFix 一致性提示", () => {
    const hint = renderSchemaHint("review")
    expect(hint).toContain("⚡ 常见被拒原因")
    expect(hint).toContain("passed=true")
    expect(hint).toContain("mustFix")
  })

  it("translate 阶段 pitfalls 包含 oracleName 重载序号提示", () => {
    const hint = renderSchemaHint("translate")
    expect(hint).toContain("⚡ 常见被拒原因")
    expect(hint).toContain("oracleName")
    expect(hint).toContain("__序号")
  })

  it("每个 pitfall 条目以 '- ' 开头", () => {
    for (const phase of PHASES_WITH_PITFALLS) {
      const hint = renderSchemaHint(phase)
      const pitfallSection = hint.split("--- ⚡ 常见被拒原因 ---")[1]
      if (pitfallSection) {
        // 取到下一个 --- section 之前
        const nextSection = pitfallSection.indexOf("\n--- ")
        const content = nextSection !== -1 ? pitfallSection.substring(0, nextSection) : pitfallSection
        const lines = content.split("\n").filter(l => l.trim().length > 0)
        for (const line of lines) {
          expect(line.trim(), `phase=${phase}: "${line.trim()}"`).toMatch(/^- /)
        }
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// 渲染器完整性 — nullable/联合类型/字符串长度不再丢失
// ═══════════════════════════════════════════════════════════════

describe("renderSchemaHint — 约束完整性（anyOf/nullable/string 长度）", () => {
  it("verify 阶段 nullable 字段渲染为 'number | null' 而非裸 any", () => {
    const hint = renderSchemaHint("verify")
    // totalTests/passedTests/failedTests/line 均为 z.coerce.number().nullable().optional()
    expect(hint).toContain("number | null")
  })

  it("review 阶段 nullable 字段渲染为 'number | null'", () => {
    const hint = renderSchemaHint("review")
    // line: z.coerce.number().nullable().optional()
    expect(hint).toContain("number | null")
  })

  it("fix 阶段 fixedPackages 元素的 minLength 约束保留", () => {
    const hint = renderSchemaHint("fix")
    // fixedPackages: z.array(z.string().min(1))
    expect(hint).toContain("minLen 1")
  })

  it("analyze 阶段不渲染顶层 analysis.json schema（代码生成）", () => {
    const hint = renderSchemaHint("analyze")
    expect(hint).not.toMatch(/###\s*analysis\.json/)
  })

  it("analyze 阶段保留 per-unit analysis-packages schema（worker 手写 per-unit 文件）", () => {
    const hint = renderSchemaHint("analyze")
    expect(hint).toContain("analysis-packages/{pkg}/{unitRef}.json")
  })

  it("inventory 阶段顶层 schema 仍渲染", () => {
    const hint = renderSchemaHint("inventory")
    expect(hint).toContain("### inventory.json")
  })
})
