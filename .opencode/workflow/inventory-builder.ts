/**
 * Inventory Builder — 把 prescan 产出的 inventory-index.json（结构抽取全字段）
 * 转换为下游消费的 inventory-packages/{PKG}.json + inventory.json。
 *
 * inventory 阶段因此成为纯代码步骤（零 LLM）：prescan（AST/regex）已抽出全部结构字段，
 * 此处仅做格式映射 + Zod 校验，无需 Worker 读源码。
 *
 * 兜底：prescan 对个别文件降级到 regex（仅名字）时，对应字段缺省——用合理默认填充以满足
 * schema，下游 analyze 可识别并（必要时）由 LLM 补全。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { InventoryPackageSchema, InventorySchema } from "./artifact-schemas"
import { formatZodIssues } from "./engine-core"
import { getLogger } from "./workflow-logger"

/** prescan 产出的 inventory-index.json 结构（与 plsql-scanner InventoryIndex 对齐，宽松读取） */
interface PrescanIndex {
  sourcePath: string
  packages: PrescanPackage[]
  tables: PrescanTable[]
  triggers: PrescanTrigger[]
  views: PrescanView[]
  sequences: PrescanSequence[]
  standaloneProcedures: PrescanStandalone[]
}

interface PrescanParam { name: string; oracleType: string; direction: string }
interface PrescanProc {
  name: string; type: string
  lineRange?: [number, number]; loc?: number
  params?: PrescanParam[]; returnType?: string | null
}
interface PrescanPackage {
  name: string; headerFile?: string; bodyFile?: string
  procedures: PrescanProc[]
  types?: { name: string; kind: string; definition: string }[]
  variables?: { name: string; type: string; defaultValue?: string | null }[]
  constants?: { name: string; type: string; value: string }[]
}
interface PrescanColumn { name: string; oracleType: string; nullable: boolean; isPrimaryKey: boolean; defaultValue?: string | null }
interface PrescanTable { name: string; ddlFile?: string; columns?: PrescanColumn[] }
interface PrescanTrigger {
  name: string; sourceFile: string
  timing?: string; level?: string; targetTable?: string; events?: string[]
  lineRange?: [number, number]; condition?: string | null
}
interface PrescanView { name: string; ddlFile?: string; columns?: string[]; underlyingTables?: string[] }
interface PrescanSequence {
  name: string; ddlFile?: string
  startWith?: number | null; incrementBy?: number | null
  minValue?: number | null; maxValue?: number | null; cycle?: boolean | null
}
interface PrescanStandalone {
  name: string; type: string; sourceFile: string
  params?: PrescanParam[]; returnType?: string | null; lineRange?: [number, number]
}

const safeRange = (r?: [number, number]): [number, number] => r ?? [0, 0]

/** 把单个 prescan package 映射为 InventoryPackageSchema 形态 */
function mapPackage(p: PrescanPackage) {
  return {
    packageName: p.name,
    headerFile: p.headerFile ?? null,
    bodyFile: p.bodyFile ?? null,
    procedures: p.procedures.map(proc => ({
      name: proc.name,
      type: proc.type,
      params: (proc.params ?? []).map(pa => ({
        name: pa.name,
        oracleType: pa.oracleType,
        direction: pa.direction as "IN" | "OUT" | "IN OUT",
      })),
      returnType: proc.returnType ?? null,
      lineRange: safeRange(proc.lineRange),
      loc: proc.loc ?? (safeRange(proc.lineRange)[1] - safeRange(proc.lineRange)[0] + 1),
    })),
    types: p.types ?? [],
    variables: (p.variables ?? []).map(v => ({ name: v.name, type: v.type, defaultValue: v.defaultValue ?? null })),
    constants: p.constants ?? [],
  }
}

/**
 * 读取 inventory-index.json，写出 inventory-packages/{PKG}.json + inventory.json。
 * 任一产物 Zod 校验失败即抛错（调用方据此判定 inventory 生成失败）。
 */
export function buildInventoryFromIndex(artifactsDir: string): {
  packageCount: number
  tableCount: number
  warnings: string[]
} {
  const indexPath = join(artifactsDir, "inventory-index.json")
  if (!existsSync(indexPath)) {
    throw new Error(`inventory-index.json 不存在: ${indexPath}（prescan 可能未运行）`)
  }
  const index = JSON.parse(readFileSync(indexPath, "utf-8")) as PrescanIndex
  const warnings: string[] = []

  // 1) 逐包 inventory-packages/{PKG}.json
  const pkgDir = join(artifactsDir, "inventory-packages")
  mkdirSync(pkgDir, { recursive: true })
  for (const p of index.packages) {
    const mapped = mapPackage(p)
    const result = InventoryPackageSchema.safeParse(mapped)
    if (!result.success) {
      throw new Error(`inventory-packages/${p.name}.json 校验失败:\n${formatZodIssues(result.error)}`)
    }
    writeFileSync(join(pkgDir, `${p.name}.json`), JSON.stringify(result.data, null, 2), "utf-8")
  }

  // 2) inventory.json（索引 + DDL）
  const inventory = {
    sourcePath: index.sourcePath,
    packageNames: index.packages.map(p => p.name),
    tables: index.tables.map(t => ({
      name: t.name,
      ddlFile: t.ddlFile ?? null,
      columns: (t.columns ?? []).map(c => ({
        name: c.name,
        oracleType: c.oracleType,
        nullable: c.nullable,
        isPrimaryKey: c.isPrimaryKey,
        defaultValue: c.defaultValue ?? null,
      })),
    })),
    standaloneProcedures: index.standaloneProcedures.map(s => ({
      name: s.name,
      type: s.type,
      params: (s.params ?? []).map(pa => ({
        name: pa.name, oracleType: pa.oracleType,
        direction: pa.direction as "IN" | "OUT" | "IN OUT",
      })),
      returnType: s.returnType ?? null,
      sourceFile: s.sourceFile,
      lineRange: safeRange(s.lineRange),
    })),
    triggers: index.triggers.map(t => {
      // prescan 文本提取总会设置 timing/level/events/targetTable；regex 降级缺省时给默认以满足 schema
      if (!t.timing || !t.targetTable) {
        warnings.push(`trigger ${t.name} 元数据不完整（prescan 降级？），用默认值填充`)
      }
      return {
        name: t.name,
        timing: t.timing ?? "before",
        level: t.level ?? "statement",
        targetTable: t.targetTable ?? "",
        events: t.events ?? [],
        sourceFile: t.sourceFile,
        lineRange: safeRange(t.lineRange),
        condition: t.condition ?? null,
      }
    }),
    views: index.views.map(v => ({
      name: v.name,
      ddlFile: v.ddlFile ?? null,
      sourceFile: v.ddlFile ?? null,
      columns: v.columns ?? [],
      underlyingTables: v.underlyingTables ?? [],
    })),
    sequences: index.sequences.map(s => ({
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

  getLogger().info("[inventory-builder]", `生成 inventory: ${index.packages.length} pkgs, ${index.tables.length} tables, ${index.triggers.length} triggers`)
  return { packageCount: index.packages.length, tableCount: index.tables.length, warnings }
}
