/**
 * Schema Hint Enrichments — Zod 无法自动提取的校验规则补充数据
 *
 * 五个来源：
 *   1. REFINE_CONSTRAINTS  — Zod .refine() 的业务规则（toJSONSchema 无法导出）
 *   2. NON_ZOD_VALIDATION_RULES — validateArtifactOnDisk() 中的额外引擎级校验
 *   3. QUALITY_GATE_HINTS  — L3 确定性质量门控阈值
 *   4. CROSS_SCHEMA_HINTS  — 跨 Schema 校验规则（仅 needsCrossSchemaValidation=true 的阶段）
 *   5. COMMON_PITFALLS     — 常见被拒原因（枚举大小写、跨字段约束、格式陷阱等）
 *
 * 维护约定：
 *   - REFINE_CONSTRAINTS 的 message 应与 artifact-schemas.ts 中 .refine() 的 message 一致
 *   - QUALITY_GATE_HINTS 的阈值应与 engine-core.ts 的 QUALITY_GATE_THRESHOLDS 一致
 *   - CROSS_SCHEMA_HINTS 的 key 应与 workflow-definitions.ts 中 needsCrossSchemaValidation=true 的 phase 一致
 *   - COMMON_PITFALLS 中提到的枚举值必须与 artifact-schemas.ts 中的 Zod enum 一致
 *   - 测试文件 schema-hint-enrichments.test.ts 会自动检测漂移
 */

import { QUALITY_GATE_THRESHOLDS } from "./engine-core"

// ═══════════════════════════════════════════════════════════════
// 1. Refine 约束 — Zod .refine() 中的业务规则
// ═══════════════════════════════════════════════════════════════

/**
 * 每个 phase 的 refine 约束描述。
 * key = phase 名（per-package schema 的 phase 用对应的顶层 phase 名）。
 *
 * 与 artifact-schemas.ts 中 .refine() 的 message 保持一致，
 * 测试会校验 message 子串匹配。
 */
export const REFINE_CONSTRAINTS: Record<string, string[]> = {
  inventory: [
    "有 procedures 的包必须有非空的 bodyFile（procedure 实现体在 body 中）",
  ],
  translate: [
    "subprogramMethods.oracleName 必须唯一（重载子程序用 {name}__序号 区分，禁用裸名重复）",
  ],
  review: [
    "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空",
    "allPassed 应与 packageResults 一致：allPassed=true 当且仅当所有 packageResults[].passed=true",
  ],
  verify: [
    "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空",
    "allPassed 应与 packageResults 一致：allPassed=true 当且仅当所有 packageResults[].passed=true",
    "compilation.success=false 时 errors 必须非空",
  ],
  fix: [
    "fixedPackages 不能为空，fix 必须至少修复一个包",
  ],
}

// ═══════════════════════════════════════════════════════════════
// 2. 非 Zod 校验规则 — validateArtifactOnDisk() 中的额外检查
// ═══════════════════════════════════════════════════════════════

/**
 * 引擎级校验规则（Zod schema 无法表达的文件名一致性、跨文件覆盖等检查）。
 * phases: 该规则适用的阶段列表。
 */
export const NON_ZOD_VALIDATION_RULES: { phases: string[]; message: string }[] = [
  {
    phases: ["inventory"],
    message: "inventory-packages/{PKG}.json: packageName 必须与文件名一致（大小写不敏感）",
  },
  {
    phases: ["inventory"],
    message: "inventory.json 的 packageNames 必须覆盖 inventory-index 中所有包（含 header-only 包：只有 constants/exceptions/variables 而没有 procedures 的包，procedures 数组为 []，bodyFile 为 null）",
  },
  {
    phases: ["analyze"],
    message: "analysis-packages/{PKG}.json: packageName 必须与文件名一致（大小写不敏感）",
  },
  {
    phases: ["analyze"],
    message: "dependency-graph.json 的 packageNames 必须与 inventory 包名一致",
  },
  {
    phases: ["scaffold"],
    message: "scaffold.json 的 projectRoot 必须为绝对路径，指向项目根目录下的 generated/{artifactId}（来自 plan.json + Runtime Context 注入值）",
  },
  {
    phases: ["translate", "review", "verify"],
    message: "translations/{pkg}/ 目录名必须与 packageName 一致（大小写不敏感）",
  },
  {
    phases: ["dedup"],
    message: "增量模式下 dedup.json 必须保留非目标包数据（scanStats.totalPackages 须等于 inventory 包数）",
  },
  {
    phases: ["verify"],
    message: "verify-summary.json 的 testFiles[] 中的路径必须实际存在于磁盘",
  },
  {
    phases: ["scaffold"],
    message: "scaffold.json 的 mapperTestShells 中的 oraclePackage 必须与 plan.json 的 packageMappings 一致",
  },
  {
    phases: ["scaffold"],
    message: "scaffold.json 的 h2SchemaFile 指向的文件必须存在于磁盘",
  },
]

