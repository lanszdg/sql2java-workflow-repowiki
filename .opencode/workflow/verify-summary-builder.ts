/**
 * Verify Summary Builder — verify 阶段确定性 reduce（零 LLM），只做**动态**检查。
 *
 * 职责分离（与 review 互补）：
 *   - review = 静态检查（读代码判断正确性、MyBatis 结构、`// TODO: [translate]` 等，#10 已统计）
 *   - verify = 动态检查（实际跑 `mvn compile` / `mvn test`，归因编译/测试失败）
 *
 * agent 只跑 mvn（输出 tee 到 verify-compile.log / verify-test.log）+ 调本 action。代码：
 *   1. 解析 mvn 日志 → compilation{success,errors} / testExecution{totals,testErrors}；
 *   2. 编译错误按文件、测试失败按测试类归因到包（plan.json packageMappings + translation.json files[]）；
 *   3. 聚合 verify-summary.json（allPassed = 全包无归因失败 且编译通过；全局编译失败由 G5 兜底阻断）。
 *
 * 不再写 per-package verify.json（静态字段已归 review，动态归因结果落在 summary.packageResults）。
 * MyBatis/TODO 等静态字段在 summary 中为占位（mybatisValid=true / totalTodosRemaining=0）——
 * 真值在 review-summary，verify-summary 只承载动态结果。
 *
 * 与 buildDependencyGraphFromIndex / buildReviewSummary 同构。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { z } from "zod"
import { PlanSchema, VerifySummarySchema } from "./artifact-schemas"
import { formatZodIssues, readScopePackagesFromArtifacts } from "./engine-core"
import { getLogger } from "./workflow-logger"
import { COVERAGE_LINE_THRESHOLD, COVERAGE_BRANCH_THRESHOLD } from "./constants"

const COMPILE_LOG = "verify-compile.log"
const TEST_LOG = "verify-test.log"
const JACOCO_XML_REL = join("target", "site", "jacoco", "jacoco.xml")
const COVERAGE_GAPS_MD = "coverage-gaps.md"
/** 业务代码源码根（相对 projectRoot），用于扫描被 jacoco excludes 排除的类 */
const MAIN_JAVA_REL = join("src", "main", "java")

interface CompileError { file: string; line: number; message: string }
interface TestError { testClass: string; testMethod: string; message: string; testType?: "unit" | "integration" }
interface PkgFiles { javaFiles: string[] }

interface JacocoGap { className: string; line: number; type: "line" | "branch" }
interface JacocoClass {
  /** 源文件相对路径（package name + sourcefilename，/ 分隔），用于归因到 Oracle 包 */
  relPath: string
  sourceFileName: string
  lineMissed: number
  lineCovered: number
  branchMissed: number
  branchCovered: number
  gaps: JacocoGap[]
}
interface CoverageResult {
  executed: boolean
  skipReason?: string
  lineRate: number | null
  branchRate: number | null
  lineThreshold: number
  branchThreshold: number
  passed: boolean
  packageCoverage: Array<{
    packageName: string
    lineRate: number | null
    branchRate: number | null
    passed: boolean
    gaps?: JacocoGap[]
  }>
}

