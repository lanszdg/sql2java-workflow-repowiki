/**
 * PL/SQL Structural Scanner — AST + regex 双模式
 *
 * 在 workflow start 时确定性扫描 PL/SQL 源码目录，产出 inventory-index.json。
 * 不依赖 LLM，不占用上下文窗口。
 *
 * AST 模式：@griffithswaite/ts-plsql-parser（ANTLR4 生成）
 * Regex 降级：Node.js fs + 正则（parser 安装失败时自动降级）
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, extname, relative } from "node:path"
import { ensureDeps, findOpencodeDir } from "./ensure-deps"
import { GENERATED_OUTPUT_DIR, GENERATED_MARKER, VALID_SOURCE_EXTENSIONS } from "./constants"
import { getLogger } from "./workflow-logger"

// ── 类型 ────────────────────────────────────────────────────────────────────────

export interface ParamIndex {
  name: string
  oracleType: string
  direction: "IN" | "OUT" | "IN OUT"
}

export interface ProcedureIndex {
  name: string
  type: "procedure" | "function"
  lineRange?: [number, number]  // [startLine, endLine]
  // ── 结构抽取扩展（AST 模式填充；regex 降级时缺省）──
  params?: ParamIndex[]
  returnType?: string | null     // FUNCTION 的返回类型；procedure 为 null/缺省
  loc?: number                   // 行数（lineRange 跨度）
}

export interface TypeIndex {
  name: string
  kind: string                   // RECORD / TABLE / VARRAY / REF CURSOR / OBJECT ...
  definition: string
}

export interface VariableIndex {
  name: string
  type: string
  defaultValue?: string | null
}

export interface ConstantIndex {
  name: string
  type: string
  value: string
}

export interface PackageIndex {
  name: string
  specFile?: string
  bodyFile?: string
  procedures: ProcedureIndex[]
  estimatedLoc: number
  // ── 结构抽取扩展（AST 模式填充；regex 降级时缺省）──
  types?: TypeIndex[]
  variables?: VariableIndex[]
  constants?: ConstantIndex[]
}

export interface ColumnIndex {
  name: string
  oracleType: string
  nullable: boolean
  isPrimaryKey: boolean
  defaultValue?: string | null
}

export interface TableIndex {
  name: string
  ddlFile?: string
  // ── 结构抽取扩展 ──
  columns?: ColumnIndex[]
}

export interface TriggerIndex {
  name: string
  sourceFile: string
  // ── 结构抽取扩展 ──
  timing?: string                // before / after / instead-of
  level?: string                 // row / statement
  targetTable?: string
  events?: string[]              // insert / update / delete
  lineRange?: [number, number]
  condition?: string | null
}

export interface ViewIndex {
  name: string
  ddlFile?: string
  // ── 结构抽取扩展 ──
  columns?: string[]
  underlyingTables?: string[]
}

export interface SequenceIndex {
  name: string
  ddlFile?: string
  // ── 结构抽取扩展 ──
  startWith?: number | null
  incrementBy?: number | null
  minValue?: number | null
  maxValue?: number | null
  cycle?: boolean | null
}

export interface StandaloneProcIndex {
  name: string
  type: "procedure" | "function"
  sourceFile: string
  // ── 结构抽取扩展 ──
  params?: ParamIndex[]
  returnType?: string | null
  lineRange?: [number, number]
}

export interface InventoryIndex {
  sourcePath: string
  scannedAt: string
  scannerUsed: "ast" | "regex"
  packages: PackageIndex[]
  tables: TableIndex[]
  triggers: TriggerIndex[]
  views: ViewIndex[]
  sequences: SequenceIndex[]
  standaloneProcedures: StandaloneProcIndex[]
  callGraph?: Record<string, string[]>
}

// ── AST 模式内部类型 ────────────────────────────────────────────────────────────

interface ParsedNode {
  type: string
  text: string
  start: string | null
  stop: string | null
  nodes: ParsedNode[]
}

// ── SQL*Plus 命令预处理 ────────────────────────────────────────────────────────

/**
 * 剥离 SQL*Plus 专有命令，避免 ANTLR 解析器报错。
 * SQL*Plus 命令是客户端编排指令（prompt/@@/SET 等），不含 PL/SQL 结构定义，
 * 对 inventory 扫描无影响。
 *
 * 处理的命令：
 *   prompt <text>        — 控制台输出
 *   @@<file> / @<file>   — 文件引入（扫描器已单独收集每个文件）
 *   SET / SPOOL / DEFINE / UNDEFINE / VARIABLE / ACCEPT 等
 */
function stripSqlPlusCommands(code: string): string {
  return code
    .split("\n")
    .map(line => {
      const trimmed = line.trimStart()
      // prompt（SQL*Plus 输出命令）
      if (/^prompt\b/i.test(trimmed)) return ""
      // @@ 或 @ 引入文件
      if (/^@@?\s?\S/i.test(trimmed)) return ""
      // 常见 SQL*Plus 会话/格式命令
      if (/^(SET|SPOOL|DEFINE|UNDEFINE|VARIABLE|ACCEPT|EXIT|QUIT|WHENEVER|HOST|COLUMN|TTITLE|BTITLE|BREAK|COMPUTE|REM|CLEAR)\b/i.test(trimmed)) return ""
      return line
    })
    .join("\n")
}

// ── Parser 安装检测 & 自动安装 ─────────────────────────────────────────────────

let parserAvailable: boolean | null = null

/**
 * 检测 parser 是否可用，不可用则通过 ensureDeps 安装所有依赖。
 * 成功返回 true，失败返回 false（将降级到 regex）。
 */
export async function ensureParser(): Promise<boolean> {
  if (parserAvailable !== null) return parserAvailable

  const opencodeDir = findOpencodeDir()

  // 1. 尝试 require（使用显式 paths 确保从 .opencode/node_modules 解析）
  try {
    require.resolve("@griffithswaite/ts-plsql-parser", { paths: [opencodeDir] })
    parserAvailable = true
    return true
  } catch {}

  // 2. 通过统一依赖安装模块安装所有依赖
  try {
    await ensureDeps()
    // 安装后再次检测
    require.resolve("@griffithswaite/ts-plsql-parser", { paths: [opencodeDir] })
    parserAvailable = true
    return true
  } catch {
    parserAvailable = false
    return false
  }
}

// ── AST 扫描 ────────────────────────────────────────────────────────────────────

/**
 * 使用 @griffithswaite/ts-plsql-parser 的 getParsedNodes 提取结构。
 * 逐文件解析，汇总结果。
 */
