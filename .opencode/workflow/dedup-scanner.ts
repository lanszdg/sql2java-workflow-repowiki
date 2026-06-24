/**
 * dedup-scanner — PMD CPD 确定性重复检测（零 LLM）
 *
 * dedup dispatch 时由 engine 调用：跑 `mvn pmd:cpd` 扫 projectRoot 下所有 Java，解析 CPD XML
 * → 跨包重复组 → 应用 dedup-rules.json 覆盖（exclude/force）→ 写 dedup-duplicates.json。
 *
 * 设计见 [[analyze-procedure-level]] 邻接的 dedup 重构方案：
 *   - 静态工具找重复（PMD CPD，token-based，跨平台——复用 verify 的 mvn，Maven 自动下载插件）
 *   - LLM dedup agent 按 dedup-duplicates.json 的 suggestedExtract/forceExtract 组做抽取+重构
 *   - mvn/PMD 不可用 → 优雅跳过（写 skipped 标记，不阻塞 pipeline；dedup 是优化项非正确性必需）
 *
 * category 由 Java 文件 role 推导（来自 translations/<pkg>/translation.json.files[].role）；
 * 业务逻辑判断（service-impl 方法体是否该抽）交给 LLM Step B——scanner 的 suggestedExtract 仅给
 * 「跨≥2包 + 无 TODO」的粗提示，LLM 复核。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { join, basename, sep, resolve, normalize } from "node:path"
import { execSync } from "node:child_process"
import { getLogger } from "./workflow-logger"
import { DedupDuplicatesSchema } from "./artifact-schemas"

const PMD_PLUGIN_COORD = "org.apache.maven.plugins:maven-pmd-plugin:3.21.2"
const MIN_TOKENS = 70

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface FileMeta { packageName: string; role: string; absPath: string }

export interface DupSource {
  packageName: string
  file: string
  startLine: number
  endLine?: number
  tokens?: number
}

export interface DupGroup {
  id: string
  category: string
  sources: DupSource[]
  diffScore: number
  suggestedExtract: boolean
  forceExtract?: boolean
  skipReason?: string
}

export interface DedupRules {
  exclude?: Matcher[]
  force?: Matcher[]
}
interface Matcher {
  category?: string
  className?: string
  memberName?: string
  package?: string
  file?: string
  reason?: string
}

export interface ScanResult {
  skipped?: boolean
  skipReason?: string
  scanStats?: { totalPackages: number; totalFilesScanned: number; duplicateGroupsFound: number }
  groups?: DupGroup[]
}

// ── 文件索引：Java 文件 → {packageName, role} ──────────────────────────────────

/**
 * 从 translations/<pkg>/translation.json 构建文件→{包,role} 索引。
 * translation.json.files[].path 相对 projectRoot；subprogramMethods.javaFile 补充。
 */
export function buildFileIndex(artifactsDir: string, projectRoot: string, targetPackages?: readonly string[]): Map<string, FileMeta> {
  const idx = new Map<string, FileMeta>()
  const transDir = join(artifactsDir, "translations")
  if (!existsSync(transDir)) return idx
  const targetUpper = targetPackages && targetPackages.length > 0
    ? new Set(targetPackages.map(p => p.toUpperCase()))
    : null

  for (const pkgDir of readdirSync(transDir, { withFileTypes: true })) {
    if (!pkgDir.isDirectory()) continue
    const pkgName = pkgDir.name
    if (targetUpper && !targetUpper.has(pkgName.toUpperCase())) continue
    const aggFile = join(transDir, pkgName, "translation.json")
    if (!existsSync(aggFile)) continue
    let agg: any
    try { agg = JSON.parse(readFileSync(aggFile, "utf-8")) } catch { continue }

    const addFile = (relPath: string, role: string) => {
      if (!relPath || typeof relPath !== "string") return
      const abs = resolve(projectRoot, relPath)
      idx.set(abs, { packageName: pkgName, role: role || "unknown", absPath: abs })
    }
    for (const f of (agg.files ?? [])) addFile(f.path, f.role)
    for (const m of (agg.subprogramMethods ?? [])) if (m.javaFile) addFile(m.javaFile, "service")
  }
  return idx
}

