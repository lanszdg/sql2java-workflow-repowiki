/**
 * engine-cross-schema.test.ts — 跨 Schema 校验集成测试
 *
 * 测试 validateCrossSchema 的 CrossSchemaFinding 分级（blocking / warning）
 * 以及 advance() 的三路分支（blocking 拒绝 / warningPending 确认 / 放行）。
 */

import { describe, it, expect, afterEach } from "vitest"
import { type CrossSchemaFinding } from "@workflow/engine-core"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"

const RUN_ID = "run-cross-schema"

/** 基础 setup：inventory 含 CORE_PKG + EXTRA_PKG，analysis 也含两包 */
function setupBaseline(dir: string) {
  writeArtifact(dir, RUN_ID, "inventory.json", {
    sourcePath: "src", packageNames: ["CORE_PKG", "EXTRA_PKG"], tables: [],
    standaloneProcedures: [], triggers: [], views: [], sequences: [],
  })
  writeArtifact(dir, RUN_ID, "analysis.json", {
    callGraph: {},
    packageDependency: {},
    translationOrder: [["CORE_PKG"], ["EXTRA_PKG"]],
    complexity: {},
    sccGroups: [],
    packageNames: ["CORE_PKG", "EXTRA_PKG"],
  })
  writeArtifact(dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
    packageName: "CORE_PKG", bodyFile: "src/core.pkb",
    procedures: [{ name: "GET_ITEM", type: "function", params: [], loc: 50, lineRange: [1, 50] }],
    types: [], variables: [], constants: [],
  })
  writeArtifact(dir, RUN_ID, "inventory-packages/EXTRA_PKG.json", {
    packageName: "EXTRA_PKG", bodyFile: "src/extra.pkb",
    procedures: [{ name: "DO_WORK", type: "procedure", params: [], loc: 30, lineRange: [1, 30] }],
    types: [], variables: [], constants: [],
  })
}

/** 将 run 推到指定阶段（跳过前置阶段的实际执行） */
function pushToPhase(engine: any, phase: string) {
  const run = engine.runs.get(RUN_ID)
  run.currentPhase = phase
  run.status = "running"
  run.phaseHistory = [
    { phase: "inventory", status: "completed", startedAt: "2026-06-15T00:00:00.000Z", completedAt: "2026-06-15T00:01:00.000Z", retryCount: 0 },
    { phase, status: "in_progress", startedAt: "2026-06-15T00:01:00.000Z", retryCount: 0 },
  ]
  engine.persist(run)
}

// ═══════════════════════════════════════════════════════════════
// validateCrossSchema — finding severity 分级
// ═══════════════════════════════════════════════════════════════

describe("validateCrossSchema — 包名一致性", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("analysis 引用的包在 inventory 中存在 → 无 finding", () => {
    ctx = createEngineWithTempDir()
    setupBaseline(ctx.dir)

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "analyze", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "analyze",
    )
    expect(findings.length).toBe(0)
  })

  it("analysis 缺少包（inventory 有但 analysis 没有）→ blocking", () => {
    ctx = createEngineWithTempDir()
    writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
      sourcePath: "src", packageNames: ["CORE_PKG", "EXTRA_PKG"], tables: [],
      standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: {}, packageDependency: {},
      translationOrder: [["CORE_PKG"]],
      complexity: {}, sccGroups: [],
      packageNames: ["CORE_PKG"],  // 缺少 EXTRA_PKG
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", bodyFile: "src/core.pkb",
      procedures: [{ name: "GET_ITEM", type: "function", params: [], loc: 50, lineRange: [1, 50] }],
      types: [], variables: [], constants: [],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "analyze", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "analyze",
    )
    const missing = findings.find(f => f.message.includes("analysis 缺少包: EXTRA_PKG"))
    expect(missing).toBeTruthy()
    expect(missing!.severity).toBe("blocking")
  })

  it("inventory 缺少包（analysis 有但 inventory 没有）→ warning", () => {
    ctx = createEngineWithTempDir()
    writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
      sourcePath: "src", packageNames: ["CORE_PKG"], tables: [],
      standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: {}, packageDependency: {},
      translationOrder: [["CORE_PKG", "GHOST_PKG"]],
      complexity: {}, sccGroups: [],
      packageNames: ["CORE_PKG", "GHOST_PKG"],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", bodyFile: "src/core.pkb",
      procedures: [{ name: "GET_ITEM", type: "function", params: [], loc: 50, lineRange: [1, 50] }],
      types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/GHOST_PKG.json", {
      packageName: "GHOST_PKG", bodyFile: "src/ghost.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "analyze", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "analyze",
    )
    const extra = findings.find(f => f.message.includes("inventory 缺少包: GHOST_PKG"))
    expect(extra).toBeTruthy()
    expect(extra!.severity).toBe("warning")
  })
})

