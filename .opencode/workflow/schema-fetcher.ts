/**
 * Schema Fetcher — 数据库 Schema 自动获取
 *
 * 在工作流启动前的预检步骤：当发现 db.xml 数据库配置时，
 * 连接 Oracle 数据库提取 schema 元数据，生成 DDL 文件。
 *
 * 触发条件：sourcePath 下存在 db.xml 或通过 --db_conf 指定配置文件。
 * 无论是否已有 PL/SQL 文件，只要找到配置就会拉取 schema。
 *
 * 设计原则：
 * - 纯前置步骤，不侵入 workflow phase 链
 * - 动态 import，不使用时不加载 oracledb
 * - 使用 oracledb 7.x thin mode（纯 JS，无需 Oracle Instant Client）
 * - 生成的 DDL 格式与现有资源文件一致，scanner 无需改动
 * - 配置文件使用 Oracle JDBC 连接描述符 XML 格式（db.xml）
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { GENERATED_OUTPUT_DIR, GENERATED_MARKER, GENERATED_MARKER_ID } from "./constants"

// ── oracledb 常量 ──────────────────────────────────────────────────────────
// 从 oracledb 库动态获取，通过 OraCtx 注入各 fetch 函数，避免模块级可变状态。

/** oracledb 常量上下文，由 fetchSchemaIfNeeded 创建并注入各 fetch 函数 */
interface OraCtx {
  outFormatObject: number   // oracledb.OUT_FORMAT_OBJECT
  stringType: any           // oracledb.STRING（DbType 对象）
}

// ── 内部配置类型 ──────────────────────────────────────────────────────────

/** 从 db.xml 解析后的内部配置结构 */
interface DbConfig {
  connectString: string
  user: string
  password: string
  schema?: string
  fetchTables?: boolean
  fetchTriggers?: boolean
  fetchViews?: boolean
  fetchSequences?: boolean
  fetchObjectTypes?: boolean
  tableFilter?: string
  triggerFilter?: string
  viewFilter?: string
  sequenceFilter?: string
  typeFilter?: string
}

// ── 元数据类型 ──────────────────────────────────────────────────────────────

interface OracleColumn {
  tableName: string
  columnName: string
  dataType: string
  dataLength: number | null
  dataPrecision: number | null
  dataScale: number | null
  nullable: string   // "Y" | "N"
  dataDefault: string | null
  charLength: number | null
  charUsed: string | null   // "C" = char, "B" = byte
  columnId: number
}

interface OracleConstraint {
  constraintName: string
  constraintType: string    // P=PK, U=Unique, R=FK, C=Check
  tableName: string
  columns: string[]
  searchCondition: string | null
  refTableName: string | null
  refColumns: string[]
  deleteRule: string | null
  status: string
}

interface OracleTrigger {
  triggerName: string
  tableName: string
  triggeringEvent: string
  triggerType: string
  whenClause: string | null
  triggerBody: string
  status: string
}

interface OracleView {
  viewName: string
  text: string
}

interface OracleSequence {
  sequenceName: string
  minValue: number | null
  maxValue: number | null
  incrementBy: number
  cacheSize: number | null
  cycleFlag: string    // "Y" | "N"
  orderFlag: string
  lastNumber: number
}

interface OracleObjectType {
  typeName: string
  typeCode: string     // "OBJECT", "COLLECTION", etc.
  source: string       // 重建的 CREATE OR REPLACE TYPE DDL
  bodySource: string | null  // TYPE BODY 源码（如有）
}

interface OracleTableComment {
  tableName: string
  comments: string
}

interface OracleColumnComment {
  tableName: string
  columnName: string
  comments: string
}

export interface SchemaFetchResult {
  tablesFetched: number
  triggersFetched: number
  viewsFetched: number
  sequencesFetched: number
  objectTypesFetched: number
  outputDir: string
}

// ── 配置加载（db.xml — Oracle JDBC 连接描述符格式）──────────────────────

/**
 * 从 XML 文本中提取指定标签的文本内容。
 *
 * 使用字符串定位代替正则，正确处理值中含 '<' 等特殊字符的情况
 * （如密码 `<p@ss<w0rd`）。不依赖 XML 解析库。
 *
 * 适用于 db.xml 这类简单结构（无 CDATA、无同名嵌套标签）。
 */
