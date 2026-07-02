/**
 * analysis-builder-bare-name.test.ts — 同包 bare-name 调用边补全回归测试（feat/proc-entry-scope D）
 *
 * 新形状：directCalls 由 listener 从 AST 抽取（enterCall_statement 捕获过程调用语句，
 * enterGeneral_element 捕获函数调用）。本测试构造一个含裸名调用的包，断言 callGraph 正确建边
 * 且无幻边/自环污染。callGraph 由 buildDependencyGraph 从 subprograms.directCalls 按需推导。
 */
import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraph } from "@workflow/dependency-graph"

let dir: string
let graph: ReturnType<typeof buildDependencyGraph>

const BODY = `CREATE OR REPLACE PACKAGE BARE_PKG AS
  PROCEDURE entry_proc;
  PROCEDURE helper_proc;
  PROCEDURE do_thing(p_id NUMBER);
END BARE_PKG;
/
CREATE OR REPLACE PACKAGE BODY BARE_PKG AS
  PROCEDURE entry_proc IS
  BEGIN
    helper_proc;
    do_thing(1);
    OTHER_PKG.cross_call;
  END;
  PROCEDURE helper_proc IS BEGIN NULL; END;
  PROCEDURE do_thing(p_id NUMBER) IS BEGIN NULL; END;
END BARE_PKG;
/
`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bare-name-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "bare_pkg_body.sql"), BODY, "utf-8")
  const index = await scanSource(dir)
  writeFileSync(join(dir, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
  buildInventoryFromIndex(dir)
  graph = buildDependencyGraph(dir)
}, 30000)

describe("analysis-builder bare-name 边补全", () => {

  it("entry_proc 裸名调用 helper_proc 建边（无参语句形式 `helper_proc;`）", () => {
    expect(graph.callGraph["BARE_PKG.ENTRY_PROC"]).toContain("BARE_PKG.HELPER_PROC")
  })

  it("entry_proc 裸名调用 do_thing 建边（带参 `do_thing(...)`）", () => {
    expect(graph.callGraph["BARE_PKG.ENTRY_PROC"]).toContain("BARE_PKG.DO_THING")
  })

  it("OTHER_PKG.cross_call 不产生 BARE_PKG 内裸边（点号调用 + 包不在 inventory）", () => {
    const callees = graph.callGraph["BARE_PKG.ENTRY_PROC"] ?? []
    expect(callees).not.toContain("BARE_PKG.CROSS_CALL")
    expect(callees.some((c: string) => c.startsWith("OTHER_PKG."))).toBe(false)
  })

  it("过程声明 `procedure do_thing(...)` 不误判为调用（无 do_thing→do_thing 自环）", () => {
    const callees = graph.callGraph["BARE_PKG.DO_THING"] ?? []
    expect(callees).not.toContain("BARE_PKG.DO_THING")
  })

  it("helper_proc / do_thing 无出边（叶子，不被 entry 之外的调用）", () => {
    expect(graph.callGraph["BARE_PKG.HELPER_PROC"] ?? []).toEqual([])
    expect(graph.callGraph["BARE_PKG.DO_THING"] ?? []).toEqual([])
  })

  it("procedureOrder 含全部 3 个 unit 且无 SCC 膨胀（无幻边成环）", () => {
    const units = graph.procedureOrder.flat()
    expect(units.sort()).toEqual(["BARE_PKG.DO_THING", "BARE_PKG.ENTRY_PROC", "BARE_PKG.HELPER_PROC"])
    expect(graph.sccGroups).toEqual([])
  })
})