describe("validateCrossSchema — translationOrder 覆盖", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("translationOrder 缺少包 → blocking", () => {
    ctx = createEngineWithTempDir()
    writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
      sourcePath: "src", packageNames: ["CORE_PKG", "EXTRA_PKG"], tables: [],
      standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: {}, packageDependency: {},
      translationOrder: [["CORE_PKG"]],  // 缺少 EXTRA_PKG
      complexity: {}, sccGroups: [],
      packageNames: ["CORE_PKG", "EXTRA_PKG"],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", bodyFile: "src/core.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/EXTRA_PKG.json", {
      packageName: "EXTRA_PKG", bodyFile: "src/extra.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "analyze", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "analyze",
    )
    const missing = findings.find(f => f.message.includes("translationOrder 缺少包: EXTRA_PKG"))
    expect(missing).toBeTruthy()
    expect(missing!.severity).toBe("blocking")
  })
})

describe("validateCrossSchema — plan 映射覆盖", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("plan 未映射包 → blocking", () => {
    ctx = createEngineWithTempDir()
    setupBaseline(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "plan.json", {
      targetProject: {
        groupId: "com.example", artifactId: "myapp",
        packageBase: "com.example", javaVersion: "17", springBootVersion: "3.2",
      },
      packageMappings: [
        { oraclePackage: "CORE_PKG", javaPackage: "com.example.core",
          mapperInterface: "CoreMapper", serviceClass: "CoreService", serviceImplClass: "CoreServiceImpl" },
        // 缺少 EXTRA_PKG 映射
      ],
      rules: {
        namingConvention: "camelCase", nullHandling: "optional",
        exceptionStrategy: "spring-data", logFramework: "slf4j",
      },
      typeMappings: {}, manualReviewList: [], conventions: "",
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "plan", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "plan",
    )
    const missing = findings.find(f => f.message.includes("plan 未映射包: EXTRA_PKG"))
    expect(missing).toBeTruthy()
    expect(missing!.severity).toBe("blocking")
  })
})

// ═══════════════════════════════════════════════════════════════
// advance() — 三路分支行为测试
// ═══════════════════════════════════════════════════════════════

describe("advance() — blocking 拒绝", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("analysis 缺少包 → advance 被拒绝（rejected=true, warningPending 无）", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "analyze")

    // inventory 有两包，analysis 只有 CORE_PKG
    writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
      sourcePath: "src", packageNames: ["CORE_PKG", "EXTRA_PKG"], tables: [],
      standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: {}, packageDependency: {},
      translationOrder: [["CORE_PKG"]],  // 也缺少 EXTRA_PKG（blocking）
      complexity: {}, sccGroups: [],
      packageNames: ["CORE_PKG"],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", bodyFile: "src/core.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/EXTRA_PKG.json", {
      packageName: "EXTRA_PKG", bodyFile: "src/extra.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", subprograms: [],
    })

    const result = engine.advance(RUN_ID)
    expect(result.rejected).toBe(true)
    expect(result.warningPending).toBeFalsy()
    expect(result.rejectionReason).toContain("阻塞级")
    expect(result.rejectionReason).toContain("EXTRA_PKG")
  })
})