function extractXmlTag(xml: string, tagName: string): string | null {
  // 构建不区分大小写的开标签：用正则仅匹配开标签位置
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?\\s*>`, "i")
  const openMatch = xml.match(openRe)
  if (!openMatch) return null

  const contentStart = openMatch.index! + openMatch[0].length
  const closeTag = `</${tagName}>`

  // 从内容起点向后找闭合标签（不区分大小写）
  const rest = xml.slice(contentStart)
  const closeIdx = rest.search(new RegExp(closeTag, "i"))
  if (closeIdx < 0) return null

  return rest.slice(0, closeIdx).trim() || null
}

/**
 * 解析 JDBC URL 为 Oracle 连接参数。
 *
 * 支持三种格式：
 *   jdbc:oracle:thin:@host:port/SERVICE_NAME   （推荐）
 *   jdbc:oracle:thin:@host:port:SID            （旧式）
 *   jdbc:oracle:thin:@(description=...)         （TNS 描述符）
 *
 * 返回可直接作为 oracledb.getConnection 参数的 connectString。
 */
function parseJdbcUrl(jdbcUrl: string): string {
  // 去掉 jdbc:oracle:thin:@ 前缀
  const thinPrefix = "jdbc:oracle:thin:@"
  const idx = jdbcUrl.toLowerCase().indexOf(thinPrefix)
  if (idx < 0) {
    throw new Error(`无效的 JDBC URL（缺少 ${thinPrefix} 前缀）: ${jdbcUrl}`)
  }
  const connPart = jdbcUrl.slice(idx + thinPrefix.length)

  // TNS 描述符格式：直接透传
  if (connPart.startsWith("(")) {
    return connPart
  }

  // Easy Connect 格式：host:port/SERVICE_NAME 或 host:port:SID
  return connPart
}

/**
 * 从 db.xml（Oracle JDBC 连接描述符格式）解析配置。
 *
 * 支持的 XML 结构：
 * ```xml
 * <database>
 *   <url>jdbc:oracle:thin:@host:1521/ORCLCDB</url>
 *   <user>schema_reader</user>
 *   <password>tiger</password>
 *   <schema>ERP_OWNER</schema>               <!-- 可选 -->
 *   <tableFilter>T_%</tableFilter>            <!-- 可选，SQL LIKE 语法 -->
 *   <triggerFilter>TRG_%</triggerFilter>      <!-- 可选 -->
 *   <viewFilter>V_%</viewFilter>              <!-- 可选 -->
 *   <sequenceFilter>SEQ_%</sequenceFilter>    <!-- 可选 -->
 *   <typeFilter>T_%</typeFilter>              <!-- 可选 -->
 *   <fetchTables>true</fetchTables>            <!-- 可选，默认 true -->
 *   <fetchTriggers>true</fetchTriggers>       <!-- 可选，默认 true -->
 *   <fetchViews>true</fetchViews>             <!-- 可选，默认 true -->
 *   <fetchSequences>true</fetchSequences>     <!-- 可选，默认 true -->
 *   <fetchObjectTypes>true</fetchObjectTypes> <!-- 可选，默认 true -->
 * </database>
 * ```
 */
function parseDbXml(xmlContent: string, filePath: string): DbConfig {
  const url = extractXmlTag(xmlContent, "url")
  if (!url) {
    throw new Error(`db.xml 缺少 <url> 标签: ${filePath}`)
  }

  const user = extractXmlTag(xmlContent, "user")
  if (!user) {
    throw new Error(`db.xml 缺少 <user> 标签: ${filePath}`)
  }

  const password = extractXmlTag(xmlContent, "password")
  if (!password) {
    throw new Error(`db.xml 缺少 <password> 标签: ${filePath}`)
  }

  const connectString = parseJdbcUrl(url)

  const config: DbConfig = {
    connectString,
    user,
    password,
  }

  // 可选字段
  const schema = extractXmlTag(xmlContent, "schema")
  if (schema) config.schema = schema

  // 名称过滤
  const tableFilter = extractXmlTag(xmlContent, "tableFilter")
  if (tableFilter) config.tableFilter = tableFilter

  const triggerFilter = extractXmlTag(xmlContent, "triggerFilter")
  if (triggerFilter) config.triggerFilter = triggerFilter

  const viewFilter = extractXmlTag(xmlContent, "viewFilter")
  if (viewFilter) config.viewFilter = viewFilter

  const sequenceFilter = extractXmlTag(xmlContent, "sequenceFilter")
  if (sequenceFilter) config.sequenceFilter = sequenceFilter

  const typeFilter = extractXmlTag(xmlContent, "typeFilter")
  if (typeFilter) config.typeFilter = typeFilter

  // 对象类型开关
  const parseBool = (val: string | null, fallback: boolean): boolean => {
    if (val === null) return fallback
    return val.toLowerCase() !== "false"
  }

  config.fetchTables = parseBool(extractXmlTag(xmlContent, "fetchTables"), true)
  config.fetchTriggers = parseBool(extractXmlTag(xmlContent, "fetchTriggers"), true)
  config.fetchViews = parseBool(extractXmlTag(xmlContent, "fetchViews"), true)
  config.fetchSequences = parseBool(extractXmlTag(xmlContent, "fetchSequences"), true)
  config.fetchObjectTypes = parseBool(extractXmlTag(xmlContent, "fetchObjectTypes"), true)

  return config
}

/**
 * 加载 db.xml 数据库配置。
 *
 * 发现顺序（优先级从高到低）：
 * 1. dbConfPath 参数（来自 --db_conf 命令行参数）— 不存在时报错
 * 2. sourcePath/db.xml（项目根目录自动发现）
 *
 * 返回 null 表示无配置文件（DDL-only 模式）。
 */
export function loadDbConfig(dbConfPath?: string, sourcePath?: string): DbConfig | null {
  // 显式指定路径时，文件必须存在
  if (dbConfPath) {
    if (!existsSync(dbConfPath)) {
      throw new Error(`指定的数据库配置文件不存在: ${dbConfPath}`)
    }
    let raw: string
    try {
      raw = readFileSync(dbConfPath, "utf-8")
    } catch (e: any) {
      throw new Error(`无法读取 db.xml: ${e.message}`)
    }
    return parseDbXml(raw, dbConfPath)
  }

  // 自动发现
  if (sourcePath) {
    const autoPath = join(sourcePath, "db.xml")
    if (!existsSync(autoPath)) return null
    let raw: string
    try {
      raw = readFileSync(autoPath, "utf-8")
    } catch (e: any) {
      throw new Error(`无法读取 db.xml: ${e.message}`)
    }
    return parseDbXml(raw, autoPath)
  }

  return null
}

// ── 连接管理 ──────────────────────────────────────────────────────────────

/**
 * 解析密码：支持 "env:VAR_NAME" 引用环境变量
 */
function resolvePassword(password: string): string {
  if (password.startsWith("env:")) {
    const envVar = password.slice(4)
    const value = process.env[envVar]
    if (!value) {
      throw new Error(`环境变量 ${envVar} 未设置（db.xml password 引用）`)
    }
    return value
  }
  return password
}

/**
 * 从配置构建 oracledb 连接参数
 */
function buildConnectionParams(config: DbConfig): Record<string, unknown> {
  return {
    user: config.user,
    password: resolvePassword(config.password),
    connectString: config.connectString,
  }
}

// ── Oracle 元数据查询 ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OracledbConnection = any  // oracledb.Connection，动态加载

/**
 * 查询表列定义
 */
async function fetchColumns(
  conn: OracledbConnection,
  owner: string,
  tableFilter: string | undefined,
  ctx: OraCtx,
): Promise<OracleColumn[]> {
  const sql = `
    SELECT table_name, column_name, data_type, data_length, data_precision, data_scale,
           nullable, data_default, char_length, char_used, column_id
      FROM all_tab_columns
     WHERE owner = :schema
       AND table_name NOT LIKE 'BIN$%'
       AND table_name NOT IN (SELECT view_name FROM all_views WHERE owner = :schema)
       ${tableFilter ? "AND table_name LIKE :table_filter" : ""}
     ORDER BY table_name, column_id`

  const binds: Record<string, unknown> = { schema: owner }
  if (tableFilter) binds.table_filter = tableFilter

  const result = await conn.execute(sql, binds, { outFormat: ctx.outFormatObject })
  return result.rows.map((r: Record<string, unknown>) => ({
    tableName: r.TABLE_NAME as string,
    columnName: r.COLUMN_NAME as string,
    dataType: r.DATA_TYPE as string,
    dataLength: r.DATA_LENGTH as number | null,
    dataPrecision: r.DATA_PRECISION as number | null,
    dataScale: r.DATA_SCALE as number | null,
    nullable: r.NULLABLE as string,
    dataDefault: r.DATA_DEFAULT as string | null,
    charLength: r.CHAR_LENGTH as number | null,
    charUsed: r.CHAR_USED as string | null,
    columnId: r.COLUMN_ID as number,
  }))
}

/**
 * 查询约束（PK/UK/FK/CHECK）
 * 返回按 constraint_name 聚合后的约束列表
 */
async function fetchConstraints(
  conn: OracledbConnection,
  owner: string,
  tableFilter: string | undefined,
  ctx: OraCtx,
): Promise<OracleConstraint[]> {
  const filterClause = tableFilter
    ? "AND c.table_name LIKE :table_filter"
    : ""
  const binds: Record<string, unknown> = { schema: owner }
  if (tableFilter) binds.table_filter = tableFilter

  // Oracle 12c+ 有 GENERATED 列，11g 没有（ORA-00904）
  // 用模板拼接 SQL，通过 generatedClause 控制是否包含 GENERATED 过滤
  const generatedClause = "AND c.generated = 'N'"
  const buildConstraintSql = (includeGenerated: boolean) => `
    SELECT c.constraint_name, c.constraint_type, c.table_name,
           c.search_condition, c.r_constraint_name, c.delete_rule, c.status,
           cc.column_name, cc.position,
           r.table_name AS ref_table_name,
           rcc.column_name AS ref_column_name, rcc.position AS ref_position
      FROM all_constraints c
      LEFT JOIN all_cons_columns cc
        ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
      LEFT JOIN all_constraints r
        ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
      LEFT JOIN all_cons_columns rcc
        ON rcc.owner = r.owner AND rcc.constraint_name = r.constraint_name
     WHERE c.owner = :schema
       AND c.constraint_type IN ('P', 'U', 'R', 'C')
       ${includeGenerated ? generatedClause : ""}
       ${filterClause}
     ORDER BY c.table_name, c.constraint_type, c.constraint_name, cc.position, rcc.position`

  let result
  try {
    result = await conn.execute(buildConstraintSql(true), binds, { outFormat: ctx.outFormatObject })
  } catch (e: any) {
    if (e.message?.includes("ORA-00904")) {
      console.warn("[schema-fetcher] Oracle 版本不支持 GENERATED 列，回退到不带过滤的查询")
      result = await conn.execute(buildConstraintSql(false), binds, { outFormat: ctx.outFormatObject })
    } else {
      throw e
    }
  }

  // 按 constraint_name 聚合
  const constraintMap = new Map<string, OracleConstraint>()
  // 位置映射：用 Map<number, string> 替代 Set<string>，确保 columns/refColumns 按 position 排序
  const colPosMap = new Map<string, Map<number, string>>()
  const refColPosMap = new Map<string, Map<number, string>>()

  for (const row of result.rows as Record<string, unknown>[]) {
    const cName = row.CONSTRAINT_NAME as string
    const cType = row.CONSTRAINT_TYPE as string

    if (!constraintMap.has(cName)) {
      constraintMap.set(cName, {
        constraintName: cName,
        constraintType: cType,
        tableName: row.TABLE_NAME as string,
        columns: [],
        searchCondition: row.SEARCH_CONDITION as string | null,
        refTableName: row.REF_TABLE_NAME as string | null,
        refColumns: [],
        deleteRule: row.DELETE_RULE as string | null,
        status: row.STATUS as string,
      })
      colPosMap.set(cName, new Map())
      refColPosMap.set(cName, new Map())
    }

    const colPos = colPosMap.get(cName)!
    const refColPos = refColPosMap.get(cName)!

    // 使用 position 索引，避免依赖 ORDER BY 保证的行顺序
    const colName = row.COLUMN_NAME as string | null
    const position = row.POSITION as number | null
    if (colName && position != null && !colPos.has(position)) {
      colPos.set(position, colName)
    }

    const refCol = row.REF_COLUMN_NAME as string | null
    const refPosition = row.REF_POSITION as number | null
    if (refCol && refPosition != null && !refColPos.has(refPosition)) {
      refColPos.set(refPosition, refCol)
    }
  }

  // 按 position 排序后填充 columns 和 refColumns
  for (const [cName, constraint] of constraintMap) {
    const colPos = colPosMap.get(cName)!
    const refColPos = refColPosMap.get(cName)!
    constraint.columns = Array.from(colPos.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v)
    constraint.refColumns = Array.from(refColPos.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v)
  }

  return Array.from(constraintMap.values())
}

/**
 * 查询触发器
 */
async function fetchTriggers(
  conn: OracledbConnection,
  owner: string,
  triggerFilter: string | undefined,
  ctx: OraCtx,
): Promise<OracleTrigger[]> {
  const sql = `
    SELECT trigger_name, table_name, triggering_event, trigger_type,
           when_clause, trigger_body, status
      FROM all_triggers
     WHERE owner = :schema
       ${triggerFilter ? "AND trigger_name LIKE :trigger_filter" : ""}
     ORDER BY trigger_name`

  const binds: Record<string, unknown> = { schema: owner }
  if (triggerFilter) binds.trigger_filter = triggerFilter

  const result = await conn.execute(sql, binds, {
    outFormat: ctx.outFormatObject,
    fetchInfo: { TRIGGER_BODY: { type: ctx.stringType } },
  })

  return result.rows
    .map((r: Record<string, unknown>) => ({
      triggerName: r.TRIGGER_NAME as string,
      tableName: r.TABLE_NAME as string,
      triggeringEvent: r.TRIGGERING_EVENT as string,
      triggerType: r.TRIGGER_TYPE as string,
      whenClause: r.WHEN_CLAUSE as string | null,
      triggerBody: r.TRIGGER_BODY as string,
      status: r.STATUS as string,
    }))
    // 过滤 DDL/事件触发器：它们的 triggerType 含 'EVENT'，
    // 需要 ON DATABASE / ON SCHEMA 而非 ON table_name，当前不支持
    .filter(t => !t.triggerType.toUpperCase().includes("EVENT"))
}

/**
 * 查询视图
 */
async function fetchViews(
  conn: OracledbConnection,
  owner: string,
  viewFilter: string | undefined,
  ctx: OraCtx,
): Promise<OracleView[]> {
  const sql = `
    SELECT view_name, text
      FROM all_views
     WHERE owner = :schema
       ${viewFilter ? "AND view_name LIKE :view_filter" : ""}
     ORDER BY view_name`

  const binds: Record<string, unknown> = { schema: owner }
  if (viewFilter) binds.view_filter = viewFilter

  const result = await conn.execute(sql, binds, {
    outFormat: ctx.outFormatObject,
    fetchInfo: { TEXT: { type: ctx.stringType } },
  })

  return result.rows.map((r: Record<string, unknown>) => ({
    viewName: r.VIEW_NAME as string,
    text: r.TEXT as string,
  }))
}

/**
 * 查询序列
 */
async function fetchSequences(
  conn: OracledbConnection,
  owner: string,
  sequenceFilter: string | undefined,
  ctx: OraCtx,
): Promise<OracleSequence[]> {
  const sql = `
    SELECT sequence_name, min_value, max_value, increment_by,
           cache_size, cycle_flag, order_flag, last_number
      FROM all_sequences
     WHERE sequence_owner = :schema
       ${sequenceFilter ? "AND sequence_name LIKE :seq_filter" : ""}
     ORDER BY sequence_name`

  const binds: Record<string, unknown> = { schema: owner }
  if (sequenceFilter) binds.seq_filter = sequenceFilter

  const result = await conn.execute(sql, binds, { outFormat: ctx.outFormatObject })
  return result.rows.map((r: Record<string, unknown>) => ({
    sequenceName: r.SEQUENCE_NAME as string,
    minValue: r.MIN_VALUE as number | null,
    maxValue: r.MAX_VALUE as number | null,
    incrementBy: r.INCREMENT_BY as number,
    cacheSize: r.CACHE_SIZE as number | null,
    cycleFlag: r.CYCLE_FLAG as string,
    orderFlag: r.ORDER_FLAG as string,
    lastNumber: r.LAST_NUMBER as number,
  }))
}

/**
 * 查询对象类型（OBJECT + COLLECTION）
 * 使用 all_source 重建完整 DDL
 */
async function fetchObjectTypes(
  conn: OracledbConnection,
  owner: string,
  typeFilter: string | undefined,
  ctx: OraCtx,
): Promise<OracleObjectType[]> {
  // 查询类型列表
  const typeListSql = `
    SELECT type_name, typecode
      FROM all_types
     WHERE owner = :schema
       ${typeFilter ? "AND type_name LIKE :type_filter" : ""}
     ORDER BY type_name`

  const binds: Record<string, unknown> = { schema: owner }
  if (typeFilter) binds.type_filter = typeFilter

  const typeListResult = await conn.execute(typeListSql, binds, { outFormat: ctx.outFormatObject })

  if (typeListResult.rows.length === 0) return []

  const typeNames = typeListResult.rows.map((r: Record<string, unknown>) => r.TYPE_NAME as string)

  // 分批查询 all_source（Oracle IN 子句限制 1000 项）
  const BATCH_SIZE = 999
  const allSourceRows: Record<string, unknown>[] = []

  for (let batchStart = 0; batchStart < typeNames.length; batchStart += BATCH_SIZE) {
    const batch = typeNames.slice(batchStart, batchStart + BATCH_SIZE)
    const sourceSql = `
      SELECT name, type, line, text
        FROM all_source
       WHERE owner = :schema
         AND name IN (${batch.map((_, i) => `:name_${i}`).join(", ")})
         AND type IN ('TYPE', 'TYPE BODY')
       ORDER BY name, type, line`

    const sourceBinds: Record<string, unknown> = { schema: owner }
    batch.forEach((name, i) => { sourceBinds[`name_${i}`] = name })

    const batchResult = await conn.execute(sourceSql, sourceBinds, { outFormat: ctx.outFormatObject })
    allSourceRows.push(...(batchResult.rows as Record<string, unknown>[]))
  }

  const sourceResult = { rows: allSourceRows }

  // 按 name + type 聚合源码行
  const sourceMap = new Map<string, Map<string, string[]>>()
  for (const row of sourceResult.rows as Record<string, unknown>[]) {
    const name = row.NAME as string
    const type = row.TYPE as string
    const text = row.TEXT as string

    if (!sourceMap.has(name)) sourceMap.set(name, new Map())
    const typeMap = sourceMap.get(name)!
    if (!typeMap.has(type)) typeMap.set(type, [])
    typeMap.get(type)!.push(text)
  }

  // 组装结果
  return typeListResult.rows.map((r: Record<string, unknown>) => {
    const typeName = r.TYPE_NAME as string
    const typeMap = sourceMap.get(typeName)

    let source = ""
    let bodySource: string | null = null

    if (typeMap?.has("TYPE")) {
      source = typeMap.get("TYPE")!.join("")
    } else {
      // all_source 无结果时生成基础声明
      source = `create or replace type ${typeName};\n/\n`
    }

    if (typeMap?.has("TYPE BODY")) {
      bodySource = typeMap.get("TYPE BODY")!.join("")
    }

    return {
      typeName,
      typeCode: r.TYPECODE as string,
      source,
      bodySource,
    }
  })
}

/**
 * 查询表和列注释
 */
async function fetchComments(
  conn: OracledbConnection,
  owner: string,
  tableFilter: string | undefined,
  ctx: OraCtx,
): Promise<{
  tableComments: OracleTableComment[]
  columnComments: OracleColumnComment[]
}> {
  const filterClause = tableFilter
    ? "AND table_name LIKE :table_filter"
    : ""
  const binds: Record<string, unknown> = { schema: owner }
  if (tableFilter) binds.table_filter = tableFilter

  const tableCommentSql = `
    SELECT table_name, comments
      FROM all_tab_comments
     WHERE owner = :schema
       AND comments IS NOT NULL
       AND table_type = 'TABLE'
       ${filterClause}`

  const colCommentSql = `
    SELECT table_name, column_name, comments
      FROM all_col_comments
     WHERE owner = :schema
       AND comments IS NOT NULL
       ${filterClause}`

  // 顺序执行：oracledb 建议单连接上避免并发查询
  const tcResult = await conn.execute(tableCommentSql, { ...binds }, { outFormat: ctx.outFormatObject })
  const ccResult = await conn.execute(colCommentSql, { ...binds }, { outFormat: ctx.outFormatObject })

  return {
    tableComments: tcResult.rows.map((r: Record<string, unknown>) => ({
      tableName: r.TABLE_NAME as string,
      comments: r.COMMENTS as string,
    })),
    columnComments: ccResult.rows.map((r: Record<string, unknown>) => ({
      tableName: r.TABLE_NAME as string,
      columnName: r.COLUMN_NAME as string,
      comments: r.COMMENTS as string,
    })),
  }
}

// ── DDL 生成 ──────────────────────────────────────────────────────────────

/** 统一小写转换（DDL 标识符统一为小写） */
function lc(s: string): string {
  return s.toLowerCase()
}

/** Oracle 内置类型判断 */
const BUILTIN_TYPES = new Set([
  "VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "CLOB", "NCLOB",
  "NUMBER", "FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE",
  "DATE", "TIMESTAMP", "TIMESTAMP(6)", "TIMESTAMP(9)",
  "TIMESTAMP WITH TIME ZONE", "TIMESTAMP(6) WITH TIME ZONE",
  "RAW", "LONG RAW", "BLOB", "LONG",
  "BOOLEAN", "SYS_REFCURSOR",
  "XMLTYPE",
])

function isBuiltInType(dataType: string): boolean {
  const upper = dataType.toUpperCase()
  if (BUILTIN_TYPES.has(upper)) return true
  // TIMESTAMP(...) WITH [LOCAL] TIME ZONE — 但排除以 TIMESTAMP 开头的 UDT
  // Oracle 允许 CREATE TYPE TIMESTAMP_REC（TIMESTAMP 是非保留关键字），
  // 这类 UDT 不应被误判为内置类型
  if (upper.startsWith("TIMESTAMP") && !upper.startsWith("TIMESTAMP_")) return true
  return false
}

/**
 * 格式化列数据类型
 */
function formatDataType(col: OracleColumn): string {
  const type = col.dataType.toUpperCase()

  if (!isBuiltInType(type)) {
    // 用户自定义类型（如 T_DIMENSION, T_TAG_VARRAY）
    return col.dataType
  }

  switch (type) {
    case "NUMBER": {
      if (col.dataPrecision != null && col.dataScale != null && col.dataScale > 0) {
        return `number(${col.dataPrecision},${col.dataScale})`
      }
      if (col.dataPrecision != null) return `number(${col.dataPrecision})`
      return "number"
    }
    case "FLOAT": {
      // FLOAT(N) 使用二进制精度，与 NUMBER(N) 的十进制精度语义不同
      // 保留 float 拼写以区分，下游 Java 映射可据此选择 Double/Float
      if (col.dataPrecision != null) return `float(${col.dataPrecision})`
      return "float"
    }
    case "VARCHAR2":
    case "NVARCHAR2":
    case "CHAR":
    case "NCHAR": {
      const len = col.charLength || col.dataLength || 1
      const typeLower = type.toLowerCase()
      return `${typeLower}(${len})`
    }
    case "TIMESTAMP(6)":
    case "TIMESTAMP(9)":
      return "timestamp"
    case "TIMESTAMP(6) WITH TIME ZONE":
    case "TIMESTAMP(9) WITH TIME ZONE":
      return "timestamp with time zone"
    default:
      return type.toLowerCase()
  }
}

/**
 * 规范化 default 值（去除 Oracle 内部格式）
 */
function normalizeDefault(val: string | null): string | null {
  if (val == null) return null
  return val.trim()
}

/**
 * 转义 SQL 字符串中的单引号
 */
function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * 生成单个表的 CREATE TABLE DDL
 */
function generateTableDdl(
  tableName: string,
  columns: OracleColumn[],
  constraints: OracleConstraint[],
  tableComment: string | undefined,
  columnComments: Map<string, string>,
): string {
  const lines: string[] = []

  // 表注释
  if (tableComment) {
    lines.push(`-- ${tableComment}`)
  }

  lines.push(`create table ${lc(tableName)} (`)

  // 列定义
  const colDefs: string[] = []
  for (const col of columns) {
    const name = lc(col.columnName).padEnd(16)
    let def = `    ${name} ${formatDataType(col)}`

    const dv = normalizeDefault(col.dataDefault)
    if (dv) {
      def += `   default ${dv}`
    }

    def += col.nullable === "N" ? " not null" : ""
    colDefs.push(def)
  }

  // 约束：按 P → U → R → C 排序
  const pk = constraints.filter(c => c.constraintType === "P")
  const uk = constraints.filter(c => c.constraintType === "U")
  const fk = constraints.filter(c => c.constraintType === "R")
  const ck = constraints.filter(c => c.constraintType === "C")

  for (const c of pk) {
    colDefs.push(
      `    constraint ${lc(c.constraintName)} primary key (${c.columns.map(lc).join(", ")})`,
    )
  }
  for (const c of uk) {
    colDefs.push(
      `    constraint ${lc(c.constraintName)} unique (${c.columns.map(lc).join(", ")})`,
    )
  }
  for (const c of fk) {
    let fkDef = `    constraint ${lc(c.constraintName)} foreign key (${c.columns.map(lc).join(", ")})`
    if (c.refTableName) {
      fkDef += ` references ${lc(c.refTableName)}(${c.refColumns.map(lc).join(", ")})`
    }
    if (c.deleteRule && c.deleteRule !== "NO ACTION") {
      fkDef += ` on delete ${c.deleteRule}`
    }
    colDefs.push(fkDef)
  }
  for (const c of ck) {
    if (c.searchCondition) {
      colDefs.push(
        `    constraint ${lc(c.constraintName)} check (${c.searchCondition})`,
      )
    }
  }

  lines.push(colDefs.join(",\n"))
  lines.push(");")
  lines.push("")

  // 列注释
  if (columnComments.size > 0) {
    for (const [colName, comment] of columnComments) {
      lines.push(
        `comment on column ${lc(tableName)}.${lc(colName)} is '${escapeSingleQuotes(comment)}';`,
      )
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * 生成触发器 DDL
 */
function generateTriggerDdl(trigger: OracleTrigger): string {
  const lines: string[] = []

  lines.push(`create or replace trigger ${lc(trigger.triggerName)}`)

  // triggerType 格式: "BEFORE EACH ROW", "AFTER STATEMENT", "INSTEAD OF EACH ROW"
  // triggeringEvent: "INSERT OR UPDATE OR DELETE"
  // 提取 timing（BEFORE / AFTER / INSTEAD OF），去掉 level 部分（EACH ROW / STATEMENT）
  const rawType = trigger.triggerType.toUpperCase()
  const suffixes = ["EACH ROW", "STATEMENT"]
  let timing = rawType
  for (const suffix of suffixes) {
    if (rawType.endsWith(suffix)) {
      timing = rawType.slice(0, rawType.length - suffix.length).trim()
      break
    }
  }
  lines.push(`${timing} ${trigger.triggeringEvent} on ${lc(trigger.tableName)}`)

  if (trigger.whenClause) {
    lines.push(`when (${trigger.whenClause})`)
  }

  lines.push(trigger.triggerBody)
  lines.push("/")
  lines.push("")

  return lines.join("\n")
}

/**
 * 生成视图 DDL
 */
function generateViewDdl(view: OracleView): string {
  const lines: string[] = []

  lines.push(`create or replace view ${lc(view.viewName)} as`)
  lines.push(view.text.trimEnd())
  lines.push("/")
  lines.push("")

  return lines.join("\n")
}

/**
 * 生成所有序列 DDL（合并到一个文件）
 */
function generateSequencesDdl(sequences: OracleSequence[]): string {
  const lines: string[] = ["-- 序列（从数据库自动获取）\n"]

  for (const seq of sequences) {
    let ddl = `create sequence ${lc(seq.sequenceName)}`
    // Oracle ALL_SEQUENCES.LAST_NUMBER 是上次持久化到磁盘的值，对 cached 序列会滞后。
    // 使用 lastNumber + 1 作为 START WITH 以避免重新创建时发出已用过的值。
    // 注意：这对 nocache 序列是精确的；对 cached 序列仍可能有少量间隙，
    // 但不会产生重复值。
    ddl += ` start with ${seq.lastNumber + 1}`
    ddl += ` increment by ${seq.incrementBy}`

    if (seq.cacheSize != null && seq.cacheSize > 0) {
      ddl += ` cache ${seq.cacheSize}`
    } else {
      ddl += " nocache"
    }

    ddl += seq.cycleFlag === "Y" ? " cycle" : " nocycle"
    ddl += ";"

    lines.push(ddl)
  }

  lines.push("")
  return lines.join("\n")
}

/**
 * 生成对象类型 DDL
 */
function generateObjectTypeDdl(objType: OracleObjectType): string {
  const lines: string[] = []

  // TYPE 规格源码（all_source 已包含完整 CREATE OR REPLACE TYPE ... ; 语句）
  if (objType.source) {
    const trimmedSource = objType.source.trimEnd()
    lines.push(trimmedSource)
    if (!trimmedSource.endsWith("/")) {
      lines.push("/")
    }
    lines.push("")
  }

  // TYPE BODY（如有）
  if (objType.bodySource) {
    const trimmedBody = objType.bodySource.trimEnd()
    lines.push(trimmedBody)
    if (!trimmedBody.endsWith("/")) {
      lines.push("/")
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ── 文件输出 ──────────────────────────────────────────────────────────────

/**
 * 生成不重复的文件路径。
 * 当小写化后文件名冲突时（如 Oracle 中存在 ORDERS 表和 Orders 视图），
 * 追加数字后缀（orders.sql → orders_2.sql）避免覆盖。
 */
function dedupedFilePath(
  dir: string,
  baseName: string,      // 已小写化的文件名（不含扩展名）
  ext: string,           // 扩展名（含点，如 ".sql"）
  usedNames: Set<string>, // 已使用的文件名集合（不含目录前缀）
): string {
  let name = `${baseName}${ext}`
  if (!usedNames.has(name)) {
    usedNames.add(name)
    return join(dir, name)
  }
  let i = 2
  do {
    name = `${baseName}_${i}${ext}`
    i++
  } while (usedNames.has(name))
  usedNames.add(name)
  return join(dir, name)
}

/**
 * 将元数据生成 DDL 文件并写入 sourcePath 下
 */
function generateDdlFiles(
  sourcePath: string,
  data: {
    columns: OracleColumn[]
    constraints: OracleConstraint[]
    triggers: OracleTrigger[]
    views: OracleView[]
    sequences: OracleSequence[]
    objectTypes: OracleObjectType[]
    tableComments: OracleTableComment[]
    columnComments: OracleColumnComment[]
  },
): SchemaFetchResult {

  // 使用带时间戳的临时目录写入，完成后原子性 rename，避免崩溃时残留部分文件
  // 使用唯一后缀避免与前次残留目录冲突（如 rmSync 因文件锁定失败时）
  const stagingDir = join(sourcePath, `.schema-staging-${Date.now()}`)
  // 清理可能存在的上次 staging 目录（清理旧的 .schema-staging-* 目录）
  try {
    const entries = readdirSync(sourcePath)
    for (const entry of entries) {
      if (entry.startsWith(".schema-staging")) {
        try { rmSync(join(sourcePath, entry), { recursive: true }) } catch { /* 文件锁定时忽略 */ }
      }
    }
  } catch { /* sourcePath 不存在或不可读 */ }

  const stagingSchemaDir = join(stagingDir, "schema")
  const stagingTriggerDir = join(stagingDir, "trigger")
  const stagingTypeDir = join(stagingDir, "type")
  mkdirSync(stagingSchemaDir, { recursive: true })
  mkdirSync(stagingTriggerDir, { recursive: true })
  mkdirSync(stagingTypeDir, { recursive: true })

  // 构建索引
  const columnsByTable = new Map<string, OracleColumn[]>()
  for (const col of data.columns) {
    if (!columnsByTable.has(col.tableName)) columnsByTable.set(col.tableName, [])
    columnsByTable.get(col.tableName)!.push(col)
  }

  const constraintsByTable = new Map<string, OracleConstraint[]>()
  for (const c of data.constraints) {
    if (!constraintsByTable.has(c.tableName)) constraintsByTable.set(c.tableName, [])
    constraintsByTable.get(c.tableName)!.push(c)
  }

  const tableCommentMap = new Map<string, string>()
  for (const tc of data.tableComments) {
    tableCommentMap.set(tc.tableName, tc.comments)
  }

  const colCommentMap = new Map<string, Map<string, string>>()
  for (const cc of data.columnComments) {
    if (!colCommentMap.has(cc.tableName)) colCommentMap.set(cc.tableName, new Map())
    colCommentMap.get(cc.tableName)!.set(cc.columnName, cc.comments)
  }

  // 生成表 DDL（每表一个文件）
  // 表和视图共享 stagingSchemaDir，用同一个 usedNames 防止同名覆盖
  const schemaUsedNames = new Set<string>()
  let tablesFetched = 0
  for (const [tableName, cols] of columnsByTable) {
    const constraints = constraintsByTable.get(tableName) || []
    const tc = tableCommentMap.get(tableName)
    const cc = colCommentMap.get(tableName) || new Map<string, string>()
    const ddl = generateTableDdl(tableName, cols, constraints, tc, cc)
    writeFileSync(dedupedFilePath(stagingSchemaDir, lc(tableName), ".sql", schemaUsedNames), ddl, "utf-8")
    tablesFetched++
  }

  // 生成触发器 DDL（每触发器一个文件）
  const triggerUsedNames = new Set<string>()
  let triggersFetched = 0
  for (const trigger of data.triggers) {
    const ddl = generateTriggerDdl(trigger)
    writeFileSync(dedupedFilePath(stagingTriggerDir, lc(trigger.triggerName), ".sql", triggerUsedNames), ddl, "utf-8")
    triggersFetched++
  }

  // 生成视图 DDL（每视图一个文件，放入 schema/ 目录）
  let viewsFetched = 0
  for (const view of data.views) {
    const ddl = generateViewDdl(view)
    writeFileSync(dedupedFilePath(stagingSchemaDir, lc(view.viewName), ".sql", schemaUsedNames), ddl, "utf-8")
    viewsFetched++
  }

  // 生成序列 DDL（合并一个文件）
  let sequencesFetched = 0
  if (data.sequences.length > 0) {
    const ddl = generateSequencesDdl(data.sequences)
    writeFileSync(join(stagingSchemaDir, "sequences.sql"), ddl, "utf-8")
    sequencesFetched = data.sequences.length
  }

  // 生成对象类型 DDL（每类型一个文件）
  const typeUsedNames = new Set<string>()
  let objectTypesFetched = 0
  for (const objType of data.objectTypes) {
    const ddl = generateObjectTypeDdl(objType)
    writeFileSync(dedupedFilePath(stagingTypeDir, lc(objType.typeName), ".sql", typeUsedNames), ddl, "utf-8")
    objectTypesFetched++
  }

  // 写入标记文件，标识此目录由 schema-fetcher 生成（供清理时区分用户自有目录）
  // 内容为 JSON，包含 generator 字段用于校验真实性
  const markerContent = JSON.stringify({
    generator: GENERATED_MARKER_ID,
    createdAt: new Date().toISOString(),
  })
  writeFileSync(join(stagingDir, GENERATED_MARKER), markerContent, "utf-8")

  // 提交 staging 目录为正式输出
  // 先删除旧输出目录，再 rename staging → outputDir
  // 不使用 backup/rollback 机制：DDL 可从数据库随时重新生成，
  // 且 rename-based rollback 在 Windows 上不可靠（EPERM on existing dir）
  const outputDir = join(sourcePath, GENERATED_OUTPUT_DIR)
  if (existsSync(outputDir)) {
    try {
      rmSync(outputDir, { recursive: true })
    } catch (rmErr: any) {
      throw new Error(`无法清理旧的 ${GENERATED_OUTPUT_DIR} 目录: ${rmErr.message}`)
    }
  }

  try {
    renameSync(stagingDir, outputDir)
  } catch (commitErr: any) {
    throw new Error(
      `DDL 文件提交失败（staging 目录仍保留: ${stagingDir}）: ${commitErr.message}`,
    )
  }

  return {
    tablesFetched,
    triggersFetched,
    viewsFetched,
    sequencesFetched,
    objectTypesFetched,
    outputDir: join(outputDir, "schema"),
  }
}

/**
 * 校验标记文件是否确实由 schema-fetcher 生成。
 * 通过读取并解析 JSON 内容中的 generator 字段判断，而非仅看文件是否存在。
 */
function isOurGeneratedMarker(markerPath: string): boolean {
  try {
    const raw = readFileSync(markerPath, "utf-8").trim()
    const parsed = JSON.parse(raw)
    return parsed.generator === GENERATED_MARKER_ID
  } catch {
    return false
  }
}

/**
 * 清理 schema-fetcher 生成的 ddl-output 目录。
 * 仅在目录包含有效标记文件（generator 字段匹配）时删除，保护用户自有的同名目录。
 */
export function cleanupGeneratedDdl(sourcePath: string): void {
  const ddlOutput = join(sourcePath, GENERATED_OUTPUT_DIR)
  const markerPath = join(ddlOutput, GENERATED_MARKER)
  if (existsSync(markerPath) && isOurGeneratedMarker(markerPath)) {
    try { rmSync(ddlOutput, { recursive: true }) } catch { /* ignore */ }
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 前置 schema 获取：发现 db.xml 配置时连接 Oracle 拉取 schema 并生成 DDL 文件。
 *
 * 在 plugins/workflow-engine.ts 的 start action 中，scanSource 之前调用。
 * 使用动态 import 加载 oracledb，不使用时不加载。
 *
 * 触发条件：dbConfPath 参数或 sourcePath/db.xml 存在。
 * 无论是否已有 PL/SQL 文件，只要找到配置就会拉取 schema。
 *
 * @param sourcePath 源码路径
 * @param dbConfPath 显式指定的 db.xml 路径（来自 --db_conf）
 * @returns fetched=true 表示已从数据库获取并生成 DDL 文件
 */
export async function fetchSchemaIfNeeded(
  sourcePath: string,
  dbConfPath?: string,
): Promise<{ fetched: boolean; result?: SchemaFetchResult; error?: string }> {
  // 归一化：空字符串视为未指定
  const effectiveDbConfPath = (dbConfPath != null && dbConfPath !== "") ? dbConfPath : undefined

  // 0. sourcePath 必须存在（避免后续 mkdirSync 静默创建错误路径）
  if (!existsSync(sourcePath)) {
    return {
      fetched: false,
      error: `源码路径不存在: ${sourcePath}`,
    }
  }

  // 1. 加载配置（发现 db.xml → 拉取；无配置 → 静默跳过）
  let config: DbConfig
  try {
    const loaded = loadDbConfig(effectiveDbConfPath, sourcePath)
    if (!loaded) {
      // 无配置文件，DDL-only 模式，不是错误
      return { fetched: false }
    }
    config = loaded
  } catch (e: any) {
    return { fetched: false, error: e.message }
  }

  // 2. 动态加载 oracledb（thin mode，纯 JS）
  let oracledb: typeof import("oracledb")
  let oraCtx: OraCtx
  try {
    oracledb = await import("oracledb")
    // 从库中获取常量，注入各 fetch 函数（避免模块级可变状态）
    oraCtx = {
      outFormatObject: oracledb.OUT_FORMAT_OBJECT,
      stringType: oracledb.STRING,
    }
  } catch {
    return {
      fetched: false,
      error:
        "无法加载 oracledb 模块。请确认依赖已安装：\n" +
        "  cd .opencode && npm install",
    }
  }

  // 3. 连接数据库并拉取 schema
  const owner = (config.schema || config.user).toUpperCase()
  let connection: OracledbConnection | null = null

  try {
    const connParams = buildConnectionParams(config)
    connection = await oracledb.getConnection(connParams)
    console.error(`[schema-fetcher] 已连接 Oracle，正在获取 schema: ${owner}`)

    // 顺序查询各类型元数据（oracledb 建议单连接上避免并发查询）
    const tableFilter = config.tableFilter

    let columns: OracleColumn[] = []
    let constraints: OracleConstraint[] = []
    let triggers: OracleTrigger[] = []
    let views: OracleView[] = []
    let sequences: OracleSequence[] = []
    let objectTypes: OracleObjectType[] = []
    let tableComments: OracleTableComment[] = []
    let columnComments: OracleColumnComment[] = []

    // 表列 + 约束 + 注释（有表过滤时一起查）
    if (config.fetchTables) {
      columns = await fetchColumns(connection, owner, tableFilter, oraCtx)
      constraints = await fetchConstraints(connection, owner, tableFilter, oraCtx)
      const commentsResult = await fetchComments(connection, owner, tableFilter, oraCtx)
      tableComments = commentsResult.tableComments
      columnComments = commentsResult.columnComments
    }

    if (config.fetchTriggers) {
      triggers = await fetchTriggers(connection, owner, config.triggerFilter, oraCtx)
    }

    if (config.fetchViews) {
      views = await fetchViews(connection, owner, config.viewFilter, oraCtx)
    }

    if (config.fetchSequences) {
      sequences = await fetchSequences(connection, owner, config.sequenceFilter, oraCtx)
    }

    if (config.fetchObjectTypes) {
      objectTypes = await fetchObjectTypes(connection, owner, config.typeFilter, oraCtx)
    }

    // 4. 检查是否有数据
    const totalCount = columns.length + triggers.length + views.length
      + sequences.length + objectTypes.length
    if (totalCount === 0) {
      console.warn(`[schema-fetcher] Oracle schema "${owner}" 未找到任何对象（可能由过滤条件导致）。继续使用已有 PL/SQL 文件。`)
      // 不阻断工作流：生成空的 ddl-output 目录，让 scanSource 继续处理本地文件
    }

    // 5. 生成 DDL 文件
    const result = generateDdlFiles(sourcePath, {
      columns,
      constraints,
      triggers,
      views,
      sequences,
      objectTypes,
      tableComments,
      columnComments,
    })

    console.error(
      `[schema-fetcher] DDL 文件已生成: ${result.tablesFetched} 表, ${result.triggersFetched} 触发器, ` +
      `${result.viewsFetched} 视图, ${result.sequencesFetched} 序列, ${result.objectTypesFetched} 类型`,
    )

    return { fetched: true, result }
  } catch (e: any) {
    // 识别常见 Oracle 错误码
    const msg = e.message || String(e)
    if (msg.includes("ORA-12154") || msg.includes("ORA-12541") || msg.includes("NJS-500")) {
      return {
        fetched: false,
        error: `无法连接 Oracle: ${msg}\n请检查 connectString / host / port 和网络连通性。`,
      }
    }
    if (msg.includes("ORA-01017")) {
      return {
        fetched: false,
        error: `Oracle 认证失败。请检查 db.xml 中的 user/password。`,
      }
    }
    if (msg.includes("ORA-00942")) {
      return {
        fetched: false,
        error: `无权限访问 Oracle 数据字典视图。请确认用户有 SELECT ANY DICTIONARY 权限或 DBA 角色。`,
      }
    }
    return { fetched: false, error: `Schema 获取失败: ${msg}` }
  } finally {
    if (connection) {
      try { await connection.close() } catch { /* ignore */ }
    }
  }
}
