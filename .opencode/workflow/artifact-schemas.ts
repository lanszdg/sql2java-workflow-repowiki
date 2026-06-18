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
// 大小写不敏感枚举辅助 — LLM 产出大小写不一致时自动 normalize
// ============================================================================

/**
 * 创建大小写不敏感枚举：接受任意大小写输入，normalize 为大写后再校验。
 *
 * 典型用途：SQL 关键字枚举（direction="IN"/"OUT"/"IN OUT"），
 * SQL 语法本身不区分大小写，LLM 可能输出 "in"/"In"/"IN"。
 *
 * 用法：ciEnumUpper(["IN", "OUT", "IN OUT"]) 替代 z.enum(["IN", "OUT", "IN OUT"])
 */
function ciEnumUpper<T extends readonly [string, ...string[]]>(values: T) {
  return z.string().transform(v => v.toUpperCase()).pipe(z.enum(values))
}

/**
 * 创建大小写不敏感枚举：接受任意大小写输入，normalize 为小写后再校验。
 *
 * 典型用途：语义分类枚举（type="procedure"/"function"、riskLevel="low" 等），
 * 这些是约定值而非 SQL 关键字，规范写法为小写，但不应因大小写拒绝。
 */
function ciEnumLower<T extends readonly [string, ...string[]]>(values: T) {
  return z.string().transform(v => v.toLowerCase()).pipe(z.enum(values))
}

// ============================================================================
// 共享枚举 — 跨 Schema 共用的常量定义
// ============================================================================

/**
 * 模块类别 — ScaffoldSchema.commonModules.classes.category 与
 * DedupSchema.extractedModules.category 共用，确保跨阶段一致性。
 *
 * 合并自两个原始枚举：Scaffold 侧重骨架分类，Dedup 侧重抽取分类。
 */
const ModuleCategoryValues = [
  "exception", "config", "type-mapper", "dto",
  "constants", "util", "mybatis", "mybatis-fragment",
  "mapper-interface", "test-base",
] as const
const ModuleCategorySchema = z.enum(ModuleCategoryValues)

// ============================================================================
// Inventory Index Schema（预扫描索引，machine-generated）
// ============================================================================

export const InventoryIndexSchema = z.object({
  sourcePath: z.string(),
  scannedAt: z.string(),
  scannerUsed: ciEnumLower(["ast", "regex"]),

  packages: z.array(z.object({
    name: z.string(),
    specFile: z.string().nullable().optional(),
    bodyFile: z.string().nullable().optional(),
    procedures: z.array(z.object({
      name: z.string(),
      type: ciEnumLower(["procedure", "function"]),
      lineRange: z.tuple([z.number(), z.number()]).optional(),
    })),
    estimatedLoc: z.number(),
  })),

  tables: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
  })),

  triggers: z.array(z.object({
    name: z.string(),
    sourceFile: z.string(),
  })),

  views: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
  })),

  sequences: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
  })),

  standaloneProcedures: z.array(z.object({
    name: z.string(),
    type: ciEnumLower(["procedure", "function"]),
    sourceFile: z.string(),
  })),

  callGraph: z.record(z.string(), z.array(z.string())).optional(),
}).passthrough()

// ============================================================================
// Inventory Package Schema（逐包 inventory，LLM enriched）
// ============================================================================

/** 逐包 inventory 的 procedure 结构 — 与 InventorySchema 旧格式兼容 */
const InventoryProcedureSchema = z.object({
  name: z.string(),
  type: ciEnumLower(["procedure", "function"]),
  params: z.array(z.object({
    name: z.string(),
    oracleType: z.string(),
    direction: ciEnumUpper(["IN", "OUT", "IN OUT"]),
  })),
  returnType: z.string().nullable().optional(),
  lineRange: z.tuple([z.number(), z.number()]),
  loc: z.number(),
})

export const InventoryPackageSchema = z.object({
  packageName: z.string(),
  specFile: z.string().nullable().optional(),
  bodyFile: z.string().nullable().optional(),
  procedures: z.array(InventoryProcedureSchema),
  types: z.array(z.object({
    name: z.string(),
    kind: z.string(),
    definition: z.string(),
  })),
  variables: z.array(z.object({
    name: z.string(),
    type: z.string(),
    defaultValue: z.string().nullable().optional(),
  })),
  constants: z.array(z.object({
    name: z.string(),
    type: z.string(),
    value: z.string(),
  })),
}).passthrough().refine(
  pkg => pkg.procedures.length === 0 || pkg.bodyFile !== undefined,
  { message: "有 procedures 的包必须有 bodyFile（procedure 实现体在 body 中）" }
)
// ============================================================================
// Inventory Schema（索引模式：packages 拆分为 per-package 文件，DDL 保留在此）
// ============================================================================