export function buildVerifySummary(artifactsDir: string): {
  packageCount: number
  allPassed: boolean
  compilationSuccess: boolean
  testsPassed: number | null
  totalTests: number | null
  coveragePassed: boolean | null
  lineRate: number | null
  branchRate: number | null
  warnings: string[]
} {
  const warnings: string[] = []
  const projectRoot = readProjectRoot(artifactsDir)
  const packages = readPackageList(artifactsDir)
  const packageMappings = readPackageMappings(artifactsDir)

  // ── 1. 解析 mvn 日志 ──
  const compileLogPath = join(artifactsDir, COMPILE_LOG)
  const testLogPath = join(artifactsDir, TEST_LOG)
  const compileLog = existsSync(compileLogPath) ? readFileSync(compileLogPath, "utf-8") : null
  const testLog = existsSync(testLogPath) ? readFileSync(testLogPath, "utf-8") : null

  const envSkipped = !compileLog && !testLog
  const compilation = compileLog
    ? parseCompileLog(compileLog, warnings)
    : { success: false, skipped: true, skipReason: "Maven/JDK 未安装或未运行 mvn compile，编译验证已跳过" }
  const testExecution = testLog
    ? parseTestLog(testLog, warnings)
    : { executed: false, skipReason: "Maven/JDK 未安装或未运行 mvn test，测试执行已跳过", testFiles: [] }

  // ── 1b. 解析 jacoco.xml（覆盖率） ──
  const coverage = buildCoverage(artifactsDir, projectRoot, packages, warnings)

  // ── 2. 逐包归因编译/测试失败 + 覆盖率 ──
  const pkgCoverageByName = new Map(coverage.packageCoverage.map(pc => [pc.packageName.toUpperCase(), pc]))
  const packageResults = packages.map(pkg => {
    const files = locatePkgFiles(artifactsDir, pkg, warnings)
    let passed = true

    if (compilation.errors) {
      for (const err of compilation.errors) {
        if (fileBelongsToPkg(err.file, files)) passed = false
      }
    }
    if (testExecution.testErrors) {
      for (const te of testExecution.testErrors) {
        if (testBelongsToPkg(te.testClass, packageMappings, pkg)) passed = false
      }
    }
    // 覆盖率不达标的包也判为未通过（统一归因，供 fix 增量补测）
    const pc = pkgCoverageByName.get(pkg.toUpperCase())
    if (pc && !pc.passed) passed = false
    return { packageName: pkg, passed, mybatisValid: true }
  })
  // GLOBAL（未归因到 inventory 包的 class）覆盖率不达标时追加条目拉低 allPassed，
  // 满足 allPassedRefine（allPassed === packageResults.every）。达标时不追加，避免干扰 inventory 包视图。
  const globalPc = pkgCoverageByName.get("GLOBAL")
  if (globalPc && !globalPc.passed) {
    packageResults.push({ packageName: "GLOBAL", passed: false, mybatisValid: true })
  }

  if (packageResults.length === 0) {
    throw new Error("未找到任何 inventory 包，无法聚合 verify-summary")
  }

  // ── 3. 聚合 verify-summary.json ──
  // allPassed 须与 packageResults.every(passed) 一致（allPassedRefine）且覆盖率达标（coverage refine）；
  // 全局编译失败由 G5 兜底阻断。env 跳过时 coverage.passed=true 不阻断。
  const allPassed = packageResults.every(p => p.passed) && coverage.passed
  const summary = {
    allPassed,
    compilation,
    packageResults,
    testExecution,
    totalTodosRemaining: 0, // TODO 统计已归 review（review-summary.totalTodosRemaining）；verify 不再统计
    coverage,
    unresolvedIssues: envSkipped
      ? [{ packageName: "GLOBAL", issue: "编译环境不可用（Maven/JDK 未安装或未运行 mvn），编译验证和测试执行已跳过，请手动执行" }]
      : (compilation.errors ?? [])
          .filter(e => !packages.some(pkg => fileBelongsToPkg(e.file, locatePkgFiles(artifactsDir, pkg, warnings))))
          .map(e => ({ packageName: "GLOBAL", issue: `未归因到包的编译错误：${e.file}:${e.line} ${e.message}` })),
  }
  const validated = VerifySummarySchema.safeParse(summary)
  if (!validated.success) {
    throw new Error(`verify-summary 聚合结果校验失败:\n${formatZodIssues(validated.error)}`)
  }
  writeFileSync(join(artifactsDir, "verify-summary.json"), JSON.stringify(validated.data, null, 2), "utf-8")

  // ── 3b. 写人类可读覆盖率报告 coverage-gaps.md ──
  writeFileSync(join(artifactsDir, COVERAGE_GAPS_MD), buildCoverageGapsMd(coverage, projectRoot, warnings), "utf-8")

  getLogger().info(
    "[verify-summary]",
    `聚合 ${packageResults.length} 包: allPassed=${allPassed}, compile=${compilation.success}, tests=${testExecution.passedTests ?? "?"}/${testExecution.totalTests ?? "?"}, coverage=${coverage.executed ? `line=${(coverage.lineRate ?? -1).toFixed(2)}/branch=${(coverage.branchRate ?? -1).toFixed(2)} passed=${coverage.passed}` : "skipped"}, warnings=${warnings.length}`,
  )
  return {
    packageCount: packageResults.length,
    allPassed,
    compilationSuccess: compilation.success,
    testsPassed: testExecution.passedTests ?? null,
    totalTests: testExecution.totalTests ?? null,
    coveragePassed: coverage.executed ? coverage.passed : null,
    lineRate: coverage.lineRate,
    branchRate: coverage.branchRate,
    warnings,
  }
}

