/**
 * review-scanner — Step A 确定性静态扫描（零 LLM）
 *
 * review dispatch 时由 engine 调用：跑 checkstyle + pmd（mvn 驱动）+ 自写 grep 脚本（不依赖
 * mvn）扫 projectRoot 下 Java，解析报告 → 结构化 findings → 写 review-static.json。
 *
 * 设计见 [[dedup-static-analysis]] 邻接的 review 静态重构方案（镜像 dedup-scanner）：
 *   - 机械类规约（#10 todo / #11 命名 / #12 格式 / #15 空catch/资源 / #16 Java9+API / #17/#19 测试空体）
 *     由工具/grep 确定性扫，零 LLM；reviewer 仅做 #1-#9 语义审（Step B）
 *   - mvn 不可用 → checkstyle/pmd 优雅跳过（toolSkipped 标记），grep 脚本照跑（不依赖 mvn）
 *   - finding 归因到包（复用 dedup-scanner.buildFileIndex）；归因失败 → "UNKNOWN"（不丢弃，进 fix）
 *   - fix 回环（mode=incremental, targetPkgs=fixedPackages）：重扫 + 与旧 review-static.json 合并
 *
 * review-static.json 是项目级产物；静态 finding 走独立通道进 fix（不进 per-package review.json /
 * previousFindings——后者维持纯语义）。buildReviewSummary 合并两路到 review-summary.staticPassed。
 *
 * Stage 1 范围：checkstyle(#11/#12) + pmd(#15) + grep(#10/#16/#17/#19/#20-completeness)。
 * #2 sql-completeness / #4 type-mapping / #9 naming-consistency / #14 中文注释 跨产物交叉校验，
 * 误报风险高，留 Stage 3 接入（见文件末 TODO）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, basename, resolve, normalize, sep } from "node:path"
import { execSync } from "node:child_process"
import { getLogger } from "./workflow-logger"
import { ReviewStaticSchema } from "./artifact-schemas"
import { buildFileIndex, checkToolchain } from "./dedup-scanner"
import { findOpencodeDir } from "./ensure-deps"

const CHECKSTYLE_PLUGIN_COORD = "org.apache.maven.plugins:maven-checkstyle-plugin:3.3.1"
// maven-checkstyle-plugin 3.3.1 默认 Checkstyle 10.x 需 JDK 11+；pin 9.3 兼容 JDK 8 基线。
const CHECKSTYLE_VERSION = "9.3"
const PMD_PLUGIN_COORD = "org.apache.maven.plugins:maven-pmd-plugin:3.21.2"

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface FileMeta { packageName: string; role: string; absPath: string }

/** 静态 finding（与 ReviewStaticFindingSchema 对齐） */
export interface StaticFinding {
  file: string
  line?: number | null
  rule: string
  severity: "critical" | "major" | "minor" | "info"
  category: string
  tool: string
  packageName: string
  message: string
}

export interface ReviewScanResult {
  findings: StaticFinding[]
  toolSkipped: { checkstyle: boolean; pmd: boolean }
  scanMode: "full" | "incremental"
  scanStats: { totalPackages: number; totalFilesScanned: number }
  skipped?: boolean
  skipReason?: string
}

// ── 归因（复用 dedup-scanner.buildFileIndex，本地实现路径匹配） ─────────────────

/** checkstyle/pmd 报告的路径按绝对/归一化/basename 三级匹配文件索引（镜像 dedup-scanner.matchFileMeta） */
function matchFileMeta(repPath: string, idx: Map<string, FileMeta>, projectRoot: string): FileMeta | null {
  const abs = resolve(projectRoot, repPath)
  if (idx.has(abs)) return idx.get(abs)!
  const norm = normalize(abs)
  for (const [k, v] of idx) if (normalize(k) === norm) return v
  const base = basename(repPath).toLowerCase()
  for (const [k, v] of idx) if (basename(k).toLowerCase() === base) return v
  return null
}

function relativeToProject(absPath: string, projectRoot: string): string {
  const pr = resolve(projectRoot)
  if (absPath.startsWith(pr + sep)) return absPath.slice(pr.length + 1)
  return absPath
}

function attribute(repPath: string, idx: Map<string, FileMeta>, projectRoot: string): { packageName: string; file: string } {
  const meta = matchFileMeta(repPath, idx, projectRoot)
  if (meta) return { packageName: meta.packageName, file: relativeToProject(meta.absPath, projectRoot) }
  return { packageName: "UNKNOWN", file: repPath }
}

// ── severity / category 映射 ──────────────────────────────────────────────────

