/**
 * 跨平台文件操作工具
 *
 * 封装 Windows 与 POSIX 系统差异：
 * - atomicRename: renameSync 在 Windows 上目标文件存在时可能 EPERM → copyFile + unlink 回退
 * - safeRm: rmSync 在 Windows 上可能因文件锁定失败 → 自动重试
 * - safeWriteFile: 原子写入（tmp → rename），统一错误处理和 tmp 清理
 */

import {
  renameSync,
  copyFileSync,
  unlinkSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
} from "node:fs"
import { dirname, join } from "node:path"

const IS_WIN = process.platform === "win32"

/** Windows 上 renameSync/rmSync 因瞬时锁定（杀毒/索引/预览）失败的错误码 */
const TRANSIENT_WIN_CODES = new Set(["EPERM", "EBUSY", "EACCES"])

/**
 * 跨平台原子 rename。
 *
 * Windows 上 renameSync 在以下场景会抛 EPERM / EBUSY / EACCES：
 * - 目标文件被其他进程锁定（杀毒软件、文件管理器预览等）
 * - 源文件仍被流持有
 *
 * 回退策略：
 * - 文件：copyFileSync + unlinkSync（牺牲原子性，但保证操作完成）
 * - 目录：递归复制 + 递归删除（copyFileSync 无法处理目录）
 *
 * POSIX 系统直接走 renameSync，保持原子性。
 */
export function atomicRename(tmpPath: string, targetPath: string): void {
  try {
    renameSync(tmpPath, targetPath)
    return
  } catch (e: any) {
    // POSIX 或非瞬时错误：直接抛出
    if (!IS_WIN || !TRANSIENT_WIN_CODES.has(e.code)) throw e
    // Windows 瞬时锁定（杀毒/索引/预览）：先重试 renameSync 以保持原子性，
    // 重试耗尽或遇到非瞬时错误再退化为非原子复制（与 safeRm 的重试策略一致）。
    const MAX_RETRIES = 3
    let lastErr = e
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        renameSync(tmpPath, targetPath)
        return
      } catch (retryErr: any) {
        lastErr = retryErr
        if (!TRANSIENT_WIN_CODES.has(retryErr.code)) break
        if (i < MAX_RETRIES - 1) syncSleep(100 * Math.pow(2, i))
      }
    }
    // 重试耗尽：退化为 copy + unlink（牺牲原子性，但保证操作完成）
    // 区分文件和目录（statSync 可能因 tmpPath 被删除而失败，此时抛原始错误）
    let st
    try { st = statSync(tmpPath) } catch { throw lastErr }
    if (st.isDirectory()) {
      // 目录回退：递归复制所有文件，然后递归删除源目录
      const tracked: { files: string[]; dirs: string[] } = { files: [], dirs: [] }
      try {
        copyDirRecursive(tmpPath, targetPath, tracked)
      } catch (copyErr) {
        // 回滚：先删已复制文件，再按创建逆序删空目录（best-effort，非空目录保留）
        for (const f of tracked.files.reverse()) {
          try { unlinkSync(f) } catch { /* best-effort */ }
        }
        for (const d of tracked.dirs.reverse()) {
          try { rmdirSync(d) } catch { /* best-effort */ }
        }
        throw copyErr
      }
      safeRm(tmpPath)
    } else {
      // 文件回退：copyFile + unlink
      copyFileSync(tmpPath, targetPath)
      try { unlinkSync(tmpPath) } catch { /* 清理失败不影响主流程 */ }
    }
  }
}

/**
 * 递归复制目录（src → dest），自动创建目标目录结构。
 * 将所有已复制文件和已创建目录记录到 tracked，由调用方在失败时统一回滚
 * （避免旧的 per-call 回滚漏掉已完成子目录中的文件）。
 */
function copyDirRecursive(
  src: string,
  dest: string,
  tracked: { files: string[]; dirs: string[] },
): void {
  mkdirSync(dest, { recursive: true })
  tracked.dirs.push(dest)
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, tracked)
    } else {
      copyFileSync(srcPath, destPath)
      tracked.files.push(destPath)
    }
  }
}

/**
 * 同步 sleep（不阻塞 CPU）。
 * Atomics.wait 在 Node.js 9+ 和 Bun 中均支持，利用 SharedArrayBuffer 实现真正的同步等待。
 */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 跨平台递归删除目录。
 *
 * rmSync 可能因文件锁定（杀毒扫描、索引服务、NFS 等）临时失败。
 * 使用指数退避重试（最多 3 次，总等待 ≤ 700ms），确保短锁定不会导致操作失败。
 *
 * 注意：force: true 表示路径不存在时不报错。所有调用场景（清理 staging / DDL 输出）
 * 的目标路径可能不存在，这是预期行为。
 */
export function safeRm(targetPath: string): void {
  const MAX_RETRIES = 3
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      rmSync(targetPath, { recursive: true, force: true })
      return
    } catch (e: any) {
      if (i === MAX_RETRIES - 1) throw e
      // 短暂等待后重试（指数退避: 100ms, 200ms）
      syncSleep(100 * Math.pow(2, i))
    }
  }
}

/**
 * 原子写入文件：先写 .tmp 再 rename，保证目标文件不会出现半写状态。
 *
 * 统一了 engine-core / phase-metrics-collector / workflow-engine 三处的
 * writeFileSync + atomicRename + tmp 清理模式。
 *
 * @param filePath 目标文件路径
 * @param content 文件内容
 * @param onError 写入失败回调（如需自定义错误处理，如 log.warn 或 return 错误消息）
 */
export function safeWriteFile(
  filePath: string,
  content: string,
  onError?: (e: Error) => void,
): void {
  const tmpPath = filePath + ".tmp"
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tmpPath, content, "utf-8")
    atomicRename(tmpPath, filePath)
  } catch (e) {
    // 清理孤立的 .tmp 文件
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch { /* 忽略清理失败 */ }
    if (onError) {
      onError(e as Error)
    } else {
      throw e
    }
  }
}

/**
 * 抽取文件指定行范围（1-indexed，闭区间 [start, end]）。
 *
 * 用于 dispatch 前引擎预切 per-unit 源码片段（generateUnitSlices）。直接 readFileSync + split，
 * 不 spawn sed —— 跨平台（Windows 无 sed / macOS sed 与 GNU sed 行为差异）、确定性、无 shell 依赖。
 * inventory-packages 的 lineRange 与 buildUnitScopeBlock 的 sed -n 命令同为 1-indexed 闭区间。
 *
 * 容错：start < 1 截到 1，end 超过文件行数截到末行，start > end 返回空串。文件不存在抛 ENOENT
 * （由调用方 try/catch 容错，记 warn 不阻断 dispatch）。
 */
export function extractLineRange(filePath: string, start: number, end: number): string {
  const content = readFileSync(filePath, "utf-8")
  const lines = content.split(/\r?\n/)
  const s = Math.max(1, Math.floor(start)) - 1
  const e = Math.min(lines.length, Math.floor(end))
  if (s >= e) return ""
  return lines.slice(s, e).join("\n")
}
