/**
 * Engine Factory — 创建预配置的 WorkflowEngine 实例供测试使用
 */

import { WorkflowEngine, type WorkflowDefinition } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { safeRm, safeWriteFile } from "@workflow/cross-platform"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/** 创建引擎并注册 sql2java 定义 */
export function createEngine(): WorkflowEngine {
  const engine = new WorkflowEngine()
  engine.registerDefinition(SQL2JAVA_WORKFLOW)
  return engine
}

/** 创建引擎并设置临时 artifactsRoot */
export function createEngineWithTempDir(): { engine: WorkflowEngine; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sql2java-engine-test-"))
  const engine = new WorkflowEngine()
  // 设置 artifactsRoot 到临时目录
  ;(engine as any).artifactsRoot = dir
  engine.registerDefinition(SQL2JAVA_WORKFLOW)
  return {
    engine,
    dir,
    cleanup: () => {
      try { safeRm(dir) } catch {}
    },
  }
}

/** 在 artifacts 目录中创建 JSON 文件（原子写：safeWriteFile 内部 mkdir + tmp→rename） */
export function writeArtifact(dir: string, runId: string, filename: string, data: unknown): void {
  safeWriteFile(join(dir, runId, filename), JSON.stringify(data))
}
