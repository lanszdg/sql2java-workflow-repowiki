/**
 * refname-validation.test.ts — validateCrossSchema 的 refName 一致性校验集成测试 (P1)
 *
 * 新形状：callGraph 由 buildDependencyGraph 从 subprograms.directCalls 按需推导（恒为合法 refName），
 * 故 callGraph 裸名缺陷不再可能（旧 dependency-graph.json 可手写裸名）。本测试聚焦 subprogramMethods
 * 校验（translation.json 由 LLM 产出，仍可能用裸名撞重载）+ 推导 callGraph 合法不告警。
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

/** 写 inventory.json + packages/UTIL_PKG.json + 两个重载 subprograms（name=get_by_id） */
function setupOverloadedUtilPkg(dir: string) {
  writeArtifact(dir, RUN_ID, "inventory.json", {
    sourcePath: "src", packageNames: ["UTIL_PKG"], tableNames: [],
    triggers: [], views: [], sequences: [],
  })
  writeArtifact(dir, RUN_ID, "packages/UTIL_PKG.json", {
    packageName: "UTIL_PKG", absolutePaths: [], headerPath: null, bodyPath: null,
    constants: [], variables: [], exceptions: [], types: [],
    functions: [], procedures: ["get_by_id"], estimatedLoc: 0,
  })
  // 两个重载 subprogram 文件（filename 带 __N，name 字段为裸名 get_by_id）
  for (const idx of [1, 2]) {
    writeArtifact(dir, RUN_ID, `subprograms/UTIL_PKG.get_by_id__${idx}.json`, {
      name: "get_by_id", type: "PROCEDURE", belongToPackage: "UTIL_PKG",
      overloadIndex: idx, isPrivate: false,
      headerLocation: null, bodyLocation: { absolutePath: "src/UTIL_PKG.pkb", lineRange: [1, 1] },
      parameters: [], returnType: null, loc: 1, directCalls: [],
    })
  }
}

describe("validateCrossSchema — 推导 callGraph 合法（inventory 阶段）", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("buildDependencyGraph 推导的 callGraph refName 合法 → 无 callGraph refName 告警", () => {
    ctx = createEngineWithTempDir()
    setupOverloadedUtilPkg(ctx.dir)
    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(makeRun("inventory"), "inventory")
    // 推导的 callGraph 恒为合法 refName（__序号），不应有 callGraph refName 告警
    expect(findings.some((f) => f.message.includes("callGraph") && f.message.includes("不在"))).toBe(false)
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
})
