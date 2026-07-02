/**
 * PL/SQL Structural Scanner — antlr4ts Listener 单遍 AST 抽取
 *
 * 在 inventory worker 第 0 步（workflow scan action）确定性扫描 PL/SQL 源码目录，产出 InventoryIndex。
 * 不依赖 LLM，不占用上下文窗口。运行态零 JDK（只用入库的生成 TS + antlr4ts 纯 TS 运行时）。
 *
 * 解析器：.opencode/workflow/plsql-ast/ 下 antlr4ts 生成的 PlSqlLexer/PlSqlParser + 手写基类。
 * 默认错误恢复（不设 BailErrorStrategy）容忍 grammar 缺口（FORALL SAVE EXCEPTIONS / FOR UPDATE OF 等），
 * body 不再降级 regex。
 *
 * 输出结构（新）：packages[]（包容器，procedures/functions 仅名字索引）+ subprograms[]（原子子程序，
 * 含 header/body 双定位 + per-method directCalls）+ tables[] + triggers[] + views[] + sequences[]。
 * standalone 过程注入为虚拟包。由 inventory-builder 落盘为 packages/+subprograms/+tables/+inventory.json。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, extname, relative, sep } from "node:path"
import { GENERATED_OUTPUT_DIR, GENERATED_MARKER, VALID_SOURCE_EXTENSIONS } from "./constants"
import { getLogger } from "./workflow-logger"
import { PlSqlLexer } from "./plsql-ast/PlSqlLexer"
import { PlSqlParser } from "./plsql-ast/PlSqlParser"
import { PlSqlParserListener } from "./plsql-ast/PlSqlParserListener"
import type { Procedure_specContext, Function_specContext, Procedure_bodyContext, Function_bodyContext, Create_packageContext, Create_package_bodyContext, Create_function_bodyContext, Create_procedure_bodyContext, Variable_declarationContext, Exception_declarationContext, Type_declarationContext, Call_statementContext, Standard_functionContext, Routine_nameContext } from "./plsql-ast/PlSqlParser"
import { CharStreams, CommonTokenStream, Interval } from "antlr4ts"
import { ParseTreeWalker } from "antlr4ts/tree/ParseTreeWalker"
import { ParserRuleContext } from "antlr4ts/ParserRuleContext"
import { TerminalNode } from "antlr4ts/tree/TerminalNode"
import { ErrorNode } from "antlr4ts/tree/ErrorNode"

// ── 类型 ────────────────────────────────────────────────────────────────────────

export interface ParamInfo {
  name: string
  type: string
  mode: "IN" | "OUT" | "IN OUT"
  defaultExpression: string | null
}

export interface LocationInfo {
  absolutePath: string
  lineRange: [number, number]
}

export interface DirectCall {
  package: string
  name: string
  line: number
  kind: "function" | "procedure"
}

export interface SubprogramInfo {
  name: string
  type: "PROCEDURE" | "FUNCTION"
  belongToPackage: string
  overloadIndex: number | null
  isPrivate: boolean
  headerLocation: LocationInfo | null
  bodyLocation: LocationInfo | null
  parameters: ParamInfo[]
  returnType: string | null
  loc: number
  directCalls: DirectCall[]
}

export interface ConstantInfo { name: string; type: string; value: string }
export interface VariableInfo { name: string; type: string; defaultValue: string | null }
export interface ExceptionInfo { name: string }
export interface TypeInfo { name: string; kind: string; definition: string }

export interface PackageInfo {
  packageName: string
  absolutePaths: string[]
  headerPath: string | null
  bodyPath: string | null
  constants: ConstantInfo[]
  variables: VariableInfo[]
  exceptions: ExceptionInfo[]
  types: TypeInfo[]
  functions: string[]
  procedures: string[]
  estimatedLoc: number
}

export interface ColumnIndex {
  name: string
  oracleType: string
  nullable: boolean
  isPrimaryKey: boolean
  defaultValue?: string | null
}
export interface ForeignKeyInfo { name: string; columns: string[]; refTable: string; refColumns: string[] }

export interface TableIndex {
  name: string
  ddlFile?: string
  columns?: ColumnIndex[]
  primaryKey?: string[]
  foreignKeys?: ForeignKeyInfo[]
}

export interface TriggerIndex {
  name: string; sourceFile: string
  timing?: string; level?: string; targetTable?: string; events?: string[]
  lineRange?: [number, number]; condition?: string | null
}
export interface ViewIndex { name: string; ddlFile?: string; columns?: string[]; underlyingTables?: string[] }
export interface SequenceIndex {
  name: string; ddlFile?: string
  startWith?: number | null; incrementBy?: number | null
  minValue?: number | null; maxValue?: number | null; cycle?: boolean | null
}
export interface StandaloneProcIndex {
  name: string; type: "PROCEDURE" | "FUNCTION"; sourceFile: string
  parameters?: ParamInfo[]; returnType?: string | null; lineRange?: [number, number]
}

export interface InventoryIndex {
  sourcePath: string
  scannedAt: string
  scannerUsed: "ast" | "regex"
  warnings: string[]
  packages: PackageInfo[]
  subprograms: SubprogramInfo[]
  tables: TableIndex[]
  triggers: TriggerIndex[]
  views: ViewIndex[]
  sequences: SequenceIndex[]
  standaloneProcedures: StandaloneProcIndex[]
}

// ── 通用辅助 ────────────────────────────────────────────────────────────────────

/** 规范化标识符：去引号、去空白、大写、保留点（包名 fm.xxx 的点编码子目录路径） */
function cleanName(name: string): string {
  return name.replace(/["`]/g, "").trim().toUpperCase()
}

/** 规范化类型文本：'VARCHAR2 ( 50 )' → 'VARCHAR2(50)'，'t_item %ROWTYPE' → 't_item%ROWTYPE' */
function normalizeTypeText(s: string): string {
  return s.replace(/\s*([(),%])\s*/g, "$1").replace(/\s+/g, " ").trim()
}

/** 取 ctx 的起止行号（1-based 闭区间）；stop 缺失时退化为 start */
function ctxLineRange(ctx: ParserRuleContext): [number, number] | null {
  const s = ctx.start?.line
  const e = ctx.stop?.line ?? s
  if (!s) return null
  return [s, e]
}

/** 取 ctx 原始文本（保留大小写，供类型/默认值等） */
function ctxText(ctx: ParserRuleContext | undefined | null): string {
  if (!ctx) return ""
  return ctx.text ?? ""
}

// ── SQL*Plus 命令预处理 ────────────────────────────────────────────────────────

/**
 * 剥离 SQL*Plus 专有命令，避免解析器报错。
 * SQL*Plus 命令是客户端编排指令（prompt/@@/SET 等），不含 PL/SQL 结构定义。
 */
function stripSqlPlusCommands(code: string): string {
  return code
    .split("\n")
    .map(line => {
      const trimmed = line.trimStart()
      if (/^prompt\b/i.test(trimmed)) return ""
      if (/^@@?\s?\S/i.test(trimmed)) return ""
      if (/^(SET|SPOOL|DEFINE|UNDEFINE|VARIABLE|ACCEPT|EXIT|QUIT|WHENEVER|HOST|COLUMN|TTITLE|BTITLE|BREAK|COMPUTE|REM|CLEAR)\b/i.test(trimmed)) return ""
      return line
    })
    .join("\n")
}

// ── AST Listener ─────────────────────────────────────────────────────────────────

/** SQL 伪列 / 内建函数，不计入 directCalls（后过滤会再按已知子程序收窄，此处快速排除常见 SQL 函数） */
const SQL_PSEUDO = new Set([
  "NEXTVAL", "CURRVAL", "COUNT", "EXISTS", "FIRST", "LAST",
  "ROWNUM", "ROWID", "LEVEL", "ROWTYPE", "TYPE",
  "ROWCOUNT", "FOUND", "NOTFOUND", "ISOPEN", "BULK_ROWCOUNT",
  "SUM", "AVG", "MIN", "MAX", "ROUND", "LEAST", "GREATEST",
  "SYSDATE", "SYSTIMESTAMP", "USER", "UID",
  "NVL", "NVL2", "COALESCE", "NULLIF", "DECODE", "CASE",
  "TO_CHAR", "TO_NUMBER", "TO_DATE", "TO_TIMESTAMP", "TO_CLOB",
  "SUBSTR", "INSTR", "LENGTH", "LENGTHB", "TRIM", "LTRIM", "RTRIM",
  "UPPER", "LOWER", "INITCAP", "REPLACE", "TRANSLATE", "LPAD", "RPAD",
  "MOD", "ABS", "POWER", "CEIL", "FLOOR", "SIGN", "TRUNC",
  "ADD_MONTHS", "MONTHS_BETWEEN", "LAST_DAY", "EXTRACT",
  "DBMS_OUTPUT", "SQLERRM", "SQLCODE",
])

/**
 * 单文件 Listener：把 PL/SQL 结构抽取到全局累加器（packages/subprograms）。
 * 跨文件 header/body 合并：subprograms 按 `PKG.METHOD` 键 + 重载顺序槽位合并 headerLocation/bodyLocation。
 */
class PlSqlStructListener implements PlSqlParserListener {
  /** 当前所处包名（大写带点）；spec/body 进入时置位，退出时清空 */
  private currentPackage: string | null = null
  /** 当前所处子程序栈（仅 body 压栈，用于 directCalls 归属 caller） */
  private subprogramStack: SubprogramInfo[] = []
  /** 包级声明栈深度：仅在栈空时收 package 级 constants/variables/types/exceptions */
  constructor(
    private readonly absolutePath: string,
    private readonly packages: Map<string, PackageInfo>,
    private readonly subprograms: Map<string, SubprogramInfo[]>,
    private readonly standaloneProcedures: StandaloneProcIndex[],
    private readonly warnings: string[],
    private readonly tokens: CommonTokenStream,
  ) {}

  /** 取 ctx 的原始文本（含空格）—— `ctx.text` 递归拼接子节点去空格，无法识别
   *  `IS RECORD`/`IS TABLE OF` 等多词关键字，故用 token stream 按 sourceInterval 取原文。 */
  private origText(ctx: ParserRuleContext | null | undefined): string {
    if (!ctx) return ""
    try {
      return this.tokens.getText(ctx.sourceInterval)
    } catch {
      return ctxText(ctx)
    }
  }

  // ── 包级 ────────────────────────────────────────────────────────────────────

  private getOrCreatePackage(fullName: string): PackageInfo {
    const name = cleanName(fullName)
    this.currentPackage = name
    let pkg = this.packages.get(name)
    if (!pkg) {
      pkg = {
        packageName: name,
        absolutePaths: [],
        headerPath: null,
        bodyPath: null,
        constants: [],
        variables: [],
        exceptions: [],
        types: [],
        functions: [],
        procedures: [],
        estimatedLoc: 0,
      }
      this.packages.set(name, pkg)
    }
    if (!pkg.absolutePaths.includes(this.absolutePath)) pkg.absolutePaths.push(this.absolutePath)
    return pkg
  }

  /** 从 create_package/body ctx 提取完整包名（schema.package，保留点） */
  private extractFullPackageName(ctx: Create_packageContext | Create_package_bodyContext): string | null {
    // package_name 在规则里被引用两次（PACKAGE 后 + END 后），antlr4ts 返回数组；取首个。
    const pns = ctx.package_name() as unknown
    const pnArr = Array.isArray(pns) ? pns : [pns]
    const name = pnArr[0]?.text
    if (!name) return null
    const schema = ctx.schema_object_name()?.text
    return schema ? `${schema}.${name}` : name
  }

  enterCreate_package(ctx: Create_packageContext) {
    const full = this.extractFullPackageName(ctx)
    if (!full) return
    const pkg = this.getOrCreatePackage(full)
    if (!pkg.headerPath) pkg.headerPath = this.absolutePath
    // 用原始含换行文本计 LOC（ctx.text 去空格无换行，恒 1 行/ctx）
    pkg.estimatedLoc += this.origText(ctx).split("\n").length
  }
  enterCreate_package_body(ctx: Create_package_bodyContext) {
    const full = this.extractFullPackageName(ctx)
    if (!full) return
    const pkg = this.getOrCreatePackage(full)
    if (!pkg.bodyPath) pkg.bodyPath = this.absolutePath
    pkg.estimatedLoc += this.origText(ctx).split("\n").length
  }
  exitCreate_package() { this.currentPackage = null }
  exitCreate_package_body() { this.currentPackage = null }

  // ── 子程序注册（spec=headerLocation, body=bodyLocation + 压栈）──────────────

  /**
   * 注册子程序：按 `PKG.METHOD` 键取槽位数组。
   *  - spec：找首个 headerLocation===null 的槽位填 headerLocation；无则新建槽位。
   *  - body：找首个 bodyLocation===null 的槽位填 bodyLocation；无则新建槽位（私有方法）。
   * 参数/返回类型：spec 优先（权威签名），body 仅在槽位无参数时补（私有方法）。
   */
  private registerSubprogram(
    nameRaw: string,
    type: "PROCEDURE" | "FUNCTION",
    isBody: boolean,
    ctx: Procedure_specContext | Function_specContext | Procedure_bodyContext | Function_bodyContext,
    params: ParamInfo[],
    returnType: string | null,
  ): SubprogramInfo | null {
    if (!this.currentPackage) return null
    const name = cleanName(nameRaw)
    const key = `${this.currentPackage}.${name}`
    const slots = this.subprograms.get(key) ?? []

    let slot: SubprogramInfo | undefined
    if (isBody) {
      slot = slots.find(s => s.bodyLocation === null)
    } else {
      slot = slots.find(s => s.headerLocation === null)
    }
    if (!slot) {
      slot = {
        name,
        type,
        belongToPackage: this.currentPackage,
        overloadIndex: null,            // 最终扁平化时按槽位数组长度决定
        isPrivate: false,
        headerLocation: null,
        bodyLocation: null,
        parameters: [],
        returnType: null,
        loc: 0,
        directCalls: [],
      }
      slots.push(slot)
      this.subprograms.set(key, slots)
    }
    const range = ctxLineRange(ctx)
    const loc: LocationInfo | null = range ? { absolutePath: this.absolutePath, lineRange: range } : null
    if (isBody) {
      if (loc) { slot.bodyLocation = loc; slot.loc = loc.lineRange[1] - loc.lineRange[0] + 1 }
      if (slot.parameters.length === 0 && params.length > 0) slot.parameters = params
      if (slot.returnType === null && returnType !== null) slot.returnType = returnType
      this.subprogramStack.push(slot)
    } else {
      if (loc) slot.headerLocation = loc
      // spec 是签名权威：覆盖参数/返回类型
      if (params.length > 0) slot.parameters = params
      if (type === "FUNCTION") slot.returnType = returnType
    }
    slot.isPrivate = slot.headerLocation === null
    return slot
  }

  enterProcedure_spec(ctx: Procedure_specContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.registerSubprogram(name, "PROCEDURE", false, ctx, extractParams(ctx.parameter()), null)
  }
  enterFunction_spec(ctx: Function_specContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.registerSubprogram(name, "FUNCTION", false, ctx, extractParams(ctx.parameter()), extractReturnType(ctx))
  }
  enterProcedure_body(ctx: Procedure_bodyContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.registerSubprogram(name, "PROCEDURE", true, ctx, extractParams(ctx.parameter()), null)
  }
  enterFunction_body(ctx: Function_bodyContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.registerSubprogram(name, "FUNCTION", true, ctx, extractParams(ctx.parameter()), extractReturnType(ctx))
  }
  exitProcedure_body() { this.subprogramStack.pop() }
  exitFunction_body() { this.subprogramStack.pop() }

  // ── standalone CREATE PROCEDURE/FUNCTION（顶层，非包内）──────────────────────
  enterCreate_function_body(ctx: Create_function_bodyContext) {
    const name = cleanName(ctx.function_name()?.text ?? "")
    if (!name) return
    const range = ctxLineRange(ctx)
    this.standaloneProcedures.push({
      name, type: "FUNCTION", sourceFile: this.absolutePath,
      parameters: extractParams(ctx.parameter()),
      returnType: normalizeTypeText(ctxText(ctx.type_spec())) || null,
      lineRange: range ?? undefined,
    })
  }
  enterCreate_procedure_body(ctx: Create_procedure_bodyContext) {
    const name = cleanName(ctx.procedure_name()?.text ?? "")
    if (!name) return
    const range = ctxLineRange(ctx)
    this.standaloneProcedures.push({
      name, type: "PROCEDURE", sourceFile: this.absolutePath,
      parameters: extractParams(ctx.parameter()),
      returnType: null,
      lineRange: range ?? undefined,
    })
  }

  // ── 包级声明（仅在 subprogramStack 为空时收，避免收进过程局部变量）─────────

  enterVariable_declaration(ctx: Variable_declarationContext) {
    if (!this.currentPackage || this.subprogramStack.length > 0) return
    const pkg = this.packages.get(this.currentPackage)!
    const name = cleanName(ctx.identifier()?.text ?? "")
    if (!name) return
    const isConst = !!ctx.CONSTANT()
    const type = normalizeTypeText(ctxText(ctx.type_spec())) || "unknown"
    const defaultExpr = ctx.default_value_part()?.expression()
    const valueText = defaultExpr ? normalizeTypeText(ctxText(defaultExpr)) : null
    if (isConst) {
      pkg.constants.push({ name, type, value: valueText ?? "" })
    } else {
      pkg.variables.push({ name, type, defaultValue: valueText })
    }
  }

  enterException_declaration(ctx: Exception_declarationContext) {
    if (!this.currentPackage || this.subprogramStack.length > 0) return
    const pkg = this.packages.get(this.currentPackage)!
    const name = cleanName(ctx.identifier()?.text ?? "")
    if (name) pkg.exceptions.push({ name })
  }

  enterType_declaration(ctx: Type_declarationContext) {
    if (!this.currentPackage || this.subprogramStack.length > 0) return
    const pkg = this.packages.get(this.currentPackage)!
    const name = cleanName(ctx.identifier()?.text ?? "")
    if (!name) return
    // 用原始含空格文本识别 kind（ctx.text 去空格会让 "IS RECORD" 变 "ISRECORD" 漏匹配）
    const def = this.origText(ctx)
    let kind = "UNKNOWN"
    if (/IS\s+RECORD/i.test(def)) kind = "RECORD"
    else if (/IS\s+TABLE\s+OF/i.test(def)) kind = "TABLE"
    else if (/IS\s+VARRAY/i.test(def) || /VARRAY/i.test(def)) kind = "VARRAY"
    else if (/IS\s+REF\s+CURSOR/i.test(def) || /REF\s+CURSOR/i.test(def)) kind = "REF CURSOR"
    pkg.types.push({ name, kind, definition: normalizeTypeText(def) })
  }

  // ── directCalls（caller 栈非空时记）────────────────────────────────────────

  enterCall_statement(ctx: Call_statementContext) {
    if (this.subprogramStack.length === 0) return
    // call_statement: CALL? routine_name function_argument? ('.' routine_name function_argument?)* ...
    // routine_name 被引用多次，antlr4ts 返回数组；join 所有 routine_name 文本得完整限定名。
    const rns = ctx.routine_name() as unknown
    const rnArr = Array.isArray(rns) ? rns : [rns]
    const parts = rnArr.map(rn => rn?.text).filter(Boolean)
    if (parts.length === 0) return
    this.recordCall(parts.join("."), ctx.start.line, "procedure")
  }
  enterStandard_function(ctx: Standard_functionContext) {
    if (this.subprogramStack.length === 0) return
    // standard_function 文本形如 'pkg.func(args)' 或 'func(args)'；正则取前置限定名
    const m = ctxText(ctx).match(/^([A-Za-z_][\w.]*)\s*\(/)
    if (!m) return
    this.recordCall(m[1], ctx.start.line, "function")
  }

  private recordCallFromRoutine(_rn: Routine_nameContext | undefined, _line: number, _kind: "function" | "procedure") {
    // 保留签名兼容；实际 directCalls 经 enterCall_statement / enterStandard_function 走 recordCall
  }

  /** 把限定名拆为 package + name；裸名归属调用方所属包；排除 SQL 伪列与自递归 */
  private recordCall(qualified: string, line: number, kind: "function" | "procedure") {
    if (this.subprogramStack.length === 0) return
    const caller = this.subprogramStack[this.subprogramStack.length - 1]
    const cleaned = qualified.replace(/["`]/g, "")
    const lastDot = cleaned.lastIndexOf(".")
    let pkg: string
    let method: string
    if (lastDot > 0) {
      pkg = cleanName(cleaned.slice(0, lastDot))
      method = cleanName(cleaned.slice(lastDot + 1))
    } else {
      pkg = caller.belongToPackage
      method = cleanName(cleaned)
    }
    if (method.length < 2 || SQL_PSEUDO.has(method)) return
    // 排除 :NEW/:OLD 绑定变量上下文（routine_name 不会匹配，但防 :NEW.X 误入）
    if (pkg === "NEW" || pkg === "OLD") return
    if (pkg === caller.belongToPackage && method === caller.name) return // 自递归
    caller.directCalls.push({ package: pkg, name: method, line, kind })
  }

  // ParseTreeListener 必需的 4 个 no-op
  enterEveryRule() {}
  exitEveryRule() {}
  visitTerminal() {}
  visitErrorNode() {}
}

// ── 参数 / 返回类型抽取 ─────────────────────────────────────────────────────────

/** 从 ParameterContext[] 抽参数（name/type/mode/defaultExpression） */
function extractParams(params: ParameterContext[]): ParamInfo[] {
  const out: ParamInfo[] = []
  for (const p of params) {
    const name = cleanName(p.parameter_name()?.text ?? p.text ?? "")
    if (!name) continue
    const type = normalizeTypeText(ctxText(p.type_spec())) || "unknown"
    // antlr4ts 生成的 IN()/OUT()/INOUT() 返回 TerminalNode[]——空数组 [] 在 JS 中是 truthy，
    // 须用 .length > 0 判定（旧实现 !!p.OUT() 恒 true，导致所有参数 mode 误判为 "IN OUT"）。
    // grammar: parameter_name (IN | OUT | INOUT | NOCOPY)* type_spec? —— INOUT 单 token 等同 IN OUT。
    const inout = p.INOUT().length > 0
    const hasIn = p.IN().length > 0 || inout
    const hasOut = p.OUT().length > 0 || inout
    let mode: ParamInfo["mode"]
    if (hasIn && hasOut) mode = "IN OUT"
    else if (hasOut) mode = "OUT"
    else mode = "IN"
    const expr = p.default_value_part()?.expression()
    const defaultExpression = expr ? normalizeTypeText(ctxText(expr)) : null
    out.push({ name, type, mode, defaultExpression })
  }
  return out
}

/** 从 function spec/body ctx 取 RETURN 后的返回类型（第一个 type_spec） */
function extractReturnType(ctx: Function_specContext | Function_bodyContext): string | null {
  // RETURN type_spec ... —— 取 ctx 内的 type_spec（function spec/body 含一个 type_spec 为返回类型）
  const ts = ctx.type_spec()
  if (ts) return normalizeTypeText(ctxText(ts)) || null
  return null
}

// ── AST 扫描主流程 ──────────────────────────────────────────────────────────────

/**
 * 用 antlr4ts listener 扫描源码目录，产出 InventoryIndex。
 * 逐文件解析，packages/subprograms 在全局 Map 中跨文件合并。
 */
export async function scanWithAST(roots: string[], primaryBase: string): Promise<InventoryIndex> {
  const files = collectSourceFiles(roots)
  const packages = new Map<string, PackageInfo>()
  const subprograms = new Map<string, SubprogramInfo[]>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const warnings: string[] = []
  const processed = new Set<string>()  // 按绝对路径去重，防多根重叠导致重复扫描

  for (const filePath of files) {
    if (processed.has(filePath)) continue
    processed.add(filePath)
    const rawCode = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const relPath = storedFilePath(filePath, primaryBase)
    const code = stripSqlPlusCommands(rawCode)

    // table/trigger/view/sequence 仍走文本提取（与包结构无关，不在痛点范围）
    extractTableFromText(code, tables, relPath)
    extractTriggerFromText(code, triggers, relPath)
    extractViewFromText(code, views, relPath)
    extractSequenceFromText(code, sequences, relPath)

    // 包/子程序/独立过程走 AST
    try {
      const lex = new PlSqlLexer(CharStreams.fromString(code))
      const tokens = new CommonTokenStream(lex)
      const parser = new PlSqlParser(tokens)
      // 默认错误恢复：不清空 error listener 的话默认 ConsoleErrorListener 会打印；
      // 挂一个收集 warning 的 listener，不抛。
      lex.removeErrorListeners()
      parser.removeErrorListeners()
      const tree = parser.sql_script()
      const listener = new PlSqlStructListener(relPath, packages, subprograms, standaloneProcedures, warnings, tokens)
      ParseTreeWalker.DEFAULT.walk(listener as any, tree)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      warnings.push(`AST 解析失败，跳过该文件的包结构: ${relPath} — ${msg}`)
      getLogger().warn("[plsql-scanner]", `AST 解析失败: ${relPath} — ${msg}`)
    }
  }

  // 扁平化 subprograms，赋 overloadIndex（同名>1 才标序）
  const subprogramList: SubprogramInfo[] = []
  for (const slots of subprograms.values()) {
    if (slots.length > 1) {
      slots.forEach((s, i) => { s.overloadIndex = i + 1 })
    }
    subprogramList.push(...slots)
  }

  // standalone 虚拟包注入（在 directCalls 后过滤前，使调用 standalone 的边被保留）
  const pkgList = Array.from(packages.values())
  injectStandaloneVirtualPackages(pkgList, subprogramList, standaloneProcedures)

  // directCalls 后过滤 + 去重：只保留指向已知子程序的调用（排除 SQL 内建函数 / 外部包 / 误捕）。
  // 建索引：PKG -> Set<METHOD>（大写），用于校验 callee 是否落在本项目子程序集合内。
  const subprogramIndex = new Map<string, Set<string>>()
  for (const s of subprogramList) {
    let set = subprogramIndex.get(s.belongToPackage)
    if (!set) { set = new Set(); subprogramIndex.set(s.belongToPackage, set) }
    set.add(s.name)
  }
  for (const s of subprogramList) {
    const seen = new Set<string>()
    const filtered: DirectCall[] = []
    for (const c of s.directCalls) {
      const methods = subprogramIndex.get(c.package)
      if (!methods || !methods.has(c.name)) continue  // callee 非本项目子程序，丢弃
      const key = `${c.package}.${c.name}.${c.line}`
      if (seen.has(key)) continue
      seen.add(key)
      filtered.push(c)
    }
    s.directCalls = filtered
  }

  // 回填包的 functions/procedures 名字索引（去重，保序）
  for (const pkg of pkgList) {
    const seenProc = new Set<string>()
    const seenFunc = new Set<string>()
    for (const s of subprogramList) {
      if (s.belongToPackage !== pkg.packageName) continue
      if (s.type === "FUNCTION") {
        if (!seenFunc.has(s.name)) { seenFunc.add(s.name); pkg.functions.push(s.name) }
      } else {
        if (!seenProc.has(s.name)) { seenProc.add(s.name); pkg.procedures.push(s.name) }
      }
    }
  }

  return {
    sourcePath: primaryBase,
    scannedAt: new Date().toISOString(),
    scannerUsed: "ast",
    warnings,
    packages: pkgList,
    subprograms: subprogramList,
    tables,
    triggers,
    views,
    sequences,
    standaloneProcedures,
  }
}

// ── standalone 虚拟包注入 ──────────────────────────────────────────────────────

/**
 * standalone CREATE PROCEDURE/FUNCTION 自成虚拟包（__STANDALONE_X__），其子程序落入 subprograms。
 * 保留 standaloneProcedures 数组供 metrics 兼容。
 */
function injectStandaloneVirtualPackages(
  packages: PackageInfo[],
  subprograms: SubprogramInfo[],
  standaloneProcedures: StandaloneProcIndex[],
): void {
  // standalone 从 subprograms 里那些 belongToPackage 为虚拟包的项识别——但 standalone 此处尚未建。
  // 简化：standalone 由 scanWithRegex/AST 单独收集（见 collectStandaloneFromText），这里仅注入虚拟包壳。
  const existing = new Set(packages.map(p => p.packageName))
  for (const s of standaloneProcedures) {
    const vname = `__STANDALONE_${s.name}__`
    let name = vname
    let n = 2
    while (existing.has(name)) { name = `${vname.slice(0, -2)}_${n}__`; n++ }
    existing.add(name)
    const range = s.lineRange
    packages.push({
      packageName: name,
      absolutePaths: [s.sourceFile],
      headerPath: null,
      bodyPath: s.sourceFile,
      constants: [], variables: [], exceptions: [], types: [],
      functions: [],
      procedures: [],
      estimatedLoc: range ? range[1] - range[0] + 1 : 0,
    })
    subprograms.push({
      name: s.name,
      type: s.type,
      belongToPackage: name,
      overloadIndex: null,
      isPrivate: false,
      headerLocation: null,
      bodyLocation: range ? { absolutePath: s.sourceFile, lineRange: range } : null,
      parameters: s.parameters ?? [],
      returnType: s.returnType ?? null,
      loc: range ? range[1] - range[0] + 1 : 0,
      directCalls: [],
    })
  }
}

// ── 表 / 触发器 / 视图 / 序列 文本提取（保留现有实现）────────────────────────────

/** 计算子串在全文中的起止行号（1-based） */
function lineRangeOf(code: string, startIdx: number, endIdx: number): [number, number] | undefined {
  if (startIdx < 0) return undefined
  const startLine = code.slice(0, startIdx).split("\n").length
  const endLine = code.slice(0, endIdx).split("\n").length
  return [startLine, endLine]
}

/** 从文本提取表 + 列 + 主键 + 外键 */
function extractTableFromText(code: string, tables: TableIndex[], relPath: string): void {
  for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+([\w.]+)/gi)) {
    const name = cleanName(m[1])
    const startIdx = m.index ?? 0
    // 表体到匹配的 ')' —— 简化：取到下一个 '\n/\n' 或下一个 CREATE 前
    const bodyEnd = nextStatementBoundary(code, startIdx)
    const fullBody = code.slice(startIdx, bodyEnd)
    // 列定义从表头的 '(' 之后开始——否则首行 "CREATE TABLE T_ITEM (" 会被列正则误匹配为
    // 列名 CREATE / 类型 TABLE（旧实现 body 从 CREATE 起切，首列产出垃圾 "CREATE"）。
    const parenIdx = fullBody.indexOf("(")
    const body = parenIdx >= 0 ? fullBody.slice(parenIdx + 1) : fullBody
    const columns: ColumnIndex[] = []
    const pkCols = new Set<string>()
    const foreignKeys: ForeignKeyInfo[] = []
    // 列定义逐行解析：name + rest（rest = 类型 + 约束 DEFAULT/NOT NULL/PRIMARY KEY 等，到逗号或行尾）。
    // 旧 multiline 正则只消费到类型，NOT NULL 等约束不在 rest 内 → nullable 误判。
    for (const rawLine of body.split("\n")) {
      const trimmed = rawLine.trim().replace(/,\s*$/, "")
      if (!trimmed) continue
      // 跳过外联约束行（CONSTRAINT / PRIMARY KEY ... 单独行）
      if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|KEY|NOT|NULL)\b/i.test(trimmed)) continue
      const m = trimmed.match(/^(\w+)\s+(.+)$/)
      if (!m) continue
      const colName = cleanName(m[1])
      if (!colName) continue
      const rest = m[2].trim()  // "VARCHAR2(40) NOT NULL" / "NUMBER(20,6) DEFAULT 0" / "t_dimension"
      // 类型 = 首个 token（含括号精度），去尾逗号（UDT 列无约束时 rest 即 "t_dimension,"）
      const typeMatch = rest.match(/^([\w(),.]+)/)
      const type = normalizeTypeText((typeMatch ? typeMatch[1] : rest).replace(/,\s*$/, ""))
      const notNull = /\bNOT\s+NULL\b/i.test(rest)
      const inlinePk = /\bPRIMARY\s+KEY\b/i.test(rest)
      // DEFAULT 值在 NOT NULL / 行尾前截断（避免吞下 "DEFAULT 'RAW' NOT NULL" 的 NOT NULL）
      const defMatch = rest.match(/DEFAULT\s+([^,]*?)(?:\s+NOT\s+NULL\b|\s*$)/i)
      columns.push({
        name: colName,
        oracleType: type,
        nullable: !(notNull || inlinePk),
        isPrimaryKey: inlinePk,
        defaultValue: defMatch ? normalizeTypeText(defMatch[1]) : null,
      })
      if (inlinePk) pkCols.add(colName)
    }
    // 外联约束
    for (const fk of body.matchAll(/CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([\w.]+)\s*\(([^)]+)\)/gi)) {
      foreignKeys.push({
        name: cleanName(fk[1]),
        columns: fk[2].split(",").map(c => cleanName(c)),
        refTable: cleanName(fk[3]),
        refColumns: fk[4].split(",").map(c => cleanName(c)),
      })
    }
    // 外联主键
    for (const pk of body.matchAll(/CONSTRAINT\s+\w+\s+PRIMARY\s+KEY\s*\(([^)]+)\)/gi)) {
      for (const c of pk[1].split(",")) pkCols.add(cleanName(c))
    }
    if (pkCols.size > 0) {
      for (const col of columns) if (pkCols.has(col.name)) { col.isPrimaryKey = true; col.nullable = false }
    }
    tables.push({
      name,
      ddlFile: relPath,
      columns,
      primaryKey: pkCols.size > 0 ? Array.from(pkCols) : undefined,
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
    })
  }
}