/** CPD 报告的路径可能绝对/相对，按绝对/归一化/basename 三级匹配文件索引 */
function matchFileMeta(cpdPath: string, idx: Map<string, FileMeta>, projectRoot: string): FileMeta | null {
  const abs = resolve(projectRoot, cpdPath)
  if (idx.has(abs)) return idx.get(abs)!
  const norm = normalize(abs)
  for (const [k, v] of idx) if (normalize(k) === norm) return v
  // basename 兜底（同名文件）
  const base = basename(cpdPath).toLowerCase()
  for (const [k, v] of idx) if (basename(k).toLowerCase() === base) return v
  return null
}

// ── 工具链版本基线 ────────────────────────────────────────────────────────────
// 以「最低可运行版本」为准，所有 mvn 驱动的阶段（dedup 的 pmd:cpd、verify 的 compile/test）
// 必须能在该基线跑。JDK 8 = 生成项目目标（java-code-spec.md）；Maven 3.5 = Spring Boot 2.7
// 的最低要求（maven-pmd-plugin 3.21.2 仅需 3.2.5，3.5 为绑定最低）。maven-pmd-plugin 3.21.2
// 自带 PMD 6.55.0，最低 JDK 8；若将来 java-code-spec 把目标升到 17+，需把插件提到 3.22+
// （自带 PMD 7.x，支持 Java 17/21 语法）。
export const MIN_JDK = 8
export const MIN_MAVEN: readonly [number, number, number] = [3, 5, 0]

