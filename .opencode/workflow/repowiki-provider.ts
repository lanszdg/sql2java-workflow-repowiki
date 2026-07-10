import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { safeWriteFile } from "./cross-platform"
import { UnitAnalysisSchema } from "./artifact-schemas"

export type RepowikiAnalyzeProviderStatus =
  | "skipped"
  | "completed"
  | "needs_l2_fact"
  | "failed"

export interface RepowikiAnalyzeProviderOptions {
  enabled: boolean
  artifactsDir: string
  sourcePath?: string
  targetUnits: string[]
  l2Facts?: Array<Record<string, unknown>>
  repowikiRoot?: string
  l3Runner?: RepowikiL3CommandRunner
  l3Concurrency?: number
  shardIndex?: number
  env?: Record<string, string | undefined>
  now?: () => string
}

export interface RepowikiAnalyzeProviderResult {
  status: RepowikiAnalyzeProviderStatus
  writtenArtifacts: string[]
  missingFacts?: string[]
  error?: string
}

export interface RepowikiAnalyzeProviderDispatchOptions extends Omit<RepowikiAnalyzeProviderOptions, "enabled"> {
  currentPhase?: string
  runId: string
  metadata?: Record<string, unknown>
  env?: Record<string, string | undefined>
  sourcePath?: string
  l2FactsFile?: string
  prepareRunner?: RepowikiPrepareCommandRunner
}

export interface RepowikiAnalyzeProviderDispatchResponse {
  title: string
  output: string
  metadata: Record<string, unknown>
}

export interface RepowikiAnalyzeProviderDispatchResult {
  handled: boolean
  response?: RepowikiAnalyzeProviderDispatchResponse
  providerResult?: RepowikiAnalyzeProviderResult
}

export interface RepowikiPrepareCommand {
  name: string
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string | undefined>
}

export interface RepowikiPrepareCommandResult {
  status: number | null
  stdout?: string
  stderr?: string
  error?: string
}

export type RepowikiPrepareCommandRunner = (command: RepowikiPrepareCommand) => RepowikiPrepareCommandResult
export type RepowikiL3CommandRunner = (command: RepowikiPrepareCommand) => RepowikiPrepareCommandResult

export interface RepowikiPrepareStepResult extends RepowikiPrepareCommand {
  status: number | null
  stdout?: string
  stderr?: string
  error?: string
}

export interface RepowikiPrepareResult {
  status: "completed" | "failed"
  factsFile?: string
  steps: RepowikiPrepareStepResult[]
  error?: string
}

export interface RepowikiL3GenerateResult {
  status: "completed" | "failed"
  steps: RepowikiPrepareStepResult[]
  error?: string
}

interface RepowikiPrepareMarker {
  status?: string
  factsFile?: string
}

interface TargetUnit {
  unitId: string
  pkg: string
  ref: string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(__dirname, "..", "..")

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, "/")
}

function parseTargetUnit(unitId: string): TargetUnit | null {
  const text = String(unitId || "").trim()
  const dot = text.lastIndexOf(".")
  if (dot <= 0 || dot >= text.length - 1) return null
  return {
    unitId: text,
    pkg: text.slice(0, dot),
    ref: text.slice(dot + 1),
  }
}

function factPackage(fact: Record<string, unknown>): string {
  return String(fact.impl_qn || fact.package_name || fact.service_iface || "").toUpperCase()
}

function packageMatchesTarget(fact: Record<string, unknown>, targetPkg: string): boolean {
  const pkg = factPackage(fact)
  return pkg === targetPkg || (pkg === "__STANDALONE__" && targetPkg.startsWith("__STANDALONE_"))
}

function factMethodRefs(fact: Record<string, unknown>): string[] {
  const method = String(fact.method || fact.refName || "").trim()
  if (!method) return []
  const refs = new Set([method.toLowerCase()])
  const overload = fact.overload_index ?? fact.overloadIndex
  if (overload !== undefined && overload !== null && String(overload).trim()) {
    refs.add(`${method}__${String(overload).trim()}`.toLowerCase())
  }
  return [...refs]
}

function targetBaseRef(ref: string): string {
  return String(ref || "").replace(/__\d+$/i, "").toLowerCase()
}

function targetHasOverloadRef(ref: string): boolean {
  return /__\d+$/i.test(String(ref || ""))
}

function factHasOverload(fact: Record<string, unknown>): boolean {
  const overload = fact.overload_index ?? fact.overloadIndex
  return overload !== undefined && overload !== null && String(overload).trim() !== ""
}

function normalizeSignatureText(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
}

