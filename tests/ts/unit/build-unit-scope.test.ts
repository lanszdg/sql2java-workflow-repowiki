/**
 * build-unit-scope.test.ts — 分片「单元读取清单」生成测试
 *
 * 验证 buildUnitScopeBlock 按 subprograms.bodyLocation + 依赖图.functionOwnership
 * 为每个 targetUnit 输出精准的切片目录 + cargo FUNCTION + FSD/依赖路径。
 *
 * 新形状：functionOwnership 由 buildDependencyGraph 从 subprograms.directCalls 按需推导（不再读 dependency-graph.json）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildUnitScopeBlock } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unit-scope-"))
})

/** 写 subprograms/{pkg}.{refName}.json（name 可与 refName 不同，支持重载）+ 兜底 packages/{pkg}.json */
function writeSub(
  art: string, pkg: string, refName: string, name: string,
  type: "PROCEDURE" | "FUNCTION",
  directCalls: Array<{ package: string; name: string; line: number; kind: "function" | "procedure" }> = [],
) {
  mkdirSync(join(art, "subprograms"), { recursive: true })
  mkdirSync(join(art, "packages"), { recursive: true })
  writeFileSync(join(art, "subprograms", `${pkg}.${refName}.json`), JSON.stringify({
    name, type, belongToPackage: pkg, overloadIndex: null, isPrivate: false,
    headerLocation: null, bodyLocation: { absolutePath: `${pkg}.sql`, lineRange: [1, 1] },
    parameters: [], returnType: type === "FUNCTION" ? "VARCHAR2" : null, loc: 1, directCalls,
  }), "utf-8")
  const p = join(art, "packages", `${pkg}.json`)
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify({
      packageName: pkg, absolutePaths: [], headerPath: null, bodyPath: null,
      constants: [], variables: [], exceptions: [], types: [], functions: [], procedures: [], estimatedLoc: 0,
    }), "utf-8")
  }
}

describe("buildUnitScopeBlock", () => {
  it("analyze：切片目录 + cargo FSD 输出路径（Phase 1 切片模式，不再 sed -n）", () => {
    const art = join(dir, "a")
    mkdirSync(art, { recursive: true })
    // proc1 调 calc_total（FUNCTION）→ 推导 calc_total 归属 proc1（cargo）
    writeSub(art, "PKG_A", "proc1", "proc1", "PROCEDURE", [{ package: "PKG_A", name: "calc_total", line: 1, kind: "function" }])
    writeSub(art, "PKG_A", "calc_total", "calc_total", "FUNCTION")

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "analyze", [])
    expect(out).toContain("PKG_A.proc1")
    // 切片目录引用（取代 sed -n）
    expect(out).toContain("shard-inputs/PKG_A/proc1/")
    expect(out).toContain("source.sql + inventory-slice.json + meta.json")
    // 输出路径仍精确枚举（含 cargo FSD）
    expect(out).toContain("analysis-packages/PKG_A/proc1.json")
    expect(out).toContain("fsd/PKG_A/proc1.md")
    expect(out).toContain("fsd/PKG_A/calc_total.md")
    expect(out).not.toContain("{cargoRef}")
    // analyze 切片模式不再出现 sed -n / translate 专属的 FSD 输入
    expect(out).not.toContain("sed -n")
    expect(out).not.toContain("FSD 输入")
  })

  it("重载子程序：refName __序号 切片目录对齐", () => {
    const art = join(dir, "b")
    mkdirSync(art, { recursive: true })
    // 两个同名 get → refNamesForPackage 推导 get__1 / get__2
    writeSub(art, "PKG_A", "get__1", "get", "PROCEDURE")
    writeSub(art, "PKG_A", "get__2", "get", "PROCEDURE")

    const out1 = buildUnitScopeBlock(art, ["PKG_A.get__1"], "analyze", [])
    expect(out1).toContain("shard-inputs/PKG_A/get__1/")
    expect(out1).not.toContain("get__2")
    const out2 = buildUnitScopeBlock(art, ["PKG_A.get__2"], "analyze", [])
    expect(out2).toContain("shard-inputs/PKG_A/get__2/")
  })

  it("translate：切片目录 + FSD 输入 + 输出 + 依赖签名引用（Phase 2 切片模式）", () => {
    const art = join(dir, "c")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", "proc1", "PROCEDURE", [{ package: "PKG_B", name: "other", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_B", "other", "other", "PROCEDURE")

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "translate", ["PKG_B.other"])
    // 切片目录（取代 sed -n / 整包）
    expect(out).toContain("shard-inputs/PKG_A/proc1/")
    expect(out).toContain("analysis-slice.json")
    expect(out).toContain("FSD 输入")
    expect(out).toContain("fsd/PKG_A/proc1.md")
    // per-unit 输出
    expect(out).toContain("translations/PKG_A/proc1.json")
    // 依赖签名引用预注入块（不再列 translation.json 路径）
    expect(out).toContain("依赖签名")
    expect(out).not.toContain("sed -n")
    expect(out).not.toContain("依赖聚合 translation")
  })

  it("translate：清单不再列 translation.json 路径（依赖签名由预注入块提供）", () => {
    const art = join(dir, "d")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", "proc1", "PROCEDURE", [{ package: "PKG_C", name: "unfinished", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_C", "unfinished", "unfinished", "PROCEDURE")

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "translate", []) // PKG_C 未完成
    expect(out).not.toContain("translations/PKG_C/translation.json")
    expect(out).not.toContain("translations/PKG_A/translation.json")
    expect(out).toContain("依赖签名")  // 引用预注入块
  })

  it("非 unit 阶段 / 空 targetUnits → 返回空串", () => {
    const art = join(dir, "e")
    mkdirSync(art, { recursive: true })
    expect(buildUnitScopeBlock(art, [], "analyze", [])).toBe("")
    expect(buildUnitScopeBlock(art, ["PKG_A.p1"], "review", [])).toBe("")
  })

  it("translate：清单始终引用依赖签名预注入块（跨包依赖大小写匹配移至 buildDependencySignaturesBlock 测试）", () => {
    const art = join(dir, "f")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", "proc1", "PROCEDURE", [{ package: "PKG_B", name: "other", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_B", "other", "other", "PROCEDURE")

    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "translate", ["pkg_b.other"])
    // 清单只引用预注入块，不列 translation.json 路径（大小写匹配由预注入函数负责）
    expect(out).toContain("依赖签名")
    expect(out).not.toContain("translations/PKG_B/translation.json")
  })

  it("analyze 切片模式：清单引用切片目录，不泄漏相对 bodyPath 路径", () => {
    const art = join(dir, "g")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", "proc1", "PROCEDURE")

    const sourcePath = "/proj/plsql-src"
    const out = buildUnitScopeBlock(art, ["PKG_A.proc1"], "analyze", [], sourcePath)
    // 切片模式：清单只引用切片目录，不出现 sed -n / 相对 bodyPath（源码已由引擎抽进 source.sql）
    expect(out).toContain("shard-inputs/PKG_A/proc1/")
    expect(out).not.toContain("sed -n")
  })
})
