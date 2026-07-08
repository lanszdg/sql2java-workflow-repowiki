/**
 * worker 池 worker entry —— 仅 import 叶子模块 scanFileSet（不拉 scanner 全链，打破循环 import）。
 *
 * 协议（主线程 ↔ worker）：
 *   主→worker: { id, fileSet: string[], primaryBase: string }
 *   worker→主: { id, ok: true, result: FileSetResult } | { id, ok: false, error: string }
 *   worker→主（启动）: { kind: "ready" }
 *
 * 常驻 worker：处理完一个任务后保持存活等下一条消息（persistent 池，amortize PlSqlParser
 * ATN 冷启动 ~4.3s——首次 new PlSqlParser() 懒构建，每 worker 只付一次）。
 *
 * 失败不崩：scanFileAst 内部已 try/catch 收 warning；此处再兜一层，单文件集异常只回 error，
 * 主线程据此决定跳过/fallback，worker 继续存活。
 */
import { scanFileSet, type FileSetResult } from "./plsql-file-scanner"

;(self as any).postMessage({ kind: "ready" })

;(self as any).onmessage = (ev: MessageEvent) => {
  const { id, fileSet, primaryBase } = ev.data as {
    id: number; fileSet: string[]; primaryBase: string
  }
  try {
    const result: FileSetResult = scanFileSet(fileSet, primaryBase)
    ;(self as any).postMessage({ id, ok: true, result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ;(self as any).postMessage({ id, ok: false, error: msg })
  }
}
