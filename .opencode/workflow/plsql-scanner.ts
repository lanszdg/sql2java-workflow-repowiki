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
import { join, extname, sep } from "node:path"
import { GENERATED_OUTPUT_DIR, GENERATED_MARKER, VALID_SOURCE_EXTENSIONS } from "./constants"
import { getLogger } from "./workflow-logger"
import { parseMainEntry } from "./scope-computer"
import { PlSqlLexer } from "./plsql-ast/PlSqlLexer"
import { PlSqlParser } from "./plsql-ast/PlSqlParser"
import { PlSqlParserListener } from "./plsql-ast/PlSqlParserListener"
import type { Procedure_specContext, Function_specContext, Procedure_bodyContext, Function_bodyContext, Create_packageContext, Create_package_bodyContext, Create_function_bodyContext, Create_procedure_bodyContext, Variable_declarationContext, Exception_declarationContext, Type_declarationContext, Call_statementContext, Standard_functionContext, Routine_nameContext } from "./plsql-ast/PlSqlParser"
import { CharStreams, CommonTokenStream, Interval } from "antlr4ts"
import type { CharStream } from "antlr4ts/CharStream"
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

/** 跨包非调用引用（pkg.const / pkg.type / pkg.var）——不进 callGraph，仅聚合进 packageDependency，
 *  使 scope-computer 闭包能纳入「仅常量/类型被引用」的包（修复 const-only 包漏入闭包）。 */
