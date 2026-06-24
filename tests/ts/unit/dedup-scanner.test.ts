/**
 * dedup-scanner.test.ts — PMD CPD 解析 + 规则覆盖 + 文件索引 单测
 *
 * 测纯函数（parseCpdXml / applyRules / buildFileIndex），mock CPD XML 输出，不依赖真实 mvn/PMD。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseCpdXml, applyRules, buildFileIndex, parseMavenVersion, parseJavaMajor, cmpVersion, MIN_JDK, MIN_MAVEN, type DupGroup } from "@workflow/dedup-scanner"

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "dedup-scan-")) })

function idxEntry(projectRoot: string, pkg: string, role: string, relFile: string) {
  return [join(projectRoot, relFile), { packageName: pkg, role, absPath: join(projectRoot, relFile) }] as const
}

describe("parseCpdXml", () => {
  it("解析 <duplication> 组：sources + category(file role) + diffScore=0", () => {
    const projectRoot = "/proj"
    const idx = new Map<string, any>([
      idxEntry(projectRoot, "PKG_A", "dto", "src/main/java/a/FooDto.java"),
      idxEntry(projectRoot, "PKG_B", "dto", "src/main/java/b/FooDto.java"),
    ])
    const xml = `<?xml version="1.0"?>
<pmd-cpd>
<duplication lines="10" tokens="80">
<file line="5" path="/proj/src/main/java/a/FooDto.java"/>
<file line="7" path="/proj/src/main/java/b/FooDto.java"/>
<codefragment>...</codefragment>
</duplication>
</pmd-cpd>`
    const groups = parseCpdXml(xml, idx, projectRoot)
    expect(groups.length).toBe(1)
    const g = groups[0]
    expect(g.category).toBe("dto")
    expect(g.diffScore).toBe(0)
    expect(g.sources.map(s => s.packageName).sort()).toEqual(["PKG_A", "PKG_B"])
    expect(g.sources[0].startLine).toBe(5)
    expect(g.sources[0].tokens).toBe(80)
    // file 路径归一为相对 projectRoot
    expect(g.sources[0].file).toBe("src/main/java/a/FooDto.java")
  })

  it("未匹配文件索引的路径 → packageName=UNKNOWN，category=unknown", () => {
    const idx = new Map<string, any>()
    const xml = `<pmd-cpd><duplication lines="5" tokens="60">
<file line="1" path="/proj/src/main/java/x/Orphan.java"/>
</duplication></pmd-cpd>`
    const groups = parseCpdXml(xml, idx, "/proj")
    expect(groups[0].sources[0].packageName).toBe("UNKNOWN")
    expect(groups[0].category).toBe("unknown")
  })
})

describe("applyRules", () => {
  const projectRoot = "/proj"

  function groupOf(packages: string[], file: string, role = "dto"): DupGroup {
    return {
      id: "dup-1",
      category: role,
      sources: packages.map(p => ({ packageName: p, file, startLine: 1 })),
      diffScore: 0,
      suggestedExtract: false,
    }
  }

  it("跨≥2包 + 无 TODO → suggestedExtract=true", () => {
    const idx = new Map<string, any>()
    const groups = applyRules([groupOf(["PKG_A", "PKG_B"], "src/FooDto.java")], {}, idx, projectRoot)
    expect(groups[0].suggestedExtract).toBe(true)
    expect(groups[0].skipReason).toBeUndefined()
  })

  it("单包 → suggestedExtract=false, skipReason=single-package", () => {
    const idx = new Map<string, any>()
    const groups = applyRules([groupOf(["PKG_A"], "src/FooDto.java")], {}, idx, projectRoot)
    expect(groups[0].suggestedExtract).toBe(false)
    expect(groups[0].skipReason).toBe("single-package")
  })

  it("exclude matcher → user-excluded（覆盖跨包默认 true）", () => {
    const idx = new Map<string, any>()
    const rules = { exclude: [{ className: "FooDto", reason: "不同业务域不合并" }] }
    const groups = applyRules([groupOf(["PKG_A", "PKG_B"], "src/FooDto.java")], rules, idx, projectRoot)
    expect(groups[0].suggestedExtract).toBe(false)
    expect(groups[0].skipReason).toContain("user-excluded")
  })

  it("force matcher → forceExtract=true（即使单包）", () => {
    const idx = new Map<string, any>()
    const rules = { force: [{ className: "DateConvertUtil", reason: "强制抽取" }] }
    const groups = applyRules([groupOf(["PKG_A"], "src/DateConvertUtil.java")], rules, idx, projectRoot)
    expect(groups[0].suggestedExtract).toBe(true)
    expect(groups[0].forceExtract).toBe(true)
  })

  it("force 单包补扫：force matcher 未命中现有组时按 className 在索引里找文件产出 forceExtract 组", () => {
    const idx = new Map<string, any>([
      idxEntry(projectRoot, "PKG_A", "dto", "src/main/java/a/DateConvertUtil.java"),
    ])
    // 现有组不含 DateConvertUtil
    const existing = [groupOf(["PKG_A", "PKG_B"], "src/FooDto.java")]
    const rules = { force: [{ className: "DateConvertUtil", reason: "强制" }] }
    const groups = applyRules(existing, rules, idx, projectRoot)
    const forceGroup = groups.find(g => g.forceExtract && g.sources[0].file.includes("DateConvertUtil"))
    expect(forceGroup).toBeTruthy()
    expect(forceGroup!.suggestedExtract).toBe(true)
  })
})

describe("buildFileIndex", () => {
  it("从 translations/*/translation.json.files[] + subprogramMethods 构建 文件→{包,role}", () => {
    const art = join(dir, "a")
    const projectRoot = join(dir, "proj")
    mkdirSync(join(art, "translations", "PKG_A"), { recursive: true })
    writeFileSync(join(art, "translations", "PKG_A", "translation.json"), JSON.stringify({
      packageName: "PKG_A",
      files: [
        { path: "src/main/java/a/FooDto.java", role: "dto" },
        { path: "src/main/java/a/OrderMapper.xml", role: "mapper-xml" },
      ],
      subprogramMethods: [
        { oracleName: "do_x", javaClass: "com.x.AService", javaMethod: "doX", javaFile: "src/main/java/a/AService.java" },
      ],
    }), "utf-8")
    const idx = buildFileIndex(art, projectRoot)
    expect(idx.get(join(projectRoot, "src/main/java/a/FooDto.java"))?.role).toBe("dto")
    expect(idx.get(join(projectRoot, "src/main/java/a/OrderMapper.xml"))?.packageName).toBe("PKG_A")
    expect(idx.get(join(projectRoot, "src/main/java/a/AService.java"))?.role).toBe("service")
  })

  it("targetPackages 过滤：只收指定包", () => {
    const art = join(dir, "b")
    const projectRoot = join(dir, "proj2")
    for (const pkg of ["PKG_A", "PKG_B"]) {
      mkdirSync(join(art, "translations", pkg), { recursive: true })
      writeFileSync(join(art, "translations", pkg, "translation.json"), JSON.stringify({
        packageName: pkg, files: [{ path: `src/${pkg}.java`, role: "dto" }],
      }), "utf-8")
    }
    const idx = buildFileIndex(art, projectRoot, ["PKG_A"])
    expect(idx.size).toBe(1)
    expect([...idx.values()][0].packageName).toBe("PKG_A")
  })
})

