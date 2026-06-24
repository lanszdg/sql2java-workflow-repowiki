/**
 * Analysis Builder — 把 prescan 的 inventory-index.json（结构全字段）转换为
 * 下游 analysis.json（依赖图 meta）+ 无子程序包的空 analysis-packages。
 *
 * 这是 analyze map-reduce 的 **reduce**（代码，零 LLM），归入 inventory 阶段：
 *   - callGraph：按子程序 lineRange 扫描源码 `PKG.PROC` 调用 → caller→callee 真实边，
 *     callee 用 refName 规范解析（非重载裸名；重载 grep 无法消歧→过近似全部变体）。
 *   - packageDependency：从 callGraph 聚合包级依赖（排除自环）。
 *   - translationOrder + sccGroups：包级依赖图上跑 Tarjan SCC，输出拓扑序（依赖在前）。
 *   - complexity：启发式（LOC + 子程序数 + 出边数 + 模式 grep）→ score/riskLevel/patterns。
 *
 * 产出过 AnalysisMetaSchema / AnalysisPackageSchema Zod 校验。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { AnalysisMetaSchema, AnalysisPackageSchema } from "./artifact-schemas"
import { formatZodIssues } from "./engine-core"
import { refNamesForPackage, pkgOf } from "./refname"
import { getLogger } from "./workflow-logger"

// ── prescan inventory-index.json 形态（宽松读取）──
interface PrescanProc { name: string; type: string; lineRange?: [number, number] }
interface PrescanPackage {
  name: string
  specFile?: string
  bodyFile?: string
  procedures: PrescanProc[]
  estimatedLoc?: number
}
interface PrescanIndex {
  sourcePath: string
  packages: PrescanPackage[]
}

interface SubprogramInfo {
  name: string
  refName: string
  type: "procedure" | "function"
  lineRange?: [number, number]
}

// SQL 伪列 / 绑定变量排除（与 plsql-scanner extractCallGraph 一致）
const SQL_PSEUDO = new Set([
  "NEXTVAL", "CURRVAL", "COUNT", "EXISTS", "FIRST", "LAST",
  "ROWCOUNT", "FOUND", "NOTFOUND", "ISOPEN", "BULK_ROWCOUNT",
  "SQL", "DBMS", "UTL", "SQLERRM", "SQLCODE",
])

interface CallSite { line: number; calleePkg: string; calleeProc: string }

/** 读源码文件（specFile/bodyFile 相对 sourcePath） */
function readSource(sourcePath: string, rel?: string): string {
  if (!rel) return ""
  const abs = isAbsolute(rel) ? rel : join(sourcePath, rel)
  if (!existsSync(abs)) return ""
  return readFileSync(abs, "utf-8").replace(/\r\n?/g, "\n")
}

/** 构建 refName 索引：同名仅 1 次→裸名；同名多次→`{name}__{i}`（1-based，全部带序号）。
 *  refName 计算复用 refname.ts 单一真相源 refNamesForPackage，保证与 engine-core
 *  validateCrossSchema 的 validRefNameSet 口径一致（PL/SQL 不区分大小写，按大写计数重载）。 */
export function buildRefNameIndex(pkgs: PrescanPackage[]): Map<string, {
  subprograms: SubprogramInfo[]
  procNameToRefNames: Map<string, string[]>
}> {
  const result = new Map<string, { subprograms: SubprogramInfo[]; procNameToRefNames: Map<string, string[]> }>()
  for (const pkg of pkgs) {
    const refNames = refNamesForPackage(pkg.procedures.map((p) => p.name))
    const subprograms: SubprogramInfo[] = pkg.procedures.map((p, i) => ({
      name: p.name,
      refName: refNames[i],
      type: (p.type?.toLowerCase() === "function" ? "function" : "procedure") as "procedure" | "function",
      lineRange: p.lineRange,
    }))
    const procNameToRefNames = new Map<string, string[]>()
    for (const s of subprograms) {
      const key = s.name.toUpperCase()
      const arr = procNameToRefNames.get(key) ?? []
      arr.push(s.refName)
      procNameToRefNames.set(key, arr)
    }
    result.set(pkg.name, { subprograms, procNameToRefNames })
  }
  return result
}