export async function scanWithAST(sourcePath: string): Promise<InventoryIndex> {
  const { getParserFromInput, getParsedNodes } = await import("@griffithswaite/ts-plsql-parser")
  // 动态导入 antlr4 的 BailErrorStrategy，避免静态导入找不到模块的类型错误
  const antlr4 = await import("antlr4")
  const files = collectSourceFiles(sourcePath)
  const packages = new Map<string, PackageIndex>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const callGraph: Record<string, string[]> = {}

  for (const filePath of files) {
    const rawCode = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const relPath = relative(sourcePath, filePath)
    const ext = extname(filePath).toLowerCase()
    const code = stripSqlPlusCommands(rawCode)

    // 按文件类型路由：ts-plsql-parser 对含 SQL 体的构造（package body / trigger / view）
    // 解析极慢或抛错（FOR UPDATE OF / FORALL SAVE EXCEPTIONS 等 grammar 缺口），而 inventory
    // 只需 spec 的签名 + DDL 结构，body 仅需 lineRange（regex 即可）。故：
    //   spec / table / sequence / standalone-proc → AST（快、结构丰富）
    //   body         → regex 取 lineRange（签名由 spec 提供）
    //   trigger/view → 文本提取（元数据在头部 / SELECT，不进 AST 体）
    //   type / dml   → 跳过（inventory 不建模对象类型 / DML）
    const kind = classifyFile(code)
    try {
      if (kind === "body") {
        regexFallbackForFile(code, relPath, ext, packages, tables, triggers, views, sequences, standaloneProcedures, callGraph)
      } else if (kind === "trigger") {
        extractTriggerFromText(code, triggers, relPath)
        extractCallGraph(code, relPath, callGraph)
      } else if (kind === "view") {
        extractViewFromText(code, views, relPath)
        extractCallGraph(code, relPath, callGraph)
      } else if (kind === "type" || kind === "dml") {
        // 跳过结构抽取；仍抽取调用关系（CREATE TYPE BODY / DML 中可能有调用）
        extractCallGraph(code, relPath, callGraph)
      } else {
        // AST：spec / table / sequence / standalone-proc
        const parser = getParserFromInput(code) as any
        const lexer = parser.getTokenStream()?.tokenSource
        lexer?.removeErrorListeners()
        parser.removeErrorListeners()
        if (typeof parser._errHandler !== "undefined") {
          parser._errHandler = new antlr4.BailErrorStrategy()
        }
        const tree = parser.sql_script()
        const result = getParsedNodes(code, tree)

        for (const scriptNode of result.nodes) {
          if (scriptNode.type !== "Sql_scriptContext") continue
          for (const unitNode of scriptNode.nodes) {
            if (unitNode.type !== "Unit_statementContext") continue
            for (const child of unitNode.nodes) {
              switch (child.type) {
                case "Create_packageContext":
                  extractPackageSpec(child, packages, relPath)
                  break
                case "Create_package_bodyContext":
                  extractPackageBody(child, packages, relPath, code)
                  break
                case "Create_procedure_bodyContext":
                  extractStandaloneProc(child, standaloneProcedures, relPath, "procedure")
                  break
                case "Create_function_bodyContext":
                  extractStandaloneProc(child, standaloneProcedures, relPath, "function")
                  break
                case "Create_tableContext":
                  extractTable(child, tables, relPath)
                  break
                case "Create_triggerContext":
                  extractTrigger(child, triggers, relPath)
                  break
                case "Create_viewContext":
                  extractView(child, views, relPath)
                  break
                case "Create_sequenceContext":
                  extractSequence(child, sequences, relPath)
                  break
              }
            }
          }
        }
        extractCallGraph(code, relPath, callGraph)
      }
    } catch (e) {
      // AST 解析失败，降级到 regex 提取
      const errMsg = e instanceof Error ? e.message : String(e)
      getLogger().warn("[plsql-scanner]", `AST 解析失败，降级到 regex: ${relPath} — ${errMsg}`)
      regexFallbackForFile(code, relPath, ext, packages, tables, triggers, views, sequences, standaloneProcedures, callGraph)
    }
  }

  return {
    sourcePath,
    scannedAt: new Date().toISOString(),
    scannerUsed: "ast",
    packages: Array.from(packages.values()),
    tables,
    triggers,
    views,
    sequences,
    standaloneProcedures,
    callGraph: Object.keys(callGraph).length > 0 ? callGraph : undefined,
  }
}

// ── AST 提取辅助函数 ────────────────────────────────────────────────────────────

/** 从 Package_nameContext 的子节点提取包名 */
function extractPackageName(node: ParsedNode): string | null {
  if (node.type === "Package_nameContext") {
    return findIdentifierText(node)
  }
  for (const child of node.nodes) {
    const name = extractPackageName(child)
    if (name) return name
  }
  return null
}

/** 从 Table_nameContext 提取表名 */
function extractTableName(node: ParsedNode): string | null {
  if (node.type === "Table_nameContext") {
    return findIdentifierText(node)
  }
  for (const child of node.nodes) {
    const name = extractTableName(child)
    if (name) return name
  }
  return null
}

/** 从 Trigger_nameContext 提取触发器名 */
function extractTriggerName(node: ParsedNode): string | null {
  if (node.type === "Trigger_nameContext") {
    return findIdentifierText(node)
  }
  for (const child of node.nodes) {
    const name = extractTriggerName(child)
    if (name) return name
  }
  return null
}

/** 从 Sequence_nameContext 提取序列名 */
function extractSequenceName(node: ParsedNode): string | null {
  if (node.type === "Sequence_nameContext") {
    return nameContextText(node)
  }
  for (const child of node.nodes) {
    const name = extractSequenceName(child)
    if (name) return name
  }
  return null
}

/** 从节点中找到第一个 IdentifierContext 的文本（跳过关键字 token） */
function findIdentifierText(node: ParsedNode): string | null {
  if (node.type === "IdentifierContext") {
    return node.text?.toUpperCase() ?? null
  }
  for (const child of node.nodes) {
    const text = findIdentifierText(child)
    if (text) return text
  }
  return null
}

/**
 * 从 *NameContext 提取名称：优先找 IdentifierContext 子节点；找不到则直接用
 * context 节点的 text（部分 context 如 Sequence_nameContext 不含 IdentifierContext，
 * 名称直接挂在节点 text 上）。返回大写。
 */
function nameContextText(node: ParsedNode): string | null {
  const id = findIdentifierText(node)
  if (id) return id
  const t = (node.text || "").trim()
  return t ? t.toUpperCase() : null
}

/** 解析 "line:col" 格式的位置为行号 */
function parseLine(pos: string | null): number | null {
  if (!pos) return null
  return parseInt(pos.split(":")[0], 10) || null
}

// ── 结构抽取通用辅助（AST 模式专用）────────────────────────────────────────────