export const InventorySchema = z.object({
  sourcePath: z.string(),
  packageNames: z.array(z.string()),

  tables: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
    columns: z.array(z.object({
      name: z.string(),
      oracleType: z.string(),
      nullable: z.boolean(),
      isPrimaryKey: z.boolean(),
      defaultValue: z.string().nullable().optional(),
    })),
  })),

  standaloneProcedures: z.array(z.object({
    name: z.string(),
    type: ciEnumLower(["procedure", "function"]),
    params: z.array(z.object({
      name: z.string(),
      oracleType: z.string(),
      direction: ciEnumUpper(["IN", "OUT", "IN OUT"]),
    })),
    returnType: z.string().nullable().optional(),
    sourceFile: z.string(),
    lineRange: z.tuple([z.number(), z.number()]),
  })),

  triggers: z.array(z.object({
    name: z.string(),
    timing: ciEnumLower(["before", "after", "instead-of", "compound"]),
    level: ciEnumLower(["statement", "row"]),
    targetTable: z.string(),
    events: z.array(ciEnumLower(["insert", "update", "delete"])),
    sourceFile: z.string(),
    lineRange: z.tuple([z.number(), z.number()]),
    condition: z.string().nullable().optional(),
  })),

  views: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
    sourceFile: z.string().nullable().optional(),
    columns: z.array(z.string()),
    underlyingTables: z.array(z.string()).nullable().optional(),
  })),

  sequences: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
    startWith: z.number().nullable().optional(),
    incrementBy: z.number().nullable().optional(),
    minValue: z.number().nullable().optional(),
    maxValue: z.number().nullable().optional(),
    cycle: z.boolean().nullable().optional(),
  })),
}).passthrough()

// ============================================================================
// Analysis Schema（拆分为 Meta + Per-Package）
// ============================================================================

/** 子程序结构 — analyze 和 downstream agents 共用 */
const SubprogramSchema = z.object({
  name: z.string(),
  blocks: z.array(z.object({
    type: z.string(),
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
    fetchMode: z.string(),
  })),
  exceptionHandlers: z.array(z.object({
    name: z.string(),
    actions: z.array(z.string()),
  })),
  translationNotes: z.array(z.string()),
})

/** analysis.json — 全局元数据（不含逐包子程序数据） */
export const AnalysisMetaSchema = z.object({
  /**
   * 调用图：key = 限定名 `PKG.refName`，value = 被调用的 `PKG.refName` 数组（与 key 同规范）。
   * refName 规范：非重载子程序=Oracle 原始名；重载子程序=`{name}__{序号}`（1-based，全部带序号），
   * 与 FSD 文件名、translation.json.subprogramMethods.oracleName 一致（修现行裸名撞重载的缺陷）。
   */
  callGraph: z.record(z.string(), z.array(z.string())),
  packageDependency: z.record(z.string(), z.array(z.string())),
  translationOrder: z.array(z.array(z.string())),
  complexity: z.record(z.string(), z.object({
    score: z.number().min(1).max(10),
    patterns: z.array(z.string()),
    riskLevel: ciEnumLower(["low", "medium", "high"]),
  })),
  sccGroups: z.array(z.array(z.string())),
  packageNames: z.array(z.string()),
}).passthrough()

/** analysis-packages/{pkg}.json — 逐包子程序结构 */
export const AnalysisPackageSchema = z.object({
  packageName: z.string(),
  subprograms: z.array(SubprogramSchema),
}).passthrough()

/** @deprecated 旧格式兼容，仅用于跨 Schema 校验的 fallback */
export const AnalysisSchema = z.object({
  callGraph: z.record(z.string(), z.array(z.string())),
  packageDependency: z.record(z.string(), z.array(z.string())),
  translationOrder: z.array(z.array(z.string())),
  complexity: z.record(z.string(), z.object({
    score: z.number().min(1).max(10),
    patterns: z.array(z.string()),
    riskLevel: ciEnumLower(["low", "medium", "high"]),
  })),
  sccGroups: z.array(z.array(z.string())),
  packages: z.array(z.object({
    name: z.string(),
    subprograms: z.array(SubprogramSchema),
  })).optional(),
  packageNames: z.array(z.string()).optional(),
}).passthrough()

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
    namingConvention: z.string(),
    nullHandling: z.string(),
    exceptionStrategy: z.string(),
    logFramework: z.string(),
  }),

  typeMappings: z.record(z.string(), z.string()),
  manualReviewList: z.array(z.object({
    procedure: z.string(),
    reason: z.string(),
  })),

  conventions: z.string(),
}).passthrough()

