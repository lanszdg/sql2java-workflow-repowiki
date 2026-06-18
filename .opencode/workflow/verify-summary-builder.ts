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
 * 与 buildAnalysisFromIndex / buildReviewSummary 同构。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { VerifySummarySchema } from "./artifact-schemas"
import { formatZodIssues } from "./engine-core"
import { getLogger } from "./workflow-logger"

const COMPILE_LOG = "verify-compile.log"
const TEST_LOG = "verify-test.log"

interface CompileError { file: string; line: number; message: string }
interface TestError { testClass: string; testMethod: string; message: string; testType?: "unit" | "integration" }
interface PkgFiles { javaFiles: string[] }

export function buildVerifySummary(artifactsDir: string): {
  packageCount: number
  allPassed: boolean
  compilationSuccess: boolean
  testsPassed: number | null
  totalTests: number | null
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

  // ── 2. 逐包归因编译/测试失败 ──
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
    return { packageName: pkg, passed, mybatisValid: true }
  })

  if (packageResults.length === 0) {
    throw new Error("未找到任何 inventory 包，无法聚合 verify-summary")
  }

  // ── 3. 聚合 verify-summary.json ──
  // allPassed 须与 packageResults.every(passed) 一致（allPassedRefine）；全局编译失败由 G5 兜底阻断
  const allPassed = packageResults.every(p => p.passed)
  const summary = {
    allPassed,
    compilation,
    packageResults,
    testExecution,
    totalTodosRemaining: 0, // TODO 统计已归 review（review-summary.totalTodosRemaining）；verify 不再统计
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
  getLogger().info(
    "[verify-summary]",
    `聚合 ${packageResults.length} 包: allPassed=${allPassed}, compile=${compilation.success}, tests=${testExecution.passedTests ?? "?"}/${testExecution.totalTests ?? "?"}, warnings=${warnings.length}`,
  )
  return {
    packageCount: packageResults.length,
    allPassed,
    compilationSuccess: compilation.success,
    testsPassed: testExecution.passedTests ?? null,
    totalTests: testExecution.totalTests ?? null,
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

function readPackageList(artifactsDir: string): string[] {
  const inv = readJson(join(artifactsDir, "inventory.json"))
  const names = (inv?.packageNames as string[]) ?? []
  return names.filter((n): n is string => typeof n === "string" && n.length > 0)
}

function readPackageMappings(artifactsDir: string): Array<{ oraclePackage: string; serviceClass?: string; serviceImplClass?: string }> {
  const plan = readJson(join(artifactsDir, "plan.json"))
  return (plan?.packageMappings as Array<{ oraclePackage: string; serviceClass?: string; serviceImplClass?: string }>) ?? []
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

/** 测试类是否属于本包（按 plan.json packageMappings 的 serviceImplClass/serviceClass 前缀匹配简单类名） */
function testBelongsToPkg(
  testClass: string,
  mappings: Array<{ oraclePackage: string; serviceClass?: string; serviceImplClass?: string }>,
  pkg: string,
): boolean {
  const m = mappings.find(mp => mp.oraclePackage?.toUpperCase() === pkg.toUpperCase())
  if (!m) return false
  // Surefire 的 <<< FAILURE! - [Class.method] 中 Class 可能是全限定名（com.a.AServiceImplTest），
  // 取简单类名再与服务实现类前缀匹配。
  const simple = testClass.slice(testClass.lastIndexOf(".") + 1).toLowerCase()
  for (const c of [m.serviceImplClass, m.serviceClass]) {
    if (typeof c === "string" && c !== "N/A" && simple.startsWith(c.toLowerCase())) return true
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
