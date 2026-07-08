/**
 * lazy-inventory.test.ts — scanSourceLazy 入口闭包惰性扫描
 *
 * Phase 0 regex 建 包→文件 映射 + 全量表抽取；Phase 1 antlr BFS 文件粒度只解析闭包内文件。
 * 断言：
 *  - 只产闭包内包 artifact（entry + directCall 目标 + packageRef 目标），out-of-closure 包不落盘；
 *  - tables/triggers/views/sequences 全量（DDL 不在包体，BFS 跟不到）；
 *  - directCalls/packageRefs 后过滤在部分闭包上正确（in-closure 边保留）；
 *  - 非过程级 mainEntry 回退全量；入口包不存在硬失败；
 *  - 下游 buildInventoryFromIndex + buildDependencyGraph + computeClosure 在部分产物上一致。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanSource, scanSourceLazy } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraph, clearDependencyGraphCache } from "@workflow/dependency-graph"
import { computeClosure as scopeClosure } from "@workflow/scope-computer"

let dir: string
let srcDir: string
let artifactsDir: string

const CORE_PKG_SQL = `create or replace package core_pkg as
  procedure entry_proc(p_id in number);
end;
/
create or replace package body core_pkg as
  procedure entry_proc(p_id in number) is
    v_limit number := const_pkg.c_max;
    v_ret   number;
  begin
    v_ret := base_pkg.do_work(p_id);
    if v_ret > v_limit then
      v_ret := 0;
    end if;
  end;
end;
/`

const BASE_PKG_SQL = `create or replace package base_pkg as
  function do_work(p_id in number) return number;
end;
/
create or replace package body base_pkg as
  function do_work(p_id in number) return number is
  begin
    return p_id * 2;
  end;
end;
/`

const CONST_PKG_SQL = `create or replace package const_pkg as
  c_max constant number := 100;
end;
/
create or replace package body const_pkg as
end;
/`

const UNUSED_PKG_SQL = `create or replace package unused_pkg as
  procedure unused_proc;
end;
/
create or replace package body unused_pkg as
  procedure unused_proc is
  begin
    null;
  end;
end;
/`

const TABLE_DDL = `create table t_items (
  id number primary key,
  name varchar2(100) not null
);
/`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lazy-inv-"))
  srcDir = join(dir, "src")
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, "core_pkg.sql"), CORE_PKG_SQL, "utf-8")
  writeFileSync(join(srcDir, "base_pkg.sql"), BASE_PKG_SQL, "utf-8")
  writeFileSync(join(srcDir, "const_pkg.sql"), CONST_PKG_SQL, "utf-8")
  writeFileSync(join(srcDir, "unused_pkg.sql"), UNUSED_PKG_SQL, "utf-8")
  writeFileSync(join(srcDir, "t_items.sql"), TABLE_DDL, "utf-8")
  artifactsDir = join(dir, "run1")
  mkdirSync(artifactsDir, { recursive: true })
}, 60000)

afterAll(() => {
  clearDependencyGraphCache()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe("scanSourceLazy 入口闭包惰性扫描", () => {
  it("只解析闭包内包：CORE_PKG + BASE_PKG(directCall) + CONST_PKG(packageRef)，排除 UNUSED_PKG", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir, mainEntry: "CORE_PKG.ENTRY_PROC" })
    const names = new Set(lazy.packages.map(p => p.packageName))
    expect(names.has("CORE_PKG"), "入口包在闭包内").toBe(true)
    expect(names.has("BASE_PKG"), "directCall 目标包拉入闭包").toBe(true)
    expect(names.has("CONST_PKG"), "packageRef 目标包拉入闭包").toBe(true)
    expect(names.has("UNUSED_PKG"), "out-of-closure 包不落盘").toBe(false)
    // 闭包子程序不含 UNUSED_PROC
    expect(lazy.subprograms.some(s => s.belongToPackage === "UNUSED_PKG"), "out-of-closure 子程序不落盘").toBe(false)
    expect(lazy.subprograms.some(s => s.belongToPackage === "BASE_PKG" && s.name === "DO_WORK"), "callee 子程序在闭包内").toBe(true)
  }, 30000)

  it("directCalls/packageRefs 后过滤在闭包内正确保留（in-closure 边不丢）", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir, mainEntry: "CORE_PKG.ENTRY_PROC" })
    const entry = lazy.subprograms.find(s => s.belongToPackage === "CORE_PKG" && s.name === "ENTRY_PROC")!
    expect(entry, "ENTRY_PROC 被扫描").toBeDefined()
    expect(entry.directCalls.some(c => c.package === "BASE_PKG" && c.name === "DO_WORK"),
      "BASE_PKG.DO_WORK 调用边保留（BASE_PKG 在闭包内）").toBe(true)
    expect(entry.packageRefs.some(r => r.package === "CONST_PKG" && r.name === "C_MAX"),
      "CONST_PKG.C_MAX 引用保留（CONST_PKG 在闭包内）").toBe(true)
  }, 30000)

  it("tables 全量抽取（DDL 不在包体，Phase 0 全量扫）", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir, mainEntry: "CORE_PKG.ENTRY_PROC" })
    expect(lazy.tables.some(t => t.name === "T_ITEMS"), "T_ITEMS 表被全量抽取").toBe(true)
  }, 30000)

  it("全量 scanSource 含全部 4 包（对照基线）", async () => {
    const full = await scanSource(srcDir)
    const names = new Set(full.packages.map(p => p.packageName))
    expect(names.has("UNUSED_PKG"), "全量扫描含 UNUSED_PKG").toBe(true)
    expect(full.packages.length, "全量 4 包").toBeGreaterThanOrEqual(4)
  }, 30000)

  it("非过程级 mainEntry（纯包名）回退全量 scanSource", async () => {
    const fb = await scanSourceLazy({ sourcePath: srcDir, mainEntry: "CORE_PKG" })
    expect(fb.packages.some(p => p.packageName === "UNUSED_PKG"), "包级 mainEntry 回退全量，含 UNUSED_PKG").toBe(true)
  }, 30000)

  it("入口包不存在 → 硬失败抛错", async () => {
    await expect(scanSourceLazy({ sourcePath: srcDir, mainEntry: "NOPE_PKG.X" }))
      .rejects.toThrow(/未在源码中找到/)
  }, 30000)

  it("下游链路在部分 inventory 上一致：buildInventoryFromIndex + buildDependencyGraph + computeClosure", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir, mainEntry: "CORE_PKG.ENTRY_PROC" })
    buildInventoryFromIndex(artifactsDir, lazy)

    const g = buildDependencyGraph(artifactsDir)
    // 闭包内包都在依赖图里
    for (const pkg of ["CORE_PKG", "BASE_PKG", "CONST_PKG"]) {
      expect(g.packageNames.map(n => n.toUpperCase()), `${pkg} 在依赖图`).toContain(pkg)
    }
    // UNUSED_PKG 不在依赖图
    expect(g.packageNames.map(n => n.toUpperCase()), "UNUSED_PKG 不在依赖图").not.toContain("UNUSED_PKG")
    // 调用边 CORE_PKG.ENTRY_PROC -> BASE_PKG.DO_WORK 保留
    const callEdges = g.callGraph["CORE_PKG.ENTRY_PROC"] ?? []
    expect(callEdges.some(e => e.startsWith("BASE_PKG.DO_WORK")), "闭包内调用边保留").toBe(true)
    // packageDependency 含 CONST_PKG（const-only 包）
    expect((g.packageDependency["CORE_PKG"] ?? []).some(p => p.toUpperCase() === "CONST_PKG"),
      "const-only 包进 packageDependency").toBe(true)

    // computeClosure 在部分图上算 METHOD 闭包，scopePackages ⊆ lazy 闭包
    const analysis = {
      callGraph: g.callGraph,
      packageDependency: g.packageDependency,
      functionOwnership: g.functionOwnership,
    } as any
    const cl = scopeClosure(analysis, "CORE_PKG.ENTRY_PROC")
    expect(cl.scopePackages, "scope 含闭包内包").toContain("BASE_PKG")
    expect(cl.scopePackages, "scope 含 const-only 包").toContain("CONST_PKG")
    for (const p of cl.scopePackages) {
      expect(p.toUpperCase(), "scope 包都在 lazy 闭包内").not.toBe("UNUSED_PKG")
    }
  }, 30000)

  it("lazy 产物的 inventory.json 经 buildInventoryFromIndex 落盘包名 = 闭包子集", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir, mainEntry: "CORE_PKG.ENTRY_PROC" })
    buildInventoryFromIndex(artifactsDir, lazy)
    // inventory.json.packageNames 应只含闭包内包
    const inv = JSON.parse(readFileSync(join(artifactsDir, "inventory.json"), "utf-8")) as { packageNames: string[] }
    const names = new Set(inv.packageNames.map(n => n.toUpperCase()))
    expect(names.has("UNUSED_PKG"), "inventory.json 不含 out-of-closure 包").toBe(false)
    expect(names.has("CORE_PKG") && names.has("BASE_PKG") && names.has("CONST_PKG"), "含闭包内三包").toBe(true)
  }, 30000)

  it("two-dir 模式（headerPath/bodyPath 分离）闭包正确，且重叠目录不重复抽取", async () => {
    // spec 与 body 分置 header/body 目录；CORE_PKG.ENTRY_PROC 调 base_pkg.do_work
    const headerDir = join(dir, "hdr")
    const bodyDir = join(dir, "body")
    mkdirSync(headerDir, { recursive: true })
    mkdirSync(bodyDir, { recursive: true })
    const spec = `create or replace package core_pkg as procedure entry_proc(p_id in number); end;`
    const body = `create or replace package body core_pkg as
  procedure entry_proc(p_id in number) is begin base_pkg.do_work(p_id); end;
end;`
    const baseSpec = `create or replace package base_pkg as function do_work(p number) return number; end;`
    const baseBody = `create or replace package body base_pkg as function do_work(p number) return number is begin return p; end; end;`
    const unused = `create or replace package unused_pkg as procedure u; end;\ncreate or replace package body unused_pkg as procedure u is begin null; end; end;`
    writeFileSync(join(headerDir, "core_pkg.pks"), spec, "utf-8")
    writeFileSync(join(bodyDir, "core_pkg.pkb"), body, "utf-8")
    writeFileSync(join(headerDir, "base_pkg.pks"), baseSpec, "utf-8")
    writeFileSync(join(bodyDir, "base_pkg.pkb"), baseBody, "utf-8")
    writeFileSync(join(bodyDir, "unused_pkg.pkb"), unused, "utf-8")

    const lazy = await scanSourceLazy({ headerPath: headerDir, bodyPath: bodyDir, mainEntry: "CORE_PKG.ENTRY_PROC" })
    const names = new Set(lazy.packages.map(p => p.packageName))
    expect(names.has("CORE_PKG") && names.has("BASE_PKG"), "two-dir 闭包含入口+被调包").toBe(true)
    expect(names.has("UNUSED_PKG"), "two-dir 排除 out-of-closure").toBe(false)
    // 入口包子程序数 = 1（不因 spec+body 两文件重复）
    const coreSubs = lazy.subprograms.filter(s => s.belongToPackage === "CORE_PKG")
    expect(coreSubs.length, "CORE_PKG 子程序不因 spec/body 分文件而重复").toBe(1)
  }, 30000)
})

// ── 方案 C 断传递：const-leaf 包作叶子，2-hop const 不传递扫描；const-ref 同时被 directCall 则升级为 call-closure ──
//
// CALLER_PKG.ENTRY_PROC:
//   - packageRef MID_PKG.C_MID（1-hop const-leaf，不被调用）
//   - packageRef SHARED_PKG.C_SHARED + directCall SHARED_PKG.DO_SHARED（SHARED_PKG 升级为 call-closure）
// MID_PKG.UNUSED_MID 体里 packageRef LEAF_PKG.C_LEAF（2-hop，断传递不应扫描 LEAF_PKG）
// SHARED_PKG.DO_SHARED directCall DEEP_PKG.DO_DEEP（call-closure 传递可达）
const CALLER_PKG_SQL = `create or replace package caller_pkg as
  procedure entry_proc(p in number);
end;
/
create or replace package body caller_pkg as
  procedure entry_proc(p in number) is
    v_mid    number := mid_pkg.c_mid;
    v_shared number := shared_pkg.c_shared;
  begin
    shared_pkg.do_shared(p);
  end;
end;
/`

const MID_PKG_SQL = `create or replace package mid_pkg as
  c_max constant number := 100;
  procedure unused_mid;
end;
/
create or replace package body mid_pkg as
  procedure unused_mid is
    v number := leaf_pkg.c_leaf;
  begin
    null;
  end;
end;
/`

const LEAF_PKG_SQL = `create or replace package leaf_pkg as
  c_leaf constant number := 1;
end;
/
create or replace package body leaf_pkg as
end;
/`

const SHARED_PKG_SQL = `create or replace package shared_pkg as
  c_shared constant number := 5;
  procedure do_shared(p in number);
end;
/
create or replace package body shared_pkg as
  procedure do_shared(p in number) is
  begin
    deep_pkg.do_deep(p);
  end;
end;
/`

const DEEP_PKG_SQL = `create or replace package deep_pkg as
  procedure do_deep(p in number);
end;
/
create or replace package body deep_pkg as
  procedure do_deep(p in number) is
  begin
    null;
  end;
end;
/`

describe("scanSourceLazy 断传递（方案 C）", () => {
  let srcDir2: string
  let artDir2: string

  beforeAll(() => {
    srcDir2 = join(dir, "src2")
    artDir2 = join(dir, "run2")
    mkdirSync(srcDir2, { recursive: true })
    mkdirSync(artDir2, { recursive: true })
    writeFileSync(join(srcDir2, "caller_pkg.sql"), CALLER_PKG_SQL, "utf-8")
    writeFileSync(join(srcDir2, "mid_pkg.sql"), MID_PKG_SQL, "utf-8")
    writeFileSync(join(srcDir2, "leaf_pkg.sql"), LEAF_PKG_SQL, "utf-8")
    writeFileSync(join(srcDir2, "shared_pkg.sql"), SHARED_PKG_SQL, "utf-8")
    writeFileSync(join(srcDir2, "deep_pkg.sql"), DEEP_PKG_SQL, "utf-8")
  }, 60000)

  afterAll(() => { clearDependencyGraphCache() })

  it("2-hop const 包不传递扫描；1-hop const-leaf 与 call-closure 传递包都扫", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir2, mainEntry: "CALLER_PKG.ENTRY_PROC" })
    const names = new Set(lazy.packages.map(p => p.packageName))
    expect(names.has("CALLER_PKG"), "入口包").toBe(true)
    expect(names.has("MID_PKG"), "1-hop const-leaf 包扫描").toBe(true)
    expect(names.has("SHARED_PKG"), "call-closure 包扫描").toBe(true)
    expect(names.has("DEEP_PKG"), "call-closure 传递包扫描").toBe(true)
    expect(names.has("LEAF_PKG"), "2-hop const 包不传递扫描").toBe(false)
  }, 30000)

  it("const-ref 同时被 directCall → 升级为 call-closure（其 directCalls 被跟随，不卡在 const-leaf）", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir2, mainEntry: "CALLER_PKG.ENTRY_PROC" })
    buildInventoryFromIndex(artDir2, lazy)
    const g = buildDependencyGraph(artDir2)
    const cl = scopeClosure({
      callGraph: g.callGraph,
      packageDependency: g.packageDependency,
      functionOwnership: g.functionOwnership,
    } as any, "CALLER_PKG.ENTRY_PROC")

    // SHARED_PKG 被调用 → call-closure → 进 scopeUnits；其 directCall DEEP_PKG 传递可达
    expect(cl.scopeUnits.some(u => u.startsWith("SHARED_PKG.DO_SHARED")),
      "SHARED_PKG 是 call-closure（被调用，不卡在 const-leaf）").toBe(true)
    expect(cl.scopeUnits.some(u => u.startsWith("DEEP_PKG.DO_DEEP")),
      "DEEP_PKG 经 SHARED_PKG 传递调用可达").toBe(true)
    // MID_PKG 仅 const 引用、未被调用 → const-leaf → 不进 scopeUnits，但进 scopePackages（1-hop）
    expect(cl.scopeUnits.some(u => u.startsWith("MID_PKG.")),
      "MID_PKG 是 const-leaf 不进 scopeUnits").toBe(false)
    expect(cl.scopePackages, "scope 含 1-hop const-leaf MID_PKG").toContain("MID_PKG")
    // LEAF_PKG 2-hop：断传递后不扫描 → 不在 packageDependency → 不进 scopePackages
    expect(cl.scopePackages, "scope 不含 2-hop const LEAF_PKG").not.toContain("LEAF_PKG")
  }, 30000)
})

// ── 跨波次升级：const-leaf 包先被扫（已 visited），后波次经中间包 directCall 触发升级为 call-closure ──
// 验证 fixpoint 读整个 pool + while(changed) 能补收已 visited 升级包的 directCalls（候选#1 漏收顾虑）。
//
// XCALLER_PKG.ENTRY: packageRef MIDC_PKG.C（→ constLeaf，wave2 扫）；directCall BASE2_PKG.DO（→ callClosure）
// BASE2_PKG.DO: directCall MIDC_PKG.USE（wave2 扫 BASE2 时才发现 → 升级 MIDC 为 callClosure）
// MIDC_PKG.USE: directCall DEEP2_PKG.DO_DEEP（升级后须被 fixpoint 补收 → DEEP2 wave3 扫）
const XCALLER_PKG_SQL = `create or replace package xcaller_pkg as
  procedure entry(p in number);
end;
/
create or replace package body xcaller_pkg as
  procedure entry(p in number) is
    v number := midc_pkg.c;
  begin
    base2_pkg.do(p);
  end;
end;
/`

const BASE2_PKG_SQL = `create or replace package base2_pkg as
  procedure do(p in number);
end;
/
create or replace package body base2_pkg as
  procedure do(p in number) is
  begin
    midc_pkg.use(p);
  end;
end;
/`

const MIDC_PKG_SQL = `create or replace package midc_pkg as
  c constant number := 7;
  procedure use(p in number);
end;
/
create or replace package body midc_pkg as
  procedure use(p in number) is
  begin
    deep2_pkg.do_deep(p);
  end;
end;
/`

const DEEP2_PKG_SQL = `create or replace package deep2_pkg as
  procedure do_deep(p in number);
end;
/
create or replace package body deep2_pkg as
  procedure do_deep(p in number) is
  begin
    null;
  end;
end;
/`

describe("scanSourceLazy 跨波次升级（const-leaf → call-closure）", () => {
  let srcDir3: string
  let artDir3: string

  beforeAll(() => {
    srcDir3 = join(dir, "src3")
    artDir3 = join(dir, "run3")
    mkdirSync(srcDir3, { recursive: true })
    mkdirSync(artDir3, { recursive: true })
    writeFileSync(join(srcDir3, "xcaller_pkg.sql"), XCALLER_PKG_SQL, "utf-8")
    writeFileSync(join(srcDir3, "base2_pkg.sql"), BASE2_PKG_SQL, "utf-8")
    writeFileSync(join(srcDir3, "midc_pkg.sql"), MIDC_PKG_SQL, "utf-8")
    writeFileSync(join(srcDir3, "deep2_pkg.sql"), DEEP2_PKG_SQL, "utf-8")
  }, 60000)

  afterAll(() => { clearDependencyGraphCache() })

  it("已 visited 的 const-leaf 包被后波次 directCall 升级后，其 directCalls 被 fixpoint 补收", async () => {
    const lazy = await scanSourceLazy({ sourcePath: srcDir3, mainEntry: "XCALLER_PKG.ENTRY" })
    const names = new Set(lazy.packages.map(p => p.packageName))
    expect(names.has("XCALLER_PKG"), "入口").toBe(true)
    expect(names.has("BASE2_PKG"), "中间 call-closure 包").toBe(true)
    expect(names.has("MIDC_PKG"), "const-leaf 升级为 call-closure").toBe(true)
    // 关键：MIDC_PKG 先以 const-leaf 扫描（wave2 visited），wave2 fixpoint 升级后其 directCall
    // 到 DEEP2_PKG 必须被补收 → DEEP2_PKG 入队 wave3 扫描。若 fixpoint 漏收已 visited 升级包，DEEP2 缺失。
    expect(names.has("DEEP2_PKG"), "升级包的 directCalls 被 fixpoint 补收 → DEEP2 扫描").toBe(true)

    // scope 链路：MIDC_PKG 升级为 call-closure → MIDC_PKG.USE 进 scopeUnits；DEEP2_PKG.DO_DEEP 传递可达
    buildInventoryFromIndex(artDir3, lazy)
    const g = buildDependencyGraph(artDir3)
    const cl = scopeClosure({
      callGraph: g.callGraph,
      packageDependency: g.packageDependency,
      functionOwnership: g.functionOwnership,
    } as any, "XCALLER_PKG.ENTRY")
    expect(cl.scopeUnits.some(u => u.startsWith("MIDC_PKG.USE")),
      "MIDC_PKG 升级后 USE 进 scopeUnits").toBe(true)
    expect(cl.scopeUnits.some(u => u.startsWith("DEEP2_PKG.DO_DEEP")),
      "DEEP2_PKG 经升级包传递可达").toBe(true)
  }, 30000)
})