// ============================================================================
// Scaffold Schema
// ============================================================================

export const ScaffoldSchema = z.object({
  /** Java 项目输出根目录（绝对路径，由引擎注入，指向 cwd/generated/{artifactId}） */
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
    testShells: z.array(z.object({
      file: z.string(),
      oraclePackage: z.string(),
      testClass: z.string(),
    })).optional(),
    /** Mapper 集成测试骨架（@MybatisTest + H2） */
    mapperTestShells: z.array(z.object({
      file: z.string(),
      oraclePackage: z.string(),
      testClass: z.string(),
      mapperInterface: z.string(),
    })).optional(),
    /** H2 兼容建表脚本路径（相对于 projectRoot） */
    h2SchemaFile: z.string().optional(),
    /** 测试用 application 配置路径（相对于 projectRoot） */
    testApplicationConfig: z.string().optional(),
    // TODO (F8): commonClasses {file, purpose} 和 commonModules.classes {file, purpose, category}
    // 结构重叠。考虑统一为单一数组（category 可选），避免消费者需检查两个数组。
    commonClasses: z.array(z.object({
      file: z.string(),
      purpose: z.string(),
    })),
    /** 公共模块（细粒度分类） */
    commonModules: z.object({
      classes: z.array(z.object({
        file: z.string(),
        purpose: z.string(),
        category: z.string(),
      })),
      directories: z.array(z.string()),
    }).optional(),
  }),
  conventions: z.string(),
  basedOnPlanHash: z.string().nullable().optional(),
}).passthrough()

// ============================================================================
// Translation Schema（每包一个）
// ============================================================================

export const TranslationSchema = z.object({
  packageName: z.string(),
  status: z.string(),
  completedSubprograms: z.array(z.string()),
  totalSubprograms: z.coerce.number(),

  files: z.array(z.object({
    path: z.string(),
    role: z.string(),
  })),

  decisions: z.array(z.object({
    line: z.coerce.number(),
    oracleConstruct: z.string(),
    javaConstruct: z.string(),
    reason: z.string(),
    confidence: z.string(),
  })),

  todos: z.array(z.object({
    file: z.string(),
    issue: z.string(),
    oracleLine: z.coerce.number(),
    suggestion: z.string(),
  })),

  /**
   * 本包子程序 → Java 调用入口索引，供「依赖本包的后续翻译包」对接跨包调用。
   *
   * translate 按拓扑序逐包翻译：后翻译的包 A 调用本包子程序 y 时，read 本文件、在此按
   * oracleName 查到 y 的真实 javaClass/javaMethod，避免靠 FSD 预估或命名猜测。
   *
   * - oracleName：唯一引用名（refName）。非重载=Oracle 原始名；重载=`{name}__{序号}`（1-based，全部带序号），
   *   与 callGraph key 的 refName、FSD 文件名一致。**唯一性由 refine 强制**（大小写不敏感去重），
   *   避免重载裸名重复导致跨包查找歧义。
   * - javaClass：调用入口的**全限定名**，即对外暴露的 Service 接口（调用方经 Spring DI 注入它），
   *   如 "com.example.util.BService"。全限定以便调用方直接 import，无需再查 plan。
   * - javaMethod：Java 方法名（Service 接口上的方法名）。
   * - javaFile：Service 接口文件相对路径（可选，便于定位）。
   */
  subprogramMethods: z.array(z.object({
    oracleName: z.string(),
    javaClass: z.string(),
    javaMethod: z.string(),
    javaFile: z.string().nullable().optional(),
  })).refine(
    (methods) => new Set(methods.map((m) => m.oracleName.toUpperCase())).size === methods.length,
    { message: "subprogramMethods.oracleName 必须唯一（重载子程序用 {name}__序号 区分，禁用裸名重复）" },
  ).default([]),
}).passthrough()

// ============================================================================
// 共享 Refine 描述（消除 ReviewSchema/VerifySchema 和 Summary Schema 之间的复制粘贴）
// ============================================================================

