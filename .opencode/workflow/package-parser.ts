/**
 * package-parser — 共享的 per-package artifact JSON 解析器。
 *
 * 统一「读 {inventory,analysis}-packages/{pkg}.json → refNamesForPackage(names) 推导重载 refName
 * → 回退字段」逻辑，消除 generateUnitSlices（invForPkg/subprogramsForPkg）与 review-focus
 * （buildInvRefMap/buildAnaRefMap）各自重复实现导致的 refName 不一致风险。
 * 文件缺失或 JSON 解析失败返回 null；调用方按需自行缓存。
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { refNamesForPackage } from "./refname"

// ── inventory-packages/{pkg}.json ──────────────────────────────────────────────

/** parseInventoryPackage 的返回结构。procs 为原始 procedures 数组（原样，含 lineRange/params 等字段）。 */
export interface InventoryPackageParsed {
  /** 重载 refName 列表（refNamesForPackage 处理 {name}__序号），与 procs 一一对应。 */
  refNames: string[]
  /** 原始 procedures 数组（顺序与 refNames 对齐）。 */
  procs: any[]
  /** bodyFile ?? specFile ?? null —— 源码定位用。 */
  bodyFile: string | null
}

/**
 * 读取并解析 inventory-packages/{pkg}.json。
 * @returns 解析结构；文件缺失或解析失败返回 null
 */
export function parseInventoryPackage(artifactsDir: string, pkg: string): InventoryPackageParsed | null {
  const p = join(artifactsDir, "inventory-packages", `${pkg}.json`)
  if (!existsSync(p)) return null
  let inv: any
  try {
    inv = JSON.parse(readFileSync(p, "utf-8"))
  } catch {
    return null
  }
  const procs: any[] = Array.isArray(inv.procedures) ? inv.procedures : []
  const refNames = refNamesForPackage(procs.map((proc: any) => proc.name))
  const bodyFile = inv.bodyFile ?? inv.specFile ?? null
  return { refNames, procs, bodyFile }
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