/** 收集子树中所有指定 type 的节点 */
function collectByType(node: ParsedNode, type: string, acc: ParsedNode[] = []): ParsedNode[] {
  if (node.type === type) acc.push(node)
  if (node.nodes) for (const c of node.nodes) collectByType(c, type, acc)
  return acc
}

/** 拼接节点子树所有叶子 token 文本（保留原始大小写） */
function subtreeText(node: ParsedNode): string {
  if (!node.nodes || node.nodes.length === 0) return (node.text || "").trim()
  return node.nodes.map(subtreeText).filter(Boolean).join(" ")
}

/** 规范化类型文本：'VARCHAR2 ( 50 )' → 'VARCHAR2(50)'，'t_item %ROWTYPE' → 't_item%ROWTYPE' */
function normalizeTypeText(s: string): string {
  return s
    .replace(/\s*([(),%])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/** 第一个 IdentifierContext 的原始文本（保留源码大小写，用于名称类字段） */
function firstIdentifierRaw(node: ParsedNode | null | undefined): string | null {
  if (!node) return null
  if (node.type === "IdentifierContext") return node.text ?? null
  for (const c of node.nodes || []) {
    const t = firstIdentifierRaw(c)
    if (t) return t
  }
  return null
}

/** 从 ParameterContext 提取单个参数 {name, oracleType, direction} */
function extractParameter(paramNode: ParsedNode): ParamIndex | null {
  const nameNode = collectByType(paramNode, "Parameter_nameContext")[0]
  const name = (firstIdentifierRaw(nameNode) || firstIdentifierRaw(paramNode))
  if (!name) return null
  // direction：ParameterContext 直接子节点中的 IN / OUT token
  const dirTokens = (paramNode.nodes || [])
    .map(c => (c.text || "").trim().toUpperCase())
    .filter(t => t === "IN" || t === "OUT")
  let direction: ParamIndex["direction"]
  if (dirTokens.includes("IN") && dirTokens.includes("OUT")) direction = "IN OUT"
  else if (dirTokens.includes("OUT")) direction = "OUT"
  else direction = "IN"
  const typeSpec = collectByType(paramNode, "Type_specContext")[0]
  const oracleType = typeSpec ? normalizeTypeText(subtreeText(typeSpec)) : "unknown"
  return { name, oracleType, direction }
}

/** 从一组 ParameterContext 提取参数列表 */
function extractParams(node: ParsedNode): ParamIndex[] {
  return collectByType(node, "ParameterContext")
    .map(extractParameter)
    .filter((p): p is ParamIndex => p !== null)
}

/** 从 Function spec/body 节点提取返回类型（RETURN 后的第一个 Type_spec） */
function extractReturnType(funcNode: ParsedNode): string | null {
  const children = funcNode.nodes || []
  let seenReturn = false
  for (const c of children) {
    if (!seenReturn) {
      if ((c.text || "").trim().toUpperCase() === "RETURN") seenReturn = true
      continue
    }
    if (c.type === "Type_specContext") return normalizeTypeText(subtreeText(c))
  }
  return null
}

/** 提取 Package spec */
function extractPackageSpec(
  node: ParsedNode,
  packages: Map<string, PackageIndex>,
  relPath: string,
): void {
  const pkgName = extractPackageName(node)
  if (!pkgName) return

  const existing = packages.get(pkgName) ?? {
    name: pkgName,
    specFile: undefined,
    bodyFile: undefined,
    procedures: [],
    estimatedLoc: 0,
  }
  existing.specFile = relPath
  existing.estimatedLoc += (node.text || "").split("\n").length

  // 提取 procedures 和 functions（含参数 / 返回类型 / loc）。
  // spec 是声明的权威来源（含重载多版本、参数签名）；以 spec 重建 procedures 列表，
  // 同时保留 body 可能已写入的 lineRange（实现行号范围，比 spec 声明行更精确）。
  // 按名匹配 body 已有条目（重载按首条 best-effort），避免 body/spec 顺序导致的重复。
  const specProcs: ProcedureIndex[] = []
  for (const child of node.nodes) {
    if (child.type !== "Package_obj_specContext") continue
    for (const obj of child.nodes) {
      const isProc = obj.type === "Procedure_specContext"
      const isFunc = obj.type === "Function_specContext"
      if (!isProc && !isFunc) continue
      const procName = findIdentifierText(obj)
      if (!procName) continue
      const startLine = parseLine(obj.start)
      const endLine = parseLine(obj.stop)
      const specRange = startLine && endLine ? [startLine, endLine] as [number, number] : undefined
      const bodyMatch = existing.procedures.find(p => p.name === procName.toLowerCase())
      const lineRange = bodyMatch?.lineRange ?? specRange
      specProcs.push({
        name: procName.toLowerCase(),
        type: isFunc ? "function" : "procedure",
        lineRange,
        loc: lineRange ? lineRange[1] - lineRange[0] + 1 : undefined,
        params: extractParams(obj),
        returnType: isFunc ? extractReturnType(obj) : null,
      })
    }
  }
  existing.procedures = specProcs

  // 提取 package 级 types / variables / constants
  existing.types = extractTypeDeclarations(node)
  const varsAndConsts = extractVariablesAndConstants(node)
  existing.variables = varsAndConsts.variables
  existing.constants = varsAndConsts.constants

  packages.set(pkgName, existing)
}

/** 提取 Package body */
function extractPackageBody(
  node: ParsedNode,
  packages: Map<string, PackageIndex>,
  relPath: string,
  code: string,
): void {
  const pkgName = extractPackageName(node)
  if (!pkgName) return

  const existing = packages.get(pkgName) ?? {
    name: pkgName,
    specFile: undefined,
    bodyFile: undefined,
    procedures: [],
    estimatedLoc: 0,
  }
  existing.bodyFile = relPath
  existing.estimatedLoc += (node.text || "").split("\n").length

  // body 中可能有额外的 procedure/function 实现，补充行号 + 参数（body-only 才取参数）
  for (const child of node.nodes) {
    if (child.type === "Package_obj_bodyContext") {
      for (const obj of child.nodes) {
        if (obj.type === "Procedure_bodyContext" || obj.type === "Function_bodyContext") {
          const procName = findIdentifierText(obj)
          const procType = obj.type === "Procedure_bodyContext" ? "procedure" : "function"
          if (procName) {
            // 检查是否已存在（spec 中已声明）
            const existing2 = existing.procedures.find(p => p.name === procName.toLowerCase())
            const startLine = parseLine(obj.start)
            const endLine = parseLine(obj.stop)
            const lineRange = startLine && endLine ? [startLine, endLine] as [number, number] : undefined
            if (existing2) {
              // 更新行号范围（body 的更精确）+ loc
              if (lineRange) {
                existing2.lineRange = lineRange
                existing2.loc = lineRange[1] - lineRange[0] + 1
              }
              // spec 缺参数时用 body 补（body 签名最完整）
              if ((!existing2.params || existing2.params.length === 0)) {
                existing2.params = extractParams(obj)
              }
            } else {
              // body-only procedure（可能没有在 spec 中声明）
              existing.procedures.push({
                name: procName.toLowerCase(),
                type: procType,
                lineRange,
                loc: lineRange ? lineRange[1] - lineRange[0] + 1 : undefined,
                params: extractParams(obj),
                returnType: procType === "function" ? extractReturnType(obj) : null,
              })
            }
          }
        }
      }
    }
  }

  packages.set(pkgName, existing)
}

/** 提取独立 procedure/function */
/** 提取 package 级类型声明（RECORD / TABLE / VARRAY / REF CURSOR ...） */
function extractTypeDeclarations(scopeNode: ParsedNode): TypeIndex[] {
  const types: TypeIndex[] = []
  for (const td of collectByType(scopeNode, "Type_declarationContext")) {
    const name = firstIdentifierRaw(td)
    if (!name) continue
    let kind = "UNKNOWN"
    if (collectByType(td, "Record_type_defContext").length) kind = "RECORD"
    else if (collectByType(td, "Table_type_defContext").length) kind = "TABLE"
    else if (collectByType(td, "Varray_type_defContext").length) kind = "VARRAY"
    else if (collectByType(td, "Ref_cursor_typeContext").length
          || (td.nodes || []).some(c => /^REF$/i.test((c.text || "").trim()) && (td.nodes || []).some(d => /^CURSOR$/i.test((d.text || "").trim())))) kind = "REF CURSOR"
    types.push({ name, kind, definition: normalizeTypeText(subtreeText(td)) })
  }
  return types
}

/** 提取变量与常量声明（按 CONSTANT 关键字区分） */
function extractVariablesAndConstants(scopeNode: ParsedNode): { variables: VariableIndex[]; constants: ConstantIndex[] } {
  const variables: VariableIndex[] = []
  const constants: ConstantIndex[] = []
  for (const vd of collectByType(scopeNode, "Variable_declarationContext")) {
    const name = firstIdentifierRaw(vd)
    if (!name) continue
    const isConst = (vd.nodes || []).some(c => /^CONSTANT$/i.test((c.text || "").trim()))
    const typeSpec = collectByType(vd, "Type_specContext")[0]
    const type = typeSpec ? normalizeTypeText(subtreeText(typeSpec)) : "unknown"
    const expr = collectByType(vd, "ExpressionContext")[0]
    const valueText = expr ? normalizeTypeText(subtreeText(expr)) : null
    if (isConst) {
      constants.push({ name, type, value: valueText ?? "" })
    } else {
      variables.push({ name, type, defaultValue: valueText })
    }
  }
  return { variables, constants }
}

/** 提取独立 procedure/function（含参数 / 返回类型 / 行号） */
function extractStandaloneProc(
  node: ParsedNode,
  standaloneProcedures: StandaloneProcIndex[],
  relPath: string,
  type: "procedure" | "function",
): void {
  // 独立 CREATE PROCEDURE/FUNCTION 的结构：Create_procedure_bodyContext / Create_function_bodyContext
  // 直接含 Procedure_nameContext / Function_nameContext + ParameterContext + RETURN（无 *BodyContext 包装）。
  // 包内 procedure 则是 Procedure_bodyContext（由 extractPackageBody 处理，不进入此处）。
  const nameNode = collectByType(node, "Function_nameContext")[0]
    ?? collectByType(node, "Procedure_nameContext")[0]
  const name = nameNode ? (nameContextText(nameNode) ?? findIdentifierText(node)) : findIdentifierText(node)
  if (!name) return
  const startLine = parseLine(node.start)
  const endLine = parseLine(node.stop)
  standaloneProcedures.push({
    name: name.toLowerCase(),
    type,
    sourceFile: relPath,
    params: extractParams(node),
    returnType: type === "function" ? extractReturnType(node) : null,
    lineRange: startLine && endLine ? [startLine, endLine] : undefined,
  })
}

/** 提取表名 + 列定义（含 nullable / isPrimaryKey / defaultValue） */
function extractTable(node: ParsedNode, tables: TableIndex[], relPath: string): void {
  const name = extractTableName(node)
  if (!name) return
  const columns: ColumnIndex[] = []
  for (const col of collectByType(node, "Column_definitionContext")) {
    // 外联约束（CONSTRAINT/CHECK/PK/FK/UNIQUE）可能被归入 Column_definitionContext，
    // 按文本起始关键字排除；真正的列定义不以这些关键字开头。
    const colText = subtreeText(col)
    if (/^(CONSTRAINT|CHECK|PRIMARY|FOREIGN|UNIQUE)\b/i.test(colText)) continue
    const colNameNode = collectByType(col, "Column_nameContext")[0]
    const colName = firstIdentifierRaw(colNameNode)
    if (!colName) continue
    const direct = col.nodes || []
    // 类型：优先 DatatypeContext（原生），否则取直接子节点中的类型名标识符（UDT 列如 dim t_dimension）
    const dt = direct.find(c => c.type === "DatatypeContext")
    let oracleType = "unknown"
    if (dt) oracleType = normalizeTypeText(subtreeText(dt))
    else {
      const typeId = direct.find(c => c.type === "Regular_idContext" || c.type === "IdentifierContext")
      if (typeId) oracleType = (typeId.text || "").trim()
    }
    // DEFAULT：直接子节点 DEFAULT token 后的 ExpressionContext
    let defaultValue: string | null = null
    const defIdx = direct.findIndex(c => (c.text || "").trim().toUpperCase() === "DEFAULT")
    if (defIdx >= 0) {
      for (let i = defIdx + 1; i < direct.length; i++) {
        if (direct[i].type === "ExpressionContext") {
          defaultValue = normalizeTypeText(subtreeText(direct[i]))
          break
        }
      }
    }
    // 内联约束：NOT NULL / PRIMARY KEY
    const inlineText = collectByType(col, "Inline_constraintContext").map(subtreeText).join(" ")
    const notNull = /NOT\s+NULL/i.test(inlineText)
    const inlinePk = /PRIMARY\s+KEY/i.test(inlineText)
    columns.push({
      name: colName,
      oracleType,
      nullable: !(notNull || inlinePk),
      isPrimaryKey: inlinePk,
      defaultValue,
    })
  }
  // 外联约束：CONSTRAINT ... PRIMARY KEY (cols) → 标记对应列 isPrimaryKey
  const outOfLine = [
    ...collectByType(node, "Constraint_clauseContext"),
    ...collectByType(node, "Out_of_line_constraintContext"),
  ]
  const pkCols = new Set<string>()
  for (const con of outOfLine) {
    const txt = subtreeText(con)
    const pkMatch = txt.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i)
    if (pkMatch) {
      for (const c of pkMatch[1].split(",")) {
        const cn = c.trim()
        if (cn) pkCols.add(cn.toUpperCase())
      }
    }
  }
  if (pkCols.size > 0) {
    for (const col of columns) {
      if (pkCols.has(col.name.toUpperCase())) {
        col.isPrimaryKey = true
        col.nullable = false
      }
    }
  }
  tables.push({ name, ddlFile: relPath, columns })
}

/** 提取触发器（timing / level / events / targetTable / condition / 行号） */
function extractTrigger(node: ParsedNode, triggers: TriggerIndex[], relPath: string): void {
  const name = extractTriggerName(node)
  if (!name) return
  const txt = subtreeText(node)
  const startLine = parseLine(node.start)
  const endLine = parseLine(node.stop)
  let timing: string | undefined
  if (/\bBEFORE\b/i.test(txt)) timing = "before"
  else if (/\bAFTER\b/i.test(txt)) timing = "after"
  else if (/\bINSTEAD\s+OF\b/i.test(txt)) timing = "instead-of"
  const level = /\bFOR\s+EACH\s+ROW\b/i.test(txt) ? "row" : "statement"
  // 事件只在触发头部（timing 到 ON 之间）识别，避免误捕触发体里的 INSERT/UPDATE/DELETE
  const headerMatch = txt.match(/(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(.+?)\s+ON\s+/is)
  const header = headerMatch ? headerMatch[1] : ""
  const events: string[] = []
  if (/\bINSERT\b/i.test(header)) events.push("insert")
  if (/\bUPDATE\b/i.test(header)) events.push("update")
  if (/\bDELETE\b/i.test(header)) events.push("delete")
  const onMatch = txt.match(/\bON\s+(\w+)/i)
  const targetTable = onMatch ? onMatch[1].toUpperCase() : undefined
  const whenMatch = txt.match(/\bWHEN\s*\(([^)]*(?:\([^)]*\))*[^)]*)\)/i)
  // 规范化条件文本：'old . std_cost' → 'old.std_cost'
  const condition = whenMatch ? whenMatch[1].replace(/\s*\.\s*/g, ".").trim() : null
  triggers.push({
    name, sourceFile: relPath,
    timing, level, events,
    targetTable,
    lineRange: startLine && endLine ? [startLine, endLine] : undefined,
    condition,
  })
}

