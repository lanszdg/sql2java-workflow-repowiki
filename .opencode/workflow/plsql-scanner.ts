/**
 * PL/SQL Structural Scanner — inventory 入口 + 后处理 + 落盘前装配
 *
 * 在 inventory worker 第 0 步（workflow scan action）确定性扫描 PL/SQL 源码目录，产出 InventoryIndex。
 * 不依赖 LLM，不占用上下文窗口。运行态零 JDK（只用入库的生成 TS + antlr4ts 纯 TS 运行时）。
 *
 * 解析器 + 单文件抽取逻辑已抽到 `./plsql-file-scanner`（叶子模块，无重依赖，可被 worker 池 import
 * 打破循环）。本模块保留：文件收集（collectSourceFiles，用 constants）、后处理装配（finalize），
 * 以及全量 / lazy / regex 三条扫描入口。
 *
 * 输出结构：packages[]（包容器，procedures/functions 仅名字索引）+ subprograms[]（原子子程序，
 * 含 header/body 双定位 + per-method directCalls）+ tables[] + triggers[] + views[] + sequences[]。
 * standalone 过程注入为虚拟包。由 inventory-builder 落盘为 packages/+subprograms/+tables/+inventory.json。
 */

// 从叶子模块 re-export 全部类型 + 解析 helper（向后兼容外部从 plsql-scanner import 的用法）
export {
  UpperCaseCharStream, cleanName, normalizeTypeText, ctxLineRange, ctxText,
  stripSqlPlusCommands, parenDelta, SQL_PSEUDO, PlSqlStructListener, extractPackageNames,
  extractTableFromText, extractTriggerFromText, extractViewFromText, extractSequenceFromText,
  nextStatementBoundary, lineRangeOf, storedFilePath, parseFileAst, scanFileSet,
  type ParamInfo, type LocationInfo, type DirectCall, type PackageRef,
  type SubprogramInfo, type ConstantInfo, type VariableInfo, type ExceptionInfo, type TypeInfo,
  type PackageInfo, type ColumnIndex, type ForeignKeyInfo,
  type TableIndex, type TriggerIndex, type ViewIndex, type SequenceIndex,
  type StandaloneProcIndex, type InventoryIndex, type FileSetResult,
} from "./plsql-file-scanner"

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, extname } from "node:path"
import { GENERATED_OUTPUT_DIR, GENERATED_MARKER, VALID_SOURCE_EXTENSIONS } from "./constants"
import { getLogger } from "./workflow-logger"
import { parseMainEntry } from "./scope-computer"
import { scanFilesParallel, createPoolSession, getWorkerCount, type PoolSession } from "./plsql-worker-pool"
import {
  cleanName, extractTriggerFromText, extractTableFromText, extractViewFromText, extractSequenceFromText,
  extractPackageNames, stripSqlPlusCommands, storedFilePath, scanFileSet,
  type PackageInfo, type SubprogramInfo, type TableIndex, type TriggerIndex, type ViewIndex, type SequenceIndex,
  type StandaloneProcIndex, type DirectCall, type PackageRef, type InventoryIndex, type FileSetResult,
} from "./plsql-file-scanner"

// ── 文件收集 ────────────────────────────────────────────────────────────────────

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

// ── 后处理 + 装配 InventoryIndex ────────────────────────────────────────────────

/**
 * 把多个 FileSetResult 合并 + 跑后处理 + 装配 InventoryIndex。
 * scanWithAST（全量，单 set）/ scanSourceLazy（lazy，多 set）/ worker 池（多 set，按包分区）共用。
 *
 * **按包分区保证**：同一包的全部文件落在同一 file-set → 同 `PKG.METHOD` key 的子程序不跨 set 出现
 * → subprograms re-bucket 无需复现 listener 的 spec↔body 槽位配对（registerSubprogram 的
 * find-by-vacancy 已在 file-set 内完成），只需按 key 收集槽位保持顺序。
 */