/** 找下一个语句边界（粗：下一个行首 CREATE 或文件末） */
function nextStatementBoundary(code: string, from: number): number {
  const re = /\n\s*(CREATE|CREATE OR REPLACE)\b/gi
  re.lastIndex = from + 1
  const m = re.exec(code)
  return m ? m.index : code.length
}

/** 从原始文本提取触发器元数据 */
export function extractTriggerFromText(code: string, triggers: TriggerIndex[], relPath: string): void {
  const m = code.match(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+([\w.]+)/i)
  if (!m) return
  const name = cleanName(m[2])
  const startIdx = m.index ?? 0
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
  const onMatch = txt.match(/\bON\s+([\w.]+)/i)
  const targetTable = onMatch ? cleanName(onMatch[1]) : undefined
  const whenMatch = txt.match(/\bWHEN\s*\(([^)]*(?:\([^)]*\))*[^)]*)\)/i)
  const condition = whenMatch ? whenMatch[1].replace(/\s*\.\s*/g, ".").trim() : null
  triggers.push({
    name, sourceFile: relPath,
    timing, level, events, targetTable,
    lineRange: lineRangeOf(code, startIdx, endIdx),
    condition,
  })
}

/** 从原始文本提取视图元数据 */
function extractViewFromText(code: string, views: ViewIndex[], relPath: string): void {
  const m = code.match(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+([\w.]+)\s+AS\b/is)
  if (!m) return
  const name = cleanName(m[2])
  const body = code.slice((m.index ?? 0) + m[0].length)
  const selMatch = body.match(/SELECT\s+(.*?)\s+FROM\s+/is)
  const columns: string[] = []
  if (selMatch) {
    for (const part of selMatch[1].split(",")) {
      const mm = part.trim().match(/(\w+)\s*(?:\sAS\s*)?$/i)
      if (mm && mm[1] && !/^(SELECT|FROM|WHERE|AS|AND|OR)$/i.test(mm[1])) columns.push(mm[1])
    }
  }
  const underlyingTables: string[] = []
  const tableRe = /(?:FROM|JOIN)\s+([\w.]+)/gi
  let tm: RegExpExecArray | null
  while ((tm = tableRe.exec(body)) !== null) {
    const t = cleanName(tm[1])
    if (!underlyingTables.includes(t)) underlyingTables.push(t)
  }
  views.push({ name, ddlFile: relPath, columns, underlyingTables })
}

