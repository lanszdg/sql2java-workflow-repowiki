/**
 * Dependency Graph — 按需推导的调用图工具
 *
 * 从 inventory 阶段产出的 subprograms/{PKG.METHOD}.json 的 directCalls 在内存构建调用图，
 * 提供 callGraph / packageDependency / 闭包 / Tarjan SCC 翻译序 / FUNCTION 属主 / 过程级拓扑序。
 *
 * 取代旧 dependency-graph.json（已删）：调用边不再落盘，按需从 directCalls 推导（进程内缓存）。
 * 算法（tarjanSCC / assignFunctionOwnership / buildProcedureOrder）迁移自 analysis-builder。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { refNamesForPackage, pkgOf } from "./refname"

// ── 类型 ────────────────────────────────────────────────────────────────────────

interface SubprogramFile {
  name: string
  type: "PROCEDURE" | "FUNCTION"
  belongToPackage: string
  overloadIndex: number | null
  isPrivate: boolean
  directCalls: { package: string; name: string; line: number; kind: "function" | "procedure" }[]
}

export interface RefIndexEntry {
  /** 本包子程序（含 refName / type），顺序与文件 encounter 一致 */
  subprograms: { name: string; refName: string; type: "procedure" | "function" }[]
  /** 大写裸名 → 该名的所有 refName（重载多版本） */
  procNameToRefNames: Map<string, string[]>
}

export interface DependencyGraph {
  /** 子程序级调用图：key=`PKG.refName`，value=被调用的 `PKG.refName` 数组 */
  callGraph: Record<string, string[]>
  /** 包级依赖：PKG → 依赖的 PKG[]（去重，排除自环） */
  packageDependency: Record<string, string[]>
  /** 包名列表 */
  packageNames: string[]
  /** refName 索引 */
  refIndex: Map<string, RefIndexEntry>
  /** 包级翻译序（Tarjan SCC，依赖在前） */
  translationOrder: string[][]
  /** size>1 的 SCC 组 */
  sccGroups: string[][]
  /** 过程级单元拓扑序（PROCEDURE + 孤儿 FUNCTION 为 unit，依赖在前） */
  procedureOrder: string[][]
  /** FUNCTION 属主：`PKG.funcRef` → `PKG.ownerProcRef`（仅被拥有的 FUNCTION） */
  functionOwnership: Record<string, string>
}

// ── 子程序 refName ──────────────────────────────────────────────────────────────

/** 由子程序文件名/overloadIndex 计算 refName：重载=`{name}__{idx}`，否则裸名 */
function refNameOf(s: { name: string; overloadIndex: number | null }): string {
  return s.overloadIndex !== null ? `${s.name}__${s.overloadIndex}` : s.name
}

// ── 读 subprograms/*.json ──────────────────────────────────────────────────────

function readSubprograms(artifactsDir: string): SubprogramFile[] {
  const dir = join(artifactsDir, "subprograms")
  if (!existsSync(dir)) return []
  const out: SubprogramFile[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf-8")) as SubprogramFile)
    } catch { /* 跳过损坏文件 */ }
  }
  return out
}

/** 读 packages/*.json 取全部包名（含无子程序的常量包等，作为 SCC 节点） */
function readPackageNames(artifactsDir: string): string[] {
  const dir = join(artifactsDir, "packages")
  if (!existsSync(dir)) return []
  const names: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { packageName: string }
      if (p.packageName) names.push(p.packageName)
    } catch { /* 跳过 */ }
  }
  return names
}

// ── refIndex 构建 ───────────────────────────────────────────────────────────────

