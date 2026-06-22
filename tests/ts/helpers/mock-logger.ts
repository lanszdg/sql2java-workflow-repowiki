/**
 * Mock Logger — 替代 WorkflowLogger，在内存中捕获日志
 */

import { vi } from "vitest"

export interface MockLogEntry {
  level: "INFO" | "WARN" | "ERROR"
  tag: string
  msg: string
}

export function createMockLogger() {
  const logs: MockLogEntry[] = []

  const logger = {
    info: vi.fn((tag: string, msg: string) => {
      logs.push({ level: "INFO", tag, msg })
    }),
    warn: vi.fn((tag: string, msg: string) => {
      logs.push({ level: "WARN", tag, msg })
    }),
    error: vi.fn((tag: string, msg: string) => {
      logs.push({ level: "ERROR", tag, msg })
    }),
  }

  return {
    logger,
    logs,
    clear: () => logs.splice(0, logs.length),
    findByTag: (tag: string) => logs.filter(l => l.tag === tag),
    findByLevel: (level: MockLogEntry["level"]) => logs.filter(l => l.level === level),
    findByMsg: (pattern: RegExp) => logs.filter(l => pattern.test(l.msg)),
  }
}
