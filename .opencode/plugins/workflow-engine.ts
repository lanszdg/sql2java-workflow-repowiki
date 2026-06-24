/**
 * Workflow Engine Plugin — 适配 @opencode-ai/plugin
 *
 * 实现：
 *   - workflow 工具（7 个 action）
 *   - advance 时 Zod artifact 校验（D5）
 *   - system prompt 构建 + Runtime Context 注入（D11）
 *   - 阶段开始前注入 Schema 校验要求（D13）
 *   - 温度控制 + 工具过滤
 *   - 大输出截断
 *   - 依赖自动安装（node_modules 缺失时自动 npm/bun install）
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, realpathSync } from "node:fs"
import { join, dirname, resolve, sep, relative, isAbsolute } from "node:path"
import { safeWriteFile } from "../workflow/cross-platform"
import { WorkflowEngine, WorkflowEngineError, formatZodIssues, type WorkflowRun } from "../workflow/engine-core"
import { enhanceRejection } from "../workflow/rejection-guidance"
import { renderSchemaHint } from "../workflow/schema-hint-renderer"
import { SQL2JAVA_WORKFLOW } from "../workflow/workflow-definitions"
import { UPSTREAM_ARTIFACTS, PHASE_PREREQUISITES } from "../workflow/workflow-definitions"
import {
  getSchemaForPhase, getPerPackageSchema, getPerUnitSchema, getSummarySchema,
  getAnalysisPackageSchema, getInventoryPackageSchema,
  getArtifactFilename, AnalysisMetaSchema,
} from "../workflow/artifact-schemas"
import { scanSource } from "../workflow/plsql-scanner"
import { refNamesForPackage, pkgOf, refOf } from "../workflow/refname"
import { buildInventoryFromIndex } from "../workflow/inventory-builder"
import { buildAnalysisFromIndex } from "../workflow/analysis-builder"
import { buildReviewSummary } from "../workflow/review-summary-builder"
import { buildVerifySummary } from "../workflow/verify-summary-builder"
import { ensureDeps, findOpencodeDir } from "../workflow/ensure-deps"
import {
  PhaseMetricsCollector,
  generateRunMetrics, formatPhaseReport, formatFinalReport,
  formatDuration,
} from "../workflow/phase-metrics-collector"
import type { PhaseMetrics } from "../workflow/phase-metrics-collector"
import { initLogger, getLogger, destroyLogger } from "../workflow/workflow-logger"

const engine = new WorkflowEngine()
engine.registerDefinition(SQL2JAVA_WORKFLOW)
const ARTIFACT_DIR = ".workflow-artifacts"

let currentWorkflowContext: {
  runId: string
  phase: string
  agentFile: string
  temperature: number
} | null = null

let activeCollector: PhaseMetricsCollector | null = null

/** 编排 session ID 集合 — chat.params hook 中记录，system.transform hook 中用于跳过编排 session 的 prompt 注入 */
const orchestratorSessionIds = new Set<string>()

/**
 * 生成 run-<project>-YYYYMMDD-HHMMSS 格式的 runId。
 * project 取 sourcePath 的 basename（净化为文件名安全字符），缺失/为空时用 unknown 占位，
 * 便于在 .workflow-artifacts/ 下按项目区分多次运行。runId 仅作目录名 + 字符串 id，无格式反解析。
 */
export function formatRunId(sourcePath?: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  let proj = "unknown"
  if (sourcePath) {
    // 取最终路径段（兼容尾部斜杠/反斜杠）
    const base = sourcePath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? ""
    // 净化为文件名安全字符：非 [a-zA-Z0-9_-] → _，折叠连续 _，去首尾 _
    const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "")
    if (sanitized) proj = sanitized
  }
  return `run-${proj}-${ts}`
}

/**
 * run-context.json — 一次运行的输入参数 + 目录的稳固快照。
 * 与 run.json（引擎状态，会被引擎更新）互补：run-context.json 在 start 时写一次，
 * 记录用户原始输入与解析后参数，resume 时作为输入参数的兜底事实源。
 */
export interface RunContext {
  runId: string
  originalInput: string                  // 用户原始 $ARGUMENTS 文字，便于回溯
  params: {
    path?: string
    dbConf?: string
    specConf?: string
    mainEntry?: string
    phases?: string
    mode?: string
  }
  dirs: { artifacts: string; logs: string }
  createdAt: string
}

function runContextPath(runId: string): string {
  return join(ARTIFACT_DIR, runId, "run-context.json")
}

function writeRunContext(ctx: RunContext): void {
  const filePath = runContextPath(ctx.runId)
  const dir = join(ARTIFACT_DIR, ctx.runId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(ctx, null, 2), "utf-8")
}

function loadRunContext(runId: string): RunContext | null {
  try {
    const filePath = runContextPath(runId)
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, "utf-8")) as RunContext
  } catch {
    return null
  }
}

