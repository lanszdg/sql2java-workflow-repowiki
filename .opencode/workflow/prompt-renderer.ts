/**
 * prompt-renderer.ts — worker 任务提示词模板渲染器
 *
 * 把 analyze/translate 的 worker 任务从「编排者 LLM 即兴拼凑」改为「.md 模板 + 引擎填变量」：
 * 模板（.opencode/workflow/prompts/{phase}-worker.md）是可 review 的静态骨架，引擎用本分片数据
 * 填充 {{占位符}}（含动态块：scopeBanner / 切片读取清单 / 依赖签名 / upstream / schemaHint /
 * rejectionError）。渲染产物 = workOrder，既落盘可追溯（dispatch-logs/），又注入 worker 系统提示
 * 作权威任务（确定性，不依赖编排者透传）。
 *
 * 占位符语法：{{key}}；未提供的 key 替换为空串；渲染后折叠 3+ 连续空行为 2 行（清理空 section）。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts")

/** 静态 subtask 触发器（analyze/translate 分片用）。读一次缓存——非运行时拼接，可 review。 */
let _subtaskTriggerCache: string | null = null
export function getSubtaskTriggerPrompt(): string {
  if (_subtaskTriggerCache !== null) return _subtaskTriggerCache
  const p = join(TEMPLATES_DIR, "subtask-trigger.md")
  _subtaskTriggerCache = existsSync(p) ? readFileSync(p, "utf-8").trim() : ""
  return _subtaskTriggerCache
}

/** worker 任务上下文 —— 全部字符串（动态块由调用方预渲染后传入，渲染器只做占位符替换）。 */
export type WorkerPromptCtx = Record<string, string>

/**
 * 渲染 worker 任务模板。
 * @param phase "analyze" | "translate"（其他阶段无模板，抛错）
 * @param ctx   占位符 → 值（含动态块字符串）
 * @returns 渲染后的 workOrder 文本
 */
export function renderWorkerPrompt(phase: string, ctx: WorkerPromptCtx): string {
  const tplPath = join(TEMPLATES_DIR, `${phase}-worker.md`)
  if (!existsSync(tplPath)) {
    throw new Error(`worker prompt template not found: ${tplPath}（phase=${phase}）`)
  }
  let out = readFileSync(tplPath, "utf-8")
  // 占位符替换（未提供 → 空串）
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => ctx[key] ?? "")
  // 折叠 3+ 连续换行为 2 个（清理空 section 留下的多余空行）
  out = out.replace(/\n{3,}/g, "\n\n")
  // 去除行尾空白
  out = out.replace(/[ \t]+\n/g, "\n")
  return out.trim() + "\n"
}

/** 持久化 workOrder 文件名（按分片区分，便于追溯每次 dispatch 的精确 prompt）。 */
export function workOrderFileName(phase: string, shardIndex: number | undefined): string {
  return shardIndex !== undefined
    ? `${phase}-shard${shardIndex}.workOrder.md`
    : `${phase}.workOrder.md`
}

/**
 * 落盘 workOrder 到 artifactsDir/dispatch-logs/，供审计追溯 + system.transform 读取注入。
 * 失败不阻断 dispatch（warn 由调用方处理）。
 */
export function persistWorkOrder(
  artifactsDir: string,
  phase: string,
  shardIndex: number | undefined,
  content: string,
): void {
  const dir = join(artifactsDir, "dispatch-logs")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, workOrderFileName(phase, shardIndex)), content, "utf-8")
}

/** 读取已持久化的 workOrder（system.transform 注入用）。缺失返回 null。 */
export function readPersistedWorkOrder(
  artifactsDir: string,
  phase: string,
  shardIndex: number | undefined,
): string | null {
  const p = join(artifactsDir, "dispatch-logs", workOrderFileName(phase, shardIndex))
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, "utf-8")
  } catch {
    return null
  }
}