// ═══════════════════════════════════════════════════════════════
// 输入读取
// ═══════════════════════════════════════════════════════════════

function readProjectRoot(artifactsDir: string): string {
  const scaffold = readJson(join(artifactsDir, "scaffold.json"))
  const pr = scaffold?.projectRoot
  if (typeof pr !== "string" || !pr) throw new Error("scaffold.json 缺少 projectRoot，无法定位 Java 项目")
  return pr
}

/**
 * 期望覆盖包集：scoped run 用 metadata.scopePackages（lazy inventory 下 inventory.packageNames
 * 与 scope 同源——call-closure ∪ 1-hop const-leaf，断传递后两者相等）；非 scoped 回退 inventory.packageNames。
 */
function readPackageList(artifactsDir: string): string[] {
  const scopePkgs = readScopePackagesFromArtifacts(artifactsDir)
  if (scopePkgs) return scopePkgs
  const inv = readJson(join(artifactsDir, "inventory.json"))
  const names = (inv?.packageNames as string[]) ?? []
  return names.filter((n): n is string => typeof n === "string" && n.length > 0)
}

type PkgMappingLite = z.infer<typeof PlanSchema>["packageMappings"][number]

function readPackageMappings(artifactsDir: string): PkgMappingLite[] {
  const plan = readJson(join(artifactsDir, "plan.json"))
  return (plan?.packageMappings as PkgMappingLite[]) ?? []
}

function readJson(path: string): any {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return null }
}

/** 定位一个包的全部 Java 文件（相对 projectRoot），用于编译错误按文件归因 */
function locatePkgFiles(artifactsDir: string, pkg: string, warnings: string[]): PkgFiles {
  const dir = findDirCaseInsensitive(join(artifactsDir, "translations"), pkg)
  if (!dir) {
    warnings.push(`包 ${pkg}: translations/ 下找不到目录，编译错误无法按文件归因`)
    return { javaFiles: [] }
  }
  const trans = readJson(join(artifactsDir, "translations", dir, "translation.json"))
  const files = (trans?.files as Array<{ path?: string; role?: string; javaConstruct?: string }>) ?? []
  const javaFiles: string[] = []
  for (const f of files) {
    const path = f.path ?? f.javaConstruct
    if (typeof path === "string" && path) javaFiles.push(path)
  }
  return { javaFiles }
}

// ═══════════════════════════════════════════════════════════════
// mvn 日志解析
// ═══════════════════════════════════════════════════════════════

function parseCompileLog(log: string, warnings: string[]): {
  success: boolean; skipped?: boolean; skipReason?: string; errors?: CompileError[]
} {
  const success = /BUILD SUCCESS/.test(log)
  const errors: CompileError[] = []
  // Maven javac: [ERROR] /path/File.java:[12,34] message  或  [ERROR] path/File.java:[12] message
  const re = /^\[ERROR\]\s+(.+?\.java):\[(\d+)(?:,\d+)?\]\s+(.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(log)) !== null) {
    errors.push({ file: m[1].trim(), line: parseInt(m[2], 10), message: m[3].trim() })
  }
  if (!success && errors.length === 0) {
    warnings.push("compile 日志检测到 BUILD FAILURE 但未抽到 .java 行号错误（可能是依赖/插件错误，将作为 unresolvedIssues）")
  }
  return { success, errors }
}

