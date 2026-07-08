/**
 * inventory worker 池 —— persistent bun Worker 池，按包分区并行解析 file-set。
 *
 * smoke test 实测（scripts/smoke-bun-worker.ts）：4 worker 3.96x、8 worker 7.66x 近线性加速；
 * parse 建 ATN 树占 92-98%，CPU-bound，无共享状态竞争。ATN 冷启动 ~4.3s/worker（首次
 * new PlSqlParser() 懒构建），persistent 池每 worker 只付一次。
 *
 * **串行 fallback**：Worker 全局不可用（非 bun 运行时）/ spawn 失败 / 池运行中崩溃
 * → 退回主线程串行 scanFileSet，行为 100% 等价，零回归。测试环境（vitest/node）走此路径。
 *
 * 结果按 file-set 提交序返回（非完成序）——保 overloadIndex 顺序确定性。
 * 单任务失败不崩池：返回带 warning 的空 FileSetResult，该 file-set 跳过，worker 存活。
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { scanFileSet, type FileSetResult } from "./plsql-file-scanner"
import type { PackageInfo, SubprogramInfo, TableIndex, TriggerIndex, ViewIndex, SequenceIndex, StandaloneProcIndex } from "./plsql-file-scanner"

const WORKER_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "plsql-pool-worker.ts")

/** worker 数：保守默认 min(hardwareConcurrency, 4)，env SQL2JAVA_WORKER_COUNT 可覆盖。 */
export function getWorkerCount(): number {
  const env = (globalThis as any).process?.env?.SQL2JAVA_WORKER_COUNT
  if (env) {
    const n = parseInt(env, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  const cores = (globalThis as any).navigator?.hardwareConcurrency ?? 1
  return Math.max(1, Math.min(cores, 4))
}

/** 单任务失败的占位产物（带 warning，不丢整体结果） */
function emptyResultWithError(errMsg: string, fileSet: string[]): FileSetResult {
  return {
    packages: [], subprograms: [], standaloneProcedures: [], standaloneSlots: [],
    tables: [], triggers: [], views: [], sequences: [],
    warnings: [`worker file-set 失败 (${fileSet.length} 文件): ${errMsg}`],
  }
}

/** 串行 fallback：主线程逐个 scanFileSet，按提交序返回。 */
async function serialFallback(fileSets: string[][], primaryBase: string): Promise<FileSetResult[]> {
  const results: FileSetResult[] = []
  for (const fs of fileSets) {
    try {
      results.push(scanFileSet(fs, primaryBase))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push(emptyResultWithError(msg, fs))
    }
  }
  return results
}

/** 单个 worker 的 RPC 句柄：常驻，一次处理一个任务，按 id 匹配响应。 */
class WorkerHandle {
  readonly worker: any
  private readonly ready: Promise<void>
  private nextId = 0

  constructor() {
    const WorkerCtor = (globalThis as any).Worker
    if (typeof WorkerCtor !== "function") {
      throw new Error("Worker 全局不可用（非 bun 运行时）")
    }
    this.worker = new WorkerCtor(WORKER_FILE)
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (ev: MessageEvent) => {
        if (ev.data?.kind === "ready") {
          this.worker.removeEventListener?.("message", onReady)
          resolve()
        }
      }
      const onError = (e: any) => reject(new Error(e?.message ?? "worker spawn error"))
      this.worker.addEventListener?.("message", onReady)
      this.worker.addEventListener?.("error", onError)
      // 兜底：某些运行时 onmessage 赋值式而非 addEventListener
      if (!this.worker.addEventListener) this.worker.onmessage = onReady
    })
  }

  /** 等待 worker 模块加载完成（ready 信号）。 */
  whenReady(): Promise<void> { return this.ready }

  /** 跑一个 file-set，返回结果（失败 reject）。worker 处理完保持存活等下一个。 */
  run(fileSet: string[], primaryBase: string): Promise<FileSetResult> {
    const id = this.nextId++
    return new Promise<FileSetResult>((resolve, reject) => {
      const onMsg = (ev: MessageEvent) => {
        const d = ev.data
        if (d?.id !== id) return
        this.worker.removeEventListener?.("message", onMsg)
        if (d.ok) resolve(d.result as FileSetResult)
        else reject(new Error(d.error))
      }
      this.worker.addEventListener?.("message", onMsg)
      if (!this.worker.addEventListener) this.worker.onmessage = onMsg
      this.worker.postMessage({ id, fileSet, primaryBase })
    })
  }

  terminate() {
    try { this.worker.terminate?.() } catch { /* 忽略 */ }
  }
}

