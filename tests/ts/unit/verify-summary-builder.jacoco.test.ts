/**
 * verify-summary-builder.jacoco.test.ts — JaCoCo 覆盖率解析与门禁测试
 *
 * 覆盖 buildVerifySummary 的覆盖率链路：
 *   - jacoco.xml 解析（class 级 counter + sourcefile 行级 gap）
 *   - 归因到 Oracle 包
 *   - coverage.passed 判定（行 90% / 分支 75%）+ 纳入 allPassed
 *   - coverage-gaps.md 三段内容（未覆盖明细 / 未纳入统计范围 / 汇总）
 *   - 无 jacoco.xml 时跳过（不阻断）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildVerifySummary } from "@workflow/verify-summary-builder"

let dir: string
let projectRoot: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-jacoco-"))
  projectRoot = mkdtempSync(join(tmpdir(), "proj-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
})

/** 造 scaffold/inventory/plan/translation + projectRoot 指向真实临时目录 */
function setup(packages: string[], files: Record<string, string[]>) {
  writeFileSync(join(dir, "scaffold.json"), JSON.stringify({ projectRoot }), "utf-8")
  writeFileSync(join(dir, "inventory.json"), JSON.stringify({ packageNames: packages }), "utf-8")
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ packageMappings: [] }), "utf-8")
  for (const pkg of packages) {
    mkdirSync(join(dir, "translations", pkg), { recursive: true })
    writeFileSync(
      join(dir, "translations", pkg, "translation.json"),
      JSON.stringify({ packageName: pkg, files: (files[pkg] ?? []).map(p => ({ path: p, role: "aggregate" })) }),
      "utf-8",
    )
  }
}

function writeCompileLog(content: string) {
  writeFileSync(join(dir, "verify-compile.log"), content, "utf-8")
}
function writeTestLog(content: string) {
  writeFileSync(join(dir, "verify-test.log"), content, "utf-8")
}
function writeJacocoXml(xml: string) {
  mkdirSync(join(projectRoot, "target", "site", "jacoco"), { recursive: true })
  writeFileSync(join(projectRoot, "target", "site", "jacoco", "jacoco.xml"), xml, "utf-8")
}

/** 造一个被 jacoco excludes 排除的类文件，验证 coverage-gaps.md 第 2 段 */
function writeExcludedClasses() {
  const base = join(projectRoot, "src", "main", "java", "com", "example")
  mkdirSync(join(base, "common", "infrastructure"), { recursive: true })
  writeFileSync(join(base, "common", "infrastructure", "TranFailException.java"), "package com.example.common.infrastructure;", "utf-8")
  mkdirSync(join(base, "beans"), { recursive: true })
  writeFileSync(join(base, "beans", "OrderBean.java"), "package com.example.beans;", "utf-8")
  writeFileSync(join(base, "AppConfig.java"), "package com.example;", "utf-8")
  writeFileSync(join(base, "OrderSystemApplication.java"), "package com.example;", "utf-8")
}

const XML_FULL = `<?xml version="1.0"?>
<report name="proj">
  <package name="com/example/a">
    <class name="com/example/a/AAggregate" sourcefilename="AAggregate.java">
      <counter type="LINE" missed="0" covered="5"/>
      <counter type="BRANCH" missed="0" covered="4"/>
    </class>
    <sourcefile name="AAggregate.java">
      <line nr="10" mi="0" ci="2" mb="0" cb="2"/>
      <line nr="20" mi="0" ci="3" mb="0" cb="2"/>
    </sourcefile>
  </package>
</report>`

const XML_PARTIAL = `<?xml version="1.0"?>
<report name="proj">
  <package name="com/example/a">
    <class name="com/example/a/AAggregate" sourcefilename="AAggregate.java">
      <counter type="LINE" missed="2" covered="3"/>
      <counter type="BRANCH" missed="1" covered="1"/>
    </class>
    <sourcefile name="AAggregate.java">
      <line nr="20" mi="2" ci="0" mb="0" cb="0"/>
      <line nr="21" mi="0" ci="3" mb="1" cb="0"/>
    </sourcefile>
  </package>
</report>`

