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
 * 模块类别 — 仅 ScaffoldSchema.commonModules.classes.category 使用（受控值域）。
 * DedupSchema.extractedModules.category 不用此枚举（其值由 translation.json files[].role
 * 派生，如 "service"/"unknown"/"aggregate" 等，是自由字符串）。
 *
 * 合并自两个原始枚举：Scaffold 侧重骨架分类，Dedup 侧重抽取分类。
 */
const ModuleCategoryValues = [
  "exception", "config", "type-mapper", "dto",
  "constants", "util", "mybatis", "mybatis-fragment",
  "mapper-interface", "test-base", "infrastructure",
] as const
const ModuleCategorySchema = z.enum(ModuleCategoryValues)

// ============================================================================
// Inventory Index Schema（预扫描索引，machine-generated）
// 定义移至 PackageArtifactSchema/SubprogramArtifactSchema/TableArtifactSchema 之后（复用它们）
// ============================================================================

// ============================================================================
// Inventory Schema（顶层轻量索引：packageNames + tableNames + triggers/views/sequences + 元信息）
// tables 列结构拆到 tables/{TABLE}.json（TableArtifactSchema）；包过程详情拆到 packages/+subprograms/
// ============================================================================

export const InventorySchema = z.object({
  sourcePath: z.string(),
  scannedAt: z.string().optional(),
  scannerUsed: ciEnumLower(["ast", "regex"]).optional(),
  warnings: z.array(z.string()).default([]),

  packageNames: z.array(z.string()),
  tableNames: z.array(z.string()),

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
// 新版按实体落盘 schema（packages/{PKG}.json + subprograms/{PKG.METHOD}.json + tables/{TABLE}.json）
// ============================================================================

const LocationInfoSchema = z.object({
  absolutePath: z.string(),
  lineRange: z.tuple([z.number(), z.number()]),
})

/** packages/{PKG}.json — 包容器（procedures/functions 仅名字索引，详情在 subprograms/） */
export const PackageArtifactSchema = z.object({
  packageName: z.string(),                         // 大写、保留点（FM.XXX）
  absolutePaths: z.array(z.string()),
  headerPath: z.string().nullable(),
  bodyPath: z.string().nullable(),
  constants: z.array(z.object({ name: z.string(), type: z.string(), value: z.string() })).default([]),
  variables: z.array(z.object({ name: z.string(), type: z.string(), defaultValue: z.string().nullable() })).default([]),
  exceptions: z.array(z.object({ name: z.string() })).default([]),
  types: z.array(z.object({ name: z.string(), kind: z.string(), definition: z.string() })).default([]),
  functions: z.array(z.string()).default([]),
  procedures: z.array(z.string()).default([]),
  estimatedLoc: z.number().default(0),
  complexity: z.object({
    score: z.number().min(1).max(10),
    patterns: z.array(z.string()),
    riskLevel: ciEnumLower(["low", "medium", "high"]),
  }).optional(),
}).passthrough()

/** subprograms/{PKG.METHOD}.json — 原子子程序（header/body 双定位 + per-method directCalls） */
export const SubprogramArtifactSchema = z.object({
  name: z.string(),
  type: z.enum(["PROCEDURE", "FUNCTION"]),
  belongToPackage: z.string(),
  overloadIndex: z.number().nullable(),
  isPrivate: z.boolean(),
  headerLocation: LocationInfoSchema.nullable(),
  bodyLocation: LocationInfoSchema.nullable(),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.string(),
    mode: ciEnumUpper(["IN", "OUT", "IN OUT"]),
    defaultExpression: z.string().nullable(),
  })).default([]),
  returnType: z.string().nullable(),
  loc: z.number().default(0),
  directCalls: z.array(z.object({
    package: z.string(),
    name: z.string(),
    line: z.number(),
    kind: z.enum(["function", "procedure"]),
  })).default([]),
  packageRefs: z.array(z.object({
    package: z.string(),
    name: z.string(),
    line: z.number(),
  })).default([]),
}).passthrough()