// ═══════════════════════════════════════════════════════════════
// 3. L3 质量门控 — 确定性数值门控阈值
// ═══════════════════════════════════════════════════════════════

/**
 * L3 质量门控提示（仅出现在有门控的阶段）。
 * 阈值从 engine-core.ts 的 QUALITY_GATE_THRESHOLDS 引用，避免硬编码漂移。
 */
export const QUALITY_GATE_HINTS: Record<string, string[]> = {
  translate: [
    `G1: 翻译完成率 (completedSubprograms/totalSubprograms) ≥ ${Math.round(QUALITY_GATE_THRESHOLDS.COMPLETION_RATIO * 100)}% [blocking]`,
    "G2: subprogramMethods 数量应 ≥ completedSubprograms [warning]",
  ],
  review: [
    `G3: passed=true 但 overallScore < ${QUALITY_GATE_THRESHOLDS.REVIEW_PASS_SCORE} → blocking`,
    "G4: allPassed=true 但 totalMustFix > 0 → blocking（逻辑不一致）",
  ],
  verify: [
    "G5: compilation.success=false 但 allPassed=true → blocking",
    `G6: 测试通过率 (passedTests/totalTests) ≥ ${Math.round(QUALITY_GATE_THRESHOLDS.TEST_PASS_RATIO * 100)}% [warning]`,
  ],
}

// ═══════════════════════════════════════════════════════════════
// 4. 跨 Schema 校验规则 — 仅 needsCrossSchemaValidation=true 的阶段
// ═══════════════════════════════════════════════════════════════

/**
 * 跨 Schema 校验提示（仅出现在 needsCrossSchemaValidation=true 的阶段）。
 * key 应与 workflow-definitions.ts 中 needsCrossSchemaValidation=true 的 phase 名一致。
 */
export const CROSS_SCHEMA_HINTS: Record<string, string[]> = {
  inventory: [
    "dependency-graph.json（含 callGraph）现由 inventory 阶段代码产出：packageNames 必须与 inventory 包名一致（大小写不敏感）",
    "callGraph 的 key/value 必须为 PKG.refName 格式；refName 须落在该包 inventory-packages 推导的合法集合内（非重载=裸名，重载={name}__序号，大小写不敏感计数重载）",
    "translationOrder 必须覆盖所有 analysis 包",
  ],
  analyze: [
    "dependency-graph.json 的 packageNames 必须与 inventory 包名一致（大小写不敏感）",
    "callGraph 的 key 必须为 PKG.refName 格式；重载子程序用 {name}__序号",
  ],
  plan: [
    "plan.packageMappings 必须覆盖所有 inventory 包的 oraclePackage",
  ],
  translate: [
    "subprogramMethods.oracleName 必须唯一且符合 refName 规范（重载用 {name}__序号）",
  ],
  dedup: [
    "extractedModules.affectedPackages 和 packageChanges.packageName 必须引用 inventory 中存在的包",
  ],
}

// ═══════════════════════════════════════════════════════════════
// 5. 常见被拒原因 — 枚举大小写、跨字段约束、格式陷阱等高频 advance 拒绝原因
// ═══════════════════════════════════════════════════════════════

/**
 * 每个 phase 的常见被拒原因。
 * key = phase 名（与 REFINE_CONSTRAINTS 等同）。
 *
 * 与 artifact-schemas.ts 中的 Zod enum 定义保持一致，
 * 测试会校验枚举值匹配。
 */
