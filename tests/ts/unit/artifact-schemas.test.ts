/**
 * artifact-schemas.test.ts — Zod Schema 校验测试
 */

import { describe, it, expect } from "vitest"
import {
  InventoryIndexSchema,
  InventoryPackageSchema,
  InventorySchema,
  AnalysisMetaSchema,
  AnalysisPackageSchema,
  PlanSchema,
  ScaffoldSchema,
  TranslationSchema,
  ReviewSchema,
  ReviewSummarySchema,
  VerifySchema,
  VerifySummarySchema,
  DedupSchema,
  FixArtifactSchema,
  getSchemaForPhase,
  getPerPackageSchema,
  getSummarySchema,
  getArtifactFilename,
  getInventoryPackageSchema,
  getAnalysisPackageSchema,
} from "@workflow/artifact-schemas"
import {
  makeInventoryIndex, makeInventory, makeInventoryPackage, makeAnalysisMeta,
  makePlan, makeScaffold, makeAnalysisPackage, makeTranslation,
  makeReviewSummary, makeVerifySummary, makeDedup, makeFixArtifact,
} from "../helpers/artifact-factory"

// ═══════════════════════════════════════════════════════════════
// Schema 有效数据通过校验
// ═══════════════════════════════════════════════════════════════

describe("Schema 有效数据通过校验", () => {
  it("InventoryIndexSchema 通过", () => {
    expect(InventoryIndexSchema.safeParse(makeInventoryIndex()).success).toBe(true)
  })

  it("InventoryPackageSchema 通过（有 bodyFile + procedures）", () => {
    const data = {
      packageName: "CORE_PKG",
      specFile: "pkg/core_pkg.pks",
      bodyFile: "pkg/core_pkg.pkb",
      procedures: [
        {
          name: "GET_ITEM", type: "function",
          params: [{ name: "P_ID", oracleType: "NUMBER", direction: "IN" }],
          returnType: "VARCHAR2",
          lineRange: [10, 50], loc: 40,
        },
      ],
      types: [],
      variables: [],
      constants: [],
    }
    expect(InventoryPackageSchema.safeParse(data).success).toBe(true)
  })

  it("InventoryPackageSchema 通过（无 procedures，无需 bodyFile）", () => {
    const data = {
      packageName: "TYPES_PKG",
      specFile: "pkg/types_pkg.pks",
      procedures: [],
      types: [{ name: "REC_TYPE", kind: "RECORD", definition: "IS RECORD(...)" }],
      variables: [],
      constants: [],
    }
    expect(InventoryPackageSchema.safeParse(data).success).toBe(true)
  })

  it("InventorySchema 通过", () => {
    const data = {
      sourcePath: "/test",
      packageNames: ["CORE_PKG"],
      tables: [],
      standaloneProcedures: [],
      triggers: [],
      views: [],
      sequences: [],
    }
    expect(InventorySchema.safeParse(data).success).toBe(true)
  })

  it("AnalysisMetaSchema 通过", () => {
    const data = {
      callGraph: {},
      packageDependency: {},
      translationOrder: [["CORE_PKG"]],
      complexity: { CORE_PKG: { score: 5, patterns: ["cursor"], riskLevel: "medium" } },
      sccGroups: [["CORE_PKG"]],
      packageNames: ["CORE_PKG"],
    }
    expect(AnalysisMetaSchema.safeParse(data).success).toBe(true)
  })

  it("AnalysisPackageSchema 通过", () => {
    const data = {
      packageName: "CORE_PKG",
      subprograms: [{
        name: "GET_ITEM",
        blocks: [],
        variables: [],
        cursors: [],
        exceptionHandlers: [],
        translationNotes: ["Simple getter"],
      }],
    }
    expect(AnalysisPackageSchema.safeParse(data).success).toBe(true)
  })

  it("PlanSchema 通过", () => {
    expect(PlanSchema.safeParse(makePlan()).success).toBe(true)
  })

  it("ScaffoldSchema 通过", () => {
    const data = {
      projectRoot: "/abs/path/generated/item-service",
      structure: {
        directories: ["src/main/java/com/example"],
        pomXml: "pom.xml",
      },
      generated: {
        entities: [],
        mapperInterfaces: [],
        serviceShells: [],
        commonClasses: [],
      },
      conventions: "Standard Spring Boot conventions",
    }
    expect(ScaffoldSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema 通过", () => {
    const data = {
      packageName: "CORE_PKG",
      status: "completed",
      completedSubprograms: ["GET_ITEM"],
      totalSubprograms: 1,
      files: [{ path: "service/ItemService.java", role: "service-impl" }],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema 含 subprogramMethods 通过", () => {
    const data = {
      packageName: "CORE_PKG",
      status: "completed",
      completedSubprograms: ["GET_ITEM"],
      totalSubprograms: 1,
      files: [{ path: "service/ItemService.java", role: "service-impl" }],
      decisions: [],
      todos: [],
      subprogramMethods: [
        { oracleName: "get_item", javaClass: "com.example.item.ItemService", javaMethod: "getItem", javaFile: "service/ItemService.java" },
      ],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema 重载子程序 refName 唯一（__序号区分，重复 oracleName 被拒）", () => {
    const data = {
      packageName: "CORE_PKG",
      status: "completed",
      completedSubprograms: ["get_param__1", "get_param__2"],
      totalSubprograms: 2,
      files: [],
      decisions: [],
      todos: [],
      subprogramMethods: [
        { oracleName: "get_param__1", javaClass: "com.example.item.ItemService", javaMethod: "getParamById" },
        { oracleName: "get_param__2", javaClass: "com.example.item.ItemService", javaMethod: "getParamByName" },
      ],
    }
    // 合法：两个不同 refName → 通过
    expect(TranslationSchema.safeParse(data).success).toBe(true)

    // 非法：重复 oracleName（裸名撞重载的典型错误）→ 被拒
    const dup = { ...data, subprogramMethods: [
      { oracleName: "get_param", javaClass: "X", javaMethod: "a" },
      { oracleName: "get_param", javaClass: "X", javaMethod: "b" },
    ] }
    const parsed = TranslationSchema.safeParse(dup)
    expect(parsed.success).toBe(false)
  })

  it("ReviewSchema 通过 (passed=true, mustFix=[])", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: true,
      overallScore: 85,
      procedureReviews: [],
      mustFix: [],
      suggestions: [],
      todoRemainingCount: 0,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })

  it("ReviewSchema 通过 (passed=false, mustFix 非空)", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: false,
      overallScore: 50,
      procedureReviews: [],
      mustFix: [{ file: "ItemService.java", line: 10, issue: "Missing null check" }],
      suggestions: [],
      todoRemainingCount: 1,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })

  it("ReviewSummarySchema 通过 (allPassed=true)", () => {
    expect(ReviewSummarySchema.safeParse(makeReviewSummary()).success).toBe(true)
  })

  it("ReviewSummarySchema 通过 (allPassed=false)", () => {
    const data = {
      allPassed: false,
      packageResults: [
        { packageName: "CORE_PKG", passed: false, score: 50, mustFixCount: 2 },
      ],
      totalMustFix: 2,
      totalTodosRemaining: 1,
    }
    expect(ReviewSummarySchema.safeParse(data).success).toBe(true)
  })

  it("VerifySchema 通过 (passed=true, mustFix=[])", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: true,
      mybatisValidation: { mapperXmlValid: true, statementIdsMatch: true },
      todoRemainingCount: 0,
      mustFix: [],
    }
    expect(VerifySchema.safeParse(data).success).toBe(true)
  })

  it("VerifySummarySchema 通过 (allPassed=true)", () => {
    const data = {
      allPassed: true,
      compilation: { success: true, errors: [] },
      packageResults: [{ packageName: "CORE_PKG", passed: true, mybatisValid: true }],
      testExecution: { executed: true, testFiles: ["ItemServiceTest.java"] },
      totalTodosRemaining: 0,
    }
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("VerifySummarySchema 通过 (compilation failed, errors 非空)", () => {
    const data = {
      allPassed: false,
      compilation: {
        success: false,
        errors: [{ file: "ItemService.java", line: 10, message: "cannot find symbol" }],
      },
      packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 1,
    }
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("DedupSchema 通过", () => {
    expect(DedupSchema.safeParse(makeDedup()).success).toBe(true)
  })

  it("FixArtifactSchema 通过", () => {
    expect(FixArtifactSchema.safeParse(makeFixArtifact()).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// 工厂默认产出符合 Schema（防止工厂与 schema 漂移，P9）
// ═══════════════════════════════════════════════════════════════

describe("工厂默认产出符合 Schema", () => {
  it("makeScaffold 默认值通过 ScaffoldSchema", () => {
    expect(ScaffoldSchema.safeParse(makeScaffold()).success).toBe(true)
  })
  it("makeAnalysisMeta 默认值通过 AnalysisMetaSchema", () => {
    expect(AnalysisMetaSchema.safeParse(makeAnalysisMeta()).success).toBe(true)
  })
  it("makeTranslation 默认值通过 TranslationSchema", () => {
    expect(TranslationSchema.safeParse(makeTranslation()).success).toBe(true)
  })
  it("makeInventoryPackage 默认值通过 InventoryPackageSchema", () => {
    expect(InventoryPackageSchema.safeParse(makeInventoryPackage()).success).toBe(true)
  })
  it("makeAnalysisPackage 默认值通过 AnalysisPackageSchema", () => {
    expect(AnalysisPackageSchema.safeParse(makeAnalysisPackage()).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// Schema 无效数据被拒绝
// ═══════════════════════════════════════════════════════════════

describe("Schema 无效数据被拒绝", () => {
  it("InventoryIndexSchema 缺少必填字段失败", () => {
    const result = InventoryIndexSchema.safeParse({ sourcePath: "/test" })
    expect(result.success).toBe(false)
  })

  it("InventoryIndexSchema callGraph 可选缺失通过", () => {
    const data = makeInventoryIndex()
    delete (data as any).callGraph
    expect(InventoryIndexSchema.safeParse(data).success).toBe(true)
  })

  it("InventoryPackageSchema 有 procedures 但无 bodyFile → refine 失败", () => {
    const data = {
      packageName: "CORE_PKG",
      specFile: "pkg/core_pkg.pks",
      // 无 bodyFile
      procedures: [
        {
          name: "GET_ITEM", type: "function",
          params: [], lineRange: [1, 10], loc: 10,
        },
      ],
      types: [],
      variables: [],
      constants: [],
    }
    const result = InventoryPackageSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("ReviewSchema passed=true + mustFix 非空 → refine 失败", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: true,
      overallScore: 80,
      procedureReviews: [],
      mustFix: [{ file: "a.java", issue: "bug" }],
      suggestions: [],
      todoRemainingCount: 0,
    }
    const result = ReviewSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("ReviewSchema passed=false + mustFix 空 → refine 失败", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: false,
      overallScore: 40,
      procedureReviews: [],
      mustFix: [],
      suggestions: [],
      todoRemainingCount: 1,
    }
    const result = ReviewSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("ReviewSummarySchema allPassed 与 packageResults 矛盾 → refine 失败", () => {
    const data = {
      allPassed: true,
      packageResults: [
        { packageName: "CORE_PKG", passed: false, score: 50, mustFixCount: 2 },
      ],
      totalMustFix: 2,
      totalTodosRemaining: 1,
    }
    const result = ReviewSummarySchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("VerifySummarySchema compilation failed 但 errors=[] → 通过（已放松：空数组视为已声明）", () => {
    const data = {
      allPassed: false,
      compilation: { success: false, errors: [] },
      packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 1,
    }
    const result = VerifySummarySchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it("VerifySummarySchema compilation failed 且 errors 完全缺失 → refine 失败", () => {
    const data = {
      allPassed: false,
      compilation: { success: false },
      packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 1,
    }
    const result = VerifySummarySchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("FixArtifactSchema fixedPackages 为空 → refine 失败", () => {
    const result = FixArtifactSchema.safeParse({ fixedPackages: [] })
    expect(result.success).toBe(false)
  })

  it("PlanSchema 无效 namingConvention 现在也能通过（已放开为 string）", () => {
    const planData = {
      targetProject: {
        groupId: "com.example", artifactId: "item-service",
        packageBase: "com.example.item", javaVersion: "17", springBootVersion: "3.2.0",
      },
      packageMappings: [],
      rules: {
        namingConvention: "snake_case",
        nullHandling: "optional",
        exceptionStrategy: "spring-data",
        logFramework: "slf4j",
      },
      typeMappings: {},
      manualReviewList: [],
      conventions: "",
    }
    const result = PlanSchema.safeParse(planData)
    expect(result.success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// Schema 查找函数
// ═══════════════════════════════════════════════════════════════

describe("getArtifactFilename", () => {
  it("analyze → analysis", () => {
    expect(getArtifactFilename("analyze")).toBe("analysis")
  })

  it("translate → translation", () => {
    expect(getArtifactFilename("translate")).toBe("translation")
  })

  it("inventory → inventory", () => {
    expect(getArtifactFilename("inventory")).toBe("inventory")
  })

  it("plan → plan", () => {
    expect(getArtifactFilename("plan")).toBe("plan")
  })

  it("未知 phase 返回原值", () => {
    expect(getArtifactFilename("custom-phase")).toBe("custom-phase")
  })
})

describe("getSchemaForPhase", () => {
  const knownPhases = ["inventory", "inventory-index", "analyze", "plan", "scaffold", "dedup", "fix"]

  it("已知阶段都返回非 null schema", () => {
    for (const phase of knownPhases) {
      expect(getSchemaForPhase(phase), `getSchemaForPhase("${phase}") should not be null`).not.toBeNull()
    }
  })

  it("未知阶段返回 null", () => {
    expect(getSchemaForPhase("unknown")).toBeNull()
  })
})

describe("getPerPackageSchema", () => {
  it("translate 返回 TranslationSchema", () => {
    expect(getPerPackageSchema("translate")).not.toBeNull()
  })

  it("review 返回 ReviewSchema", () => {
    expect(getPerPackageSchema("review")).not.toBeNull()
  })

  it("verify 不再 per-package（动态结果落 verify-summary.json）", () => {
    // verify 静态检查归 review，动态检查（mvn + 归因）由 generateVerifySummary 代码聚合到
    // verify-summary.json；不再产 per-package verify.json。
    expect(getPerPackageSchema("verify")).toBeNull()
  })

  it("非 per-package 阶段返回 null", () => {
    expect(getPerPackageSchema("inventory")).toBeNull()
    expect(getPerPackageSchema("plan")).toBeNull()
  })
})

describe("getSummarySchema", () => {
  it("review-summary 返回非 null", () => {
    expect(getSummarySchema("review-summary")).not.toBeNull()
  })

  it("verify-summary 返回非 null", () => {
    expect(getSummarySchema("verify-summary")).not.toBeNull()
  })

  it("非 summary 阶段返回 null", () => {
    expect(getSummarySchema("review")).toBeNull()
  })
})

describe("getInventoryPackageSchema", () => {
  it("返回非 null schema", () => {
    expect(getInventoryPackageSchema()).not.toBeNull()
  })
})

describe("getAnalysisPackageSchema", () => {
  it("返回非 null schema", () => {
    expect(getAnalysisPackageSchema()).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
// 类型放松：Zod 不再因合理变体拒绝 LLM 产出
// ═══════════════════════════════════════════════════════════════

describe("类型放松 — 合理 LLM 变体不再被拒", () => {
  it("InventoryPackageSchema: bodyFile='' + procedures → 通过", () => {
    const data = {
      packageName: "CORE_PKG",
      bodyFile: "",
      procedures: [
        { name: "P", type: "procedure", params: [], lineRange: [1, 10] as [number, number], loc: 10 },
      ],
      types: [],
      variables: [],
      constants: [],
    }
    expect(InventoryPackageSchema.safeParse(data).success).toBe(true)
  })

  it("InventoryPackageSchema: bodyFile=null + procedures → 通过", () => {
    const data = {
      packageName: "CORE_PKG",
      bodyFile: null,
      procedures: [
        { name: "P", type: "procedure", params: [], returnType: null, lineRange: [1, 10] as [number, number], loc: 10 },
      ],
      types: [],
      variables: [],
      constants: [],
    }
    expect(InventoryPackageSchema.safeParse(data).success).toBe(true)
  })

  it("InventorySchema: defaultValue=null → 通过", () => {
    const data = {
      sourcePath: "/test",
      packageNames: ["X"],
      tables: [{
        name: "T",
        ddlFile: null,
        columns: [{ name: "C", oracleType: "NUM", nullable: true, isPrimaryKey: false, defaultValue: null }],
      }],
      standaloneProcedures: [],
      triggers: [],
      views: [],
      sequences: [],
    }
    expect(InventorySchema.safeParse(data).success).toBe(true)
  })

  it("VerifySummarySchema: errors=[] + success=false → 通过", () => {
    const data = {
      allPassed: false,
      compilation: { success: false, errors: [] },
      packageResults: [{ packageName: "X", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 0,
    }
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema: files.role 非枚举值 → 通过", () => {
    const data = {
      packageName: "X",
      status: "completed",
      completedSubprograms: ["A"],
      totalSubprograms: 1,
      files: [{ path: "a.java", role: "entity" }],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema: status 非枚举值 → 通过", () => {
    const data = {
      packageName: "X",
      status: "in_progress",
      completedSubprograms: [],
      totalSubprograms: 5,
      files: [],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema: totalSubprograms 为字符串 → 通过（coerce）", () => {
    const data = {
      packageName: "X",
      status: "completed",
      completedSubprograms: ["A"],
      totalSubprograms: "5",
      files: [],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("ReviewSchema: checks.category 非枚举值 → 通过", () => {
    const data = {
      packageName: "X",
      passed: true,
      overallScore: 85,
      procedureReviews: [{ procedure: "P", checks: [{ category: "custom-check", passed: true, detail: "ok", severity: "info" }] }],
      mustFix: [],
      suggestions: [],
      todoRemainingCount: 0,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })

  it("ReviewSchema: suggestions 含对象 → 通过", () => {
    const data = {
      packageName: "X",
      passed: true,
      overallScore: 85,
      mustFix: [],
      suggestions: [{ severity: "info", issue: "minor issue" }],
      todoRemainingCount: 0,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// 大小写 normalize — ciEnum 自动纠正 LLM 大小写变体
// ═══════════════════════════════════════════════════════════════

describe("大小写 normalize — ciEnum 自动纠正 LLM 大小写变体", () => {
  // ── direction (ciEnumUpper) ──────────────────────────────

  it("InventoryProcedureSchema: direction 大小写变体 normalize 为大写", () => {
    const base = {
      name: "GET_ITEM",
      params: [{ name: "P_ID", oracleType: "NUMBER", direction: "IN" }],
      returnType: null,
      lineRange: [1, 10] as [number, number],
      loc: 10,
    }

    // 小写 "in" → normalize 为 "IN"
    const lower = { ...base, type: "procedure", params: [{ ...base.params[0], direction: "in" }] }
    const resultLower = InventoryPackageSchema.safeParse({
      packageName: "CORE_PKG", bodyFile: "pkg.pkb",
      procedures: [lower], types: [], variables: [], constants: [],
    })
    expect(resultLower.success).toBe(true)
    if (resultLower.success) {
      expect(resultLower.data.procedures[0].params[0].direction).toBe("IN")
    }

    // 混合大小写 "In" → normalize 为 "IN"
    const mixed = { ...base, type: "procedure", params: [{ ...base.params[0], direction: "In" }] }
    const resultMixed = InventoryPackageSchema.safeParse({
      packageName: "CORE_PKG", bodyFile: "pkg.pkb",
      procedures: [mixed], types: [], variables: [], constants: [],
    })
    expect(resultMixed.success).toBe(true)
    if (resultMixed.success) {
      expect(resultMixed.data.procedures[0].params[0].direction).toBe("IN")
    }
  })

  it("InventoryProcedureSchema: direction 'in out' normalize 为 'IN OUT'", () => {
    const data = {
      packageName: "CORE_PKG", bodyFile: "pkg.pkb",
      procedures: [{
        name: "P", type: "procedure",
        params: [{ name: "X", oracleType: "NUMBER", direction: "in out" }],
        returnType: null, lineRange: [1, 10] as [number, number], loc: 10,
      }],
      types: [], variables: [], constants: [],
    }
    const result = InventoryPackageSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.procedures[0].params[0].direction).toBe("IN OUT")
    }
  })

  // ── type (ciEnumLower) ───────────────────────────────────

  it("InventoryIndexSchema: type 大小写变体 normalize 为小写", () => {
    const base = {
      sourcePath: "/test", scannedAt: "2026-06-01T00:00:00.000Z", scannerUsed: "regex",
      packages: [{
        name: "PKG", specFile: "a.pks", bodyFile: "a.pkb",
        procedures: [{ name: "P", type: "PROCEDURE", lineRange: [1, 10] as [number, number] }],
        estimatedLoc: 10,
      }],
      tables: [], triggers: [], views: [], sequences: [], standaloneProcedures: [],
    }
    const result = InventoryIndexSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.packages[0].procedures[0].type).toBe("procedure")
    }
  })

  it("InventoryIndexSchema: type 'Function' normalize 为 'function'", () => {
    const base = {
      sourcePath: "/test", scannedAt: "2026-06-01T00:00:00.000Z", scannerUsed: "regex",
      packages: [{
        name: "PKG", specFile: "a.pks", bodyFile: "a.pkb",
        procedures: [{ name: "F", type: "Function", lineRange: [1, 10] as [number, number] }],
        estimatedLoc: 10,
      }],
      tables: [], triggers: [], views: [], sequences: [], standaloneProcedures: [],
    }
    const result = InventoryIndexSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.packages[0].procedures[0].type).toBe("function")
    }
  })

  // ── scannerUsed (ciEnumLower) ────────────────────────────

  it("InventoryIndexSchema: scannerUsed 'AST' normalize 为 'ast'", () => {
    const base = makeInventoryIndex()
    base.scannerUsed = "AST" as any
    const result = InventoryIndexSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.scannerUsed).toBe("ast")
    }
  })

  // ── riskLevel (ciEnumLower) ──────────────────────────────

  it("AnalysisMetaSchema: riskLevel 'HIGH' normalize 为 'high'", () => {
    const data = {
      callGraph: {},
      packageDependency: {},
      translationOrder: [["CORE_PKG"]],
      complexity: { CORE_PKG: { score: 5, patterns: ["cursor"], riskLevel: "HIGH" } },
      sccGroups: [["CORE_PKG"]],
      packageNames: ["CORE_PKG"],
    }
    const result = AnalysisMetaSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.complexity.CORE_PKG.riskLevel).toBe("high")
    }
  })

  // ── triggers (ciEnumLower) ───────────────────────────────

  it("InventorySchema: triggers 大小写变体 normalize 为小写", () => {
    const data = {
      sourcePath: "/test",
      packageNames: ["PKG"],
      tables: [],
      standaloneProcedures: [],
      triggers: [{
        name: "TRG",
        timing: "BEFORE",
        level: "ROW",
        targetTable: "T",
        events: ["INSERT", "UPDATE"],
        sourceFile: "trg.sql",
        lineRange: [1, 10] as [number, number],
      }],
      views: [],
      sequences: [],
    }
    const result = InventorySchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.triggers[0].timing).toBe("before")
      expect(result.data.triggers[0].level).toBe("row")
      expect(result.data.triggers[0].events).toEqual(["insert", "update"])
    }
  })

  // ── direction 在 InventorySchema.standaloneProcedures ────

  it("InventorySchema: standaloneProcedures direction 'out' normalize 为 'OUT'", () => {
    const data = {
      sourcePath: "/test",
      packageNames: ["PKG"],
      tables: [],
      standaloneProcedures: [{
        name: "SP",
        type: "Procedure",
        params: [{ name: "X", oracleType: "NUMBER", direction: "out" }],
        returnType: null,
        sourceFile: "sp.sql",
        lineRange: [1, 10] as [number, number],
      }],
      triggers: [],
      views: [],
      sequences: [],
    }
    const result = InventorySchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.standaloneProcedures[0].type).toBe("procedure")
      expect(result.data.standaloneProcedures[0].params[0].direction).toBe("OUT")
    }
  })
})
