/**
 * Artifact Zod Schemas — 所有阶段的产物结构定义
 *
 * 跨 Schema 约定：
 *   - Zod 只做结构校验，语义校验留给 review 阶段
 *   - 引擎层 validateCrossSchema() 负责跨 Schema 语义校验
 *   - 引擎对 Oracle 类型做大小写 normalize
 */

import { z } from "zod"

// ============================================================================
// Inventory Index Schema（预扫描索引，machine-generated）
// ============================================================================

export const InventoryIndexSchema = z.object({
  sourcePath: z.string(),
  scannedAt: z.string(),
  scannerUsed: z.enum(["ast", "regex"]),

  packages: z.array(z.object({
    name: z.string(),
    specFile: z.string().optional(),
    bodyFile: z.string().optional(),
    procedures: z.array(z.object({
      name: z.string(),
      type: z.enum(["procedure", "function"]),
      lineRange: z.tuple([z.number(), z.number()]).optional(),
    })),
    estimatedLoc: z.number(),
  })),

  tables: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
  })),

  triggers: z.array(z.object({
    name: z.string(),
    sourceFile: z.string(),
  })),

  views: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
  })),

  sequences: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
  })),

  standaloneProcedures: z.array(z.object({
    name: z.string(),
    type: z.enum(["procedure", "function"]),
    sourceFile: z.string(),
  })),

  callGraph: z.record(z.array(z.string())).optional(),
})

// ============================================================================
// Inventory Package Schema（逐包 inventory，LLM enriched）
// ============================================================================

/** 逐包 inventory 的 procedure 结构 — 与 InventorySchema 旧格式兼容 */
const InventoryProcedureSchema = z.object({
  name: z.string(),
  type: z.enum(["procedure", "function"]),
  params: z.array(z.object({
    name: z.string(),
    oracleType: z.string(),
    direction: z.enum(["IN", "OUT", "IN OUT"]),
  })),
  returnType: z.string().optional(),
  lineRange: z.tuple([z.number(), z.number()]),
  loc: z.number(),
})

export const InventoryPackageSchema = z.object({
  packageName: z.string(),
  specFile: z.string().optional(),
  bodyFile: z.string().optional(),
  procedures: z.array(InventoryProcedureSchema),
  types: z.array(z.object({
    name: z.string(),
    kind: z.string(),
    definition: z.string(),
  })),
  variables: z.array(z.object({
    name: z.string(),
    type: z.string(),
    defaultValue: z.string().optional(),
  })),
  constants: z.array(z.object({
    name: z.string(),
    type: z.string(),
    value: z.string(),
  })),
}).refine(
  pkg => pkg.procedures.length === 0 || (pkg.bodyFile !== undefined && pkg.bodyFile.length > 0),
  { message: "有 procedures 的包必须有非空的 bodyFile（procedure 实现体在 body 中）" }
)

// ============================================================================
// Inventory Schema（索引模式：packages 拆分为 per-package 文件，DDL 保留在此）
// ============================================================================

export const InventorySchema = z.object({
  sourcePath: z.string(),
  packageNames: z.array(z.string()),

  tables: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
    columns: z.array(z.object({
      name: z.string(),
      oracleType: z.string(),
      nullable: z.boolean(),
      isPrimaryKey: z.boolean(),
      defaultValue: z.string().optional(),
    })),
  })),

  standaloneProcedures: z.array(z.object({
    name: z.string(),
    type: z.enum(["procedure", "function"]),
    params: z.array(z.object({
      name: z.string(),
      oracleType: z.string(),
      direction: z.enum(["IN", "OUT", "IN OUT"]),
    })),
    returnType: z.string().optional(),
    sourceFile: z.string(),
    lineRange: z.tuple([z.number(), z.number()]),
  })),

  triggers: z.array(z.object({
    name: z.string(),
    timing: z.enum(["before", "after", "instead-of", "compound"]),
    level: z.enum(["statement", "row"]),
    targetTable: z.string(),
    events: z.array(z.enum(["insert", "update", "delete"])),
    sourceFile: z.string(),
    lineRange: z.tuple([z.number(), z.number()]),
    condition: z.string().optional(),
  })),

  views: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
    sourceFile: z.string().optional(),
    columns: z.array(z.string()),
    underlyingTables: z.array(z.string()).optional(),
  })),

  sequences: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().optional(),
    startWith: z.number().optional(),
    incrementBy: z.number().optional(),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    cycle: z.boolean().optional(),
  })),
})

// ============================================================================
// Analysis Schema（拆分为 Meta + Per-Package）
// ============================================================================

/** 子程序结构 — analyze 和 downstream agents 共用 */
const SubprogramSchema = z.object({
  name: z.string(),
  blocks: z.array(z.object({
    type: z.enum([
      "loop", "cursor", "if-else", "exception-block",
      "sql-statement", "assignment", "call",
    ]),
    oracleLine: z.number(),
    description: z.string(),
    dependencies: z.array(z.string()),
  })),
  variables: z.array(z.object({
    name: z.string(),
    type: z.string(),
    scope: z.string(),
  })),
  cursors: z.array(z.object({
    name: z.string(),
    query: z.string(),
    fetchMode: z.enum(["BULK", "ONE_BY_ONE", "FOR_UPDATE", "OTHER"]),
  })),
  exceptionHandlers: z.array(z.object({
    name: z.string(),
    actions: z.array(z.string()),
  })),
  translationNotes: z.string(),
})