export function finalizeFileSetResults(
  results: FileSetResult[],
  primaryBase: string,
  scannerUsed: "ast" | "regex",
): InventoryIndex {
  const packages = new Map<string, PackageInfo>()
  const subprograms = new Map<string, SubprogramInfo[]>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const standaloneSlots: SubprogramInfo[] = []
  const warnings: string[] = []

  for (const r of results) {
    for (const p of r.packages) {
      // 按包分区下包不跨 set 出现；defensive merge 仅在分区不完美时触发（合并字段，不丢数据）
      const ex = packages.get(p.packageName)
      if (!ex) {
        packages.set(p.packageName, p)
      } else {
        if (!ex.headerPath) ex.headerPath = p.headerPath
        if (!ex.bodyPath) ex.bodyPath = p.bodyPath
        for (const ap of p.absolutePaths) if (!ex.absolutePaths.includes(ap)) ex.absolutePaths.push(ap)
        ex.constants.push(...p.constants)
        ex.variables.push(...p.variables)
        ex.exceptions.push(...p.exceptions)
        ex.types.push(...p.types)
        ex.estimatedLoc += p.estimatedLoc
        // functions/procedures 名索引由 finalizeInventoryIndex 末尾从 subprograms 重建，此处跳过
      }
    }
    for (const s of r.subprograms) {
      const key = `${s.belongToPackage}.${s.name}`
      let arr = subprograms.get(key)
      if (!arr) { arr = []; subprograms.set(key, arr) }
      arr.push(s)
    }
    standaloneProcedures.push(...r.standaloneProcedures)
    standaloneSlots.push(...r.standaloneSlots)
    tables.push(...r.tables)
    triggers.push(...r.triggers)
    views.push(...r.views)
    sequences.push(...r.sequences)
    warnings.push(...r.warnings)
  }

  return finalizeInventoryIndex(primaryBase, packages, subprograms, standaloneProcedures, standaloneSlots, tables, triggers, views, sequences, warnings, scannerUsed)
}

/**
 * 后处理 + 装配 InventoryIndex：
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

// ── AST 全量扫描 ────────────────────────────────────────────────────────────────

/**
 * Phase 0 regex 建 包→文件 映射，按包连通分量分区成 file-set。
 * **同一包的全部文件落同一 file-set**（spec+body 可能跨文件，须由同一 worker 的 listener
 * 在共享 local Map 上合并）；无包文件（DDL/standalone）chunk 成批。按 min 文件序排序，
 * 保留与原串行一致的 packages/subprograms 输出顺序（确定性 + 测试友好）。
 *
 * 连通分量用 union-find：声明多包的文件把所声明的包的文件全连在一起。
 * 返回 file-sets + 总行数（供串行/并行闸门决策：小工作量走串行省 N×ATN 冷启动）。
 */
export function partitionFilesByPackage(files: string[]): { fileSets: string[][]; totalLines: number } {
  if (files.length === 0) return { fileSets: [], totalLines: 0 }
  const pkgFiles = new Map<string, number[]>()
  let totalLines = 0
  for (let i = 0; i < files.length; i++) {
    let code: string
    try { code = readFileSync(files[i], "utf-8") } catch { continue }
    totalLines += code.split("\n").length
    for (const name of extractPackageNames(code)) {
      let arr = pkgFiles.get(name)
      if (!arr) { arr = []; pkgFiles.set(name, arr) }
      if (!arr.includes(i)) arr.push(i)
    }
  }
  if (files.length === 1) return { fileSets: [files], totalLines }
  // union-find：同包文件连通
  const parent = new Array(files.length)
  for (let i = 0; i < files.length; i++) parent[i] = i
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (const indices of pkgFiles.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k])
  }
  // 按 root 分组；Map 迭代序 = root 首次出现序 = 该分量 min index 升序
  const groups = new Map<number, number[]>()
  for (let i = 0; i < files.length; i++) {
    const r = find(i)
    let arr = groups.get(r)
    if (!arr) { arr = []; groups.set(r, arr) }
    arr.push(i)
  }
  // 多文件分量保持整体；单文件分量（无共享包）chunk 成批。chunk 大小自适应：目标 ~32 个
  // singleton 批（足够 4-8 worker 各分多批均衡负载），避免固定 32 文件/批把少量单文件包
  // 合成 1-2 个大 file-set 榨干并行度。整体按 min 文件序排序保输出顺序与原串行一致。
  const multi: number[][] = []
  const singletons: number[] = []
  for (const indices of groups.values()) {
    if (indices.length > 1) multi.push(indices)
    else singletons.push(indices[0])
  }
  // {minIdx, paths}，按 minIdx 升序
  const sets: { minIdx: number; paths: string[] }[] = []
  for (const indices of multi) sets.push({ minIdx: indices[0], paths: indices.map(i => files[i]) })
  const targetBatches = 32
  const chunkSize = Math.max(1, Math.ceil(singletons.length / targetBatches))
  for (let i = 0; i < singletons.length; i += chunkSize) {
    const slice = singletons.slice(i, i + chunkSize)
    sets.push({ minIdx: slice[0], paths: slice.map(idx => files[idx]) })
  }
  sets.sort((a, b) => a.minIdx - b.minIdx)
  return { fileSets: sets.map(s => s.paths), totalLines }
}

/** 串行/并行闸门：总行数低于此值时，N 个 worker 的 ATN 冷启动（~4.3s/worker）摊销不开，串行更快。 */
const SERIAL_THRESHOLD_LINES = 10_000

