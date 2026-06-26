/**
 * review-focus — Step B 聚焦语义审查的「信号选点 + 圈片段」（零 LLM，确定性）
 *
 * review dispatch 时由 engine 调用：对本分片 targetPackages 的每个 PROCEDURE，按各类信号
 * （complexity.high / manualReviewList / 游标 / 异常块 / 出参 / NVL·COALESCE / AUTONOMOUS_TRANSACTION）
 * 筛出需 LLM 语义审的过程，并用 translation.subprogramMethods 圈定 Java 方法锚点（软约束）+
 * inventory.lineRange 给 PL/SQL sed -n（硬约束）。产出 workOrder 注入的文本块。
 *
 * 设计见 [[review-static-redesign]] Stage 2 + [[translate-procedure-level]] 邻接讨论：
 *   - 信号归属最自然的阶段产物：#8 参数方向→inventory.params[].direction；#5/#7→analysis SubprogramSchema
 *     （exceptionHandlers/cursors）；#1→analysis.complexity + plan.manualReviewList；#3/#6→源码 grep
 *     （#6 未来可下沉 analyze SubprogramSchema.isAutonomous，现 grep）
 *   - 锚点 = 翻译单元（PROCEDURE），subprogramMethods.oracleName=refName 给 Java 方法定位
 *   - 无信号的纯 CRUD/低复杂度过程跳过语义审——靠 Step A 静态扫描兜底（省 LLM）
 *   - 复用 refname.ts 的 refNamesForPackage/pkgOf/refOf 解决重载 refName join
 *
 * 镜像 buildUnitScopeBlock 的 refMapForPkg + absSrc 模式（PL/SQL 源 sed -n 硬约束），
 * Java 用软约束锚点（javaFile+javaMethod，reviewer read 后按方法名定位——不搞引擎括号匹配）。
 */

