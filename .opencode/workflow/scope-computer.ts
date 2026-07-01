/**
 * Scope Computer — 过程级入口闭包计算（确定性，零 LLM）。
 *
 * 当 `mainEntry` 为过程级（`subdir/PKG.refName`）时，从入口子程序出发计算 callee
 * 传递闭包，作为本次 run 的翻译 scope：
 *   - `scopeUnits`：沿 `callGraph`（子程序级调用边）正向 BFS 到达的子程序 → 映射到 unit。
 *     unit = PROCEDURE 自身，或 owned FUNCTION 的 owner unit（被拥有的 FUNCTION 折叠进 owner），
 *     孤儿 FUNCTION 自身成 unit。**只含被调用的 PROC/FUNC**。
 *   - `scopePackages`：`scopeUnits` 所属包 ∪ 从这些包沿 `packageDependency`（包级引用，含
 *     常量/类型/跨包调用）正向 BFS 到达的所有包。仅常量/类型被引用、无 PROC 被调用的包
 *     进 `scopePackages`（scaffold 出壳）但不进 `scopeUnits`（不译过程体）。
 *
 * 设计见 [[per-unit-hard-isolation]] / plan「过程级入口闭包翻译」。复用 refname.ts
 * 单一真相源（refName 规范、pkgOf/refOf/parseQualified），与 callGraph key 口径一致。
 *
 * 纯函数、零副作用、可单测：不读文件、不持久化。调用方（workflow-engine）负责加载
 * dependency-graph.json / inventory-packages 数据并传入，以及把结果写入 run.metadata。
 */

import { pkgOf, refNamesForPackage, parseQualified } from "./refname"

// ── 宽松输入形态（来自 Zod 校验后的 dependency-graph.json / inventory-packages，但本模块不强耦合 schema）──

export interface AnalysisLike {
  callGraph: Record<string, string[]>
  packageDependency: Record<string, string[]>
  functionOwnership?: Record<string, string>
}

export interface InventoryPackageLike {
  packageName: string
  headerFile?: string | null
  bodyFile?: string | null
  procedures: { name: string; type: string }[]
}

// ── mainEntry 解析 ──

export interface ParsedMainEntry {
  /** 入口文件所在子目录（相对 sourcePath），仅作校验；null = 未给 location */
  subdir: string | null
  /** 包名（Oracle 原始大小写） */
  pkg: string
  /** refName 或裸名（Oracle 原始大小写）；重载须显式给 `name__N` */
  refName: string
}

/**
 * 解析 mainEntry 串。过程级形态：`[subdir/]PKG.refName`（location 用 `/`，调用图键用 `.`）。
 * 返回 null = 非过程级（纯包名 / 无点），调用方按旧门面包语义全量翻译。
 *
 * 拆分：先按最后一个 `/` 分 location / rest；rest 按首个 `.` 拆 pkg / refName（parseQualified）。
 * 无 `/` 时 location=null；rest 无 `.` → 非过程级 → null。
 */
export function parseMainEntry(spec: unknown): ParsedMainEntry | null {
  if (typeof spec !== "string" || spec.length === 0) return null
  const trimmed = spec.trim()
  if (trimmed.length === 0) return null

  const slashIdx = trimmed.lastIndexOf("/")
  const subdir = slashIdx >= 0 ? trimmed.slice(0, slashIdx) : null
  const rest = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed
  if (rest.length === 0) return null

  const q = parseQualified(rest) // [pkg, refName]，按首个 `.` 拆；无 `.` 返回 null
  if (!q) return null // 纯包名（无过程）→ 非过程级
  return { subdir: subdir && subdir.length > 0 ? subdir : null, pkg: q[0], refName: q[1] }
}

// ── 入口存在性 + refName 消歧 ──

export interface EntryResolution {
  ok: true
  /** 入口子程序 callGraph key `PKG.refName`（解析后的真实 refName，保留原始大小写） */
  entrySubprogram: string
  /** 入口 unit（owned FUNCTION → owner unit；否则自身） */
  entryUnit: string
}

export interface EntryError {
  ok: false
  error: string
}

/**
 * 校验入口子程序存在并解析出真实 refName。
 *
 * 重载消歧：用户给的 refName 段若命中唯一 refName（裸名非重载 / 显式 `name__N`）→ 取之；
 * 若是裸名且该名重载（多个 `name__N`）→ 报错要求显式 refName；若不在该包子程序集 → 报错。
 *
 * subdir 校验：入口包的 `bodyFile ?? headerFile` 须以 `subdir/` 开头（防指错/同名包）。
 * subdir=null 时跳过。
 *
 * @param entryPkg 入口包的 inventory 数据（调用方从 inventory-packages/{pkg}.json 加载）
 */