export const COMMON_PITFALLS: Record<string, string[]> = {
  "inventory-index": [
    'scannerUsed 自动 normalize 为小写，"AST"/"Regex" 等任意大小写均可通过',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  inventory: [
    'optional 字段（defaultValue/bodyFile/returnType/headerFile/ddlFile 等）可省略或写 null，均可通过校验',
    'direction 自动 normalize 为大写："in"/"In"/"IN" 均等价于 "IN"，"in out"/"IN OUT" 均等价于 "IN OUT"',
    'type 自动 normalize 为小写："PROCEDURE"/"Procedure" 均等价于 "procedure"',
    'triggers.timing 自动 normalize 为小写：任意大小写均可通过',
    'triggers.level 自动 normalize 为小写：任意大小写均可通过',
    'triggers.events 每个元素自动 normalize 为小写：任意大小写均可通过',
    '有 procedures 的包必须提供 bodyFile（空串或 null 均可）；无 body 的包可省略该键',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  analyze: [
    'riskLevel 自动 normalize 为小写：任意大小写均可通过',
    'fetchMode 推荐大写："BULK" / "ONE_BY_ONE" / "FOR_UPDATE" / "OTHER"',
    'callGraph key 格式为 PKG.refName；重载子程序用 {name}__序号（如 CALC__1），不能用裸名',
    'block.type 推荐为以下之一（小写）："loop" / "cursor" / "if-else" / "exception-block" / "sql-statement" / "assignment" / "call"（不限死，但推荐使用这些值）',
    'subprograms[].translationNotes 是 string[]（每条注意事项一个元素），不是单个字符串——如 ["注意空值处理", "循环边界需验证"]',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  plan: [
    'namingConvention 推荐值：camelCase / keep-oracle / mixed（不限死）',
    'nullHandling 推荐值：optional / nullable / throw-empty',
    'exceptionStrategy 推荐值：spring-data / custom-business / oracle-mirror',
    'logFramework 推荐值：slf4j / log4j2',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  scaffold: [
    'commonModules.classes.category 推荐全小写，如 "type-mapper" / "mybatis-fragment" / "mapper-interface" / "test-base"（不限死）',
    'projectRoot 为绝对路径，必须使用 Runtime Context 注入的 projectRoot 值（指向项目根目录下 generated/{artifactId}）',
    'mapperTestShells 中的 testClass 命名必须为 {MapperInterface}IntegrationTest',
    'mapperTestShells 中的 oraclePackage 必须与 plan.json 的 packageMappings 一致',
    'h2SchemaFile 指向的文件必须存在于磁盘（src/test/resources/schema-h2.sql）',
    'schema-h2.sql 必须覆盖 inventory.json 中所有 tables 和 sequences',
    'schema-h2.sql 中 UDT 列必须跳过并加注释（-- H2 不支持 Oracle UDT），不能生成 H2 不支持的类型',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  translate: [
    'status 推荐值："completed" / "partial"（不限死，允许其他状态值）',
    'files.role 推荐值："mapper-interface" / "mapper-xml" / "service" / "service-impl" / "dto" / "exception" / "test" / "mapper-integration-test"（不限死）',
    'confidence 推荐小写："high" / "medium" / "low"',
    'subprogramMethods.oracleName：重载子程序必须用 {name}__序号，禁止裸名重复',
    'totalSubprograms 等数字字段支持字符串自动转换（写 "5" 等同 5）',
    'files.role 使用 "mapper-integration-test" 标识 Mapper 集成测试文件',
    '生产 Mapper XML 保持 Oracle 原生语法不变',
    'H2 确实不兼容的 SQL 标 @Disabled（不修改 Mapper XML）',
    '测试数据 INSERT 使用硬编码 ID 值（不使用 SEQ.NEXTVAL）',
    'JdbcTemplate INSERT 测试数据的列必须与 schema-h2.sql 一致',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  review: [
    'severity 推荐小写："critical" / "major" / "minor" / "info"（不限死）',
    'checks.category 推荐全小写，如 "logic-equivalence" / "null-handling" / "exception-mapping" 等（不限死）',
    'passed=true 时 mustFix 必须为 []，passed=false 时 mustFix 必须非空——这是最常见的被拒原因',
    'overallScore 范围 0-100，passed=true 时必须 ≥ 70',
    'suggestions 可写字符串数组或对象数组',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  verify: [
    'compilation.success=false 时 compilation.errors 必须存在（空数组 [] 也可通过）',
    'passed=true 时 mustFix 必须为 []，passed=false 时 mustFix 必须非空',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  dedup: [
    'extractedModules.category 推荐全小写，如 "type-mapper" / "mybatis-fragment" / "mapper-interface" / "test-base"（不限死）',
    'affectedPackages 和 packageChanges.packageName 必须引用 inventory 中实际存在的包名',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  fix: [
    'fixedPackages 不能为空数组，至少包含一个被修复的包名',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
}