function parseTestLog(log: string, warnings: string[]): {
  executed: boolean
  skipReason?: string
  totalTests?: number | null
  passedTests?: number | null
  failedTests?: number | null
  testErrors?: TestError[]
  testFiles: string[]
} {
  const summaryLines = [...log.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g)]
  if (summaryLines.length === 0) {
    return { executed: false, skipReason: "未从 mvn test 日志解析到 Surefire 汇总（测试可能未执行或格式异常）", testFiles: [] }
  }
  let total = 0, failures = 0, errors = 0, skipped = 0
  for (const s of summaryLines) {
    total += parseInt(s[1], 10); failures += parseInt(s[2], 10); errors += parseInt(s[3], 10); skipped += parseInt(s[4], 10)
  }
  const failedTests = failures + errors
  const testErrors: TestError[] = []
  // Surefire 失败标记：<<< FAILURE! - [com.x.OrderServiceImplTest.createOrder_shouldComplete]
  const failRe = /<<< (?:FAILURE|ERROR)!\s*-\s*\[([^\]\s]+)\]/g
  let fm: RegExpExecArray | null
  while ((fm = failRe.exec(log)) !== null) {
    const qualified = fm[1]
    const lastDot = qualified.lastIndexOf(".")
    const testClass = lastDot > 0 ? qualified.slice(0, lastDot) : qualified
    const testMethod = lastDot > 0 ? qualified.slice(lastDot + 1) : ""
    testErrors.push({
      testClass,
      testMethod,
      message: "测试失败/错误（详见 mvn test 日志）",
      testType: /IntegrationTest/.test(testClass) ? "integration" : "unit",
    })
  }
  if (failedTests > 0 && testErrors.length === 0) {
    warnings.push(`test 日志显示 ${failedTests} 个失败但未抽到 <<< FAILURE 行，失败明细可能不全`)
  }
  return {
    executed: true,
    totalTests: total,
    passedTests: total - failedTests - skipped,
    failedTests,
    testErrors,
    testFiles: [],
  }
}

// ═══════════════════════════════════════════════════════════════
// 归因
// ═══════════════════════════════════════════════════════════════

/** 编译错误文件是否属于本包（按 translation.json files[] 路径后缀匹配，大小写不敏感） */
function fileBelongsToPkg(errFile: string, files: PkgFiles): boolean {
  const errNorm = errFile.replace(/\\/g, "/").toLowerCase()
  for (const rel of files.javaFiles) {
    if (errNorm.endsWith(rel.replace(/\\/g, "/").toLowerCase())) return true
  }
  return false
}

/**
 * jacoco class 源文件路径（短，无 src/main/java 前缀，如 com/example/a/AAggregate.java）
 * 是否属于本包——按 translation.json files[] 长路径后缀匹配（file.endsWith(classRelPath)），
 * 与 fileBelongsToPkg 方向相反（后者是 errFile 长路径 endsWith file 短路径）。
 */
function classBelongsToPkg(classRelPath: string, files: PkgFiles): boolean {
  const classNorm = classRelPath.replace(/\\/g, "/").toLowerCase()
  for (const f of files.javaFiles) {
    if (f.replace(/\\/g, "/").toLowerCase().endsWith(classNorm)) return true
  }
  return false
}

/** 测试类是否属于本包（按 plan.json packageMappings 的组件类名 + Test/IntegrationTest 后缀精确匹配） */
function testBelongsToPkg(
  testClass: string,
  mappings: PkgMappingLite[],
  pkg: string,
): boolean {
  const m = mappings.find(mp => mp.oraclePackage?.toUpperCase() === pkg.toUpperCase())
  if (!m) return false
  // Surefire 的 <<< FAILURE! - [Class.method] 中 Class 可能是全限定名（com.a.AAccessImplTest），
  // 取简单类名。测试类命名约定：单元测试 = {组件类}Test，Mapper 集成测试 = {MapperInterface}IntegrationTest。
  // 用精确后缀匹配（组件类名 + Test/IntegrationTest），避免 startsWith 跨包前缀碰撞
  // （如 ItemAggregate 误命中 ItemAggregateV2Test）。
  const simple = testClass.slice(testClass.lastIndexOf(".") + 1).toLowerCase()
  for (const c of [m.accessImpl, m.accessIntf, m.aggregate, m.processor, m.builder, m.validator, m.serviceImplClass, m.serviceClass]) {
    if (typeof c !== "string" || c === "N/A") continue
    const base = c.toLowerCase()
    if (simple === base + "test" || simple === base + "integrationtest") return true
  }
  return false
}

function findDirCaseInsensitive(parent: string, name: string): string | undefined {
  if (!existsSync(parent)) return undefined
  const target = name.toUpperCase()
  for (const e of readdirSync(parent, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.toUpperCase() === target) return e.name
  }
  return undefined
}

// ═══════════════════════════════════════════════════════════════
// JaCoCo 覆盖率解析
// ═══════════════════════════════════════════════════════════════

/** 从 XML 属性串中提取命名属性值，缺失返回 "0" */
function attr(s: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s)
  return m ? m[1] : "0"
}