describe("buildVerifySummary — JaCoCo 覆盖率", () => {
  it("jacoco.xml 全覆盖 → coverage.passed=true, allPassed=true（编译测试都过）", () => {
    setup(["PKG_A"], { PKG_A: ["src/main/java/com/example/a/AAggregate.java"] })
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 2, Failures: 0, Errors: 0, Skipped: 0")
    writeJacocoXml(XML_FULL)
    const r = buildVerifySummary(dir)
    expect(r.coveragePassed).toBe(true)
    expect(r.allPassed).toBe(true)
    expect(r.lineRate).toBe(1)
    expect(r.branchRate).toBe(1)
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(summary.coverage.executed).toBe(true)
    expect(summary.coverage.passed).toBe(true)
  })

  it("jacoco.xml 有未覆盖 → coverage.passed=false, allPassed=false, 对应包 passed=false", () => {
    setup(["PKG_A"], { PKG_A: ["src/main/java/com/example/a/AAggregate.java"] })
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 2, Failures: 0, Errors: 0, Skipped: 0")
    writeJacocoXml(XML_PARTIAL)
    const r = buildVerifySummary(dir)
    expect(r.coveragePassed).toBe(false)
    expect(r.allPassed).toBe(false) // 编译测试全过但覆盖率不达标 → 整体 failed
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(summary.coverage.passed).toBe(false)
    expect(summary.packageResults[0].passed).toBe(false) // 覆盖率不达标包并入 passed=false
    // line missed=2 covered=3 → 0.6；branch missed=1 covered=1 → 0.5
    expect(summary.coverage.lineRate).toBeCloseTo(0.6, 5)
    expect(summary.coverage.branchRate).toBeCloseTo(0.5, 5)
  })

  it("coverage-gaps.md 含未覆盖明细 + 被排除范围 + 汇总", () => {
    setup(["PKG_A"], { PKG_A: ["src/main/java/com/example/a/AAggregate.java"] })
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 2, Failures: 0, Errors: 0, Skipped: 0")
    writeJacocoXml(XML_PARTIAL)
    writeExcludedClasses()
    buildVerifySummary(dir)
    const md = readFileSync(join(dir, "coverage-gaps.md"), "utf-8")
    // 段 1：未覆盖明细
    expect(md).toContain("## 1. 未覆盖明细")
    expect(md).toContain("com.example.a.AAggregate")
    expect(md).toContain("行 20") // line gap
    expect(md).toContain("分支未覆盖") // branch gap
    // 段 2：未纳入统计的范围
    expect(md).toContain("## 2. 未纳入统计的范围")
    expect(md).toContain("TranFailException.java")
    expect(md).toContain("OrderBean.java")
    expect(md).toContain("AppConfig.java")
    expect(md).toContain("OrderSystemApplication.java")
    // 段 3：汇总
    expect(md).toContain("## 3. 汇总")
    expect(md).toContain("❌ 否")
  })

  it("coverage-gaps.md 达标时第 1 段显示无未覆盖项", () => {
    setup(["PKG_A"], { PKG_A: ["src/main/java/com/example/a/AAggregate.java"] })
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 2, Failures: 0, Errors: 0, Skipped: 0")
    writeJacocoXml(XML_FULL)
    buildVerifySummary(dir)
    const md = readFileSync(join(dir, "coverage-gaps.md"), "utf-8")
    expect(md).toContain("所有包覆盖率达标，无未覆盖项")
    expect(md).toContain("✅ 是")
  })

  it("无 jacoco.xml → coverage.executed=false, passed=true 不阻断, coverage-gaps.md 写跳过说明", () => {
    setup(["PKG_A"], { PKG_A: ["src/main/java/com/example/a/AAggregate.java"] })
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 2, Failures: 0, Errors: 0, Skipped: 0")
    // 不写 jacoco.xml
    const r = buildVerifySummary(dir)
    expect(r.coveragePassed).toBe(null)
    expect(r.allPassed).toBe(true) // 跳过不阻断
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(summary.coverage.executed).toBe(false)
    expect(summary.coverage.passed).toBe(true)
    const md = readFileSync(join(dir, "coverage-gaps.md"), "utf-8")
    expect(md).toContain("覆盖率统计已跳过")
  })

  it("未归因到包的 class 进 GLOBAL，coverage-gaps.md 列出", () => {
    setup(["PKG_A"], { PKG_A: ["src/main/java/com/example/a/AAggregate.java"] })
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 2, Failures: 0, Errors: 0, Skipped: 0")
    // 这个 class 不属于任何包（路径不匹配 translation.json files[]）
    const xml = `<?xml version="1.0"?>
<report name="proj">
  <package name="com/example/orphan">
    <class name="com/example/orphan/Orphan" sourcefilename="Orphan.java">
      <counter type="LINE" missed="3" covered="0"/>
      <counter type="BRANCH" missed="0" covered="0"/>
    </class>
    <sourcefile name="Orphan.java">
      <line nr="5" mi="3" ci="0" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`
    writeJacocoXml(xml)
    const r = buildVerifySummary(dir)
    expect(r.coveragePassed).toBe(false)
    const md = readFileSync(join(dir, "coverage-gaps.md"), "utf-8")
    expect(md).toContain("GLOBAL")
    expect(md).toContain("com.example.orphan.Orphan")
  })
})
