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
import { join, dirname, resolve, sep } from "node:path"
import { safeWriteFile } from "../workflow/cross-platform"
import { WorkflowEngine, WorkflowEngineError, formatZodIssues, type WorkflowRun } from "../workflow/engine-core"
import { enhanceRejection } from "../workflow/rejection-guidance"
import { renderSchemaHint } from "../workflow/schema-hint-renderer"
import { SQL2JAVA_WORKFLOW } from "../workflow/workflow-definitions"
import { UPSTREAM_ARTIFACTS, PHASE_PREREQUISITES } from "../workflow/workflow-definitions"
import {
  getSchemaForPhase, getPerPackageSchema, getSummarySchema,
  getAnalysisPackageSchema, getInventoryPackageSchema,
  getArtifactFilename,
} from "../workflow/artifact-schemas"
import { scanSource } from "../workflow/plsql-scanner"
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

/**
 * 加载项目目录结构定义。
 * 优先级：1) structureConf 指定路径  2) sourcePath/project-structure.md 自动发现  3) null（用默认）
 *
 * 当 structureConf 显式指定但文件不存在时，抛出 Error（用户应知道指定的路径无效）。
 * 其他情况（自动发现失败、解析失败）返回 null，不阻塞流程。
 */
function loadProjectStructure(structureConf?: string, sourcePath?: string): string[] | null {
  let filePath: string | null = null

  // 优先级 1: CLI 参数指定（必须存在，否则报错）
  if (structureConf) {
    if (!existsSync(structureConf)) {
      throw new Error(`--structure 指定的文件不存在: ${structureConf}`)
    }
    filePath = structureConf
  }
  // 优先级 2: 自动发现
  else if (sourcePath) {
    const autoPath = join(sourcePath, "project-structure.md")
    if (!existsSync(autoPath)) return null
    filePath = autoPath
  }

  if (!filePath) return null

  try {
    const raw = readFileSync(filePath, "utf-8")
    const paths = parseStructureText(raw)
    if (paths.length === 0) {
      getLogger().warn("[workflow-engine]", `结构定义文件解析结果为空: ${filePath}`)
      return null
    }
    getLogger().info("[workflow-engine]", `加载项目结构定义: ${filePath} (${paths.length} 个路径)`)
    return paths
  } catch (e: any) {
    if (e.message.startsWith("--structure")) throw e // 重新抛出上面的显式错误
    getLogger().warn("[workflow-engine]", `无法加载结构定义文件 ${filePath}: ${e.message}`)
    return null
  }
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
    lines.push(`  targetPackages: ${JSON.stringify(currentEntry.incrementalContext.targetPackages)}`)
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
| \`incrementalContext\` | 增量模式上下文（可选） | fix 后增量处理时传入 targetPackages |
| \`projectStructure\` | 自定义目录结构路径列表（可选） | scaffold 阶段使用自定义目录布局替代默认模板 |
| \`projectRoot\` | Java 项目输出根目录（绝对路径，scaffold 及之后阶段，可选） | scaffold 写入 Java 文件到此目录，后续阶段从此目录读取 |

### Artifact 写入规则

- **JSON artifact**（plan.json、scaffold.json、translation.json 等元数据文件）使用 \`write\` 工具写入 \`\${artifactsDir}/\` 下的指定路径
- **Java 源文件**（.java、.xml、.yml、pom.xml 等）必须写入 Runtime Context 中 \`projectRoot\` 指定的目录（绝对路径），**绝不能**写入 \`\${artifactsDir}/\` 下
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
  metaParsed: Record<string, unknown>,
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
  const expectedPackages = Array.from(engine.extractPackageNames(inventory))

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

  // 校验 meta 文件 packageNames 与 inventory 一致
  // 包名不一致降为 warning：engine-core validateCrossSchema 会检测并自动放行
  const metaNames = engine.extractPackageNames(metaParsed)
  const invSet = new Set(expectedPackages)
  const pkgWarnings: string[] = []
  for (const n of invSet) {
    if (!metaNames.has(n)) pkgWarnings.push(`analysis.json packageNames missing: ${n}`)
  }
  for (const n of metaNames) {
    if (!invSet.has(n)) pkgWarnings.push(`analysis.json packageNames has extra: ${n}`)
  }
  if (pkgWarnings.length > 0) {
    getLogger().warn("[validateAnalysisPackages]", `包名一致性警告（已降级为 warning，不阻断）：${pkgWarnings.join("; ")}`)
  }

  return null // 校验通过
}

// per-package 文件名映射复用 artifact-schemas.ts 的 PHASE_FILENAME_MAP
// getArtifactFilename("translate") → "translation"，其余 phase 名与文件名一致

/**
 * D5: advance 时从磁盘读取 artifact 并做 Zod 校验
 * 返回 null 表示校验通过，否则返回错误信息
 */
function validateArtifactOnDisk(run: WorkflowRun): string | null {
  const phase = run.currentPhase
  if (!phase) return null

  const artifactsDir = join(ARTIFACT_DIR, run.runId)

  // 1. 顶层 schema（inventory / analyze / plan / scaffold / fix）
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

      // analyze 阶段：额外校验 analysis-packages/ 目录下的逐包文件
      if (phase === "analyze") {
        const pkgError = validateAnalysisPackages(artifactsDir, parsed)
        if (pkgError) return pkgError
      }

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

      // inventory 阶段：校验 inventory-packages/ + inventory-index.json
      if (phase === "inventory") {
        const pkgError = validateInventoryPackages(artifactsDir)
        if (pkgError) return pkgError
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
        structureConf: zFn.string().optional(), // --structure 用
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
            const runId = args.runId ?? `run-${Date.now()}`
            initLogger(runId)

            // 加载自定义项目目录结构
            let projectStructure: string[] | null = null
            try {
              projectStructure = args.sourcePath
                ? loadProjectStructure(args.structureConf, args.sourcePath)
                : null
            } catch (e: any) {
              return {
                title: "Error",
                output: `❌ ${e.message}`,
                metadata: { runId, dispatch: false },
              }
            }
            const metadata: Record<string, unknown> = {}
            if (args.sourcePath) metadata.sourcePath = args.sourcePath
            if (projectStructure) metadata.projectStructure = projectStructure

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

            // ── 前置步骤：schema 获取（有 db.xml 配置时触发，无论是否已有 SQL 文件）──
            // fetchSchemaIfNeeded 内部自行判断 db.xml 是否存在，无配置时静默返回 { fetched: false }
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
                const enhancedError = enhanceRejection(statusBefore.currentPhase, validationError)
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

            // ★ BUG FIX: engine.advance() 就地修改 run 对象（statusBefore 是同一引用），
            // advance 后 statusBefore.currentPhase 变成下一阶段而非完成阶段。
            // 必须在 advance 之前保存完成阶段名。
            const completedPhase = statusBefore?.currentPhase ?? ""
            getLogger().info("[advance]", `阶段 ${completedPhase} 请求 advance, result=${args.result ?? "auto"}`)

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

              // translate/review/verify 阶段：检查哪些包已有 artifact
              if (["translate", "review", "verify"].includes(run.currentPhase)) {
                const translationsDir = join(artifactsDir, "translations")
                if (existsSync(translationsDir)) {
                  const currentEntry = engine.findCurrentEntry(run)
                  const isIncremental = !!currentEntry?.incrementalContext?.targetPackages?.length

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
            setWorkflowContext(run)

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

            // 上游 artifact 路径列表：明确告诉 Worker 要读取哪些文件及完整路径
            const upstream = UPSTREAM_ARTIFACTS[run.currentPhase ?? ""]
            if (upstream && upstream.length > 0) {
              workOrderParts.push(`- upstreamArtifacts:`)
              for (const a of upstream) {
                workOrderParts.push(`  - ${artifactsDir}/${a}`)
              }
            }

            workOrderParts.push(
              ``,
              `## 指令`,
              `1. 按 Phase 指令读取上游 artifact（使用上方完整路径）并执行工作`,
              `2. 将产出物写入 artifactsDir 目录`,
              `3. 写入 Worker Status: ${artifactsDir}/status/${run.currentPhase}.json`,
              `4. 输出阶段小结（WORKER_SUMMARY 格式）`,
            )

            if (artifactValidationError) {
              // 修正模式：注入校验错误，Worker 必须先修正再继续
              const enhancedError = enhanceRejection(run.currentPhase, artifactValidationError)
              workOrderParts.push(
                ``,
                `## ⚠️ 上次 advance 被拒绝——必须先修正以下问题`,
                enhancedError,
                ``,
                `**你必须先修正以上错误，重新写入有问题的 artifact，然后再输出 WORKER_SUMMARY。**`,
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
        }

        // 4. 拼接 system prompt
        const sharedInstructions = run ? buildSharedInstructions(run) : ""
        // 仅对白名单中的 agent 注入代码规约
        const needsJavaSpec = JAVA_SPEC_AGENTS.some(a => currentWorkflowContext.agentFile.includes(a))
        const rawSpec = needsJavaSpec ? readJavaCodeSpec() : ""
        // 规约缺失时注入显眼警告，避免 agent 在不知情下产出无规约代码
        const javaCodeSpec = rawSpec || (needsJavaSpec
          ? "\n> ⚠️ **[workflow-engine] Java 代码规约文件缺失或不可读，请检查 .opencode/docs/java-code-spec.md**\n"
          : "")
        // D13: 注入当前阶段的 Schema 校验要求（advance 时的 Zod + 引擎级校验 + 质量门控）
        const schemaHint = renderSchemaHint(currentWorkflowContext.phase)
        const parts = [
          common,
          phaseSection,
          schemaHint,
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