function sum<T>(arr: T[], f: (x: T) => number): number {
  let s = 0
  for (const x of arr) s += f(x)
  return s
}

/** 覆盖率：missed+covered==0（无该类型计数）视为 1.0，不拉低整体 */
function rate(missed: number, covered: number): number {
  return missed + covered === 0 ? 1 : covered / (missed + covered)
}

function thresholdPassed(lineRate: number, branchRate: number): boolean {
  return lineRate >= COVERAGE_LINE_THRESHOLD && branchRate >= COVERAGE_BRANCH_THRESHOLD
}

/**
 * 解析 jacoco.xml（无 XML 库依赖，正则提取）。
 * 结构：<package name="..."> <class name sourcefilename> <counter type=LINE/BRANCH missed covered/> </class>
 *                          <sourcefile name> <line nr mi ci mb cb/> </sourcefile> </package>
 * class 级 counter 给覆盖率分子分母；sourcefile 的 <line> 给未覆盖行/分支明细（gaps）。
 */
function parseJacocoXml(xml: string, warnings: string[]): JacocoClass[] {
  const classes: JacocoClass[] = []
  const pkgRe = /<package\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/package>/g
  let pm: RegExpExecArray | null
  while ((pm = pkgRe.exec(xml)) !== null) {
    const pkgName = pm[1] // / 分隔的目录路径
    const pkgBody = pm[2]
    // class 级 counter（按 sourcefilename 索引）
    const classCounters = new Map<string, { lineMissed: number; lineCovered: number; branchMissed: number; branchCovered: number }>()
    const classRe = /<class\s+name="[^"]+"[^>]*?sourcefilename="([^"]+)"[^>]*?>([\s\S]*?)<\/class>/g
    let cm: RegExpExecArray | null
    while ((cm = classRe.exec(pkgBody)) !== null) {
      const sourceFileName = cm[1]
      const body = cm[2]
      const lineC = /<counter\s+type="LINE"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/.exec(body)
      const branchC = /<counter\s+type="BRANCH"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/.exec(body)
      classCounters.set(sourceFileName, {
        lineMissed: lineC ? parseInt(lineC[1], 10) : 0,
        lineCovered: lineC ? parseInt(lineC[2], 10) : 0,
        branchMissed: branchC ? parseInt(branchC[1], 10) : 0,
        branchCovered: branchC ? parseInt(branchC[2], 10) : 0,
      })
    }
    // sourcefile 行级明细 → gaps
    const sfRe = /<sourcefile\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g
    let sfm: RegExpExecArray | null
    while ((sfm = sfRe.exec(pkgBody)) !== null) {
      const sourceFileName = sfm[1]
      const counters = classCounters.get(sourceFileName)
      if (!counters) continue // 无对应 class 计数（理论上不发生），跳过
      const gaps: JacocoGap[] = []
      const classNameFqn = `${pkgName}/${sourceFileName.replace(/\.java$/, "")}`
      const lineRe = /<line\s+([^>]*?)\/>/g
      let lm: RegExpExecArray | null
      while ((lm = lineRe.exec(sfm[2])) !== null) {
        const a = lm[1]
        const nr = parseInt(attr(a, "nr"), 10)
        const mi = parseInt(attr(a, "mi"), 10)
        const ci = parseInt(attr(a, "ci"), 10)
        const mb = parseInt(attr(a, "mb"), 10)
        if (mi > 0 && ci === 0) gaps.push({ className: classNameFqn, line: nr, type: "line" })
        if (mb > 0) gaps.push({ className: classNameFqn, line: nr, type: "branch" })
      }
      classes.push({
        relPath: `${pkgName}/${sourceFileName}`,
        sourceFileName,
        ...counters,
        gaps,
      })
    }
  }
  if (classes.length === 0) warnings.push("jacoco.xml 解析未抽到任何 class（报告可能为空或格式异常）")
  return classes
}

/** 构造覆盖率结果：读 jacoco.xml → 解析 → 归因到包 → 算 rate/passed */
function buildCoverage(artifactsDir: string, projectRoot: string, packages: string[], warnings: string[]): CoverageResult {
  const noop = (skipReason: string): CoverageResult => ({
    executed: false,
    skipReason,
    lineRate: null,
    branchRate: null,
    lineThreshold: COVERAGE_LINE_THRESHOLD,
    branchThreshold: COVERAGE_BRANCH_THRESHOLD,
    passed: true, // 环境不可用时不阻断，与 mvn 跳过语义一致
    packageCoverage: [],
  })

  const xmlPath = join(projectRoot, JACOCO_XML_REL)
  if (!existsSync(xmlPath)) {
    warnings.push(`未找到 jacoco.xml（${JACOCO_XML_REL}），覆盖率统计已跳过`)
    return noop(`未找到 jacoco.xml（mvn test jacoco:report 未运行或未生成报告），覆盖率统计已跳过`)
  }

  let classes: JacocoClass[]
  try {
    classes = parseJacocoXml(readFileSync(xmlPath, "utf-8"), warnings)
  } catch (e: any) {
    warnings.push(`解析 jacoco.xml 失败: ${e.message}`)
    return noop(`解析 jacoco.xml 失败: ${e.message}`)
  }
  if (classes.length === 0) return noop("jacoco.xml 无 class 数据，覆盖率统计已跳过")

  // 应用覆盖率排除策略：beans/Application/Config/infrastructure 等无业务逻辑类不计入门控，
  // 避免数据载体类归因到 GLOBAL 后拉低覆盖率误伤 allPassed（与 coverage-gaps.md 报告同源）。
  const businessClasses = classes.filter(c => excludeReason(c.relPath) === null)
  if (businessClasses.length === 0) {
    return noop("jacoco.xml 全部 class 均被覆盖率排除策略排除（beans/Config/Application/infrastructure），无业务类可统计")
  }
  classes = businessClasses

  // pkg → files 缓存（复用 locatePkgFiles，按 Oracle 包归因）
  const pkgFilesCache = new Map<string, PkgFiles>()
  for (const pkg of packages) pkgFilesCache.set(pkg.toUpperCase(), locatePkgFiles(artifactsDir, pkg, warnings))

  const byPkg = new Map<string, JacocoClass[]>() // key = Oracle 包名或 GLOBAL
  for (const c of classes) {
    const owner = packages.find(p => classBelongsToPkg(c.relPath, pkgFilesCache.get(p.toUpperCase())!)) ?? "GLOBAL"
    const arr = byPkg.get(owner) ?? []
    arr.push(c)
    byPkg.set(owner, arr)
  }

  const lineRate = rate(sum(classes, c => c.lineMissed), sum(classes, c => c.lineCovered))
  const branchRate = rate(sum(classes, c => c.branchMissed), sum(classes, c => c.branchCovered))

  const packageCoverage = [...byPkg.entries()].map(([pkg, cs]) => {
    const lr = rate(sum(cs, c => c.lineMissed), sum(cs, c => c.lineCovered))
    const br = rate(sum(cs, c => c.branchMissed), sum(cs, c => c.branchCovered))
    return {
      packageName: pkg,
      lineRate: lr,
      branchRate: br,
      passed: thresholdPassed(lr, br),
      gaps: cs.flatMap(c => c.gaps),
    }
  })

  const passed = thresholdPassed(lineRate, branchRate) && packageCoverage.every(p => p.passed)
  return {
    executed: true,
    lineRate,
    branchRate,
    lineThreshold: COVERAGE_LINE_THRESHOLD,
    branchThreshold: COVERAGE_BRANCH_THRESHOLD,
    passed,
    packageCoverage,
  }
}

/** 项目覆盖率排除策略：beans/Application/Config/infrastructure 等无业务逻辑类不计入覆盖率。
 *  供覆盖率门控（buildCoverage）与报告（scanExcludedClasses → coverage-gaps.md）共用，
 *  避免数据载体类（Bean/Dto 等）拉低 GLOBAL 覆盖率误伤 allPassed。返回排除原因或 null。 */
function excludeReason(relPath: string): string | null {
  if (relPath.includes("/common/infrastructure/")) return "基础设施层（common/infrastructure，统一异常/日志/工具）"
  const base = relPath.slice(relPath.lastIndexOf("/") + 1)
  // 仅排除 beans/ 下的 *Bean.java（数据载体，与 pom jacoco exclude `**/beans/**Bean` 一致）。
  // 旧实现 `relPath.includes("/beans/")` 误排除 beans/ 下所有 .java——若含 *Mapper/*Validator/*Helper
  // 等逻辑类，会被静默踢出覆盖率门控，未覆盖逻辑类不再触发 allPassed=false，门控失效。
  if (relPath.includes("/beans/") && base.endsWith("Bean.java")) return "数据对象（beans/*Bean，纯数据载体）"
  if (base.endsWith("Config.java")) return "配置类（*Config，无业务逻辑）"
  if (base.endsWith("Application.java")) return "启动类（*Application，框架入口）"
  return null
}

/** 扫描 src/main/java 下所有 .java，列出被 jacoco excludes 排除的类（供 coverage-gaps.md 第 2 段） */
function scanExcludedClasses(projectRoot: string): Array<{ relPath: string; reason: string }> {
  const root = join(projectRoot, MAIN_JAVA_REL)
  if (!existsSync(root)) return []
  const out: Array<{ relPath: string; reason: string }> = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.name.endsWith(".java")) {
        const rel = relative(root, full).replace(/\\/g, "/")
        const r = excludeReason(rel)
        if (r) out.push({ relPath: `src/main/java/${rel}`, reason: r })
      }
    }
  }
  walk(root)
  return out
}