/** 提取视图名 + 列 + 依赖表（AST 视图结构不稳，回退到文本解析） */
function extractView(node: ParsedNode, views: ViewIndex[], relPath: string): void {
  const text = node.text || ""
  const match = text.match(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+(\w+)/i)
  if (!match) return
  const name = match[2].toUpperCase()
  // 列：SELECT 后到 FROM 之间的别名 / 列名（粗提取，够 inventory 用）
  const selMatch = text.match(/SELECT\s+(.*?)\s+FROM\s+/is)
  const columns: string[] = []
  if (selMatch) {
    for (const part of selMatch[1].split(",")) {
      const m = part.trim().match(/(\w+)\s*(?:\sAS\s*)?$/i)
      if (m && m[1] && !/^[a-z]+$|^(SELECT|FROM|WHERE|AS)$/i.test(m[1])) columns.push(m[1])
    }
  }
  // 依赖表：FROM/JOIN 后的表名
  const underlyingTables: string[] = []
  const tableRe = /(?:FROM|JOIN)\s+(\w+)/gi
  let tm: RegExpExecArray | null
  while ((tm = tableRe.exec(text)) !== null) {
    const t = tm[1].toUpperCase()
    if (!underlyingTables.includes(t)) underlyingTables.push(t)
  }
  views.push({ name, ddlFile: relPath, columns, underlyingTables })
}