/** 从原始文本提取序列属性 */
function extractSequenceFromText(code: string, sequences: SequenceIndex[], relPath: string): void {
  for (const m of code.matchAll(/CREATE\s+SEQUENCE\s+([\w.]+)/gi)) {
    const name = cleanName(m[1])
    const startIdx = m.index ?? 0
    const txt = code.slice(startIdx, nextStatementBoundary(code, startIdx))
    const num = (re: RegExp): number | null => { const x = txt.match(re); return x ? parseInt(x[1], 10) : null }
    sequences.push({
      name, ddlFile: relPath,
      startWith: num(/START\s+WITH\s+(\d+)/i),
      incrementBy: num(/INCREMENT\s+BY\s+(\-?\d+)/i),
      minValue: num(/MINVALUE\s+(\-?\d+)/i),
      maxValue: num(/MAXVALUE\s+(\-?\d+)/i),
      cycle: /\bCYCLE\b/i.test(txt) && !/\bNOCYCLE\b/i.test(txt) ? true
        : /\bNOCYCLE\b/i.test(txt) ? false : null,
    })
  }
}

// ── 文件收集 ────────────────────────────────────────────────────────────────────

/** 计算存入 headerPath/bodyPath 的路径：在 primaryBase 下存相对（可移植），否则存绝对。 */
function storedFilePath(filePath: string, primaryBase: string): string {
  return filePath.startsWith(primaryBase + sep) ? relative(primaryBase, filePath) : filePath
}

