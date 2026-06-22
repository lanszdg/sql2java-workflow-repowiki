/**
 * harness/run-test.ts — 执行点测试执行器
 *
 * runExecutionPoint：预置 run → opencode run "/sql2java resume"（真实 agent）→ 解析该 phase 产出
 * artifact + 生成的源码 → 返回 CaseContext。
 *
 * 触发契约（标准化）：统一走 "/sql2java resume" 复用预置 run（见 workspace.ts 说明）。
 * runId 固定为 RUN_ID，故产出落在 <workDir>/.workflow-artifacts/<RUN_ID>/，直接解析该目录。
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type { CaseContext, PhaseName } from "./types"
import { prepareExecutionPoint, RUN_ID, type PrepareOptions } from "./workspace"

const ARTIFACT_DIR = ".workflow-artifacts"
/** 解析 artifact 时跳过的辅助目录（非 phase 产出） */
const SKIP_DIRS = new Set(["logs", "metrics", "reports"])

export interface RunExecutionPointOptions {
  workDir: string
  phase: PhaseName
  sourcePath?: string
  prepareArtifacts?: PrepareOptions["prepareArtifacts"]
  staticArtifactsDir?: string
  prepareFixture?: PrepareOptions["prepareFixture"]
  staticFixtureDir?: string
  /** 触发命令，默认 "/sql2java resume" */
  trigger?: string
  timeout?: number
}

export interface RunExecutionPointResult {
  ctx: CaseContext
  durationMs: number
}

/**
 * 执行一个执行点测试：预置 → 真实 agent 续跑 → 解析产出。
 * 失败（超时/opencode 不可用）时仍返回已收集的 ctx，由上层断言/报告决定结论。
 */
export async function runExecutionPoint(opts: RunExecutionPointOptions): Promise<RunExecutionPointResult> {
  const { phase, trigger = "/sql2java resume", timeout = 600_000 } = opts

  // 1. 预置 run + artifact + fixture（真实 engine-core 推进，不调 opencode）
  const prepared = prepareExecutionPoint({
    workDir: opts.workDir,
    phase,
    sourcePath: opts.sourcePath,
    prepareArtifacts: opts.prepareArtifacts,
    staticArtifactsDir: opts.staticArtifactsDir,
    prepareFixture: opts.prepareFixture,
    staticFixtureDir: opts.staticFixtureDir,
  })

  // 2. opencode run 触发真实 agent（cwd=workDir）
  const startMs = Date.now()
  let stdout = ""
  try {
    const cmd = `opencode run "${trigger.replace(/"/g, '\\"')}"`
    stdout = execSync(cmd, {
      cwd: prepared.workDir,
      timeout,
      encoding: "utf-8",
      // NOTE: 曾注入 SQL2JAVA_TEST_MODE=1 意图让 .opencode 降级 verify 的 mvn，但 .opencode
      // 全仓未读取该变量（设计 §7.2/§11.3：等 verify 执行点遇真实阻断再接线）。删掉避免给人
      // 「verify 已降级」的错觉；需要时在 .opencode 接线后在此恢复注入（execSync 默认继承 process.env）。
    })
  } catch (e: any) {
    // opencode 可能非零退出（如 review failed / completed_with_issues），stdout 仍有价值
    stdout = e.stdout ?? ""
    if (e.killed) {
      // 超时：返回空 ctx，由断言失败体现
      return {
        ctx: emptyContext(prepared.workDir),
        durationMs: Date.now() - startMs,
      }
    }
    // 其他非零退出：继续解析产出（agent 可能已写出 artifact）
  }

  const durationMs = Date.now() - startMs

  // 3. 解析该 run 的产出 artifact（递归，含 translations/<pkg>/*.json）
  const artifacts = parseArtifacts(prepared.artifactsDir)

  // 4. 收集生成的源码（glob *.java，排除 .workflow-artifacts）
  const generatedFiles = collectGeneratedFiles(prepared.workDir)

  return {
    ctx: { artifacts, generatedFiles, stdout, workDir: prepared.workDir, runId: prepared.runId },
    durationMs,
  }
}

/** 递归解析 run artifact 目录下所有 .json（键 = 相对 run 目录的路径），跳过辅助目录 */
export function parseArtifacts(artifactsDir: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!existsSync(artifactsDir)) return result
  walkJson(artifactsDir, artifactsDir, result)
  return result
}

function walkJson(rootDir: string, currentDir: string, result: Record<string, unknown>): void {
  let entries
  try {
    entries = readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkJson(rootDir, join(currentDir, entry.name), result)
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const rel = relative(rootDir, join(currentDir, entry.name)).split("\\").join("/")
      try {
        result[rel] = JSON.parse(readFileSync(join(currentDir, entry.name), "utf-8"))
      } catch {
        // 解析失败跳过
      }
    }
  }
}

/** 收集 workDir 下所有 *.java（键 = 相对 workDir 路径），排除 .workflow-artifacts */
export function collectGeneratedFiles(workDir: string): Record<string, string> {
  const result: Record<string, string> = {}
  const absWorkDir = resolve(workDir)
  if (!existsSync(absWorkDir)) return result
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === ARTIFACT_DIR || entry.name === "node_modules") continue
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        const rel = relative(absWorkDir, full).split("\\").join("/")
        try {
          result[rel] = readFileSync(full, "utf-8")
        } catch {
          // 读取失败跳过
        }
      }
    }
  }
  walk(absWorkDir)
  return result
}

function emptyContext(workDir: string): CaseContext {
  return { artifacts: {}, generatedFiles: {}, stdout: "", workDir, runId: RUN_ID }
}