export function resolveEntry(
  entryPkg: InventoryPackageLike | undefined,
  parsed: ParsedMainEntry,
): EntryResolution | EntryError {
  if (!entryPkg) {
    return { ok: false, error: `入口包 ${parsed.pkg} 不在 inventory（检查包名拼写）` }
  }

  // 大小写不敏感匹配包名（Oracle 标识符大小写不敏感）
  if (entryPkg.packageName.toUpperCase() !== parsed.pkg.toUpperCase()) {
    return { ok: false, error: `inventory-packages 数据包名 ${entryPkg.packageName} 与入口 ${parsed.pkg} 不匹配` }
  }

  // 计算该包真实 refName 列表（与 callGraph key / FSD 文件名同口径）
  const procNames = entryPkg.procedures.map(p => p.name)
  const refNames = refNamesForPackage(procNames) // 与 procedures 数组同序
  const upperToRefName = new Map<string, string>() // 大写 refName → 原始 refName
  for (const r of refNames) upperToRefName.set(r.toUpperCase(), r)

  const wantUpper = parsed.refName.toUpperCase()

  // 1) 直接命中唯一 refName（裸名非重载，或显式 name__N）
  const direct = upperToRefName.get(wantUpper)
  if (direct) {
    return finalize(entryPkg, parsed, entryPkg.packageName, direct)
  }

  // 2) 裸名撞重载：用户给了裸名，但该名是重载（refNames 里全是 name__N，裸名不在集合）
  //    检查是否存在 base == wantUpper 的重载 refName
  const overloadedMatches = refNames.filter(r => {
    const base = r.replace(/__\d+$/, "").toUpperCase()
    return base === wantUpper && r.toUpperCase() !== wantUpper // 自身非裸名（带 __N）
  })
  if (overloadedMatches.length > 0) {
    return {
      ok: false,
      error: `入口 ${parsed.pkg}.${parsed.refName} 是重载子程序（${overloadedMatches.length} 个变体: ${overloadedMatches.join(", ")}）。请显式指定 refName，如 ${parsed.pkg}.${overloadedMatches[0]}`,
    }
  }

  // 3) 不存在
  return {
    ok: false,
    error: `入口子程序 ${parsed.pkg}.${parsed.refName} 不在包 ${entryPkg.packageName} 的子程序集（现有: ${procNames.join(", ") || "无"}）`,
  }
}

function finalize(
  entryPkg: InventoryPackageLike,
  parsed: ParsedMainEntry,
  pkg: string,
  refName: string,
): EntryResolution | EntryError {
  // subdir 校验
  if (parsed.subdir) {
    const file = entryPkg.bodyFile ?? entryPkg.headerFile
    if (!file) {
      return { ok: false, error: `入口包 ${pkg} 无 bodyFile/headerFile，无法校验子目录 ${parsed.subdir}` }
    }
    const prefix = parsed.subdir.endsWith("/") ? parsed.subdir : parsed.subdir + "/"
    // 归一化反斜杠（跨平台容忍）
    const normFile = file.replace(/\\/g, "/")
    const normPrefix = prefix.replace(/\\/g, "/")
    if (!normFile.startsWith(normPrefix)) {
      return {
        ok: false,
        error: `入口包 ${pkg} 文件 ${file} 不在子目录 ${parsed.subdir}/ 下（期望前缀 ${normPrefix}）`,
      }
    }
  }
  const entrySubprogram = `${pkg}.${refName}`
  return { ok: true, entrySubprogram, entryUnit: entrySubprogram } // entryUnit 由 computeClosure 经 functionOwnership 修正
}

// ── 闭包计算 ──

export interface ClosureResult {
  /** 闭包 unit 集合 `PKG.refName`（含入口 unit + 全部被调用 unit） */
  scopeUnits: string[]
  /** 闭包包集合（scopeUnits 所属包 ∪ 常量/类型/跨包引用可达包） */
  scopePackages: string[]
  /** 入口 unit（owned FUNCTION → owner） */
  entryUnit: string
  warnings: string[]
}

