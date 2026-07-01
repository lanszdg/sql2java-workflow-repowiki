/**
 * Shared constants for sql2java workflow modules.
 *
 * 此文件无外部依赖，所有模块均可安全静态导入。
 */

/** schema-fetcher 生成的 DDL 文件输出目录名 */
export const GENERATED_OUTPUT_DIR = "ddl-output"

/** 标识由 schema-fetcher 自动生成的标记文件名（域名式命名，避免与用户文件冲突） */
export const GENERATED_MARKER = ".sql2java-generated"

/** 标记文件中的 generator 字段值，用于校验标记真实性 */
export const GENERATED_MARKER_ID = "sql2java-schema-fetcher"

/** PL/SQL 源文件有效扩展名（小写，含前导点） */
export const VALID_SOURCE_EXTENSIONS: readonly string[] = [".sql", ".pks", ".pkb", ".pls"]

// ── JaCoCo 覆盖率门禁阈值（verify 阶段解析 jacoco.xml 后判定） ──
// 起步阈值：行 90% / 分支 75%。范围由 scaffold pom 的 <excludes> 收窄到业务核心
// （排除 common/infrastructure、beans/*Bean、*Config、*Application）。不达标走 fix 回环增量补测；
// 实测过紧时调这两个常量即可，无需改其他代码。
/** 行覆盖率阈值（0-1） */
export const COVERAGE_LINE_THRESHOLD = 0.9
/** 分支覆盖率阈值（0-1） */
export const COVERAGE_BRANCH_THRESHOLD = 0.75