/** 从 agentFile 路径提取 agent 短名 (e.g. "agent/sql-analyst.md" → "sql-analyst") */
function agentFileToName(agentFile: string): string {
  return agentFile.replace(/^agent\//, "").replace(/\.md$/, "")
}

/** 已知的 subagent 名称（从 SQL2JAVA_WORKFLOW.phases 动态推导，避免硬编码不同步） */
function getSubagentNames(): string[] {
  return [...new Set(SQL2JAVA_WORKFLOW.phases.map(p => agentFileToName(p.agentFile)))]
}

/** fix 阶段序号追踪（同一 runId 内递增） */
const fixPhaseIndexMap = new Map<string, number>()

/** 跨 session 恢复 fixIndex：从 metrics/ 目录下已有的 fix-*.json 文件数推导序号 */
function recoverFixIndex(runId: string): number {
  const metricsDir = join(ARTIFACT_DIR, runId, "metrics")
  if (!existsSync(metricsDir)) return 0
  const existing = readdirSync(metricsDir).filter(f => /^fix-\d+\.json$/.test(f))
  return existing.length
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 格式化阶段开始 banner */
function formatPhaseStartBanner(phaseName: string | null | undefined): string {
  const safeName = phaseName ?? "unknown"
  const phaseConfig = SQL2JAVA_WORKFLOW.phases.find(p => p.name === safeName)
  const desc = phaseConfig?.description ?? safeName
  const isFix = phaseConfig?.isFixPhase ?? false
  // fix 是条件分支阶段，不属于主线 1-N 进度
  const mainPhases = SQL2JAVA_WORKFLOW.phases.filter(p => !p.isFixPhase)
  const rawIdx = mainPhases.findIndex(p => p.name === safeName)
  const idx = rawIdx === -1 ? 0 : rawIdx + 1
  const total = mainPhases.length
  const label = isFix
    ? `${safeName} — ${desc}`
    : `阶段 ${idx}/${total}：${safeName} — ${desc}`
  return [
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `▶ ${label}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ].join("\n")
}

/** 格式化阶段完成 banner */
function formatPhaseEndBanner(phaseName: string, duration?: string): string {
  if (!phaseName) return ""
  return [
    ``,
    `────────────────────────────────────────────────`,
    `✔ ${phaseName} 完成${duration ? ` (${duration})` : ""}`,
    `────────────────────────────────────────────────`,
    ``,
  ].join("\n")
}

function setWorkflowContext(run: WorkflowRun): void {
  const phaseConfig = SQL2JAVA_WORKFLOW.phases.find((p) => p.name === run.currentPhase)
  currentWorkflowContext = {
    runId: run.runId,
    phase: run.currentPhase ?? "unknown",
    agentFile: phaseConfig?.agentFile ?? "unknown",
    temperature: phaseConfig?.temperature ?? 0.1,
  }
  // ── Metrics: 创建 collector ──
  const isFix = phaseConfig?.isFixPhase
  const fixIndex = isFix ? nextFixIndex(run.runId) : undefined
  const artifactsDir = join(ARTIFACT_DIR, run.runId)
  activeCollector = new PhaseMetricsCollector(
    run.currentPhase ?? "unknown", run.runId, artifactsDir, fixIndex,
  )
}

/** 统一的 fixIndex 递增逻辑：优先读内存 Map，回退到磁盘文件计数 */
function nextFixIndex(runId: string): number {
  const existing = fixPhaseIndexMap.get(runId)
  const fixIndex = existing !== undefined ? existing + 1 : recoverFixIndex(runId) + 1
  fixPhaseIndexMap.set(runId, fixIndex)
  return fixIndex
}

/** 尝试将当前 collector 的数据持久化到磁盘（用于 abort/retry-exhausted 等非正常终止场景） */
function persistCollectorIfActive(runId: string): void {
  if (!activeCollector || !currentWorkflowContext) return
  try {
    const artifactsDir = join(ARTIFACT_DIR, runId)
    const snap = activeCollector.getSnapshot()
    if (snap.apiCallCount > 0 || snap.totalToolCallCount > 0) {
      activeCollector.persistAsIncomplete()
      getLogger().warn("[metrics]", `非正常终止时持久化了 ${snap.apiCallCount} 次 API 调用 / $${snap.totalCost.toFixed(4)} 数据`)
    }
  } catch (e: any) {
    getLogger().warn("[metrics]", `非正常终止 persist 失败: ${e.message}`)
  }
}

function clearWorkflowContext(): void {
  if (currentWorkflowContext) {
    fixPhaseIndexMap.delete(currentWorkflowContext.runId)
  }
  // 工作流结束时清理编排 session 注册表，避免长期运行后 Set 无限增长
  orchestratorSessionIds.clear()
  currentWorkflowContext = null
  activeCollector = null
  _cachedJavaCodeSpec = null
  _cachedSpecMtime = null
  _cachedUserSpec = null
  _cachedUserSpecMtime = null
  _cachedUserSpecPath = null
  destroyLogger()
}

/** 需要 Java 代码规约的 agent 文件名（正向白名单） */
const JAVA_SPEC_AGENTS = ["java-architect", "translator", "reviewer"]

/** 缓存的 Java 代码规约内容 + 文件 mtime（缺失时不缓存，每次重试） */
let _cachedJavaCodeSpec: string | null = null
let _cachedSpecMtime: number | null = null

/** 读取共享 Java 代码规约文件（mtime 感知缓存，缺失/不可读不缓存） */
function readJavaCodeSpec(): string {
  const specPath = join(findOpencodeDir(), "docs", "java-code-spec.md")
  try {
    const stat = statSync(specPath)
    const mtime = stat.mtimeMs
    if (_cachedJavaCodeSpec !== null && _cachedSpecMtime === mtime) {
      return _cachedJavaCodeSpec
    }
    const content = readFileSync(specPath, "utf-8").trim()
    _cachedJavaCodeSpec = content
    _cachedSpecMtime = mtime
    return content
  } catch {
    getLogger().warn("[workflow-engine]", `Java 代码规约文件未找到或不可读: ${specPath}`)
    return ""
  }
}

// ── 用户自定义规约（--spec）解析与合并 ──

/** 解析 Markdown 文本为 ## 标题级别的章节 Map。
 *  - 键：章节标题（去掉 `## ` 前缀后的文本）
 *  - 值：章节正文（不含标题行本身）
 *  - 首个 ## 之前的内容存为 `__preamble__`
 *  - ### 及更深层标题保留在章节正文中，不作为章节边界
 */
function parseMarkdownSections(text: string): Map<string, string> {
  const sections = new Map<string, string>()
  const lines = text.split("\n")
  let currentTitle = "__preamble__"
  let currentBody: string[] = []

  for (const line of lines) {
    if (/^## (?!#)/.test(line)) {
      // 保存上一个章节
      if (currentBody.length > 0 || currentTitle !== "__preamble__") {
        sections.set(currentTitle, currentBody.join("\n").trim())
      }
      currentTitle = line.replace(/^## /, "").trim()
      currentBody = []
    } else {
      currentBody.push(line)
    }
  }
  // 保存最后一个章节
  if (currentBody.length > 0 || currentTitle !== "__preamble__") {
    sections.set(currentTitle, currentBody.join("\n").trim())
  }
  return sections
}

/** 合并内置规范与用户规范：用户章节覆盖同名内置章节，独有章节追加到末尾。
 *  - 精确标题匹配（区分大小写）：用户需复制内置标题才能覆盖
 *  - 不匹配的用户章节追加到末尾（保留用户文件中的顺序）
 *  - 用户未覆盖的内置章节保留原样
 */
function mergeSpecSections(
  builtIn: Map<string, string>,
  user: Map<string, string>,
): string {
  const parts: string[] = []

  // Preamble: 用户覆盖内置
  const userPreamble = user.get("__preamble__")
  const builtInPreamble = builtIn.get("__preamble__")
  if (userPreamble) {
    parts.push(userPreamble)
  } else if (builtInPreamble) {
    parts.push(builtInPreamble)
  }

  // 内置章节（保留原始顺序），用户同名章节覆盖
  for (const [title, body] of builtIn) {
    if (title === "__preamble__") continue
    const sectionBody = user.has(title) ? user.get(title)! : body
    parts.push(`## ${title}\n\n${sectionBody}`)
  }

  // 用户独有章节（内置中不存在的），追加到末尾
  for (const [title, body] of user) {
    if (title === "__preamble__") continue
    if (!builtIn.has(title)) {
      parts.push(`## ${title}\n\n${body}`)
    }
  }

  return parts.join("\n\n")
}

/** 目录结构章节标题匹配模式 */
const STRUCTURE_SECTION_PATTERN = /^(工程结构|目录结构|Project Structure|Directory Structure)$/

/** 从规范章节中提取目录结构路径列表。
 *  查找标题匹配 `工程结构`/`目录结构`/`Project Structure`/`Directory Structure` 的章节，
 *  对其正文调用 parseStructureText() 解析目录路径。
 */
function extractStructureFromSpec(sections: Map<string, string>): string[] | null {
  for (const [title, body] of sections) {
    if (STRUCTURE_SECTION_PATTERN.test(title)) {
      const paths = parseStructureText(body)
      if (paths.length > 0) return paths
    }
  }
  return null
}

/** 用户自定义规约加载结果 */
interface UserSpecResult {
  rawMarkdown: string
  sections: Map<string, string>
  projectStructure: string[] | null
  sourcePath: string
}

/** 缓存的用户规约 + mtime */
let _cachedUserSpec: UserSpecResult | null = null
let _cachedUserSpecMtime: number | null = null
let _cachedUserSpecPath: string | null = null

/** 加载用户自定义规约文件（--spec 参数）。
 *  优先级：1) specConf 指定路径  2) sourcePath/project-spec.md
 *
 *  无 ## 标题的文件：先尝试解析为目录结构，否则包装为单个章节。
 */
function loadUserSpec(specConf?: string, sourcePath?: string): UserSpecResult | null {
  // 入口规范化为绝对路径：防御历史 run 在 metadata/run-context 中存入的相对路径，
  // 保证内部 join 与返回的 sourcePath 都基于绝对路径，消除 cwd 依赖。
  if (specConf) specConf = resolve(specConf)
  if (sourcePath) sourcePath = resolve(sourcePath)

  let filePath: string | null = null

  // 优先级 1: CLI --spec 参数指定（必须存在，否则报错）
  if (specConf) {
    if (!existsSync(specConf)) {
      throw new Error(`--spec 指定的文件不存在: ${specConf}`)
    }
    filePath = specConf
  }
  // 优先级 2: project-spec.md 自动发现
  else if (sourcePath) {
    const autoPath = join(sourcePath, "project-spec.md")
    if (existsSync(autoPath)) {
      filePath = autoPath
    }
  }

  if (!filePath) return null

  try {
    if (!existsSync(filePath)) {
      // 文件在运行期间被删除（start 时存在，system.transform 时已不存在）
      getLogger().warn("[workflow-engine]", `用户规范文件已不存在: ${filePath}，回退到内置规约`)
      return null
    }
    const stat = statSync(filePath)
    const mtime = stat.mtimeMs
    if (_cachedUserSpec && _cachedUserSpecPath === filePath && _cachedUserSpecMtime === mtime) {
      return _cachedUserSpec
    }

    const rawMarkdown = readFileSync(filePath, "utf-8").trim()

    // 无 ## 标题的文件处理
    const hasHeadings = /^## /m.test(rawMarkdown)
    if (!hasHeadings) {
      // 无标题文件：先尝试解析为目录结构，否则包装为单个章节
      const paths = parseStructureText(rawMarkdown)
      if (paths.length > 0) {
        const result: UserSpecResult = {
          rawMarkdown,
          sections: new Map(),
          projectStructure: paths,
          sourcePath: filePath,
        }
        _cachedUserSpec = result
        _cachedUserSpecMtime = mtime
        _cachedUserSpecPath = filePath
        getLogger().info("[workflow-engine]", `加载无标题结构定义: ${filePath} (${paths.length} 个路径)`)
        return result
      }
      // 纯文本规约：包装为"用户自定义规约"章节，避免内容丢失到 preamble
      const wrappedSections = new Map<string, string>()
      wrappedSections.set("用户自定义规约", rawMarkdown)
      const result: UserSpecResult = {
        rawMarkdown,
        sections: wrappedSections,
        projectStructure: null,
        sourcePath: filePath,
      }
      _cachedUserSpec = result
      _cachedUserSpecMtime = mtime
      _cachedUserSpecPath = filePath
      getLogger().info("[workflow-engine]", `加载无标题规约文件: ${filePath}（已包装为"用户自定义规约"章节）`)
      return result
    }

    // 新格式：按 ## 章节解析
    const sections = parseMarkdownSections(rawMarkdown)
    const projectStructure = extractStructureFromSpec(sections)

    // 检测近似标题重叠：用户可能想覆盖内置章节但标题不完全匹配
    const builtInSections = parseMarkdownSections(readJavaCodeSpec())
    for (const [userTitle] of sections) {
      if (userTitle === "__preamble__") continue
      for (const [builtInTitle] of builtInSections) {
        if (builtInTitle === "__preamble__") continue
        if (userTitle !== builtInTitle && (
          builtInTitle.includes(userTitle) || userTitle.includes(builtInTitle)
        )) {
          getLogger().warn("[workflow-engine]",
            `用户规约章节 "${userTitle}" 与内置章节 "${builtInTitle}" 标题不完全匹配，将作为新章节追加而非覆盖。如需覆盖，请使用精确标题。`)
        }
      }
    }

    const result: UserSpecResult = {
      rawMarkdown,
      sections,
      projectStructure,
      sourcePath: filePath,
    }
    _cachedUserSpec = result
    _cachedUserSpecMtime = mtime
    _cachedUserSpecPath = filePath

    getLogger().info("[workflow-engine]",
      `加载用户规范: ${filePath} (${sections.size} 个章节, ${projectStructure?.length ?? 0} 个结构路径)`)
    return result
  } catch (e: any) {
    if (e.message.startsWith("--spec")) throw e
    getLogger().warn("[workflow-engine]", `无法加载用户规范文件 ${filePath}: ${e.message}`)
    return null
  }
}

/**
 * 解析目录结构定义文本为路径列表。自动检测三种格式：
 *
 * 格式 1 — Tree（含 ├── └── 连接符）：
 *   ├── src/
 *   │   └── main/
 *   │       └── java/{packageBase}/config
 *
 * 格式 2 — 缩进（纯空格/Tab，无 tree 字符）：
 *   src/
 *     main/
 *       java/{packageBase}/config
 *
 * 格式 3 — 平铺路径（每行一个完整路径）：
 *   src/main/java/{packageBase}/config
 *
 * 公共规则：
 *   - 空行和 # 开头的注释行跳过
 *   - {projectRoot}/ 根行跳过
 *   - 尾部 / 会被清理
 *   - {packageBase} 等占位符原样保留
 */
function parseStructureText(text: string): string[] {
  const rawLines = text.split("\n").map(l => l.replace(/\r$/, ""))
  // 过滤：非空、非注释、非 projectRoot 根行
  const lines = rawLines
    .map(l => l.replace(/\s+#.*$/, ""))   // 剥离行内注释（空格 + # 开头）
    .filter(l => {
      const t = l.trim()
      return t && !t.startsWith("#") && !/^\{projectRoot\}\s*\/?\s*$/.test(t)
    })
  if (lines.length === 0) return []

  // 格式检测：任一行含 tree connector → tree 格式
  const hasTreeConnector = lines.some(l => /[├└]── /.test(l))
  if (hasTreeConnector) return parseTreeFormat(lines)

  // 格式检测：有多级缩进（不同行 leading spaces 不同）→ 缩进格式
  const indents = lines.map(l => {
    const m = l.match(/^( +|\t+)/)
    return m ? m[1].length : 0
  })
  const hasMultipleIndents = new Set(indents).size > 1
  if (hasMultipleIndents) return parseIndentFormat(lines)

  // 否则：平铺路径
  return parseFlatFormat(lines)
}

/** 格式 1：Tree（├── / └── 连接符，每级占 4 字符宽度） */
function parseTreeFormat(lines: string[]): string[] {
  const result: string[] = []
  const stack: { name: string; depth: number }[] = []

  for (const line of lines) {
    const connectorIdx = line.search(/[├└]── /)
    if (connectorIdx === -1 || connectorIdx % 4 !== 0) continue

    const depth = connectorIdx / 4
    const name = line.slice(connectorIdx + 4).trim()
    if (!name) continue

    const cleanName = name.replace(/\/+$/, "")
    while (stack.length > depth) stack.pop()

    const parentPath = stack.map(s => s.name).join("/")
    result.push(parentPath ? `${parentPath}/${cleanName}` : cleanName)
    stack.push({ name: cleanName, depth })
  }
  return result
}

/** 格式 2：缩进（空格或 Tab，自动推断每级宽度） */
function parseIndentFormat(lines: string[]): string[] {
  const result: string[] = []

  // 推断缩进单位：取所有非零缩进的最小公约数
  const indentLengths = lines
    .map(l => { const m = l.match(/^( +|\t+)/); return m ? m[1].length : 0 })
    .filter(n => n > 0)
  const unit = indentLengths.length > 0 ? Math.min(...indentLengths) : 2

  const stack: { name: string; depth: number }[] = []

  for (const line of lines) {
    const m = line.match(/^( +|\t+)/)
    const indentLen = m ? m[1].length : 0
    const depth = Math.round(indentLen / unit)
    const name = line.trim()
    if (!name) continue

    const cleanName = name.replace(/\/+$/, "")
    while (stack.length > depth) stack.pop()

    const parentPath = stack.map(s => s.name).join("/")
    result.push(parentPath ? `${parentPath}/${cleanName}` : cleanName)
    stack.push({ name: cleanName, depth })
  }
  return result
}

/** 格式 3：平铺路径（每行一个完整路径） */
function parseFlatFormat(lines: string[]): string[] {
  return lines
    .map(l => l.trim().replace(/\/+$/, ""))
    .filter(l => l.length > 0)
}

/** 提取 agent .md 通用部分（文件头到第一个 ## Phase: 之前） */
function extractCommonPart(content: string): string {
  const lines = content.split("\n")
  const idx = lines.findIndex((l) => /^## Phase:\s*\S+/.test(l))
  return idx === -1 ? content.trim() : lines.slice(0, idx).join("\n").trim()
}

/** 提取 agent .md 中当前 phase 对应的 ## Phase: xxx section */
function extractPhaseSection(content: string, phase: string): string {
  const lines = content.split("\n")
  let start = -1, end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## Phase:\s*(\S+)/)
    if (m) {
      if (m[1] === phase) start = i
      else if (start !== -1 && end === lines.length) end = i
    }
  }
  return start === -1 ? "" : lines.slice(start, end).join("\n").trim()
}

/**
 * 确定项目根目录的绝对路径。
 *
 * 策略：
 *   1. .workflow-artifacts/ 已存在 → 其父目录的 realpath 即为项目根目录
 *   2. 不存在 → 使用 process.cwd() 的 resolve 路径（首次 start 时目录尚未创建）
 *
 * 这样即使运行期间 cwd 发生变化，projectRoot 始终指向启动时的项目根目录。
 */
function resolveProjectRoot(): string {
  if (existsSync(ARTIFACT_DIR)) {
    try {
      // realpathSync 解析符号链接并返回绝对路径
      const artifactAbsPath = realpathSync(ARTIFACT_DIR)
      return dirname(artifactAbsPath)
    } catch {}
  }
  return resolve(process.cwd())
}

/** 构建 Runtime Context 文本块 */
function buildRuntimeContext(run: WorkflowRun): string {
  const lines: string[] = []
  lines.push(`currentPhase: ${run.currentPhase ?? "unknown"}`)
  lines.push(`runId: ${run.runId}`)
  lines.push(`sourcePath: ${(run.metadata as Record<string, unknown>).sourcePath ?? "unknown"}`)
  const mainEntry = (run.metadata as Record<string, unknown>).mainEntry
  if (mainEntry) lines.push(`mainEntry: ${mainEntry}`)
  lines.push(`artifactsDir: ${ARTIFACT_DIR}/${run.runId}`)

  // projectRoot: scaffold 及后续阶段从 plan.json 的 targetProject.artifactId 推导
  // 使用绝对路径，避免 LLM 在不同工作目录下解析到错误位置。
  // 定位基准：.workflow-artifacts 目录的父目录就是项目根目录。
  const planArtifact = engine.loadArtifactJson(`${ARTIFACT_DIR}/${run.runId}`, "plan")
  if (planArtifact) {
    const targetProject = planArtifact.targetProject as { artifactId: string } | undefined
    if (targetProject?.artifactId) {
      const projectRoot = resolveProjectRoot()
      lines.push(`projectRoot: ${join(projectRoot, "generated", targetProject.artifactId)}`)
    }
  }

  // 查找当前 entry（用于 incrementalContext 和 triggerPhase）
  const currentEntry = engine.findCurrentEntry(run)

  // triggerPhase：fix 阶段从 branchedFrom 获取触发阶段，注入到 context
  if (run.currentPhase === "fix" && currentEntry?.branchedFrom) {
    lines.push(`triggerPhase: ${currentEntry.branchedFrom}`)
  }

  // upstreamArtifacts：fix 阶段根据 triggerPhase 过滤只注入对应的 summary
  let upstream = UPSTREAM_ARTIFACTS[run.currentPhase ?? ""]
  if (upstream && upstream.length > 0) {
    if (run.currentPhase === "fix" && currentEntry?.branchedFrom) {
      const triggerPhase = currentEntry.branchedFrom
      // 过滤：只保留触发阶段对应的 summary，排除另一个
      const excludeSummary = triggerPhase === "review"
        ? "verify-summary.json"
        : "review-summary.json"
      upstream = upstream.filter(a => a !== excludeSummary)
    }
    lines.push(`upstreamArtifacts:`)
    for (const a of upstream) {
      lines.push(`  - ${ARTIFACT_DIR}/${run.runId}/${a}`)
    }
  }

  // incrementalContext
  if (currentEntry?.incrementalContext) {
    lines.push(`incrementalContext:`)
    // analyze/translate PROCEDURE 级用 targetUnits；review/包级回退用 targetPackages。两者择一输出。
    const tu = currentEntry.incrementalContext.targetUnits
    if (tu && tu.length > 0) {
      lines.push(`  targetUnits: ${JSON.stringify(tu)}`)
    } else {
      lines.push(`  targetPackages: ${JSON.stringify(currentEntry.incrementalContext.targetPackages)}`)
    }
    if (currentEntry.incrementalContext.shardIndex !== undefined) {
      lines.push(`  shardIndex: ${currentEntry.incrementalContext.shardIndex}`)
      lines.push(`  totalShards: ${currentEntry.incrementalContext.totalShards ?? "?"}`)
    }
    const pf = currentEntry.incrementalContext.previousFindings
    if (pf && pf.length > 0) {
      lines.push(`  previousFindings: 上次 review 的 mustFix，请先逐项核对是否已修复（未修复的须再次列入本次 mustFix）`)
      for (const f of pf) {
        lines.push(`    - { packageName: ${f.packageName}, file: ${f.file}, line: ${f.line ?? "null"}, issue: ${JSON.stringify(f.issue)} }`)
      }
    }
  }

  // projectStructure: 自定义目录结构覆盖
  const ps = (run.metadata as Record<string, unknown>).projectStructure
  if (ps && Array.isArray(ps)) {
    lines.push(`projectStructure:`)
    for (const dir of ps) lines.push(`  - ${dir}`)
  }

  return lines.join("\n")
}

/**
 * 构建共享指令文本块（Runtime Context 表格 + Artifact 写入规则 + 阶段小结）
 * 所有 agent 共享，由引擎自动注入，agent .md 文件不再包含这些重复内容
 */
function buildSharedInstructions(run: WorkflowRun): string {
  return `### Runtime Context

你的每次执行由工作流引擎注入以下 Runtime Context：

| 字段 | 说明 | 用途 |
|------|------|------|
| \`currentPhase\` | 当前阶段名 | 决定执行哪个 Phase section |
| \`runId\` | 工作流运行 ID | 调用 workflow 工具时传入 |
| \`sourcePath\` | PL/SQL 源码目录 | 读取原始 SQL 文件 |
| \`artifactsDir\` | artifact 输出目录 | 读取上游 artifact / 写入产出 |
| \`upstreamArtifacts\` | 上游 artifact 路径列表 | 当前阶段需要读取的文件 |
| \`incrementalContext\` | 增量模式上下文（可选） | 分片/增量处理范围：analyze/translate 级用 targetUnits（PROCEDURE 单元），包级用 targetPackages；分片模式含 shardIndex/totalShards |
| \`mainEntry\` | 翻译起点/对外门面包名（可选，由用户输入提取） | 标识对外门面包，后续 plan/scaffold 阶段消费 |
| \`projectStructure\` | 自定义目录结构路径列表（可选，由 --spec 提取） | scaffold 阶段使用自定义目录布局替代默认模板 |
| \`projectRoot\` | Java 项目输出根目录（绝对路径，scaffold 及之后阶段，可选） | scaffold 写入 Java 文件到此目录，后续阶段从此目录读取 |

### Artifact 写入规则

- **JSON artifact**（plan.json、scaffold.json、translation.json 等元数据文件）使用 \`write\` 工具写入 \`\${artifactsDir}/\` 下的指定路径
- **Java 源文件**（.java、.xml、.yml、pom.xml 等）必须写入 Runtime Context 中 \`projectRoot\` 指定的目录（绝对路径），**绝不能**写入 \`\${artifactsDir}/\` 下
- **禁止写入以下目录**：.git/、.claude/、node_modules/（引擎会拦截并阻止）
- **sourcePath 目录是只读的**，禁止向其中写入任何文件
- 如果写入路径被引擎拦截重定向，请使用重定向后的路径继续工作
- 写入前确保 JSON 格式合法（无尾逗号、引号闭合）
- 逐包持久化：每处理完一个包立即写入 per-package artifact，避免中途崩溃丢失
- 写入后不需要读回验证（引擎 advance 时会做 Zod 校验）

### Worker Status 写入

完成阶段工作后，将 Worker Status 写入 \`\${artifactsDir}/status/\${currentPhase}.json\`：

\`\`\`json
{
  "phase": "{currentPhase}",
  "status": "completed",
  "startedAt": "...",
  "completedAt": "...",
  "artifacts": ["写入的关键文件列表"],
  "metrics": { "completedSubprograms": N, "totalSubprograms": N }
}
\`\`\`

### 阶段小结

完成阶段工作后，必须输出本阶段工作小结，格式如下：

\`\`\`
📋 {phaseName} 阶段小结
├─ 产出物：{列出写入的关键文件及数量}
├─ 处理范围：{处理的包数量、子程序数量等}
├─ 关键指标：{通过/失败数、成功率、TODO 数等}
└─ 耗时/异常：{如有异常或特别耗时的操作，简要说明}
\`\`\`

### Worker 摘要格式

返回编排者之前，输出以下格式的摘要（编排者仅保留此摘要，丢弃其余输出）：

\`\`\`
WORKER_SUMMARY
Phase: {currentPhase}
Status: completed|failed
Artifacts: {写入的关键文件列表}
Metrics: {1-2 个关键数字，如"8 packages, 45 subprograms"}
END_SUMMARY
\`\`\``
}

/**
 * 校验 inventory 拆分后的 inventory-packages/ 目录
 * - 从 inventory-index.json 获取期望包名
 * - 逐个校验 per-package 文件存在且通过 Zod 校验
 * - 校验 inventory.json 的 packageNames 与 index 一致
 */
function validateInventoryPackages(
  artifactsDir: string,
): string | null {
  // 1. 检查 inventory-index.json 存在并获取期望包名
  const indexArtifact = engine.loadArtifactJson(artifactsDir, "inventory-index")
  if (!indexArtifact) {
    return "inventory-index.json not found or malformed. Pre-scan may have failed."
  }
  const expectedPackages = Array.from(engine.extractPackageNames(indexArtifact))

  // 2. 检查 inventory-packages/ 目录
  const pkgDir = join(artifactsDir, "inventory-packages")
  if (!existsSync(pkgDir)) {
    return "inventory-packages/ directory not found. Agent must write per-package files before advancing."
  }

  // 3. 逐包校验（大小写不敏感匹配文件名，缓存目录列表避免 N 次 readdirSync）
  const pkgSchema = getInventoryPackageSchema()
  const pkgDirEntries = readdirSync(pkgDir, { withFileTypes: true })
  for (const pkgName of expectedPackages) {
    const actualFileName = findFileCaseInsensitive(pkgDir, pkgName, pkgDirEntries)
    if (!actualFileName) {
      return `Missing inventory package file: inventory-packages/${pkgName}.json`
    }
    const pkgFile = join(pkgDir, actualFileName)
    try {
      const raw = readFileSync(pkgFile, "utf-8")
      const parsed = JSON.parse(raw)
      const result = pkgSchema.safeParse(parsed)
      if (!result.success) {
        const errors = formatZodIssues(result.error)
        return `Zod validation failed for inventory-packages/${actualFileName}:\n${errors}`
      }
      if (typeof parsed.packageName !== "string" || parsed.packageName.toUpperCase() !== pkgName.toUpperCase()) {
        return `inventory-packages/${actualFileName}: packageName "${parsed.packageName}" does not match expected "${pkgName}"`
      }
    } catch (e: any) {
      return `Failed to read/parse inventory-packages/${actualFileName}: ${e.message}`
    }
  }

  // 4. inventory.json 必须存在（包名一致性校验已移至 engine-core 的 warning 逻辑，不再 blocking）
  const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
  if (!inventory) {
    return "inventory.json not found or malformed. Agent must write inventory.json before advancing."
  }

  return null // 校验通过
}

/**
 * 校验 analyze 拆分后的 analysis-packages/ 目录
 * - 检查目录存在
 * - 从 inventory.json 获取期望包名
 * - 逐个校验 per-package 文件存在且通过 Zod 校验
 * - 校验 packageNames 与 inventory 一致
 */
function validateAnalysisPackages(
  artifactsDir: string,
  targetPkgs?: string[],
): string | null {
  const analysisPackagesDir = join(artifactsDir, "analysis-packages")
  if (!existsSync(analysisPackagesDir)) {
    return "analysis-packages/ directory not found. Agent must write per-package files before advancing."
  }

  // 从 inventory.json 获取期望包名
  const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
  if (!inventory) {
    return "inventory.json not found or malformed — cannot verify analysis package coverage"
  }
  const allPackages = Array.from(engine.extractPackageNames(inventory))
  // 分片模式下只校验本分片包（与 translate G1 同模式：每包在所属分片 advance 时校验，全量覆盖跨分片完成）
  const expectedPackages = targetPkgs && targetPkgs.length > 0
    ? allPackages.filter(p => targetPkgs.some(t => t.toUpperCase() === p.toUpperCase()))
    : allPackages

  // 逐包校验（大小写不敏感匹配文件名，缓存目录列表避免 N 次 readdirSync）
  const pkgSchema = getAnalysisPackageSchema()
  const pkgDirEntries = readdirSync(analysisPackagesDir, { withFileTypes: true })
  for (const pkgName of expectedPackages) {
    const actualFileName = findFileCaseInsensitive(analysisPackagesDir, pkgName, pkgDirEntries)
    if (!actualFileName) {
      return `Missing analysis package file: analysis-packages/${pkgName}.json`
    }
    const pkgFile = join(analysisPackagesDir, actualFileName)
    try {
      const raw = readFileSync(pkgFile, "utf-8")
      const parsed = JSON.parse(raw)
      const result = pkgSchema.safeParse(parsed)
      if (!result.success) {
        const errors = formatZodIssues(result.error)
        return `Zod validation failed for analysis-packages/${actualFileName}:\n${errors}`
      }
      if (typeof parsed.packageName !== "string" || parsed.packageName.toUpperCase() !== pkgName.toUpperCase()) {
        return `analysis-packages/${actualFileName}: packageName "${parsed.packageName}" does not match expected "${pkgName}"`
      }
    } catch (e: any) {
      return `Failed to read/parse analysis-packages/${actualFileName}: ${e.message}`
    }
  }

  // 注：analysis.json 的 packageNames 一致性校验已随 analysis.json 产出移至 inventory 边界
  // （engine-core validateCrossSchema("inventory")），此处不再依赖 analysis.json。

  return null // 校验通过
}

// per-package 文件名映射复用 artifact-schemas.ts 的 PHASE_FILENAME_MAP
// getArtifactFilename("translate") → "translation"，其余 phase 名与文件名一致

/**
 * 校验 FSD 文档（analyze 阶段产出）：
 *  - 覆盖：每个有子程序的包，按 refName 规范（refNamesForPackage）算出期望文件名，
 *    逐个检查 fsd/{pkg}/{refName}.md 存在。
 *  - stub：fsd 下所有 .md 不得含"详见"占位符（FSD 必须自包含）。
 * 缺 FSD 或含占位符均 blocking（translate 依赖完整 FSD）。
 */
export function validateFsds(artifactsDir: string, targetPkgs?: string[]): string | null {
  const fsdDir = join(artifactsDir, "fsd")
  if (!existsSync(fsdDir)) {
    return "fsd/ directory not found. Agent must generate FSD docs before advancing."
  }

  // 读 inventory.json 取包名（直接读盘，避免依赖 engine 单例，便于单测）
  const invPath = join(artifactsDir, "inventory.json")
  if (!existsSync(invPath)) {
    return "inventory.json not found or malformed — cannot verify FSD coverage"
  }
  let allPackages: string[]
  try {
    const inv = JSON.parse(readFileSync(invPath, "utf-8")) as { packageNames?: string[] }
    allPackages = inv.packageNames ?? []
  } catch (e: any) {
    return `Failed to read/parse inventory.json: ${e.message}`
  }
  // 分片模式下只校验本分片包（每包在所属分片 advance 时校验，全量覆盖跨分片完成）
  const packageNames = targetPkgs && targetPkgs.length > 0
    ? allPackages.filter(p => targetPkgs.some(t => t.toUpperCase() === p.toUpperCase()))
    : allPackages

  const invPkgDir = join(artifactsDir, "inventory-packages")
  // 覆盖校验：逐包按 refName 检查 FSD 存在
  for (const pkgName of packageNames) {
    const invPkgFile = findFileCaseInsensitive(invPkgDir, pkgName)
    if (!invPkgFile) continue // inventory-packages 缺该包由 validateAnalysisPackages 报，此处不重复
    let procNames: string[]
    try {
      const invPkg = JSON.parse(readFileSync(join(invPkgDir, invPkgFile), "utf-8")) as { procedures?: Array<{ name: string }> }
      procNames = (invPkg.procedures ?? []).map(p => p.name)
    } catch {
      continue
    }
    if (procNames.length === 0) continue // 无子程序的包不生成 FSD
    const refNames = refNamesForPackage(procNames)
    const pkgFsdDirName = findDirCaseInsensitive(fsdDir, pkgName)
    if (!pkgFsdDirName) {
      return `Missing FSD directory: fsd/${pkgName}/ (包有 ${procNames.length} 个子程序)`
    }
    const fullPkgFsdDir = join(fsdDir, pkgFsdDirName)
    const entries = readdirSync(fullPkgFsdDir, { withFileTypes: true })
    for (const refName of refNames) {
      // .md 文件大小写不敏感匹配（findFileCaseInsensitive 仅支持 .json，此处直接查）
      const refUpper = refName.toUpperCase()
      const found = entries.some(e => e.isFile() && e.name.replace(/\.md$/i, "").toUpperCase() === refUpper)
      if (!found) {
        return `Missing FSD: fsd/${pkgName}/${refName}.md`
      }
    }
  }

  // stub 校验：fsd 下所有 .md 不得含"详见"占位符（FSD 必须自包含）
  return validateFsdStubs(artifactsDir)
}

/**
 * FSD 占位符校验：递归 grep fsd 下所有 .md，含"详见"即报错。
 * 从 validateFsds 抽出，供 analyze unit 模式（per-unit 存在性检查替代包级覆盖）复用。
 */
function validateFsdStubs(artifactsDir: string): string | null {
  const fsdDir = join(artifactsDir, "fsd")
  if (!existsSync(fsdDir)) return null // 目录存在性由调用方/覆盖校验保证
  const stubFiles: string[] = []
  function walkFsd(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walkFsd(full)
      else if (e.isFile() && e.name.endsWith(".md")) {
        const text = readFileSync(full, "utf-8")
        if (text.includes("详见")) stubFiles.push(relative(artifactsDir, full))
      }
    }
  }
  walkFsd(fsdDir)
  if (stubFiles.length > 0) {
    return `FSD 含"详见"占位符（必须自包含，禁用占位）: ${stubFiles.slice(0, 5).join(", ")}${stubFiles.length > 5 ? ` ... (+${stubFiles.length - 5})` : ""}`
  }
  return null
}

/**
 * translate PROCEDURE 级：合并某包的所有 per-unit 产物 → 聚合 translations/{pkg}/translation.json。
 *
 * 单元文件按「本包期望 unit ref 集合」白名单过滤（期望集取自 analysis.procedureOrder），天然排除
 * 同目录的 translation.json / review.json / verify.json 等非单元产物——避免 fix 阶段把 review.json
 * 误当 per-unit 文件解析而 Zod 失败。逐个过 UnitTranslationSchema 校验，聚合 units/
 * completedSubprograms/subprogramMethods/files/decisions/todos，写出聚合 translation.json（跨包/同包
 * 跨单元调用对接的稳定契约）。仿 generateReviewSummary 模式（代码 reduce，零 LLM）。
 *
 * - 无 unit 的空包（spec-only/类型包，procedureOrder 无其 unit）：写 completed 空 stub，保证下游
 *   review/verify 能读到该包 translation.json（与包级模式行为一致）。
 * - status：期望 unit 全部 present 且各 status=completed → "completed"，否则 "partial"。
 * - totalSubprograms：取 inventory-packages/{pkg}.json 的 procedures 数，缺失兜底 completed.length。
 * 返回 null 成功，string 为首个错误。
 */
export function mergeUnitTranslations(artifactsDir: string, pkgName: string): string | null {
  const schema = getPerUnitSchema("translate")
  if (!schema) return `no UnitTranslationSchema for translate`

  // 期望 unit ref 集合（从 analysis.procedureOrder 取本包 unit）→ 白名单过滤 + completed 判定
  const analysis = engine.loadArtifactJson(artifactsDir, "analysis")
  const procOrder = (analysis?.procedureOrder as string[][] | undefined) ?? []
  const expectedRefs = new Set(
    procOrder.flat()
      .filter(u => { const i = u.indexOf("."); return i > 0 && pkgOf(u) === pkgName })
      .map(refOf),
  )

  const pkgDir = join(artifactsDir, "translations", pkgName)
  if (!existsSync(pkgDir)) {
    // 目录不存在：非空包尚无产物（return null，等 agent 写）；空包写 completed stub
    if (expectedRefs.size === 0) {
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, "translation.json"), JSON.stringify({
        packageName: pkgName, status: "completed", completedSubprograms: [],
        totalSubprograms: 0, units: [], files: [], decisions: [], todos: [], subprogramMethods: [],
      }, null, 2), "utf-8")
    }
    return null
  }

  // 白名单：仅读文件名（去 .json）落在期望 unit ref 集合的文件 → 排除 review.json/verify.json/translation.json
  const unitFiles = readdirSync(pkgDir).filter(f => f.endsWith(".json") && expectedRefs.has(f.slice(0, -5)))

  const units: { refName: string; status: string }[] = []
  const completed: string[] = []
  const methods: Array<{ oracleName: string; [k: string]: unknown }> = []
  const files: unknown[] = []
  const decisions: unknown[] = []
  const todos: unknown[] = []
  for (const f of unitFiles) {
    let parsed: any
    try {
      parsed = JSON.parse(readFileSync(join(pkgDir, f), "utf-8"))
    } catch (e: any) {
      return `Failed to parse translations/${pkgName}/${f}: ${e.message}`
    }
    const r = schema.safeParse(parsed)
    if (!r.success) {
      return `Zod validation failed for translations/${pkgName}/${f}:\n${formatZodIssues(r.error)}`
    }
    const u = r.data as any
    units.push({ refName: u.unitRefName, status: u.status })
    completed.push(...(u.completedSubprograms ?? []))
    methods.push(...(u.subprogramMethods ?? []))
    files.push(...(u.files ?? []))
    decisions.push(...(u.decisions ?? []))
    todos.push(...(u.todos ?? []))
  }

  // subprogramMethods 按 oracleName 大写去重（后写覆盖先写，理论上同包不重复）
  const methodMap = new Map<string, any>()
  for (const m of methods) methodMap.set(String(m.oracleName).toUpperCase(), m)
  const dedupMethods = [...methodMap.values()]

  const presentRefs = new Set(units.map(u => u.refName))
  const allPresent = expectedRefs.size > 0 && [...expectedRefs].every(r => presentRefs.has(r))
  const allCompleted = allPresent && units.every(u => u.status === "completed")

  // totalSubprograms：取 inventory-packages/{pkg}.json 的 procedures 数（proc+func 总数），缺失兜底
  let total = completed.length
  const invPkgPath = join(artifactsDir, "inventory-packages", `${pkgName}.json`)
  if (existsSync(invPkgPath)) {
    try {
      const ip = JSON.parse(readFileSync(invPkgPath, "utf-8"))
      if (Array.isArray(ip.procedures)) total = ip.procedures.length
    } catch { /* 兜底用 completed.length */ }
  }

  const aggregated = {
    packageName: pkgName,
    status: allCompleted ? "completed" : "partial",
    completedSubprograms: completed,
    totalSubprograms: total,
    units,
    files,
    decisions,
    todos,
    subprogramMethods: dedupMethods,
  }
  writeFileSync(join(pkgDir, "translation.json"), JSON.stringify(aggregated, null, 2), "utf-8")
  return null
}

/**
 * analyze PROCEDURE 级：合并某包的所有 per-unit 产物 → 聚合 analysis-packages/{pkg}.json。
 *
 * 镜像 mergeUnitTranslations（零 LLM 代码 reduce）。per-unit 文件位于子目录
 * `analysis-packages/{pkg}/{refName}.json`（UnitAnalysisSchema，含根 + cargo FUNCTION 的 subprogram
 * 结构）；聚合文件 `analysis-packages/{pkg}.json`（AnalysisPackageSchema = {packageName, subprograms}）
 * 在父目录，供 plan/review/translator 消费，形状不变。
 *
 * 期望 unit ref 集合取自 analysis.procedureOrder 本包 unit，作白名单过滤（排除子目录里可能的杂散文件）。
 * - 无 unit 的空包（spec-only/类型包）：子目录不存在，聚合空文件已由 analysis-builder 预写，直接 return。
 * - 子目录不存在但有期望 unit：return null（等 agent 写 per-unit 文件）。
 * 返回 null 成功，string 为首个错误。
 */
export function mergeUnitAnalysis(artifactsDir: string, pkgName: string): string | null {
  const schema = getPerUnitSchema("analyze")
  if (!schema) return `no UnitAnalysisSchema for analyze`

  const analysis = engine.loadArtifactJson(artifactsDir, "analysis")
  const procOrder = (analysis?.procedureOrder as string[][] | undefined) ?? []
  const expectedRefs = new Set(
    procOrder.flat()
      .filter(u => { const i = u.indexOf("."); return i > 0 && pkgOf(u) === pkgName })
      .map(refOf),
  )

  const pkgSubDir = join(artifactsDir, "analysis-packages", pkgName)
  if (!existsSync(pkgSubDir)) {
    // 空包：聚合空文件已由 analysis-builder 预写；有期望 unit 但尚未产出 per-unit → 等 agent 写。
    return null
  }

  // 白名单：仅读文件名（去 .json）落在期望 unit ref 集合的 per-unit 文件
  const unitFiles = readdirSync(pkgSubDir).filter(f => f.endsWith(".json") && expectedRefs.has(f.slice(0, -5)))

  const subprograms: unknown[] = []
  for (const f of unitFiles) {
    let parsed: any
    try {
      parsed = JSON.parse(readFileSync(join(pkgSubDir, f), "utf-8"))
    } catch (e: any) {
      return `Failed to parse analysis-packages/${pkgName}/${f}: ${e.message}`
    }
    const r = schema.safeParse(parsed)
    if (!r.success) {
      return `Zod validation failed for analysis-packages/${pkgName}/${f}:\n${formatZodIssues(r.error)}`
    }
    const u = r.data as any
    subprograms.push(...(u.subprograms ?? []))
  }

  const aggregated = {
    packageName: pkgName,
    subprograms,
  }
  writeFileSync(join(artifactsDir, "analysis-packages", `${pkgName}.json`), JSON.stringify(aggregated, null, 2), "utf-8")
  return null
}

/**
 * D5: advance 时从磁盘读取 artifact 并做 Zod 校验
 * 返回 null 表示校验通过，否则返回错误信息
 */
function validateArtifactOnDisk(run: WorkflowRun): string | null {
  const phase = run.currentPhase
  if (!phase) return null

  const artifactsDir = join(ARTIFACT_DIR, run.runId)

  // analyze 阶段：analysis.json 已归 inventory 产出（不在此校验），只验逐包 analysis-packages + FSD。
  // PROCEDURE 级（unit 模式，procedureOrder 存在）：agent 写 per-procedure analysis-packages/{pkg}/{ref}.json
  // + fsd/{pkg}/{ref}.md；此处 merge 聚合 analysis-packages/{pkg}.json + 校验本分片 unit 产物存在性 +
  // FSD 占位符。包级回退（procedureOrder 缺失旧 run）：按 targetPackages 走包级 validateAnalysisPackages+validateFsds。
  if (phase === "analyze") {
    const currentEntry = engine.findCurrentEntry(run)
    const analysis = engine.loadArtifactJson(artifactsDir, "analysis")
    const procedureOrder = (analysis?.procedureOrder as string[][] | undefined) ?? []
    if (procedureOrder.length > 0) {
      const targetUnits = currentEntry?.incrementalContext?.targetUnits
      // 增量分片：本分片 targetUnits；全量单分片：procedureOrder 全部 unit
      const units = targetUnits && targetUnits.length > 0 ? targetUnits : procedureOrder.flat()
      const ownership = (analysis?.functionOwnership as Record<string, string> | undefined) ?? {}

      // merge 本分片 unit 所属包的聚合 analysis-packages/{pkg}.json
      const touchedPkgs = [...new Set(units.map(pkgOf))]
      for (const pkg of touchedPkgs) {
        const err = mergeUnitAnalysis(artifactsDir, pkg)
        if (err) return err
      }

      // 完整性：本分片每个 unit 的 per-procedure analysis-packages + FSD（根 + cargo FUNCTION）必须存在
      for (const u of units) {
        const pkg = pkgOf(u)
        const ref = refOf(u)
        const unitFile = join(artifactsDir, "analysis-packages", pkg, `${ref}.json`)
        if (!existsSync(unitFile)) {
          return `Missing per-unit artifact: analysis-packages/${pkg}/${ref}.json. All targetUnits must have per-procedure artifacts before advancing.`
        }
        if (!existsSync(join(artifactsDir, "fsd", pkg, `${ref}.md`))) {
          return `Missing FSD: fsd/${pkg}/${ref}.md`
        }
        for (const [func, owner] of Object.entries(ownership)) {
          if (owner === u) {
            const fPkg = pkgOf(func), fRef = refOf(func)
            if (!existsSync(join(artifactsDir, "fsd", fPkg, `${fRef}.md`))) {
              return `Missing FSD (cargo FUNCTION): fsd/${fPkg}/${fRef}.md`
            }
          }
        }
      }

      // FSD 占位符校验（全局 walk，仅见已写 FSD；每分片 advance 时校验本分片及之前写入的 FSD）
      const stubError = validateFsdStubs(artifactsDir)
      if (stubError) return stubError
      return null
    }

    // 包级回退（procedureOrder 缺失旧 run）
    const targetPkgs = currentEntry?.incrementalContext?.targetPackages
    const pkgError = validateAnalysisPackages(artifactsDir, targetPkgs)
    if (pkgError) return pkgError
    const fsdError = validateFsds(artifactsDir, targetPkgs)
    if (fsdError) return fsdError
    return null
  }

  // translate PROCEDURE 级（unit 模式）：agent 写 per-unit translations/{pkg}/{unitRef}.json，
  // 此处合并 → 聚合 translation.json + 校验 per-unit 文件，短路掉下方的包级 translation.json 校验。
  // unit 模式判定基于 analysis.procedureOrder 存在（覆盖分片与单分片全量两种场景）。
  if (phase === "translate") {
    const analysis = engine.loadArtifactJson(artifactsDir, "analysis")
    const procedureOrder = (analysis?.procedureOrder as string[][] | undefined) ?? []
    if (procedureOrder.length > 0) {
      const currentEntry = engine.findCurrentEntry(run)
      const targetUnits = currentEntry?.incrementalContext?.targetUnits
      // 增量分片：本分片 targetUnits；全量单分片：procedureOrder 全部 unit
      const units = targetUnits && targetUnits.length > 0 ? targetUnits : procedureOrder.flat()
      const touchedPkgs = [...new Set(units.map(pkgOf))]
      for (const pkg of touchedPkgs) {
        const err = mergeUnitTranslations(artifactsDir, pkg)
        if (err) return err
      }
      // 完整性：本分片（或全量）每个 unit 必须有 per-unit 文件，防止 agent 漏写却 advance
      for (const u of units) {
        const pkg = pkgOf(u)
        const ref = refOf(u)
        const unitFile = join(artifactsDir, "translations", pkg, `${ref}.json`)
        if (!existsSync(unitFile)) {
          return `Missing per-unit artifact: translations/${pkg}/${ref}.json. All targetUnits must have per-unit artifacts before advancing.`
        }
      }
      // 空包兜底：无 unit 的包（spec-only/类型包，procedureOrder 无其 unit）不会被任何分片触及，
      // 需确保它们也有聚合 translation.json（completed 空 stub），否则下游 review/verify 读不到。
      // mergeUnitTranslations 对空包写 stub；这里只对尚无 translation.json 的空包调用，避免重复写。
      const unitPkgs = new Set(procedureOrder.flat().map(pkgOf))
      const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
      const allPkgs = inventory ? Array.from(engine.extractPackageNames(inventory)) : []
      for (const pkg of allPkgs) {
        if (unitPkgs.has(pkg)) continue // 非空包，由其 unit 分片 merge
        const aggFile = join(artifactsDir, "translations", pkg, "translation.json")
        if (!existsSync(aggFile)) {
          const err = mergeUnitTranslations(artifactsDir, pkg)
          if (err) return err
        }
      }
      return null
    }
  }

  // fix 阶段（unit 模式）：translator 重翻 targetPackages 的 unit 写 per-unit 文件后，
  // 此处 re-merge 这些包的聚合 translation.json，供后续 review 读取最新索引。
  if (phase === "fix") {
    const analysis = engine.loadArtifactJson(artifactsDir, "analysis")
    const procedureOrder = (analysis?.procedureOrder as string[][] | undefined) ?? []
    if (procedureOrder.length > 0) {
      const currentEntry = engine.findCurrentEntry(run)
      const targetPkgs = currentEntry?.incrementalContext?.targetPackages ?? []
      for (const pkg of targetPkgs) {
        const err = mergeUnitTranslations(artifactsDir, pkg)
        if (err) return err
      }
    }
  }

  // 1. 顶层 schema（inventory / plan / scaffold / fix）—— analyze 已在上面提前返回
  const topLevelSchema = getSchemaForPhase(phase)
  if (topLevelSchema) {
    const artifactFileName = getArtifactFilename(phase)
    const filePath = join(artifactsDir, `${artifactFileName}.json`)
    if (!existsSync(filePath)) {
      return `Artifact not found on disk: ${filePath}. Agent must write ${artifactFileName}.json before advancing.`
    }
    try {
      const raw = readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(raw)
      const result = topLevelSchema.safeParse(parsed)
      if (!result.success) {
        const errors = formatZodIssues(result.error)
        return `Zod validation failed for ${artifactFileName}.json:\n${errors}`
      }

      // analyze 阶段已在函数开头提前返回（不校验 analysis.json，归 inventory）

      // scaffold 阶段：校验 projectRoot 必须指向项目根目录下的 generated/{artifactId}
      // 并校验 Java 文件实际写入了 projectRoot 而非 artifactsDir/translations/
      if (phase === "scaffold") {
        const scaffoldData = parsed as { projectRoot: string; generated?: Record<string, unknown> }
        const planForRoot = engine.loadArtifactJson(artifactsDir, "plan")
        if (planForRoot) {
          const artifactId = (planForRoot.targetProject as { artifactId: string })?.artifactId
          if (artifactId) {
            const expectedRoot = join(resolveProjectRoot(), "generated", artifactId)
            if (scaffoldData.projectRoot !== expectedRoot) {
              return `scaffold.json projectRoot 必须是 "${expectedRoot}"，实际为 "${scaffoldData.projectRoot}"。请使用 Runtime Context 中注入的 projectRoot 值。`
            }
            // D14: 校验 pom.xml 实际存在于 projectRoot 下（而非 artifactsDir/translations/ 下）
            const pomInProjectRoot = existsSync(join(expectedRoot, "pom.xml"))
            const pomInArtifactsDir = existsSync(join(artifactsDir, "translations", artifactId, "pom.xml"))
            if (!pomInProjectRoot && pomInArtifactsDir) {
              return `scaffold 阶段 pom.xml 写入了错误位置 "${join(artifactsDir, "translations", artifactId)}"。Java 源文件必须写入 projectRoot="${expectedRoot}"，不能写入 artifactsDir/translations/。请将所有 Java 文件从 artifactsDir/translations/${artifactId}/ 移动到 ${expectedRoot}/。`
            }
            if (!pomInProjectRoot) {
              return `scaffold 阶段未在 projectRoot="${expectedRoot}" 下找到 pom.xml。请确保 Java 源文件写入 Runtime Context 中注入的 projectRoot 目录。`
            }
          }
        }
      }

      // inventory 阶段：校验 inventory-packages/ + inventory-index.json + analysis.json（reduce 归 inventory）
      if (phase === "inventory") {
        const pkgError = validateInventoryPackages(artifactsDir)
        if (pkgError) return pkgError
        // analysis.json 现由 inventory 阶段 generateAnalysis 代码产出，此处复验
        const analysisPath = join(artifactsDir, "analysis.json")
        if (!existsSync(analysisPath)) {
          return `Artifact not found on disk: ${analysisPath}. inventory 阶段必须调用 generateAnalysis 产出 analysis.json。`
        }
        try {
          const aRaw = readFileSync(analysisPath, "utf-8")
          const aParsed = JSON.parse(aRaw)
          const aResult = AnalysisMetaSchema.safeParse(aParsed)
          if (!aResult.success) {
            return `Zod validation failed for analysis.json:\n${formatZodIssues(aResult.error)}`
          }
        } catch (e: any) {
          return `Failed to read/parse analysis.json: ${e.message}`
        }
      }

      // dedup 阶段：增量模式下校验 dedup.json 未丢失非增量包数据
      if (phase === "dedup") {
        const currentEntry = engine.findCurrentEntry(run)
        const isIncremental = !!currentEntry?.incrementalContext?.targetPackages?.length
        if (isIncremental) {
          const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
          if (inventory) {
            const invPkgCount = engine.extractPackageNames(inventory).size
            const dedupStats = parsed.scanStats as { totalPackages?: number } | undefined
            if (dedupStats && dedupStats.totalPackages !== undefined && dedupStats.totalPackages < invPkgCount) {
              return `dedup.json scanStats.totalPackages (${dedupStats.totalPackages}) < inventory package count (${invPkgCount}). Incremental dedup must merge with existing data to preserve all packages.`
            }
            // 内容覆盖检查：验证 extractedModules 未丢失非目标包数据
            // 防止 agent 正确携带 totalPackages 计数但丢失非目标包的抽取数据
            const targetPkgs = new Set(
              ((currentEntry!.incrementalContext!.targetPackages as string[]) ?? [])
                .filter((p): p is string => typeof p === "string" && p.length > 0)
                .map((p) => p.toUpperCase())
            )
            const modules = (parsed.extractedModules as Array<{ sources?: Array<{ packageName: string }> }>) ?? []
            // 空模块 + 存在非目标包 → 数据丢失
            if (modules.length === 0 && invPkgCount > targetPkgs.size) {
              return `dedup.json incremental run has empty extractedModules but inventory has ${invPkgCount} packages (target: ${targetPkgs.size}). Non-target package data must be preserved.`
            }
            const sourcePkgs = new Set(
              modules.flatMap((m) => (m.sources ?? [])
                .map((s) => s.packageName)
                .filter((n): n is string => typeof n === "string" && n.length > 0)
              ).map((n) => n.toUpperCase())
            )
            const nonTargetSourcePkgs = [...sourcePkgs].filter((p) => !targetPkgs.has(p))
            if (modules.length > 0 && nonTargetSourcePkgs.length === 0 && invPkgCount > targetPkgs.size) {
              return `dedup.json incremental run has extracted modules only from target packages (${[...targetPkgs].join(", ")}), but inventory has ${invPkgCount} packages. Non-target package data may have been lost during merge.`
            }
          }
        }
      }
    } catch (e: any) {
      return `Failed to read/parse ${filePath}: ${e.message}`
    }
    return null // 校验通过
  }

  // 2. per-package schema（translate / review / verify）
  const perPackageSchema = getPerPackageSchema(phase)
  if (perPackageSchema) {
    // 检查 translations/ 目录下的 per-package artifact
    const translationsDir = join(artifactsDir, "translations")
    if (!existsSync(translationsDir)) {
      return `Translations directory not found: ${translationsDir}. Agent must write per-package artifacts before advancing.`
    }

    // 判断是否增量模式：查找当前 entry 的 incrementalContext
    const currentEntry = engine.findCurrentEntry(run)
    const isIncremental = !!currentEntry?.incrementalContext?.targetPackages?.length
    // per-package 文件名映射（translate → translation.json，其余与 phase 名一致）
    const pkgFileName = getArtifactFilename(phase)

    // 获取 inventory 期望包名列表（缓存到局部变量供非增量存在性检查 + Zod 校验共用）
    const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
    const expectedPackages = inventory
      ? Array.from(engine.extractPackageNames(inventory))
      : [] as string[]

    // 缓存目录读取结果，避免存在性检查 + Zod 校验循环中重复 readdirSync
    const cachedDirEntries = readdirSync(translationsDir, { withFileTypes: true })

    // 非增量模式：校验所有期望包都有对应的 artifact 文件
    if (!isIncremental) {
      if (!inventory) {
        return `inventory.json not found or malformed in ${artifactsDir}. Cannot verify per-package completeness for phase "${phase}".`
      }
      for (const pkgName of expectedPackages) {
        // 大小写不敏感匹配目录名（scanner 输出大写，LLM 可能用原始大小写）
        const actualDirName = findDirCaseInsensitive(translationsDir, pkgName, cachedDirEntries)
        if (!actualDirName) {
          return `Missing per-package directory: translations/${pkgName}/. All packages must have directories before advancing.`
        }
        const artifactFile = join(translationsDir, actualDirName, `${pkgFileName}.json`)
        if (!existsSync(artifactFile)) {
          return `Missing per-package artifact: translations/${actualDirName}/${pkgFileName}.json. All packages must have artifacts before advancing.`
        }
      }
    } else {
      // 增量模式：校验所有 targetPackages 都有对应的 artifact 文件
      const targetPackages = currentEntry?.incrementalContext?.targetPackages ?? []
      for (const pkgName of targetPackages) {
        const actualDirName = findDirCaseInsensitive(translationsDir, pkgName, cachedDirEntries)
        if (!actualDirName) {
          return `Missing per-package directory in incremental mode: translations/${pkgName}/`
        }
        const artifactFile = join(translationsDir, actualDirName, `${pkgFileName}.json`)
        if (!existsSync(artifactFile)) {
          return `Missing per-package artifact in incremental mode: translations/${actualDirName}/${pkgFileName}.json. All targetPackages must have artifacts before advancing.`
        }
      }
    }

    // Zod 校验：逐包验证 per-package artifact
    // 仅校验 inventory 期望的包（增量模式取 targetPackages，非增量取全部）
    const packagesToValidate = isIncremental
      ? (currentEntry?.incrementalContext?.targetPackages ?? [])
      : expectedPackages
    for (const pkgName of packagesToValidate) {
      // 大小写不敏感匹配磁盘目录名
      const actualDirName = findDirCaseInsensitive(translationsDir, pkgName, cachedDirEntries)
      if (!actualDirName) continue // 目录不存在（增量模式下未修改的包）
      const artifactFile = join(translationsDir, actualDirName, `${pkgFileName}.json`)
      if (!existsSync(artifactFile)) continue // 跳过无文件的包（增量模式下未修改的包）
      try {
        const raw = readFileSync(artifactFile, "utf-8")
        const parsed = JSON.parse(raw)
        const result = perPackageSchema.safeParse(parsed)
        if (!result.success) {
          const errors = formatZodIssues(result.error)
          return `Zod validation failed for translations/${actualDirName}/${pkgFileName}.json:\n${errors}`
        }
      } catch (e: any) {
        return `Failed to read/parse translations/${actualDirName}/${pkgFileName}.json: ${e.message}`
      }
    }

    // summary 必须存在且通过校验（review/verify 阶段）
    const summaryPhase = `${phase}-summary`
    const summarySchema = getSummarySchema(summaryPhase)
    if (summarySchema) {
      const summaryFile = join(artifactsDir, `${summaryPhase}.json`)
      if (!existsSync(summaryFile)) {
        return `Summary artifact not found: ${summaryFile}. Agent must write ${summaryPhase}.json before advancing.`
      }
      try {
        const raw = readFileSync(summaryFile, "utf-8")
        const parsed = JSON.parse(raw)
        const result = summarySchema.safeParse(parsed)
        if (!result.success) {
          const errors = formatZodIssues(result.error)
          return `Zod validation failed for ${summaryPhase}.json:\n${errors}`
        }
        // verify-summary: 校验 testFiles[] 中的路径实际存在
        if (summaryPhase === "verify-summary") {
          const te = parsed.testExecution as { executed?: boolean; testFiles?: string[] } | undefined
          if (te && te.executed) {
            const files = te.testFiles ?? []
            const missing = files.filter(
              (f) => !existsSync(f) && !existsSync(join(artifactsDir, f)) && !existsSync(join(process.cwd(), f))
            )
            if (missing.length > 0) {
              return `verify-summary declares testFiles that do not exist on disk:\n${missing.map((f) => `  - ${f}`).join("\n")}`
            }
          }
        }
      } catch (e: any) {
        return `Failed to read/parse ${summaryFile}: ${e.message}`
      }
    }
    return null
  }

  // 3. 没有对应 schema 的阶段（如 review/verify 但没有 per-package 概念的情况）
  // 不做校验
  return null
}

// ══════════════════════════════════════════════════════════════════
// P2a: Auto-fix 表面结构问题（strip 不合法的 null 值）
// ══════════════════════════════════════════════════════════════════

/**
 * 递归删除 JSON 对象中值为 null 的 key（仅当该 key 在 schema 中是 optional 但不是 nullable 时）。
 *
 * 策略：先尝试 Zod safeParse，如果失败，从错误信息中提取 "received null" 的路径，
 * 只删除那些报错的 null 字段，保留 .nullable() 字段中的合法 null。
 * 如果首次 safeParse 通过，则不需要任何修改。
 */
function stripInvalidNulls(obj: any, schema: import("zod").ZodType): any {
  // 先试一次 safeParse，如果通过则无需修改
  const firstTry = schema.safeParse(obj)
  if (firstTry.success) return obj

  // 收集所有 "received null" 的错误路径
  const nullPaths: string[][] = []
  if (!firstTry.success) {
    for (const issue of firstTry.error.issues) {
      if (issue.message.includes("null") || issue.message.toLowerCase().includes("expected") && issue.message.includes("null")) {
        nullPaths.push(issue.path.map(String))
      }
    }
  }
  if (nullPaths.length === 0) return obj

  // 递归删除指定路径上的 null 值
  return deletePaths(obj, nullPaths)
}

/** 递归删除 JSON 中指定路径的 null 值 */
function deletePaths(obj: any, paths: string[][]): any {
  let changed = false
  const result = Array.isArray(obj) ? [...obj] : { ...obj }

  // 精确删除：如果某个 path 完全匹配，且当前值为 null
  for (const path of paths) {
    if (path.length === 0) continue
    let current: any = result
    let valid = true
    for (let i = 0; i < path.length - 1; i++) {
      if (current == null || typeof current !== "object") { valid = false; break }
      current = current[path[i]]
    }
    if (!valid) continue
    const lastKey = path[path.length - 1]
    if (current != null && typeof current === "object" && current[lastKey] === null) {
      delete current[lastKey]
      changed = true
    }
  }

  // 递归处理嵌套对象/数组（处理子路径）
  for (const key of Object.keys(result)) {
    if (result[key] !== null && typeof result[key] === "object") {
      const subPaths = paths
        .filter(p => p.length > 1 && p[0] === key)
        .map(p => p.slice(1))
      if (subPaths.length > 0) {
        const sub = deletePaths(result[key], subPaths)
        if (sub !== result[key]) {
          result[key] = sub
          changed = true
        }
      }
    }
  }

  return changed ? result : obj
}

/** 对单个 artifact 文件执行 auto-fix（strip 不合法的 null）并写回 */
function stripNullsAndRewrite(filePath: string, schema?: import("zod").ZodType): boolean {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    if (!schema) {
      // 无 schema 时不做修改
      return false
    }
    const stripped = stripInvalidNulls(parsed, schema)
    if (stripped !== parsed) {
      safeWriteFile(filePath, JSON.stringify(stripped, null, 2))
      return true
    }
  } catch {
    // 读取/解析失败 → 跳过，由 Zod 校验报错
  }
  return false
}

/**
 * 自动修复当前阶段的表面结构问题（strip null 值）。
 * 返回是否有文件被修复，以及修复的文件列表。
 */
function autoFixStructuralIssues(run: WorkflowRun): {
  fixed: boolean
  files: string[]
  summary: string
} {
  const phase = run.currentPhase
  if (!phase) return { fixed: false, files: [], summary: "" }
  const artifactsDir = join(ARTIFACT_DIR, run.runId)
  const fixedFiles: string[] = []

  // 1. 顶层 schema artifact
  const topLevelSchema = getSchemaForPhase(phase)
  if (topLevelSchema) {
    const fileName = getArtifactFilename(phase)
    const filePath = join(artifactsDir, `${fileName}.json`)
    if (existsSync(filePath) && stripNullsAndRewrite(filePath, topLevelSchema)) {
      fixedFiles.push(`${fileName}.json`)
    }
  }

  // 2. per-package artifacts (translate/review/verify)
  const perPkgSchema = getPerPackageSchema(phase)
  if (perPkgSchema) {
    const pkgFileName = getArtifactFilename(phase)
    const translationsDir = join(artifactsDir, "translations")
    if (existsSync(translationsDir)) {
      try {
        for (const dir of readdirSync(translationsDir, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue
          const filePath = join(translationsDir, dir.name, `${pkgFileName}.json`)
          if (existsSync(filePath) && stripNullsAndRewrite(filePath, perPkgSchema)) {
            fixedFiles.push(`translations/${dir.name}/${pkgFileName}.json`)
          }
        }
      } catch { /* ignore */ }
    }
  }

  // 3. summary artifacts (review-summary, verify-summary)
  const summarySchema = getSummarySchema(`${phase}-summary`)
  if (summarySchema) {
    const filePath = join(artifactsDir, `${phase}-summary.json`)
    if (existsSync(filePath) && stripNullsAndRewrite(filePath, summarySchema)) {
      fixedFiles.push(`${phase}-summary.json`)
    }
  }

  // 4. inventory per-package
  if (phase === "inventory") {
    const invPkgSchema = getInventoryPackageSchema()
    const invPkgDir = join(artifactsDir, "inventory-packages")
    if (existsSync(invPkgDir)) {
      try {
        for (const f of readdirSync(invPkgDir).filter(f => f.endsWith(".json"))) {
          const filePath = join(invPkgDir, f)
          if (stripNullsAndRewrite(filePath, invPkgSchema)) {
            fixedFiles.push(`inventory-packages/${f}`)
          }
        }
      } catch { /* ignore */ }
    }
    // inventory-index.json
    const idxSchema = getSchemaForPhase("inventory-index")
    const idxPath = join(artifactsDir, "inventory-index.json")
    if (existsSync(idxPath) && stripNullsAndRewrite(idxPath, idxSchema ?? undefined)) {
      fixedFiles.push("inventory-index.json")
    }
  }

  // 5. analyze：PROCEDURE 级 per-unit 文件（analysis-packages/{pkg}/{ref}.json，UnitAnalysisSchema）
  //    + 包级回退聚合（analysis-packages/{pkg}.json，AnalysisPackageSchema）。两者都扫，覆盖 unit 模式与
  //    旧 run 包级回退；per-unit 文件在 {pkg}/ 子目录，须递归子目录 strip（顶层 readdirSync 不递归）。
  if (phase === "analyze") {
    const anaPkgDir = join(artifactsDir, "analysis-packages")
    if (existsSync(anaPkgDir)) {
      const unitSchema = getPerUnitSchema("analyze") // UnitAnalysisSchema
      const aggSchema = getAnalysisPackageSchema()
      try {
        for (const entry of readdirSync(anaPkgDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".json")) {
            // 包级回退聚合 analysis-packages/{pkg}.json
            const filePath = join(anaPkgDir, entry.name)
            if (stripNullsAndRewrite(filePath, aggSchema)) {
              fixedFiles.push(`analysis-packages/${entry.name}`)
            }
          } else if (entry.isDirectory()) {
            // unit 模式 per-unit analysis-packages/{pkg}/{ref}.json
            const subDir = join(anaPkgDir, entry.name)
            for (const f of readdirSync(subDir).filter(f => f.endsWith(".json"))) {
              const filePath = join(subDir, f)
              if (stripNullsAndRewrite(filePath, unitSchema ?? undefined)) {
                fixedFiles.push(`analysis-packages/${entry.name}/${f}`)
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return {
    fixed: fixedFiles.length > 0,
    files: fixedFiles,
    summary: fixedFiles.length > 0
      ? `Stripped null values from: ${fixedFiles.join(", ")}`
      : "",
  }
}

/**
 * 校验 --phases 前置依赖（支持 OR-group）
 * 返回缺失项列表，空数组表示全部通过
 * .json 文件额外校验内容可解析（防止空文件或损坏 JSON 通过检查）
 */
function checkPrerequisites(targetPhases: string[], artifactsDir: string): string[] {
  const missing: string[] = []
  for (const phase of targetPhases) {
    const prereqs = PHASE_PREREQUISITES[phase]
    if (!prereqs) continue
    for (const item of prereqs) {
      if (Array.isArray(item)) {
        // OR-group：至少一个存在且有效即可
        const anyValid = item.some(f => {
          const fullPath = join(artifactsDir, f)
          if (!existsSync(fullPath)) return false
          return validateJsonContent(fullPath, f)
        })
        if (!anyValid) {
          missing.push(`${item.join(" 或 ")}（至少需要其中一个）`)
        }
      } else {
        const fullPath = join(artifactsDir, item)
        if (!existsSync(fullPath)) {
          missing.push(item)
        } else if (!validateJsonContent(fullPath, item)) {
          missing.push(`${item}（文件存在但内容无效）`)
        }
      }
    }
  }
  return missing
}

/** 校验 .json 文件内容可解析（非 .json 文件/目录直接返回 true） */
function validateJsonContent(fullPath: string, name: string): boolean {
  if (!name.endsWith(".json")) return true  // 目录类 prerequisite 不校验内容
  try {
    JSON.parse(readFileSync(fullPath, "utf-8"))
    return true
  } catch {
    return false
  }
}

/**
 * 大小写不敏感的文件查找
 * 在指定目录下查找文件名（不含 .json 后缀）与 targetName 匹配的文件。
 * 返回磁盘上的实际文件名（含 .json），未找到返回 null。
 * 可传入预读的 entries 列表以避免重复 readdirSync。
 */
function findFileCaseInsensitive(dir: string, targetName: string, cachedEntries?: import("node:fs").Dirent[]): string | null {
  if (!targetName || typeof targetName !== "string") return null
  const targetUpper = targetName.toUpperCase()
  // 预编译正则：仅匹配单个 .json 后缀，避免 .json.json 被过度剥离
  const jsonSuffixRe = /\.json$/i
  try {
    const entries = cachedEntries ?? readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      // 仅匹配文件（排除子目录），且必须以 .json 结尾
      if (!entry.isFile() || !jsonSuffixRe.test(entry.name)) continue
      const nameWithoutExt = entry.name.replace(jsonSuffixRe, "").toUpperCase()
      if (nameWithoutExt === targetUpper) {
        return entry.name
      }
    }
  } catch {
    // 目录不存在或不可读
  }
  return null
}

/**
 * 大小写不敏感的目录查找
 * 在父目录下查找与 targetName 匹配的子目录名。
 * 返回磁盘上的实际目录名，未找到返回 null。
 * 可传入预读的 entries 列表以避免重复 readdirSync。
 */
function findDirCaseInsensitive(parentDir: string, targetName: string, cachedEntries?: import("node:fs").Dirent[]): string | null {
  if (!targetName || typeof targetName !== "string") return null
  const targetUpper = targetName.toUpperCase()
  try {
    const entries = cachedEntries ?? readdirSync(parentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toUpperCase() === targetUpper) {
        return entry.name
      }
    }
  } catch {
    // 目录不存在或不可读
  }
  return null
}

/** 递归截断对象中所有超过 maxLength 的字符串字段（含嵌套对象/数组），返回新对象不修改原始 */
function truncateStringsDeep(obj: unknown, maxLength: number): unknown {
  if (!obj || typeof obj !== "object") return obj
  if (Array.isArray(obj)) {
    return obj.map(item => {
      if (typeof item === "string" && item.length > maxLength) {
        return item.slice(0, maxLength) + `\n... [truncated, total ${item.length} bytes]`
      } else if (typeof item === "object" && item !== null) {
        return truncateStringsDeep(item, maxLength)
      }
      return item
    })
  } else {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const val = (obj as Record<string, unknown>)[key]
      if (typeof val === "string" && val.length > maxLength) {
        result[key] = val.slice(0, maxLength) + `\n... [truncated, total ${val.length} bytes]`
      } else if (typeof val === "object" && val !== null) {
        result[key] = truncateStringsDeep(val, maxLength)
      } else {
        result[key] = val
      }
    }
    return result
  }
}

// ── 文件写入路径拦截：类型、常量、辅助函数 ──────────────────────────────────

/** 禁止写入的敏感目录名 */
const SENSITIVE_DIR_NAMES = new Set([".git", ".claude", ".svn", ".hg", "node_modules"])

/** 项目文件扩展名 — 应写入 projectRoot */
const PROJECT_FILE_EXTS = /\.(java|xml|yml|yaml|properties|sql)$/i

/** Artifact 文件扩展名 — 应写入 artifactsDir */
const ARTIFACT_FILE_EXTS = /\.(json|md)$/i

type FileType = 'project' | 'artifact' | 'unknown'
type WriteZone = 'artifacts' | 'project' | 'source' | 'sensitive' | 'outside'

interface PathClassification {
  zone: WriteZone
  fileType: FileType
  shouldRedirect: boolean
  correctedPath: string | null
  shouldBlock: boolean
  blockReason?: string
}

/** 判断文件路径类型：项目文件 / artifact / 未知 */
function classifyFileType(filePath: string): FileType {
  if (PROJECT_FILE_EXTS.test(filePath)) return 'project'
  if (ARTIFACT_FILE_EXTS.test(filePath)) return 'artifact'
  return 'unknown'
}

/** 向后兼容：buildSharedInstructions / dispatch 文本中引用的旧函数 */
function isProjectFile(path: string): boolean {
  return classifyFileType(path) === 'project'
}

/** artifactsDir 下已知子目录前缀，重定向时需剥除 */
const ARTIFACT_PREFIX_RE = /^(?:translations|analysis-packages|inventory-packages|status|metrics|fsd|reports)\/[^/]+\//

/**
 * 从 artifactsDir 下的相对路径中剥除 artifact 子目录前缀，提取项目文件路径。
 *
 * "translations/ORDER_PKG/src/main/java/.../Order.java" → "src/main/java/.../Order.java"
 * "analysis-packages/ORDER_PKG/src/main/..."             → "src/main/..."
 * "src/main/java/.../Order.java" (无前缀)               → "src/main/java/.../Order.java"
 */
function stripArtifactPrefixes(relPath: string): string {
  let cleaned = relPath.replace(ARTIFACT_PREFIX_RE, '')
  const srcIdx = cleaned.indexOf('src/')
  if (srcIdx > 0) cleaned = cleaned.substring(srcIdx)
  if (!cleaned.startsWith('src/')) return cleaned.split('/').pop() ?? cleaned
  return cleaned
}

/**
 * 从 run 元数据解析 sourcePath 的绝对路径。
 * plan 前阶段或未设置时返回空字符串。
 */
function resolveSourcePath(runId: string): string {
  const run = engine.status(runId)
  if (!run) return ''
  const raw = (run.metadata as Record<string, unknown>).sourcePath
  if (!raw || typeof raw !== 'string') return ''
  return resolve(raw)
}

/**
 * 统一路径分类：判断写入路径应归属哪个 zone，以及是否需要重定向或阻止。
 *
 * 所有路径须先通过 resolve() 转为绝对路径。
 * projectRoot 为空时（plan 前阶段），只做 sensitive block，不 redirect。
 *
 * Zone 优先级：sensitive > artifacts > project > source > outside
 *
 * | Zone      | 项目文件         | Artifact 文件   |
 * |-----------|-----------------|-----------------|
 * | artifacts | → redirect projectRoot | ✅ allow    |
 * | project   | ✅ allow        | → redirect artifactsDir |
 * | source    | 🚫 block        | 🚫 block       |
 * | sensitive | 🚫 block        | 🚫 block       |
 * | outside   | → redirect projectRoot | → redirect artifactsDir |
 */
function classifyWritePath(
  filePath: string,
  artifactsDir: string,
  projectRoot: string,
  sourcePath: string,
): PathClassification {
  const fileType = classifyFileType(filePath)
  const normalized = filePath.replace(/\\/g, '/')

  // 1. Sensitive 目录检查（优先级最高，始终 block）
  for (const seg of normalized.split('/')) {
    if (SENSITIVE_DIR_NAMES.has(seg)) {
      return {
        zone: 'sensitive',
        fileType,
        shouldRedirect: false,
        correctedPath: null,
        shouldBlock: true,
        blockReason: `写入敏感目录 "${seg}" 被禁止`,
      }
    }
  }

  // 2. Zone 判定（按路径前缀匹配，most specific first）
  const normArtifacts = artifactsDir.replace(/\\/g, '/')
  const normProject = projectRoot.replace(/\\/g, '/')
  const normSource = sourcePath.replace(/\\/g, '/')

  let zone: WriteZone
  if (normArtifacts && normalized.startsWith(normArtifacts + '/')) {
    zone = 'artifacts'
  } else if (normProject && normalized.startsWith(normProject + '/')) {
    zone = 'project'
  } else if (normSource && normalized.startsWith(normSource + '/')) {
    zone = 'source'
  } else {
    zone = 'outside'
  }

  // 3. Source zone：只读，一律 block
  if (zone === 'source') {
    return {
      zone,
      fileType,
      shouldRedirect: false,
      correctedPath: null,
      shouldBlock: true,
      blockReason: `sourcePath 目录是只读的，禁止写入`,
    }
  }

  // 4. Artifacts zone：项目文件 → redirect 到 projectRoot；artifact 文件 → allow
  if (zone === 'artifacts') {
    if (fileType === 'project' && projectRoot) {
      const relPath = normalized.substring(normArtifacts.length + 1)
      const cleanedRel = stripArtifactPrefixes(relPath)
      return {
        zone,
        fileType,
        shouldRedirect: true,
        correctedPath: normProject + '/' + cleanedRel,
        shouldBlock: false,
      }
    }
    return { zone, fileType, shouldRedirect: false, correctedPath: null, shouldBlock: false }
  }

  // 5. Project zone：项目文件 → allow；artifact 文件 → redirect 到 artifactsDir
  if (zone === 'project') {
    if (fileType === 'artifact' && artifactsDir) {
      const relPath = normalized.substring(normProject.length + 1)
      return {
        zone,
        fileType,
        shouldRedirect: true,
        correctedPath: normArtifacts + '/' + relPath,
        shouldBlock: false,
      }
    }
    return { zone, fileType, shouldRedirect: false, correctedPath: null, shouldBlock: false }
  }

  // 6. Outside zone：按文件类型 redirect 到对应目录
  if (zone === 'outside') {
    if (fileType === 'project' && projectRoot) {
      // 尝试从路径中提取 src/ 段
      const srcIdx = normalized.indexOf('/src/')
      let correctedPath: string
      if (srcIdx > 0) {
        const relFromSrc = normalized.substring(srcIdx + 1) // "src/main/..."
        correctedPath = normProject + '/' + relFromSrc
      } else {
        // fallback: 只取文件名
        const fileName = normalized.split('/').pop() ?? 'unknown'
        correctedPath = normProject + '/' + fileName
      }
      return {
        zone,
        fileType,
        shouldRedirect: true,
        correctedPath,
        shouldBlock: false,
      }
    }
    if (fileType === 'artifact' && artifactsDir) {
      const fileName = normalized.split('/').pop() ?? 'unknown'
      return {
        zone,
        fileType,
        shouldRedirect: true,
        correctedPath: normArtifacts + '/' + fileName,
        shouldBlock: false,
      }
    }
    // 未知文件类型在 outside zone：允许（不拦截 .txt, .log 等）
    return { zone, fileType, shouldRedirect: false, correctedPath: null, shouldBlock: false }
  }

  // 不可达，TypeScript 兜底
  return { zone: 'outside', fileType, shouldRedirect: false, correctedPath: null, shouldBlock: false }
}

// ══════════════════════════════════════════════════════════════════════════════
// 分片模式 upstream 收窄（dispatch 用，纯函数便于测试）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 分片模式下收窄 worker 的 upstream artifact 列表。
 *
 * 一个分片的 worker 只需读自己分片 targetPackages 的 per-package 文件 + 已完成分片的
 * translation.json（跨包调用）。全量 per-package glob 若不收窄，worker 会读所有包的
 * per-package 文件，顺手写出其他包的产物（analyze 的 FSD、translate/review 的 per-package
 * 文件）——这是分片隔离的漏洞。
 *
 * 规则：
 *  - translations 通配（translations 下所有 translation.json）→ 展开为已完成分片各包
 *  - inventory-packages 通配  → 收窄为本分片 targetPackages 各包
 *  - analysis-packages 通配   → 收窄为本分片 targetPackages 各包
 *  - fsd 通配（fsd 下所有 .md）→ 收窄为本分片 targetPackages 各包的 fsd/{pkg}/*.md
 *  - translate 阶段额外追加已完成分片的 translation.json（跨包调用依赖，translator.md 承诺）
 *  - 全局只读 artifact（analysis.json、plan.json 等）原样保留
 *
 * 跨包调用关系不需要读别的包的 inventory-packages/analysis-packages：analyze 从 analysis.json
 * 的 callGraph 取，translate 从已完成分片的 translation.json.subprogramMethods 取。
 */
export function narrowUpstreamForShard(
  upstream: readonly string[],
  phase: string,
  targetPkgs: readonly string[],
  completedPkgs: readonly string[],
  opts?: {
    targetUnits?: readonly string[]
    functionOwnership?: Record<string, string>
  },
): string[] {
  const targetUnits = opts?.targetUnits ?? []

  // ── translate/analyze PROCEDURE 级（unit 模式）：shards 元素是 unit id `PKG.refName` ──
  // PROCEDURE 为 unit，FUNCTION 跟随属主（cargo）。收窄到本分片 unit 的源码/FSD + 已完成 unit
  // 所属包的聚合 translation.json（translate 跨包 + 同包跨单元调用解析）。
  // analyze 的 upstream 不含 fsd/analysis-packages/translations（它是产出方），下列分支对 analyze
  // 仅 inventory-packages 收窄生效，其余 no-op。
  if ((phase === "translate" || phase === "analyze") && targetUnits.length > 0) {
    const ownership = opts?.functionOwnership ?? {}
    const unitPkgs = [...new Set(targetUnits.map(pkgOf))]
    // 已完成 unit（completedPkgs 在 unit 模式下是 unit id）→ 包，供读聚合 translation.json
    const completedUnitPkgs = [...new Set(completedPkgs.map(pkgOf))]

    // 本分片 FSD：每个 unit 的根 FSD + 其 cargo FUNCTION 的 FSD
    const fsdFiles: string[] = []
    for (const u of targetUnits) {
      fsdFiles.push(`fsd/${pkgOf(u)}/${refOf(u)}.md`)
      for (const [func, owner] of Object.entries(ownership)) {
        if (owner === u) fsdFiles.push(`fsd/${pkgOf(func)}/${refOf(func)}.md`)
      }
    }

    return upstream.flatMap(a => {
      if (a === "inventory-packages/*.json") return unitPkgs.map(p => `inventory-packages/${p}.json`)
      if (a === "analysis-packages/*.json") return unitPkgs.map(p => `analysis-packages/${p}.json`)
      if (a === "fsd/*/*.md") return fsdFiles
      if (a === "translations/*/translation.json") {
        return completedUnitPkgs.map(p => `translations/${p}/translation.json`)
      }
      return [a]
    })
  }

  // 1) translations/* glob 收窄
  // - review：审查当前分片包的翻译 → 收窄到 targetPackages（本分片包）。原逻辑用 completedPkgs
  //   收窄，review 第一分片 completedPkgs=[] 时 glob 保留，导致 worker 读到全部包 translation 全审了。
  // - translate/dedup/fix：跨包对接依赖已完成包的翻译 → 收窄到 completedPkgs
  //   （completedPkgs 为空时保留 glob；translate 第一分片时 translations/* 尚未生成，glob 匹配为空无害）
  let result = upstream.flatMap(a => {
    if (a !== "translations/*/translation.json") return [a]
    if (phase === "review" && targetPkgs.length > 0) {
      return targetPkgs.map(pkg => `translations/${pkg}/translation.json`)
    }
    if (completedPkgs.length > 0) {
      return completedPkgs.map(pkg => `translations/${pkg}/translation.json`)
    }
    return [a]
  })
  // 2) per-package glob → 收窄到本分片 targetPackages
  if (targetPkgs.length > 0) {
    result = result.flatMap(a => {
      if (a === "inventory-packages/*.json") {
        return targetPkgs.map(pkg => `inventory-packages/${pkg}.json`)
      }
      if (a === "analysis-packages/*.json") {
        return targetPkgs.map(pkg => `analysis-packages/${pkg}.json`)
      }
      // fsd/*/*.md → 本包 FSD 目录 fsd/{pkg}/*.md。FSD 是聚合文档、translate 按它实施，
      // 应只读本包对应的 FSD；需要其他包 FSD 时由 worker 显式指明具体文件（见 translator.md）。
      if (a === "fsd/*/*.md") {
        return targetPkgs.map(pkg => `fsd/${pkg}/*.md`)
      }
      return [a]
    })
  }
  // 3) translate：追加已完成分片的 translation.json（跨包调用依赖）
  if (phase === "translate" && completedPkgs.length > 0) {
    const existing = new Set(result)
    for (const pkg of completedPkgs) {
      const p = `translations/${pkg}/translation.json`
      if (!existing.has(p)) {
        result.push(p)
        existing.add(p)
      }
    }
  }
  return result
}

/**
 * 构建分片 work order 的「单元读取清单」（中间文件，软约束）：对本分片每个 targetUnit 精准列出
 * 要读的源码文件 + 行范围（sed -n）+ cargo FUNCTION + FSD/依赖聚合路径。数据确定性取自
 * inventory-packages（lineRange/bodyFile）+ analysis.json（functionOwnership/callGraph）。
 *
 * 目的：把「读取单元」收紧到「工作单元」——agent 按清单 sed -n 抽片段，不再读整包 body 顺手全做
 * （详见 [[translate-procedure-level]] / analyze 下沉）。analyze 与 translate 共用。
 *
 * 返回文本块（含分片信息后注入）；targetUnits 为空或非 unit 阶段时返回空串。
 */
export function buildUnitScopeBlock(
  artifactsDir: string,
  targetUnits: readonly string[],
  phase: string,
  completedUnitIds: readonly string[],
  sourcePath = "",
): string {
  if (targetUnits.length === 0) return ""
  if (phase !== "analyze" && phase !== "translate") return ""

  const analysis = engine.loadArtifactJson(artifactsDir, "analysis")
  const ownership = (analysis?.functionOwnership as Record<string, string> | undefined) ?? {}
  const callGraph = (analysis?.callGraph as Record<string, string[]> | undefined) ?? {}

  // inventory-packages 的 bodyFile/specFile 是相对 sourcePath 的路径；worker subagent 的 cwd
  // 是 opencode 项目根（≠ sourcePath），故 sed 命令必须用绝对路径——否则找不到文件。
  // 与代码库"全部消费绝对路径，消除 cwd 依赖"原则一致（见 dispatch 注释）。
  const absSrc = (rel: string | null | undefined): string | null | undefined => {
    if (!rel) return rel
    return isAbsolute(rel) ? rel : join(sourcePath, rel)
  }

  // inventory-packages/{pkg}.json 缓存：refName → { lineRange, bodyFile }
  const procCache = new Map<string, Map<string, { lineRange: [number, number]; bodyFile: string | null | undefined }>>()
  function refMapForPkg(pkg: string): Map<string, { lineRange: [number, number]; bodyFile: string | null | undefined }> | null {
    if (procCache.has(pkg)) return procCache.get(pkg)!
    const invPkgPath = join(artifactsDir, "inventory-packages", `${pkg}.json`)
    if (!existsSync(invPkgPath)) { procCache.set(pkg, new Map()); return procCache.get(pkg)! }
    let invPkg: any
    try {
      invPkg = JSON.parse(readFileSync(invPkgPath, "utf-8"))
    } catch {
      procCache.set(pkg, new Map()); return procCache.get(pkg)!
    }
    const procs: any[] = Array.isArray(invPkg.procedures) ? invPkg.procedures : []
    const refNames = refNamesForPackage(procs.map((p: any) => p.name))
    const bodyFile = invPkg.bodyFile ?? invPkg.specFile // 过程实现体在 body；standalone 虚拟包 bodyFile=源文件
    const m = new Map<string, { lineRange: [number, number]; bodyFile: string | null | undefined }>()
    procs.forEach((p: any, i: number) => {
      const ref = refNames[i]
      if (ref && Array.isArray(p.lineRange) && p.lineRange.length === 2) {
        m.set(ref, { lineRange: [Number(p.lineRange[0]), Number(p.lineRange[1])], bodyFile })
      }
    })
    procCache.set(pkg, m)
    return m
  }

  // 已完成 unit 的所属包（大写集合，大小写不敏感匹配；拼路径时用原大小写 tPkg）
  const completedPkgsUpper = new Set(completedUnitIds.map(u => pkgOf(u).toUpperCase()))
  const lines: string[] = [
    `## 本分片单元读取清单（精准范围 — 只读这些，禁止 read 整包源码）`,
    `按下列 sed -n 命令抽取源码片段（路径为绝对路径，直接执行即可）；禁止 read 整个包 body/spec 文件。`,
  ]

  for (const u of targetUnits) {
    const pkg = pkgOf(u)
    const rootRef = refOf(u)
    const refMap = refMapForPkg(pkg)
    const root = refMap?.get(rootRef)
    lines.push(`### unit ${u}`)
    if (root) {
      const [s, e] = root.lineRange
      const src = absSrc(root.bodyFile)
      lines.push(`- 根 ${rootRef}：源码 \`${src}\` 行 ${s}-${e} → \`sed -n '${s},${e}p' '${src}'\``)
    } else {
      lines.push(`- 根 ${rootRef}：lineRange 未在 inventory-packages/${pkg}.json 找到（按 refName 自行定位，仅抽该子程序片段，路径相对 sourcePath=${sourcePath || "（未注入）"}）`)
    }
    // cargo FUNCTION
    for (const [func, owner] of Object.entries(ownership)) {
      if (owner !== u) continue
      const fRef = refOf(func)
      const fPkg = pkgOf(func)
      const fm = refMapForPkg(fPkg)?.get(fRef)
      if (fm) {
        const [s, e] = fm.lineRange
        const src = absSrc(fm.bodyFile)
        lines.push(`- cargo FUNCTION ${fRef}：源码 \`${src}\` 行 ${s}-${e} → \`sed -n '${s},${e}p' '${src}'\``)
      } else {
        lines.push(`- cargo FUNCTION ${fRef}：lineRange 未找到（按 refName 自行定位，仅抽该子程序片段）`)
      }
    }
    // 阶段产物/输入路径
    if (phase === "analyze") {
      // 输出路径：per-unit 结构 + 根 FSD + 各 cargo FUNCTION FSD（cargo 用 func 所属包，与 validator 一致）
      const outParts = [`analysis-packages/${pkg}/${rootRef}.json（结构）`, `fsd/${pkg}/${rootRef}.md（FSD）`]
      for (const [func, owner] of Object.entries(ownership)) {
        if (owner === u) outParts.push(`fsd/${pkgOf(func)}/${refOf(func)}.md（cargo FSD）`)
      }
      lines.push(`- 输出：${outParts.join(" + ")}`)
    } else {
      // translate：FSD 输入（根 + cargo）
      const fsdInputs = [`fsd/${pkg}/${rootRef}.md`]
      for (const [func, owner] of Object.entries(ownership)) if (owner === u) fsdInputs.push(`fsd/${pkgOf(func)}/${refOf(func)}.md`)
      lines.push(`- FSD 输入：${fsdInputs.join(", ")}`)
      // 依赖聚合 translation：跨包调用目标（已完成分片）+ 本包聚合（同包跨单元）
      // 包名比较大小写不敏感（与文件其余处一致）；depPkgs 保留原大小写用于拼路径
      const depPkgs = new Set<string>()
      const cgKey = `${pkg}.${rootRef}`
      for (const tgt of (callGraph[cgKey] ?? [])) {
        const tPkg = pkgOf(tgt)
        if (tPkg.toUpperCase() !== pkg.toUpperCase() && completedPkgsUpper.has(tPkg.toUpperCase())) depPkgs.add(tPkg)
      }
      // 同包跨单元：本包聚合 translation.json（含 prior unit 的 subprogramMethods）
      depPkgs.add(pkg)
      lines.push(`- 依赖聚合 translation：${[...depPkgs].map(p => `translations/${p}/translation.json`).join(", ")}（仅读 subprogramMethods 对接调用，勿顺带处理）`)
    }
    // 子程序结构（translate 需 analysis-packages 聚合；analyze 是产出方不读）
    if (phase === "translate") {
      lines.push(`- 子程序结构：analysis-packages/${pkg}.json（按本 unit 根+cargo refName 取 blocks/variables/cursors/exceptionHandlers/translationNotes）`)
    }
  }

  lines.push(`⛔ 只处理以上 unit，只读以上列出的源码片段与文件。其他包/单元由别的分片处理。`)
  return lines.join("\n")
}

// ── 插件导出 ──────────────────────────────────────────────────────────────────

export const WorkflowEnginePlugin = async ({ $ }: { $: any }) => {
  // 尝试安装依赖，失败则注册 stub 工具提供清晰错误信息（Fix #2）
  let depsOk = false
  try {
    await ensureDeps()
    depsOk = true
  } catch (_e: any) {
    // runId 未初始化，日志忽略
  }

  // 依赖就绪后才动态 import npm 包（ESM-only 包无法用 require 加载）
  let toolFn: any
  let zFn: any
  if (depsOk) {
    try {
      const opencodePlugin = await import("@opencode-ai/plugin")
      toolFn = opencodePlugin.tool
      const zodMod = await import("zod")
      zFn = zodMod.z
    } catch (_e: any) {
      depsOk = false
    }
  }

  // 依赖不可用：注册 stub workflow 工具，返回安装指引
  if (!depsOk || !toolFn || !zFn) {
    return {
      tool: {
        workflow: {
          description: "Workflow engine (依赖未安装)",
          args: { action: { type: "string" } },
          execute: async () => "❌ 工作流引擎依赖未安装。请手动执行：cd .opencode && npm install",
        },
      },
    }
  }

  return ({
  tool: {
    workflow: toolFn({
      description:
        "Deterministic multi-phase workflow engine for SQL→Java translation.",
      args: {
        action: zFn.enum([
          "start", "advance", "confirm", "retry", "abort", "status", "list",
          "prerequisites", "resume", "fixContinue", "dispatch",
        ]),
        runId: zFn.string().optional(),
        sourcePath: zFn.string().optional(),
        artifact: zFn.any().optional(),
        result: zFn.enum(["passed", "failed"]).optional(),
        phases: zFn.string().optional(),        // --phases 用
        dbConf: zFn.string().optional(),        // --db_conf 用
        specConf: zFn.string().optional(),      // --spec 用
        mainEntry: zFn.string().optional(),     // 翻译起点/对外门面包，自然语言提取或 --mainEntry
        originalInput: zFn.string().optional(), // 用户原始 $ARGUMENTS 文字，写入 run-context.json 供回溯
      },
      execute: async (args: any, context: any) => {
        // ── Worker 编排工具拦截（L1 防线）──
        // Worker subagent 只能调用 status/list/prerequisites/saveArtifact，
        // 编排类 action（advance/confirm/retry/abort/dispatch/fixContinue/start）
        // 由 Orchestrator 在编排循环中调用，Worker 越权调用直接拒绝。
        const ORCHESTRATOR_ONLY_ACTIONS = new Set([
          "advance", "confirm", "retry", "abort", "dispatch", "fixContinue", "start",
        ])
        const agentName = context?.agent ?? ""
        const isWorker = getSubagentNames().includes(agentName)
        if (isWorker && ORCHESTRATOR_ONLY_ACTIONS.has(args.action)) {
          return `⛔ Worker（${agentName}）不能调用 workflow ${args.action}——这是编排者的职责。\n` +
            `请完成当前阶段工作，写入 artifact，输出 WORKER_SUMMARY 即可。编排者会推进流程。`
        }

        // opencode 1.4.6: execute 必须返回 string，title/metadata 通过 context.metadata() 设置
        // 用 IIFE 包裹现有逻辑，后处理转换 { title, output, metadata } → string
        const _r = await (async () => {
        switch (args.action) {
          // ── start ──
          case "start": {
            // 路径规范化：在入口统一 resolve 成绝对路径，下游（metadata / run-context.json /
            // dispatch 注入 / loadUserSpec / scanSource / fetchSchemaIfNeeded）全部消费绝对路径，
            // 消除 worker subagent 与 resume 跨 cwd 的对齐风险。originalInput 仍保留用户原文用于回溯。
            if (args.sourcePath) args.sourcePath = resolve(args.sourcePath)
            if (args.dbConf) args.dbConf = resolve(args.dbConf)
            if (args.specConf) args.specConf = resolve(args.specConf)

            const runId = args.runId ?? formatRunId(args.sourcePath)
            initLogger(runId)

            // 加载用户自定义规约（--spec）
            let userSpecResult: UserSpecResult | null = null
            try {
              userSpecResult = loadUserSpec(args.specConf, args.sourcePath)
            } catch (e: any) {
              return {
                title: "Error",
                output: `❌ ${e.message}`,
                metadata: { runId, dispatch: false },
              }
            }
            const metadata: Record<string, unknown> = {}
            if (args.sourcePath) metadata.sourcePath = args.sourcePath
            if (args.dbConf) metadata.dbConf = args.dbConf
            if (args.specConf) metadata.specConf = args.specConf
            if (args.mainEntry) metadata.mainEntry = args.mainEntry
            if (userSpecResult?.projectStructure) metadata.projectStructure = userSpecResult.projectStructure
            if (userSpecResult?.sourcePath) metadata.userSpecPath = userSpecResult.sourcePath

            // 尝试从磁盘恢复已有 run
            try {
              const existing = engine.loadFromDisk(runId)
              if (existing) {
                setWorkflowContext(existing)
                return {
                  title: "Resumed",
                  output: `${runId} | ${existing.currentPhase} | ${existing.status}`,
                  metadata: { runId, resumed: true, nextAction: "dispatch" },
                }
              }
            } catch (e: any) {
              // "not found" 是预期情况（新 run），继续创建
              // 其他错误（corrupted JSON、schema 校验失败）需报告
              if (e instanceof WorkflowEngineError && e.code === "NOT_FOUND") {
                // 预期：新 run，继续创建
              } else {
                return {
                  title: "Error",
                  output: `无法加载已有 run ${runId}: ${e.message}`,
                  metadata: { runId, error: e.message, dispatch: false },
                }
              }
            }

            // ── 前置步骤：schema 获取（有 db.properties 配置时触发，无论是否已有 SQL 文件）──
            // fetchSchemaIfNeeded 内部自行判断 db.properties 是否存在，无配置时静默返回 { fetched: false }
            let fetchStatus = "skipped"
            if (args.sourcePath) {
              const srcPath = args.sourcePath as string

              // Step 1: 动态加载模块
              let fetchSchemaIfNeeded: typeof import("../workflow/schema-fetcher").fetchSchemaIfNeeded
              let cleanupDdl: typeof import("../workflow/schema-fetcher").cleanupGeneratedDdl
              try {
                const mod = await import("../workflow/schema-fetcher")
                fetchSchemaIfNeeded = mod.fetchSchemaIfNeeded
                cleanupDdl = mod.cleanupGeneratedDdl
              } catch (e: any) {
                const isModuleNotFound = e.code === "MODULE_NOT_FOUND"
                  || /Cannot find module/.test(e.message)
                const hint = isModuleNotFound
                  ? "schema-fetcher 模块加载失败，可能缺少依赖。请执行：cd .opencode && npm install"
                  : `无法加载 schema-fetcher 模块: ${e.message}`
                return {
                  title: "Schema Error",
                  output: hint,
                  metadata: { runId, error: e.message, dispatch: false },
                }
              }

              // Step 2: 执行 schema 获取
              try {
                const fetchResult = await fetchSchemaIfNeeded(srcPath, args.dbConf as string | undefined)
                if (fetchResult.error) {
                  // schema fetch 返回错误时清理已生成的 ddl-output，避免残留
                  cleanupDdl(srcPath)
                  return {
                    title: "Schema Error",
                    output: fetchResult.error,
                    metadata: { runId, error: fetchResult.error, dispatch: false },
                  }
                }
                if (fetchResult.fetched && fetchResult.result) {
                  const r = fetchResult.result
                  fetchStatus = `tables:${r.tablesFetched} views:${r.viewsFetched} triggers:${r.triggersFetched} seqs:${r.sequencesFetched} types:${r.objectTypesFetched}`
                }
              } catch (e: any) {
                // schema fetch 抛异常时清理已生成的 ddl-output，避免残留
                cleanupDdl(srcPath)
                return {
                  title: "Schema Error",
                  output: `Schema 获取失败: ${e.message}`,
                  metadata: { runId, error: e.message, dispatch: false },
                }
              }
            }

            // 预扫描：在 engine.start 之前扫描源码生成 inventory-index.json
            let scanStatus = "skipped"
            if (args.sourcePath) {
              try {
                const index = await scanSource(args.sourcePath as string)
                const artifactsDir = join(ARTIFACT_DIR, runId)
                if (!existsSync(artifactsDir)) {
                  mkdirSync(artifactsDir, { recursive: true })
                }
                writeFileSync(
                  join(artifactsDir, "inventory-index.json"),
                  JSON.stringify(index, null, 2),
                  "utf-8",
                )

                // F4: 校验扫描结果非空
                const total = index.packages.length + index.tables.length
                  + index.triggers.length + index.standaloneProcedures.length
                  + index.views.length + index.sequences.length
                if (total === 0) {
                  if (fetchStatus !== "skipped") cleanupDdl(args.sourcePath as string)
                  return {
                    title: "Empty Source",
                    output: `源码目录 "${args.sourcePath}" 未找到任何可处理的 PL/SQL 对象（package、table、trigger、standalone procedure）。请确认目录下包含 .sql/.pks/.pkb/.pls 文件。`,
                    metadata: { runId, error: "empty_source", dispatch: false },
                  }
                }

                scanStatus = `${index.scannerUsed} | ${index.packages.length} pkgs | ${index.tables.length} tables | ${index.triggers.length} triggers`
                if (fetchStatus !== "skipped") {
                  scanStatus = `fetch: ${fetchStatus} | scan: ${scanStatus}`
                }
              } catch (e: any) {
                if (fetchStatus !== "skipped") cleanupDdl(args.sourcePath as string)
                return {
                  title: "Scan Error",
                  output: `源码扫描失败: ${e.message}`,
                  metadata: { runId, error: e.message, dispatch: false },
                }
              }
            }

            // 写入 run-context.json：输入参数 + 目录的稳固快照，resume 兜底事实源
            writeRunContext({
              runId,
              originalInput: (args.originalInput as string) ?? "",
              params: {
                path: args.sourcePath as string | undefined,
                dbConf: args.dbConf as string | undefined,
                specConf: args.specConf as string | undefined,
                mainEntry: args.mainEntry as string | undefined,
                phases: args.phases as string | undefined,
              },
              dirs: {
                artifacts: join(ARTIFACT_DIR, runId),
                logs: join(ARTIFACT_DIR, runId, "logs"),
              },
              createdAt: new Date().toISOString(),
            })

            const run = engine.start("sql2java", runId, metadata)
            getLogger().info("[workflow]", `工作流启动: runId=${runId} sourcePath=${args.sourcePath ?? "N/A"} scan=${scanStatus}`)
            setWorkflowContext(run)
            const banner = formatPhaseStartBanner(run.currentPhase)
            return {
              title: "Started",
              output: `${runId} | ${run.currentPhase} | scan: ${scanStatus}${banner}\n📌 调用 todowrite 创建主线阶段进度（${run.currentPhase}=in_progress，其余=pending，所有 priority="medium"）\n\n✔ 工作流已启动，${run.currentPhase} 阶段就绪。\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会调度执行。`,
              metadata: { runId, phase: run.currentPhase, scanStatus, nextAction: "dispatch" },
            }
          }

          // ── advance ──
          case "advance": {
            if (!args.runId) throw new Error("runId required")
            const runId = args.runId

            // D5: 从磁盘校验 artifact（在 engine.advance 之前）
            // fix-failed 时跳过校验：agent 可能无法写出有效 fix.json，advance(result="failed")
            // 应直接进入 handleFixAdvance 的 failed 分支处理，不应被 Zod 校验拦截
            let statusBefore: WorkflowRun | null = engine.status(runId)
            const isFixFailed = statusBefore?.currentPhase === "fix" && args.result === "failed"
            // statusBefore 为空时（跨 session），从磁盘加载以确保校验不跳过
            if (!statusBefore) {
              try {
                statusBefore = engine.loadFromDisk(runId)
              } catch (e: any) {
                // "not found" 交给 engine.advance 处理（会抛 not found）
                // 其他错误（corrupted JSON 等）需报告
                if (!(e instanceof WorkflowEngineError && e.code === "NOT_FOUND")) {
                  return {
                    title: "Error",
                    output: `无法加载 run ${runId}: ${e.message}`,
                    metadata: { runId, error: e.message, dispatch: false },
                  }
                }
              }
            }
            if (statusBefore && statusBefore.status === "running" && !isFixFailed) {
              const validationError = validateArtifactOnDisk(statusBefore)
              if (validationError) {
                // P2b: 尝试 auto-fix 表面结构问题（strip null 值）
                const fixResult = autoFixStructuralIssues(statusBefore)
                // 汇总最终需上报的错误（auto-fix 后仍失败 → 结构问题；无法 auto-fix → 内容问题）
                let errorToReport: string | null = null
                let isStructural = false
                if (fixResult.fixed) {
                  const recheck = validateArtifactOnDisk(statusBefore)
                  if (!recheck) {
                    getLogger().info("[advance]", `Auto-fixed structural issues: ${fixResult.summary}`)
                  } else {
                    errorToReport = recheck
                    isStructural = true
                  }
                } else {
                  errorToReport = validationError
                  isStructural = false
                }

                if (errorToReport) {
                  // fix 阶段走自有 maxRetries 机制，不参与降级
                  const phaseCfg = SQL2JAVA_WORKFLOW.phases.find(p => p.name === statusBefore.currentPhase)
                  const isFixPhase = phaseCfg?.isFixPhase === true
                  if (!isFixPhase && engine.rejectionBoundExceeded(statusBefore)) {
                    // D16：达上限，Zod 问题降级为 warning 放行，不阻断（engine.advance 内部对 blocking 同样降级）
                    engine.logEvent(runId, "ADVANCE", statusBefore.currentPhase ?? "",
                      `[rejection-bound-exceeded] 阶段 ${statusBefore.currentPhase} 已连续 ${engine.getRejectionCount(statusBefore)} 次拒绝，达到上限(${engine.REJECTION_BOUND})，Zod 问题降级为 warning 放行：\n${errorToReport}`)
                    getLogger().warn("[advance]", `rejection bound exceeded, demoting Zod error to warning for phase ${statusBefore.currentPhase}`)
                    // 不 return，继续 advance
                  } else {
                    if (!isFixPhase) engine.bumpRejectionCount(statusBefore)
                    const enhancedError = enhanceRejection(statusBefore.currentPhase, errorToReport, isStructural)
                    return {
                      title: "Validation Failed",
                      output: enhancedError,
                      metadata: {
                        rejected: true,
                        rejectionReason: enhancedError,
                        nextAction: "dispatch",
                      },
                    }
                  }
                }
              }
            }

            // ★ BUG FIX: engine.advance() 就地修改 run 对象（statusBefore 是同一引用），
            // advance 后 statusBefore.currentPhase 变成下一阶段而非完成阶段。
            // 必须在 advance 之前保存完成阶段名。
            const completedPhase = statusBefore?.currentPhase ?? ""
            getLogger().info("[advance]", `阶段 ${completedPhase} 请求 advance, result=${args.result ?? "auto"}`)

            // review 阶段：advance 前确定性重建 review-summary.json（读所有 per-package review.json 聚合）。
            // 按包分片下每个 shard 只写本包 review.json，summary 必须在 advance 前由代码聚合成完整态，
            // 供 engine.advance 内 G3/G4 门控与 D8 推导使用。agent 调的 generateReviewSummary 是会话内反馈，
            // 此处是正确性兜底（幂等，每次 review advance 都重建为当下最完整态）。重建失败不阻断——
            // 交由 D8 检测 summary 缺失/不完整后拒绝并重新 dispatch。
            if (completedPhase === "review") {
              try {
                buildReviewSummary(`${ARTIFACT_DIR}/${runId}`)
              } catch (e: any) {
                getLogger().warn("[advance]", `review-summary 重建失败（交由 D8 处理）: ${e.message}`)
              }
            }

            // verify 阶段：advance 前确定性重建 verify-summary.json（解析 mvn 日志 + 归因 + 聚合）。
            // agent 调的 generateVerifySummary 是会话内反馈，此处是正确性兜底（幂等）。失败不阻断——
            // 交由 D8 检测 summary 缺失后拒绝并重新 dispatch。
            if (completedPhase === "verify") {
              try {
                buildVerifySummary(`${ARTIFACT_DIR}/${runId}`)
              } catch (e: any) {
                getLogger().warn("[advance]", `verify-summary 重建失败（交由 D8 处理）: ${e.message}`)
              }
            }

            const adv = engine.advance(runId, { result: args.result, acceptWarnings: args.acceptWarnings })

            // ── Metrics: finalize 当前 collector（仅当阶段成功完成时） ──
            // try-catch 保护：engine.advance() 已提交状态，metrics I/O 失败不应阻断流程
            let phaseReportText: string | undefined
            let phaseMetrics: PhaseMetrics | undefined
            try {
              if (activeCollector && !adv.rejected && !adv.fixFailed && completedPhase) {
                const entries = adv.run.phaseHistory.filter(
                  (e: any) => e.phase === completedPhase && e.status === "completed" && e.completedAt
                )
                const entry = entries[entries.length - 1]
                if (entry) {
                  phaseMetrics = activeCollector.finalize(entry, join(ARTIFACT_DIR, runId))
                  activeCollector.persist()
                  getLogger().info("[metrics]", `阶段 ${completedPhase} metrics 已持久化: ${phaseMetrics.apiCallCount} API 调用, $${phaseMetrics.totalCost.toFixed(4)}, ${phaseMetrics.totalToolCallCount} 工具调用`)
                  phaseReportText = formatPhaseReport(phaseMetrics)
                  const reportsDir = join(ARTIFACT_DIR, runId, "reports")
                  const reportFile = phaseMetrics.fixIndex != null
                    ? `fix-${phaseMetrics.fixIndex}-report.txt`
                    : `${completedPhase}-report.txt`
                  mkdirSync(reportsDir, { recursive: true })
                  writeFileSync(join(reportsDir, reportFile), phaseReportText, "utf-8")
                }
              }
            } catch (e: any) {
              getLogger().warn("[metrics]", `阶段报告生成失败: ${e.message}`)
            }

            if (adv.finished) {
              // ── Metrics: 生成最终报告 ──
              let finalText: string | undefined
              try {
                const runMetrics = generateRunMetrics(runId, adv.run, join(ARTIFACT_DIR, runId))
                const metricsDir = join(ARTIFACT_DIR, runId, "metrics")
                mkdirSync(metricsDir, { recursive: true })
                writeFileSync(join(metricsDir, "run-metrics.json"), JSON.stringify(runMetrics, null, 2), "utf-8")
                finalText = formatFinalReport(runMetrics)
                const reportsDir = join(ARTIFACT_DIR, runId, "reports")
                mkdirSync(reportsDir, { recursive: true })
                writeFileSync(join(reportsDir, "final-report.txt"), finalText, "utf-8")
                getLogger().info("[metrics]", `最终报告已生成: ${runMetrics.totalApiCallCount} API 调用, $${runMetrics.totalCost.toFixed(4)}, ${runMetrics.phases.length} 阶段`)
              } catch (e: any) {
                getLogger().warn("[metrics]", `最终报告生成失败: ${e.message}`)
              }
              clearWorkflowContext()
              const isWithIssues = adv.run.status === "completed_with_issues"
              const duration = phaseMetrics?.wallDurationMs != null ? formatDuration(phaseMetrics.wallDurationMs) : undefined
              const endBanner = formatPhaseEndBanner(completedPhase, duration)

              if (isWithIssues) {
                // Fix 耗尽：询问用户选择继续还是接受
                const reportPath = join(ARTIFACT_DIR, runId, "reports", "final-report.txt")
                return {
                  title: "Fix Exhausted — User Decision Required",
                  output: `${endBanner}⚠️ Fix 循环已达上限，工作流暂停。请选择：\n\n1. 继续修复（重置计数器）：workflow({ action: "fixContinue", runId: "${runId}" })\n2. 接受当前结果：保持 completed_with_issues 状态\n\n详细报告: ${reportPath}`,
                  metadata: {
                    status: adv.run.status,
                    fixExhausted: true,
                    reportPath,
                    nextAction: "user_decision",
                  },
                }
              }

              const finalMsg = "🎉 工作流全部完成！"
              return {
                title: "Completed",
                output: `${endBanner}${finalMsg}\nrunId: ${runId} | status: ${adv.run.status}`,
                metadata: { status: adv.run.status, reportPath: join(ARTIFACT_DIR, runId, "reports", "final-report.txt"), nextAction: "finished" },
              }
            }

            if (adv.waitingForConfirmation) {
              const duration = phaseMetrics?.wallDurationMs != null ? formatDuration(phaseMetrics.wallDurationMs) : undefined
              const endBanner = formatPhaseEndBanner(completedPhase, duration)
              const pausedPhase = adv.run.currentPhase ?? ""
              const pausedDesc = adv.nextPhase?.description ?? pausedPhase
              return {
                title: "Paused",
                output: `${endBanner}⏸ ${pausedPhase}（${pausedDesc}）等待确认。请审阅后调用：\nworkflow({action:"confirm",runId:"${runId}"})`,
                metadata: { waitingForConfirmation: true, reportPath: phaseReportText ? join(ARTIFACT_DIR, runId, "reports", `${completedPhase || "unknown"}-report.txt`) : undefined, nextAction: "confirm" },
              }
            }

            if (adv.rejected) {
              // 路径 A：blocking 拒绝 → 需要重新 dispatch Worker 让其修正
              // 不清理 workflowContext：LLM 应修正 artifact 后重新 advance，当前 phase context 仍有效
              // activeCollector 保持活跃，继续累计
              getLogger().warn("[advance]", `阶段 ${completedPhase} advance 被拒绝: ${adv.rejectionReason}`)
              const enhancedError = enhanceRejection(completedPhase, adv.rejectionReason!)
              return {
                title: "Rejected",
                output: `${enhancedError}\n\n⛔ 不要更新 todowrite（阶段尚未通过，保持 ${completedPhase}=in_progress）。\n⏹ 请根据以上错误修正 artifact，然后输出 WORKER_SUMMARY。编排者会重新调度。`,
                metadata: { rejected: true, nextAction: "dispatch" },
              }
            }

            if (adv.fixFailed) {
              // 不清理 workflowContext：LLM 应调用 retry()，retry 仍处于 fix phase，fix-phase context 仍有效
              // activeCollector 保持活跃，继续累计
              return {
                title: "Fix Failed",
                output: adv.rejectionReason!,
                metadata: { fixFailed: true, nextAction: "retry" },
              }
            }

            // try-catch 保护：metrics collector 构造失败不应阻断流程
            try {
              setWorkflowContext(adv.run)
              getLogger().info("[advance]", `阶段转换: ${completedPhase} → ${adv.run.currentPhase}`)
            } catch (e: any) {
              getLogger().warn("[metrics]", `collector 创建失败: ${e.message}`)
            }

            // 分片切换：同阶段内分片推进
            if (adv.run.currentPhase === completedPhase) {
              const currentEntry = engine.findCurrentEntry(adv.run)
              const si = currentEntry?.incrementalContext?.shardIndex
              const ts = currentEntry?.incrementalContext?.totalShards
              if (si !== undefined && ts !== undefined) {
                const nextPkgs = currentEntry!.incrementalContext!.targetPackages
                const shardInfo = `📦 分片 ${si + 1}/${ts}（包: ${nextPkgs.join(", ")}）`
                getLogger().info("[advance]", `分片切换: ${completedPhase} 分片 ${si + 1}/${ts}`)
                return {
                  title: `分片 ${si + 1}/${ts}: ${completedPhase}`,
                  output: `✔ ${completedPhase} 分片 ${si}/${ts} 完成，进入分片 ${si + 1}/${ts}。\n${shardInfo}\n\n📌 调用 todowrite 更新进度（${completedPhase} 保持 in_progress，备注分片 ${si + 1}/${ts}）\n\n⏹ 请输出 WORKER_SUMMARY 并结束当前工作——编排者会调度下一分片。`,
                  metadata: { runId, phase: completedPhase, shardIndex: si, totalShards: ts, nextAction: "dispatch" },
                }
              }
            }

            getLogger().info("[advance]", `阶段 ${completedPhase} 完成${phaseMetrics?.wallDurationMs != null ? ` (${formatDuration(phaseMetrics.wallDurationMs)})` : ""}, 进入 ${adv.run.currentPhase}`)
            const duration = phaseMetrics?.wallDurationMs != null ? formatDuration(phaseMetrics.wallDurationMs) : undefined
            const endBanner = formatPhaseEndBanner(completedPhase, duration)
            const startBanner = formatPhaseStartBanner(adv.run.currentPhase)
            const nextAgentName = adv.nextPhase?.agentFile ? agentFileToName(adv.nextPhase.agentFile) : ""
            let advanceOutput = `${endBanner}${startBanner}Agent: ${adv.nextPhase?.agentFile}\n\n📌 调用 todowrite 更新进度：${completedPhase}→completed，${adv.run.currentPhase}→in_progress（priority 保持原值）\n\n✔ 阶段 ${completedPhase} 已完成，${adv.run.currentPhase} 阶段就绪。\n⏹ 请输出 WORKER_SUMMARY 并结束当前工作——编排者会调度下一阶段。`
            // warning 提醒（醒目但不阻断）
            if (adv.crossSchemaWarnings && adv.crossSchemaWarnings.length > 0) {
              advanceOutput += `\n\n⚠️⚠️⚠️ 校验警告（已自动放行，但建议关注）：\n${adv.crossSchemaWarnings.map(w => `  - ⚠️ ${w}`).join("\n")}`
            }
            return {
              title: `→ ${adv.run.currentPhase}`,
              output: advanceOutput,
              metadata: { runId, phase: adv.run.currentPhase, agent: nextAgentName, crossSchemaWarnings: adv.crossSchemaWarnings, reportPath: phaseReportText ? join(ARTIFACT_DIR, runId, "reports", `${completedPhase || "unknown"}-report.txt`) : undefined, nextAction: "dispatch" },
            }
          }

          // ── generateInventory — inventory 阶段代码生成（由 sql-analyst agent 调用）──
          // inventory 的结构抽取已下沉到 prescan（AST/regex 全字段），此处纯代码把
          // inventory-index.json 转成下游 inventory-packages/*.json + inventory.json。
          // agent 调本 action 生成产物 → 输出 WORKER_SUMMARY；编排者调 advance 推进。
          // advance 若被拒（校验失败），编排者重新 dispatch，workOrder 带校验错误，
          // agent 据此最小修复 json（优先）或重跑 generateInventory。
          case "generateInventory": {
            if (!args.runId) throw new Error("runId required")
            const runId = args.runId
            const artifactsDir = join(ARTIFACT_DIR, runId)
            try {
              const r = buildInventoryFromIndex(artifactsDir)
              const warn = r.warnings.length > 0
                ? `\n\n⚠️ prescan 降级导致部分元数据用默认值填充（${r.warnings.length} 条）：\n${r.warnings.map(w => `  - ${w}`).join("\n")}`
                : ""
              return {
                title: "Inventory Generated",
                output: `✔ inventory 代码生成完成：${r.packageCount} 包 / ${r.tableCount} 表（已过 Zod 校验）。${warn}\n\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会调用 advance 推进到 analyze。`,
                metadata: { runId, packageCount: r.packageCount, tableCount: r.tableCount, warnings: r.warnings },
              }
            } catch (e: any) {
              return {
                title: "Inventory Generation Failed",
                output: `✖ inventory 代码生成失败：${e.message}\n\n可重试 workflow({action:"generateInventory", runId:"${runId}"})；若反复失败，回退到读源码手工生成 inventory-packages + inventory.json。`,
                metadata: { runId, error: e.message },
              }
            }
          }

          // ── generateAnalysis — inventory 阶段代码生成 analysis.json（reduce，零 LLM）──
          // analyze 的全局依赖图 meta（callGraph/packageDependency/translationOrder/sccGroups/
          // complexity）已可从 inventory-index 纯代码计算，归入 inventory 阶段。agent 在调完
          // generateInventory 后调本 action 生成 analysis.json + 无子程序包空 analysis-packages。
          // advance 失败时编排者重新 dispatch，workOrder 带校验错误，agent 最小修复 json。
          case "generateAnalysis": {
            if (!args.runId) throw new Error("runId required")
            const runId = args.runId
            const artifactsDir = join(ARTIFACT_DIR, runId)
            try {
              const r = buildAnalysisFromIndex(artifactsDir)
              return {
                title: "Analysis Meta Generated",
                output: `✔ analysis.json 代码生成完成：${r.packageCount} 包 / ${r.sccGroupCount} SCC 组（已过 Zod 校验）。${r.warnings.length ? `\n⚠️ ${r.warnings.join("; ")}` : ""}\n\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会调用 advance 推进。`,
                metadata: { runId, packageCount: r.packageCount, sccGroupCount: r.sccGroupCount, warnings: r.warnings },
              }
            } catch (e: any) {
              return {
                title: "Analysis Meta Generation Failed",
                output: `✖ analysis.json 代码生成失败：${e.message}\n\n可重试 workflow({action:"generateAnalysis", runId:"${runId}"})；若反复失败，检查 inventory-index.json 是否完整。`,
                metadata: { runId, error: e.message },
              }
            }
          }

          // ── generateReviewSummary — review 阶段代码聚合 review-summary.json（reduce，零 LLM）──
          // review 按包分片后，每个分片只写本分片包的 translations/{pkg}/review.json，
          // 没有任何单个 agent 看得到全部包。agent 写完本分片 review.json 后调本 action，
          // 由代码读取所有 per-package review.json 聚合成顶层 review-summary.json（advance 据其推导 D8）。
          // 幂等：每个分片都可调用，最终分片产出的 summary 覆盖全部包。
          case "generateReviewSummary": {
            if (!args.runId) throw new Error("runId required")
            const runId = args.runId
            const artifactsDir = join(ARTIFACT_DIR, runId)
            try {
              const r = buildReviewSummary(artifactsDir)
              const warn = r.warnings.length > 0
                ? `\n\n⚠️ ${r.warnings.length} 个 per-package review.json 跳过（解析/校验失败）：\n${r.warnings.map(w => `  - ${w}`).join("\n")}`
                : ""
              return {
                title: "Review Summary Generated",
                output: `✔ review-summary.json 聚合完成：${r.packageCount} 包 / allPassed=${r.allPassed} / totalMustFix=${r.totalMustFix}（已过 Zod 校验）。${warn}\n\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会调用 advance 推进。`,
                metadata: { runId, packageCount: r.packageCount, allPassed: r.allPassed, totalMustFix: r.totalMustFix, warnings: r.warnings },
              }
            } catch (e: any) {
              return {
                title: "Review Summary Generation Failed",
                output: `✖ review-summary 聚合失败：${e.message}\n\n可重试 workflow({action:"generateReviewSummary", runId:"${runId}"})；若反复失败，检查 translations/*/review.json 是否完整。`,
                metadata: { runId, error: e.message },
              }
            }
          }

          // ── generateVerifySummary — verify 阶段代码聚合 verify-summary.json（reduce，零 LLM）──
          // verify 只做动态检查：agent 跑 `mvn compile`/`mvn test`（输出 tee 到 verify-compile.log /
          // verify-test.log），调本 action 由代码解析日志 + 编译/测试失败归因到包 + 聚合 summary。
          // 静态检查（MyBatis 结构、`// TODO: [translate]` 等）归 review，不在 verify。
          case "generateVerifySummary": {
            if (!args.runId) throw new Error("runId required")
            const runId = args.runId
            const artifactsDir = join(ARTIFACT_DIR, runId)
            try {
              const r = buildVerifySummary(artifactsDir)
              const warn = r.warnings.length > 0
                ? `\n\n⚠️ ${r.warnings.length} 条提示：\n${r.warnings.map(w => `  - ${w}`).join("\n")}`
                : ""
              return {
                title: "Verify Summary Generated",
                output: `✔ verify-summary.json 聚合完成：${r.packageCount} 包 / allPassed=${r.allPassed} / compile=${r.compilationSuccess} / tests=${r.testsPassed ?? "?"}/${r.totalTests ?? "?"}（已过 Zod 校验）。${warn}\n\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会调用 advance 推进。`,
                metadata: { runId, packageCount: r.packageCount, allPassed: r.allPassed, compilationSuccess: r.compilationSuccess, testsPassed: r.testsPassed, totalTests: r.totalTests, warnings: r.warnings },
              }
            } catch (e: any) {
              return {
                title: "Verify Summary Generation Failed",
                output: `✖ verify-summary 聚合失败：${e.message}\n\n可重试 workflow({action:"generateVerifySummary", runId:"${runId}"})；若反复失败，检查 verify-compile.log / verify-test.log 是否已生成、scaffold.json 的 projectRoot 是否正确。`,
                metadata: { runId, error: e.message },
              }
            }
          }

          // ── confirm ──
          case "confirm": {
            if (!args.runId) throw new Error("runId required")
            const r = engine.confirm(args.runId)
            setWorkflowContext(r)
            const startBanner = formatPhaseStartBanner(r.currentPhase)
            const confirmedPhase = r.currentPhase ?? ""
            const confirmedDesc = SQL2JAVA_WORKFLOW.phases.find(p => p.name === confirmedPhase)?.description ?? confirmedPhase
            return {
              title: "Confirmed",
              output: `${startBanner}✔ ${confirmedPhase}（${confirmedDesc}）已确认，继续执行: ${r.status}\n\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会调度执行。`,
              metadata: { runId: args.runId, phase: confirmedPhase, nextAction: "dispatch" },
            }
          }

          // ── fixContinue — fix 耗尽后用户选择继续修复 ──
          case "fixContinue": {
            if (!args.runId) throw new Error("runId required")
            // 前置状态校验：fixContinue 仅在 completed_with_issues 时可用，
            // 避免 LLM 在 run 仍为 running 时误调用导致异常
            const currentRun = engine.status(args.runId)
            if (!currentRun || currentRun.status !== "completed_with_issues") {
              const actualStatus = currentRun?.status ?? "unknown"
              const currentPhase = currentRun?.currentPhase ?? "unknown"
              return {
                title: "Invalid Action",
                output: `⚠️ fixContinue 仅在 fix 循环耗尽（status=completed_with_issues）时可用。当前状态：status=${actualStatus}, phase=${currentPhase}。\n\n请根据当前状态选择正确的操作：\n- 当前阶段已完成 → workflow({ action: "advance", runId: "${args.runId}", result: "passed" 或 "failed" })\n- fix 失败但未耗尽 → workflow({ action: "retry", runId: "${args.runId}" })\n- fix 循环耗尽后才可 → workflow({ action: "fixContinue", runId: "${args.runId}" })`,
                metadata: { runId: args.runId, error: "invalid_state", actualStatus, dispatch: false },
              }
            }
            const r = engine.fixContinue(args.runId)
            setWorkflowContext(r) // 已内部创建正确的 PhaseMetricsCollector
            const startBanner = formatPhaseStartBanner("fix")

            return {
              title: "Fix Continued",
              output: `${startBanner}🔄 Fix 计数器已重置，继续修复。runId: ${args.runId} | status: ${r.status}\n\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会调度 fix 阶段。`,
              metadata: { runId: args.runId, phase: "fix", fixReset: true, nextAction: "dispatch" },
            }
          }

          // ── retry ──
          case "retry": {
            if (!args.runId) throw new Error("runId required")
            const ret = engine.retry(args.runId)
            if (ret.exhausted) {
              persistCollectorIfActive(args.runId)
              clearWorkflowContext()

              // fix 阶段 retry 耗尽 → 询问用户
              if (ret.terminalState === "completed_with_issues") {
                const reportPath = join(ARTIFACT_DIR, args.runId, "reports", "final-report.txt")
                return {
                  title: "Fix Exhausted — User Decision Required",
                  output: `⚠️ Fix 循环已达上限（retry exhausted: ${ret.retryCount}）。请选择：\n\n1. 继续修复（重置计数器）：workflow({ action: "fixContinue", runId: "${args.runId}" })\n2. 接受当前结果：保持 completed_with_issues 状态\n\n详细报告: ${reportPath}`,
                  metadata: {
                    status: ret.run.status,
                    fixExhausted: true,
                    terminalState: ret.terminalState,
                    reportPath,
                    nextAction: "user_decision",
                  },
                }
              }

              return {
                title: "Exhausted",
                output: `Retries exhausted: ${ret.retryCount}. Status: ${ret.run.status}`,
                metadata: {
                  status: ret.run.status,
                  terminalState: ret.terminalState,
                  nextAction: "finished",
                },
              }
            }
            // ── Metrics: 重置 collector（retry 创建新 PhaseHistoryEntry，从零开始累计） ──
            if (currentWorkflowContext) {
              if (activeCollector) {
                const snap = activeCollector.getSnapshot()
                if (snap.apiCallCount > 0) {
                  getLogger().warn("[metrics]", `retry 丢弃了 ${snap.apiCallCount} 次 API 调用 / $${snap.totalCost.toFixed(4)} 数据`)
                }
              }
              const artifactsDir = join(ARTIFACT_DIR, currentWorkflowContext.runId)
              const fixIndex = currentWorkflowContext.phase === "fix"
                ? nextFixIndex(currentWorkflowContext.runId)
                : undefined
              activeCollector = new PhaseMetricsCollector(
                currentWorkflowContext.phase, currentWorkflowContext.runId, artifactsDir, fixIndex,
              )
            }
            return {
              title: `Retry ${ret.retryCount}`,
              output: `🔄 重试已激活（第 ${ret.retryCount} 次），阶段：${ret.run.currentPhase}。\n\n⏹ 请输出 WORKER_SUMMARY 并结束——编排者会重新调度。`,
              metadata: { runId: args.runId, nextAction: "dispatch" },
            }
          }

          // ── abort ──
          case "abort": {
            if (!args.runId) throw new Error("runId required")
            const r = engine.abort(args.runId)
            persistCollectorIfActive(args.runId)
            clearWorkflowContext()
            return {
              title: "Aborted",
              output: r.status,
              metadata: { status: r.status, dispatch: false },
            }
          }

          // ── status ──
          case "status": {
            if (!args.runId) {
              const runs = engine.listRuns()
              return {
                title: `${runs.length} runs`,
                output:
                  runs
                    .map((r: any) => `${r.runId}|${r.status}|${r.currentPhase}`)
                    .join("\n") || "No runs",
                metadata: { count: runs.length, dispatch: false },
              }
            }
            const r = engine.status(args.runId)
            if (!r)
              return { title: "Not found", output: "No such run", metadata: { dispatch: false } }
            // ── Metrics: 附加实时 metrics 快照（仅当 runId 匹配时） ──
            const liveMetrics = activeCollector && activeCollector.runId === args.runId
              ? activeCollector.getSnapshot()
              : undefined
            return {
              title: r.status,
              output: JSON.stringify(
                {
                  runId: r.runId,
                  status: r.status,
                  currentPhase: r.currentPhase,
                  phases: r.phaseHistory.map((h: any) => ({
                    phase: h.phase,
                    status: h.status,
                    retry: h.retryCount,
                  })),
                  ...(liveMetrics ? { liveMetrics } : {}),
                },
                null,
                2
              ),
              metadata: { runId: r.runId, ...(liveMetrics ? { liveMetrics } : {}), dispatch: false },
            }
          }

          // ── list ──
          case "list": {
            const runs = engine.listRuns()
            return {
              title: `${runs.length} runs`,
              output:
                runs
                  .map((r: any) => `${r.runId}|${r.status}|${r.currentPhase}`)
                  .join("\n") || "No runs",
              metadata: { count: runs.length, dispatch: false },
            }
          }

          // ── prerequisites ──
          case "prerequisites": {
            // 校验指定阶段的前置 artifact 是否满足（支持 OR-group）
            if (!args.phases) {
              return { title: "Error", output: "phases parameter required", metadata: { dispatch: false } }
            }
            // 找到最近的 run 对应的 artifacts 目录
            const runs = engine.listRuns()
            // 按 updatedAt 降序排序，确保取到最新的 run（readdirSync 不保证顺序）
            const latestRun = [...runs].sort((a: any, b: any) =>
              b.updatedAt.localeCompare(a.updatedAt)
            )[0]
            if (!latestRun) {
              return { title: "Error", output: "No workflow runs found", metadata: { dispatch: false } }
            }
            const artifactsDir = join(ARTIFACT_DIR, latestRun.runId)
            const targetPhases = args.phases.split(",").map((p: string) => p.trim())
            const missing = checkPrerequisites(targetPhases, artifactsDir)
            if (missing.length > 0) {
              return {
                title: "Prerequisites Missing",
                output: `Missing prerequisites for phases [${targetPhases.join(", ")}]:\n${missing.map(m => `  - ${m}`).join("\n")}`,
                metadata: { missing, phases: targetPhases, dispatch: false },
              }
            }
            return {
              title: "Prerequisites OK",
              output: `All prerequisites satisfied for phases: ${targetPhases.join(", ")}`,
              metadata: { phases: targetPhases, dispatch: false },
            }
          }

          // ── resume（确定性断点续传）──
          case "resume": {
            // 1. 找到 runs（使用修复后的 listRuns，含磁盘扫描）
            const allRuns = engine.listRuns()
            if (allRuns.length === 0) {
              return {
                title: "No Runs",
                output: "No workflow runs found. Start with /sql2java <path>",
                metadata: { resumeStrategy: "no_runs", dispatch: false },
              }
            }

            // 2. 取最新的 run（按 updatedAt 降序）
            const latestRun = [...allRuns].sort((a: any, b: any) =>
              b.updatedAt.localeCompare(a.updatedAt)
            )[0]

            // 3. 从磁盘加载（含 Zod 校验）
            let run: WorkflowRun
            try {
              run = engine.loadFromDisk(latestRun.runId)
            } catch (e: any) {
              return {
                title: "Corrupted Run",
                output: `Latest run ${latestRun.runId} is corrupted: ${e.message}\nConsider starting a new run with /sql2java <path>`,
                metadata: { resumeStrategy: "corrupted", runId: latestRun.runId, dispatch: false },
              }
            }

            const runId = run.runId

            // 4. 已完成
            if (run.status === "completed") {
              return {
                title: "Already Completed",
                output: `Workflow ${runId} is already completed. No action needed.`,
                metadata: {
                  action: "resume",
                  runId,
                  status: run.status,
                  resumeStrategy: "already_completed",
                  message: "Workflow already completed",
                  dispatch: false,
                },
              }
            }

            // 5. 完成但有未解决问题
            if (run.status === "completed_with_issues") {
              const artifactsDir = join(ARTIFACT_DIR, runId)
              const verifySummary = engine.loadArtifactJson(artifactsDir, "verify-summary")
              const unresolvedText = verifySummary?.unresolvedIssues
                ? JSON.stringify(verifySummary.unresolvedIssues, null, 2)
                : `See ${ARTIFACT_DIR}/${runId}/verify-summary.json`
              return {
                title: "Completed with Issues",
                output: `Workflow ${runId} completed with unresolved issues:\n${unresolvedText}`,
                metadata: {
                  action: "resume",
                  runId,
                  status: run.status,
                  resumeStrategy: "already_completed",
                  message: "Workflow completed with issues",
                  dispatch: false,
                },
              }
            }

            // 6. 暂停等待确认 — 仅当阶段不需要确认时自动跳过
            if (run.status === "paused") {
              const pausedPhaseConfig = SQL2JAVA_WORKFLOW.phases.find(p => p.name === run.currentPhase)
              const needsConfirmation = pausedPhaseConfig?.requiresConfirmation === true

              if (needsConfirmation) {
                return {
                  title: "Paused — Confirmation Needed",
                  output: `Workflow ${runId} is paused at phase "${run.currentPhase}"（需人工确认）. Call:\nworkflow({ action: "confirm", runId: "${runId}" })`,
                  metadata: {
                    action: "resume",
                    runId,
                    status: run.status,
                    currentPhase: run.currentPhase,
                    resumeStrategy: "confirm_needed",
                    message: `Paused at ${run.currentPhase}. Awaiting confirmation.`,
                    dispatch: false,
                  },
                }
              }

              // 阶段不再要求确认 → 自动跳过（兼容旧版本 paused 状态的 run）
              try {
                const confirmed = engine.confirm(runId)
                setWorkflowContext(confirmed)
                const confirmedPhase = confirmed.currentPhase ?? ""
                const confirmedDesc = SQL2JAVA_WORKFLOW.phases.find(p => p.name === confirmedPhase)?.description ?? confirmedPhase
                return {
                  title: "Resumed — Auto Confirmed",
                  output: `Workflow ${runId} was paused at "${run.currentPhase}". Auto-confirmed (phase no longer requires confirmation), now executing: ${confirmedPhase}（${confirmedDesc}）`,
                  metadata: {
                    action: "resume",
                    runId,
                    status: confirmed.status,
                    currentPhase: confirmed.currentPhase,
                    resumeStrategy: "continue_phase",
                    message: `Auto-confirmed ${run.currentPhase}, continuing at ${confirmedPhase}`,
                    nextAction: "dispatch",
                  },
                }
              } catch (e: any) {
                return {
                  title: "Resume Failed",
                  output: `Failed to auto-confirm paused run ${runId}: ${e.message}`,
                  metadata: { resumeStrategy: "corrupted", runId, dispatch: false },
                }
              }
            }

            // 7. 已中止
            if (run.status === "aborted") {
              return {
                title: "Aborted Run",
                output: `Workflow ${runId} was aborted at phase "${run.currentPhase}". To restart, start a new run with /sql2java <path>`,
                metadata: {
                  action: "resume",
                  runId,
                  status: run.status,
                  currentPhase: run.currentPhase,
                  resumeStrategy: "restart_phase",
                  message: `Run was aborted at ${run.currentPhase}. Manual decision required.`,
                  dispatch: false,
                },
              }
            }

            // 8. 运行中 — 计算跳过的包，确定恢复策略
            if (run.status === "running" && run.currentPhase) {
              const artifactsDir = join(ARTIFACT_DIR, runId)
              let skippedPackages: string[] | undefined

              // 分片模式恢复：检查 shardPlan，恢复到下一个未完成的分片
              const shardPlan = engine.getShardPlan(run)
              if (shardPlan) {
                const currentEntry = engine.findCurrentEntry(run)
                // 找到下一个未完成的分片（completedShards 紧凑 [0..k]，即当前分片之后）
                const nextShardIndex = shardPlan.shards.findIndex(
                  (_, i) => !shardPlan.completedShards.includes(i),
                )
                if (nextShardIndex >= 0 && currentEntry) {
                  // 更新 currentEntry 的 incrementalContext 指向未完成的分片
                  const nextShard = shardPlan.shards[nextShardIndex]
                  currentEntry.incrementalContext = shardPlan.unitMode
                    ? { targetUnits: nextShard, shardIndex: nextShardIndex, totalShards: shardPlan.shards.length }
                    : { targetPackages: nextShard, shardIndex: nextShardIndex, totalShards: shardPlan.shards.length }
                  engine.persist(run)
                  skippedPackages = shardPlan.completedShards.flatMap(i => shardPlan.shards[i] ?? [])
                }
              }

              // translate/review/verify 阶段：检查哪些包已有 artifact
              if (["translate", "review", "verify"].includes(run.currentPhase)) {
                const translationsDir = join(artifactsDir, "translations")
                if (existsSync(translationsDir)) {
                  const currentEntry = engine.findCurrentEntry(run)
                  const isIncremental = !!currentEntry?.incrementalContext?.targetPackages?.length
                    || !!currentEntry?.incrementalContext?.targetUnits?.length

                  if (!isIncremental) {
                    const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
                    if (inventory) {
                      const allPackages = Array.from(engine.extractPackageNames(inventory))
                      const pkgDirEntries = readdirSync(translationsDir, { withFileTypes: true })
                        .filter((d: import("node:fs").Dirent) => d.isDirectory())
                      const pkgFileName = getArtifactFilename(run.currentPhase!)
                      skippedPackages = allPackages.filter(pkgName => {
                        // 大小写不敏感匹配磁盘目录名
                        const actualDirName = findDirCaseInsensitive(translationsDir, pkgName, pkgDirEntries)
                        if (!actualDirName) return false
                        const artifactFile = join(translationsDir, actualDirName, `${pkgFileName}.json`)
                        return existsSync(artifactFile)
                      })
                    }
                  }
                }
              }

              // 校验 artifact 完整性决定策略
              const validationError = validateArtifactOnDisk(run)
              const strategy = validationError ? "restart_phase" : "continue_phase"

              return {
                title: `Resumed — ${run.currentPhase}`,
                output: [
                  `Resuming run ${runId} at phase "${run.currentPhase}" (status: running).`,
                  strategy === "continue_phase"
                    ? `Phase has valid partial artifacts. Continue from where it left off.`
                    : `Phase artifacts incomplete or invalid. Restart the phase from the beginning.`,
                  skippedPackages?.length
                    ? `Skippable packages (already completed): ${skippedPackages.join(", ")}`
                    : null,
                  `Call: workflow({ action: "start", runId: "${runId}" }) to activate.`,
                ].filter(Boolean).join("\n"),
                metadata: {
                  action: "resume",
                  runId,
                  status: run.status,
                  currentPhase: run.currentPhase,
                  resumeStrategy: strategy,
                  skippedPackages,
                  message: `Running at ${run.currentPhase}. ${strategy === "continue_phase" ? "Continue from checkpoint." : "Restart phase."}`,
                  nextAction: "dispatch",
                },
              }
            }

            // 9. 未知状态兜底
            return {
              title: "Unknown State",
              output: `Run ${runId} is in unexpected state. Status: ${run.status}, Phase: ${run.currentPhase}`,
              metadata: { runId, status: run.status, resumeStrategy: "corrupted", dispatch: false },
            }
          }

          // ── dispatch — 编排指令：返回 Worker 调度信息 ──
          case "dispatch": {
            if (!args.runId) throw new Error("runId required")
            const runId = args.runId
            let run = engine.status(runId)
            if (!run) {
              try {
                run = engine.loadFromDisk(runId)
              } catch (e: any) {
                if (e instanceof WorkflowEngineError && e.code === "NOT_FOUND") {
                  return { title: "Error", output: `Run ${runId} not found`, metadata: { runId, dispatch: false } }
                }
                return { title: "Error", output: `无法加载 run ${runId}: ${e.message}`, metadata: { runId, error: e.message, dispatch: false } }
              }
            }
            if (!run) {
              return { title: "Error", output: `Run ${runId} not found`, metadata: { runId, dispatch: false } }
            }
            if (run.status !== "running") {
              // 已完成/暂停/中止 — 不 dispatch，返回状态
              const isFixExhausted = run.status === "completed_with_issues"
              let statusMsg = `Run ${runId} status: ${run.status}, phase: ${run.currentPhase ?? "none"}`
              if (isFixExhausted) {
                statusMsg += `\n\n⚠️ Fix 循环已达上限。请选择：\n1. 继续修复（重置计数器）：workflow({ action: "fixContinue", runId: "${runId}" })\n2. 接受当前结果`
              }
              return {
                title: `Workflow ${run.status}`,
                output: statusMsg,
                metadata: { runId, status: run.status, phase: run.currentPhase, dispatch: false, nextAction: run.status === "completed" ? "finished" : undefined },
              }
            }

            const phaseConfig = SQL2JAVA_WORKFLOW.phases.find(p => p.name === run.currentPhase)
            if (!phaseConfig) {
              return { title: "Error", output: `Unknown phase: ${run.currentPhase}`, metadata: { runId, dispatch: false } }
            }

            // 确保 WorkflowContext 正确
            // 先持久化已有 collector（rejected Worker 的指标可能未保存），再重建
            if (currentWorkflowContext && activeCollector) {
              persistCollectorIfActive(currentWorkflowContext.runId)
            }
            // 兜底：若 run.json 的 metadata 缺失输入参数（旧 run 或损坏），从 run-context.json 恢复
            const restoredCtx = loadRunContext(runId)
            if (restoredCtx) {
              const md = run.metadata as Record<string, unknown>
              // 历史回填：旧 run 的 run-context.json 可能存相对路径，统一 resolve 成绝对路径
              if (restoredCtx.params.path && !md.sourcePath) md.sourcePath = resolve(restoredCtx.params.path)
              if (restoredCtx.params.dbConf && !md.dbConf) md.dbConf = resolve(restoredCtx.params.dbConf)
              if (restoredCtx.params.specConf && !md.specConf) md.specConf = resolve(restoredCtx.params.specConf)
              if (restoredCtx.params.mainEntry && !md.mainEntry) md.mainEntry = restoredCtx.params.mainEntry
            }
            setWorkflowContext(run)

            // ── 分片 dispatch：计算或恢复分片计划 ──
            const currentEntry = engine.findCurrentEntry(run)
            const shardPlan = engine.getShardPlan(run)
            if (shardPlan) {
              // 已有 shardPlan：当前 entry 的 incrementalContext 已由 advance 设置
              // 无需额外处理
            } else if (phaseConfig.maxPackagesPerShard && phaseConfig.maxPackagesPerShard > 0 && currentEntry) {
              // 首次 dispatch 可分片阶段：检查是否有增量上下文（fix 回来时不分片）
              const isIncremental = !!(currentEntry.incrementalContext?.targetPackages?.length)
                || !!(currentEntry.incrementalContext?.targetUnits?.length)
              if (!isIncremental) {
                // 从 analysis.json 读取拓扑序
                const analysis = engine.loadArtifactJson(`${ARTIFACT_DIR}/${run.runId}`, "analysis")
                // translate/analyze 优先用单元级 procedureOrder（PROCEDURE 级下沉）；缺失时回退包级 translationOrder
                const isUnitPhase = run.currentPhase === "translate" || run.currentPhase === "analyze"
                const procedureOrder = (analysis?.procedureOrder as string[][] | undefined) ?? undefined
                const useUnits = isUnitPhase && procedureOrder && procedureOrder.length > 0
                const translationOrder = useUnits
                  ? procedureOrder!
                  : (analysis?.translationOrder as string[][]) ?? []
                // 分片依赖 analysis.json 的拓扑序；缺失或为空时静默退化为不分片
                // （单 session 处理全部——正是分片要避免的上下文爆炸），此处显式 warn 让退化可见。
                const orderField = useUnits ? "procedureOrder" : "translationOrder"
                if (!analysis) {
                  getLogger().warn(
                    "[dispatch]",
                    `阶段 ${run.currentPhase} 配置了分片(maxPackagesPerShard=${phaseConfig.maxPackagesPerShard})但 analysis.json 缺失或不可解析，无法计算拓扑序——回退为不分片(单 session 处理全部)。请确认 inventory 阶段已产出 analysis.json。`,
                  )
                } else if (translationOrder.length === 0) {
                  getLogger().warn(
                    "[dispatch]",
                    `阶段 ${run.currentPhase} 配置了分片但 analysis.json.${orderField} 为空——回退为不分片。请确认 inventory 阶段产出了非空 ${orderField}。`,
                  )
                }
                if (translationOrder.length > 0) {
                  // analyze（PROCEDURE 级，每 unit 一分片）/review（包级，每包一分片）拍平 SCC；
                  // translate 保留 SCC 共处。详见 engine.shardOrderForPhase 的阶段语义说明。
                  const effectiveOrder = engine.shardOrderForPhase(translationOrder, run.currentPhase!)
                  const plan = engine.computeShardPlan(effectiveOrder, phaseConfig.maxPackagesPerShard, run.currentPhase!)
                  if (plan.shards.length > 1) {
                    // 多分片：设置 shardPlan 到 run.metadata，更新 currentEntry 的 incrementalContext
                    plan.unitMode = useUnits
                    run.metadata.shardPlan = plan
                    currentEntry.incrementalContext = useUnits
                      ? { targetUnits: plan.shards[0], shardIndex: 0, totalShards: plan.shards.length }
                      : { targetPackages: plan.shards[0], shardIndex: 0, totalShards: plan.shards.length }
                    engine.persist(run)
                  }
                  // 只有 1 个分片时不需要分片机制（单包项目或单元很少）
                }
              }
            }

            // 从 agentFile 提取 agent 名
            const agentName = agentFileToName(phaseConfig.agentFile)
            const artifactsDir = `${ARTIFACT_DIR}/${run.runId}`

            // 检测当前阶段是否有 artifact 校验错误（advance rejected 后重新 dispatch 的场景）
            // 重新执行 Zod 校验，如果有错误则注入到 workOrder 让 Worker 修正
            const artifactValidationError = validateArtifactOnDisk(run)

            // 构建 Work Order prompt
            const workOrderParts = [
              `执行工作流 ${run.runId} 的 ${run.currentPhase} 阶段（${phaseConfig.description ?? run.currentPhase}）。`,
              ``,
              `## 关键参数`,
              `- runId: ${run.runId}`,
              `- phase: ${run.currentPhase}`,
              `- artifactsDir: ${artifactsDir}`,
              `- sourcePath: ${(run.metadata as Record<string, unknown>).sourcePath ?? "unknown"}`,
            ]
            // 关键参数补全：把这些原本只在系统提示（system.transform hook → buildRuntimeContext）
            // 里的字段也放进 workOrder，使任务提示自包含——hook 若未触发/失败（currentWorkflowContext
            // 为 null、agentPath 缺失、异常被吞），worker 仍能拿到 mainEntry/triggerPhase/
            // previousFindings/projectStructure，不致失能。
            {
              const md = run.metadata as Record<string, unknown>
              if (md.mainEntry) workOrderParts.push(`- mainEntry: ${md.mainEntry}`)
              if (run.currentPhase === "fix" && currentEntry?.branchedFrom) {
                workOrderParts.push(`- triggerPhase: ${currentEntry.branchedFrom}`)
              }
              const ps = md.projectStructure
              if (ps && Array.isArray(ps)) workOrderParts.push(`- projectStructure: ${ps.join(", ")}`)
              const pf = currentEntry?.incrementalContext?.previousFindings
              if (pf && pf.length > 0) {
                workOrderParts.push(`- previousFindings（上次 review 的 mustFix，先逐项核对是否已修复；未修复的须再次列入本次 mustFix）:`)
                for (const f of pf) {
                  workOrderParts.push(`  - { packageName: ${f.packageName}, file: ${f.file}, line: ${f.line ?? "null"}, issue: ${JSON.stringify(f.issue)} }`)
                }
              }
            }

            // 上游 artifact 路径列表：明确告诉 Worker 要读取哪些文件及完整路径
            // 复用上方已取的 currentEntry（同一 run 同一 dispatch，避免重复线性扫描）
            const activeShardPlan = engine.getShardPlan(run)
            let upstream = UPSTREAM_ARTIFACTS[run.currentPhase ?? ""]
            if (upstream && upstream.length > 0) {
              // fix 阶段过滤只注入对应 triggerPhase 的 summary
              if (run.currentPhase === "fix" && currentEntry?.branchedFrom) {
                const triggerPhase = currentEntry.branchedFrom
                const excludeSummary = triggerPhase === "review"
                  ? "verify-summary.json"
                  : "review-summary.json"
                upstream = upstream.filter(a => a !== excludeSummary)
              }
              // 分片模式：收窄 upstream（per-package glob 限定到本分片包 + 已完成分片 translation.json）
              if (activeShardPlan && currentEntry?.incrementalContext?.shardIndex !== undefined) {
                const completedPkgs = activeShardPlan.completedShards
                  .flatMap(i => activeShardPlan.shards[i] ?? [])
                const shardTargetPkgs = currentEntry?.incrementalContext?.targetPackages ?? []
                const shardTargetUnits = currentEntry?.incrementalContext?.targetUnits ?? []
                // translate unit 模式需 functionOwnership 展开 cargo FUNCTION 的 FSD
                let functionOwnership: Record<string, string> | undefined
                if (shardTargetUnits.length > 0) {
                  const analysis = engine.loadArtifactJson(`${ARTIFACT_DIR}/${run.runId}`, "analysis")
                  functionOwnership = (analysis?.functionOwnership as Record<string, string> | undefined) ?? undefined
                }
                upstream = narrowUpstreamForShard(upstream, run.currentPhase ?? "", shardTargetPkgs, completedPkgs, {
                  targetUnits: shardTargetUnits,
                  functionOwnership,
                })
              }
              workOrderParts.push(`- upstreamArtifacts:`)
              for (const a of upstream) {
                workOrderParts.push(`  - ${artifactsDir}/${a}`)
              }
            }

            // 分片模式：注入分片信息到 workOrder
            if (activeShardPlan && currentEntry?.incrementalContext?.shardIndex !== undefined) {
              const si = currentEntry.incrementalContext.shardIndex
              const ts = currentEntry.incrementalContext.totalShards ?? activeShardPlan.shards.length
              const units = currentEntry.incrementalContext.targetUnits
              const pkgs = currentEntry.incrementalContext.targetPackages
              const isUnitMode = !!units?.length
              const targetLabel = isUnitMode ? units!.join(", ") : (pkgs?.join(", ") ?? "")
              const targetWord = isUnitMode ? "PROCEDURE 单元" : "包"
              workOrderParts.push(
                ``,
                `## 分片信息`,
                `- 本分片序号: ${si + 1} / ${ts}`,
                `- 本分片${targetWord}列表: ${targetLabel}`,
                `- **只处理以上列出的${targetWord}，不要处理其他${targetWord}**`,
                `- 已完成分片: ${activeShardPlan.completedShards.map(i => i + 1).join(", ") || "无"}`,
              )
              // 单元读取清单（unit 模式）：精准列出本分片每个 unit 要读的源码片段/文件，
              // 把读取单元收紧到工作单元，防止 agent 读整包 body 顺手全做（[[translate-procedure-level]]）。
              if (isUnitMode && units && units.length > 0) {
                const completedUnitIds = activeShardPlan.completedShards
                  .flatMap(i => activeShardPlan.shards[i] ?? [])
                const scopeBlock = buildUnitScopeBlock(
                  `${ARTIFACT_DIR}/${run.runId}`,
                  units,
                  run.currentPhase ?? "",
                  completedUnitIds,
                  String((run.metadata as Record<string, unknown>).sourcePath ?? ""),
                )
                if (scopeBlock) workOrderParts.push("", scopeBlock)
              }
              // 顶部 scope banner（最高优先级，置于 workOrder 最前）：分片 agent 常越界处理其他包/单元，
              // 靠「分片信息」中段提示不够醒目，故在最前再加强约束（[[opencode-todowrite-prompt-driven]] banner 模式）。
              const scopeBanner = [
                `⛔⛔⛔ 分片范围硬约束（最高优先级，开始工作前先读）⛔⛔⛔`,
                `本分片【只】处理以下 ${targetWord}: ${targetLabel}`,
                `- 禁止处理、读源码、生成 FSD/产物 for 任何【其他】${targetWord}。`,
                `- analysis.json / inventory.json 里列出的其他包/单元【不是】你的工作清单，仅作参考信息。`,
                `- 处理完本分片 ${targetWord} 后立即输出 WORKER_SUMMARY 结束，不要"顺手"做其他 ${targetWord}（会有别的分片做，重复 = 产物冲突）。`,
                `⛔⛔⛔ 违反 = 重复工作 + 产物冲突 ⛔⛔⛔`,
                ``,
              ].join("\n")
              workOrderParts.unshift(scopeBanner)
            }

            // P3c: projectRoot + 文件写入路径映射（plan 阶段之后才有 projectRoot）
            const planForDispatch = engine.loadArtifactJson(`${ARTIFACT_DIR}/${run.runId}`, "plan")
            if (planForDispatch) {
              const artifactId = (planForDispatch.targetProject as any)?.artifactId
              if (artifactId) {
                const projectRoot = join(resolveProjectRoot(), "generated", artifactId)
                workOrderParts.push(
                  `- projectRoot: ${projectRoot}  ← Java/项目文件写入此目录`,
                )
              }
            }

            // D15: schema hint 放在指令之前——worker 先看到"必须符合的格式"再读指令，
            // 降低盲写导致的 Zod 拒绝。system prompt 不再注入（单一来源原则）。
            const schemaHint = renderSchemaHint(run.currentPhase)
            if (schemaHint) {
              workOrderParts.push('', schemaHint)
            }

            workOrderParts.push(
              ``,
              `## 指令`,
              `1. 按 Phase 指令读取上游 artifact（使用上方完整路径）并执行工作`,
              `2. 将产出物写入正确目录（见下方路径规则）`,
              `3. 写入 Worker Status: ${artifactsDir}/status/${run.currentPhase}.json`,
              `4. 输出阶段小结（WORKER_SUMMARY 格式）`,
            )

            // P3c: 路径规则（plan 之后阶段才有 projectRoot 概念）
            if (planForDispatch && (planForDispatch.targetProject as any)?.artifactId) {
              const artifactId = (planForDispatch.targetProject as any).artifactId
              const projectRoot = join(resolveProjectRoot(), "generated", artifactId)
              workOrderParts.push(
                ``,
                `## 📂 文件写入路径（强制）`,
                `- JSON artifact（scaffold.json、translation.json 等）→ saveArtifact 工具 → artifactsDir`,
                `- Java/.xml/.yml/.properties/.sql 项目文件 → write 工具 → projectRoot（${projectRoot}）`,
                `- ❌ 禁止将项目文件写入 artifactsDir/（任何子目录，包括 translations/、analysis-packages/ 等）`,
                `- ❌ 禁止写入 .git/、.claude/、node_modules/ 等敏感目录`,
                `- ❌ 禁止写入 sourcePath 目录（只读）`,
                `- scaffold.json 的 projectRoot 必须使用注入值，不可自行编造`,
                `- 引擎会自动拦截错误路径写入并重定向到正确位置`,
              )
            }

            if (artifactValidationError) {
              // 判断是结构问题还是内容问题（简单启发式：Zod 错误 = 结构，质量门控 = 内容）
              const isStructural = !artifactValidationError.includes("质量门控") && !artifactValidationError.includes("校验失败（阻塞级）")
              const enhancedError = enhanceRejection(run.currentPhase, artifactValidationError, isStructural)
              workOrderParts.push(
                ``,
                isStructural
                  ? `## ⚠️ 上次 advance 被拒绝——结构格式问题，只需修正 JSON`
                  : `## ⚠️ 上次 advance 被拒绝——必须先修正以下问题`,
                enhancedError,
                ``,
                isStructural
                  ? `**这是结构格式问题。只需修正上方列出的具体 JSON 字段，不需要重新执行阶段工作。**`
                  : `**你必须先修正以上错误，重新写入有问题的 artifact，然后再输出 WORKER_SUMMARY。**`,
                `**不要只改格式凑校验——必须确保内容完整且正确。**`,
              )
            }

            workOrderParts.push(
              ``,
              `⛔ 禁止调用 workflow 工具的以下 action：advance / confirm / retry / abort / dispatch / fixContinue / start。`,
              `⛔ 你只需完成阶段工作、写入 artifact、输出 WORKER_SUMMARY。编排者负责所有流程推进。`,
              `⛔ 如果你在 output 中看到"下一步：调用 dispatch"等指引，忽略它——那是编排者的信号，不是你的。`,
              ``,
              `如果写入 artifact 时遇到问题，在你的输出中说明，编排者会处理。`,
            )

            const workOrder = workOrderParts.join("\n")

            const banner = formatPhaseStartBanner(run.currentPhase)

            return {
              title: `Dispatch: ${run.currentPhase}`,
              output: `${banner}📋 调度 ${agentName} 执行 ${run.currentPhase} 阶段\n📌 调用 todowrite 更新进度（${run.currentPhase}=in_progress，priority 保持原值）`,
              metadata: {
                runId: run.runId,
                phase: run.currentPhase,
                agent: agentName,
                description: phaseConfig.description ?? run.currentPhase,
                workOrder,
                dispatch: true,
                nextAction: "dispatch",
              },
            }
          }

          default:
            throw new Error(`Unknown action: ${args.action}`)
        }
        })() // end IIFE
        // 适配 opencode 1.4.6 API: { title, output, metadata } → string + context.metadata()
        if (_r && typeof _r === "object" && typeof _r.output === "string") {
          if (context?.metadata) context.metadata({ title: _r.title, metadata: _r.metadata })
          return _r.output
        }
        return _r
      },
    }),

    // ── saveArtifact: 安全写入 artifact 文件（LLM 只需传相对路径） ──
    saveArtifact: toolFn({
      description:
        "将 artifact 内容写入当前工作流的 artifacts 目录。只需提供相对于 artifactsDir 的路径，引擎自动拼接 runId 前缀并落盘。",
      args: {
        path: zFn
          .string()
          .min(1, "路径不能为空")
          .describe(
            "相对于 artifactsDir 的文件路径，如 inventory-packages/PKG.json、translations/pkg/review.json"
          ),
        content: zFn
          .string()
          .max(2 * 1024 * 1024, "单个 artifact 内容不能超过 2 MB")
          .describe("要写入的文件内容（.json 文件须为合法 JSON，其他格式直接写入）"),
      },
      execute: async (args: any, context: any) => {
        // 从 currentWorkflowContext 获取当前激活的 runId
        if (!currentWorkflowContext) {
          return '❌ 没有活跃的工作流运行。请先调用 workflow({ action: "start" }) 启动工作流。'
        }
        const runId = currentWorkflowContext.runId
        const artifactsDir = join(ARTIFACT_DIR, runId)
        const fullPath = join(artifactsDir, args.path)

        // 安全校验：路径不能逃逸出 artifactsDir（拒绝目录级写入 + 符号链接穿越）
        const resolved = resolve(fullPath)
        const resolvedDir = resolve(artifactsDir)
        if (!resolved.startsWith(resolvedDir + sep)) {
          return `❌ 路径越界: ${args.path} 不允许写入 artifacts 目录之外`
        }

        // 安全校验：确保目标路径不是符号链接（防止穿越到目录外）
        const parentDir = dirname(resolved)
        if (existsSync(parentDir)) {
          const realParent = realpathSync(parentDir)
          if (!realParent.startsWith(resolve(artifactsDir) + sep) && realParent !== resolve(artifactsDir)) {
            return `❌ 路径包含指向目录外的符号链接: ${args.path}`
          }
        }

        // 校验：.json 文件须为合法 JSON，其他格式直接写入
        if (args.path.endsWith('.json')) {
          try {
            JSON.parse(args.content)
          } catch {
            return '❌ .json 文件的 content 不是合法的 JSON 字符串。请确保 content 可以被 JSON.parse 正确解析。'
          }
        }

        // P3b: scaffold.json 的 projectRoot 强制覆写为引擎计算值
        if (args.path === "scaffold.json") {
          const planArtifact = engine.loadArtifactJson(`${ARTIFACT_DIR}/${runId}`, "plan")
          const artifactId = (planArtifact?.targetProject as any)?.artifactId
          if (artifactId) {
            const expectedRoot = join(resolveProjectRoot(), "generated", artifactId)
            try {
              const parsed = JSON.parse(args.content)
              if (parsed.projectRoot !== expectedRoot) {
                parsed.projectRoot = expectedRoot
                args.content = JSON.stringify(parsed, null, 2)
                getLogger().info("[saveArtifact]", `Overrode scaffold.json projectRoot → ${expectedRoot}`)
              }
            } catch { /* already validated above */ }
          }
        }

        // 原子写入（safeWriteFile 内含 mkdir + tmp → rename + 清理）
        let writeErr: Error | undefined
        safeWriteFile(fullPath, args.content, (e) => { writeErr = e })
        if (writeErr) {
          return `❌ 写入失败: ${writeErr.message}`
        }

        const sizeKB = (args.content.length / 1024).toFixed(1)
        if (context?.metadata) {
          context.metadata({
            title: `saved ${args.path}`,
            metadata: { runId, path: args.path, sizeKB },
          })
        }
        getLogger().info("[saveArtifact]", `${runId} | ${args.path} (${sizeKB} KB)`)

        return `✅ saved: ${args.path} (${sizeKB} KB)`
      },
    }),
  },

  // ── Hook: tool.execute.before — 文件写入路径拦截（P3a v2: zone 分类统一拦截） ──
  // 统一拦截 write/bash 工具的文件写入，按 zone × fileType 决定 redirect/block/allow
  "tool.execute.before": async (input: any, output: any) => {
    if (!currentWorkflowContext) return

    // ── Branch A: write 工具路径拦截 ──
    if (input.tool === "write") {
      const filePath = resolve(output.args?.file_path ?? "")
      if (!filePath) return

      const runId = currentWorkflowContext.runId
      const artifactsDir = resolve(join(ARTIFACT_DIR, runId))

      // 计算 projectRoot（plan 阶段之后才存在）
      const planArtifact = engine.loadArtifactJson(`${ARTIFACT_DIR}/${runId}`, "plan")
      let projectRoot = ''
      if (planArtifact) {
        const artifactId = (planArtifact.targetProject as any)?.artifactId
        if (artifactId) projectRoot = resolve(join(resolveProjectRoot(), "generated", artifactId))
      }

      const sourcePath = resolveSourcePath(runId)
      const cls = classifyWritePath(filePath, artifactsDir, projectRoot, sourcePath)

      if (cls.shouldBlock) {
        // 阻止写入：记录到 artifactsDir/_blocked-writes/ 并替换目标
        getLogger().error("[write-intercept]", `BLOCKED: ${filePath} — ${cls.blockReason}`)
        try {
          const blockedDir = join(artifactsDir, "_blocked-writes")
          mkdirSync(blockedDir, { recursive: true })
          const blockedEntry = join(blockedDir, `blocked-${Date.now()}.log`)
          safeWriteFile(blockedEntry,
            `Blocked: ${filePath}\nReason: ${cls.blockReason}\n`)
          output.args = { ...output.args, file_path: blockedEntry, content: `[blocked] ${cls.blockReason}` }
        } catch {
          // blocked-writes 日志写入失败也不影响主流程，静默忽略
        }
        return
      }

      if (cls.shouldRedirect && cls.correctedPath) {
        getLogger().warn("[write-intercept]",
          `Redirected (${cls.zone}/${cls.fileType}): ${filePath} → ${cls.correctedPath}`)
        output.args = { ...output.args, file_path: cls.correctedPath }
        return
      }

      return
    }

    // ── Branch B: bash 写入检查（仅告警，不拦截） ──
    if (input.tool === "bash") {
      const command = output.args?.command ?? ''
      if (typeof command !== 'string' || !command) return

      const runId = currentWorkflowContext.runId
      const planArtifact = engine.loadArtifactJson(`${ARTIFACT_DIR}/${runId}`, "plan")
      if (!planArtifact) return
      const artifactId = (planArtifact.targetProject as any)?.artifactId
      if (!artifactId) return
      const projectRoot = resolve(join(resolveProjectRoot(), "generated", artifactId))

      // 扫描常见写入模式，检测是否往项目文件路径写入
      const writeRe = /(?:>|\btee\b|\bcp\b|\bmv\b)\s.*\.(java|xml|yml|yaml|properties|sql)\b/i
      if (writeRe.test(command)) {
        getLogger().warn("[bash-write-inspect]",
          `Bash 写入项目文件检测，期望目标在 projectRoot 下: ${projectRoot}`)
      }
    }
  },

  // ── Hook: tool.execute.after — 大输出截断 ──
  "tool.execute.after": async (input: any, output: any) => {
    if (
      currentWorkflowContext &&
      (input.tool === "Agent" || input.tool === "Task")
    ) {
      try {
        const j = JSON.stringify(output)
        if (j?.length > 50000) {
          // 递归截断所有超过阈值的字符串字段（含嵌套对象/数组），返回新对象不修改原始
          if (output && typeof output === "object") {
            const truncated = truncateStringsDeep(output, 10000)
            // 将截断后的字段写回 output（仅写回截断后的顶级字段，避免替换整个对象引用）
            if (truncated && typeof truncated === "object") {
              if (Array.isArray(truncated)) {
                // 数组：用 splice 替换内容，保持原始数组引用
                const arr = output as unknown[]
                arr.splice(0, arr.length, ...(truncated as unknown[]))
              } else {
                Object.assign(output as Record<string, unknown>, truncated as Record<string, unknown>)
              }
            }
          }
        }
      } catch {
        // JSON.stringify 可能因循环引用失败，安全忽略
      }
    }
  },

  // ── Hook: chat.params — 温度控制 + 编排 session 识别 ──
  // opencode 1.4.6: (input, output) => void，修改 output 参数
  "chat.params": async (input: any, output: any) => {
    // 编排 session 识别：非 subagent agent 名称 → 编排 session
    const agentName = input?.agent ?? ""
    if (!getSubagentNames().includes(agentName)) {
      const sid = input?.sessionID
      if (sid) orchestratorSessionIds.add(sid)
      // 编排 session 不覆盖温度，使用默认值
      return
    }
    // Worker subagent session：按阶段配置设置温度
    if (currentWorkflowContext) {
      if (output) output.temperature = currentWorkflowContext.temperature
    }
  },

  // ── Hook: experimental.chat.system.transform — system prompt 构建 (D11) ──
  // opencode 1.4.6: (input, output) => void，修改 output.system (string[])
  "experimental.chat.system.transform": async (input: any, output: any) => {
    // 编排 session 不注入 Worker agent prompt（编排者的指令来自 command .md）
    const sid = input?.sessionID
    if (sid && orchestratorSessionIds.has(sid)) return
    if (!currentWorkflowContext) return
    try {
      // 使用共享路径工具定位 agent 文件，不依赖 process.cwd()
      const agentPath = join(findOpencodeDir(), currentWorkflowContext.agentFile)
      if (existsSync(agentPath)) {
        // 1. 读取 agent .md 全文
        let c = readFileSync(agentPath, "utf-8").replace(/^---[\s\S]*?---\n*/, "")

        // 2. 提取通用部分 + 当前 phase section
        const common = extractCommonPart(c)
        const phaseSection = extractPhaseSection(c, currentWorkflowContext.phase)

        // 3. 构建 Runtime Context
        const run = engine.status(currentWorkflowContext.runId)
        let runtimeContext = ""
        if (run) {
          runtimeContext = buildRuntimeContext(run)
        } else {
          // currentWorkflowContext 已设（有活跃 workflow）但 run.json 读不到 → 系统提示会缺
          // runtimeContext 实际值。worker 仍可从 workOrder 关键参数取核心字段（已自包含），
          // 但此降级须可见，避免静默失能。
          getLogger().warn(
            "[workflow-engine]",
            `system.transform: currentWorkflowContext 已设(runId=${currentWorkflowContext.runId})但 engine.status 读不到 run——Runtime Context 实际值未注入系统提示，worker 将依赖 workOrder 自包含字段。`,
          )
        }

        // 4. 拼接 system prompt
        const sharedInstructions = run ? buildSharedInstructions(run) : ""
        // 仅对白名单中的 agent 注入代码规约
        const needsJavaSpec = JAVA_SPEC_AGENTS.some(a => currentWorkflowContext.agentFile.includes(a))
        const rawSpec = needsJavaSpec ? readJavaCodeSpec() : ""
        // 合并用户自定义规约（--spec）：用户章节覆盖同名内置章节，独有章节追加
        let javaCodeSpec: string
        if (needsJavaSpec && rawSpec) {
          const userSpecPath = (run?.metadata as Record<string, unknown>)?.userSpecPath as string | undefined
          if (userSpecPath) {
            try {
              const userSpec = loadUserSpec(userSpecPath, undefined)
              if (userSpec && userSpec.sections.size > 0) {
                javaCodeSpec = mergeSpecSections(parseMarkdownSections(rawSpec), userSpec.sections)
              } else {
                javaCodeSpec = rawSpec
              }
            } catch (e: any) {
              getLogger().warn("[workflow-engine]", `合并用户规约失败，回退到内置规约: ${e.message}`)
              javaCodeSpec = rawSpec
            }
          } else {
            javaCodeSpec = rawSpec
          }
        } else if (needsJavaSpec) {
          // 规约缺失时注入显眼警告，避免 agent 在不知情下产出无规约代码
          javaCodeSpec = "\n> ⚠️ **[workflow-engine] Java 代码规约文件缺失或不可读，请检查 .opencode/docs/java-code-spec.md**\n"
        } else {
          javaCodeSpec = ""
        }
        // D13 已迁至 dispatch workOrder — schema hint 不再注入 system prompt（单一来源原则）
        const parts = [
          common,
          phaseSection,
          javaCodeSpec,
          sharedInstructions,
          runtimeContext ? "## Runtime Context\n\n" + runtimeContext : "",
        ].filter((p) => p !== "")

        if (output) output.system = [parts.join("\n\n")]
      } else {
        getLogger().error("[workflow-engine]", `Agent file not found: ${agentPath}. System prompt will not be injected.`)
      }
    } catch (e: any) {
      getLogger().error("[workflow-engine]", `Failed to build system prompt: ${e.message}`)
    }
  },

  // ── Hook: event — Metrics 采集（message.part.updated 事件） ──
  // try-catch 包裹整体：畸形事件或 SDK 变更不应杀死事件链
  event: async ({ event }: { event: any }) => {
    try {
      if (!currentWorkflowContext || !activeCollector) return
      if (event.type !== "message.part.updated") return
      const part = event.properties?.part
      if (!part) return

      switch (part.type) {
        case "step-finish":
          activeCollector.recordStepFinish({
            cost: part.cost ?? 0,
            tokens: part.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            reason: part.reason ?? "unknown",
          })
          break
        case "tool": {
          const state = part.state
          if (!state) break
          if (state.status === "running" && state.time?.start) {
            // 工具开始运行
            activeCollector.recordToolCalled(part.callID, part.tool, state.time.start)
          } else if ((state.status === "completed" || state.status === "error") && state.time) {
            // 兜底：若未捕获 running 状态，先补录 start（幂等：recordToolCalled 会覆盖已有 entry）
            activeCollector.recordToolCalled(part.callID, part.tool, state.time.start)
            activeCollector.recordToolCompleted(
              part.callID, state.status === "completed" ? "completed" : "error", state.time.end,
            )
          }
          break
        }
      }
    } catch (e: any) {
      getLogger().warn("[metrics]", `event hook 处理失败: ${e.message}`)
    }
  },
})
}