/** tables/{TABLE}.json — 单表列结构 + 主键 + 外键 */
export const TableArtifactSchema = z.object({
  name: z.string(),
  ddlFile: z.string().nullable().optional(),
  columns: z.array(z.object({
    name: z.string(),
    oracleType: z.string(),
    nullable: z.boolean(),
    isPrimaryKey: z.boolean(),
    defaultValue: z.string().nullable().optional(),
  })).default([]),
  primaryKey: z.array(z.string()).optional(),
  foreignKeys: z.array(z.object({
    name: z.string(),
    columns: z.array(z.string()),
    refTable: z.string(),
    refColumns: z.array(z.string()),
  })).optional(),
}).passthrough()

// ── InventoryIndexSchema（scanner 产出的预扫描索引，machine-generated）──────────
// 新形状：packages[]（PackageArtifactSchema 全字段）+ 顶层 subprograms[]（SubprogramArtifactSchema）
// + tables/triggers/views/sequences/standaloneProcedures。不再有 callGraph（依赖图按需推导）。
// 注：inventory-index.json 已不再落盘——InventoryIndex 经引擎内存 cache 由 scan 交接给 generateInventory。
// 本 schema 保留用于类型化/校验内存 index 形状（测试覆盖），不再是磁盘 phase artifact。
export const InventoryIndexSchema = z.object({
  sourcePath: z.string(),
  scannedAt: z.string(),
  scannerUsed: ciEnumLower(["ast", "regex"]),
  warnings: z.array(z.string()).default([]),
  packages: z.array(PackageArtifactSchema),
  subprograms: z.array(SubprogramArtifactSchema),
  tables: z.array(TableArtifactSchema),
  triggers: z.array(z.object({
    name: z.string(),
    timing: ciEnumLower(["before", "after", "instead-of", "compound"]).optional(),
    level: ciEnumLower(["statement", "row"]).optional(),
    targetTable: z.string().optional(),
    events: z.array(ciEnumLower(["insert", "update", "delete"])).optional(),
    sourceFile: z.string(),
    lineRange: z.tuple([z.number(), z.number()]).optional(),
    condition: z.string().nullable().optional(),
  }).passthrough()).default([]),
  views: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
    sourceFile: z.string().nullable().optional(),
    columns: z.array(z.string()).optional(),
    underlyingTables: z.array(z.string()).nullable().optional(),
  }).passthrough()).default([]),
  sequences: z.array(z.object({
    name: z.string(),
    ddlFile: z.string().nullable().optional(),
    sourceFile: z.string().nullable().optional(),
    startWith: z.number().nullable().optional(),
    incrementBy: z.number().nullable().optional(),
    minValue: z.number().nullable().optional(),
    maxValue: z.number().nullable().optional(),
    cycle: z.boolean().nullable().optional(),
  }).passthrough()).default([]),
  standaloneProcedures: z.array(z.object({
    name: z.string(),
    type: ciEnumLower(["procedure", "function"]),
    sourceFile: z.string(),
  }).passthrough()).default([]),
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

/** analysis-packages/{pkg}.json — 逐包子程序结构（聚合，由 engine mergeUnitAnalysis 产出） */
export const AnalysisPackageSchema = z.object({
  packageName: z.string(),
  subprograms: z.array(SubprogramSchema),
}).passthrough()

/**
 * analysis-packages/{pkg}/{unitRef}.json — PROCEDURE 级 analyze 产物（per-unit）。
 *
 * analyze 下沉到 PROCEDURE 级后，一个 unit = 一个 PROCEDURE（或孤儿 FUNCTION）+ 其 cargo FUNCTION。
 * agent 只写本 unit 的 per-procedure 文件（根 + cargo 的 subprogram 结构）；engine 在每个 analyze
 * 分片 advance 后 merge 同包所有 per-unit 文件 → 聚合 `analysis-packages/{pkg}.json`
 * （AnalysisPackageSchema），下游 plan/review/translator 读聚合，形状不变。
 *
 * 与 [[translate-procedure-level]] 的 UnitTranslationSchema 同模式（per-unit + engine merge）。
 */