/** analysis.json — 全局元数据（不含逐包子程序数据） */
export const AnalysisMetaSchema = z.object({
  callGraph: z.record(z.array(z.string())),
  packageDependency: z.record(z.array(z.string())),
  translationOrder: z.array(z.array(z.string())),
  complexity: z.record(z.object({
    score: z.number().min(1).max(10),
    patterns: z.array(z.string()),
    riskLevel: z.enum(["low", "medium", "high"]),
  })),
  sccGroups: z.array(z.array(z.string())),
  packageNames: z.array(z.string()),
})

/** analysis-packages/{pkg}.json — 逐包子程序结构 */
export const AnalysisPackageSchema = z.object({
  packageName: z.string(),
  subprograms: z.array(SubprogramSchema),
})

/** @deprecated 旧格式兼容，仅用于跨 Schema 校验的 fallback */
export const AnalysisSchema = z.object({
  callGraph: z.record(z.array(z.string())),
  packageDependency: z.record(z.array(z.string())),
  translationOrder: z.array(z.array(z.string())),
  complexity: z.record(z.object({
    score: z.number().min(1).max(10),
    patterns: z.array(z.string()),
    riskLevel: z.enum(["low", "medium", "high"]),
  })),
  sccGroups: z.array(z.array(z.string())),
  packages: z.array(z.object({
    name: z.string(),
    subprograms: z.array(SubprogramSchema),
  })).optional(),
  packageNames: z.array(z.string()).optional(),
})

// ============================================================================
// Plan Schema
// ============================================================================

export const PlanSchema = z.object({
  targetProject: z.object({
    groupId: z.string(),
    artifactId: z.string(),
    packageBase: z.string(),
    javaVersion: z.string(),
    springBootVersion: z.string(),
  }),

  packageMappings: z.array(z.object({
    oraclePackage: z.string(),
    javaPackage: z.string(),
    mapperInterface: z.string(),
    serviceClass: z.string(),
    serviceImplClass: z.string(),
  })),

  rules: z.object({
    namingConvention: z.enum(["keep-oracle", "camelCase", "mixed"]),
    nullHandling: z.enum(["optional", "nullable", "throw-empty"]),
    exceptionStrategy: z.enum(["spring-data", "custom-business", "oracle-mirror"]),
    logFramework: z.enum(["slf4j", "log4j2"]),
  }),

  typeMappings: z.record(z.string()),
  manualReviewList: z.array(z.object({
    procedure: z.string(),
    reason: z.string(),
  })),

  conventions: z.string(),
})

// ============================================================================
// Scaffold Schema
// ============================================================================

export const ScaffoldSchema = z.object({
  projectRoot: z.string(),
  structure: z.object({
    directories: z.array(z.string()),
    pomXml: z.string(),
  }),
  generated: z.object({
    entities: z.array(z.object({
      file: z.string(),
      tableName: z.string(),
    })),
    mapperInterfaces: z.array(z.object({
      file: z.string(),
      oraclePackage: z.string(),
    })),
    serviceShells: z.array(z.object({
      file: z.string(),
      oraclePackage: z.string(),
    })),
    commonClasses: z.array(z.object({
      file: z.string(),
      purpose: z.string(),
    })),
  }),
  conventions: z.string(),
  basedOnPlanHash: z.string().optional(),
})

// ============================================================================
// Translation Schema（每包一个）
// ============================================================================

export const TranslationSchema = z.object({
  packageName: z.string(),
  status: z.enum(["completed", "partial"]),
  completedSubprograms: z.array(z.string()),
  totalSubprograms: z.number(),

  files: z.array(z.object({
    path: z.string(),
    role: z.enum([
      "mapper-interface", "mapper-xml", "service",
      "service-impl", "dto", "exception",
    ]),
  })),

  decisions: z.array(z.object({
    line: z.number(),
    oracleConstruct: z.string(),
    javaConstruct: z.string(),
    reason: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),

  todos: z.array(z.object({
    file: z.string(),
    issue: z.string(),
    oracleLine: z.number(),
    suggestion: z.string(),
  })),
})

// ============================================================================
// Review Schema（每包一个）
// ============================================================================

export const ReviewSchema = z.object({
  packageName: z.string(),
  passed: z.boolean(),
  overallScore: z.number().min(0).max(100),
  procedureReviews: z.array(z.object({
    procedure: z.string(),
    checks: z.array(z.object({
      category: z.enum([
        "logic-equivalence", "sql-completeness", "null-handling",
        "type-mapping", "exception-mapping", "transaction-boundary",
        "cursor-mapping", "parameter-direction", "naming-consistency",
        "todo-remaining",
      ]),
      passed: z.boolean(),
      detail: z.string(),
      severity: z.enum(["critical", "major", "minor", "info"]),
    })),
  })),
  mustFix: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    issue: z.string(),
  })),
  suggestions: z.array(z.string()),
  todoRemainingCount: z.number(),
}).refine(
  data => (data.passed === true) === (data.mustFix.length === 0),
  { message: "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空" }
)