/** 收集多根目录下所有 PL/SQL 文件，root 顺序为主键，root 内 .pks→.pkb→名。 */
function collectSourceFiles(roots: string[]): string[] {
  const extensions = new Set(VALID_SOURCE_EXTENSIONS)
  const tagged: { rootIdx: number; path: string }[] = []
  function walk(dir: string, rootIdx: number): void {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (entry.name === GENERATED_OUTPUT_DIR && entry.isDirectory()
          && existsSync(join(fullPath, GENERATED_MARKER))) continue
      if (entry.isDirectory()) walk(fullPath, rootIdx)
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        tagged.push({ rootIdx, path: fullPath })
      }
    }
  }
  roots.forEach((root, idx) => {
    if (!existsSync(root)) throw new Error(`Source path does not exist: ${root}`)
    walk(root, idx)
  })
  return tagged.sort((a, b) => {
    if (a.rootIdx !== b.rootIdx) return a.rootIdx - b.rootIdx
    const extA = extname(a.path).toLowerCase()
    const extB = extname(b.path).toLowerCase()
    if (extA === ".pks" && extB === ".pkb") return -1
    if (extA === ".pkb" && extB === ".pks") return 1
    return a.path.localeCompare(b.path)
  }).map(t => t.path)
}

// ── Regex 兜底（parser 完全不可用时）──────────────────────────────────────────