describe("advance() — warningPending 确认", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("仅有 warning 且未 acceptWarnings → warningPending=true", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "analyze")

    // inventory 只有一包，analysis 有两包 → inventory 缺少包 = warning
    writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
      sourcePath: "src", packageNames: ["CORE_PKG"], tables: [],
      standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: {}, packageDependency: {},
      translationOrder: [["CORE_PKG", "GHOST_PKG"]],
      complexity: {}, sccGroups: [],
      packageNames: ["CORE_PKG", "GHOST_PKG"],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", bodyFile: "src/core.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/GHOST_PKG.json", {
      packageName: "GHOST_PKG", bodyFile: "src/ghost.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", subprograms: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis-packages/GHOST_PKG.json", {
      packageName: "GHOST_PKG", subprograms: [],
    })

    const result = engine.advance(RUN_ID)
    expect(result.rejected).toBe(true)
    expect(result.warningPending).toBe(true)
    expect(result.crossSchemaWarnings).toBeDefined()
    expect(result.crossSchemaWarnings!.length).toBeGreaterThan(0)
  })

  it("acceptWarnings=true → 放行，附带 crossSchemaWarnings", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "analyze")

    writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
      sourcePath: "src", packageNames: ["CORE_PKG"], tables: [],
      standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: {}, packageDependency: {},
      translationOrder: [["CORE_PKG", "GHOST_PKG"]],
      complexity: {}, sccGroups: [],
      packageNames: ["CORE_PKG", "GHOST_PKG"],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", bodyFile: "src/core.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/GHOST_PKG.json", {
      packageName: "GHOST_PKG", bodyFile: "src/ghost.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", subprograms: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis-packages/GHOST_PKG.json", {
      packageName: "GHOST_PKG", subprograms: [],
    })

    const result = engine.advance(RUN_ID, { acceptWarnings: true })
    expect(result.rejected).toBe(false)
    expect(result.crossSchemaWarnings).toBeDefined()
    expect(result.crossSchemaWarnings!.length).toBeGreaterThan(0)
  })
})

describe("advance() — 混合场景", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("同时有 blocking + warning → 按 blocking 拒绝，warning 附带在 crossSchemaWarnings", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "analyze")

    // inventory 有 CORE_PKG + EXTRA_PKG，analysis 有 CORE_PKG + GHOST_PKG
    // → EXTRA_PKG: analysis 缺少包 = blocking
    // → GHOST_PKG: inventory 缺少包 = warning
    writeArtifact(ctx.dir, RUN_ID, "inventory.json", {
      sourcePath: "src", packageNames: ["CORE_PKG", "EXTRA_PKG"], tables: [],
      standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis.json", {
      callGraph: {}, packageDependency: {},
      translationOrder: [["CORE_PKG", "GHOST_PKG"]],
      complexity: {}, sccGroups: [],
      packageNames: ["CORE_PKG", "GHOST_PKG"],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", bodyFile: "src/core.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/EXTRA_PKG.json", {
      packageName: "EXTRA_PKG", bodyFile: "src/extra.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "inventory-packages/GHOST_PKG.json", {
      packageName: "GHOST_PKG", bodyFile: "src/ghost.pkb",
      procedures: [], types: [], variables: [], constants: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis-packages/CORE_PKG.json", {
      packageName: "CORE_PKG", subprograms: [],
    })
    writeArtifact(ctx.dir, RUN_ID, "analysis-packages/GHOST_PKG.json", {
      packageName: "GHOST_PKG", subprograms: [],
    })

    const result = engine.advance(RUN_ID)
    expect(result.rejected).toBe(true)
    expect(result.warningPending).toBeFalsy() // blocking 优先，不是 warningPending
    expect(result.rejectionReason).toContain("阻塞级")
    expect(result.rejectionReason).toContain("EXTRA_PKG")
    // warning 应附带在 crossSchemaWarnings
    expect(result.crossSchemaWarnings).toBeDefined()
    expect(result.crossSchemaWarnings!.some(w => w.includes("GHOST_PKG"))).toBe(true)
  })
})