export function parseMavenVersion(out: string): [number, number, number] | null {
  const m = /Apache Maven (\d+)\.(\d+)\.(\d+)/.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** mvn --version 输出 "Java version: 1.8.0_292" 或 "Java version: 17.0.1" → 主版本号 */
export function parseJavaMajor(out: string): number | null {
  const m = /Java version:\s+(\d+)(?:\.(\d+))?/.exec(out)
  if (!m) return null
  const first = Number(m[1])
  const second = m[2] ? Number(m[2]) : 0
  return first === 1 ? second : first // 1.8 → 8；17 → 17
}

export function cmpVersion(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** 校验 JDK + Maven 是否达最低基线（mvn --version 一次性给两者版本） */
export function checkToolchain(): { ok: boolean; maven?: string; java?: string; reason?: string } {
  let out: string
  try {
    out = execSync("mvn --version", { stdio: "pipe", encoding: "utf-8", timeout: 15_000 })
  } catch {
    return { ok: false, reason: "mvn 不在 PATH（verify/dedup 均依赖 mvn）" }
  }
  const mvn = parseMavenVersion(out)
  const jdk = parseJavaMajor(out)
  if (!mvn) return { ok: false, reason: "无法解析 mvn --version 的 Maven 版本" }
  if (!jdk) return { ok: false, reason: "无法解析 mvn --version 的 Java 版本" }
  if (cmpVersion(mvn, MIN_MAVEN) < 0) {
    return { ok: false, maven: mvn.join("."), java: String(jdk), reason: `Maven ${mvn.join(".")} 低于最低要求 ${MIN_MAVEN.join(".")}（Spring Boot 2.7 要求 Maven 3.5+）` }
  }
  if (jdk < MIN_JDK) {
    return { ok: false, maven: mvn.join("."), java: String(jdk), reason: `JDK ${jdk} 低于最低要求 JDK ${MIN_JDK}` }
  }
  return { ok: true, maven: mvn.join("."), java: String(jdk) }
}

// ── PMD CPD 执行 ──────────────────────────────────────────────────────────────

/**
 * 跑 mvn pmd:cpd，返回 CPD XML 内容。工具链不达基线/无 pom/执行失败/无输出 → null（调用方走跳过）。
 * 跨平台：mvn 自身跨平台；不下载 PMD dist（Maven 自动下载插件缓存 ~/.m2）。
 */
export function runPmdCpd(projectRoot: string): { xml: string } | null {
  if (!existsSync(join(projectRoot, "pom.xml"))) {
    getLogger().warn("[dedup-scanner]", `projectRoot=${projectRoot} 下无 pom.xml，跳过 PMD CPD`)
    return null
  }
  const tc = checkToolchain()
  if (!tc.ok) {
    getLogger().warn("[dedup-scanner]", `工具链不达基线，跳过 dedup 检测：${tc.reason}`)
    return null
  }
  // 注意：Maven 的 -o 是离线开关（toggle），不是 key=value。-o=false 是无效语法，Maven 会把
  // "false" 当 lifecycle phase 报 "Unknown lifecycle phase" 立即退出。在线是默认，无需任何 flag。
  const cmd = `mvn -q ${PMD_PLUGIN_COORD}:cpd -DminimumTokens=${MIN_TOKENS} -Dformat=xml -Dlanguage=java`
  try {
    execSync(cmd, { cwd: projectRoot, stdio: "pipe", timeout: 300_000, encoding: "utf-8" })
  } catch (e: any) {
    // mvn 非零退出但仍可能产出 cpd.xml（如部分文件扫描告警）；记录 stderr 摘要便于诊断，无 xml 才视为失败
    const stderr = String(e.stderr || e.stdout || "")
    const tail = stderr.split("\n").filter((l: string) => l.trim()).slice(-5).join(" | ")
    getLogger().warn("[dedup-scanner]", `mvn pmd:cpd 失败：${tail || e.message?.split("\n")[0]}；尝试读取已有 cpd.xml`)
  }
  const cpdXml = join(projectRoot, "target", "cpd.xml")
  if (!existsSync(cpdXml)) {
    getLogger().warn("[dedup-scanner]", `mvn pmd:cpd 未产出 target/cpd.xml（离线/插件下载失败？），跳过 dedup`)
    return null
  }
  try {
    return { xml: readFileSync(cpdXml, "utf-8") }
  } catch (e: any) {
    getLogger().warn("[dedup-scanner]", `读取 target/cpd.xml 失败: ${e.message}`)
    return null
  }
}

// ── CPD XML 解析（纯函数，便于单测 mock） ──────────────────────────────────────

const DUP_RE = /<duplication\s+([^>]*)>([\s\S]*?)<\/duplication>/g
const FILE_RE = /<file\s+line="(\d+)"\s+path="([^"]+)"\s*\/>/g
const ATTR = (attrs: string, name: string): number | undefined => {
  const m = new RegExp(`${name}="(\\d+)"`).exec(attrs)
  return m ? Number(m[1]) : undefined
}

/**
 * 解析 CPD XML → 重复组。每个 <duplication> 一组，含 <file> 各处。
 * category 由文件 role 推导；无匹配归 unknown。
 */
export function parseCpdXml(xml: string, idx: Map<string, FileMeta>, projectRoot: string): DupGroup[] {
  const groups: DupGroup[] = []
  let m: RegExpExecArray | null
  let gi = 0
  while ((m = DUP_RE.exec(xml)) !== null) {
    const attrs = m[1]
    const body = m[2]
    const tokens = ATTR(attrs, "tokens") ?? 0
    const sources: DupSource[] = []
    let fm: RegExpExecArray | null
    const fre = new RegExp(FILE_RE)
    while ((fm = fre.exec(body)) !== null) {
      const startLine = Number(fm[1])
      const cpdPath = fm[2]
      const meta = matchFileMeta(cpdPath, idx, projectRoot)
      const lines = ATTR(attrs, "lines")
      sources.push({
        packageName: meta?.packageName ?? "UNKNOWN",
        file: meta ? relativeToProject(meta.absPath, projectRoot) : cpdPath,
        startLine,
        endLine: lines ? startLine + lines - 1 : undefined,
        tokens,
      })
    }
    if (sources.length === 0) continue
    // category：取首个匹配文件的 role；多 role 取最具体（非 unknown 优先）
    const roles = sources.map(s => idx.get(resolve(projectRoot, s.file))?.role).filter(Boolean) as string[]
    const category = roles.find(r => r && r !== "unknown") ?? roles[0] ?? "unknown"
    groups.push({
      id: `dup-${++gi}`,
      category,
      sources,
      diffScore: 0, // CPD 同组即 token 一致
      suggestedExtract: false, // applyRules 定
    })
  }
  return groups
}

