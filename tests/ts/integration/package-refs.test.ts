/**
 * package-refs.test.ts — 项1：跨包非调用引用（pkg.const / pkg.type）端到端
 *
 * scanner 捕获 packageRefs → dependency-graph 聚合进 packageDependency（不进 callGraph）
 * → scope-computer 闭包 scopePackages 纳入「仅常量/类型被引用」的包。
 * 修复：const-only 包此前漏入闭包，translate 看不到所需常量/类型定义。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraph, clearDependencyGraphCache } from "@workflow/dependency-graph"
import { computeClosure as scopeClosure } from "@workflow/scope-computer"

let dir: string
let artifactsDir: string

const CONST_PKG_SQL = `create or replace package const_pkg as
  c_max constant number := 100;
  type t_rec is record (id number, name varchar2(50));
end;
/
create or replace package body const_pkg as
end;
/`

const CALLER_PKG_SQL = `create or replace package caller_pkg as
  procedure use_const(p_id in number);
end;
/
create or replace package body caller_pkg as
  procedure use_const(p_id in number) is
    v_limit number := const_pkg.c_max;
    v_row   const_pkg.t_rec;
  begin
    if p_id > v_limit then
      v_row.id := p_id;
    end if;
  end;
end;
/`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pkg-refs-"))
  const srcDir = join(dir, "src")
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, "const_pkg.sql"), CONST_PKG_SQL, "utf-8")
  writeFileSync(join(srcDir, "caller_pkg.sql"), CALLER_PKG_SQL, "utf-8")

  artifactsDir = join(dir, "run1")
  mkdirSync(artifactsDir, { recursive: true })
  const index = await scanSource(srcDir)
  writeFileSync(join(artifactsDir, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
  buildInventoryFromIndex(artifactsDir)
}, 60000)

afterAll(() => {
  clearDependencyGraphCache()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe("跨包非调用引用 packageRefs", () => {
  it("scanner 捕获 const_pkg.c_max / const_pkg.t_rec 为 packageRefs，不计入 directCalls", async () => {
    const inv = await scanSource(join(dir, "src"))
    const useConst = inv.subprograms.find(s => s.name === "USE_CONST" && s.belongToPackage === "CALLER_PKG")
    expect(useConst, "USE_CONST 子程序应被扫描").toBeDefined()
    const refs = useConst!.packageRefs.filter(r => r.package === "CONST_PKG")
    expect(refs.some(r => r.name === "C_MAX"), "应捕获 const_pkg.c_max 引用").toBe(true)
    expect(refs.some(r => r.name === "T_REC"), "应捕获 const_pkg.t_rec 引用").toBe(true)
    // 非调用引用不应进入 directCalls
    expect(useConst!.directCalls.some(d => d.package === "CONST_PKG"), "const/type 引用不应进 directCalls").toBe(false)
  })

  it("dependency-graph 把 packageRefs 聚合进 packageDependency（不进 callGraph）", () => {
    const g = buildDependencyGraph(artifactsDir)
    expect(g.packageDependency["CALLER_PKG"]).toContain("CONST_PKG")
    // callGraph 不应含 const/type 引用边（USE_CONST 无调用出边）
    const callEdges = g.callGraph["CALLER_PKG.USE_CONST"] ?? []
    expect(callEdges.some(e => e.startsWith("CONST_PKG.")), "callGraph 不应含 const 引用边").toBe(false)
  })

  it("scope-computer 闭包 scopePackages 纳入 const-only 包 CONST_PKG", () => {
    const g = buildDependencyGraph(artifactsDir)
    const analysis = {
      callGraph: g.callGraph,
      packageDependency: g.packageDependency,
      functionOwnership: g.functionOwnership,
    } as any
    const cl = scopeClosure(analysis, "CALLER_PKG.USE_CONST")
    expect(cl.scopePackages).toContain("CONST_PKG")
    expect(cl.scopeUnits).toContain("CALLER_PKG.USE_CONST")
  })

  it("localRecord.field 不误捕为 packageRef（后过滤按已知包名收窄）", async () => {
    const localSql = `create or replace package localref_pkg as
  procedure p;
end;
/
create or replace package body localref_pkg as
  procedure p is
    type t_inner is record (a number, b number);
    v t_inner;
  begin
    v.a := 1;
    v.b := 2;
  end;
end;
/`
    const tmp = mkdtempSync(join(tmpdir(), "pkg-refs-local-"))
    try {
      writeFileSync(join(tmp, "localref_pkg.sql"), localSql, "utf-8")
      const inv = await scanSource(tmp)
      const p = inv.subprograms.find(s => s.name === "P" && s.belongToPackage === "LOCALREF_PKG")
      expect(p, "P 子程序应被扫描").toBeDefined()
      // V / T_INNER 都不是已知包 → packageRefs 应为空
      expect(p!.packageRefs.every(r => r.package !== "V" && r.package !== "T_INNER")).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 30000)

  it("跨包函数调用 pkg.func(args) 进 directCall 且包限定符进 packageRefs（修复递归 grammar 丢前缀）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pkg-refs-call-"))
    const sql = `create or replace package other_pkg as function get_val(p number) return number; end;
/
create or replace package body other_pkg as
function get_val(p number) return number is begin return p; end;
end;
/
create or replace package caller_pkg as procedure do_it; end;
/
create or replace package body caller_pkg as
procedure do_it is v number;
begin v := other_pkg.get_val(1); end;
end;
/`
    try {
      writeFileSync(join(tmp, "call_pkg.sql"), sql, "utf-8")
      const inv = await scanSource(tmp)
      const d = inv.subprograms.find(s => s.name === "DO_IT" && s.belongToPackage === "CALLER_PKG")
      expect(d, "DO_IT 子程序应被扫描").toBeDefined()
      // directCall 应含跨包调用边（修复前因递归 grammar 丢前缀被记成裸名遭丢弃）
      expect(d!.directCalls.some(c => c.package === "OTHER_PKG" && c.name === "GET_VAL"), "directCall 应捕获跨包调用").toBe(true)
      // packageRefs 也应含该包限定符（保证 packageDependency 边）
      expect(d!.packageRefs.some(r => r.package === "OTHER_PKG"), "packageRefs 应含被调用包").toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 30000)

  it("dotted 包名（fm.xxx）的常量/类型引用以 lastIndexOf 拆限定符（修复 split[0] 误取 schema/首段）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pkg-refs-dot-"))
    const sql = `create or replace package fm.xxx as
  c_max constant number := 100;
  type t_rec is record (id number);
end;
/
create or replace package body fm.xxx as end;
/
create or replace package caller_pkg as procedure use_const; end;
/
create or replace package body caller_pkg as
procedure use_const is
  v_limit number := fm.xxx.c_max;
  v_row   fm.xxx.t_rec;
begin null; end;
end;
/`
    try {
      writeFileSync(join(tmp, "dot_pkg.sql"), sql, "utf-8")
      const inv = await scanSource(tmp)
      expect(inv.packages.map(p => p.packageName)).toContain("FM.XXX")
      const u = inv.subprograms.find(s => s.name === "USE_CONST" && s.belongToPackage === "CALLER_PKG")
      expect(u, "USE_CONST 子程序应被扫描").toBeDefined()
      // 限定符应为 FM.XXX（dotted 包名整体），而非首段 FM
      const refs = u!.packageRefs.filter(r => r.package === "FM.XXX")
      expect(refs.some(r => r.name === "C_MAX"), "应捕获 fm.xxx.c_max（包限定符=FM.XXX）").toBe(true)
      expect(refs.some(r => r.name === "T_REC"), "应捕获 fm.xxx.t_rec（包限定符=FM.XXX）").toBe(true)
      expect(u!.packageRefs.some(r => r.package === "FM"), "不应把首段 FM 当作包限定符").toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 30000)

  it("类型构造 pkg.t_rec_type(...) / 集合访问 pkg.g_array(i) 的包限定符进 packageRefs（directCall 丢弃但包依赖保留）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pkg-refs-ctor-"))
    const sql = `create or replace package other_pkg as
  type t_rec is record (id number);
  g_arr dbms_sql.varchar2_table;
  function real_fn return number;
end;
/
create or replace package body other_pkg as
function real_fn return number is begin return 0; end;
end;
/
create or replace package caller_pkg as procedure p; end;
/
create or replace package body caller_pkg as
procedure p is
  v other_pkg.t_rec;
  n number;
begin
  v := other_pkg.t_rec(1);
  n := other_pkg.g_arr(1);
end;
end;
/`
    try {
      writeFileSync(join(tmp, "ctor_pkg.sql"), sql, "utf-8")
      const inv = await scanSource(tmp)
      const p = inv.subprograms.find(s => s.name === "P" && s.belongToPackage === "CALLER_PKG")
      expect(p, "P 子程序应被扫描").toBeDefined()
      // T_REC / G_ARR 非子程序 → directCall 后过滤丢弃；但包限定符 OTHER_PKG 应进 packageRefs
      expect(p!.packageRefs.some(r => r.package === "OTHER_PKG"), "构造/集合访问的包限定符应进 packageRefs").toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 30000)
})