/** 从子程序文件构建 refIndex：PKG → { subprograms, procNameToRefNames } */
function buildRefIndex(subprograms: SubprogramFile[]): Map<string, RefIndexEntry> {
  const byPkg = new Map<string, SubprogramFile[]>()
  for (const s of subprograms) {
    const arr = byPkg.get(s.belongToPackage) ?? []
    arr.push(s)
    byPkg.set(s.belongToPackage, arr)
  }
  const result = new Map<string, RefIndexEntry>()
  for (const [pkg, subs] of byPkg) {
    // 复用 refNamesForPackage 保证与 FSD/translation 命名一致（按名出现序，重载全部带序号）
    const refNames = refNamesForPackage(subs.map(s => s.name))
    const subprogIdx = subs.map((s, i) => ({
      name: s.name,
      refName: refNames[i],
      type: s.type.toLowerCase() === "function" ? "function" as const : "procedure" as const,
    }))
    const procNameToRefNames = new Map<string, string[]>()
    for (const s of subprogIdx) {
      const key = s.name.toUpperCase()
      const arr = procNameToRefNames.get(key) ?? []
      arr.push(s.refName)
      procNameToRefNames.set(key, arr)
    }
    result.set(pkg, { subprograms: subprogIdx, procNameToRefNames })
  }
  return result
}

// ── callee 解析 ────────────────────────────────────────────────────────────────

/** 解析 callee 裸名 → 该包下所有同名 refName（重载多版本） */
function resolveCalleeRefNames(
  calleePkg: string,
  calleeName: string,
  refIndex: Map<string, RefIndexEntry>,
): string[] | null {
  const info = refIndex.get(calleePkg)
  if (!info) return null
  const arr = info.procNameToRefNames.get(calleeName.toUpperCase())
  return arr && arr.length > 0 ? arr : null
}

// ── Tarjan SCC（迁移自 analysis-builder）──────────────────────────────────────

export function tarjanSCC(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let order = 0
  const sccs: string[][] = []
  function strongconnect(v: string): void {
    index.set(v, order); lowlink.set(v, order); order++
    stack.push(v); onStack.add(v)
    for (const w of edges.get(v) ?? new Set()) {
      if (!index.has(w)) { strongconnect(w); lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!)) }
      else if (onStack.has(w)) { lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!)) }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = []
      let w: string
      do { w = stack.pop()!; onStack.delete(w); comp.push(w) } while (w !== v)
      sccs.push(comp)
    }
  }
  for (const v of nodes) if (!index.has(v)) strongconnect(v)
  return sccs
}

// ── FUNCTION 属主（迁移自 analysis-builder）────────────────────────────────────

export function assignFunctionOwnership(
  callGraph: Record<string, string[]>,
  refIndex: Map<string, RefIndexEntry>,
): Map<string, string> {
  const ownership = new Map<string, string>()
  for (const [pkg, info] of refIndex) {
    const typeOf = new Map<string, "procedure" | "function">()
    const reverse = new Map<string, string[]>()
    for (const s of info.subprograms) {
      const full = `${pkg}.${s.refName}`
      typeOf.set(full, s.type)
      reverse.set(full, [])
    }
    for (const [s, callees] of Object.entries(callGraph)) {
      if (pkgOf(s) !== pkg) continue
      for (const t of callees) {
        if (pkgOf(t) !== pkg) continue
        const arr = reverse.get(t)
        if (arr) arr.push(s)
      }
    }
    for (const s of info.subprograms) {
      if (s.type !== "function") continue
      const f = `${pkg}.${s.refName}`
      const dist = new Map<string, number>([[f, 0]])
      const queue: string[] = [f]
      let head = 0
      while (head < queue.length) {
        const cur = queue[head++]
        for (const pred of reverse.get(cur) ?? []) {
          if (!dist.has(pred)) { dist.set(pred, dist.get(cur)! + 1); queue.push(pred) }
        }
      }
      let best: { ref: string; dist: number } | null = null
      for (const [node, d] of dist) {
        if (typeOf.get(node) !== "procedure") continue
        const cand = { ref: node, dist: d }
        if (best === null || cand.dist < best.dist || (cand.dist === best.dist && cand.ref < best.ref)) best = cand
      }
      if (best) ownership.set(f, best.ref)
    }
  }
  return ownership
}

// ── 过程级拓扑序（迁移自 analysis-builder）────────────────────────────────────

export function buildProcedureOrder(
  callGraph: Record<string, string[]>,
  refIndex: Map<string, RefIndexEntry>,
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
      if (!ut || ut === us) continue
      edges.get(us)!.add(ut)
    }
  }
  return tarjanSCC(unitList, edges)
}

// ── 主构建：从 subprograms/*.json directCalls 推导全图 ──────────────────────────