/** 极简 regex 扫描，仅当 AST 路径整体不可用时兜底。 */
export function scanWithRegex(roots: string[], primaryBase: string): InventoryIndex {
  const files = collectSourceFiles(roots)
  const packages = new Map<string, PackageInfo>()
  const subprograms = new Map<string, SubprogramInfo[]>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const warnings: string[] = ["regex 兜底模式：仅提取名字，结构字段缺失"]

  for (const filePath of files) {
    const code = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const relPath = storedFilePath(filePath, primaryBase)
    extractTableFromText(code, tables, relPath)
    extractTriggerFromText(code, triggers, relPath)
    extractViewFromText(code, views, relPath)
    extractSequenceFromText(code, sequences, relPath)
    // regex 兜底只粗提包名/过程名
    for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(?:BODY\s+)?([\w.]+)/gi)) {
      const name = cleanName(m[1])
      if (!packages.has(name)) {
        packages.set(name, {
          packageName: name, absolutePaths: [relPath], headerPath: relPath, bodyPath: relPath,
          constants: [], variables: [], exceptions: [], types: [], functions: [], procedures: [], estimatedLoc: 0,
        })
      }
    }
  }
  return {
    sourcePath: primaryBase,
    scannedAt: new Date().toISOString(),
    scannerUsed: "regex",
    warnings,
    packages: Array.from(packages.values()),
    subprograms: [],
    tables, triggers, views, sequences, standaloneProcedures,
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────────

export type ScanSourceOpts = { sourcePath?: string; headerPath?: string; bodyPath?: string; entry?: string }

/**
 * 扫描 PL/SQL 源码目录，返回 inventory index。
 * 单目录：scanSource(sourcePath) / scanSource({ sourcePath })。
 * 双目录：scanSource({ headerPath, bodyPath }) —— headerPath 先于 bodyPath 处理。
 * entry（PKG.METHOD）：入口范围扫描（Phase 2.5，暂未实现，传入则忽略并 warning）。
 */
export async function scanSource(sourceOrOpts: string | ScanSourceOpts): Promise<InventoryIndex> {
  const opts = typeof sourceOrOpts === "string" ? { sourcePath: sourceOrOpts } : sourceOrOpts
  const { sourcePath, headerPath, bodyPath, entry } = opts
  const twoDir = !!(headerPath && bodyPath)
  const primaryBase = twoDir ? headerPath! : (sourcePath ?? headerPath ?? bodyPath)
  if (!primaryBase) throw new Error("scanSource 需要 sourcePath 或 (headerPath + bodyPath)")
  const roots = twoDir ? [headerPath!, bodyPath!] : [primaryBase]

  if (entry) {
    // Phase 2.5 入口范围扫描尚未实现；当前退化为全量 + warning
    getLogger().warn("[plsql-scanner]", `entry=${entry} 入口范围扫描尚未实现，退化为全量扫描`)
  }

  try {
    return await scanWithAST(roots, primaryBase)
  } catch (e) {
    getLogger().error("[plsql-scanner]", `AST scan failed, falling back to regex: ${e}`)
    return scanWithRegex(roots, primaryBase)
  }
}