function relativeToProject(absPath: string, projectRoot: string): string {
  const pr = resolve(projectRoot)
  if (absPath.startsWith(pr + sep)) return absPath.slice(pr.length + 1)
  return absPath
}

// ── 规则应用（exclude / force / suggestedExtract） ─────────────────────────────

function classNameOf(file: string): string {
  const b = basename(file).replace(/\.java$/i, "")
  return b
}

function matcherHit(m: Matcher, ctx: { category: string; className: string; packageName: string; file: string }): boolean {
  if (m.category && m.category.toUpperCase() !== ctx.category.toUpperCase()) return false
  if (m.className && !new RegExp(m.className).test(ctx.className)) return false
  if (m.package && !new RegExp(m.package).test(ctx.packageName)) return false
  if (m.file && !new RegExp(m.file).test(ctx.file)) return false
  return true
}

/** 读源文件片段检查是否含 `// TODO: [translate]` */
function hasTranslateTodo(file: string, startLine: number, endLine: number | undefined, projectRoot: string): boolean {
  const abs = resolve(projectRoot, file)
  if (!existsSync(abs)) return false
  try {
    const lines = readFileSync(abs, "utf-8").split("\n")
    const end = endLine ?? startLine + 50
    for (let i = startLine - 1; i < Math.min(end, lines.length); i++) {
      if (lines[i]?.includes("// TODO: [translate]")) return true
    }
  } catch { /* ignore */ }
  return false
}

/**
 * 应用规则 + dedup-rules.json 覆盖。
 * suggestedExtract = 跨≥2包 && 无 TODO（默认）；force 覆盖为 true；exclude 覆盖为 false。
 * force 单包补扫：force matcher 未命中任何跨包组时，按 className 在文件索引里找单包文件，产出 forceExtract 组。
 */
