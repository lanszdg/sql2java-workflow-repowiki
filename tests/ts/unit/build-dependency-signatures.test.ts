/**
 * build-dependency-signatures.test.ts — 依赖签名预注入测试（Phase 2 translate）
 *
 * 验证 buildDependencySignaturesBlock 按调用图把本分片 unit 调用的、已完成 unit 的 Java 方法签名
 * 内联到 workOrder；未完成目标标 TODO；第一分片无依赖返回空串。
 *
 * 新形状：调用图由 buildDependencyGraph 从 subprograms/*.json 的 directCalls 按需推导（不再读 dependency-graph.json）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildDependencySignaturesBlock } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dep-sig-"))
})

/** 写 subprograms/{pkg}.{name}.json（含 directCalls）+ 兜底 packages/{pkg}.json */
function writeSub(art: string, pkg: string, name: string, directCalls: Array<{ package: string; name: string; line: number; kind: "function" | "procedure" }> = []) {
  mkdirSync(join(art, "subprograms"), { recursive: true })
  mkdirSync(join(art, "packages"), { recursive: true })
  writeFileSync(join(art, "subprograms", `${pkg}.${name}.json`), JSON.stringify({
    name, type: "PROCEDURE", belongToPackage: pkg, overloadIndex: null, isPrivate: false,
    headerLocation: null, bodyLocation: { absolutePath: `${pkg}.sql`, lineRange: [1, 1] },
    parameters: [], returnType: null, loc: 1, directCalls,
  }), "utf-8")
  const p = join(art, "packages", `${pkg}.json`)
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify({
      packageName: pkg, absolutePaths: [], headerPath: null, bodyPath: null,
      constants: [], variables: [], exceptions: [], types: [], functions: [], procedures: [], estimatedLoc: 0,
    }), "utf-8")
  }
}

function writeAggregatedTranslation(art: string, pkg: string, methods: Array<Record<string, unknown>>) {
  mkdirSync(join(art, "translations", pkg), { recursive: true })
  writeFileSync(join(art, "translations", pkg, "translation.json"), JSON.stringify({
    packageName: pkg, status: "completed", subprogramMethods: methods,
  }), "utf-8")
}

describe("buildDependencySignaturesBlock", () => {
  it("跨包已完成依赖：内联真实方法签名", () => {
    const art = join(dir, "a")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", [{ package: "PKG_B", name: "other", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_B", "other")
    writeAggregatedTranslation(art, "PKG_B", [
      { oracleName: "other", javaClass: "com.x.BService", javaMethod: "other", javaFile: "src/BService.java" },
    ])

    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["PKG_B.other"])
    expect(block).toContain("依赖签名")
    expect(block).toContain("PKG_A.proc1 调用")
    expect(block).toContain("PKG_B.other → com.x.BService#other")
    expect(block).toContain("src/BService.java")
    expect(block).not.toContain("// TODO") // 无 TODO 占位行（header 文本含 "TODO" 字样属正常）
  })

  it("同包跨单元依赖：读本包聚合 translation.json", () => {
    const art = join(dir, "b")
    mkdirSync(art, { recursive: true })
    // PKG_A.proc2 调用同包 PKG_A.proc1（prior unit，已完成）
    writeSub(art, "PKG_A", "proc2", [{ package: "PKG_A", name: "proc1", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_A", "proc1")
    writeAggregatedTranslation(art, "PKG_A", [
      { oracleName: "proc1", javaClass: "com.x.AService", javaMethod: "proc1", javaFile: null },
    ])

    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc2"], ["PKG_A.proc1"])
    expect(block).toContain("PKG_A.proc1 → com.x.AService#proc1")
  })

  it("跨包未完成依赖：标 TODO（拓扑序在后的目标）", () => {
    const art = join(dir, "c")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", [{ package: "PKG_C", name: "unfinished", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_C", "unfinished")
    // PKG_C 未完成，无聚合 translation.json

    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], []) // PKG_C 未在 completed
    expect(block).toContain("// TODO")
    expect(block).toContain("PKG_C.unfinished")
    expect(block).not.toContain("com.")
  })

  it("已完成包但无匹配子程序签名：标 TODO", () => {
    const art = join(dir, "d")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", [{ package: "PKG_B", name: "missing_method", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_B", "missing_method")
    writeAggregatedTranslation(art, "PKG_B", [
      { oracleName: "other", javaClass: "com.x.BService", javaMethod: "other" },
    ])

    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["PKG_B.someunit"])
    expect(block).toContain("// TODO")
    expect(block).toContain("PKG_B.missing_method")
  })

  it("第一分片无依赖（无 callee）→ 返回空串", () => {
    const art = join(dir, "e")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1") // 无 directCalls
    expect(buildDependencySignaturesBlock(art, ["PKG_A.proc1"], [])).toBe("")
  })

  it("空 targetUnits → 返回空串", () => {
    const art = join(dir, "f")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", [{ package: "PKG_B", name: "other", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_B", "other")
    expect(buildDependencySignaturesBlock(art, [], ["PKG_B.other"])).toBe("")
  })

  it("大小写不敏感：directCalls 与 completedUnitIds 大小写不一致仍命中", () => {
    const art = join(dir, "g")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", [{ package: "PKG_B", name: "other", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_B", "other")
    writeAggregatedTranslation(art, "PKG_B", [
      { oracleName: "other", javaClass: "com.x.BService", javaMethod: "other" },
    ])
    // completedUnitIds 用小写 pkg_b.other（scanner 大小写变体）——大小写不敏感应仍命中
    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["pkg_b.other"])
    expect(block).toContain("com.x.BService#other")
  })

  it("translation.json 不存在/损坏：该 callee 标 TODO，不抛错", () => {
    const art = join(dir, "h")
    mkdirSync(art, { recursive: true })
    writeSub(art, "PKG_A", "proc1", [{ package: "PKG_B", name: "other", line: 1, kind: "procedure" }])
    writeSub(art, "PKG_B", "other")
    // PKG_B 标记为已完成但聚合文件不存在
    expect(() => buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["PKG_B.other"])).not.toThrow()
    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["PKG_B.other"])
    expect(block).toContain("// TODO")
  })
})