const cache = new Map<string, DependencyGraph>()

/**
 * 构建（并缓存）依赖图：读 subprograms/*.json 的 directCalls → callGraph + packageDependency +
 * Tarjan SCC 翻译序 + FUNCTION 属主 + 过程级拓扑序。同一 artifactsDir 只构建一次。
 */
export function buildDependencyGraph(artifactsDir: string): DependencyGraph {
  const cached = cache.get(artifactsDir)
  if (cached) return cached

  const subprograms = readSubprograms(artifactsDir)
  const refIndex = buildRefIndex(subprograms)

  // callGraph：caller `PKG.refName` → callee `PKG.refName`[]（重载 callee 展开为多边，去重）
  const callGraph: Record<string, string[]> = {}
  const packageDepsRaw: { callerPkg: string; calleePkg: string }[] = []
  for (const s of subprograms) {
    const info = refIndex.get(s.belongToPackage)
    if (!info) continue
    // 子程序文件本身可能因重载有多个 refName 槽位；按名+overloadIndex 定位当前 refName
    const callerRef = refNameOf(s)
    const callerKey = `${s.belongToPackage}.${callerRef}`
    const arr = callGraph[callerKey] ?? []
    for (const c of s.directCalls) {
      const calleeRefs = resolveCalleeRefNames(c.package, c.name, refIndex)
      if (!calleeRefs) continue  // 非本项目子程序（应已在 scanner 后过滤，双保险）
      if (c.package !== s.belongToPackage) {
        packageDepsRaw.push({ callerPkg: s.belongToPackage, calleePkg: c.package })
      }
      for (const r of calleeRefs) {
        const calleeKey = `${c.package}.${r}`
        if (calleeKey === callerKey) continue  // 自环
        if (!arr.includes(calleeKey)) arr.push(calleeKey)
      }
    }
    if (arr.length > 0) callGraph[callerKey] = arr
  }

  // packageDependency：跨包引用聚合（排除自环，去重）
  const packageNames = readPackageNames(artifactsDir)
  const packageDependency: Record<string, string[]> = {}
  for (const p of packageNames) packageDependency[p] = []
  for (const { callerPkg, calleePkg } of packageDepsRaw) {
    if (callerPkg === calleePkg) continue
    const arr = packageDependency[callerPkg] ?? (packageDependency[callerPkg] = [])
    if (!arr.includes(calleePkg)) arr.push(calleePkg)
  }

  // 包级 Tarjan SCC → translationOrder（依赖在前）+ sccGroups（size>1）
  const nodes = packageNames
  const edges = new Map<string, Set<string>>()
  for (const p of packageNames) edges.set(p, new Set(packageDependency[p] ?? []))
  const sccs = tarjanSCC(nodes, edges)
  const translationOrder: string[][] = sccs.map(c => c)
  const sccGroups: string[][] = sccs.filter(c => c.length > 1).map(c => [...c].sort())

  // 过程级
  const functionOwnershipMap = assignFunctionOwnership(callGraph, refIndex)
  const functionOwnership: Record<string, string> = {}
  for (const [k, v] of functionOwnershipMap) functionOwnership[k] = v
  const procedureOrder = buildProcedureOrder(callGraph, refIndex, functionOwnershipMap)

  const graph: DependencyGraph = {
    callGraph, packageDependency, packageNames, refIndex,
    translationOrder, sccGroups, procedureOrder, functionOwnership,
  }
  cache.set(artifactsDir, graph)
  return graph
}

// ── 闭包 ───────────────────────────────────────────────────────────────────────

/** 正向 BFS 闭包：从 entry（`PKG.refName`）出发，沿 callGraph 边收集所有可达子程序（含 entry） */
export function computeClosure(entry: string, callGraph: Record<string, string[]>): Set<string> {
  const seen = new Set<string>([entry])
  const queue: string[] = [entry]
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]
    for (const next of callGraph[cur] ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return seen
}

/** 清缓存（测试/重算用） */
export function clearDependencyGraphCache(artifactsDir?: string): void {
  if (artifactsDir) cache.delete(artifactsDir)
  else cache.clear()
}