/** 扫描源码中的 `PKG.PROC` 调用点（排除注释 / 绑定变量 / 伪列），带行号 */
function scanCallSites(code: string): CallSite[] {
  const sites: CallSite[] = []
  const lines = code.split("\n")
  lines.forEach((rawLine, i) => {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith("--")) return
    // 排除 :NEW/:OLD 绑定变量
    const cleaned = trimmed.replace(/:[A-Z]+/gi, " ")
    const matches = cleaned.matchAll(/\b([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)\b/gi)
    for (const m of matches) {
      const calleePkg = m[1].toUpperCase()
      const calleeProc = m[2].toUpperCase()
      if (SQL_PSEUDO.has(calleePkg) || SQL_PSEUDO.has(calleeProc)) continue
      if (calleePkg.length < 2 || calleeProc.length < 2) continue
      sites.push({ line: i + 1, calleePkg, calleeProc })
    }
  })
  return sites
}

/** 找包含指定行的最内层子程序（lineRange 最小者） */
function findCallerSubprogram(subprograms: SubprogramInfo[], line: number): SubprogramInfo | null {
  let best: SubprogramInfo | null = null
  let bestSpan = Infinity
  for (const s of subprograms) {
    if (!s.lineRange) continue
    const [a, b] = s.lineRange
    if (line >= a && line <= b) {
      const span = b - a
      if (span < bestSpan) { bestSpan = span; best = s }
    }
  }
  return best
}

/** 解析 callee 的 refName 列表：PROC 须是 calleePkg 的子程序；重载→全部变体；否则跳过 */
function resolveCalleeRefNames(
  calleePkg: string,
  calleeProc: string,
  refIndex: Map<string, { procNameToRefNames: Map<string, string[]> }>,
): string[] | null {
  const pkgInfo = refIndex.get(calleePkg)
  if (!pkgInfo) return null // callee 包不在 inventory（外部/系统包），跳过
  const refNames = pkgInfo.procNameToRefNames.get(calleeProc)
  if (!refNames) return null // callee 不是子程序（常量/变量/类型），跳过
  return refNames.map(r => `${calleePkg}.${r}`)
}

/**
 * Tarjan SCC（递归）。图边 A→B 表示 A 依赖 B。
 * 输出 SCC 列表，顺序为 **依赖在前**（B 的 SCC 先于 A 的 SCC 输出）→ 直接作 translationOrder。
 */
export function tarjanSCC(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let order = 0
  const sccs: string[][] = []

  function strongconnect(v: string): void {
    index.set(v, order)
    lowlink.set(v, order)
    order++
    stack.push(v)
    onStack.add(v)
    const succs = edges.get(v) ?? new Set()
    for (const w of succs) {
      if (!index.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!))
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      sccs.push(comp)
    }
  }

  for (const v of nodes) {
    if (!index.has(v)) strongconnect(v)
  }
  return sccs
}

/**
 * 计算 FUNCTION 属主归属（同包内，确定性）。见 plan「FUNCTION 属主归属」。
 *
 * 对每个 FUNCTION f，在**同包**子程序 callGraph 上反向 BFS，收集能（经 function→function 链）
 * 调用 f 的 PROCEDURE 及其最短调用距离；owner = 距离最近者，并列取 refName 字典序最小。
 * 无任何 PROCEDURE 可达 → f 为孤儿（不在返回 map 中，自身作为独立 unit）。
 * 跨包调用不建立属主（仅同包边参与反向可达）。
 *
 * @returns ownership: `PKG.funcRef` → `PKG.ownerProcRef`（仅被拥有的 FUNCTION）
 */