export interface PackageRef {
  package: string
  name: string
  line: number
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
  packageRefs: PackageRef[]
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

/**
 * 大小写不敏感 CharStream 包装器。
 *
 * grammar 声明了 `caseInsensitive=true`，但 antlr4ts 4.7.2 不支持该选项（4.13+ 才有）——
 * 被忽略，生成的 lexer 大小写敏感（关键字 token 是大写 'CREATE' 等）。真实项目 PL/SQL 常用
 * 小写关键字（create/package/procedure），会解析失败。
 *
 * 解法：包装 CharStream，把 LA()（lookahead）返回的 a-z 转成 A-Z，让 lexer 按大写关键字匹配。
 * **只转 LA，不转 getText**——故字符串字面量 / 标识符 / 类型定义的原文大小写保留（通过
 * tokens.getText(sourceInterval) 取到原始文本），仅 token 匹配大小写不敏感。
 *
 * 注意：antlr4ts IntStream 的 `index` / `size` / `sourceName` 是 readonly **属性**（getter），
 * `consume`/`LA`/`mark`/`release`/`seek` 是方法——不能用方法形式实现 index/size，否则 lexer
 * 的 `this._input.index`（属性访问）取到方法函数，比较 `index < size` 变 NaN → 死循环。
 */
class UpperCaseCharStream implements CharStream {
  constructor(private readonly src: CharStream) {}
  LA(i: number): number {
    const c = this.src.LA(i)
    // a-z (0x61-0x7A) → A-Z；EOF(-1) 与其他字符不变
    if (c >= 0x61 && c <= 0x7a) return c - 0x20
    return c
  }
  getText(interval: Interval): string { return this.src.getText(interval) }
  consume(): void { this.src.consume() }
  mark(): number { return this.src.mark() }
  release(marker: number): void { this.src.release(marker) }
  seek(index: number): void { this.src.seek(index) }
  get index(): number { return this.src.index }
  get size(): number { return this.src.size }
  get sourceName(): string { return this.src.sourceName }
}

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
 * SQL*Plus 命令是客户端编排指令（prompt/@@/SET ECHO 等），只出现在 PL/SQL 单元之外的顶层
 * （install.sql / schema 脚本里）。**单元内不剥**——`SET col = val`（UPDATE SET）、`EXIT WHEN`
 * 是 PL/SQL，旧实现按行首关键字 `^SET\b`/`^EXIT\b` 误剥，导致 UPDATE 丢 SET 行 → 语法错误
 * → 错误恢复级联 → 漏捕获跨包引用。
 *
 * 单元边界：`CREATE [OR REPLACE] (PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE)` 起，独占一行的 `/`
 * （SQL*Plus 终止符）止。资源里单元均以 `/` 结尾。
 */
function stripSqlPlusCommands(code: string): string {
  // 仅剥离 grammar 不认的纯顶层 SQL*Plus 命令。grammar 认的（PROMPT/REM/@@/@/SET/EXIT/QUIT/
  // SHOW/TIMING/CLEAR）交给 antlr4 的 sql_plus_command 规则——由语法上下文区分 SQL*Plus 的 SET 与
  // PL/SQL 的 UPDATE SET、SQL*Plus 的 EXIT 与 PL/SQL 的 EXIT WHEN，无需 unitStart/unitEnd 单元边界
  // 判断。旧版用边界正则模拟这个区分，因不容忍 /*EDITIONABLE*/ 等内联注释而 inUnit 全程 false，
  // 误把单元内 EXIT WHEN / UPDATE SET 当 SQL*Plus 命令剥掉 → 语法断裂 → 后续子程序 bodyLocation=null。
  // 此处所列命令（SPOOL/DEFINE/...）从不出现在 PL/SQL 单元内，只按行首关键字 + 括号外判断即可。
  // 括号内不剥：CREATE TABLE 列定义里可能恰好是这些词作列名（括号深度跨行累积）。
  const sqlPlusLine = /^(SPOOL|DEFINE|UNDEFINE|VARIABLE|ACCEPT|WHENEVER|HOST|COLUMN|TTITLE|BTITLE|BREAK|COMPUTE)\b/i
  let parenDepth = 0
  return code
    .split("\n")
    .map(line => {
      const trimmed = line.trimStart()
      if (parenDepth === 0 && sqlPlusLine.test(trimmed)) {
        parenDepth += parenDelta(line)
        return ""
      }
      parenDepth += parenDelta(line)
      return line
    })
    .join("\n")
}

/** 单行括号深度增量（跳过单引号字符串内的括号，'' 视为转义引号） */
function parenDelta(line: string): number {
  let depth = 0
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      if (inStr && line[i + 1] === "'") { i++; continue }  // 转义引号 ''
      inStr = !inStr
    } else if (!inStr) {
      if (c === "(") depth++
      else if (c === ")") depth--
    }
  }
  return depth
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
  /** 嵌套局部过程（过程体内 declare_spec 递归定义）的槽位标记：不注册为包级，
   *  exit 时把其 directCalls/packageRefs 卷回外层后弹出，避免污染 subprograms/重载/callGraph。 */
  private readonly localSlots = new WeakSet<SubprogramInfo>()
  /** 包级声明栈深度：仅在栈空时收 package 级 constants/variables/types/exceptions */
  constructor(
    private readonly absolutePath: string,
    private readonly packages: Map<string, PackageInfo>,
    private readonly subprograms: Map<string, SubprogramInfo[]>,
    private readonly standaloneProcedures: StandaloneProcIndex[],
    private readonly standaloneSlots: SubprogramInfo[],
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
        packageRefs: [],
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
    this.enterSubprogramBody(name, "PROCEDURE", ctx, extractParams(ctx.parameter()), null)
  }
  enterFunction_body(ctx: Function_bodyContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.enterSubprogramBody(name, "FUNCTION", ctx, extractParams(ctx.parameter()), extractReturnType(ctx))
  }
  exitProcedure_body() { this.popSubprogramBody() }
  exitFunction_body() { this.popSubprogramBody() }

  /**
   * 进入子程序体。栈空 = 顶层包体子程序（与 spec 配对，注册为包级）；
   * 栈非空 = 嵌套局部过程（declare_spec 递归触发）——不注册（否则污染 subprograms/重载/callGraph），
   * 仅压局部槽位使体内调用归属正确，exit 时卷回外层。
   */
  private enterSubprogramBody(
    nameRaw: string, type: "PROCEDURE" | "FUNCTION",
    ctx: Procedure_bodyContext | Function_bodyContext,
    params: ParamInfo[], returnType: string | null,
  ): void {
    if (!this.currentPackage) return
    if (this.subprogramStack.length === 0) {
      this.registerSubprogram(nameRaw, type, true, ctx, params, returnType)
      return
    }
    const name = cleanName(nameRaw)
    const range = ctxLineRange(ctx)
    const slot: SubprogramInfo = {
      name, type,
      belongToPackage: this.currentPackage,
      overloadIndex: null,
      isPrivate: true,
      headerLocation: null,
      bodyLocation: range ? { absolutePath: this.absolutePath, lineRange: range } : null,
      parameters: params, returnType,
      loc: range ? range[1] - range[0] + 1 : 0,
      directCalls: [], packageRefs: [],
    }
    this.subprogramStack.push(slot)
    this.localSlots.add(slot)
  }

  /** 退出子程序体：局部槽位的调用卷回外层后弹出；包级槽位直接弹出。 */
  private popSubprogramBody(): void {
    const slot = this.subprogramStack.pop()
    if (slot && this.localSlots.has(slot)) {
      const outer = this.subprogramStack[this.subprogramStack.length - 1]
      if (outer) {
        outer.directCalls.push(...slot.directCalls)
        outer.packageRefs.push(...slot.packageRefs)
      }
      this.localSlots.delete(slot)
    }
  }

  // ── standalone CREATE PROCEDURE/FUNCTION（顶层，非包内）──────────────────────
  //   建子程序槽位并压 subprogramStack，使体内的 directCalls/packageRefs 被捕获（旧实现仅推
  //   standaloneProcedures 索引、不压栈，导致 enterCall_statement 等因栈空早退，standalone 体内调用全丢，
  //   injectStandaloneVirtualPackages 写死 directCalls:[]）。槽位与索引同序推入 standaloneSlots，
  //   由 injectStandaloneVirtualPackages 配对挂到虚拟包。
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
    this.pushStandaloneSlot(name, "FUNCTION", range)
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
    this.pushStandaloneSlot(name, "PROCEDURE", range)
  }
  exitCreate_function_body() { this.subprogramStack.pop() }
  exitCreate_procedure_body() { this.subprogramStack.pop() }

  /** 建 standalone 槽位并压栈（belongToPackage 占位，由 injectStandaloneVirtualPackages 回填虚拟包名） */
  private pushStandaloneSlot(name: string, type: "PROCEDURE" | "FUNCTION", range: [number, number] | null) {
    const slot: SubprogramInfo = {
      name, type,
      belongToPackage: "",  // 占位，injectStandaloneVirtualPackages 回填 __STANDALONE_x__
      overloadIndex: null,
      isPrivate: false,
      headerLocation: null,
      bodyLocation: range ? { absolutePath: this.absolutePath, lineRange: range } : null,
      parameters: [],
      returnType: null,
      loc: range ? range[1] - range[0] + 1 : 0,
      directCalls: [],
      packageRefs: [],
    }
    this.subprogramStack.push(slot)
    this.standaloneSlots.push(slot)
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

  // 用户函数调用（如 `v := get_item(p)` / `pkg.func(p)`）在 PL/SQL 表达式中走 general_element
  //（非 standard_function），standard_function 只覆盖 SQL 内建函数。监听 general_element 的 part，
  // 带 function_argument 的 part 即调用点：限定名 = 前置 part.id + 本 part.id。
  enterGeneral_element(ctx: any) {
    if (this.subprogramStack.length === 0) return
    const text = ctxText(ctx)
    // general_element 是递归规则（general_element ('.' general_element_part)+），
    // ctx.general_element_part() 只返回最末段，dotted 限定符在嵌套子节点——故用整体文本解析。
    // 统一用「去引号 + lastIndexOf('.')」拆限定名，与 refname.ts（pkgOf/refOf 单一真相源）及
    // recordCall 一致，正确处理 dotted 包名（fm.xxx）与 schema 限定（app.pkg）。
    const parenIdx = text.indexOf("(")
    if (parenIdx < 0) {
      // 非调用限定引用：pkg.const / pkg.type / pkg.var（表达式中的常量/类型/变量引用）。
      const cleaned = text.replace(/["`]/g, "")
      const lastDot = cleaned.lastIndexOf(".")
      if (lastDot <= 0) return  // 裸名变量引用，无包限定符
      this.recordPackageRef(cleaned.slice(0, lastDot), cleaned.slice(lastDot + 1), ctx.start.line)
      return
    }
    // 调用：限定名 = '(' 之前文本（含 pkg.func 形式）。直接传完整限定名给 recordCall（其内部按
    // lastIndexOf 拆 pkg/member、处理裸名归属 + SQL_PSEUDO + 自递归）。修复递归 grammar 导致
    // ctx.general_element_part() 只取末段、限定调用 pkg.func(args) 丢前缀被记成裸名遭后过滤丢弃的缺陷。
    const cleaned = text.slice(0, parenIdx).replace(/["`]/g, "")
    this.recordCall(cleaned, ctx.start.line, "function")
    // 限定调用的包限定符额外记 packageRef：覆盖「被调用成员非子程序」（类型构造 pkg.t_rec_type(...)、
    // 集合访问 pkg.g_array(i)）及 directCall 后过滤丢弃但包依赖仍应保留的情形。真实调用的
    // packageDependency 边与 directCall 重复，由 dependency-graph 聚合去重。
    const lastDot = cleaned.lastIndexOf(".")
    if (lastDot > 0) {
      this.recordPackageRef(cleaned.slice(0, lastDot), cleaned.slice(lastDot + 1), ctx.start.line)
    }
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

  /** 记录跨包非调用引用（pkg.const / pkg.type）。仅原始入栈，后过滤按已知包名收窄。 */
  private recordPackageRef(qualifier: string, name: string, line: number) {
    if (this.subprogramStack.length === 0) return
    const caller = this.subprogramStack[this.subprogramStack.length - 1]
    const pkg = cleanName(qualifier)
    const member = cleanName(name)
    if (pkg.length < 2 || member.length < 2) return
    if (pkg === "NEW" || pkg === "OLD") return
    caller.packageRefs.push({ package: pkg, name: member, line })
  }

  // 声明中的跨包类型引用（v_row const_pkg.t_rec; / p in other_pkg.t_rec）走 type_name，
  // 不进 general_element。捕获 dotted type_name，后过滤按已知包名收窄（原生类型走 datatype 不进 type_name；
  // table.col%TYPE 的 table 非包被过滤）。
  enterType_name(ctx: any) {
    if (this.subprogramStack.length === 0) return
    // 与 enterGeneral_element 一致：去引号 + lastIndexOf('.') 拆限定名，正确处理 dotted 包名
    // （fm.xxx.t_rec → 包限定符 fm.xxx）与 schema 限定。原生类型（NUMBER 等）走 datatype 不进此规则。
    const cleaned = ctxText(ctx).replace(/["`]/g, "")
    const lastDot = cleaned.lastIndexOf(".")
    if (lastDot <= 0) return  // 裸类型名，无包限定符
    this.recordPackageRef(cleaned.slice(0, lastDot), cleaned.slice(lastDot + 1), ctx.start.line)
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
  const standaloneSlots: SubprogramInfo[] = []
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
    parseFileAst(code, relPath, packages, subprograms, standaloneProcedures, standaloneSlots, warnings)
  }

  return finalizeInventoryIndex(primaryBase, packages, subprograms, standaloneProcedures, standaloneSlots, tables, triggers, views, sequences, warnings, "ast")
}

/**
 * 单文件 AST 解析：lex/parse/walk，把包结构累积进共享 Map。
 * scanWithAST（全量）与 scanSourceLazy（闭包 BFS）复用同一份每文件解析逻辑。
 * 失败不抛：收集 warning 跳过该文件（默认错误恢复，与原内联 try 行为一致）。
 */
function parseFileAst(
  code: string,
  relPath: string,
  packages: Map<string, PackageInfo>,
  subprograms: Map<string, SubprogramInfo[]>,
  standaloneProcedures: StandaloneProcIndex[],
  standaloneSlots: SubprogramInfo[],
  warnings: string[],
): void {
  try {
    const lex = new PlSqlLexer(new UpperCaseCharStream(CharStreams.fromString(code)))
    const tokens = new CommonTokenStream(lex)
    const parser = new PlSqlParser(tokens)
    // 默认错误恢复：不清空 error listener 的话默认 ConsoleErrorListener 会打印；
    // 挂一个收集 warning 的 listener，不抛。
    lex.removeErrorListeners()
    parser.removeErrorListeners()
    const tree = parser.sql_script()
    const listener = new PlSqlStructListener(relPath, packages, subprograms, standaloneProcedures, standaloneSlots, warnings, tokens)
    ParseTreeWalker.DEFAULT.walk(listener as any, tree)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    warnings.push(`AST 解析失败，跳过该文件的包结构: ${relPath} — ${msg}`)
    getLogger().warn("[plsql-scanner]", `AST 解析失败: ${relPath} — ${msg}`)
  }
}

/**
 * scanWithAST / scanSourceLazy 共用的后处理 + 装配 InventoryIndex：
 * 扁平化 subprograms + overloadIndex + standalone 虚拟包注入 + directCalls/packageRefs 后过滤去重
 * + 回填包 functions/procedures 名索引。
 * 在 lazy 模式下，subprograms 仅为闭包内子程序——后过滤按已知（闭包内）包名收窄，
 * out-of-closure 引用被丢弃，正是 scoped run 想要的行为。
 */
function finalizeInventoryIndex(
  primaryBase: string,
  packages: Map<string, PackageInfo>,
  subprograms: Map<string, SubprogramInfo[]>,
  standaloneProcedures: StandaloneProcIndex[],
  standaloneSlots: SubprogramInfo[],
  tables: TableIndex[],
  triggers: TriggerIndex[],
  views: ViewIndex[],
  sequences: SequenceIndex[],
  warnings: string[],
  scannerUsed: "ast" | "regex",
): InventoryIndex {
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
  injectStandaloneVirtualPackages(pkgList, subprogramList, standaloneProcedures, standaloneSlots)

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

  // packageRefs 后过滤 + 去重：只保留指向「已知项目包」的跨包引用（排除 localRecord.field /
  // schema.table.col / DBMS_OUTPUT 等外部限定）。已知包 = packages + standalone 虚拟包。
  // 同包引用不产生 packageDependency 边，丢弃。callGraph 不受影响。
  const knownPackages = new Set<string>()
  for (const p of pkgList) knownPackages.add(p.packageName.toUpperCase())
  for (const s of subprogramList) {
    const seen = new Set<string>()
    const filtered: PackageRef[] = []
    for (const r of s.packageRefs) {
      const pkg = r.package.toUpperCase()
      if (pkg === s.belongToPackage.toUpperCase()) continue  // 同包引用，无跨包边
      if (!knownPackages.has(pkg)) continue                  // 非已知项目包
      const key = `${pkg}.${r.name.toUpperCase()}.${r.line}`
      if (seen.has(key)) continue
      seen.add(key)
      filtered.push({ package: pkg, name: r.name.toUpperCase(), line: r.line })
    }
    s.packageRefs = filtered
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
    scannerUsed,
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
  standaloneSlots: SubprogramInfo[],
): void {
  // standaloneProcedures 与 standaloneSlots 同序（同一 enterCreate_*_body 推入），按索引配对。
  // 槽位的 directCalls/packageRefs 已在 AST walk 时压栈捕获；此处仅回填虚拟包名并推入列表。
  const existing = new Set(packages.map(p => p.packageName))
  for (let i = 0; i < standaloneProcedures.length; i++) {
    const s = standaloneProcedures[i]
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
    const slot = standaloneSlots[i]
    if (slot) {
      // 用 AST walk 已捕获 directCalls/packageRefs 的槽位（回填虚拟包名 + 索引字段）
      slot.belongToPackage = name
      slot.parameters = s.parameters ?? slot.parameters
      slot.returnType = s.returnType ?? slot.returnType
      subprograms.push(slot)
    } else {
      // 兜底（regex 路径无槽位）：建空槽位，directCalls 不可得
      subprograms.push({
        name: s.name, type: s.type, belongToPackage: name,
        overloadIndex: null, isPrivate: false,
        headerLocation: null,
        bodyLocation: range ? { absolutePath: s.sourceFile, lineRange: range } : null,
        parameters: s.parameters ?? [], returnType: s.returnType ?? null,
        loc: range ? range[1] - range[0] + 1 : 0,
        directCalls: [], packageRefs: [],
      })
    }
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
    // 剥 /* */ 块注释（多行注释替换为等量换行，保持行结构/行号），否则注释中间行
    // `col_more NUMBER */` 会被列正则 ^(\w+)\s+(.+)$ 误判为幻影列。-- 行注释由各行尾处理。
    const bodyNoComments = body.replace(/\/\*[\s\S]*?\*\//g, m => "\n".repeat((m.match(/\n/g) || []).length))
    const columns: ColumnIndex[] = []
    const pkCols = new Set<string>()
    const foreignKeys: ForeignKeyInfo[] = []
    // 列定义逐行解析：name + rest（rest = 类型 + 约束 DEFAULT/NOT NULL/PRIMARY KEY 等，到逗号或行尾）。
    // 旧 multiline 正则只消费到类型，NOT NULL 等约束不在 rest 内 → nullable 误判。
    for (const rawLine of bodyNoComments.split("\n")) {
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
    for (const fk of bodyNoComments.matchAll(/CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([\w.]+)\s*\(([^)]+)\)/gi)) {
      foreignKeys.push({
        name: cleanName(fk[1]),
        columns: fk[2].split(",").map(c => cleanName(c)),
        refTable: cleanName(fk[3]),
        refColumns: fk[4].split(",").map(c => cleanName(c)),
      })
    }
    // 外联主键
    for (const pk of bodyNoComments.matchAll(/CONSTRAINT\s+\w+\s+PRIMARY\s+KEY\s*\(([^)]+)\)/gi)) {
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

/** 计算存入 headerPath/bodyPath 的路径：在 primaryBase 下存相对（可移植），否则存绝对。
 *  Windows 文件系统大小写不敏感：用户传的 primaryBase 大小写可能与 readdirSync 返回的不一致
 *  （C:\Proj vs C:\proj），startsWith 区分大小写会误判为非子路径 → 存绝对路径，使 inventory.json
 *  路径风格部分相对部分绝对、跨平台不可移植。故 win32 下做大小写不敏感前缀匹配，存路径仍用原始大小写。 */
function storedFilePath(filePath: string, primaryBase: string): string {
  const prefix = primaryBase + sep
  const underPrimary = process.platform === "win32"
    ? filePath.toLowerCase().startsWith(prefix.toLowerCase())
    : filePath.startsWith(prefix)
  if (!underPrimary) return filePath
  // 剥前缀（保留 filePath 原始大小写），规范为 '/' 分隔跨平台可移植
  return filePath.slice(prefix.length).replace(/\\/g, "/")
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
  // primaryBase 优先 sourcePath：三路径(sourcePath+headerPath+bodyPath)时用它做相对路径基准，
  // 让 type/schema 等非包文件也存成可移植相对路径（TABLE/ITEM.sql 而非绝对路径）。
  const primaryBase = sourcePath ?? (twoDir ? headerPath! : (headerPath ?? bodyPath))
  if (!primaryBase) throw new Error("scanSource 需要 sourcePath 或 (headerPath + bodyPath)")
  // 双目录模式 header/body 优先（保 header-first）；同时给了 sourcePath 则追加为额外 root，
  // collectSourceFiles 递归扫到 type/schema 等非包 DDL，重复文件按绝对路径去重（processed 集合）。
  const roots = twoDir
    ? [headerPath!, bodyPath!, ...(sourcePath ? [sourcePath] : [])]
    : [primaryBase]

  if (entry) {
    // entry 全量扫描已被 scanSourceLazy 取代；保留参数向后兼容，忽略并 warning。
    getLogger().warn("[plsql-scanner]", `scanSource 收到 entry=${entry}，入口范围扫描请改用 scanSourceLazy；此处忽略，按全量扫描`)
  }

  try {
    return await scanWithAST(roots, primaryBase)
  } catch (e) {
    getLogger().error("[plsql-scanner]", `AST scan failed, falling back to regex: ${e}`)
    return scanWithRegex(roots, primaryBase)
  }
}

export type ScanSourceLazyOpts = { sourcePath?: string; headerPath?: string; bodyPath?: string; mainEntry: string }

/**
 * 入口闭包惰性扫描：只为 mainEntry 过程级入口的可达闭包解析包/子程序 artifact，
 * 避免大项目全量 antlr 解析（4M 行全量 ~40min → 闭包 30% ~13min）。
 *
 * - Phase 0（regex，不碰 antlr）：遍历全部源文件，建 `包名→文件` 完整映射 + 全量抽
 *   tables/triggers/views/sequences（DDL 不在包体，BFS 跟不到，须全量）。实测 ~1.2M lines/s。
 * - Phase 1（antlr BFS，文件粒度）：入口包文件入队 → 解析得 directCalls/packageRefs →
 *   跟限定名 `pkg.X` 查 Phase 0 映射找文件，未访问则解析，展开到队空。
 *   裸名 `proc(x)` 归同包不展开（跨包调用 PL/SQL 须限定，非回归）。
 *
 * 非过程级 mainEntry（包级/无点）/ 入口包不在源码 → 回退全量 scanSource 或硬失败。
 * 失败由调用方 catch 回退 scanSource（与 AST→regex 回退语义一致）。
 *
 * **闭包 ⊇ scope.scopePackages**：BFS 解析整入口包（所有子程序）的可达包，
 * ensureRunScope 的 computeClosure 在此部分产物上算 METHOD 闭包子集，一致无循环依赖。
 */
export async function scanSourceLazy(opts: ScanSourceLazyOpts): Promise<InventoryIndex> {
  const { sourcePath, headerPath, bodyPath, mainEntry } = opts
  const twoDir = !!(headerPath && bodyPath)
  // primaryBase 优先 sourcePath：三路径(sourcePath+headerPath+bodyPath)时用它做相对路径基准。
  const primaryBase = sourcePath ?? (twoDir ? headerPath! : (headerPath ?? bodyPath))
  if (!primaryBase) throw new Error("scanSourceLazy 需要 sourcePath 或 (headerPath + bodyPath)")
  // 双目录模式 header/body 优先（保 header-first）；同时给了 sourcePath 则追加为额外 root，
  // 让闭包扫描的 Phase 0 全量抽表也能覆盖到 sourcePath 下的 type/schema（重复文件去重）。
  const roots = twoDir
    ? [headerPath!, bodyPath!, ...(sourcePath ? [sourcePath] : [])]
    : [primaryBase]

  const parsed = parseMainEntry(mainEntry)
  if (!parsed) {
    // 非过程级（纯包名/无点）→ 无闭包概念，回退全量
    getLogger().warn("[plsql-scanner]", `scanSourceLazy: mainEntry=${mainEntry} 非过程级，回退全量 scanSource`)
    return scanSource({ sourcePath, headerPath, bodyPath })
  }
  const entryPkgUpper = parsed.pkg.toUpperCase()

  // ── Phase 0: regex 全量扫，建 包→文件 映射 + 全量抽 table/trigger/view/sequence ──
  const files = collectSourceFiles(roots)
  const packageFileMap = new Map<string, { files: string[] }>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const pkgDeclRe = /CREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+(BODY\s+)?([A-Za-z_][\w.]*)/gi
  // collectSourceFiles 不去重，双目录重叠时会返回重复文件 → 须按路径去重（与 scanWithAST 的 processed Set 一致）
  const seenFiles = new Set<string>()
  for (const filePath of files) {
    if (seenFiles.has(filePath)) continue
    seenFiles.add(filePath)
    const rawCode = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const relPath = storedFilePath(filePath, primaryBase)
    const code = stripSqlPlusCommands(rawCode)
    extractTableFromText(code, tables, relPath)
    extractTriggerFromText(code, triggers, relPath)
    extractViewFromText(code, views, relPath)
    extractSequenceFromText(code, sequences, relPath)
    for (const m of code.matchAll(pkgDeclRe)) {
      const name = cleanName(m[2])
      if (!name) continue
      let entry = packageFileMap.get(name)
      if (!entry) { entry = { files: [] }; packageFileMap.set(name, entry) }
      if (!entry.files.includes(filePath)) entry.files.push(filePath)
    }
  }

  const entryMap = packageFileMap.get(entryPkgUpper)
  if (!entryMap) {
    throw new Error(`scanSourceLazy: 入口包 ${parsed.pkg} 未在源码中找到 CREATE PACKAGE 声明（检查包名拼写 / 大小写 / mainEntry 格式）`)
  }

  // ── Phase 1: antlr BFS，文件粒度，只解析闭包内文件 ──
  const packages = new Map<string, PackageInfo>()
  const subprograms = new Map<string, SubprogramInfo[]>()
  const standaloneProcedures: StandaloneProcIndex[] = []
  const standaloneSlots: SubprogramInfo[] = []
  const warnings: string[] = [`lazy 扫描：仅解析入口 ${parsed.pkg}.${parsed.refName} 的可达闭包，out-of-closure 包未落盘`]
  const visited = new Set<string>()
  const queue: string[] = [...entryMap.files]
  while (queue.length > 0) {
    const filePath = queue.shift()!
    if (visited.has(filePath)) continue
    visited.add(filePath)
    const rawCode = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const code = stripSqlPlusCommands(rawCode)
    const relPath = storedFilePath(filePath, primaryBase)
    parseFileAst(code, relPath, packages, subprograms, standaloneProcedures, standaloneSlots, warnings)
    // 从已解析子程序的原始 directCalls/packageRefs 抽目标包，展开闭包。
    // directCalls/packageRefs 的 package 字段已 cleanName（大写），与 packageFileMap 键一致。
    // 每解析一个文件就扫全部子程序：直接调用边可能在 body 文件解析后才出现（spec 先入队时无 directCalls），
    // visited 去重避免重复解析；子程序遍历开销远小于 antlr，可接受。
    const targetPkgs = new Set<string>()
    for (const slots of subprograms.values()) {
      for (const s of slots) {
        const selfPkg = s.belongToPackage.toUpperCase()
        for (const c of s.directCalls) {
          const p = c.package.toUpperCase()
          if (p !== selfPkg) targetPkgs.add(p)
        }
        for (const r of s.packageRefs) {
          const p = r.package.toUpperCase()
          if (p !== selfPkg) targetPkgs.add(p)
        }
      }
    }
    for (const p of targetPkgs) {
      const em = packageFileMap.get(p)
      if (!em) continue  // 非项目包（SQL 内建 / 外部），跳过
      for (const f of em.files) if (!visited.has(f)) queue.push(f)
    }
  }

  return finalizeInventoryIndex(primaryBase, packages, subprograms, standaloneProcedures, standaloneSlots, tables, triggers, views, sequences, warnings, "ast")
}