export function applyRules(
  groups: DupGroup[],
  rules: DedupRules,
  idx: Map<string, FileMeta>,
  projectRoot: string,
): DupGroup[] {
  const exclude = rules.exclude ?? []
  const force = rules.force ?? []

  for (const g of groups) {
    const firstSrc = g.sources[0]
    const ctx = {
      category: g.category,
      className: classNameOf(firstSrc.file),
      packageName: firstSrc.packageName,
      file: firstSrc.file,
    }
    // exclude 优先
    const ex = exclude.find(m => matcherHit(m, ctx))
    if (ex) {
      g.suggestedExtract = false
      g.skipReason = `user-excluded: ${ex.reason ?? "dedup-rules exclude"}`
      continue
    }
    // force 覆盖
    const fo = force.find(m => matcherHit(m, ctx))
    if (fo) {
      g.suggestedExtract = true
      g.forceExtract = true
      g.skipReason = undefined
      continue
    }
    // 默认规则：跨≥2包 && 无 TODO
    const crossPkg = new Set(g.sources.map(s => s.packageName.toUpperCase())).size >= 2
    const todo = g.sources.some(s => hasTranslateTodo(s.file, s.startLine, s.endLine, projectRoot))
    if (!crossPkg) {
      g.suggestedExtract = false
      g.skipReason = "single-package"
    } else if (todo) {
      g.suggestedExtract = false
      g.skipReason = "has-todo"
    } else {
      g.suggestedExtract = true
    }
  }

  // force 单包补扫：force matcher 未命中现有组的 className → 在文件索引里按 className 找文件，产出单包 forceExtract 组
  const existingClassNames = new Set(groups.map(g => classNameOf(g.sources[0].file).toLowerCase()))
  let extraIdx = 0
  for (const fo of force) {
    if (!fo.className) continue
    const re = new RegExp(fo.className)
    const seen = new Set<string>()
    for (const [, meta] of idx) {
      const cn = classNameOf(meta.absPath)
      if (!re.test(cn)) continue
      if (existingClassNames.has(cn.toLowerCase())) continue // 已在跨包组
      const rel = relativeToProject(meta.absPath, projectRoot)
      const key = `${cn.toLowerCase()}|${meta.packageName}`
      if (seen.has(key)) continue
      seen.add(key)
      // 同包同类名多文件只取一个代表
      groups.push({
        id: `force-${++extraIdx}`,
        category: meta.role || "unknown",
        sources: [{ packageName: meta.packageName, file: rel, startLine: 1 }],
        diffScore: 0,
        suggestedExtract: true,
        forceExtract: true,
        skipReason: undefined,
      })
      break
    }
  }

  return groups
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

function loadRules(dedupRulesPath?: string): DedupRules {
  if (!dedupRulesPath || !existsSync(dedupRulesPath)) return {}
  try { return JSON.parse(readFileSync(dedupRulesPath, "utf-8")) as DedupRules } catch { return {} }
}

/**
 * 扫描重复，写 dedup-duplicates.json。返回 ScanResult（含 skipped 时由调用方写占位 dedup.json）。
 * 增量：targetPackages 非空时只重扫这些包文件，与已有 dedup-duplicates.json 合并（替换涉及包的组）。
 */
export function scanDuplicates(
  artifactsDir: string,
  projectRoot: string,
  targetPackages?: readonly string[],
  dedupRulesPath?: string,
): ScanResult {
  const idx = buildFileIndex(artifactsDir, projectRoot, targetPackages)
  const totalPackages = new Set([...idx.values()].map(m => m.packageName)).size

  const cpd = runPmdCpd(projectRoot)
  if (!cpd) {
    return {
      skipped: true,
      skipReason: "PMD CPD 不可用（mvn 缺失/无 pom.xml/离线/插件下载失败）",
      scanStats: { totalPackages, totalFilesScanned: idx.size, duplicateGroupsFound: 0 },
      groups: [],
    }
  }

  let groups = parseCpdXml(cpd.xml, idx, projectRoot)
  const rules = loadRules(dedupRulesPath)
  groups = applyRules(groups, rules, idx, projectRoot)

  // 增量合并：保留已有 dedup-duplicates.json 中非 targetPackages 的组
  if (targetPackages && targetPackages.length > 0) {
    const dupFile = join(artifactsDir, "dedup-duplicates.json")
    if (existsSync(dupFile)) {
      try {
        const prev = JSON.parse(readFileSync(dupFile, "utf-8"))
        const targetUpper = new Set(targetPackages.map(p => p.toUpperCase()))
        const kept = (prev.groups ?? []).filter((g: DupGroup) =>
          !g.sources.some(s => targetUpper.has(s.packageName.toUpperCase())))
        // 重编 id 避免冲突
        const merged = [...kept, ...groups].map((g, i) => ({ ...g, id: `dup-${i + 1}` }))
        groups = merged
      } catch { /* ignore，用本次全量 */ }
    }
  }

  const result: ScanResult = {
    scanStats: {
      totalPackages,
      totalFilesScanned: idx.size,
      duplicateGroupsFound: groups.length,
    },
    groups,
  }

  // 写 dedup-duplicates.json（schema 校验）
  const out = {
    scanStats: result.scanStats,
    groups: result.groups,
    generatedBy: "pmd-cpd",
  }
  const r = DedupDuplicatesSchema.safeParse(out)
  if (!r.success) {
    getLogger().error("[dedup-scanner]", `dedup-duplicates.json schema 校验失败: ${JSON.stringify(r.error.issues)}`)
    return { skipped: true, skipReason: `dedup-duplicates schema 校验失败` }
  }
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(join(artifactsDir, "dedup-duplicates.json"), JSON.stringify(out, null, 2), "utf-8")
  return result
}
