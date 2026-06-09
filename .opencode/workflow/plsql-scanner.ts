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

// ── 类型 ────────────────────────────────────────────────────────────────────────

export interface ProcedureIndex {
  name: string
  type: "procedure" | "function"
  lineRange?: [number, number]  // [startLine, endLine]
}

export interface PackageIndex {
  name: string
  specFile?: string
  bodyFile?: string
  procedures: ProcedureIndex[]
  estimatedLoc: number
}

export interface TableIndex {
  name: string
  ddlFile?: string
}

export interface TriggerIndex {
  name: string
  sourceFile: string
}

export interface ViewIndex {
  name: string
  ddlFile?: string
}

export interface SequenceIndex {
  name: string
  ddlFile?: string
}

export interface StandaloneProcIndex {
  name: string
  type: "procedure" | "function"
  sourceFile: string
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

  const files = collectSourceFiles(sourcePath)
  const packages = new Map<string, PackageIndex>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const callGraph: Record<string, string[]> = {}

  for (const filePath of files) {
    const code = readFileSync(filePath, "utf-8")
    const relPath = relative(sourcePath, filePath)
    const ext = extname(filePath).toLowerCase()

    try {
      const parser = getParserFromInput(code)
      const tree = parser.sql_script()
      const result = getParsedNodes(code, tree)

      // 遍历 AST 节点树：Sql_scriptContext → Unit_statementContext → 具体 statement
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

      // 提取调用关系（PKG.PROC 模式）
      extractCallGraph(code, relPath, callGraph)
    } catch {
      // 解析失败的单文件降级到 regex 提取
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
    return findIdentifierText(node)
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

/** 解析 "line:col" 格式的位置为行号 */
function parseLine(pos: string | null): number | null {
  if (!pos) return null
  return parseInt(pos.split(":")[0], 10) || null
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
  existing.estimatedLoc += node.text.split("\n").length

  // 提取 procedures 和 functions
  for (const child of node.nodes) {
    if (child.type === "Package_obj_specContext") {
      for (const obj of child.nodes) {
        if (obj.type === "Procedure_specContext") {
          const procName = findIdentifierText(obj)
          if (procName) {
            const startLine = parseLine(obj.start)
            const endLine = parseLine(obj.stop)
            existing.procedures.push({
              name: procName.toLowerCase(),
              type: "procedure",
              lineRange: startLine && endLine ? [startLine, endLine] : undefined,
            })
          }
        } else if (obj.type === "Function_specContext") {
          const funcName = findIdentifierText(obj)
          if (funcName) {
            const startLine = parseLine(obj.start)
            const endLine = parseLine(obj.stop)
            existing.procedures.push({
              name: funcName.toLowerCase(),
              type: "function",
              lineRange: startLine && endLine ? [startLine, endLine] : undefined,
            })
          }
        }
      }
    }
  }

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
  existing.estimatedLoc += node.text.split("\n").length

  // body 中可能有额外的 procedure/function 实现，补充行号
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
            if (existing2) {
              // 更新行号范围（body 的更精确）
              if (startLine && endLine) existing2.lineRange = [startLine, endLine]
            } else {
              // body-only procedure（可能没有在 spec 中声明）
              existing.procedures.push({
                name: procName.toLowerCase(),
                type: procType,
                lineRange: startLine && endLine ? [startLine, endLine] : undefined,
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
function extractStandaloneProc(
  node: ParsedNode,
  standaloneProcedures: StandaloneProcIndex[],
  relPath: string,
  type: "procedure" | "function",
): void {
  // 从 Create_procedure_bodyContext 或 Create_function_bodyContext 提取名称
  // 名称在 Procedure_bodyContext / Function_bodyContext 内
  for (const child of node.nodes) {
    if (child.type === "Procedure_bodyContext" || child.type === "Function_bodyContext") {
      const name = findIdentifierText(child)
      if (name) {
        standaloneProcedures.push({
          name: name.toLowerCase(),
          type,
          sourceFile: relPath,
        })
      }
    }
  }
}

/** 提取表名 */
function extractTable(node: ParsedNode, tables: TableIndex[], relPath: string): void {
  const name = extractTableName(node)
  if (name) {
    tables.push({ name, ddlFile: relPath })
  }
}

/** 提取触发器名 */
function extractTrigger(node: ParsedNode, triggers: TriggerIndex[], relPath: string): void {
  const name = extractTriggerName(node)
  if (name) {
    triggers.push({ name, sourceFile: relPath })
  }
}

/** 提取视图名（AST 模式下视图名 context 类型不确定，使用 regex 回退） */
function extractView(node: ParsedNode, views: ViewIndex[], relPath: string): void {
  const match = node.text.match(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+(\w+)/i)
  if (match) {
    views.push({ name: match[2].toUpperCase(), ddlFile: relPath })
  }
}

/** 提取序列名 */
function extractSequence(node: ParsedNode, sequences: SequenceIndex[], relPath: string): void {
  const name = extractSequenceName(node)
  if (name) {
    sequences.push({ name, ddlFile: relPath })
  }
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
    const code = readFileSync(filePath, "utf-8")
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
    const tableMatch = code.match(/CREATE\s+TABLE\s+(\w+)/i)
    if (tableMatch) {
      tables.push({ name: tableMatch[1].toUpperCase(), ddlFile: relPath })
    }

    // CREATE TRIGGER
    const triggerMatch = code.match(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(\w+)/i)
    if (triggerMatch) {
      triggers.push({ name: triggerMatch[2].toUpperCase(), sourceFile: relPath })
    }

    // CREATE VIEW
    const viewMatch = code.match(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+(\w+)/i)
    if (viewMatch) {
      views.push({ name: viewMatch[2].toUpperCase(), ddlFile: relPath })
    }

    // CREATE SEQUENCE
    const seqMatch = code.match(/CREATE\s+SEQUENCE\s+(\w+)/i)
    if (seqMatch) {
      sequences.push({ name: seqMatch[1].toUpperCase(), ddlFile: relPath })
    }

    // Standalone procedure/function
    const procMatch = code.match(/CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+(\w+)/i)
    if (procMatch) {
      standaloneProcedures.push({
        name: procMatch[2].toLowerCase(),
        type: "procedure",
        sourceFile: relPath,
      })
    }
    const funcMatch = code.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/i)
    if (funcMatch) {
      standaloneProcedures.push({
        name: funcMatch[2].toLowerCase(),
        type: "function",
        sourceFile: relPath,
      })
    }

    // .sql 文件也可能是 package spec/body（某些项目规范）
    const pkgSpecMatch = code.match(/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+(?!BODY\s+)(\w+)/i)
    if (pkgSpecMatch) {
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
    const pkgBodyMatch = code.match(/CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\s+(\w+)/i)
    if (pkgBodyMatch) {
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

/** 从 body 文件提取 procedure/function 实现及行号范围 */
function regexExtractProceduresFromBody(lines: string[], pkg: PackageIndex): void {
  let currentProc: { name: string; type: "procedure" | "function"; startLine: number } | null = null
  let depth = 0

  /** 向后搜索最多 maxLines 行，检查是否包含 IS/AS（表示有实现体） */
  function hasBodyKeyword(startIdx: number): boolean {
    const maxLines = 20
    let inTypeDecl = false  // 跟踪跨行 TYPE 声明
    for (let j = startIdx; j < Math.min(startIdx + maxLines, lines.length); j++) {
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
    // 支持多行签名：IS/AS 可能在后续行（最多 20 行内）
    if (procMatch && !line.match(/^\s*--/)) {
      const hasIsOrAs = /\b(IS|AS)\b/i.test(line)
      const hasBodyElsewhere = !hasIsOrAs && hasBodyKeyword(i + 1)

      if (hasIsOrAs || hasBodyElsewhere) {
        // 如果之前有未结束的 procedure，先关闭它
        if (currentProc) {
          updateProcedureLineRange(pkg, currentProc.name, currentProc.startLine, i)
        }
        const procType = procMatch[1].toUpperCase() === "PROCEDURE" ? "procedure" : "function"
        currentProc = {
          name: procMatch[2].toLowerCase(),
          type: procType,
          startLine: i + 1,
        }
        depth = 0
      }
    }

    // 追踪 BEGIN/END 深度来定位结束行
    // 注意：END IF / END LOOP / END CASE 不是块结束，需要排除
    if (currentProc) {
      // 移除字符串字面量和行内注释，避免误匹配 'END' / "BEGIN" 等
      const codeOnly = line.replace(/'[^']*'/g, "")   // 单引号字符串
        .replace(/--.*$/, "")                          // 行尾注释（前面已跳过纯注释行，但行内注释仍需处理）
      const begins = (codeOnly.match(/\bBEGIN\b/gi) || []).length
      // 排除 END IF / END LOOP / END CASE 等非块结束的 END
      const ends = (codeOnly.replace(/\bEND\s+(IF|LOOP|CASE)\b/gi, "").match(/\bEND\b/gi) || []).length
      depth += begins - ends
      // 仅当 depth 严格递减到 0 且原始行含真实 END（排除 END IF/LOOP/CASE）时关闭过程
      if (depth === 0 && codeOnly.match(/\bEND\b/i) && !codeOnly.match(/\bEND\s+(IF|LOOP|CASE)\b/i)) {
        updateProcedureLineRange(pkg, currentProc.name, currentProc.startLine, i + 1, currentProc.type)
        currentProc = null
        depth = 0
      } else if (depth < 0) {
        // 防御性重置：depth 不应为负（可能是未过滤的边缘情况），归零避免后续误判
        depth = 0
      }
    }
  }

  // 处理未关闭的（文件结尾）
  if (currentProc) {
    updateProcedureLineRange(pkg, currentProc.name, currentProc.startLine, lines.length, currentProc.type)
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
      console.error(`[plsql-scanner] AST scan failed, falling back to regex: ${e}`)
      return scanWithRegex(sourcePath)
    }
  }
  return scanWithRegex(sourcePath)
}
