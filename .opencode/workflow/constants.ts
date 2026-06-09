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