function checkstyleSeverity(sev: string): StaticFinding["severity"] {
  const s = (sev || "").toLowerCase()
  if (s === "error") return "major"
  if (s === "warning") return "minor"
  return "info"
}

/** checkstyle source 形如 com.puppycrawl.tools.checkstyle.checks.naming.TypeNameCheck */
function checkstyleCategory(source: string): string {
  const s = source || ""
  if (s.includes("naming")) return "naming-convention"
  if (s.includes("javadoc")) return "comment-convention"
  return "code-format"
}

function pmdSeverity(priority: number | undefined): StaticFinding["severity"] {
  if (priority === 1) return "critical"
  if (priority === 2) return "major"
  if (priority === 3) return "minor"
  return "info"
}

function pmdCategory(rule: string): string {
  const r = (rule || "").toLowerCase()
  if (r.includes("catch") || r.includes("resource") || r.includes("close")) return "collection-exception"
  return "code-format"
}

// ── checkstyle 执行 + 解析 ────────────────────────────────────────────────────

function runCheckstyle(projectRoot: string): StaticFinding[] | null {
  if (!existsSync(join(projectRoot, "pom.xml"))) {
    getLogger().warn("[review-scanner]", `projectRoot=${projectRoot} 下无 pom.xml，跳过 checkstyle`)
    return null
  }
  const tc = checkToolchain()
  if (!tc.ok) {
    getLogger().warn("[review-scanner]", `工具链不达基线，跳过 checkstyle：${tc.reason}`)
    return null
  }
  const configPath = join(findOpencodeDir(), "resources", "review", "checkstyle.xml")
  if (!existsSync(configPath)) {
    getLogger().warn("[review-scanner]", `checkstyle 规则文件不存在: ${configPath}，跳过 checkstyle`)
    return null
  }
  const cmd = [
    `mvn -q ${CHECKSTYLE_PLUGIN_COORD}:check`,
    `-Dcheckstyle.version=${CHECKSTYLE_VERSION}`,
    `-Dcheckstyle.config.location=${configPath}`,
    `-Dcheckstyle.outputFile=target/checkstyle-result.xml`,
    `-Dcheckstyle.output.format=xml`,
    `-Dcheckstyle.violationSeverity=info`,
    `-Dcheckstyle.failOnViolation=false`,
    `-Dcheckstyle.includes=**/*.java`,
  ].join(" ")
  try {
    execSync(cmd, { cwd: projectRoot, stdio: "pipe", timeout: 300_000, encoding: "utf-8" })
  } catch (e: any) {
    const stderr = String(e.stderr || e.stdout || "")
    const tail = stderr.split("\n").filter((l: string) => l.trim()).slice(-5).join(" | ")
    getLogger().warn("[review-scanner]", `mvn checkstyle 非零退出：${tail || e.message?.split("\n")[0]}；尝试读取已有 checkstyle-result.xml`)
  }
  const xmlPath = join(projectRoot, "target", "checkstyle-result.xml")
  if (!existsSync(xmlPath)) {
    getLogger().warn("[review-scanner]", `checkstyle 未产出 target/checkstyle-result.xml，跳过 checkstyle`)
    return null
  }
  try {
    return parseCheckstyleXml(readFileSync(xmlPath, "utf-8"))
  } catch (e: any) {
    getLogger().warn("[review-scanner]", `解析 checkstyle-result.xml 失败: ${e.message}`)
    return null
  }
}

/** checkstyle XML：<file name="..."><error line="" severity="" message="" source=""/></file> */
const CS_FILE_RE = /<file\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g
const CS_ERR_RE = /<error\s+([^/]*?)\/>/g
const CS_ATTR = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs)
  return m ? m[1] : undefined
}

export function parseCheckstyleXml(xml: string): StaticFinding[] {
  const findings: StaticFinding[] = []
  let fm: RegExpExecArray | null
  while ((fm = CS_FILE_RE.exec(xml)) !== null) {
    const file = fm[1]
    const body = fm[2]
    let em: RegExpExecArray | null
    const ere = new RegExp(CS_ERR_RE)
    while ((em = ere.exec(body)) !== null) {
      const attrs = em[1]
      const line = CS_ATTR(attrs, "line")
      const severity = CS_ATTR(attrs, "severity") ?? "warning"
      const source = CS_ATTR(attrs, "source") ?? ""
      const message = CS_ATTR(attrs, "message") ?? ""
      findings.push({
        file,
        line: line ? Number(line) : null,
        rule: source.split(".").pop()?.replace(/Check$/, "") ?? source,
        severity: checkstyleSeverity(severity),
        category: checkstyleCategory(source),
        tool: "checkstyle",
        packageName: "UNKNOWN", // 归因在 scanReviewStatic 统一做
        message,
      })
    }
  }
  return findings
}

