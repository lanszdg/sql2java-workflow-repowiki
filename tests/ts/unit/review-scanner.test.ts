/**
 * review-scanner.test.ts — checkstyle/pmd XML 解析单测
 *
 * 测纯函数（parseCheckstyleXml / parsePmdXml），mock 工具报告 XML，不依赖真实 mvn。
 * 归因在 scanReviewStatic 统一做，故解析阶段 packageName 为 "UNKNOWN"。
 */

import { describe, it, expect } from "vitest"
import { parseCheckstyleXml, parsePmdXml } from "@workflow/review-scanner"

describe("parseCheckstyleXml", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="9.3">
  <file name="/proj/src/main/java/a/Foo.java">
    <error line="12" column="5" severity="error" message="Name 'foo' must match pattern" source="com.puppycrawl.tools.checkstyle.checks.naming.MethodNameCheck"/>
    <error line="30" severity="warning" message="Line is longer than 120" source="com.puppycrawl.tools.checkstyle.checks.sizes.LineLengthCheck"/>
  </file>
</checkstyle>`

  it("解析 <error> 为 findings，rule 去包名去 Check 后缀", () => {
    const f = parseCheckstyleXml(xml)
    expect(f.length).toBe(2)
    expect(f[0].rule).toBe("MethodName")
    expect(f[1].rule).toBe("LineLength")
  })

  it("severity 映射：error→major, warning→minor", () => {
    const f = parseCheckstyleXml(xml)
    expect(f[0].severity).toBe("major")
    expect(f[1].severity).toBe("minor")
  })

  it("category 映射：naming→naming-convention, 其余→code-format", () => {
    const f = parseCheckstyleXml(xml)
    expect(f[0].category).toBe("naming-convention")
    expect(f[1].category).toBe("code-format")
  })

  it("tool=checkstyle, packageName 占位 UNKNOWN（归因在 scanReviewStatic）", () => {
    const f = parseCheckstyleXml(xml)
    expect(f[0].tool).toBe("checkstyle")
    expect(f[0].packageName).toBe("UNKNOWN")
    expect(f[0].line).toBe(12)
  })
})

describe("parsePmdXml", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pmd xmlns="http://pmd.sourceforge.net/ruleset/2.0.0" version="6.55.0">
  <file name="/proj/src/main/java/a/Foo.java">
    <violation beginline="20" endline="22" rule="EmptyCatchBlock" ruleset="Error Prone" priority="2">Avoid empty catch blocks</violation>
    <violation beginline="40" rule="CloseResource" priority="3">Ensure resources closed</violation>
    <violation beginline="55" rule="UnusedLocalVariable" priority="4">unused</violation>
  </file>
</pmd>`

  it("priority 映射：2→major, 3→minor, 4→info", () => {
    const f = parsePmdXml(xml)
    expect(f.length).toBe(3)
    expect(f[0].severity).toBe("major")
    expect(f[1].severity).toBe("minor")
    expect(f[2].severity).toBe("info")
  })

  it("category 映射：EmptyCatchBlock/CloseResource→collection-exception, 其余→code-format", () => {
    const f = parsePmdXml(xml)
    expect(f[0].category).toBe("collection-exception")
    expect(f[1].category).toBe("collection-exception")
    expect(f[2].category).toBe("code-format")
  })

  it("tool=pmd, line/rule/message 正确", () => {
    const f = parsePmdXml(xml)
    expect(f[0].tool).toBe("pmd")
    expect(f[0].line).toBe(20)
    expect(f[0].rule).toBe("EmptyCatchBlock")
    expect(f[0].message).toBe("Avoid empty catch blocks")
  })
})