/** 提取序列名 + 属性（startWith / incrementBy / min / max / cycle） */
function extractSequence(node: ParsedNode, sequences: SequenceIndex[], relPath: string): void {
  const name = extractSequenceName(node)
  if (!name) return
  const txt = subtreeText(node)
  const num = (re: RegExp): number | null => {
    const m = txt.match(re)
    return m ? parseInt(m[1], 10) : null
  }
  sequences.push({
    name, ddlFile: relPath,
    startWith: num(/START\s+WITH\s+(\d+)/i),
    incrementBy: num(/INCREMENT\s+BY\s+(\-?\d+)/i),
    minValue: num(/MINVALUE\s+(\-?\d+)/i),
    maxValue: num(/MAXVALUE\s+(\-?\d+)/i),
    cycle: /\bCYCLE\b/i.test(txt) && !/\bNOCYCLE\b/i.test(txt) ? true
      : /\bNOCYCLE\b/i.test(txt) ? false
      : null,
  })
}

// ── 文件类型分类 + 文本提取（避免对慢构造走 AST）──────────────────────────────

/**
 * 按文件内容（cheap regex）分类，决定走 AST 还是文本/regex。
 * 顺序敏感：body / trigger / view / type 先判，再 spec，最后通用 CREATE。
 * 注意：单文件混合多种 DDL 时，首个命中的慢类型胜出（其余被跳过）——
 * 建议项目按类型分文件存放（与 fixture 的 pkg/ schema/ trigger/ 目录约定一致）。
 */
function classifyFile(code: string): "body" | "trigger" | "view" | "type" | "spec" | "create" | "dml" {
  if (/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\b/i.test(code)) return "body"
  if (/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(code)) return "trigger"
  if (/CREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i.test(code)) return "view"
  if (/CREATE\s+(OR\s+REPLACE\s+)?TYPE\b/i.test(code)) return "type"
  if (/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\b/i.test(code)) return "spec"
  if (/\bCREATE\b/i.test(code)) return "create" // table / sequence / standalone proc/func
  return "dml" // 纯 DML / 匿名块 / SQL*Plus 脚本
}

/** 计算子串在全文中的起止行号（1-based） */
function lineRangeOf(code: string, startIdx: number, endIdx: number): [number, number] | undefined {
  if (startIdx < 0) return undefined
  const startLine = code.slice(0, startIdx).split("\n").length
  const endLine = code.slice(0, endIdx).split("\n").length
  return [startLine, endLine]
}

