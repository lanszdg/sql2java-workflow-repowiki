/**
 * refname-validation.test.ts — validateCrossSchema 的 refName 一致性校验集成测试 (P1)
 *
 * vitest(esbuild) 不做类型检查，且无 tsc 步骤；此测试通过真实构造 WorkflowEngine +
 * 写入故意带缺陷的 artifact，端到端验证 engine-core.ts 中新增的 refName 校验逻辑
 * （既验证类型/接线正确，也验证"裸名撞重载"缺陷确实被捕获）。
 */

import { describe, it, expect, afterEach } from "vitest"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"
import type { WorkflowRun, CrossSchemaFinding } from "@workflow/engine-core"

const RUN_ID = "run-refname"

function makeRun(currentPhase: string): WorkflowRun {
  return {
    runId: RUN_ID,
    definitionId: "sql2java",
    currentPhase,
    status: "running",
    phaseHistory: [],
    metadata: {},
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
  }
}

function setupOverloadedUtilPkg(dir: string) {
  // inventory + analysis：单包 UTIL_PKG，含两个 get_by_id 重载
  writeArtifact(dir, RUN_ID, "inventory.json", {
    sourcePath: "src", packageNames: ["UTIL_PKG"], tables: [],
    standaloneProcedures: [], triggers: [], views: [], sequences: [],
  })
  writeArtifact(dir, RUN_ID, "analysis.json", {
    callGraph: {},
    packageDependency: {},
    translationOrder: [["UTIL_PKG"]],
    complexity: {},
    sccGroups: [],
    packageNames: ["UTIL_PKG"],
  })
  // inventory-packages：get_by_id 出现 2 次 → 合法 refName = {GET_BY_ID__1, GET_BY_ID__2}，裸名非法
  writeArtifact(dir, RUN_ID, "inventory-packages/UTIL_PKG.json", {
    packageName: "UTIL_PKG",
    bodyFile: "src/UTIL_PKG.pkb",
    procedures: [{ name: "get_by_id" }, { name: "get_by_id" }],
    types: [], variables: [], constants: [],
  })
}

describe("validateCrossSchema — callGraph refName 校验 (analyze 阶段)", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("裸名引用重载子程序 → warning（捕获'裸名撞重载'缺陷）", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    // 覆盖 analysis.callGraph：裸名 get_by_id（非法）+ 合法 get_by_id__1
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: { "UTIL_PKG.get_by_id": [], "UTIL_PKG.get_by_id__1": [] },
      packageDependency: {}, translationOrder: [["UTIL_PKG"]],
      complexity: {}, sccGroups: [], packageNames: ["UTIL_PKG"],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("analyze"), "analyze")
    const bare = findings.find((f) => f.message.includes("callGraph") && f.message.includes("get_by_id") && f.message.includes("不在"))
    expect(bare, `应告警裸名撞重载，实际 findings:\n${findings.map(f => f.message).join("\n")}`).toBeTruthy()
    // callGraph refName 问题应为 warning 级别
    expect(bare!.severity).toBe("warning")
    // 合法的 __1 不应被告警
    expect(findings.some((f) => f.message.includes("get_by_id__1") && f.message.includes("不在"))).toBe(false)
  })

  it("合法 refName（重载带 __序号）不告警", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: { "UTIL_PKG.get_by_id__2": ["UTIL_PKG.get_by_id__1"] },
      packageDependency: {}, translationOrder: [["UTIL_PKG"]],
      complexity: {}, sccGroups: [], packageNames: ["UTIL_PKG"],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("analyze"), "analyze")
    expect(findings.some((f) => f.message.includes("不在") && f.message.includes("refName"))).toBe(false)
  })
})

describe("validateCrossSchema — subprogramMethods 校验 (dedup 阶段)", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("重复 oracleName → warning", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "translations/UTIL_PKG/translation.json", {
      packageName: "UTIL_PKG", status: "completed",
      completedSubprograms: ["get_by_id__1"], totalSubprograms: 2,
      files: [], decisions: [], todos: [],
      subprogramMethods: [
        { oracleName: "get_by_id__1", javaClass: "UtilService", javaMethod: "a" },
        { oracleName: "get_by_id__1", javaClass: "UtilService", javaMethod: "b" },
      ],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("dedup"), "dedup")
    const dup = findings.find((f) => f.message.includes("重复 oracleName"))
    expect(dup).toBeTruthy()
    expect(dup!.severity).toBe("warning")
  })

  it("oracleName 用裸名引用重载子程序 → warning", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "translations/UTIL_PKG/translation.json", {
      packageName: "UTIL_PKG", status: "completed",
      completedSubprograms: ["get_by_id"], totalSubprograms: 2,
      files: [], decisions: [], todos: [],
      subprogramMethods: [
        { oracleName: "get_by_id", javaClass: "UtilService", javaMethod: "a" },
      ],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("dedup"), "dedup")
    const invalid = findings.find((f) => f.message.includes("不在合法 refName 集合内"))
    expect(invalid).toBeTruthy()
    expect(invalid!.severity).toBe("warning")
  })

  it("合法 subprogramMethods 不告警", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "translations/UTIL_PKG/translation.json", {
      packageName: "UTIL_PKG", status: "completed",
      completedSubprograms: ["get_by_id__1", "get_by_id__2"], totalSubprograms: 2,
      files: [], decisions: [], todos: [],
      subprogramMethods: [
        { oracleName: "get_by_id__1", javaClass: "UtilService", javaMethod: "a" },
        { oracleName: "get_by_id__2", javaClass: "UtilService", javaMethod: "b" },
      ],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("dedup"), "dedup")
    expect(findings.some((f) => f.message.includes("subprogramMethods"))).toBe(false)
  })
})

describe("validateCrossSchema — subprogramMethods 校验 (translate 阶段，translate 完成即校验)", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("translate 完成时重复 oracleName 即告警（即时反馈，不必等到 dedup）", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "translations/UTIL_PKG/translation.json", {
      packageName: "UTIL_PKG", status: "completed",
      completedSubprograms: ["get_by_id__1"], totalSubprograms: 2,
      files: [], decisions: [], todos: [],
      subprogramMethods: [
        { oracleName: "get_by_id__1", javaClass: "UtilService", javaMethod: "a" },
        { oracleName: "get_by_id__1", javaClass: "UtilService", javaMethod: "b" },
      ],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("translate"), "translate")
    expect(findings.some((f) => f.message.includes("重复 oracleName"))).toBe(true)
  })

  it("callGraph 校验不在 translate 触发（仅 analyze），translate 不应报 callGraph refName 问题", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: { "UTIL_PKG.get_by_id": [] },  // 裸名（非法），但 analyze 才校验
      packageDependency: {}, translationOrder: [["UTIL_PKG"]],
      complexity: {}, sccGroups: [], packageNames: ["UTIL_PKG"],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("translate"), "translate")
    // translate 阶段不校验 callGraph，故裸名不应被告警
    expect(findings.some((f) => f.message.includes("callGraph") && f.message.includes("不在"))).toBe(false)
  })
})