/** persistent 池：N 个常驻 worker 共享任务队列，各取所需直到清空。 */
class WorkerPool {
  private handles: WorkerHandle[]
  constructor(n: number) {
    this.handles = Array.from({ length: n }, () => new WorkerHandle())
  }
  async ready(): Promise<void> {
    await Promise.all(this.handles.map(h => h.whenReady()))
  }
  /** 提交全部 file-set，按提交序返回结果。单任务失败→占位产物，不 reject。 */
  async runAll(fileSets: string[][], primaryBase: string): Promise<FileSetResult[]> {
    const results = new Array<FileSetResult>(fileSets.length)
    let nextIdx = 0
    const runNext = async (h: WorkerHandle) => {
      while (true) {
        const i = nextIdx++
        if (i >= fileSets.length) break
        try {
          results[i] = await h.run(fileSets[i], primaryBase)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          results[i] = emptyResultWithError(msg, fileSets[i])
        }
      }
    }
    await Promise.all(this.handles.map(runNext))
    return results
  }
  terminate() {
    for (const h of this.handles) h.terminate()
  }
}

/**
 * 并行扫描多个 file-set，结果按提交序返回。
 * - 0 file-set → []
 * - 1 file-set → 直接串行（省 spawn 开销）
 * - Worker 不可用 / spawn 失败 → 串行 fallback
 * - 池运行中崩溃 → 串行 fallback 兜底重跑全部
 */
export async function scanFilesParallel(fileSets: string[][], primaryBase: string): Promise<FileSetResult[]> {
  if (fileSets.length === 0) return []
  // 小工作量闸门：file-set 数 < 2×workerCount 时，N 个 worker 各付 ATN 冷启动（~4.3s/worker）
  // 摊销不开 → 串行（1 次冷启动）反而更快。大项目（千级包→千级 file-set）才走池。
  const workerCount = getWorkerCount()
  if (fileSets.length < 2 * workerCount) {
    return serialFallback(fileSets, primaryBase)
  }

  let pool: WorkerPool | null = null
  try {
    pool = new WorkerPool(getWorkerCount())
    await pool.ready()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try { (await import("./workflow-logger")).getLogger().warn("[worker-pool]", `spawn 失败，回退串行: ${msg}`) } catch { /* logger 不可用也无所谓 */ }
    return serialFallback(fileSets, primaryBase)
  }

  try {
    return await pool.runAll(fileSets, primaryBase)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try { (await import("./workflow-logger")).getLogger().warn("[worker-pool]", `池运行失败，回退串行: ${msg}`) } catch { /* */ }
    return serialFallback(fileSets, primaryBase)
  } finally {
    pool.terminate()
  }
}

/**
 * persistent session —— 跨多次 run 复用同一池，amortize ATN 冷启动。
 * scanSourceLazy 的 BFS 多波次用：首波足够大时建 session，后续波次（无论大小）复用 warm 池；
 * 小闭包（所有波次都小）不建 session，全程串行，省 spawn 开销。
 *
 * Worker 不可用 / spawn 失败 → 返回 null，调用方走串行。
 */
export interface PoolSession {
  run(fileSets: string[][], primaryBase: string): Promise<FileSetResult[]>
  close(): void
}

export async function createPoolSession(): Promise<PoolSession | null> {
  if (typeof (globalThis as any).Worker !== "function") return null
  try {
    const pool = new WorkerPool(getWorkerCount())
    await pool.ready()
    return {
      // 池已 warm（ATN 已付），无论波次大小都派发到池；空/单任务也走池（worker 已就绪）
      run: (fileSets: string[][], primaryBase: string) => pool.runAll(fileSets, primaryBase),
      close: () => pool.terminate(),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try { (await import("./workflow-logger")).getLogger().warn("[worker-pool]", `session 创建失败，回退串行: ${msg}`) } catch { /* */ }
    return null
  }
}
