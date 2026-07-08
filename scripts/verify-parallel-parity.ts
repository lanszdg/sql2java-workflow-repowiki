/**
 * 并行 vs 串行 parity + 加速比验证（bun 独立运行，非 vitest）。
 *
 * vitest 跑在 node worker 里，Worker 全局不可用 → 只能验证串行 fallback。
 * 真正的并行路径（bun Worker 池）只能用 `bun run` 验证。本脚本：
 *   1. 合成大资源（mfg_erp_sql ×K，包名加后缀 _Ck 保证唯一 → K×17 个独立包，均衡）
 *   2. 并行 scanSource（默认 workerCount）vs 强制串行（SQL2JAVA_WORKER_COUNT 设大触发 gate）
 *   3. 深度相等校验（packages/subprograms/tables 完全一致）
 *   4. 加速比报告
 *
 * 用法：bun run scripts/verify-parallel-parity.ts [copies=15]
 */
import { scanSource, type InventoryIndex } from "../.opencode/workflow/plsql-scanner"
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"

const __dirname = import.meta.dirname
const SRC = resolve(__dirname, "..", "resources/mfg_erp_sql")
const TMP = resolve(__dirname, "..", ".tmp-parallel-parity")
const K = Number(process.argv[2] ?? "15")

// 收集源文件
function listSql(dir: string): string[] {
  const out: string[] = []
  const { readdirSync, statSync } = require("node:fs")
  for (const e of readdirSync(dir)) {
    const f = join(dir, e)
    if (statSync(f).isDirectory()) out.push(...listSql(f))
    else if (f.endsWith(".sql")) out.push(f)
  }
  return out
}

// 合成：每个 copy 的包名/独立函数名加后缀 _Ck，保证跨 copy 唯一（同 copy 内引用一致 → 调用边自洽）
function synthesize() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const srcFiles = listSql(SRC)
  for (let k = 1; k <= K; k++) {
    const sub = join(TMP, `c${k}`)
    mkdirSync(sub, { recursive: true })
    for (const sf of srcFiles) {
      let code = readFileSync(sf, "utf-8")
      // 后缀化 _PKG 包名 + __STANDALONE fn（独立函数名在 create function body 里）
      code = code.replace(/([A-Za-z_][\w]*)(_PKG)\b/g, `$1$2_C${k}`)
      code = code.replace(/\b(FN_[A-Za-z_][\w]*)\b/g, `$1_C${k}`)
      const rel = sf.slice(SRC.length)
      const dest = join(sub, rel)
      mkdirSync(join(dest, ".."), { recursive: true })
      writeFileSync(dest, code)
    }
  }
}

function signature(inv: InventoryIndex): string {
  // 稳定签名：排序后序列化关键字段（用于深相等比较，忽略 scannedAt/warnings 顺序）
  const pkgs = [...inv.packages].map(p => `${p.packageName}|loc=${p.estimatedLoc}|fn=${p.functions.length}|proc=${p.procedures.length}`).sort()
  const subs = [...inv.subprograms].map(s => `${s.belongToPackage}.${s.name}.${s.overloadIndex ?? 0}|t=${s.type}|dc=${s.directCalls.length}|pr=${s.packageRefs.length}`).sort()
  const tables = [...inv.tables].map(t => `${t.name}|cols=${t.columns?.length ?? 0}`).sort()
  return `pkgs=${pkgs.length}:${pkgs.join(";")}\nsubs=${subs.length}:${subs.join(";")}\ntables=${tables.length}:${tables.join(";")}`
}

async function main() {
  console.log(`合成大资源: mfg_erp_sql ×${K} (包名后缀化) → ${TMP}`)
  synthesize()

  // 串行（workerCount 设大 → 2*N > fileSets → gate 触发串行；且 Worker 即便可用也被 gate 拦）
  process.env.SQL2JAVA_WORKER_COUNT = "99999"
  const t0 = performance.now()
  const serial = await scanSource(TMP)
  const tSerial = performance.now() - t0
  console.log(`串行: ${serial.packages.length} pkgs, ${serial.subprograms.length} subs, ${serial.tables.length} tables, ${tSerial.toFixed(0)}ms`)

  // 并行（默认 workerCount=min(cores,4)）
  delete process.env.SQL2JAVA_WORKER_COUNT
  const t1 = performance.now()
  const parallel = await scanSource(TMP)
  const tParallel = performance.now() - t1
  console.log(`并行: ${parallel.packages.length} pkgs, ${parallel.subprograms.length} subs, ${parallel.tables.length} tables, ${tParallel.toFixed(0)}ms (scanner=${parallel.scannerUsed})`)

  const sigS = signature(serial)
  const sigP = signature(parallel)
  const match = sigS === sigP
  console.log(`\n深度相等（packages/subprograms/tables 签名）: ${match ? "✓ 一致" : "✗ 不一致"}`)
  if (!match) {
    console.log("--- serial ---"); console.log(sigS.slice(0, 2000))
    console.log("--- parallel ---"); console.log(sigP.slice(0, 2000))
    process.exit(1)
  }
  console.log(`加速比: ${(tSerial / tParallel).toFixed(2)}x (串行 ${tSerial.toFixed(0)}ms / 并行 ${tParallel.toFixed(0)}ms)`)

  rmSync(TMP, { recursive: true, force: true })
}

main().catch(e => { console.error(e); process.exit(1) })
