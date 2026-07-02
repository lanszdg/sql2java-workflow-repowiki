/**
 * review-focus.test.ts — Step B 信号选点 + 圈片段 单测
 *
 * 合成 artifacts 目录（inventory/analysis/plan/translation/scaffold + 源 body 文件），
 * 验证：有信号过程入选（#1/#3/#5/#7/#8）、纯 CRUD 无信号过程跳过、聚焦块含 Java 锚点 + PL/SQL sed -n。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildReviewFocus } from "@workflow/review-focus"

let dir: string
let sourcePath: string
const projectRoot = "/proj/generated/app"

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "review-focus-"))
  sourcePath = join(dir, "src")
  mkdirSync(sourcePath, { recursive: true })

  // 源 body 文件：4 个过程，行范围对齐 lineRange
  const body = [
    "PROCEDURE get_item IS",                       // 1
    "  v VARCHAR2 := NVL(p_x, '0');",              // 2  ← NVL → #3
    "  CURSOR c IS SELECT * FROM t;",              // 3  ← cursor → #7
    "BEGIN NULL; END;",                            // 4
    "PROCEDURE update_status(p_code OUT VARCHAR2) IS", // 5 ← OUT param → #8
    "BEGIN NULL; END;",                            // 6
    "PROCEDURE create_order IS",                   // 7
    "BEGIN IF x THEN NULL; END IF; END;",          // 8  ← complexity high → #1
    "PROCEDURE simple_crud IS",                    // 9  ← 无信号
    "BEGIN INSERT INTO t VALUES(1); END;",         // 10
  ].join("\n")
  writeFileSync(join(sourcePath, "pkg_a_body.sql"), body)

  // packages/PKG_A.json + subprograms/PKG_A.*.json（bodyLocation.lineRange + parameters.mode）
  mkdirSync(join(dir, "packages"), { recursive: true })
  mkdirSync(join(dir, "subprograms"), { recursive: true })
  const subs = [
    { name: "get_item", lineRange: [1, 4], params: [] },
    { name: "update_status", lineRange: [5, 6], params: [{ name: "p_code", type: "VARCHAR2", mode: "OUT" }] },
    { name: "create_order", lineRange: [7, 8], params: [] },
    { name: "simple_crud", lineRange: [9, 10], params: [] },
  ]
  writeFileSync(join(dir, "packages", "PKG_A.json"), JSON.stringify({
    packageName: "PKG_A", absolutePaths: ["pkg_a_body.sql"], headerPath: "pkg_a_body.sql", bodyPath: "pkg_a_body.sql",
    constants: [], variables: [], exceptions: [], types: [],
    functions: [], procedures: subs.map(s => s.name), estimatedLoc: 10,
    // complexity 现为包级（原 dependency-graph.json.complexity 迁此）；PKG_A 整体 low
    complexity: { score: 3, patterns: [], riskLevel: "low" },
  }), "utf-8")
  for (const s of subs) {
    writeFileSync(join(dir, "subprograms", `PKG_A.${s.name}.json`), JSON.stringify({
      name: s.name, type: "PROCEDURE", belongToPackage: "PKG_A", overloadIndex: null, isPrivate: false,
      headerLocation: null, bodyLocation: { absolutePath: "pkg_a_body.sql", lineRange: s.lineRange },
      parameters: s.params, returnType: null, loc: 1, directCalls: [],
    }), "utf-8")
  }

  // analysis-packages/PKG_A.json（cursors / exceptionHandlers）
  mkdirSync(join(dir, "analysis-packages"), { recursive: true })
  writeFileSync(join(dir, "analysis-packages", "PKG_A.json"), JSON.stringify({
    packageName: "PKG_A",
    subprograms: [
      { name: "get_item", cursors: [{ name: "c", query: "SELECT * FROM t", fetchMode: "implicit" }], exceptionHandlers: [] },
      { name: "update_status", cursors: [], exceptionHandlers: [{ name: "OTHERS", actions: ["NULL"] }] }, // → #5
      { name: "create_order", cursors: [], exceptionHandlers: [] },
      { name: "simple_crud", cursors: [], exceptionHandlers: [] },
    ],
  }))

  // plan.json（manualReviewList：create_order → #1 logic-equivalence；complexity 包级已 low）
  writeFileSync(join(dir, "plan.json"), JSON.stringify({
    targetProject: { groupId: "com.x", artifactId: "app", packageBase: "com.x", javaVersion: "1.8", springBootVersion: "2.7" },
    packageMappings: [{ oraclePackage: "PKG_A", javaPackage: "com.x", mapperInterface: "FooMapper", accessIntf: "FooAccessIntf", accessImpl: "FooAccessImpl", processor: "FooProcessor", aggregate: "FooAggregate", builder: "FooBuilder", validator: "FooValidator" }],
    rules: {}, typeMappings: {}, manualReviewList: [{ procedure: "create_order" }], conventions: "",
  }))

  // translations/PKG_A/translation.json（subprogramMethods → Java 锚点）
  mkdirSync(join(dir, "translations", "PKG_A"), { recursive: true })
  writeFileSync(join(dir, "translations", "PKG_A", "translation.json"), JSON.stringify({
    packageName: "PKG_A", status: "done", completedSubprograms: ["get_item", "update_status", "create_order", "simple_crud"],
    totalSubprograms: 4,
    subprogramMethods: [
      { oracleName: "get_item", javaClass: "FooAccessIntf", javaMethod: "getItem", javaFile: "src/main/java/com/x/access/FooAccessIntf.java" },
      { oracleName: "update_status", javaClass: "FooAccessIntf", javaMethod: "updateStatus", javaFile: "src/main/java/com/x/access/FooAccessIntf.java" },
      { oracleName: "create_order", javaClass: "FooAccessIntf", javaMethod: "createOrder", javaFile: "src/main/java/com/x/access/FooAccessIntf.java" },
      { oracleName: "simple_crud", javaClass: "FooAccessIntf", javaMethod: "simpleCrud", javaFile: "src/main/java/com/x/access/FooAccessIntf.java" },
    ],
    files: [{ path: "src/main/java/com/x/access/FooAccessIntf.java", role: "access-intf" }],
  }))

  // scaffold.json（testShells → #18/#20 测试审查）
  writeFileSync(join(dir, "scaffold.json"), JSON.stringify({
    projectRoot: projectRoot,
    structure: { directories: [], pomXml: "" },
    generated: {
      testShells: [{ file: "src/test/java/com/x/domain/aggregate/FooAggregateTest.java", oraclePackage: "PKG_A", testClass: "FooAggregateTest" }],
      mapperTestShells: [{ file: "src/test/java/com/x/FooMapperIntegrationTest.java", oraclePackage: "PKG_A", testClass: "FooMapperIntegrationTest", mapperInterface: "FooMapper" }],
    },
  }))
})

describe("buildReviewFocus 信号选点", () => {
  const block = () => buildReviewFocus(dir, ["PKG_A"], sourcePath, projectRoot)

  it("get_item 入选：#7 cursor-mapping + #3 null-handling(NVL)", () => {
    const s = block()
    expect(s).toContain("PKG_A.get_item")
    expect(s).toContain("#7 cursor-mapping")
    expect(s).toContain("#3 null-handling")
  })

  it("update_status 入选：#8 parameter-direction + #5 exception-mapping", () => {
    const s = block()
    expect(s).toContain("PKG_A.update_status")
    expect(s).toContain("#8 parameter-direction")
    expect(s).toContain("#5 exception-mapping")
  })

  it("create_order 入选：#1 logic-equivalence(complexity high)", () => {
    const s = block()
    expect(s).toContain("PKG_A.create_order")
    expect(s).toContain("#1 logic-equivalence")
  })

  it("simple_crud 无信号 → 不在聚焦点（但出现在跳过统计）", () => {
    const s = block()
    expect(s).not.toMatch(/### PKG_A\.simple_crud/)
    expect(s).toContain("1 个过程无信号") // simple_crud 跳过
  })

  it("聚焦块含 Java 方法锚点 + PL/SQL sed -n 硬约束", () => {
    const s = block()
    expect(s).toContain("sed -n '1,4p'") // get_item lineRange
    expect(s).toContain("FooAccessIntf.java")
    expect(s).toContain("方法 `getItem`") // Java 方法锚点（软约束）
  })

  it("测试审查段列出 Aggregate 单元测试 + Mapper 集成测试", () => {
    const s = block()
    expect(s).toContain("test-correctness(#18)")
    expect(s).toContain("mapper-test-correctness(#20)")
    expect(s).toContain("FooAggregateTest")
    expect(s).toContain("FooMapperIntegrationTest")
  })
})
