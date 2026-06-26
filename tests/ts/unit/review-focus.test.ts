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

  // inventory-packages/PKG_A.json
  mkdirSync(join(dir, "inventory-packages"), { recursive: true })
  writeFileSync(join(dir, "inventory-packages", "PKG_A.json"), JSON.stringify({
    packageName: "PKG_A",
    bodyFile: "pkg_a_body.sql",
    procedures: [
      { name: "get_item", type: "procedure", params: [], lineRange: [1, 4] },
      { name: "update_status", type: "procedure", params: [{ name: "p_code", oracleType: "VARCHAR2", direction: "OUT" }], lineRange: [5, 6] },
      { name: "create_order", type: "procedure", params: [], lineRange: [7, 8] },
      { name: "simple_crud", type: "procedure", params: [], lineRange: [9, 10] },
    ],
  }))

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

  // analysis.json（complexity：create_order high → #1）
  writeFileSync(join(dir, "analysis.json"), JSON.stringify({
    packageNames: ["PKG_A"],
    complexity: {
      "PKG_A.create_order": { score: 8, patterns: ["nested-if"], riskLevel: "high" },
      "PKG_A.get_item": { score: 3, patterns: [], riskLevel: "low" },
    },
    callGraph: {}, packageDependency: {}, translationOrder: [["PKG_A"]], sccGroups: [],
  }))

  // plan.json
  writeFileSync(join(dir, "plan.json"), JSON.stringify({
    targetProject: { groupId: "com.x", artifactId: "app", packageBase: "com.x", javaVersion: "1.8", springBootVersion: "2.7" },
    packageMappings: [{ oraclePackage: "PKG_A", javaPackage: "com.x", mapperInterface: "FooMapper", serviceClass: "FooService", serviceImplClass: "FooServiceImpl" }],
    rules: {}, typeMappings: {}, manualReviewList: [], conventions: "",
  }))

  // translations/PKG_A/translation.json（subprogramMethods → Java 锚点）
  mkdirSync(join(dir, "translations", "PKG_A"), { recursive: true })
  writeFileSync(join(dir, "translations", "PKG_A", "translation.json"), JSON.stringify({
    packageName: "PKG_A", status: "done", completedSubprograms: ["get_item", "update_status", "create_order", "simple_crud"],
    totalSubprograms: 4,
    subprogramMethods: [
      { oracleName: "get_item", javaClass: "FooServiceImpl", javaMethod: "getItem", javaFile: "src/main/java/com/x/FooServiceImpl.java" },
      { oracleName: "update_status", javaClass: "FooServiceImpl", javaMethod: "updateStatus", javaFile: "src/main/java/com/x/FooServiceImpl.java" },
      { oracleName: "create_order", javaClass: "FooServiceImpl", javaMethod: "createOrder", javaFile: "src/main/java/com/x/FooServiceImpl.java" },
      { oracleName: "simple_crud", javaClass: "FooServiceImpl", javaMethod: "simpleCrud", javaFile: "src/main/java/com/x/FooServiceImpl.java" },
    ],
    files: [{ path: "src/main/java/com/x/FooServiceImpl.java", role: "service-impl" }],
  }))

  // scaffold.json（testShells → #18/#20 测试审查）
  writeFileSync(join(dir, "scaffold.json"), JSON.stringify({
    projectRoot: projectRoot,
    structure: { directories: [], pomXml: "" },
    generated: {
      testShells: [{ file: "src/test/java/com/x/FooServiceImplTest.java", oraclePackage: "PKG_A", testClass: "FooServiceImplTest" }],
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
    expect(s).toContain("FooServiceImpl.java")
    expect(s).toContain("方法 `getItem`") // Java 方法锚点（软约束）
  })

  it("测试审查段列出 ServiceImpl 测试 + Mapper 集成测试", () => {
    const s = block()
    expect(s).toContain("test-correctness(#18)")
    expect(s).toContain("mapper-test-correctness(#20)")
    expect(s).toContain("FooServiceImplTest")
    expect(s).toContain("FooMapperIntegrationTest")
  })
})