/**
 * 从入口子程序计算闭包。纯函数。
 *
 * scopeUnits：callGraph 正向 BFS（visited 防环）→ 子程序 → 映射 unit（owned FUNCTION 折叠进 owner）。
 * scopePackages：scopeUnits 所属包作种子 → packageDependency 正向 BFS（传递，含常量/类型引用）。
 */
export function computeClosure(analysis: AnalysisLike, entrySubprogram: string): ClosureResult {
  const callGraph = analysis.callGraph ?? {}
  const packageDependency = analysis.packageDependency ?? {}
  const functionOwnership = analysis.functionOwnership ?? {}
  const warnings: string[] = []

  // 1) callGraph BFS
  const visitedSubprograms = new Set<string>([entrySubprogram])
  const queue: string[] = [entrySubprogram]
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]
    const callees = callGraph[cur]
    if (!Array.isArray(callees)) continue
    for (const callee of callees) {
      if (typeof callee !== "string" || callee.length === 0) continue
      if (!visitedSubprograms.has(callee)) {
        visitedSubprograms.add(callee)
        queue.push(callee)
      }
    }
  }
  if (!callGraph[entrySubprogram] || callGraph[entrySubprogram].length === 0) {
    warnings.push(`入口 ${entrySubprogram} 在 callGraph 中无出边（叶子或未被扫描到调用）——闭包仅含入口 unit`)
  }

  // 2) 子程序 → unit（owned FUNCTION 折叠进 owner；PROC/孤儿 FUNCTION = 自身）
  const scopeUnitsSet = new Set<string>()
  for (const sub of visitedSubprograms) {
    const unit = functionOwnership[sub] ?? sub
    scopeUnitsSet.add(unit)
  }
  // entryUnit 修正：入口若为 owned FUNCTION，取 owner unit
  const entryUnit = functionOwnership[entrySubprogram] ?? entrySubprogram

  // 3) 包级 BFS：种子 = scopeUnits 所属包
  const seedPkgs = new Set<string>()
  for (const u of scopeUnitsSet) seedPkgs.add(pkgOf(u))

  const scopePackagesSet = new Set<string>(seedPkgs)
  const pkgQueue: string[] = [...seedPkgs]
  let pHead = 0
  while (pHead < pkgQueue.length) {
    const cur = pkgQueue[pHead++]
    const deps = packageDependency[cur]
    if (!Array.isArray(deps)) continue
    for (const dep of deps) {
      if (typeof dep !== "string" || dep.length === 0) continue
      if (!scopePackagesSet.has(dep)) {
        scopePackagesSet.add(dep)
        pkgQueue.push(dep)
      }
    }
  }

  return {
    scopeUnits: [...scopeUnitsSet],
    scopePackages: [...scopePackagesSet],
    entryUnit,
    warnings,
  }
}

// ── scope 读取辅助（供 engine 各消费点统一读 run.metadata）──

export interface RunScope {
  scopeUnits: string[]
  scopePackages: string[]
  entryUnit: string
}

/**
 * 从 run.metadata 读取 scope。null = 未激活（无 mainEntry 或未计算）→ 全量翻译。
 * metadata 是 z.record(z.unknown())，此处宽松解析 + 形状校验，异常时返回 null 回退全量。
 */
export function readScope(metadata: Record<string, unknown> | undefined): RunScope | null {
  if (!metadata) return null
  const su = metadata.scopeUnits
  const sp = metadata.scopePackages
  const eu = metadata.entryUnit
  if (!Array.isArray(su) || !Array.isArray(sp) || typeof eu !== "string") return null
  if (su.length === 0 && sp.length === 0) return null
  return {
    scopeUnits: su.filter((x): x is string => typeof x === "string" && x.length > 0),
    scopePackages: sp.filter((x): x is string => typeof x === "string" && x.length > 0),
    entryUnit: eu,
  }
}

/**
 * 闭包内**仅常量/类型被引用、无 unit 被翻译**的包 = scopePackages \ pkgsOf(targetUnits)。
 * 这些包需对 translate 可见（取常量/类型定义），但无 unit 切片。无 scope 返回 undefined。
 */
export function constOnlyScopePkgs(
  scope: RunScope | null,
  targetUnits: readonly string[],
): string[] | undefined {
  if (!scope) return undefined
  const tuPkgs = new Set(targetUnits.map(u => pkgOf(u).toUpperCase()))
  return scope.scopePackages.filter(p => !tuPkgs.has(p.toUpperCase()))
}