describe("toolchain 版本基线", () => {
  it("基线常量：JDK 8 + Maven 3.5.0", () => {
    expect(MIN_JDK).toBe(8)
    expect([...MIN_MAVEN]).toEqual([3, 5, 0])
  })

  it("parseMavenVersion：从 mvn --version 输出取 X.Y.Z", () => {
    const out = `Apache Maven 3.6.3 (cecedd343002696d0abb50b32b541b8a6ba2883f)\nMaven home: /usr/share/maven\nJava version: 1.8.0_292, vendor: Private Build`
    expect(parseMavenVersion(out)).toEqual([3, 6, 3])
  })

  it("parseJavaMajor：1.8.0_292 → 8；17.0.1 → 17", () => {
    expect(parseJavaMajor("Java version: 1.8.0_292, vendor: X")).toBe(8)
    expect(parseJavaMajor("Java version: 17.0.1, vendor: X")).toBe(17)
    expect(parseJavaMajor("Java version: 11.0.20, vendor: X")).toBe(11)
  })

  it("cmpVersion：基线判定（3.5.0 是最低，3.4.x 不达；3.6.3 达标）", () => {
    expect(cmpVersion([3, 5, 0], MIN_MAVEN)).toBe(0) // 等于基线 → 达标
    expect(cmpVersion([3, 6, 3], MIN_MAVEN)).toBeGreaterThan(0) // 高于 → 达标
    expect(cmpVersion([3, 4, 9], MIN_MAVEN)).toBeLessThan(0) // 低于 → 不达标
  })
})
