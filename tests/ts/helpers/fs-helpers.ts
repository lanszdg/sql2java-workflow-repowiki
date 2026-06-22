/**
 * 文件系统测试工具 — 临时目录管理、fixture 复制
 */

import { mkdtempSync, rmSync, cpSync, mkdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterAll } from "vitest"

const PROJECT_ROOT = resolve(import.meta.dirname, "../../..")

/** 获取项目根目录 */
export function getProjectRoot(): string {
  return PROJECT_ROOT
}

/** 创建临时目录，afterAll 自动清理 */
export function useTempDir(prefix = "sql2java-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  afterAll(() => {
    try { rmSync(dir, { recursive: true }) } catch {}
  })
  return dir
}

/** 复制 fixture 到临时目录并返回路径 */
export function useFixtureCopy(fixtureRelPath: string): string {
  const tmpDir = useTempDir("sql2java-fixture-")
  const srcDir = join(PROJECT_ROOT, fixtureRelPath)
  if (existsSync(srcDir)) {
    cpSync(srcDir, tmpDir, { recursive: true })
  }
  return tmpDir
}

/** 创建 artifact 目录结构 */
export function useArtifactDir(runId?: string): string {
  const tmpDir = useTempDir("sql2java-artifacts-")
  const artifactDir = runId
    ? join(tmpDir, ".workflow-artifacts", runId)
    : join(tmpDir, ".workflow-artifacts")
  mkdirSync(artifactDir, { recursive: true })
  return artifactDir
}

/** 获取 fixture 文件的绝对路径 */
export function fixturePath(...segments: string[]): string {
  return join(PROJECT_ROOT, "tests", "ts", "fixtures", ...segments)
}

/** 获取资源文件的绝对路径 */
export function resourcePath(...segments: string[]): string {
  return join(PROJECT_ROOT, "resources", ...segments)
}