/** 从原始文本提取触发器元数据（不进 AST，避免解析触发体 SQL） */
export function extractTriggerFromText(code: string, triggers: TriggerIndex[], relPath: string): void {
  const m = code.match(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(\w+)/i)
  if (!m) return
  const name = m[2].toUpperCase()
  const startIdx = m.index ?? 0
  // 触发器结尾：最后一个 END; （大小写不敏感、词边界）。
  // 不用 lastIndexOf("END")——它是区分大小写的纯子串搜索：会漏掉小写 end;（PL/SQL 不区分大小写），
  // 也会误命中 PENDING/APPEND/SENDING 等含 "END" 子串的标识符，把 endIdx 推到真正的 END; 之后。
  // 词边界 \b 还可排除 MY_END 这类以下划线连写的标识符。\bEND\s*; 不会匹配 END IF; / END LOOP;。
  const txt = code.slice(startIdx)
  const endRe = /\bEND\s*;/gi
  let lastEnd: RegExpExecArray | null = null
  let em: RegExpExecArray | null
  while ((em = endRe.exec(txt)) !== null) lastEnd = em
  const endIdx = lastEnd ? startIdx + lastEnd.index + lastEnd[0].length : code.length
  let timing: string | undefined
  if (/\bBEFORE\b/i.test(txt)) timing = "before"
  else if (/\bAFTER\b/i.test(txt)) timing = "after"
  else if (/\bINSTEAD\s+OF\b/i.test(txt)) timing = "instead-of"
  const level = /\bFOR\s+EACH\s+ROW\b/i.test(txt) ? "row" : "statement"
  const headerMatch = txt.match(/(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(.+?)\s+ON\s+/is)
  const header = headerMatch ? headerMatch[1] : ""
  const events: string[] = []
  if (/\bINSERT\b/i.test(header)) events.push("insert")
  if (/\bUPDATE\b/i.test(header)) events.push("update")
  if (/\bDELETE\b/i.test(header)) events.push("delete")
  const onMatch = txt.match(/\bON\s+(\w+)/i)
  const targetTable = onMatch ? onMatch[1].toUpperCase() : undefined
  const whenMatch = txt.match(/\bWHEN\s*\(([^)]*(?:\([^)]*\))*[^)]*)\)/i)
  const condition = whenMatch ? whenMatch[1].replace(/\s*\.\s*/g, ".").trim() : null
  triggers.push({
    name, sourceFile: relPath,
    timing, level, events, targetTable,
    lineRange: lineRangeOf(code, startIdx, endIdx),
    condition,
  })
}

/** 从原始文本提取视图元数据（不进 AST，避免解析视图 SELECT） */
function extractViewFromText(code: string, views: ViewIndex[], relPath: string): void {
  const m = code.match(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+(\w+)\s+AS\b/is)
  if (!m) return
  const name = m[2].toUpperCase()
  const body = code.slice((m.index ?? 0) + m[0].length)
  // 列：SELECT 后到 FROM 之间的别名 / 列名（粗提取）
  const selMatch = body.match(/SELECT\s+(.*?)\s+FROM\s+/is)
  const columns: string[] = []
  if (selMatch) {
    for (const part of selMatch[1].split(",")) {
      const mm = part.trim().match(/(\w+)\s*(?:\sAS\s*)?$/i)
      if (mm && mm[1] && !/^(SELECT|FROM|WHERE|AS|AND|OR)$/i.test(mm[1])) columns.push(mm[1])
    }
  }
  // 依赖表：FROM/JOIN 后的表名
  const underlyingTables: string[] = []
  const tableRe = /(?:FROM|JOIN)\s+(\w+)/gi
  let tm: RegExpExecArray | null
  while ((tm = tableRe.exec(body)) !== null) {
    const t = tm[1].toUpperCase()
    if (!underlyingTables.includes(t)) underlyingTables.push(t)
  }
  views.push({ name, ddlFile: relPath, columns, underlyingTables })
}

/** 提取调用关系（PKG.PROC 模式，排除 :NEW/:OLD 绑定变量） */
function extractCallGraph(
  code: string,
  _relPath: string,
  callGraph: Record<string, string[]>,
): void {
  const sqlPseudo = new Set([
    "NEXTVAL", "CURRVAL", "COUNT", "EXISTS", "FIRST", "LAST",
    "ROWCOUNT", "FOUND", "NOTFOUND", "ISOPEN", "BULK_ROWCOUNT",
  ])

  const lines = code.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("--")) continue
    // 排除绑定变量上下文（:NEW.xxx, :OLD.xxx）
    const cleaned = trimmed.replace(/:[A-Z]+/gi, " ")
    const matches = cleaned.matchAll(/\b([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)\b/gi)
    for (const m of matches) {
      const pkg = m[1].toUpperCase()
      const proc = m[2].toUpperCase()
      if (sqlPseudo.has(proc)) continue
      if (pkg.length < 2 || proc.length < 2) continue
      const key = `${pkg}.${proc}`
      if (!callGraph[key]) callGraph[key] = []
    }
  }
}

// ── Regex 降级扫描 ──────────────────────────────────────────────────────────────

export function scanWithRegex(sourcePath: string): InventoryIndex {
  const files = collectSourceFiles(sourcePath)
  const packages = new Map<string, PackageIndex>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const callGraph: Record<string, string[]> = {}

  for (const filePath of files) {
    const code = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const relPath = relative(sourcePath, filePath)
    const ext = extname(filePath).toLowerCase()

    regexFallbackForFile(code, relPath, ext, packages, tables, triggers, views, sequences, standaloneProcedures, callGraph)
  }

  return {
    sourcePath,
    scannedAt: new Date().toISOString(),
    scannerUsed: "regex",
    packages: Array.from(packages.values()),
    tables,
    triggers,
    views,
    sequences,
    standaloneProcedures,
    callGraph: Object.keys(callGraph).length > 0 ? callGraph : undefined,
  }
}

/**
 * 对单个文件执行 regex 提取（AST 解析失败时降级，或 regex 模式直接使用）
 */