// ============================================================================
// Review Summary Schema（顶层汇总）
// ============================================================================

export const ReviewSummarySchema = z.object({
  allPassed: z.boolean(),
  packageResults: z.array(z.object({
    packageName: z.string(),
    passed: z.boolean(),
    score: z.number(),
    mustFixCount: z.number(),
  })),
  totalMustFix: z.number(),
  totalTodosRemaining: z.number(),
}).refine(
  data => data.allPassed === data.packageResults.every(p => p.passed),
  { message: "allPassed 应与 packageResults 一致" }
)

// ============================================================================
// Verify Schema（每包一个）
// ============================================================================

export const VerifySchema = z.object({
  packageName: z.string(),
  passed: z.boolean(),
  mybatisValidation: z.object({
    mapperXmlValid: z.boolean(),
    statementIdsMatch: z.boolean(),
  }),
  todoRemainingCount: z.number(),
  mustFix: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    issue: z.string(),
  })),
}).refine(
  data => (data.passed === true) === (data.mustFix.length === 0),
  { message: "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空" }
)

// ============================================================================
// Verify Summary Schema（顶层汇总）
// ============================================================================

export const VerifySummarySchema = z.object({
  allPassed: z.boolean(),
  compilation: z.object({
    success: z.boolean(),
    errors: z.array(z.object({
      file: z.string(),
      line: z.number(),
      message: z.string(),
    })).optional(),
  }),
  packageResults: z.array(z.object({
    packageName: z.string(),
    passed: z.boolean(),
    mybatisValid: z.boolean(),
  })),
  testGeneration: z.object({
    generated: z.boolean(),
    testFiles: z.array(z.string()),
  }),
  totalTodosRemaining: z.number(),
  unresolvedIssues: z.array(z.object({
    packageName: z.string(),
    issue: z.string(),
  })).optional(),
}).refine(
  data => data.allPassed === data.packageResults.every(p => p.passed),
  { message: "allPassed 应与 packageResults 一致" }
).refine(
  data => data.compilation.success === true || (data.compilation.errors !== undefined && data.compilation.errors.length > 0),
  { message: "compilation.success=false 时 errors 必须非空" }
)

// ============================================================================
// Fix Artifact Schema（fix 阶段产出）
// ============================================================================

export const FixArtifactSchema = z.object({
  fixedPackages: z.array(z.string().min(1)),
}).refine(
  data => data.fixedPackages.length > 0,
  { message: "fixedPackages 不能为空，fix 必须至少修复一个包" }
)

// ============================================================================
// Schema 查找辅助
// ============================================================================

import type { ZodTypeAny } from "zod"

/** 阶段名 → 磁盘文件名映射（phase 名与文件名不一致时使用） */
const PHASE_FILENAME_MAP: Record<string, string> = {
  inventory: "inventory",
  "inventory-index": "inventory-index",
  analyze: "analysis",       // phase="analyze" → 文件名 analysis.json
  plan: "plan",
  scaffold: "scaffold",
  fix: "fix",
}

/** 根据阶段名获取磁盘文件名（不含 .json 后缀） */
export function getArtifactFilename(phase: string): string {
  return PHASE_FILENAME_MAP[phase] ?? phase
}

/** 根据阶段名查找对应的 Zod Schema */
export function getSchemaForPhase(phase: string): ZodTypeAny | null {
  const schemaMap: Record<string, ZodTypeAny> = {
    inventory: InventorySchema,
    "inventory-index": InventoryIndexSchema,
    analyze: AnalysisMetaSchema,
    plan: PlanSchema,
    scaffold: ScaffoldSchema,
    fix: FixArtifactSchema,
  }
  return schemaMap[phase] ?? null
}

/** 查找 inventory per-package schema（inventory 阶段拆分校验用） */
export function getInventoryPackageSchema(): ZodTypeAny {
  return InventoryPackageSchema
}

/** 根据阶段名查找 per-package schema */
export function getPerPackageSchema(phase: string): ZodTypeAny | null {
  const schemaMap: Record<string, ZodTypeAny> = {
    translate: TranslationSchema,
    review: ReviewSchema,
    verify: VerifySchema,
  }
  return schemaMap[phase] ?? null
}

/** 查找 analysis per-package schema（analyze 阶段拆分校验用） */
export function getAnalysisPackageSchema(): ZodTypeAny {
  return AnalysisPackageSchema
}

/** 根据 summary 文件名查找 summary schema */
export function getSummarySchema(phase: string): ZodTypeAny | null {
  const schemaMap: Record<string, ZodTypeAny> = {
    "review-summary": ReviewSummarySchema,
    "verify-summary": VerifySummarySchema,
  }
  return schemaMap[phase] ?? null
}