function normalizeParamType(value: unknown): string {
  return normalizeSignatureText(value).replace(/\s*\(.*/, "")
}

function normalizeParamMode(value: unknown): string {
  return normalizeSignatureText(value || "IN") || "IN"
}

function paramSignature(params: unknown[]): string[] {
  return asArray(params).map((param: any) => [
    normalizeSignatureText(param.name),
    normalizeParamMode(param.direction || param.mode || param.scope),
    normalizeParamType(param.oracle_type || param.type || param.dataType),
  ].join(":"))
}

function loadTargetSubprogram(artifactsDir: string | undefined, target: TargetUnit): any | null {
  if (!artifactsDir) return null
  const file = join(artifactsDir, "subprograms", `${target.pkg}.${target.ref}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf-8"))
  } catch {
    return null
  }
}

function findFactForTarget(
  facts: Array<Record<string, unknown>>,
  target: TargetUnit,
  artifactsDir?: string,
): Record<string, unknown> | null {
  const targetPkg = target.pkg.toUpperCase()
  const targetRef = target.ref.toLowerCase()
  const exact = facts.find((fact) => packageMatchesTarget(fact, targetPkg) && factMethodRefs(fact).includes(targetRef))
  if (exact) return exact

  const subprogram = loadTargetSubprogram(artifactsDir, target)
  if (!subprogram) return null

  const expectedParams = paramSignature(subprogram.parameters || [])
  const baseRef = targetBaseRef(target.ref)
  const candidates = facts.filter((fact) =>
    packageMatchesTarget(fact, targetPkg)
    && String(fact.method || fact.refName || "").trim().toLowerCase() === baseRef
    && !factHasOverload(fact)
  )

  return candidates.find((fact) => {
    const actualParams = paramSignature(asArray(fact.oracle_params))
    return actualParams.length === expectedParams.length
      && actualParams.every((value, index) => value === expectedParams[index])
  }) || null
}

function resolveRepowikiRuntimeRoot(
  repowikiRoot: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const roots = [
    repowikiRoot,
    env.REPOWIKI_ROOT,
    env.LINGXICODE_ROOT,
    join(pluginRoot, ".opencode", "vendor", "repowiki-runtime"),
  ].filter((x): x is string => Boolean(x && x.trim()))

  for (const root of roots) {
    const resolved = resolve(root)
    const scripts = repowikiRuntimeScripts(resolved)
    const prepareScripts = [scripts.plsqlL1, scripts.listServices, scripts.l2, scripts.mergeKnowledge]
    if (prepareScripts.every((file) => existsSync(file))) return resolved
  }

  throw new Error("Repowiki runtime unavailable. Expected bundled .opencode/vendor/repowiki-runtime, or set repowikiRoot/REPOWIKI_ROOT/LINGXICODE_ROOT.")
}

function repowikiRuntimeScripts(root: string) {
  const direct = {
    plsqlL1: join(root, "lib", "plsql-l1-producer.cjs"),
    listServices: join(root, "list-services.cjs"),
    l2: join(root, "repowiki-l2.cjs"),
    mergeKnowledge: join(root, "merge-knowledge.cjs"),
    l3Scheduler: join(root, "repowiki-l3-scheduler.cjs"),
    l3Dispatcher: join(root, "repowiki-l3-dispatcher.cjs"),
  }
  if ([direct.plsqlL1, direct.listServices, direct.l2, direct.mergeKnowledge].every((file) => existsSync(file))) return direct

  const base = join(root, "config", "skills", "repowiki")
  return {
    plsqlL1: join(base, "lib", "plsql-l1-producer.cjs"),
    listServices: join(base, "list-services.cjs"),
    l2: join(base, "repowiki-l2.cjs"),
    mergeKnowledge: join(base, "merge-knowledge.cjs"),
    l3Scheduler: join(base, "repowiki-l3-scheduler.cjs"),
    l3Dispatcher: join(base, "repowiki-l3-dispatcher.cjs"),
  }
}

function isNodeExecutableName(value: string): boolean {
  const text = String(value || "").trim()
  return /^node(?:\.exe)?$/i.test(text) || /[\\/]node(?:\.exe)?$/i.test(text)
}

function resolveRepowikiNodePath(
  root: string,
  env: Record<string, string | undefined>,
  explicitNodePath?: string,
): string {
  const candidates = [
    explicitNodePath,
    env.REPOWIKI_NODE_PATH,
    env.NODE_EXE,
    env.NODE_BINARY,
    join(root, "config", "bin", "codegraph", "node.exe"),
    join(root, "config", "bin", "codegraph", "node"),
    isNodeExecutableName(process.execPath) ? process.execPath : undefined,
    "node",
  ].filter((x): x is string => Boolean(x && String(x).trim()))

  for (const candidate of candidates) {
    const text = candidate.trim()
    if (/^node(?:\.exe)?$/i.test(text)) return text
    const resolved = resolve(text)
    if (existsSync(resolved)) return resolved
  }

  throw new Error("Node runtime unavailable. Set REPOWIKI_NODE_PATH or use a Lingxi root with config/bin/codegraph/node.exe.")
}

function truncateTail(value: unknown, limit = 4000): string {
  const text = String(value ?? "")
  return text.length <= limit ? text : text.slice(text.length - limit)
}

function repowikiWorkflowWorkDir(artifactsDir: string): string {
  return join(resolve(artifactsDir), "repowiki-work")
}

function withRepowikiWorkflowEnv(
  env: Record<string, string | undefined>,
  artifactsDir: string,
  sourcePath?: string,
): Record<string, string | undefined> {
  const next = {
    ...env,
    REPOWIKI_WORK_DIR: env.REPOWIKI_WORK_DIR || repowikiWorkflowWorkDir(artifactsDir),
  }
  if (sourcePath) next.REPOWIKI_SOURCE_ROOT = resolve(sourcePath)
  return next
}

function repowikiWorkDir(sourcePath: string, env: Record<string, string | undefined>): string {
  return resolve(env.REPOWIKI_WORK_DIR || join(resolve(sourcePath), ".repowiki"))
}

function publicStepRecord(step: RepowikiPrepareCommand, result: RepowikiPrepareCommandResult): RepowikiPrepareStepResult {
  const { env: _env, ...publicStep } = step
  return {
    ...publicStep,
    status: result.status,
    stdout: truncateTail(result.stdout),
    stderr: truncateTail(result.stderr),
    error: result.error,
  }
}

function defaultPrepareRunner(step: RepowikiPrepareCommand): RepowikiPrepareCommandResult {
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    env: step.env ? mergedProcessEnv(step.env) : undefined,
  })
  return {
    status: result.status,
    stdout: truncateTail(result.stdout),
    stderr: truncateTail(result.stderr),
    error: result.error?.message,
  }
}

function mergedProcessEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function toLine(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function describeTableFact(row: any): string {
  const operation = row.operation || row.op || "SQL"
  const table = row.table || row.tableName || row.name || "UNKNOWN_TABLE"
  return `${operation} ${table}`
}

function toSubprogram(fact: Record<string, unknown>, target: TargetUnit) {
  const params = asArray(fact.oracle_params).map((param) => ({
    name: String(param.name || ""),
    type: String(param.oracle_type || param.type || ""),
    scope: String(param.direction || param.mode || "IN"),
  }))

  const tableBlocks = asArray(fact.table_facts).map((row) => ({
    type: "sql",
    oracleLine: toLine(row.line || row.oracleLine),
    description: describeTableFact(row),
    dependencies: [String(row.table || row.tableName || row.name || "")].filter(Boolean),
  }))

  const flowBlocks = asArray(fact.control_flow).map((row) => ({
    type: String(row.type || "control-flow"),
    oracleLine: toLine(row.line || row.oracleLine),
    description: String(row.description || row.condition || row.label || row.type || "control flow"),
    dependencies: asArray(row.dependencies).map(String),
  }))

  const exceptionHandlers = asArray(fact.exception_handlers).map((row) => ({
    name: String(row.name || row.exception || "OTHERS"),
    actions: asArray(row.actions).map(String),
  }))

  const syntaxNotes = asArray(fact.special_syntax).map((row) => `special syntax: ${row.type || row.kind || row.id || "unknown"}`)
  const callNotes = asArray(fact.cross_package_calls).map((row) => `call: ${row.target_package || row.to_service || ""}.${row.target_member || row.to_method || ""}`)
  const tableNotes = asArray(fact.table_facts).map((row) => `table: ${describeTableFact(row)}`)
  const providerNotes = asArray(fact.provider_notes).map(String)

  return {
    name: String(fact.method || target.ref),
    blocks: [...tableBlocks, ...flowBlocks],
    variables: params,
    cursors: [],
    exceptionHandlers,
    translationNotes: [...tableNotes, ...callNotes, ...syntaxNotes, ...providerNotes],
  }
}

function writeJson(file: string, value: unknown): void {
  safeWriteFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function cleanPathPart(value: unknown): string {
  return String(value || "").trim()
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function fsdCandidateRels(target: TargetUnit, fact: Record<string, unknown>, desiredRel: string): string[] {
  const factPkg = factPackage(fact)
  const method = cleanPathPart(fact.method || fact.refName)
  const dirs = unique([
    target.pkg,
    factPkg,
    cleanPathPart(fact.package_name),
    cleanPathPart(fact.impl_qn),
  ])
  const names = unique([
    target.ref,
    target.ref.toLowerCase(),
    method,
    method.toLowerCase(),
  ])

  return unique([
    desiredRel,
    ...dirs.flatMap((dir) => names.map((name) => normalizeSlash(join("fsd", dir, `${name}.md`)))),
  ])
}

function publishFsdDoc(artifactsDir: string, target: TargetUnit, fact: Record<string, unknown>, desiredRel: string): void {
  const desiredFile = join(artifactsDir, desiredRel)
  if (existsSync(desiredFile)) return

  for (const rel of fsdCandidateRels(target, fact, desiredRel)) {
    const file = join(artifactsDir, rel)
    if (!existsSync(file)) continue
    safeWriteFile(desiredFile, readFileSync(file, "utf-8"))
    return
  }

  throw new Error(`Repowiki L3 FSD output not found for ${target.unitId}; expected ${desiredRel}`)
}

function repowikiPrepareStatusFile(artifactsDir: string): string {
  return join(artifactsDir, "status", "repowiki-prepare.json")
}

function readReusablePreparedFactsFile(artifactsDir: string): string | undefined {
  const file = repowikiPrepareStatusFile(artifactsDir)
  if (!existsSync(file)) return undefined
  try {
    const marker = JSON.parse(readFileSync(file, "utf-8")) as RepowikiPrepareMarker
    const factsFile = marker.status === "completed" && marker.factsFile ? resolve(marker.factsFile) : ""
    return factsFile && existsSync(factsFile) ? factsFile : undefined
  } catch {
    return undefined
  }
}

function writePrepareStatus(options: {
  artifactsDir: string
  result: RepowikiPrepareResult
  startedAt: string
  completedAt: string
}): void {
  writeJson(repowikiPrepareStatusFile(options.artifactsDir), {
    phase: "repowiki-prepare",
    status: options.result.status,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    factsFile: options.result.factsFile,
    steps: options.result.steps,
    error: options.result.error,
  })
}

function ensureRepowikiPreparedForRun(options: {
  artifactsDir: string
  sourcePath: string
  repowikiRoot?: string
  profile?: string
  env: Record<string, string | undefined>
  runner?: RepowikiPrepareCommandRunner
  now?: () => string
}): RepowikiPrepareResult {
  const existingFactsFile = readReusablePreparedFactsFile(options.artifactsDir)
  if (existingFactsFile) {
    return { status: "completed", factsFile: existingFactsFile, steps: [] }
  }

  const now = options.now || (() => new Date().toISOString())
  const startedAt = now()
  const env = withRepowikiWorkflowEnv(options.env, options.artifactsDir, options.sourcePath)
  const result = runRepowikiL1L2Prepare({
    sourcePath: options.sourcePath,
    repowikiRoot: options.repowikiRoot,
    profile: options.profile,
    env,
    runner: options.runner,
  })
  writePrepareStatus({
    artifactsDir: options.artifactsDir,
    result,
    startedAt,
    completedAt: now(),
  })
  return result
}

function repowikiL3StatusFile(artifactsDir: string): string {
  return join(artifactsDir, "status", "repowiki-l3.json")
}

function readReusableL3Status(artifactsDir: string): boolean {
  const file = repowikiL3StatusFile(artifactsDir)
  if (!existsSync(file)) return false
  try {
    const marker = JSON.parse(readFileSync(file, "utf-8"))
    return marker && marker.status === "completed"
  } catch {
    return false
  }
}

function writeL3Status(options: {
  artifactsDir: string
  result: RepowikiL3GenerateResult
  startedAt: string
  completedAt: string
}): void {
  writeJson(repowikiL3StatusFile(options.artifactsDir), {
    phase: "repowiki-l3",
    status: options.result.status,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    steps: options.result.steps,
    error: options.result.error,
  })
}

function l3ChildEnv(
  env: Record<string, string | undefined>,
  artifactsDir: string,
  sourcePath: string,
): Record<string, string | undefined> {
  return {
    ...env,
    REPOWIKI_WORK_DIR: env.REPOWIKI_WORK_DIR || repowikiWorkflowWorkDir(artifactsDir),
    REPOWIKI_SOURCE_ROOT: env.REPOWIKI_SOURCE_ROOT || resolve(sourcePath),
    REPOWIKI_WORKFLOW_ARTIFACTS_DIR: env.REPOWIKI_WORKFLOW_ARTIFACTS_DIR || artifactsDir,
    REPOWIKI_L3_DOCS_ROOT: artifactsDir,
    REPOWIKI_FSD_GATE_MODE: env.REPOWIKI_FSD_GATE_MODE || "soft",
    REPOWIKI_L3_SOFT_L2_COMPLETENESS: env.REPOWIKI_L3_SOFT_L2_COMPLETENESS || "1",
  }
}

function resolveExistingRunner(candidate: string): string {
  const file = candidate.trim() ? resolve(candidate) : ""
  return file && existsSync(file) ? file : ""
}

function resolveL3WorkerRunner(env: Record<string, string | undefined>): string {
  const explicit = String(env.REPOWIKI_L3_RUNNER || env.REPOWIKI_L3_RUNNER_PATH || "").trim()
  if (explicit) return resolve(explicit)

  const runnerName = process.platform === "win32" ? "lingxicode.bat" : "lingxicode"
  const sql2javaHome = String(env.SQL2JAVA_HOME || "").trim()
  if (sql2javaHome) {
    const runner = resolveExistingRunner(join(sql2javaHome, runnerName))
    if (runner) return runner
  }

  const localRunner = resolveExistingRunner(join(pluginRoot, runnerName))
  if (localRunner) return localRunner

  const lingxiRoot = String(env.LINGXICODE_ROOT || "").trim()
  if (lingxiRoot) {
    const opencode = resolveExistingRunner(join(lingxiRoot, "bin", process.platform === "win32" ? "opencode.exe" : "opencode"))
    if (opencode) return opencode
  }

  return ""
}

export function runRepowikiL3Generate(options: {
  sourcePath: string
  artifactsDir: string
  repowikiRoot?: string
  env?: Record<string, string | undefined>
  runner?: RepowikiL3CommandRunner
  nodePath?: string
  concurrency?: number
}): RepowikiL3GenerateResult {
  const steps: RepowikiPrepareStepResult[] = []
  try {
    const sourcePath = resolve(options.sourcePath)
    const artifactsDir = resolve(options.artifactsDir)
    const env = options.env ?? process.env
    const root = resolveRepowikiRuntimeRoot(options.repowikiRoot, env)
    const scripts = repowikiRuntimeScripts(root)
    if (!existsSync(scripts.l3Scheduler) || !existsSync(scripts.l3Dispatcher)) {
      throw new Error("Repowiki L3 runtime unavailable. Expected repowiki-l3-scheduler.cjs and repowiki-l3-dispatcher.cjs.")
    }
    const nodePath = resolveRepowikiNodePath(root, env, options.nodePath)
    const runner = options.runner || defaultPrepareRunner
    const childEnv = l3ChildEnv(env, artifactsDir, sourcePath)
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency || childEnv.REPOWIKI_L3_CONCURRENCY || 8)))
    const l3WorkerRunner = resolveL3WorkerRunner(childEnv)
    const l3DispatcherArgs = [scripts.l3Dispatcher, sourcePath]
    if (l3WorkerRunner) l3DispatcherArgs.push("--runner", l3WorkerRunner)
    const plan: RepowikiPrepareCommand[] = [
      {
        name: "l3-scheduler",
        command: nodePath,
        args: [scripts.l3Scheduler, sourcePath, "--l3-skill", "wiki-l3-oracle-sp", "--concurrency", String(concurrency)],
        cwd: sourcePath,
        env: childEnv,
      },
      {
        name: "l3-dispatcher",
        command: nodePath,
        args: l3DispatcherArgs,
        cwd: sourcePath,
        env: childEnv,
      },
    ]

    for (const step of plan) {
      const result = runner(step)
      steps.push(publicStepRecord(step, result))
      if (result.error || result.status !== 0) {
        const detail = result.stderr || result.stdout || result.error || "no output"
        return {
          status: "failed",
          steps,
          error: `${step.name} failed with status ${result.status}: ${truncateTail(detail, 1200)}`,
        }
      }
    }

    return { status: "completed", steps }
  } catch (e: any) {
    return { status: "failed", steps, error: e?.message || String(e) }
  }
}

function ensureRepowikiL3GeneratedForRun(options: {
  artifactsDir: string
  sourcePath: string
  repowikiRoot?: string
  env: Record<string, string | undefined>
  runner?: RepowikiL3CommandRunner
  now?: () => string
  concurrency?: number
}): RepowikiL3GenerateResult {
  if (readReusableL3Status(options.artifactsDir)) {
    return { status: "completed", steps: [] }
  }

  const now = options.now || (() => new Date().toISOString())
  const startedAt = now()
  const result = runRepowikiL3Generate({
    sourcePath: options.sourcePath,
    artifactsDir: options.artifactsDir,
    repowikiRoot: options.repowikiRoot,
    env: options.env,
    runner: options.runner,
    concurrency: options.concurrency,
  })
  writeL3Status({
    artifactsDir: options.artifactsDir,
    result,
    startedAt,
    completedAt: now(),
  })
  return result
}

function statusJson(shardIndex: number | undefined, artifacts: string[], now: () => string) {
  return {
    phase: "analyze",
    shardIndex: shardIndex ?? 0,
    status: "completed",
    startedAt: now(),
    completedAt: now(),
    artifacts,
  }
}

function truthy(value: unknown): boolean {
  if (value === true) return true
  const text = String(value ?? "").trim().toLowerCase()
  return text === "1" || text === "true" || text === "yes" || text === "on"
}

export function isRepowikiAnalyzeProviderEnabled(
  metadata: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return truthy(metadata?.repowikiAnalyzeProvider)
    || truthy(metadata?.repowikiProvider)
    || truthy(env.REPOWIKI_ANALYZE_PROVIDER)
}

export function isRepowikiAutoPrepareEnabled(
  metadata: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return truthy(metadata?.repowikiAutoPrepare)
    || truthy(metadata?.repowikiAutoPrepareFacts)
    || truthy(env.REPOWIKI_AUTO_PREPARE)
}

export function runRepowikiL1L2Prepare(options: {
  sourcePath: string
  repowikiRoot?: string
  profile?: string
  env?: Record<string, string | undefined>
  runner?: RepowikiPrepareCommandRunner
  nodePath?: string
}): RepowikiPrepareResult {
  const steps: RepowikiPrepareStepResult[] = []
  try {
    const sourcePath = resolve(options.sourcePath)
    const env = options.env ?? process.env
    const root = resolveRepowikiRuntimeRoot(options.repowikiRoot, env)
    const profile = options.profile || env.REPOWIKI_PROFILE || "oracle-sp"
    const scripts = repowikiRuntimeScripts(root)
    const nodePath = resolveRepowikiNodePath(root, env, options.nodePath)
    const workDir = repowikiWorkDir(sourcePath, env)
    const childEnv = {
      ...env,
      REPOWIKI_WORK_DIR: workDir,
      REPOWIKI_SOURCE_ROOT: env.REPOWIKI_SOURCE_ROOT || sourcePath,
    }
    const knowledgeDir = join(workDir, "knowledge")
    const factsFile = join(knowledgeDir, "functions.json")
    const forceRefresh = String(env.REPOWIKI_AUTO_PREPARE_FORCE ?? "1").trim().toLowerCase() !== "0"
      && String(env.REPOWIKI_AUTO_PREPARE_FORCE ?? "1").trim().toLowerCase() !== "false"
    if (forceRefresh) {
      rmSync(join(knowledgeDir, "parts"), { recursive: true, force: true })
      rmSync(factsFile, { force: true })
    }
    const runner = options.runner || defaultPrepareRunner
    const plan: RepowikiPrepareCommand[] = [
      { name: "plsql-l1", command: nodePath, args: [scripts.plsqlL1, sourcePath], cwd: sourcePath, env: childEnv },
      { name: "list-services", command: nodePath, args: [scripts.listServices, sourcePath, "--profile", profile], cwd: sourcePath, env: childEnv },
      { name: "repowiki-l2", command: nodePath, args: [scripts.l2, sourcePath, "--all", "--profile", profile], cwd: sourcePath, env: childEnv },
      { name: "merge-knowledge", command: nodePath, args: [scripts.mergeKnowledge, knowledgeDir], cwd: sourcePath, env: childEnv },
    ]

    for (const step of plan) {
      const result = runner(step)
      steps.push(publicStepRecord(step, result))
      if (result.error || result.status !== 0) {
        const detail = result.stderr || result.stdout || result.error || "no output"
        return {
          status: "failed",
          steps,
          error: `${step.name} failed with status ${result.status}: ${truncateTail(detail, 1200)}`,
        }
      }
    }

    if (!existsSync(factsFile)) {
      return {
        status: "failed",
        steps,
        error: `Repowiki prepare finished but functions.json was not created: ${factsFile}`,
      }
    }

    return { status: "completed", factsFile, steps }
  } catch (e: any) {
    return { status: "failed", steps, error: e?.message || String(e) }
  }
}

export function resolveRepowikiL2FactsFile(options: {
  metadata?: Record<string, unknown>
  env?: Record<string, string | undefined>
  sourcePath?: string
  l2FactsFile?: string
}): string | undefined {
  const explicit = options.l2FactsFile
    || String(options.metadata?.repowikiL2FactsFile || "").trim()
    || String(options.env?.REPOWIKI_L2_FACTS_FILE || "").trim()
  if (explicit) return resolve(explicit)
  if (options.env?.REPOWIKI_WORK_DIR) return join(resolve(options.env.REPOWIKI_WORK_DIR), "knowledge", "functions.json")
  if (options.sourcePath) return join(resolve(options.sourcePath), ".repowiki", "knowledge", "functions.json")
  return undefined
}

function factsFromDocument(doc: any): Array<Record<string, unknown>> {
  if (Array.isArray(doc)) return doc as Array<Record<string, unknown>>
  if (Array.isArray(doc?.functions)) return doc.functions as Array<Record<string, unknown>>
  if (Array.isArray(doc?.data?.functions)) return doc.data.functions as Array<Record<string, unknown>>
  return []
}

export function loadRepowikiL2FactsFile(file: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(readFileSync(file, "utf-8"))
  return factsFromDocument(parsed)
}

function providerDispatchResponse(
  runId: string,
  result: RepowikiAnalyzeProviderResult,
): RepowikiAnalyzeProviderDispatchResponse {
  if (result.status === "completed") {
    return {
      title: "Repowiki Analyze Provider",
      output: [
        "✅ Repowiki Analyze Provider 已写入当前 analyze 分片产物。",
        `- artifacts: ${result.writtenArtifacts.join(", ")}`,
        `下一步：调用 workflow({ action: "advance", runId: "${runId}" })。`,
      ].join("\n"),
      metadata: {
        runId,
        phase: "analyze",
        repowikiProvider: true,
        status: result.status,
        artifacts: result.writtenArtifacts,
        dispatch: false,
        nextAction: "advance",
      },
    }
  }

  if (result.status === "needs_l2_fact") {
    return {
      title: "Repowiki Analyze Provider needs L2 facts",
      output: [
        "⚠️ Repowiki Analyze Provider 未找到当前分片对应的 L2 fact，未写空文档。",
        `- missingFacts: ${(result.missingFacts || []).join(", ") || "unknown"}`,
        "下一步：先补齐 Repowiki L2 facts，再重新 dispatch 当前 analyze 分片。",
      ].join("\n"),
      metadata: {
        runId,
        phase: "analyze",
        repowikiProvider: true,
        status: result.status,
        missingFacts: result.missingFacts || [],
        dispatch: false,
        nextAction: "prepare_l2",
      },
    }
  }

  return {
    title: "Repowiki Analyze Provider failed",
    output: [
      "❌ Repowiki Analyze Provider 执行失败，未派发原 analyze worker。",
      `- error: ${result.error || "unknown"}`,
    ].join("\n"),
    metadata: {
      runId,
      phase: "analyze",
      repowikiProvider: true,
      status: result.status,
      error: result.error,
      dispatch: false,
      nextAction: "repair_provider",
    },
  }
}

function repowikiProfile(metadata: Record<string, unknown> | undefined, env: Record<string, string | undefined>): string {
  return String(metadata?.repowikiProfile || env.REPOWIKI_PROFILE || "oracle-sp").trim() || "oracle-sp"
}

export function runRepowikiAnalyzeProvider(options: RepowikiAnalyzeProviderOptions): RepowikiAnalyzeProviderResult {
  if (!options.enabled) {
    return { status: "skipped", writtenArtifacts: [] }
  }

  const env = options.env ?? process.env
  const targets = options.targetUnits.map(parseTargetUnit).filter((x): x is TargetUnit => Boolean(x))
  const facts = options.l2Facts || []
  const pairs = targets.map((target) => ({
    target,
    fact: findFactForTarget(facts, target, options.artifactsDir),
  }))
  const missingFacts = pairs.filter((row) => !row.fact).map((row) => row.target.unitId)
  if (missingFacts.length) {
    return { status: "needs_l2_fact", writtenArtifacts: [], missingFacts }
  }
  if (!options.sourcePath) {
    return {
      status: "failed",
      writtenArtifacts: [],
      error: "Repowiki L3 requires sourcePath so wiki-l3-oracle-sp can read .repowiki knowledge and write FSD.",
    }
  }

  try {
    const l3 = ensureRepowikiL3GeneratedForRun({
      artifactsDir: options.artifactsDir,
      sourcePath: options.sourcePath,
      repowikiRoot: options.repowikiRoot,
      env,
      runner: options.l3Runner,
      now: options.now,
      concurrency: options.l3Concurrency,
    })
    if (l3.status !== "completed") {
      return {
        status: "failed",
        writtenArtifacts: [],
        error: l3.error || "Repowiki L3 generation failed.",
      }
    }

    const writtenArtifacts: string[] = []

    for (const row of pairs) {
      const target = row.target
      const fact = row.fact!
      const unitRel = normalizeSlash(join("analysis-packages", target.pkg, `${target.ref}.json`))
      const fsdRel = normalizeSlash(join("fsd", target.pkg, `${target.ref}.md`))
      const unit = {
        unitRefName: target.ref,
        packageName: target.pkg,
        subprograms: [toSubprogram(fact, target)],
      }
      const parsedUnit = UnitAnalysisSchema.parse(unit)

      writeJson(join(options.artifactsDir, unitRel), parsedUnit)
      publishFsdDoc(options.artifactsDir, target, fact, fsdRel)
      writtenArtifacts.push(unitRel, fsdRel)
    }

    writeJson(join(options.artifactsDir, "status", "analyze.json"), statusJson(options.shardIndex, writtenArtifacts, options.now || (() => new Date().toISOString())))
    return { status: "completed", writtenArtifacts }
  } catch (e: any) {
    return { status: "failed", writtenArtifacts: [], error: e?.message || String(e) }
  }
}

export function runRepowikiAnalyzeProviderForDispatch(
  options: RepowikiAnalyzeProviderDispatchOptions,
): RepowikiAnalyzeProviderDispatchResult {
  const env = options.env ?? process.env
  let providerEnv = env
  if (options.currentPhase !== "analyze" || !isRepowikiAnalyzeProviderEnabled(options.metadata, env)) {
    return { handled: false }
  }

  const targetUnits = options.targetUnits || []
  if (targetUnits.length === 0) {
    return { handled: false }
  }

  let l2Facts = options.l2Facts
  let factsFile: string | undefined
  if (!l2Facts && isRepowikiAutoPrepareEnabled(options.metadata, env) && options.sourcePath) {
    providerEnv = withRepowikiWorkflowEnv(env, options.artifactsDir, options.sourcePath)
    const prepare = ensureRepowikiPreparedForRun({
      artifactsDir: options.artifactsDir,
      sourcePath: options.sourcePath,
      repowikiRoot: options.repowikiRoot || String(options.metadata?.repowikiRoot || "").trim() || undefined,
      profile: repowikiProfile(options.metadata, env),
      env: providerEnv,
      runner: options.prepareRunner,
      now: options.now,
    })
    if (prepare.status !== "completed" || !prepare.factsFile) {
      const providerResult: RepowikiAnalyzeProviderResult = {
        status: "failed",
        writtenArtifacts: [],
        error: prepare.error || "Repowiki autoPrepare failed.",
      }
      return {
        handled: true,
        providerResult,
        response: providerDispatchResponse(options.runId, providerResult),
      }
    }
    factsFile = prepare.factsFile
  }

  if (!l2Facts) {
    factsFile = factsFile || resolveRepowikiL2FactsFile({
      metadata: options.metadata,
      env: providerEnv,
      sourcePath: options.sourcePath,
      l2FactsFile: options.l2FactsFile,
    })
    try {
      l2Facts = factsFile && existsSync(factsFile) ? loadRepowikiL2FactsFile(factsFile) : []
    } catch (e: any) {
      const providerResult: RepowikiAnalyzeProviderResult = {
        status: "failed",
        writtenArtifacts: [],
        error: `Failed to load Repowiki L2 facts${factsFile ? ` from ${factsFile}` : ""}: ${e?.message || String(e)}`,
      }
      return {
        handled: true,
        providerResult,
        response: providerDispatchResponse(options.runId, providerResult),
      }
    }
  }

  let providerResult = runRepowikiAnalyzeProvider({
    enabled: true,
    artifactsDir: options.artifactsDir,
    sourcePath: options.sourcePath,
    targetUnits,
    l2Facts,
    repowikiRoot: options.repowikiRoot,
    l3Runner: options.l3Runner,
    l3Concurrency: options.l3Concurrency,
    shardIndex: options.shardIndex,
    env: providerEnv,
    now: options.now,
  })

  return {
    handled: true,
    providerResult,
    response: providerDispatchResponse(options.runId, providerResult),
  }
}