export const UnitAnalysisSchema = z.object({
  /** unit 根子程序的 refName（PROCEDURE 或孤儿 FUNCTION），与文件名 {unitRef}.json 一致 */
  unitRefName: z.string(),
  packageName: z.string(),
  /** 本单元子程序结构（根 + cargo FUNCTION），merge 后并入聚合 subprograms */
  subprograms: z.array(SubprogramSchema),
}).passthrough()

//（旧 AnalysisSchema 已删：dependency-graph.json 落盘移除后无活跃消费者，仅残留旧字段定义。
//  调用图/complexity 等改由 dependency-graph.ts 按需推导 + packages/{PKG}.json.complexity 承载。）

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
    /** @deprecated 三层架构遗留字段；DDD 改用 accessImpl。保留以兼容历史 run resume。 */
    serviceClass: z.string().optional(),
    /** @deprecated 三层架构遗留字段；DDD 改用 accessImpl。保留以兼容历史 run resume。 */
    serviceImplClass: z.string().optional(),
    /** DDD 接入层接口——对外暴露入口，跨包调用索引（subprogramMethods.javaClass）指向此类。 */
    accessIntf: z.string().optional(),
    /** DDD 接入层实现（@Component）。 */
    accessImpl: z.string().optional(),
    /** DDD 处理器（流程编排，不标 @Transactional）。 */
    processor: z.string().optional(),
    /** DDD 聚合根（业务逻辑编排，标 @Transactional）。 */
    aggregate: z.string().optional(),
    /** DDD 构建器（参数/数据构建、OUT 参数预定义）。 */
    builder: z.string().optional(),
    /** DDD 验证器（业务规则校验）。 */
    validator: z.string().optional(),
  })).refine(
    (mappings) => mappings.every(m =>
      [m.accessIntf, m.accessImpl, m.processor, m.aggregate, m.builder, m.validator, m.serviceClass, m.serviceImplClass]
        .some(v => typeof v === "string" && v.trim().length > 0)
    ),
    { message: "每个 packageMapping 至少需要一个组件类名（DDD: accessImpl/accessIntf/aggregate/processor/builder/validator；遗留: serviceImplClass/serviceClass）——下游 verify 归因 / translate 跨包索引 / 测试骨架生成均依赖此锚点" },
  ),

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
    /** 数据对象 Bean（XxxBean，tableName → Bean；DDD 下数据对象统一用 XxxBean 后缀）。 */
    entities: z.array(z.object({
      file: z.string(),
      tableName: z.string(),
    })),
    mapperInterfaces: z.array(z.object({
      file: z.string(),
      oraclePackage: z.string(),
    })),
    /** DDD 组件壳（AccessIntf/AccessImpl/Processor/Aggregate/Builder/Validator 等，每包可多条）。 */
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
        category: ModuleCategorySchema,
      })),
      directories: z.array(z.string()),
    }).optional(),
  }),
  conventions: z.string(),
}).passthrough()

// ============================================================================
// Translation Schema（每包一个）
// ============================================================================