/** 生成人类可读覆盖率报告 coverage-gaps.md（未覆盖明细 / 未纳入统计范围 / 汇总） */
function buildCoverageGapsMd(coverage: CoverageResult, projectRoot: string, _warnings: string[]): string {
  const lines: string[] = ["# 覆盖率报告（JaCoCo）", ""]
  if (!coverage.executed) {
    lines.push("> ⚠️ 覆盖率统计已跳过", "", `原因：${coverage.skipReason ?? "未知"}`, "")
    return lines.join("\n")
  }
  const pct = (r: number | null) => (r == null ? "N/A" : `${(r * 100).toFixed(1)}%`)

  // ── 段 1：未覆盖明细 ──
  lines.push("## 1. 未覆盖明细（行 < 90% 或 分支 < 75% 的包）", "")
  const failed = coverage.packageCoverage.filter(p => !p.passed)
  if (failed.length === 0) {
    lines.push("所有包覆盖率达标，无未覆盖项。", "")
  } else {
    for (const p of failed) {
      lines.push(`### ${p.packageName}（行 ${pct(p.lineRate)} / 分支 ${pct(p.branchRate)}）`, "")
      const gaps = p.gaps ?? []
      if (gaps.length === 0) {
        lines.push("- 覆盖率低于阈值但无行级 gap（可能整方法未调用，检查测试是否覆盖该类入口）", "")
      } else {
        const byClass = new Map<string, JacocoGap[]>()
        for (const g of gaps) {
          const a = byClass.get(g.className) ?? []
          a.push(g)
          byClass.set(g.className, a)
        }
        for (const [cls, gs] of byClass) {
          lines.push(`- \`${cls.replace(/\//g, ".")}\``)
          for (const g of gs) {
            lines.push(
              `  - 行 ${g.line}：${g.type === "line" ? "行未覆盖（整行未执行，补正向用例）" : "分支未覆盖（if/else 缺失一支，补边界/异常用例）"}`,
            )
          }
        }
      }
      lines.push("")
    }
  }

  // ── 段 2：未纳入统计的范围 ──
  lines.push("## 2. 未纳入统计的范围（pom jacoco &lt;excludes&gt;，需人工另行保证）", "")
  const excluded = scanExcludedClasses(projectRoot)
  if (excluded.length === 0) {
    lines.push("- 未发现被排除的类（或 src/main/java 不存在）", "")
  } else {
    for (const e of excluded) lines.push(`- \`${e.relPath}\` — ${e.reason}`)
  }
  lines.push("")

  // ── 段 3：汇总 ──
  lines.push("## 3. 汇总", "")
  lines.push(`- 行覆盖率：${pct(coverage.lineRate)}（阈值 ${(coverage.lineThreshold * 100).toFixed(0)}%）`)
  lines.push(`- 分支覆盖率：${pct(coverage.branchRate)}（阈值 ${(coverage.branchThreshold * 100).toFixed(0)}%）`)
  lines.push(
    `- 是否达标：${coverage.passed ? "✅ 是" : "❌ 否"}（未达标包数 ${coverage.packageCoverage.filter(p => !p.passed).length}）`,
  )
  lines.push("")
  return lines.join("\n")
}