/** passed 与 mustFix 一致性校验描述 */
const passedMustFixRefine = {
  check: (data: { passed: boolean; mustFix: unknown[] }) =>
    (data.passed === true) === (data.mustFix.length === 0),
  message: "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空",
} as const

/** allPassed 与 packageResults 一致性校验描述 */
const allPassedRefine = {
  check: (data: { allPassed: boolean; packageResults: { passed: boolean }[] }) =>
    data.allPassed === data.packageResults.every(p => p.passed),
  message: "allPassed 应与 packageResults 一致",
} as const

// ============================================================================
// Review Schema（每包一个）
// ============================================================================

export const ReviewSchema = z.object({
  packageName: z.string(),
  passed: z.boolean(),
  overallScore: z.coerce.number().min(0).max(100),
  procedureReviews: z.array(z.object({
    procedure: z.string(),
    checks: z.array(z.object({
      category: z.string(),
      passed: z.boolean(),
      detail: z.string(),
      severity: z.string(),
    })),
  })).default([]),
  mustFix: z.array(z.object({
    file: z.string(),
    line: z.coerce.number().nullable().optional(),
    issue: z.string(),
  })).default([]),
  suggestions: z.array(z.unknown()),
  todoRemainingCount: z.coerce.number(),
}).passthrough().refine(
  passedMustFixRefine.check,
  { message: passedMustFixRefine.message }
)

// ============================================================================
// Review Summary Schema（顶层汇总）
// ============================================================================

export const ReviewSummarySchema = z.object({
  allPassed: z.boolean(),
  packageResults: z.array(z.object({
    packageName: z.string(),
    passed: z.boolean(),
    score: z.coerce.number(),
    mustFixCount: z.coerce.number(),
  })),
  totalMustFix: z.coerce.number(),
  totalTodosRemaining: z.coerce.number(),
}).passthrough().refine(
  allPassedRefine.check,
  { message: allPassedRefine.message }
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
    /** schema-h2.sql 是否存在且可被 H2 执行 */
    h2SchemaValid: z.boolean().optional(),
    /** application-test.yml 是否正确配置 H2 数据源 */
    mapperTestConfigValid: z.boolean().optional(),
  }),
  todoRemainingCount: z.coerce.number(),
  mustFix: z.array(z.object({
    file: z.string(),
    line: z.coerce.number().nullable().optional(),
    issue: z.string(),
  })).default([]),
}).passthrough().refine(
  passedMustFixRefine.check,
  { message: passedMustFixRefine.message }
)

// ============================================================================
// Verify Summary Schema（顶层汇总）
// ============================================================================

export const VerifySummarySchema = z.object({
  allPassed: z.boolean(),
  compilation: z.object({
    success: z.boolean(),
    /** 编译是否因环境不可用（Maven/JDK 缺失）而跳过 */
    skipped: z.boolean().optional(),
    /** 跳过原因（skipped=true 时必填） */
    skipReason: z.string().optional(),
    errors: z.array(z.object({
      file: z.string(),
      line: z.coerce.number(),
      message: z.string(),
    })).optional(),
  }),
  packageResults: z.array(z.object({
    packageName: z.string(),
    passed: z.boolean(),
    mybatisValid: z.boolean(),
  })),
  // BREAKING: testExecution 为必填（旧版 testGeneration 已移除）
  // 如需恢复旧数据兼容，改回 .optional() 并加 refine 保证至少一个存在
  testExecution: z.object({
    executed: z.boolean(),
    /** 测试未执行的原因（如环境不可用），executed=false 时使用 */
    skipReason: z.string().optional(),
    totalTests: z.coerce.number().nullable().optional(),
    passedTests: z.coerce.number().nullable().optional(),
    failedTests: z.coerce.number().nullable().optional(),
    testErrors: z.array(z.object({
      testClass: z.string(),
      testMethod: z.string(),
      message: z.string(),
      /** 测试类型：unit = ServiceImpl 单元测试，integration = Mapper 集成测试 */
      testType: z.enum(["unit", "integration"]).optional(),
    })).optional(),
    testFiles: z.array(z.string()),
  }),
  totalTodosRemaining: z.coerce.number(),
  unresolvedIssues: z.array(z.object({
    packageName: z.string(),
    issue: z.string(),
  })).optional(),
}).passthrough().refine(
  allPassedRefine.check,
  { message: allPassedRefine.message }
).refine(
  data => data.compilation.success === true || data.compilation.skipped === true || data.compilation.errors !== undefined,
  { message: "compilation.success=false 时 errors 必须存在（允许空数组），除非 skipped=true" }
)