export const TranslationSchema = z.object({
  packageName: z.string(),
  status: z.string(),
  completedSubprograms: z.array(z.string()),
  totalSubprograms: z.coerce.number(),

  /**
   * PROCEDURE 级单元完成度 rollup（由 engine merge per-unit 文件聚合，非 agent 直接写）。
   * 每项 { refName=unit 根子程序 refName, status }。status: completed|partial。
   * 翻译下沉到 PROCEDURE 级后，本文件 = 聚合视图；逐单元产物在 translations/{pkg}/{unitRef}.json。
   */
  units: z.array(z.object({
    refName: z.string(),
    status: z.string(),
  })).optional(),

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
   * - javaClass：调用入口的**全限定名**，即对外暴露的 AccessIntf（DDD 接入层接口；调用方经 Spring DI
   *   注入它），如 "com.example.app.deal.access.BAccessIntf"。全限定以便调用方直接 import，无需再查 plan。
   *   （三层架构遗留 run 中此字段为 Service 接口全限定名，向后兼容。）
   * - javaMethod：Java 方法名（AccessIntf 上的方法名）。
   * - javaFile：AccessIntf 文件相对路径（可选，便于定位）。
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
// Unit Translation Schema（每 PROCEDURE 单元一个，translate 下沉到 PROCEDURE 级）
// ============================================================================

/**
 * per-unit 翻译产物：`translations/{pkg}/{unitRef}.json`。
 *
 * unit = 一个 PROCEDURE（主）或孤儿 FUNCTION；被 owner 拥有的 FUNCTION 是 owner 单元的
 * cargo，随 owner 在同一分片翻译，其方法登记在本单元的 subprogramMethods。
 *
 * engine 在每个 translate 分片 advance 后 merge 同包所有 per-unit 文件 → 聚合
 * `translations/{pkg}/translation.json`（TranslationSchema），后者是跨包调用对接的稳定契约。
 * agent 只写本 per-unit 文件，不直接写聚合 translation.json。
 */
export const UnitTranslationSchema = z.object({
  /** unit 根子程序的 refName（PROCEDURE 或孤儿 FUNCTION），与文件名 {unitRef}.json 一致 */
  unitRefName: z.string(),
  packageName: z.string(),
  status: z.string(),
  /** 本单元已完成的子程序 refName（根 + cargo FUNCTION） */
  completedSubprograms: z.array(z.string()),
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
  /** 本单元子程序（根 + cargo FUNCTION）→ Java 调用入口索引；merge 后并入聚合 translation.json */
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
// Project Review Schema（项目级，review.json 顶层产物）
// ============================================================================

// review 改项目级单次审核后，reviewer 一次写一个 artifactsDir/review.json，packages[] 覆盖全部包。
// 每个 package 条目复用 ReviewSchema（含 passed↔mustFix refine）。静态 finding 不在此（走 review-static.json）。
// fix 回环时 reviewer 读现有 review.json、只改 fixedPackages 条目、保留其余、写回完整文件。
export const ProjectReviewSchema = z.object({
  packages: z.array(ReviewSchema),
}).passthrough()

// ============================================================================
// Review Summary Schema（顶层汇总）
// ============================================================================

// review 静态审核重构（[[dedup-static-analysis]] 邻接方案）：review.json 保持纯语义，
// 静态 finding 存 review-static.json（项目级，确定性）。summary 合并两路：per-package
// `passed`=语义、`staticPassed`=静态（无 critical/major 静态 finding）。allPassed 须同时满足。
// 注意：不复用共享 allPassedRefine（verify 仍用旧语义），review 用下方专属 refine。
export const ReviewSummarySchema = z.object({
  allPassed: z.boolean(),
  packageResults: z.array(z.object({
    packageName: z.string(),
    passed: z.boolean(),
    /** 静态扫描是否通过（无 critical/major 静态 finding）。optional：旧 run/无静态产物时视为 true */
    staticPassed: z.boolean().nullable().optional(),
    score: z.coerce.number(),
    mustFixCount: z.coerce.number(),
  })),
  totalMustFix: z.coerce.number(),
  totalTodosRemaining: z.coerce.number(),
  /** 静态 finding 总数（全部包，含 UNKNOWN）。与 totalMustFix(语义) 分开计，避免触发 G4 */
  totalStaticFindings: z.coerce.number().optional(),
}).passthrough().refine(
  (data) => data.allPassed === data.packageResults.every(p => p.passed && (p.staticPassed ?? true)),
  { message: "allPassed 应与 packageResults 一致（passed && staticPassed；staticPassed 缺省视为 true）" }
)

// ============================================================================
// Review Static Schema（项目级，Step A 确定性扫描产物 review-static.json）
// ============================================================================

/** 单条静态 finding：工具/grep 脚本扫出的规约/机械类问题（20 类清单 #10-#20） */
export const ReviewStaticFindingSchema = z.object({
  /** 相对 projectRoot 的文件路径 */
  file: z.string(),
  line: z.coerce.number().nullable().optional(),
  /** 规则 id（checkstyle/pmd rule 名，或 grep 脚本名） */
  rule: z.string(),
  /** critical/major/minor/info */
  severity: z.string(),
  /** 映射 20 类清单 category，如 naming-convention/code-format/version-compliance */
  category: z.string(),
  /** 来源工具：checkstyle/pmd/todo/comment/java9api/mybatis/type-mapping/naming/test-completeness */
  tool: z.string(),
  /** 归因到的 Oracle 包名；归因失败为 "UNKNOWN"（进 __unattributed__ 桶，仍注入 fix） */
  packageName: z.string(),
  message: z.string(),
}).passthrough()

export const ReviewStaticSchema = z.object({
  findings: z.array(ReviewStaticFindingSchema).default([]),
  /** per-tool 跳过标记：mvn 不可用时 checkstyle/pmd=true，reviewer 据此回退 LLM 审 */
  toolSkipped: z.object({
    checkstyle: z.boolean().default(false),
    pmd: z.boolean().default(false),
  }).passthrough(),
  /** full=全项目首扫，incremental=fix 回环重扫 fixedPackages 后合并 */
  scanMode: z.enum(["full", "incremental"]).default("full"),
  generatedAt: z.string().optional(),
  scanStats: z.object({
    totalPackages: z.number(),
    totalFilesScanned: z.number(),
  }).passthrough().optional(),
}).passthrough()

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
  // JaCoCo 覆盖率结果（verify 阶段解析 jacoco.xml 产出）。环境不可用时 executed=false，
  // passed 置 true 不阻断（与 mvn 不可用跳过语义一致）。
  coverage: z.object({
    /** jacoco.xml 是否成功解析到 */
    executed: z.boolean(),
    /** 未解析原因（executed=false 时使用，如环境不可用/无 jacoco.xml） */
    skipReason: z.string().optional(),
    lineRate: z.coerce.number().nullable().optional(),
    branchRate: z.coerce.number().nullable().optional(),
    lineThreshold: z.coerce.number(),
    branchThreshold: z.coerce.number(),
    /** 覆盖率是否达标（executed=false 时为 true，不阻断） */
    passed: z.boolean(),
    /** 每包覆盖率明细 + 未覆盖 gaps（供 fix 注入「未覆盖行清单」段） */
    packageCoverage: z.array(z.object({
      packageName: z.string(),
      lineRate: z.coerce.number().nullable().optional(),
      branchRate: z.coerce.number().nullable().optional(),
      passed: z.boolean(),
      gaps: z.array(z.object({
        className: z.string(),
        line: z.coerce.number().nullable().optional(),
        type: z.enum(["line", "branch"]),
      })).optional(),
    })),
  }),
}).passthrough().refine(
  allPassedRefine.check,
  { message: allPassedRefine.message }
).refine(
  data => data.compilation.success === true || data.compilation.skipped === true || data.compilation.errors !== undefined,
  { message: "compilation.success=false 时 errors 必须存在（允许空数组），除非 skipped=true" }
).refine(
  // 单向蕴含：覆盖率未达标时 allPassed 必须为 false（覆盖率达标时 allPassed 由编译/测试/包归因决定，可真可假）
  data => data.coverage.passed === true || data.allPassed === false,
  { message: "覆盖率未达标时 allPassed 必须为 false" }
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

  /**
   * PMD CPD 不可用（mvn 缺失/执行失败/离线）时，engine 写占位 dedup.json 跳过抽取，
   * pipeline 继续到 review/verify（dedup 是优化项，非正确性必需）。skipped:true 时校验直接放行。
   */
  skipped: z.boolean().optional(),
  skipReason: z.string().optional(),
}).passthrough()

/**
 * dedup-duplicates.json — PMD CPD 确定性扫描产物（零 LLM，dedup dispatch 时由 engine 生成）。
 *
 * 重复组 = 同 token 序列出现在多个文件/位置（CPD）。LLM dedup agent 读此文件，对
 * suggestedExtract=true / forceExtract=true 的组做抽取+重构+改引用。
 *
 * - category：由 Java 文件 role 推导（dto/util/constant/exception/mapper-xml/unknown）。
 * - suggestedExtract：规则判定（跨≥2包 + 无 TODO + 非业务逻辑）。
 * - forceExtract：dedup-rules.json 的 force matcher 覆盖（必须抽取，LLM 不得否决）。
 * - skipped：PMD/mvn 不可用时整体跳过，不写 groups。
 */
export const DedupDuplicatesSchema = z.object({
  scanStats: z.object({
    totalPackages: z.number(),
    totalFilesScanned: z.number(),
    duplicateGroupsFound: z.number(),
  }),
  groups: z.array(z.object({
    /** 组 id（稳定，用于闭环校验） */
    id: z.string(),
    /** 类别：dto/util/constant/exception/mapper-xml/unknown */
    category: z.string(),
    /** 重复出现的各处 */
    sources: z.array(z.object({
      packageName: z.string(),
      file: z.string(),
      startLine: z.number(),
      endLine: z.number().optional(),
      tokens: z.number().optional(),
    })),
    /** 0=完全一致；越高越分歧（CPD 同组即 token 一致 → 0） */
    diffScore: z.number().min(0).max(1),
    /** 规则判定是否建议抽取 */
    suggestedExtract: z.boolean(),
    /** dedup-rules.json force 覆盖：必须抽取，LLM 不得否决 */
    forceExtract: z.boolean().optional(),
    /** 不抽取的原因（user-excluded / business-logic / has-todo / single-package / diff-too-high） */
    skipReason: z.string().optional(),
  })),
  /** PMD/mvn 不可用 → 跳过，groups 为空 */
  skipped: z.boolean().optional(),
  skipReason: z.string().optional(),
  generatedBy: z.string(),
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
    plan: PlanSchema,
    scaffold: ScaffoldSchema,
    dedup: DedupSchema,
    // review 改项目级单文件：review.json 顶层产物（packages[] 覆盖全部包）
    review: ProjectReviewSchema,
    fix: FixArtifactSchema,
  }
  return schemaMap[phase] ?? null
}

/** 根据阶段名查找 per-package schema */
export function getPerPackageSchema(phase: string): ZodType | null {
  // verify 不再产 per-package verify.json——静态检查归 review，动态结果（编译/测试归因）
  // 落在 verify-summary.json.packageResults。VerifySchema 保留定义备查但不再用于逐包校验。
  // review 改项目级单文件 review.json（packages[]），不再有 per-package review.json。
  const schemaMap: Record<string, ZodType> = {
    translate: TranslationSchema,
  }
  return schemaMap[phase] ?? null
}

/**
 * 根据阶段名查找 per-unit schema（PROCEDURE 级翻译产物校验）。
 * translate 下沉到 PROCEDURE 级后，逐单元产物 translations/{pkg}/{unitRef}.json 用此 schema。
 */
export function getPerUnitSchema(phase: string): ZodType | null {
  const schemaMap: Record<string, ZodType> = {
    analyze: UnitAnalysisSchema,
    translate: UnitTranslationSchema,
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
