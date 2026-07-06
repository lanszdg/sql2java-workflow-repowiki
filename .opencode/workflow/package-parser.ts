/**
 * package-parser — 共享的 per-package artifact JSON 解析器。
 *
 * 统一「读 packages/{pkg}.json + subprograms/{pkg}.*.json → refNamesForPackage(names) 推导重载 refName
 * → 回退字段」逻辑，消除 generateUnitSlices（invForPkg）与 review-focus（buildInvRefMap）
 * 各自重复实现导致的 refName 不一致风险。
 * 文件缺失或 JSON 解析失败返回 null；调用方按需自行缓存。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { refNameOf, refNamesForPackage } from "./refname"

// ── packages/{pkg}.json + subprograms/{pkg}.*.json ────────────────────────────

/** parseInventoryPackage 的返回结构。subprograms 为原始子程序数组（含 bodyLocation/parameters/directCalls 等）。 */
export interface InventoryPackageParsed {
  /** 重载 refName 列表（refNamesForPackage 处理 {name}__序号），与 subprograms 一一对应。 */
  refNames: string[]
  /** 原始子程序数组（顺序与 refNames 对齐，来自 subprograms/{pkg}.*.json）。 */
  subprograms: any[]
  /** 包容器对象（来自 packages/{pkg}.json，含 headerPath/bodyPath/absolutePaths 等）。 */
  pkgInfo: any
  /** headerPath ?? null —— 包头源码定位用。 */
  headerPath: string | null
  /** bodyPath ?? null —— 包体源码定位用。 */
  bodyPath: string | null
}

/**
 * 读取 packages/{pkg}.json + 聚合 subprograms/{pkg}.*.json。
 * 子程序文件按文件名自然序读取后，按 refNamesForPackage 重新对齐 refName（重载全部带序号）。
 * 包名大小写不敏感：Oracle 标识符大小写不敏感，用户给的 mainEntry 包名大小写可能与磁盘文件名
 *（规范化大写）不一致，故精确名未命中时回退大小写不敏感扫描。
 * @returns 解析结构；包文件缺失返回 null
 */
export function parseInventoryPackage(artifactsDir: string, pkg: string): InventoryPackageParsed | null {
  const pkgDir = join(artifactsDir, "packages")
  if (!existsSync(pkgDir)) return null
  // 1) 精确名
  let pkgPath = join(pkgDir, `${pkg}.json`)
  if (!existsSync(pkgPath)) {
    // 2) 大小写不敏感兜底
    const wantUpper = pkg.toUpperCase()
    let match: string | null = null
    try {
      for (const f of readdirSync(pkgDir)) {
        if (f.endsWith(".json") && f.slice(0, -".json".length).toUpperCase() === wantUpper) {
          match = f
          break
        }
      }
    } catch { return null }
    if (!match) return null
    pkgPath = join(pkgDir, match)
  }
  let pkgInfo: any
  try {
    pkgInfo = JSON.parse(readFileSync(pkgPath, "utf-8"))
  } catch {
    return null
  }
  // 聚合 subprograms/{pkg}.*.json（大小写不敏感前缀匹配）
  const subpDir = join(artifactsDir, "subprograms")
  const subprograms: any[] = []
  if (existsSync(subpDir)) {
    const prefixUpper = `${pkg.toUpperCase()}.`
    for (const f of readdirSync(subpDir).sort()) {
      if (!f.endsWith(".json")) continue
      if (!f.slice(0, -".json".length).toUpperCase().startsWith(prefixUpper)) continue
      try {
        subprograms.push(JSON.parse(readFileSync(join(subpDir, f), "utf-8")))
      } catch { /* 跳过损坏 */ }
    }
  }
  // refName 取每个子程序文件的 overloadIndex（与文件名 {PKG}.{refName}.json 及依赖图 callGraph key 一致），
  // 顺序无关。不用 refNamesForPackage(遇见序)：readdirSync().sort() 在重载≥10 时 __10<__2，且 ext4 上
  // readdirSync 非字典序——会使 generateUnitSlices 的 inv.refNames.indexOf(rootRef) 命中错文件/返回 -1。
  const refNames = subprograms.map((s: any) => refNameOf({ name: String(s?.name ?? ""), overloadIndex: s?.overloadIndex ?? null }))
  const headerPath = pkgInfo.headerPath ?? null
  const bodyPath = pkgInfo.bodyPath ?? null
  return { refNames, subprograms, pkgInfo, headerPath, bodyPath }
}

// ── analysis-packages/{pkg}.json ───────────────────────────────────────────────

/** parseAnalysisPackage 的返回结构。subprograms 为原始 subprograms 数组（原样，含 cursors/exceptionHandlers 等）。 */
export interface AnalysisPackageParsed {
  /** 重载 refName 列表（refNamesForPackage 处理 {name}__序号），与 subprograms 一一对应。 */
  refNames: string[]
  /** 原始 subprograms 数组（顺序与 refNames 对齐）。 */
  subprograms: any[]
}

/**
 * 读取并解析 analysis-packages/{pkg}.json。
 * @returns 解析结构；文件缺失或解析失败返回 null
 */
export function parseAnalysisPackage(artifactsDir: string, pkg: string): AnalysisPackageParsed | null {
  const p = join(artifactsDir, "analysis-packages", `${pkg}.json`)
  if (!existsSync(p)) return null
  let ana: any
  try {
    ana = JSON.parse(readFileSync(p, "utf-8"))
  } catch {
    return null
  }
  const subprograms: any[] = Array.isArray(ana.subprograms) ? ana.subprograms : []
  const refNames = refNamesForPackage(subprograms.map((s: any) => s.name))
  return { refNames, subprograms }
}