export function assignFunctionOwnership(
  callGraph: Record<string, string[]>,
  refIndex: Map<string, { subprograms: SubprogramInfo[]; procNameToRefNames: Map<string, string[]> }>,
): Map<string, string> {
  const ownership = new Map<string, string>()

  for (const [pkg, info] of refIndex) {
    // 同包子程序类型表 + 同包反向邻接（predecessors）
    const typeOf = new Map<string, "procedure" | "function">()
    const reverse = new Map<string, string[]>() // callee(full) → [caller(full), ...] 同包
    for (const s of info.subprograms) {
      const full = `${pkg}.${s.refName}`
      typeOf.set(full, s.type)
      reverse.set(full, [])
    }
    for (const [s, callees] of Object.entries(callGraph)) {
      if (pkgOf(s) !== pkg) continue
      for (const t of callees) {
        if (pkgOf(t) !== pkg) continue // 跨包边不参与同包属主
        const arr = reverse.get(t)
        if (arr) arr.push(s)
      }
    }

    // 每个 FUNCTION 反向 BFS 找可达 PROCEDURE
    for (const s of info.subprograms) {
      if (s.type !== "function") continue
      const f = `${pkg}.${s.refName}`
      // BFS（无权图首达即最短）
      const dist = new Map<string, number>([[f, 0]])
      const queue: string[] = [f]
      let head = 0
      while (head < queue.length) {
        const cur = queue[head++]
        for (const pred of reverse.get(cur) ?? []) {
          if (!dist.has(pred)) {
            dist.set(pred, dist.get(cur)! + 1)
            queue.push(pred)
          }
        }
      }
      // 收集可达 PROCEDURE（distance, refName）
      let best: { ref: string; dist: number } | null = null
      for (const [node, d] of dist) {
        if (typeOf.get(node) !== "procedure") continue
        const cand = { ref: node, dist: d }
        if (best === null ||
            cand.dist < best.dist ||
            (cand.dist === best.dist && cand.ref < best.ref)) {
          best = cand
        }
      }
      if (best) ownership.set(f, best.ref)
      // best===null → 孤儿，不入表
    }
  }
  return ownership
}

/**
 * 由子程序 callGraph + 属主归属折叠出**单元级**依赖图，跑 Tarjan SCC → procedureOrder。
 *
 * unit = 一个 PROCEDURE（full key 自身），或一个孤儿 FUNCTION（full key 自身）；被 owner 拥有的
 * FUNCTION 折叠进 owner 单元。边：callGraph 每条 s→t 映射为 unit(s)→unit(t)，同单元自环跳过。
 * 边方向 caller→callee = 依赖（与 tarjanSCC「A→B 表示 A 依赖 B」约定一致），输出依赖在前。
 */
export function buildProcedureOrder(
  callGraph: Record<string, string[]>,
  refIndex: Map<string, { subprograms: SubprogramInfo[]; procNameToRefNames: Map<string, string[]> }>,
  ownership: Map<string, string>,
): string[][] {
  const unitOf = new Map<string, string>()
  for (const [pkg, info] of refIndex) {
    for (const s of info.subprograms) {
      const full = `${pkg}.${s.refName}`
      const unit = s.type === "procedure" ? full : (ownership.get(full) ?? full)
      unitOf.set(full, unit)
    }
  }
  const unitList = [...new Set(unitOf.values())]
  const edges = new Map<string, Set<string>>()
  for (const u of unitList) edges.set(u, new Set())
  for (const [s, callees] of Object.entries(callGraph)) {
    const us = unitOf.get(s)
    if (!us) continue
    for (const t of callees) {
      const ut = unitOf.get(t)
      if (!ut || ut === us) continue // 跨包/同单元自环跳过
      edges.get(us)!.add(ut)
    }
  }
  return tarjanSCC(unitList, edges)
}