// ============================================================================
// Dedup Schema（dedup 阶段产出 — 跨包重复代码检测 + 公共模块抽取）
// ============================================================================

export const DedupSchema = z.object({
  /** 扫描统计 */
  scanStats: z.object({
    totalPackages: z.number(),
    totalFilesScanned: z.number(),
    duplicateGroupsFound: z.number(),
  }),

  /** 抽取的公共模块列表 */
  extractedModules: z.array(z.object({
    /** 新建的公共模块文件路径（相对于 projectRoot） */
    file: z.string(),
    /** 模块类别 */
    category: z.string(),
    /** 模块用途描述 */
    purpose: z.string(),
    /** 此模块来源：从哪些包的哪些代码中抽取 */
    sources: z.array(z.object({
      packageName: z.string(),
      originalFile: z.string(),
      originalClassName: z.string(),
    })),
    /** 受影响的包（引用被更新的包） */
    affectedPackages: z.array(z.string()),
  })),

  /** 未抽取的重复代码（记录为什么不抽取） */
  skippedDuplicates: z.array(z.object({
    reason: z.string(),
    packages: z.array(z.string()),
    codePattern: z.string(),
  })).optional(),

  /** 各包的引用变更摘要 */
  packageChanges: z.array(z.object({
    packageName: z.string(),
    filesModified: z.array(z.string()),
    importsAdded: z.array(z.string()),
    classesRemoved: z.array(z.string()),
  })),

  /** dedup 阶段质量指标 */
  metrics: z.object({
    filesExtracted: z.number(),
    filesModified: z.number(),
    linesRemoved: z.number(),
    linesAdded: z.number(),
  }),
}).passthrough()

// ============================================================================
// Fix Artifact Schema（fix 阶段产出）
// ============================================================================

export const FixArtifactSchema = z.object({
  fixedPackages: z.array(z.string().min(1)),
}).passthrough().refine(
  data => data.fixedPackages.length > 0,
  { message: "fixedPackages 不能为空，fix 必须至少修复一个包" }
)

// ============================================================================
// Schema 查找辅助
// ============================================================================

import type { ZodType } from "zod"

/** 阶段名 → 磁盘文件名映射（phase 名与文件名不一致时使用） */
const PHASE_FILENAME_MAP: Record<string, string> = {
  inventory: "inventory",
  "inventory-index": "inventory-index",
  analyze: "analysis",       // phase="analyze" → 文件名 analysis.json
  plan: "plan",
  scaffold: "scaffold",
  translate: "translation",  // phase="translate" → 文件名 translation.json
  dedup: "dedup",
  fix: "fix",
}

/** 根据阶段名获取磁盘文件名（不含 .json 后缀） */
export function getArtifactFilename(phase: string): string {
  return PHASE_FILENAME_MAP[phase] ?? phase
}

/** 根据阶段名查找对应的 Zod Schema */
export function getSchemaForPhase(phase: string): ZodType | null {
  const schemaMap: Record<string, ZodType> = {
    inventory: InventorySchema,
    "inventory-index": InventoryIndexSchema,
    analyze: AnalysisMetaSchema,
    plan: PlanSchema,
    scaffold: ScaffoldSchema,
    dedup: DedupSchema,
    fix: FixArtifactSchema,
  }
  return schemaMap[phase] ?? null
}

/** 查找 inventory per-package schema（inventory 阶段拆分校验用） */
export function getInventoryPackageSchema(): ZodType {
  return InventoryPackageSchema
}

/** 根据阶段名查找 per-package schema */
export function getPerPackageSchema(phase: string): ZodType | null {
  // verify 不再产 per-package verify.json——静态检查归 review，动态结果（编译/测试归因）
  // 落在 verify-summary.json.packageResults。VerifySchema 保留定义备查但不再用于逐包校验。
  const schemaMap: Record<string, ZodType> = {
    translate: TranslationSchema,
    review: ReviewSchema,
  }
  return schemaMap[phase] ?? null
}

/** 查找 analysis per-package schema（analyze 阶段拆分校验用） */
export function getAnalysisPackageSchema(): ZodType {
  return AnalysisPackageSchema
}

/** 根据 summary 文件名查找 summary schema */
export function getSummarySchema(phase: string): ZodType | null {
  const schemaMap: Record<string, ZodType> = {
    "review-summary": ReviewSummarySchema,
    "verify-summary": VerifySummarySchema,
  }
  return schemaMap[phase] ?? null
}
