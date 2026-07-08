/**
 * Inventory Builder — 把 scan 阶段产出的 InventoryIndex（内存对象，新形状：packages/subprograms 独立数组）
 * 落盘为按实体独立的新产物：
 *   packages/{PKG}.json       — 包容器（名字索引 + 包级声明）
 *   subprograms/{PKG.METHOD}.json — 原子子程序（header/body 双定位 + directCalls）
 *   tables/{TABLE}.json       — 单表列结构 + 主键 + 外键
 *   inventory.json            — 顶层轻量索引（packageNames + tableNames + triggers/views/sequences）
 *
 * 纯代码步骤（零 LLM）：scan（AST listener）已抽出全部结构字段，此处仅做格式映射 + Zod 校验。
 * 任一产物 Zod 校验失败即抛错（调用方据此判定 inventory 生成失败）。
 *
 * 注：scan→generateInventory 的 InventoryIndex 经引擎层内存 cache 交接，不再落盘 inventory-index.json
 *（避免大模型读到全量包源码路径等无关上下文）。本函数直接接收内存 index 对象。
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  InventorySchema,
  PackageArtifactSchema,
  SubprogramArtifactSchema,
  TableArtifactSchema,
} from "./artifact-schemas"
import { formatZodIssues } from "./engine-core"
import { getLogger } from "./workflow-logger"
import { refNameOf } from "./refname"
import { clearDependencyGraphCache } from "./dependency-graph"
import type {
  PackageInfo, SubprogramInfo, TableIndex, TriggerIndex, ViewIndex, SequenceIndex, InventoryIndex,
} from "./plsql-scanner"

/** 子程序文件名：{PKG}.{refName}.json，refName 复用单一真相源 refNameOf */
function subprogramFileName(s: SubprogramInfo): string {
  return `${s.belongToPackage}.${refNameOf(s)}.json`
}

/**
 * 把内存 InventoryIndex 写出为 packages/+subprograms/+tables/+inventory.json。
 * 任一产物 Zod 校验失败即抛错。
 *
 * idx 由调用方（generateInventory action）从引擎内存 cache 提供；cache miss 时由调用方自扫描兜底。
 */
export function buildInventoryFromIndex(artifactsDir: string, idx: InventoryIndex): {
  packageCount: number
  subprogramCount: number
  tableCount: number
  warnings: string[]
} {
  // 本函数重写 subprograms/*.json（含 directCalls），依赖图缓存（按 artifactsDir 常驻）随之失效——
  // 否则同 session 内 agent 重跑 generateInventory 修正 directCalls 后，buildDependencyGraph 仍返回旧图，
  // ensureRunScope 用过期闭包持久化错误 scope。生成失败也清：subprograms 可能已部分重写。
  clearDependencyGraphCache(artifactsDir)

  const packagesDir = join(artifactsDir, "packages")
  const subprogramsDir = join(artifactsDir, "subprograms")
  const tablesDir = join(artifactsDir, "tables")
  mkdirSync(packagesDir, { recursive: true })
  mkdirSync(subprogramsDir, { recursive: true })
  mkdirSync(tablesDir, { recursive: true })

  // 1) packages/{PKG}.json
  for (const p of idx.packages) {
    const result = PackageArtifactSchema.safeParse(p)
    if (!result.success) {
      throw new Error(`packages/${p.packageName}.json 校验失败:\n${formatZodIssues(result.error)}`)
    }
    // 软校验：包声明了子程序（procedures/functions 非空）但 bodyPath=null —— 无法翻译过程体。
    // 旧 InventoryPackageSchema 的 refine(procedures⇒bodyFile) 是硬门控，但会误伤合法的 spec-only 包
    //（Oracle 允许仅 spec 声明），故此处降为非阻塞警告：scanner 漏收 body / 手写产物缺 body 时可见。
    const subCount = (Array.isArray(p.procedures) ? p.procedures.length : 0) + (Array.isArray(p.functions) ? p.functions.length : 0)
    if (subCount > 0 && !p.bodyPath) {
      warnings.push(`包 ${p.packageName} 声明了 ${subCount} 个子程序但 bodyPath 为空（无法翻译过程体，检查 body 文件是否漏收集）`)
    }
    writeFileSync(join(packagesDir, `${p.packageName}.json`), JSON.stringify(result.data, null, 2), "utf-8")
  }

  // 2) subprograms/{PKG.METHOD}.json
  for (const s of idx.subprograms) {
    const result = SubprogramArtifactSchema.safeParse(s)
    if (!result.success) {
      throw new Error(`subprograms/${subprogramFileName(s)} 校验失败:\n${formatZodIssues(result.error)}`)
    }
    writeFileSync(join(subprogramsDir, subprogramFileName(s)), JSON.stringify(result.data, null, 2), "utf-8")
  }

  // 3) tables/{TABLE}.json（表名可能含点 FM.T_ITEM，文件名保留点）
  for (const t of idx.tables) {
    const result = TableArtifactSchema.safeParse(t)
    if (!result.success) {
      throw new Error(`tables/${t.name}.json 校验失败:\n${formatZodIssues(result.error)}`)
    }
    writeFileSync(join(tablesDir, `${t.name}.json`), JSON.stringify(result.data, null, 2), "utf-8")
  }

  // 4) inventory.json（顶层轻量索引）
  const inventory = {
    sourcePath: idx.sourcePath,
    scannedAt: idx.scannedAt,
    scannerUsed: idx.scannerUsed,
    warnings: idx.warnings ?? [],
    packageNames: idx.packages.map(p => p.packageName),
    tableNames: idx.tables.map(t => t.name),
    triggers: idx.triggers.map(t => ({
      name: t.name,
      timing: t.timing ?? "before",
      level: t.level ?? "statement",
      targetTable: t.targetTable ?? "",
      events: t.events ?? [],
      sourceFile: t.sourceFile,
      lineRange: t.lineRange ?? [0, 0],
      condition: t.condition ?? null,
    })),
    views: idx.views.map(v => ({
      name: v.name,
      ddlFile: v.ddlFile ?? null,
      sourceFile: v.ddlFile ?? null,
      columns: v.columns ?? [],
      underlyingTables: v.underlyingTables ?? [],
    })),
    sequences: idx.sequences.map(s => ({
      name: s.name,
      ddlFile: s.ddlFile ?? null,
      startWith: s.startWith ?? null,
      incrementBy: s.incrementBy ?? null,
      minValue: s.minValue ?? null,
      maxValue: s.maxValue ?? null,
      cycle: s.cycle ?? null,
    })),
  }

  const invResult = InventorySchema.safeParse(inventory)
  if (!invResult.success) {
    throw new Error(`inventory.json 校验失败:\n${formatZodIssues(invResult.error)}`)
  }
  writeFileSync(join(artifactsDir, "inventory.json"), JSON.stringify(invResult.data, null, 2), "utf-8")

  getLogger().info(
    "[inventory-builder]",
    `生成 inventory: ${idx.packages.length} pkgs, ${idx.subprograms.length} subprograms, ${idx.tables.length} tables, ${idx.triggers.length} triggers`,
  )
  return {
    packageCount: idx.packages.length,
    subprogramCount: idx.subprograms.length,
    tableCount: idx.tables.length,
    warnings: idx.warnings ?? [],
  }
}