import { existsSync, readFileSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { parseInventoryPackage, parseAnalysisPackage } from "./package-parser"
import { getLogger } from "./workflow-logger"

const MAX_FOCUS_POINTS = 30

interface ProcMeta { lineRange: [number, number]; bodyFile: string | null | undefined; hasOutParam: boolean }
interface SubprogMeta { hasCursors: boolean; hasExceptionHandlers: boolean }
interface JavaAnchor { javaClass: string; javaMethod: string; javaFile: string | null | undefined }
interface FocusPoint {
  unitRef: string
  pkg: string
  ref: string
  signals: string[] // 如 ["#1 logic-equivalence", "#7 cursor-mapping"]
  java: JavaAnchor | null
  plsqlAbs: string | null
  plsqlStart: number | null
  plsqlEnd: number | null
}
interface TestFocus { kind: "service" | "mapper"; absFile: string; testClass: string; pkg: string }

function readJson(p: string): any | null {
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf-8")) } catch { return null }
}

/** inventory-packages/{pkg}.json → refName → {lineRange, bodyFile, hasOutParam}（解析复用 parseInventoryPackage） */
function buildInvRefMap(artifactsDir: string, pkg: string): Map<string, ProcMeta> {
  const m = new Map<string, ProcMeta>()
  const parsed = parseInventoryPackage(artifactsDir, pkg)
  if (!parsed) return m
  const { refNames, procs, bodyFile } = parsed
  procs.forEach((p: any, i: number) => {
    const ref = refNames[i]
    if (!ref || !Array.isArray(p.lineRange) || p.lineRange.length !== 2) return
    const hasOutParam = Array.isArray(p.params) && p.params.some((prm: any) =>
      String(prm?.direction ?? "").toUpperCase() === "OUT" || String(prm?.direction ?? "").toUpperCase() === "IN OUT")
    m.set(ref, {
      lineRange: [Number(p.lineRange[0]), Number(p.lineRange[1])],
      bodyFile,
      hasOutParam,
    })
  })
  return m
}

/** analysis-packages/{pkg}.json → refName → {hasCursors, hasExceptionHandlers}（解析复用 parseAnalysisPackage） */
function buildAnaRefMap(artifactsDir: string, pkg: string): Map<string, SubprogMeta> {
  const m = new Map<string, SubprogMeta>()
  const parsed = parseAnalysisPackage(artifactsDir, pkg)
  if (!parsed) return m
  const { refNames, subprograms } = parsed
  subprograms.forEach((s: any, i: number) => {
    const ref = refNames[i]
    if (!ref) return
    m.set(ref, {
      hasCursors: Array.isArray(s.cursors) && s.cursors.length > 0,
      hasExceptionHandlers: Array.isArray(s.exceptionHandlers) && s.exceptionHandlers.length > 0,
    })
  })
  return m
}

/** translations/{pkg}/translation.json → refName → Java 锚点（subprogramMethods.oracleName=refName） */
function buildMethodMap(artifactsDir: string, pkg: string): Map<string, JavaAnchor> {
  const m = new Map<string, JavaAnchor>()
  const tr = readJson(join(artifactsDir, "translations", pkg, "translation.json"))
  if (!tr || !Array.isArray(tr.subprogramMethods)) return m
  for (const sm of tr.subprogramMethods) {
    if (!sm?.oracleName || !sm?.javaMethod) continue
    m.set(String(sm.oracleName), {
      javaClass: String(sm.javaClass ?? ""),
      javaMethod: String(sm.javaMethod),
      javaFile: sm.javaFile ?? null,
    })
  }
  return m
}

const RE_NULL = /\bNVL\s*\(|\bCOALESCE\s*\(|\bIS\s+NOT\s+NULL\b|\bIS\s+NULL\b/i
const RE_AUTONOMOUS = /AUTONOMOUS_TRANSACTION/i

/** 读 body 文件一次，返回按行切片的源码文本查找器（闭包缓存） */
function makeSourceSlice(bodyFileAbs: string | null | undefined): (s: number, e: number, re: RegExp) => boolean {
  if (!bodyFileAbs || !existsSync(bodyFileAbs)) return () => false
  let lines: string[] | null = null
  return (s, e, re) => {
    if (lines === null) {
      try { lines = readFileSync(bodyFileAbs, "utf-8").split("\n") } catch { lines = [] }
    }
    const slice = lines.slice(Math.max(0, s - 1), Math.max(0, e)).join("\n")
    return re.test(slice)
  }
}

/**
 * 构建本批 targetPackages 的 Step B 聚焦审查清单（workOrder 文本块）。
 * 无信号 / 无过程 → 返回空串（reviewer 按全量语义审回退）。
 */
export function buildReviewFocus(
  artifactsDir: string,
  targetPackages: readonly string[],
  sourcePath: string,
  projectRoot: string,
): string {
  if (!targetPackages || targetPackages.length === 0) return ""

  const analysis = readJson(join(artifactsDir, "analysis.json")) ?? {}
  const complexity = (analysis.complexity ?? {}) as Record<string, { riskLevel?: string }>
  const plan = readJson(join(artifactsDir, "plan.json")) ?? {}
  const manualReview = Array.isArray(plan.manualReviewList) ? plan.manualReviewList as Array<{ procedure?: string }> : []
  const scaffold = readJson(join(artifactsDir, "scaffold.json")) ?? {}

  const absSrc = (rel: string | null | undefined): string | null => {
    if (!rel) return null
    return isAbsolute(rel) ? rel : (sourcePath ? join(sourcePath, rel) : rel)
  }
  const absProj = (rel: string | null | undefined): string | null => {
    if (!rel) return null
    return isAbsolute(rel) ? rel : (projectRoot ? join(projectRoot, rel) : rel)
  }

  const focusPoints: FocusPoint[] = []
  const testFocus: TestFocus[] = []
  let skippedNoSignal = 0

  for (const pkg of targetPackages) {
    const invMap = buildInvRefMap(artifactsDir, pkg)
    const anaMap = buildAnaRefMap(artifactsDir, pkg)
    const methodMap = buildMethodMap(artifactsDir, pkg)

    // body 文件路径在 invMap 各过程一致（同包同 body），取首个非空
    const bodyFileRel = [...invMap.values()].map(m => m.bodyFile).find(Boolean)
    const slice = makeSourceSlice(absSrc(bodyFileRel))

    for (const [ref, meta] of invMap) {
      const signals: string[] = []
      const ckey = `${pkg}.${ref}`
      const isHigh = String(complexity[ckey]?.riskLevel ?? "").toLowerCase() === "high"
      const refU = ref.toUpperCase()
      const inManual = manualReview.some(mr => {
        const mp = String(mr?.procedure ?? "").toUpperCase()
        return mp === refU || (mp && refU.startsWith(mp + "__"))
      })
      if (isHigh || inManual) signals.push("#1 logic-equivalence")
      const ana = anaMap.get(ref)
      if (ana?.hasExceptionHandlers) signals.push("#5 exception-mapping")
      if (ana?.hasCursors) signals.push("#7 cursor-mapping")
      if (meta.hasOutParam) signals.push("#8 parameter-direction")
      if (slice(meta.lineRange[0], meta.lineRange[1], RE_NULL)) signals.push("#3 null-handling")
      if (slice(meta.lineRange[0], meta.lineRange[1], RE_AUTONOMOUS)) signals.push("#6 transaction-boundary")

      if (signals.length === 0) { skippedNoSignal++; continue }
      const jm = methodMap.get(ref) ?? null
      focusPoints.push({
        unitRef: `${pkg}.${ref}`, pkg, ref, signals,
        java: jm,
        plsqlAbs: absSrc(meta.bodyFile),
        plsqlStart: meta.lineRange[0],
        plsqlEnd: meta.lineRange[1],
      })
    }

    // 测试审查（#18/#20）：本包 testShells / mapperTestShells
    const testShells = (scaffold?.generated?.testShells ?? []) as any[]
    const mapperShells = (scaffold?.generated?.mapperTestShells ?? []) as any[]
    for (const sh of testShells) {
      if (String(sh?.oraclePackage ?? "").toUpperCase() !== pkg.toUpperCase()) continue
      testFocus.push({ kind: "service", absFile: absProj(sh.file) ?? String(sh.file), testClass: String(sh.testClass ?? ""), pkg })
    }
    for (const sh of mapperShells) {
      if (String(sh?.oraclePackage ?? "").toUpperCase() !== pkg.toUpperCase()) continue
      testFocus.push({ kind: "mapper", absFile: absProj(sh.file) ?? String(sh.file), testClass: String(sh.testClass ?? ""), pkg })
    }
  }

  if (focusPoints.length === 0 && testFocus.length === 0) {
    getLogger().info("[review-focus]", `无聚焦点（${skippedNoSignal} 个过程无信号），reviewer 按全量语义审回退`)
    return ""
  }

  const lines: string[] = [
    `## Step B 聚焦语义审查清单（只审这些点；#1-#9 语义，对照 PL/SQL 源码 + Java 方法）`,
    `仅对下列**有信号**的过程做语义审。无信号的纯 CRUD/低复杂度过程**跳过语义审**（靠 Step A 静态扫描兜底）。`,
    `机械类（#10-#20）已由 Step A 工具扫，勿重复。按 PL/SQL \`sed -n\` 抽源码段 + Java 方法锚点 \`read\` 后定位。`,
    ``,
  ]

  const overflow = focusPoints.length > MAX_FOCUS_POINTS
  const shown = focusPoints.slice(0, MAX_FOCUS_POINTS)
  for (const fp of shown) {
    lines.push(`### ${fp.unitRef} — 信号: ${fp.signals.join(", ")}`)
    if (fp.plsqlAbs && fp.plsqlStart && fp.plsqlEnd) {
      lines.push(`- PL/SQL 源: \`${fp.plsqlAbs}\` 行 ${fp.plsqlStart}-${fp.plsqlEnd} → \`sed -n '${fp.plsqlStart},${fp.plsqlEnd}p' '${fp.plsqlAbs}'\``)
    } else {
      lines.push(`- PL/SQL 源: lineRange 未找到（按 refName ${fp.ref} 自行在 inventory-packages/${fp.pkg}.json 定位）`)
    }
    if (fp.java) {
      const jabs = absProj(fp.java.javaFile) ?? fp.java.javaFile ?? "(javaFile 缺失)"
      lines.push(`- Java 方法: \`${jabs}\` 类 \`${fp.java.javaClass}\` 方法 \`${fp.java.javaMethod}\`（read 文件后按方法名定位）`)
    } else {
      lines.push(`- Java 方法: 未在 translations/${fp.pkg}/translation.json 的 subprogramMethods 找到 ${fp.ref}（按 translation.json 自行定位）`)
    }
    lines.push(`- 审: ${fp.signals.map(s => s.replace(/^#\d+\s*/, "")).join("、")}`)
  }
  if (overflow) {
    lines.push(``, `（聚焦点超 ${MAX_FOCUS_POINTS}，仅列前 ${MAX_FOCUS_POINTS}；余 ${focusPoints.length - MAX_FOCUS_POINTS} 个: ${focusPoints.slice(MAX_FOCUS_POINTS).map(f => f.unitRef).join(", ")}）`)
  }

  if (testFocus.length > 0) {
    lines.push(``, `### 测试审查（test-correctness #18 / mapper-test-correctness #20）`)
    for (const tf of testFocus) {
      const cat = tf.kind === "service" ? "test-correctness(#18)" : "mapper-test-correctness(#20)"
      lines.push(`- ${tf.kind === "service" ? "ServiceImpl 测试" : "Mapper 集成测试"}: \`${tf.absFile}\` 类 \`${tf.testClass}\` → 审 ${cat}`)
    }
  }

  if (skippedNoSignal > 0) {
    lines.push(``, `（另有 ${skippedNoSignal} 个过程无信号，跳过语义审——靠 Step A 静态扫描兜底）`)
  }

  getLogger().info("[review-focus]", `聚焦 ${focusPoints.length} 个过程 + ${testFocus.length} 个测试（跳过 ${skippedNoSignal} 无信号）`)
  return lines.join("\n")
}