// ── pmd 执行 + 解析 ───────────────────────────────────────────────────────────

function runPmd(projectRoot: string): StaticFinding[] | null {
  if (!existsSync(join(projectRoot, "pom.xml"))) return null
  const tc = checkToolchain()
  if (!tc.ok) {
    getLogger().warn("[review-scanner]", `工具链不达基线，跳过 pmd：${tc.reason}`)
    return null
  }
  const rulesetPath = join(findOpencodeDir(), "resources", "review", "pmd-ruleset.xml")
  if (!existsSync(rulesetPath)) {
    getLogger().warn("[review-scanner]", `pmd 规则文件不存在: ${rulesetPath}，跳过 pmd`)
    return null
  }
  const cmd = [
    `mvn -q ${PMD_PLUGIN_COORD}:pmd`,
    `-Drulesets=${rulesetPath}`,
    `-Dformat=xml`,
    `-DtargetJdk=1.8`,
    `-DfailOnViolation=false`,
    `-DskipPmdError=true`,
  ].join(" ")
  try {
    execSync(cmd, { cwd: projectRoot, stdio: "pipe", timeout: 300_000, encoding: "utf-8" })
  } catch (e: any) {
    const stderr = String(e.stderr || e.stdout || "")
    const tail = stderr.split("\n").filter((l: string) => l.trim()).slice(-5).join(" | ")
    getLogger().warn("[review-scanner]", `mvn pmd 非零退出：${tail || e.message?.split("\n")[0]}；尝试读取已有 pmd.xml`)
  }
  const xmlPath = join(projectRoot, "target", "pmd.xml")
  if (!existsSync(xmlPath)) {
    getLogger().warn("[review-scanner]", `pmd 未产出 target/pmd.xml，跳过 pmd`)
    return null
  }
  try {
    return parsePmdXml(readFileSync(xmlPath, "utf-8"))
  } catch (e: any) {
    getLogger().warn("[review-scanner]", `解析 pmd.xml 失败: ${e.message}`)
    return null
  }
}

/** PMD XML：<file name="..."><violation beginline="" rule="" priority="">message</violation></file> */
const PMD_FILE_RE = /<file\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g
const PMD_VIO_RE = /<violation\s+([^>]*?)>([\s\S]*?)<\/violation>/g

export function parsePmdXml(xml: string): StaticFinding[] {
  const findings: StaticFinding[] = []
  let fm: RegExpExecArray | null
  while ((fm = PMD_FILE_RE.exec(xml)) !== null) {
    const file = fm[1]
    const body = fm[2]
    let vm: RegExpExecArray | null
    const vre = new RegExp(PMD_VIO_RE)
    while ((vm = vre.exec(body)) !== null) {
      const attrs = vm[1]
      const message = (vm[2] || "").trim()
      const line = new RegExp(`beginline="(\\d+)"`).exec(attrs)?.[1]
      const rule = new RegExp(`rule="([^"]*)"`).exec(attrs)?.[1] ?? ""
      const priority = new RegExp(`priority="(\\d+)"`).exec(attrs)?.[1]
      findings.push({
        file,
        line: line ? Number(line) : null,
        rule,
        severity: pmdSeverity(priority ? Number(priority) : undefined),
        category: pmdCategory(rule),
        tool: "pmd",
        packageName: "UNKNOWN",
        message,
      })
    }
  }
  return findings
}

// ── grep 脚本（不依赖 mvn） ───────────────────────────────────────────────────

function readFileLines(abs: string): string[] {
  try { return readFileSync(abs, "utf-8").split("\n") } catch { return [] }
}

/** #10 todo-remaining：扫描生产 Java（非 test）里的 `// TODO: [translate]` 残留 */
function scanTodoRemaining(idx: Map<string, FileMeta>, targetSet: Set<string> | null, projectRoot: string): StaticFinding[] {
  const findings: StaticFinding[] = []
  for (const [abs, meta] of idx) {
    if (targetSet && !targetSet.has(meta.packageName.toUpperCase())) continue
    if (/test/i.test(meta.role) || /test/i.test(abs)) continue
    const lines = readFileLines(abs)
    lines.forEach((line, i) => {
      if (line.includes("// TODO: [translate]")) {
        findings.push({
          file: relativeToProject(abs, projectRoot),
          line: i + 1,
          rule: "todo-remaining",
          severity: "major",
          category: "todo-remaining",
          tool: "todo",
          packageName: meta.packageName,
          message: "未解决的 // TODO: [translate] 翻译占位",
        })
      }
    })
  }
  return findings
}