/**
 * 用 antlr4ts listener 扫描源码目录，产出 InventoryIndex。
 * 按包分区成 file-set → 大工作量走 worker 池并行（bun）/ 小工作量或 fallback 走串行
 * → 合并 + 后处理。串行/并行产物等价（partition 保序 + finalize 共用）。
 */
export async function scanWithAST(roots: string[], primaryBase: string): Promise<InventoryIndex> {
  const files = collectSourceFiles(roots)
  const { fileSets, totalLines } = partitionFilesByPackage(files)
  const results = totalLines < SERIAL_THRESHOLD_LINES
    ? await serialScanFileSets(fileSets, primaryBase)
    : await scanFilesParallel(fileSets, primaryBase)
  return finalizeFileSetResults(results, primaryBase, "ast")
}

/** 串行扫描多个 file-set（小工作量 / worker 不可用 fallback 共用）。 */
async function serialScanFileSets(fileSets: string[][], primaryBase: string): Promise<FileSetResult[]> {
  const results: FileSetResult[] = []
  for (const fs of fileSets) {
    try { results.push(scanFileSet(fs, primaryBase)) }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ packages: [], subprograms: [], standaloneProcedures: [], standaloneSlots: [], tables: [], triggers: [], views: [], sequences: [], warnings: [`scanFileSet 失败: ${msg}`] })
    }
  }
  return results
}

// ── Regex 兜底（parser 完全不可用时）──────────────────────────────────────────

