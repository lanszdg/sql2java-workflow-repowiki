/**
 * build-dependency-signatures.test.ts — 依赖签名预注入测试（Phase 2 translate）
 *
 * 验证 buildDependencySignaturesBlock 按 callGraph 把本分片 unit 调用的、已完成 unit 的 Java 方法签名
 * 内联到 workOrder；未完成目标标 TODO；第一分片无依赖返回空串。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildDependencySignaturesBlock } from "@plugins/workflow-engine"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dep-sig-"))
})

function writeAnalysis(art: string, callGraph: Record<string, string[]>) {
  writeFileSync(join(art, "analysis.json"), JSON.stringify({ callGraph, functionOwnership: {} }), "utf-8")
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
    writeAnalysis(art, { "PKG_A.proc1": ["PKG_B.other"] })
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
    writeAnalysis(art, { "PKG_A.proc2": ["PKG_A.proc1"] })
    writeAggregatedTranslation(art, "PKG_A", [
      { oracleName: "proc1", javaClass: "com.x.AService", javaMethod: "proc1", javaFile: null },
    ])

    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc2"], ["PKG_A.proc1"])
    expect(block).toContain("PKG_A.proc1 → com.x.AService#proc1")
  })

  it("跨包未完成依赖：标 TODO（拓扑序在后的目标）", () => {
    const art = join(dir, "c")
    mkdirSync(art, { recursive: true })
    writeAnalysis(art, { "PKG_A.proc1": ["PKG_C.unfinished"] })
    // PKG_C 未完成，无聚合 translation.json

    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], []) // PKG_C 未在 completed
    expect(block).toContain("// TODO")
    expect(block).toContain("PKG_C.unfinished")
    expect(block).not.toContain("com.")
  })

  it("已完成包但无匹配子程序签名：标 TODO", () => {
    const art = join(dir, "d")
    mkdirSync(art, { recursive: true })
    writeAnalysis(art, { "PKG_A.proc1": ["PKG_B.missing_method"] })
    writeAggregatedTranslation(art, "PKG_B", [
      { oracleName: "other", javaClass: "com.x.BService", javaMethod: "other" },
    ])

    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["PKG_B.someunit"])
    expect(block).toContain("// TODO")
    expect(block).toContain("PKG_B.missing_method")
  })

  it("第一分片无依赖（callGraph 空 / 无 callee）→ 返回空串", () => {
    const art = join(dir, "e")
    mkdirSync(art, { recursive: true })
    writeAnalysis(art, {})
    expect(buildDependencySignaturesBlock(art, ["PKG_A.proc1"], [])).toBe("")
  })

  it("空 targetUnits → 返回空串", () => {
    const art = join(dir, "f")
    mkdirSync(art, { recursive: true })
    writeAnalysis(art, { "PKG_A.proc1": ["PKG_B.other"] })
    expect(buildDependencySignaturesBlock(art, [], ["PKG_B.other"])).toBe("")
  })

  it("大小写不敏感：callGraph 大小写与 completedUnitIds 不一致仍命中", () => {
    const art = join(dir, "g")
    mkdirSync(art, { recursive: true })
    writeAnalysis(art, { "PKG_A.proc1": ["PKG_B.other"] }) // callGraph 大写 PKG_B
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
    writeAnalysis(art, { "PKG_A.proc1": ["PKG_B.other"] })
    // PKG_B 标记为已完成但聚合文件不存在
    expect(() => buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["PKG_B.other"])).not.toThrow()
    const block = buildDependencySignaturesBlock(art, ["PKG_A.proc1"], ["PKG_B.other"])
    expect(block).toContain("// TODO")
  })
})
