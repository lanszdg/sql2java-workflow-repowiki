/**
 * Workflow Engine Plugin — 适配 @opencode-ai/plugin
 *
 * 实现：
 *   - workflow 工具（7 个 action）
 *   - advance 时 Zod artifact 校验（D5）
 *   - system prompt 构建 + Runtime Context 注入（D11）
 *   - 温度控制 + 工具过滤
 *   - 大输出截断
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { WorkflowEngine, type WorkflowRun } from "../workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "../workflow/workflow-definitions"
import { UPSTREAM_ARTIFACTS, PHASE_PREREQUISITES } from "../workflow/workflow-definitions"
import {
  getSchemaForPhase, getPerPackageSchema, getSummarySchema,
  getAnalysisPackageSchema, getInventoryPackageSchema,
  getArtifactFilename,
} from "../workflow/artifact-schemas"
import { scanSource } from "../workflow/plsql-scanner"

const engine = new WorkflowEngine()
engine.registerDefinition(SQL2JAVA_WORKFLOW)
const ARTIFACT_DIR = ".workflow-artifacts"

let currentWorkflowContext: {
  runId: string
  phase: string
  agentFile: string
  temperature: number
} | null = null

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 格式化阶段开始 banner */
function formatPhaseStartBanner(phaseName: string): string {
  const phaseConfig = SQL2JAVA_WORKFLOW.phases.find(p => p.name === phaseName)
  const desc = phaseConfig?.description ?? phaseName
  const isFix = phaseConfig?.isFixPhase ?? false
  // fix 是条件分支阶段，不属于主线 1-N 进度
  const mainPhases = SQL2JAVA_WORKFLOW.phases.filter(p => !p.isFixPhase)
  const idx = mainPhases.findIndex(p => p.name === phaseName) + 1
  const total = mainPhases.length
  const label = isFix
    ? `${phaseName} — ${desc}`
    : `阶段 ${idx}/${total}：${phaseName} — ${desc}`
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
}