/** 极简 regex 扫描，仅当 AST 路径整体不可用时兜底。 */
export function scanWithRegex(roots: string[], primaryBase: string): InventoryIndex {
  const files = collectSourceFiles(roots)
  const packages = new Map<string, PackageInfo>()
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
 * **闭包 = call-closure ∪ 1-hop const-leaf**：directCalls 传递可达包（call-closure，全参与者）
 * + call-closure 包的 packageRefs 1-hop 目标（const-leaf，仅常量/类型被引用、叶子不传递）。
 * const-leaf 包不展开其 directCalls/packageRefs，避免 const/type 引用图传递爆炸。
 * ensureRunScope 的 computeClosure 在此产物上算 METHOD 闭包子集，scopePackages 同源（1-hop）。
 *
 * Step 1 纯重构：Phase 1 仍按文件粒度串行 parseFileAst（共享 Map 跨文件合并 spec/body）；
 * Step 4 将改为按包 file-set + worker 池 wavefront。
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
    for (const name of extractPackageNames(code)) {
      let entry = packageFileMap.get(name)
      if (!entry) { entry = { files: [] }; packageFileMap.set(name, entry) }
      if (!entry.files.includes(filePath)) entry.files.push(filePath)
    }
  }

  const entryMap = packageFileMap.get(entryPkgUpper)
  if (!entryMap) {
    throw new Error(`scanSourceLazy: 入口包 ${parsed.pkg} 未在源码中找到 CREATE PACKAGE 声明（检查包名拼写 / 大小写 / mainEntry 格式）`)
  }

  // ── Phase 1: antlr BFS，包粒度 wavefront，只解析闭包内包 ──
  // 队列持包名（非文件）：每包的全部文件作为一个 file-set 交给 scanFilesParallel（worker 池并行
  // / 小波次串行 fallback）。同包 spec+body 落同一 file-set → listener 在共享 local Map 上正确合并。
  // tables/triggers/views/sequences 由 Phase 0 全量持有，Phase 1 结果中的同名字段忽略（避免重复）。
  const packages = new Map<string, PackageInfo>()
  const subprograms = new Map<string, SubprogramInfo[]>()
  const standaloneProcedures: StandaloneProcIndex[] = []
  const standaloneSlots: SubprogramInfo[] = []
  const warnings: string[] = [`lazy 扫描：仅解析入口 ${parsed.pkg}.${parsed.refName} 的可达闭包，out-of-closure 包未落盘`]
  const visitedPkg = new Set<string>()
  const queue: string[] = [entryPkgUpper]
  // 方案 C 断传递：call-closure 包（入口 + directCalls 传递可达）驱动展开；const-leaf 包
  // （仅被 call-closure 包的 packageRef 1-hop 引用、自身无过程被调用）作叶子不展开。
  // 避免 const/type 引用图传递爆炸（一个包引用 30 个包的常量 → 传递闭包上千）。
  const callClosure = new Set<string>([entryPkgUpper])
  const constLeaf = new Set<string>()
  // persistent session：首波足够大时建，后续波次复用 warm 池（amortize ATN 冷启动）；
  // 小闭包全程不建 session，串行。Worker 不可用 → session=null，全程串行 fallback。
  let session: PoolSession | null = null
  const SESSION_THRESHOLD = 2 * getWorkerCount()
  try {
    while (queue.length > 0) {
      // 取当前 BFS 层（已去重）的全部包
      const wave: string[] = []
      while (queue.length > 0) {
        const p = queue.shift()!
        if (visitedPkg.has(p)) continue
        visitedPkg.add(p)
        if (!packageFileMap.has(p)) continue  // 非项目包（SQL 内建 / 外部），跳过
        wave.push(p)
      }
      if (wave.length === 0) continue

      // 首波达阈值 → 建 session（仅一次）；之后所有波次走 session（warm 池）
      if (!session && wave.length >= SESSION_THRESHOLD) session = await createPoolSession()
      const fileSets = wave.map(p => packageFileMap.get(p)!.files)
      const results = session
        ? await session.run(fileSets, primaryBase)
        : await serialScanFileSets(fileSets, primaryBase)
      // 合并 AST 部分（packages/subprograms/standalone）；忽略 tables/triggers/views/sequences（Phase 0 持有）
    for (const r of results) {
      for (const p of r.packages) {
        // 闭包内包不跨波次出现（visitedPkg 去重）；defensive merge 同 scanWithAST
        const ex = packages.get(p.packageName)
        if (!ex) packages.set(p.packageName, p)
        else {
          if (!ex.headerPath) ex.headerPath = p.headerPath
          if (!ex.bodyPath) ex.bodyPath = p.bodyPath
          for (const ap of p.absolutePaths) if (!ex.absolutePaths.includes(ap)) ex.absolutePaths.push(ap)
          ex.constants.push(...p.constants); ex.variables.push(...p.variables)
          ex.exceptions.push(...p.exceptions); ex.types.push(...p.types)
          ex.estimatedLoc += p.estimatedLoc
        }
      }
      for (const s of r.subprograms) {
        const key = `${s.belongToPackage}.${s.name}`
        let arr = subprograms.get(key)
        if (!arr) { arr = []; subprograms.set(key, arr) }
        arr.push(s)
      }
      standaloneProcedures.push(...r.standaloneProcedures)
      standaloneSlots.push(...r.standaloneSlots)
      warnings.push(...r.warnings)
    }

    // 从已解析子程序抽目标包，展开闭包（下一层入队）。directCalls/packageRefs 的 package
    // 字段已 cleanName（大写），与 packageFileMap 键一致。
    //
    // **断传递（方案 C）**：只有 call-closure 包驱动展开；const-leaf 包是叶子——既不跟它的
    // directCalls 也不跟它的 packageRefs。directCalls 跨包目标 → call-closure（全参与者，传递）；
    // packageRefs 跨包目标 → const-leaf（1-hop，叶子不传递）。call-closure 优先：被 directCall
    // 触达的包无论先前是否 const-leaf 都升级为 call-closure。fixpoint 处理同波内升级传播（顺序无关）。
    const callClosureSubs = (): SubprogramInfo[] => {
      const out: SubprogramInfo[] = []
      for (const slots of subprograms.values()) {
        for (const s of slots) if (callClosure.has(s.belongToPackage.toUpperCase())) out.push(s)
      }
      return out
    }
    // 1) directCalls 闭包 fixpoint：只经 call-closure 包传递（const-leaf 包的 directCalls 不收）
    let changed = true
    while (changed) {
      changed = false
      for (const s of callClosureSubs()) {
        const selfPkg = s.belongToPackage.toUpperCase()
        for (const c of s.directCalls) {
          const p = c.package.toUpperCase()
          if (p === selfPkg || !packageFileMap.has(p)) continue  // 同包 / 非项目包
          if (!callClosure.has(p)) {
            callClosure.add(p)
            constLeaf.delete(p)  // 升级：从 const-leaf 移出
            changed = true
          }
        }
      }
    }
    // 2) const-leaf：call-closure 包的 packageRefs 1-hop 目标（不再传递展开）
    for (const s of callClosureSubs()) {
      const selfPkg = s.belongToPackage.toUpperCase()
      for (const rr of s.packageRefs) {
        const p = rr.package.toUpperCase()
        if (p === selfPkg || !packageFileMap.has(p)) continue
        if (!callClosure.has(p)) constLeaf.add(p)
      }
    }
    // 3) 入队未访问的 call-closure ∪ const-leaf
    for (const p of callClosure) if (!visitedPkg.has(p)) queue.push(p)
    for (const p of constLeaf) if (!visitedPkg.has(p)) queue.push(p)
  }
  } finally {
    session?.close()
  }

  return finalizeInventoryIndex(primaryBase, packages, subprograms, standaloneProcedures, standaloneSlots, tables, triggers, views, sequences, warnings, "ast")
}