/** #16 version-compliance：Java 9+ API 名匹配（List.of/Map.of/Stream.toList/String.strip 等） */
const JAVA9_API_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:List|Map|Set)\.of\b/, "List/Map/Set.of (Java 9+)"],
  [/\b(?:List|Map|Set)\.copyOf\b/, "List/Map/Set.copyOf (Java 10+)"],
  [/\bOptional\.(?:or|ifPresentOrElse|stream)\b/, "Optional.or/ifPresentOrElse/stream (Java 9/11)"],
  [/\bString\.(?:strip|stripLeading|stripTrailing|repeat|lines|isBlank)\b/, "String.strip/repeat/lines/isBlank (Java 11+)"],
  [/\bStream\.toList\b/, "Stream.toList (Java 16)"],
  [/\.toList\(\)\s*;?\s*$/, ".toList() (Java 16, 疑似 Stream 终结)"],
  [/\bHttpClient\b/, "HttpClient (Java 11)"],
  [/\bvar\s+\w+\s*=/, "var 局部变量类型推断 (Java 10)"],
]
function scanJava9PlusApi(idx: Map<string, FileMeta>, targetSet: Set<string> | null, projectRoot: string): StaticFinding[] {
  const findings: StaticFinding[] = []
  for (const [abs, meta] of idx) {
    if (targetSet && !targetSet.has(meta.packageName.toUpperCase())) continue
    const lines = readFileLines(abs)
    lines.forEach((line, i) => {
      // 跳过注释行（粗略）
      const trimmed = line.trim()
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return
      for (const [re, desc] of JAVA9_API_PATTERNS) {
        if (re.test(line)) {
          findings.push({
            file: relativeToProject(abs, projectRoot),
            line: i + 1,
            rule: "java9-plus-api",
            severity: "critical",
            category: "version-compliance",
            tool: "java9api",
            packageName: meta.packageName,
            message: `使用了 Java 9+ API：${desc}（目标 JDK 8）`,
          })
          break
        }
      }
    })
  }
  return findings
}