/** 启发式复杂度：LOC + 子程序数 + 出边数 + 模式 grep → score/patterns/riskLevel */
function heuristicComplexity(
  pkg: PrescanPackage,
  bodyCode: string,
  specCode: string,
  outgoingEdges: number,
): { score: number; patterns: string[]; riskLevel: "low" | "medium" | "high" } {
  const code = bodyCode + "\n" + specCode
  const patternDefs: [string, RegExp][] = [
    ["cursor-loop", /\b(FOR\s+\w+\s+IN\s*\(|CURSOR\b|\bLOOP\b)/i],
    ["exception-block", /\bEXCEPTION\b/i],
    ["dynamic-sql", /(EXECUTE\s+IMMEDIATE|DBMS_SQL)/i],
    ["bulk-collect", /BULK\s+COLLECT/i],
    ["forall", /\bFORALL\b/i],
    ["merge", /\bMERGE\b/i],
    ["connect-by", /CONNECT\s+BY/i],
    ["analytic", /\bOVER\s*\(/i],
    ["pipelined", /(PIPELINED|PIPE\s+ROW)/i],
    ["autonomous-tx", /AUTONOMOUS_TRANSACTION/i],
    ["recursive-call", /\bRETURN\b/i], // 粗略，递归函数难精确判定，留作占位
  ]
  const patterns = patternDefs.filter(([, re]) => re.test(code)).map(([n]) => n)
  // 递归调用占位太粗，去掉避免噪声
  const filtered = patterns.filter(p => p !== "recursive-call")

  const loc = pkg.estimatedLoc ?? 0
  const subprogramCount = pkg.procedures.length
  let score = Math.round(loc / 100 + subprogramCount * 0.4 + outgoingEdges * 0.3 + filtered.length * 0.6)
  if (score < 1) score = 1
  if (score > 10) score = 10
  const riskLevel: "low" | "medium" | "high" = score <= 3 ? "low" : score <= 6 ? "medium" : "high"
  return { score, patterns: filtered, riskLevel }
}

/**
 * 读 inventory-index.json，写出 analysis.json + 无子程序包的空 analysis-packages/{PKG}.json。
 * 任一产物 Zod 校验失败即抛错。
 */
export function buildAnalysisFromIndex(artifactsDir: string): {
  packageCount: number
  sccGroupCount: number
  warnings: string[]
} {
  const indexPath = join(artifactsDir, "inventory-index.json")
  if (!existsSync(indexPath)) {
    throw new Error(`inventory-index.json 不存在: ${indexPath}（prescan 可能未运行）`)
  }
  const index = JSON.parse(readFileSync(indexPath, "utf-8")) as PrescanIndex
  const warnings: string[] = []
  const sourcePath = index.sourcePath

  // 1) refName 索引
  const refIndex = buildRefNameIndex(index.packages)

  // 2) callGraph（子程序级，仅 subprogram 调用）+ 收集所有跨包引用点（包级，含常量/类型）
  // 局限：scanCallSites 只识别 `PKG.PROC` 点号模式调用。standalone 过程被 package 裸名
  // 调用（proc_name() 无包前缀）时，调用边进不了 callGraph——但不阻断 standalone 自身被
  // 翻译（虚拟包进 packages 后自然走 FSD/translate），仅 package→standalone 跨包对接边
  // 可能缺失，由后续 review/fix 兜底。standalone 调用 package（PKG.PROC 形式）不受影响。
  const callGraph: Record<string, string[]> = {}
  const allRefs: { callerPkg: string; calleePkg: string }[] = []
  for (const pkg of index.packages) {
    const pkgInfo = refIndex.get(pkg.name)!
    const bodyCode = readSource(sourcePath, pkg.bodyFile)
    if (!bodyCode) continue // spec-only 包无调用
    const sites = scanCallSites(bodyCode)
    for (const site of sites) {
      // 包级引用：任何指向 inventory 包的 PKG.X 都算依赖（含常量/类型/子程序）
      if (refIndex.has(site.calleePkg) && site.calleePkg !== pkg.name) {
        allRefs.push({ callerPkg: pkg.name, calleePkg: site.calleePkg })
      }
      // 子程序级 callGraph：仅当 callee 是子程序时归属 caller
      const caller = findCallerSubprogram(pkgInfo.subprograms, site.line)
      if (!caller) continue // 调用在包初始化块等非子程序区，跳过
      const calleeRefNames = resolveCalleeRefNames(site.calleePkg, site.calleeProc, refIndex)
      if (!calleeRefNames) continue // 非子程序 callee（常量/变量/外部包），跳过
      const callerKey = `${pkg.name}.${caller.refName}`
      const arr = callGraph[callerKey] ?? []
      for (const r of calleeRefNames) {
        if (!arr.includes(r)) arr.push(r)
      }
      callGraph[callerKey] = arr
    }
  }

  // 3) packageDependency：从所有跨包引用聚合（排除自环），含常量/类型依赖
  const pkgDep: Record<string, string[]> = {}
  for (const pkg of index.packages) pkgDep[pkg.name] = []
  for (const { callerPkg, calleePkg } of allRefs) {
    const arr = pkgDep[callerPkg] ?? (pkgDep[callerPkg] = [])
    if (!arr.includes(calleePkg)) arr.push(calleePkg)
  }

  // 4) Tarjan SCC → translationOrder（依赖在前）+ sccGroups（size>1）
  const nodes = index.packages.map(p => p.name)
  const edges = new Map<string, Set<string>>()
  for (const pkg of index.packages) {
    edges.set(pkg.name, new Set(pkgDep[pkg.name] ?? []))
  }
  const sccs = tarjanSCC(nodes, edges)
  const translationOrder: string[][] = sccs.map(c => c)
  const sccGroups: string[][] = sccs.filter(c => c.length > 1).map(c => [...c].sort())

  // 5) complexity（启发式）
  const complexity: Record<string, { score: number; patterns: string[]; riskLevel: string }> = {}
  for (const pkg of index.packages) {
    const bodyCode = readSource(sourcePath, pkg.bodyFile)
    const specCode = readSource(sourcePath, pkg.specFile)
    // 出边数：该包子程序的 callee 边数
    let outgoing = 0
    for (const s of (refIndex.get(pkg.name)?.subprograms ?? [])) {
      const arr = callGraph[`${pkg.name}.${s.refName}`]
      if (arr) outgoing += arr.length
    }
    complexity[pkg.name] = heuristicComplexity(pkg, bodyCode, specCode, outgoing)
  }

  // 5.5) PROCEDURE 级：FUNCTION 属主归属 + 单元级拓扑序 procedureOrder
  // translate 下沉到 PROCEDURE 级的依赖分析：PROCEDURE 为 unit，FUNCTION 跟随同包属主，
  // 无属主 FUNCTION 独立成 unit。详见 assignFunctionOwnership / buildProcedureOrder。
  const functionOwnershipMap = assignFunctionOwnership(callGraph, refIndex)
  const functionOwnership: Record<string, string> = {}
  for (const [k, v] of functionOwnershipMap) functionOwnership[k] = v
  const procedureOrder = buildProcedureOrder(callGraph, refIndex, functionOwnershipMap)

  // 6) 写 analysis.json
  const analysis = {
    callGraph,
    packageDependency: pkgDep,
    translationOrder,
    complexity,
    sccGroups,
    packageNames: nodes,
    procedureOrder,
    functionOwnership,
  }
  const metaResult = AnalysisMetaSchema.safeParse(analysis)
  if (!metaResult.success) {
    throw new Error(`analysis.json 校验失败:\n${formatZodIssues(metaResult.error)}`)
  }
  writeFileSync(join(artifactsDir, "analysis.json"), JSON.stringify(metaResult.data, null, 2), "utf-8")

  // 7) 无子程序包写空 analysis-packages/{PKG}.json（有子程序的包由 analyze map 阶段填充）
  const analysisPkgDir = join(artifactsDir, "analysis-packages")
  mkdirSync(analysisPkgDir, { recursive: true })
  for (const pkg of index.packages) {
    if (pkg.procedures.length > 0) continue
    const empty = { packageName: pkg.name, subprograms: [] }
    const r = AnalysisPackageSchema.safeParse(empty)
    if (!r.success) {
      throw new Error(`analysis-packages/${pkg.name}.json 空文件校验失败:\n${formatZodIssues(r.error)}`)
    }
    writeFileSync(join(analysisPkgDir, `${pkg.name}.json`), JSON.stringify(r.data, null, 2), "utf-8")
  }

  getLogger().info("[analysis-builder]", `生成 analysis.json: ${nodes.length} 包, ${sccGroups.length} SCC 组, ${Object.keys(callGraph).length} 调用边, ${procedureOrder.flat().length} PROCEDURE 单元, ${Object.keys(functionOwnership).length} 被拥有 FUNCTION`)
  return { packageCount: nodes.length, sccGroupCount: sccGroups.length, warnings }
}
