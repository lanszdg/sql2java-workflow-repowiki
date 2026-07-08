import { describe, it, expect } from "vitest"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { partitionFilesByPackage, finalizeFileSetResults, scanFileSet, type FileSetResult } from "@workflow/plsql-scanner"

const ROOT = resolve(import.meta.dirname, "../../..")
const RES = resolve(ROOT, "resources")

/**
 * worker 池并行化的正确性根基：partitionFilesByPackage 的三个不变量。
 *  - 覆盖：所有输入文件出现在某个 file-set
 *  - 不重叠：同一文件不出现在两个 file-set
 *  - 同包同集：声明同一 PACKAGE 的全部文件（spec+body 跨文件）落同一 file-set
 *    （否则 worker 间无法正确合并 spec↔body 槽位 → 重载/配对错乱）
 *
 * 真正的并行 vs 串行深度相等校验在 scripts/verify-parallel-parity.ts（bun 独立运行，
 * vitest 跑在 node worker 里 Worker 全局不可用，只覆盖串行 fallback 路径）。
 */
describe("partitionFilesByPackage 分区不变量", () => {
  it("tiny: 覆盖 + 不重叠（所有文件恰好出现一次）", () => {
    const tiny = resolve(RES, "mfg_erp_sql_tiny")
    const { readdirSync, statSync } = require("node:fs")
    const list: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(d)) { const f = resolve(d, e); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith(".sql")) list.push(f) } }
    walk(tiny)
    const { fileSets } = partitionFilesByPackage(list)
    const all: string[] = fileSets.flat()
    expect(all.length, "覆盖：file-set 展平后文件数 == 输入文件数").toBe(list.length)
    expect(new Set(all).size, "不重叠：无重复文件").toBe(list.length)
    for (const f of list) expect(all).toContain(f)
  })

  it("同包 spec+body 跨文件 → 落同一 file-set（union-find 连通）", () => {
    const tmp = resolve(ROOT, ".tmp-partition-test")
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    // 两个文件声明同一包 CORE_PKG（spec 风格 + body 风格），应被 union 进同一 file-set
    writeFileSync(resolve(tmp, "core_spec.sql"), "CREATE OR REPLACE PACKAGE CORE_PKG AS\nPROCEDURE foo; END CORE_PKG;\n/\n")
    writeFileSync(resolve(tmp, "core_body.sql"), "CREATE OR REPLACE PACKAGE BODY CORE_PKG IS\nPROCEDURE foo IS BEGIN NULL; END; END CORE_PKG;\n/\n")
    // 另一个独立包
    writeFileSync(resolve(tmp, "other.sql"), "CREATE OR REPLACE PACKAGE OTHER_PKG AS PROCEDURE bar; END OTHER_PKG;\n/\n")
    const { fileSets } = partitionFilesByPackage([
      resolve(tmp, "core_spec.sql"), resolve(tmp, "core_body.sql"), resolve(tmp, "other.sql"),
    ])
    const coreSet = fileSets.find(s => s.some(f => f.endsWith("core_spec.sql")))
    expect(coreSet, "core_spec 所在 file-set").toBeDefined()
    expect(coreSet!.some(f => f.endsWith("core_body.sql")), "core_body 与 core_spec 同一 file-set（同包连通）").toBe(true)
    expect(coreSet!.length, "CORE_PKG 的 spec+body 两文件在同一 set").toBe(2)
    rmSync(tmp, { recursive: true, force: true })
  })
})

/**
 * 多 file-set 合并 == 单 file-set：证明 partition + finalizeFileSetResults 的多集合并
 * 与一次性 scanFileSet(allFiles) 产物等价（按包分区下包不跨 set，re-bucket 无需配对逻辑）。
 * tiny 各包均为单文件 → 任意按文件分组都满足"同包同集"，可直接验证合并等价性。
 */
describe("finalizeFileSetResults 多集合并 == 单集", () => {
  it("tiny: 拆 2 组 scanFileSet + 合并 == 全量单集 scanFileSet", async () => {
    const tiny = resolve(RES, "mfg_erp_sql_tiny")
    const { readdirSync, statSync } = require("node:fs")
    const list: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(d)) { const f = resolve(d, e); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith(".sql")) list.push(f) } }
    walk(tiny)
    list.sort()
    const half = Math.ceil(list.length / 2)
    const groupA = list.slice(0, half)
    const groupB = list.slice(half)
    const rA: FileSetResult = scanFileSet(groupA, tiny)
    const rB: FileSetResult = scanFileSet(groupB, tiny)
    const rAll: FileSetResult = scanFileSet(list, tiny)
    const merged = finalizeFileSetResults([rA, rB], tiny, "ast")
    const single = finalizeFileSetResults([rAll], tiny, "ast")
    // 比较 packages/subprograms/tables（忽略 scannedAt）
    const sig = (inv: any) => ({
      pkgs: [...inv.packages].map((p: any) => `${p.packageName}|${p.estimatedLoc}|${p.procedures.length}|${p.functions.length}`).sort(),
      subs: [...inv.subprograms].map((s: any) => `${s.belongToPackage}.${s.name}.${s.overloadIndex ?? 0}|${s.type}|dc=${s.directCalls.length}|pr=${s.packageRefs.length}`).sort(),
      tables: [...inv.tables].map((t: any) => `${t.name}`).sort(),
    })
    expect(sig(merged)).toEqual(sig(single))
  })
})