/** #17/#19/#20-completeness：测试方法空体 + `// TODO: [test]`/`[mapper-test]` 残留 */
function scanTestCompleteness(artifactsDir: string, projectRoot: string, targetSet: Set<string> | null): StaticFinding[] {
  const findings: StaticFinding[] = []
  const scaffoldPath = join(artifactsDir, "scaffold.json")
  if (!existsSync(scaffoldPath)) return findings
  let scaffold: any
  try { scaffold = JSON.parse(readFileSync(scaffoldPath, "utf-8")) } catch { return findings }
  const shells = [
    ...((scaffold?.generated?.testShells ?? []) as any[]),
    ...((scaffold?.generated?.mapperTestShells ?? []) as any[]),
  ]
  for (const sh of shells) {
    if (targetSet && sh.oraclePackage && !targetSet.has(String(sh.oraclePackage).toUpperCase())) continue
    const abs = resolve(projectRoot, sh.file)
    const lines = readFileLines(abs)
    if (lines.length === 0) continue
    lines.forEach((line, i) => {
      if (line.includes("// TODO: [test]") || line.includes("// TODO: [mapper-test]")) {
        findings.push({
          file: relativeToProject(abs, projectRoot),
          line: i + 1,
          rule: "test-todo-remaining",
          severity: "major",
          category: "test-completeness",
          tool: "test-completeness",
          packageName: String(sh.oraclePackage ?? "UNKNOWN"),
          message: "未实现的测试方法占位（// TODO: [test]/[mapper-test]）",
        })
      }
    })
    // 空测试方法体：@Test 后若干行内出现 `{ }` / `{}` 紧邻
    for (let i = 0; i < lines.length; i++) {
      if (!/@Test\b/.test(lines[i])) continue
      for (let j = i; j < Math.min(i + 8, lines.length); j++) {
        if (/\{\s*\}/.test(lines[j])) {
          findings.push({
            file: relativeToProject(abs, projectRoot),
            line: j + 1,
            rule: "empty-test-method",
            severity: "major",
            category: "test-completeness",
            tool: "test-completeness",
            packageName: String(sh.oraclePackage ?? "UNKNOWN"),
            message: "空测试方法体（无 arrange→act→assert）",
          })
          break
        }
        if (lines[j].includes("{") && !lines[j].includes("}")) break // 方法体已展开，非空
      }
    }
  }
  return findings
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 扫描静态规约问题，写 review-static.json。
 * mode="incremental" + targetPkgs：只重扫 fixedPackages 涉及文件，与旧 review-static.json 合并
 * （删旧中 targetPkgs 的 finding 再加新）。归因统一在此做。
 */
export function scanReviewStatic(
  artifactsDir: string,
  projectRoot: string,
  opts?: { targetPackages?: readonly string[]; mode?: "full" | "incremental" },
): ReviewScanResult {
  const mode = opts?.mode ?? "full"
  const targetPkgs = opts?.targetPackages
  const targetSet = targetPkgs && targetPkgs.length > 0
    ? new Set(targetPkgs.map(p => p.toUpperCase()))
    : null

  // 全量索引用于归因（checkstyle/pmd finding 的 file 路径需匹配到包）
  const idx = buildFileIndex(artifactsDir, projectRoot)
  const totalPackages = new Set([...idx.values()].map(m => m.packageName)).size

  const toolSkipped = { checkstyle: false, pmd: false }
  let findings: StaticFinding[] = []

  // checkstyle / pmd（mvn 驱动；不可用 → skip + 标记，reviewer 据此回退 LLM）
  const cs = runCheckstyle(projectRoot)
  if (cs === null) {
    toolSkipped.checkstyle = true
  } else {
    const attributed = cs.map(f => {
      const a = attribute(f.file, idx, projectRoot)
      return { ...f, file: a.file, packageName: a.packageName }
    })
    findings.push(...(mode === "incremental" && targetSet
      ? attributed.filter(f => targetSet.has(f.packageName.toUpperCase()) || f.packageName === "UNKNOWN")
      : attributed))
  }

  const pmd = runPmd(projectRoot)
  if (pmd === null) {
    toolSkipped.pmd = true
  } else {
    const attributed = pmd.map(f => {
      const a = attribute(f.file, idx, projectRoot)
      return { ...f, file: a.file, packageName: a.packageName }
    })
    findings.push(...(mode === "incremental" && targetSet
      ? attributed.filter(f => targetSet.has(f.packageName.toUpperCase()) || f.packageName === "UNKNOWN")
      : attributed))
  }

  // grep 脚本（不依赖 mvn，照跑）
  findings.push(...scanTodoRemaining(idx, targetSet, projectRoot))
  findings.push(...scanJava9PlusApi(idx, targetSet, projectRoot))
  findings.push(...scanTestCompleteness(artifactsDir, projectRoot, targetSet))

  // 增量合并：保留旧 review-static.json 中非 targetPkgs 的 finding
  if (mode === "incremental" && targetSet) {
    const prevPath = join(artifactsDir, "review-static.json")
    if (existsSync(prevPath)) {
      try {
        const prev = JSON.parse(readFileSync(prevPath, "utf-8")) as { findings?: StaticFinding[] }
        const kept = (prev.findings ?? []).filter(f => !targetSet.has(f.packageName.toUpperCase()))
        findings = [...kept, ...findings]
      } catch { /* ignore，用本次结果 */ }
    }
  }

  const result: ReviewScanResult = {
    findings,
    toolSkipped,
    scanMode: mode,
    scanStats: { totalPackages, totalFilesScanned: idx.size },
  }

  const out = {
    findings: result.findings,
    toolSkipped: result.toolSkipped,
    scanMode: result.scanMode,
    generatedAt: new Date().toISOString(),
    scanStats: result.scanStats,
  }
  const r = ReviewStaticSchema.safeParse(out)
  if (!r.success) {
    getLogger().error("[review-scanner]", `review-static.json schema 校验失败: ${JSON.stringify(r.error.issues)}`)
    // 仍写出未校验结果，避免阻断 pipeline（summary 容错读 findings）
  }
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(join(artifactsDir, "review-static.json"), JSON.stringify(out, null, 2), "utf-8")
  getLogger().info(
    "[review-scanner]",
    `扫描完成 mode=${mode}: ${findings.length} findings, checkstyle=${toolSkipped.checkstyle ? "skip" : "ok"}, pmd=${toolSkipped.pmd ? "skip" : "ok"}`,
  )
  return result
}

// TODO(Stage 3): 接入 #2 scanMyBatisCompleteness（PL/SQL DML ↔ MyBatis statement 对照）、
// #4 scanTypeMapping（plan.typeMappings ↔ Java 字段类型，需轻量类型解析）、
// #9 scanNamingConsistency（translation.subprogramMethods 过程名↔方法名可追溯性）、
// #14 scanChineseComments（英文注释，保守 minor，避免噪声）。