function regexFallbackForFile(
  code: string,
  relPath: string,
  ext: string,
  packages: Map<string, PackageIndex>,
  tables: TableIndex[],
  triggers: TriggerIndex[],
  views: ViewIndex[],
  sequences: SequenceIndex[],
  standaloneProcedures: StandaloneProcIndex[],
  callGraph: Record<string, string[]>,
): void {
  const lines = code.split("\n")

  if (ext === ".pks") {
    // Package spec
    const pkgName = regexExtract(/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+(\w+)/i, code, 2)
    if (pkgName) {
      const existing = packages.get(pkgName.toUpperCase()) ?? {
        name: pkgName.toUpperCase(),
        specFile: undefined,
        bodyFile: undefined,
        procedures: [],
        estimatedLoc: 0,
      }
      existing.specFile = relPath
      existing.estimatedLoc += lines.length

      // 提取 procedure/function 声明
      regexExtractProcedures(lines, existing)
      packages.set(pkgName.toUpperCase(), existing)
    }
  } else if (ext === ".pkb") {
    // Package body
    const pkgName = regexExtract(/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\s+(\w+)/i, code, 2)
    if (pkgName) {
      const existing = packages.get(pkgName.toUpperCase()) ?? {
        name: pkgName.toUpperCase(),
        specFile: undefined,
        bodyFile: undefined,
        procedures: [],
        estimatedLoc: 0,
      }
      existing.bodyFile = relPath
      existing.estimatedLoc += lines.length

      // 提取 procedure/function 实现（带行号）
      regexExtractProceduresFromBody(lines, existing)
      packages.set(pkgName.toUpperCase(), existing)
    }
  } else if (ext === ".sql") {
    // DDL 文件：table/trigger/view/sequence/standalone proc

    // CREATE TABLE
    for (const m of code.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)) {
      tables.push({ name: m[1].toUpperCase(), ddlFile: relPath })
    }

    // CREATE TRIGGER
    for (const m of code.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(\w+)/gi)) {
      triggers.push({ name: m[2].toUpperCase(), sourceFile: relPath })
    }

    // CREATE VIEW
    for (const m of code.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+(\w+)/gi)) {
      views.push({ name: m[2].toUpperCase(), ddlFile: relPath })
    }

    // CREATE SEQUENCE
    for (const m of code.matchAll(/CREATE\s+SEQUENCE\s+(\w+)/gi)) {
      sequences.push({ name: m[1].toUpperCase(), ddlFile: relPath })
    }

    // Standalone procedure/function（一个 .sql 文件可能定义多个，必须 matchAll 全量提取）
    for (const m of code.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+(\w+)/gi)) {
      standaloneProcedures.push({
        name: m[2].toLowerCase(),
        type: "procedure",
        sourceFile: relPath,
      })
    }
    for (const m of code.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/gi)) {
      standaloneProcedures.push({
        name: m[2].toLowerCase(),
        type: "function",
        sourceFile: relPath,
      })
    }

    // .sql 文件也可能是 package spec/body（某些项目规范）
    for (const pkgSpecMatch of code.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+(?!BODY\s+)(\w+)/gi)) {
      const name = pkgSpecMatch[2].toUpperCase()
      const existing = packages.get(name) ?? {
        name,
        specFile: undefined,
        bodyFile: undefined,
        procedures: [],
        estimatedLoc: 0,
      }
      existing.specFile = relPath
      existing.estimatedLoc += lines.length
      regexExtractProcedures(lines, existing)
      packages.set(name, existing)
    }
    for (const pkgBodyMatch of code.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\s+(\w+)/gi)) {
      const name = pkgBodyMatch[2].toUpperCase()
      const existing = packages.get(name) ?? {
        name,
        specFile: undefined,
        bodyFile: undefined,
        procedures: [],
        estimatedLoc: 0,
      }
      existing.bodyFile = relPath
      existing.estimatedLoc += lines.length
      regexExtractProceduresFromBody(lines, existing)
      packages.set(name, existing)
    }
  }

  // 提取调用关系（复用统一的 extractCallGraph）
  extractCallGraph(code, relPath, callGraph)
}

/** 正则提取辅助 */
function regexExtract(pattern: RegExp, text: string, group: number): string | null {
  const m = text.match(pattern)
  return m?.[group] ?? null
}

/** 从 spec 文件提取 procedure/function 声明（不重复添加已存在的） */
function regexExtractProcedures(lines: string[], pkg: PackageIndex): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const procMatch = line.match(/^\s*(PROCEDURE|FUNCTION)\s+(\w+)\s*\(/i)
    if (procMatch) {
      const name = procMatch[2].toLowerCase()
      const type: "procedure" | "function" = procMatch[1].toUpperCase() === "PROCEDURE" ? "procedure" : "function"
      // 只在不存在时添加（body 可能已先处理过）
      if (!pkg.procedures.find(p => p.name === name)) {
        pkg.procedures.push({ name, type, lineRange: [i + 1, i + 1] })
      }
    }
  }
}

/**
 * 剥离 PL/SQL 块注释（斜杠星 ... 星斜杠），保留换行以维持行号。
 * 单行内可能有多个注释、或注释跨行；非注释内容原样保留。
 * 不处理字符串字面量内的注释起始符（极少见；单引号字符串在 depth 计数时另行剥离）。
 */
function stripBlockComments(lines: string[]): string[] {
  let inBlock = false
  return lines.map(line => {
    let out = ""
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i)
        if (end === -1) return out
        inBlock = false
        i = end + 2
      } else {
        const start = line.indexOf("/*", i)
        if (start === -1) {
          out += line.slice(i)
          break
        }
        out += line.slice(i, start)
        i = start + 2
        inBlock = true
      }
    }
    return out
  })
}