function clearWorkflowContext(): void {
  currentWorkflowContext = null
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

/** 构建 Runtime Context 文本块 */
function buildRuntimeContext(run: WorkflowRun): string {
  const lines: string[] = []
  lines.push(`currentPhase: ${run.currentPhase ?? "unknown"}`)
  lines.push(`runId: ${run.runId}`)
  lines.push(`sourcePath: ${(run.metadata as Record<string, unknown>).sourcePath ?? "unknown"}`)
  lines.push(`artifactsDir: ${ARTIFACT_DIR}/${run.runId}`)

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

  return lines.join("\n")
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

  // 3. 逐包校验
  const pkgSchema = getInventoryPackageSchema()
  for (const pkgName of expectedPackages) {
    const pkgFile = join(pkgDir, `${pkgName}.json`)
    if (!existsSync(pkgFile)) {
      return `Missing inventory package file: inventory-packages/${pkgName}.json`
    }
    try {
      const raw = readFileSync(pkgFile, "utf-8")
      const parsed = JSON.parse(raw)
      const result = pkgSchema.safeParse(parsed)
      if (!result.success) {
        const errors = result.error.issues
          .map((i: any) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n")
        return `Zod validation failed for inventory-packages/${pkgName}.json:\n${errors}`
      }
      if (parsed.packageName !== pkgName) {
        return `inventory-packages/${pkgName}.json: packageName "${parsed.packageName}" does not match filename "${pkgName}"`
      }
    } catch (e: any) {
      return `Failed to read/parse inventory-packages/${pkgName}.json: ${e.message}`
    }
  }

  // 4. 校验 inventory.json 的 packageNames 与 index 一致
  const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
  if (!inventory) {
    return "inventory.json not found or malformed. Agent must write inventory.json before advancing."
  }
  const invNames = engine.extractPackageNames(inventory)
  const idxNames = new Set(expectedPackages)
  for (const n of idxNames) {
    if (!invNames.has(n)) return `inventory.json packageNames missing: ${n}`
  }
  for (const n of invNames) {
    if (!idxNames.has(n)) return `inventory.json packageNames has extra: ${n}`
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

  // 逐包校验
  const pkgSchema = getAnalysisPackageSchema()
  for (const pkgName of expectedPackages) {
    const pkgFile = join(analysisPackagesDir, `${pkgName}.json`)
    if (!existsSync(pkgFile)) {
      return `Missing analysis package file: analysis-packages/${pkgName}.json`
    }
    try {
      const raw = readFileSync(pkgFile, "utf-8")
      const parsed = JSON.parse(raw)
      const result = pkgSchema.safeParse(parsed)
      if (!result.success) {
        const errors = result.error.issues
          .map((i: any) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n")
        return `Zod validation failed for analysis-packages/${pkgName}.json:\n${errors}`
      }
      if (parsed.packageName !== pkgName) {
        return `analysis-packages/${pkgName}.json: packageName "${parsed.packageName}" does not match filename "${pkgName}"`
      }
    } catch (e: any) {
      return `Failed to read/parse analysis-packages/${pkgName}.json: ${e.message}`
    }
  }

  // 校验 meta 文件 packageNames 与 inventory 一致
  const metaNames = engine.extractPackageNames(metaParsed)
  const invSet = new Set(expectedPackages)
  for (const n of invSet) {
    if (!metaNames.has(n)) return `analysis.json packageNames missing: ${n}`
  }
  for (const n of metaNames) {
    if (!invSet.has(n)) return `analysis.json packageNames has extra: ${n}`
  }

  return null // 校验通过
}

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
        const errors = result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n")
        return `Zod validation failed for ${artifactFileName}.json:\n${errors}`
      }

      // analyze 阶段：额外校验 analysis-packages/ 目录下的逐包文件
      if (phase === "analyze") {
        const pkgError = validateAnalysisPackages(artifactsDir, parsed)
        if (pkgError) return pkgError
      }

      // inventory 阶段：校验 inventory-packages/ + inventory-index.json
      if (phase === "inventory") {
        const pkgError = validateInventoryPackages(artifactsDir)
        if (pkgError) return pkgError
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

    // 非增量模式：校验所有期望包都有对应的 artifact 文件
    if (!isIncremental) {
      const inventory = engine.loadArtifactJson(artifactsDir, "inventory")
      if (!inventory) {
        return `inventory.json not found or malformed in ${artifactsDir}. Cannot verify per-package completeness for phase "${phase}".`
      }
      const expectedPackages = Array.from(engine.extractPackageNames(inventory))
      for (const pkgName of expectedPackages) {
        const artifactFile = join(translationsDir, pkgName, `${phase}.json`)
        if (!existsSync(artifactFile)) {
          return `Missing per-package artifact: translations/${pkgName}/${phase}.json. All packages must have artifacts before advancing.`
        }
      }
    } else {
      // 增量模式：校验所有 targetPackages 都有对应的 artifact 文件
      const targetPackages = currentEntry?.incrementalContext?.targetPackages ?? []
      for (const pkgName of targetPackages) {
        const artifactFile = join(translationsDir, pkgName, `${phase}.json`)
        if (!existsSync(artifactFile)) {
          return `Missing per-package artifact in incremental mode: translations/${pkgName}/${phase}.json. All targetPackages must have artifacts before advancing.`
        }
      }
    }

    // Zod 校验：对需要校验的包目录逐个验证 per-package artifact
    const pkgDirsToValidate = isIncremental
      ? (currentEntry?.incrementalContext?.targetPackages ?? []).map(name => ({ name, isDirectory: () => true }))
      : readdirSync(translationsDir, { withFileTypes: true }).filter(d => d.isDirectory())
    for (const pkgDir of pkgDirsToValidate) {
      const artifactFile = join(translationsDir, pkgDir.name, `${phase}.json`)
      if (!existsSync(artifactFile)) continue // 跳过无文件的包（增量模式下未修改的包）
      try {
        const raw = readFileSync(artifactFile, "utf-8")
        const parsed = JSON.parse(raw)
        const result = perPackageSchema.safeParse(parsed)
        if (!result.success) {
          const errors = result.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n")
          return `Zod validation failed for translations/${pkgDir.name}/${phase}.json:\n${errors}`
        }
      } catch (e: any) {
        return `Failed to read/parse translations/${pkgDir.name}/${phase}.json: ${e.message}`
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
          const errors = result.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n")
          return `Zod validation failed for ${summaryPhase}.json:\n${errors}`
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

// ── 插件导出 ──────────────────────────────────────────────────────────────────

export const WorkflowEnginePlugin = async ({ $ }: { $: any }) => ({
  tool: {
    workflow: tool({
      description:
        "Deterministic multi-phase workflow engine for SQL→Java translation.",
      args: {
        action: z.enum([
          "start", "advance", "confirm", "retry", "abort", "status", "list",
          "prerequisites",
        ]),
        runId: z.string().optional(),
        sourcePath: z.string().optional(),
        artifact: z.any().optional(),
        result: z.enum(["passed", "failed"]).optional(),
        phases: z.string().optional(),        // --phases 用
      },
      execute: async (args: any) => {
        switch (args.action) {
          // ── start ──
          case "start": {
            const runId = args.runId ?? `run-${Date.now()}`
            const metadata = args.sourcePath ? { sourcePath: args.sourcePath } : {}

            // 尝试从磁盘恢复已有 run
            try {
              const existing = engine.loadFromDisk(runId)
              if (existing) {
                setWorkflowContext(existing)
                return {
                  title: "Resumed",
                  output: `${runId} | ${existing.currentPhase} | ${existing.status}`,
                  metadata: { runId, resumed: true },
                }
              }
            } catch {}

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
                scanStatus = `${index.scannerUsed} | ${index.packages.length} pkgs | ${index.tables.length} tables | ${index.triggers.length} triggers`
              } catch (e: any) {
                scanStatus = `failed: ${e.message}`
              }
            }

            const run = engine.start("sql2java", runId, metadata)
            setWorkflowContext(run)
            const banner = formatPhaseStartBanner(run.currentPhase!)
            return {
              title: "Started",
              output: `${runId} | ${run.currentPhase} | scan: ${scanStatus}${banner}`,
              metadata: { runId, phase: run.currentPhase, scanStatus },
            }
          }

          // ── advance ──
          case "advance": {
            if (!args.runId) throw new Error("runId required")
            const runId = args.runId

            // D5: 从磁盘校验 artifact（在 engine.advance 之前）
            // fix-failed 时跳过校验：agent 可能无法写出有效 fix.json，advance(result="failed")
            // 应直接进入 handleFixAdvance 的 failed 分支处理，不应被 Zod 校验拦截
            const statusBefore = engine.status(runId)
            const isFixFailed = statusBefore?.currentPhase === "fix" && args.result === "failed"
            if (statusBefore && statusBefore.status === "running" && !isFixFailed) {
              const validationError = validateArtifactOnDisk(statusBefore)
              if (validationError) {
                return {
                  title: "Validation Failed",
                  output: validationError,
                  metadata: {
                    rejected: true,
                    rejectionReason: validationError,
                  },
                }
              }
            }

            const adv = engine.advance(runId, { result: args.result })

            if (adv.finished) {
              clearWorkflowContext()
              const isWithIssues = adv.run.status === "completed_with_issues"
              const prevPhase = statusBefore?.currentPhase ?? ""
              const endBanner = formatPhaseEndBanner(prevPhase)
              const finalMsg = isWithIssues
                ? "⚠️ 工作流完成，但存在未解决问题"
                : "🎉 工作流全部完成！"
              return {
                title: isWithIssues ? "Completed with Issues" : "Completed",
                output: `${endBanner}${finalMsg}\nrunId: ${runId} | status: ${adv.run.status}`,
                metadata: { status: adv.run.status },
              }
            }

            if (adv.waitingForConfirmation) {
              const prevPhase = statusBefore?.currentPhase ?? ""
              const endBanner = formatPhaseEndBanner(prevPhase)
              const pausedPhase = adv.run.currentPhase ?? ""
              const pausedDesc = adv.nextPhase?.description ?? pausedPhase
              return {
                title: "Paused",
                output: `${endBanner}⏸ ${pausedPhase}（${pausedDesc}）等待确认。请审阅后调用：\nworkflow({action:"confirm",runId:"${runId}"})`,
                metadata: { waitingForConfirmation: true },
              }
            }

            if (adv.rejected) {
              // 不清理 workflowContext：LLM 应修正 artifact 后重新 advance，当前 phase context 仍有效
              return {
                title: "Rejected",
                output: adv.rejectionReason!,
                metadata: { rejected: true },
              }
            }

            if (adv.fixFailed) {
              // 不清理 workflowContext：LLM 应调用 retry()，retry 仍处于 fix phase，fix-phase context 仍有效
              return {
                title: "Fix Failed",
                output: adv.rejectionReason!,
                metadata: { fixFailed: true },
              }
            }

            setWorkflowContext(adv.run)
            const prevPhase = statusBefore?.currentPhase ?? ""
            const endBanner = formatPhaseEndBanner(prevPhase)
            const startBanner = formatPhaseStartBanner(adv.run.currentPhase!)
            return {
              title: `→ ${adv.run.currentPhase}`,
              output: `${endBanner}${startBanner}Agent: ${adv.nextPhase?.agentFile}`,
              metadata: { runId, phase: adv.run.currentPhase },
            }
          }

          // ── confirm ──
          case "confirm": {
            if (!args.runId) throw new Error("runId required")
            const r = engine.confirm(args.runId)
            setWorkflowContext(r)
            const startBanner = formatPhaseStartBanner(r.currentPhase!)
            const confirmedPhase = r.currentPhase ?? ""
            const confirmedDesc = SQL2JAVA_WORKFLOW.phases.find(p => p.name === confirmedPhase)?.description ?? confirmedPhase
            return {
              title: "Confirmed",
              output: `${startBanner}✔ ${confirmedPhase}（${confirmedDesc}）已确认，继续执行: ${r.status}`,
              metadata: { runId: args.runId },
            }
          }

          // ── retry ──
          case "retry": {
            if (!args.runId) throw new Error("runId required")
            const ret = engine.retry(args.runId)
            if (ret.exhausted) {
              clearWorkflowContext()
              return {
                title: "Exhausted",
                output: `Retries exhausted: ${ret.retryCount}. Status: ${ret.run.status}`,
                metadata: {
                  status: ret.run.status,
                  terminalState: ret.terminalState,
                },
              }
            }
            return {
              title: `Retry ${ret.retryCount}`,
              output: ret.run.currentPhase!,
              metadata: { runId: args.runId },
            }
          }

          // ── abort ──
          case "abort": {
            if (!args.runId) throw new Error("runId required")
            const r = engine.abort(args.runId)
            clearWorkflowContext()
            return {
              title: "Aborted",
              output: r.status,
              metadata: { status: r.status },
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
                metadata: { count: runs.length },
              }
            }
            const r = engine.status(args.runId)
            if (!r)
              return { title: "Not found", output: "No such run", metadata: {} }
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
                },
                null,
                2
              ),
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
              metadata: { count: runs.length },
            }
          }

          // ── prerequisites ──
          case "prerequisites": {
            // 校验指定阶段的前置 artifact 是否满足（支持 OR-group）
            if (!args.phases) {
              return { title: "Error", output: "phases parameter required", metadata: {} }
            }
            // 找到最近的 run 对应的 artifacts 目录
            const runs = engine.listRuns()
            const latestRun = runs[runs.length - 1]
            if (!latestRun) {
              return { title: "Error", output: "No workflow runs found", metadata: {} }
            }
            const artifactsDir = join(ARTIFACT_DIR, latestRun.runId)
            const targetPhases = args.phases.split(",").map((p: string) => p.trim())
            const missing = checkPrerequisites(targetPhases, artifactsDir)
            if (missing.length > 0) {
              return {
                title: "Prerequisites Missing",
                output: `Missing prerequisites for phases [${targetPhases.join(", ")}]:\n${missing.map(m => `  - ${m}`).join("\n")}`,
                metadata: { missing, phases: targetPhases },
              }
            }
            return {
              title: "Prerequisites OK",
              output: `All prerequisites satisfied for phases: ${targetPhases.join(", ")}`,
              metadata: { phases: targetPhases },
            }
          }

          default:
            throw new Error(`Unknown action: ${args.action}`)
        }
      },
    }),
  },

  // ── Hook: tool.execute.after — 大输出截断 ──
  "tool.execute.after": async (input: any, output: any) => {
    if (
      currentWorkflowContext &&
      (input.tool === "Agent" || input.tool === "Task")
    ) {
      const j = JSON.stringify(output)
      if (j?.length > 50000)
        output.__summary = `Truncated (${j.length} bytes)`
    }
  },

  // ── Hook: chat.params — 温度控制 + 工具过滤 ──
  "chat.params": async (input: any) => {
    if (!currentWorkflowContext) return input
    const result = { ...input, temperature: currentWorkflowContext.temperature }

    // 工具过滤：根据 PhaseConfig.tools[] 限制可用工具
    const phaseConfig = SQL2JAVA_WORKFLOW.phases.find(
      (p) => p.name === currentWorkflowContext.phase
    )
    if (phaseConfig?.tools) {
      const allowed = new Set(phaseConfig.tools)
      if (input.tools && Array.isArray(input.tools)) {
        result.tools = input.tools.filter((t: any) => {
          const name = typeof t === "string" ? t : t.name
          return allowed.has(name)
        })
      }
    }

    return result
  },

  // ── Hook: experimental.chat.system.transform — system prompt 构建 (D11) ──
  "experimental.chat.system.transform": async (input: any) => {
    if (!currentWorkflowContext) return input
    try {
      // 使用 __dirname（plugin/）的父目录（.opencode/）定位 agent 文件，不依赖 process.cwd()
      const agentPath = join(__dirname, "..", currentWorkflowContext.agentFile)
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
        const parts = [
          common,
          "",
          phaseSection,
          "",
          "## Runtime Context",
          runtimeContext,
        ].filter((p) => p !== "")

        return {
          ...input,
          system: parts.join("\n\n"),
        }
      } else {
        console.error(`[workflow-engine] Agent file not found: ${agentPath}. System prompt will not be injected.`)
      }
    } catch (e: any) {
      console.error(`[workflow-engine] Failed to build system prompt: ${e.message}`)
    }
    return input
  },
})
