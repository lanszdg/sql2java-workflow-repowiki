/**
 * case-loader.ts — 执行点用例加载器
 *
 * 从 tests/llm/cases/<name>/case.config.ts 加载 CaseConfig。
 * 一个用例 = 一个子目录，含 case.config.ts（+ 由其 prepareArtifacts/prepareFixture 程序化预置，
 *   或配合 artifacts/、fixture/ 静态目录）。
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { CaseConfig } from "./harness"

const CASES_DIR = join(dirname(new URL(import.meta.url).pathname), "cases")
// 兼容 Windows: import.meta.url 的 pathname 可能带前导斜杠，统一用 resolve 规整
const CASES_DIR_ABS = process.platform === "win32" ? resolve(CASES_DIR.replace(/^\//, "")) : CASES_DIR

/** 加载单个用例 */
export async function loadCase(name: string): Promise<CaseConfig> {
  const caseDir = join(CASES_DIR_ABS, name)
  const configFile = join(caseDir, "case.config.ts")
  if (!existsSync(configFile)) {
    throw new Error(`用例不存在或缺少 case.config.ts: ${configFile}`)
  }
  const mod = await import(configFile)
  const config = (mod?.default ?? mod?.config) as CaseConfig | undefined
  if (!config) {
    throw new Error(`用例 ${name} 未导出 default CaseConfig（期望 export default）`)
  }
  if (!config.name) config.name = name
  return config
}

/** 扫描 cases/ 下所有用例名（含 case.config.ts 的子目录） */
export function listCaseNames(): string[] {
  if (!existsSync(CASES_DIR_ABS)) return []
  return readdirSync(CASES_DIR_ABS, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => existsSync(join(CASES_DIR_ABS, name, "case.config.ts")))
    .sort()
}

/** 加载所有用例 */
export async function loadAllCases(): Promise<CaseConfig[]> {
  const names = listCaseNames()
  const cases: CaseConfig[] = []
  for (const name of names) {
    try {
      cases.push(await loadCase(name))
    } catch (e: any) {
      console.error(`⚠️  加载用例 ${name} 失败: ${e.message}`)
    }
  }
  return cases
}

/** cases 目录绝对路径（供 runner 计算静态 fixture/artifacts 目录） */
export function getCasesDir(): string {
  return CASES_DIR_ABS
}

// 标记 statSync 已使用（避免某些 lint 误报，保留以备扩展）
void statSync