/** 从 body 文件提取 procedure/function 实现及行号范围 */
function regexExtractProceduresFromBody(lines: string[], pkg: PackageIndex): void {
  // 预剥离跨行块注释，避免注释里的 BEGIN/END 污染 depth 计数导致过程边界错乱
  lines = stripBlockComments(lines)
  // 过程嵌套栈：PL/SQL 允许在过程内定义局部过程/函数。若用单一 currentProc，
  // 遇到内层 PROCEDURE 会提前关闭外层，导致外层 lineRange 截断在内层定义处、
  // 内层之后的代码丢失。改用栈，每帧带独立 depth：内层 BEGIN/END 只作用于栈顶，
  // 不会让外层误判结束。只有顶层过程（isTop=true）登记进 pkg.procedures；
  // 局部过程不单独登记，其代码包含在父过程 lineRange 内，下游切片得到完整外层过程。
  type Frame = { name: string; type: "procedure" | "function"; startLine: number; depth: number; isTop: boolean }
  const stack: Frame[] = []

  /**
   * 向后扫描检查是否包含 IS/AS（表示有实现体）。
   * 不设行数上限——超长参数列表可能跨越数十行，硬上限会让整个过程被跳过。
   * 遇到下一个 PROCEDURE/FUNCTION/END/CREATE 即判定为非实现体（纯声明）并停止。
   */
  function hasBodyKeyword(startIdx: number): boolean {
    let inTypeDecl = false  // 跟踪跨行 TYPE 声明
    for (let j = startIdx; j < lines.length; j++) {
      const l = lines[j].trim()
      if (l.startsWith("--")) continue
      // 跟踪跨行 TYPE 声明（TYPE xxx 开头但 IS/AS 在后续行）
      if (/^\s*TYPE\s+/i.test(l)) inTypeDecl = true
      // 检测到 IS 或 AS 关键字（排除 TYPE ... IS RECORD 等声明）
      if (/\b(IS|AS)\b/i.test(l)) {
        // 排除：同行有 TYPE 前缀，或处于跨行 TYPE 声明中，或 IS 后跟类型声明关键字
        if (/^\s*TYPE\s+/i.test(l)) continue
        if (inTypeDecl) { inTypeDecl = false; continue }
        if (/\bIS\s+(RECORD|TABLE|VARRAY|REF\s+CURSOR)\b/i.test(l)) continue
        if (/\bAS\s+(RECORD|TABLE|VARRAY|REF\s+CURSOR)\b/i.test(l)) continue
        inTypeDecl = false
        return true
      }
      // 非类型声明行出现其他内容，重置跟踪
      if (inTypeDecl && !/^\s*$/.test(l) && !/^\s*(IS|AS)\b/i.test(l)) {
        inTypeDecl = false
      }
      // 如果先遇到下一个 PROCEDURE/FUNCTION/END/CREATE 关键字，说明这不是实现体
      if (/^\s*(PROCEDURE|FUNCTION|END|CREATE)\b/i.test(l) && j > startIdx) return false
    }
    return false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith("--")) continue

    // 检测 procedure/function 开始（支持无参过程如 PROCEDURE init IS）
    const procMatch = line.match(/^\s*(PROCEDURE|FUNCTION)\s+(\w+)\s*[\(\w]/i)
    // 排除仅声明但无实现体的情况（如 TYPE ... IS RECORD）
    // 支持多行签名：IS/AS 可能在后续行（hasBodyKeyword 扫到下一个过程/END 为止）
    if (procMatch && !line.match(/^\s*--/)) {
      const hasIsOrAs = /\b(IS|AS)\b/i.test(line)
      const hasBodyElsewhere = !hasIsOrAs && hasBodyKeyword(i + 1)

      if (hasIsOrAs || hasBodyElsewhere) {
        const procType = procMatch[1].toUpperCase() === "PROCEDURE" ? "procedure" : "function"
        // 栈空 → 顶层过程；栈非空 → 局部过程（嵌套在父过程内，不单独登记）
        stack.push({
          name: procMatch[2].toLowerCase(),
          type: procType,
          startLine: i + 1,
          depth: 0,
          isTop: stack.length === 0,
        })
      }
    }

    // 追踪 BEGIN/END 深度来定位结束行（仅作用于栈顶过程）
    // 注意：END IF / END LOOP / END CASE 不是块结束，需要排除
    if (stack.length > 0) {
      const top = stack[stack.length - 1]
      // 移除字符串字面量和行内注释，避免误匹配 'END' / "BEGIN" 等
      const codeOnly = line.replace(/'[^']*'/g, "")   // 单引号字符串
        .replace(/--.*$/, "")                          // 行尾注释（前面已跳过纯注释行，但行内注释仍需处理）
      const begins = (codeOnly.match(/\bBEGIN\b/gi) || []).length
      // 排除 END IF / END LOOP / END CASE 等非块结束的 END
      const ends = (codeOnly.replace(/\bEND\s+(IF|LOOP|CASE)\b/gi, "").match(/\bEND\b/gi) || []).length
      top.depth += begins - ends
      // 仅当栈顶 depth 归零且该行含真实 END（排除 END IF/LOOP/CASE）时，栈顶过程结束
      if (top.depth === 0 && codeOnly.match(/\bEND\b/i) && !codeOnly.match(/\bEND\s+(IF|LOOP|CASE)\b/i)) {
        const frame = stack.pop()
        // 只有顶层过程登记 lineRange；局部过程的代码已包含在父过程 lineRange 内
        if (frame && frame.isTop) {
          updateProcedureLineRange(pkg, frame.name, frame.startLine, i + 1, frame.type)
        }
      } else if (top.depth < 0) {
        // 防御性重置：depth 不应为负（可能是未过滤的边缘情况），归零避免后续误判
        top.depth = 0
      }
    }
  }

  // 处理未关闭的顶层过程（文件结尾）
  for (const frame of stack) {
    if (frame.isTop) {
      updateProcedureLineRange(pkg, frame.name, frame.startLine, lines.length, frame.type)
    }
  }
}

/** 更新或添加 procedure 的行号范围（body 提取时使用，保留已有的 type） */
function updateProcedureLineRange(
  pkg: PackageIndex,
  procName: string,
  startLine: number,
  endLine: number,
  type?: "procedure" | "function",
): void {
  const existing = pkg.procedures.find(p => p.name === procName)
  if (existing) {
    existing.lineRange = [startLine, endLine]
  } else {
    pkg.procedures.push({ name: procName, type: type ?? "procedure", lineRange: [startLine, endLine] })
  }
}

/** regex 模式调用关系提取（复用 extractCallGraph） */

// ── 文件收集 ────────────────────────────────────────────────────────────────────

/** 收集目录下所有 PL/SQL 相关文件（.pks 在 .pkb 前，确保 spec 先处理） */
function collectSourceFiles(sourcePath: string): string[] {
  const extensions = new Set(VALID_SOURCE_EXTENSIONS)
  const files: string[] = []

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      // 跳过隐藏目录、node_modules
      // 跳过 schema-fetcher 自动生成的 ddl-output（需含 .generated 标记，用户同名目录不跳过）
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (entry.name === GENERATED_OUTPUT_DIR && entry.isDirectory()
          && existsSync(join(fullPath, GENERATED_MARKER))) continue
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }
  }

  if (!existsSync(sourcePath)) {
    throw new Error(`Source path does not exist: ${sourcePath}`)
  }
  walk(sourcePath)
  // .pks 在 .pkb 前：spec 先处理，body 后续更新行号
  return files.sort((a, b) => {
    const extA = extname(a).toLowerCase()
    const extB = extname(b).toLowerCase()
    if (extA === ".pks" && extB === ".pkb") return -1
    if (extA === ".pkb" && extB === ".pks") return 1
    return a.localeCompare(b)
  })
}

// ── 主入口 ──────────────────────────────────────────────────────────────────────

/**
 * 扫描 PL/SQL 源码目录，返回 inventory index。
 * 自动检测/安装 parser，失败则降级到 regex。
 */
export async function scanSource(sourcePath: string): Promise<InventoryIndex> {
  const hasParser = await ensureParser()
  if (hasParser) {
    try {
      return await scanWithAST(sourcePath)
    } catch (e) {
      // AST 扫描整体失败，降级到 regex
      getLogger().error("[plsql-scanner]", `AST scan failed, falling back to regex: ${e}`)
      return scanWithRegex(sourcePath)
    }
  }
  return scanWithRegex(sourcePath)
}
