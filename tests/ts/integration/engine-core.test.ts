/**
 * engine-core.test.ts — 核心状态机集成测试
 *
 * 测试 start / advance / confirm / abort / status / listRuns 等状态转换。
 * 使用临时目录作为 artifactsRoot，每个测试独立隔离。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { WorkflowEngine, WorkflowEngineError, DONE_SENTINEL } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"
import { makeReviewSummary, makeVerifySummary, makeFixArtifact } from "../helpers/artifact-factory"

// ── 辅助：推进到指定阶段 ──────────────────────────────────────

/** 将工作流推进到指定阶段（无条件前进到 targetPhase，自动接受跨 schema warning） */
function advanceTo(engine: any, runId: string, targetPhase: string): void {
  const phases = ["inventory", "analyze", "plan", "scaffold", "translate", "dedup"]
  const idx = phases.indexOf(targetPhase)
  if (idx === -1) throw new Error(`Unknown phase: ${targetPhase}`)

  const run = engine.status(runId)!
  // 从当前阶段开始推进
  for (let i = phases.indexOf(run.currentPhase); i < idx; i++) {
    let result = engine.advance(runId, { result: "passed" })
    // 跨 schema warning：测试辅助只需推进，自动接受
    if (result.rejected && result.warningPending) {
      result = engine.advance(runId, { result: "passed", acceptWarnings: true })
    }
    if (result.rejected) throw new Error(`Advance rejected at ${phases[i]}: ${result.rejectionReason}`)
  }
}

// ═══════════════════════════════════════════════════════════════
// start
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.start()", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("创建 run，首阶段 in_progress", () => {
    const run = ctx.engine.start("sql2java", "run-001")
    expect(run.status).toBe("running")
    expect(run.currentPhase).toBe("inventory")
    expect(run.phaseHistory).toHaveLength(1)
    expect(run.phaseHistory[0].status).toBe("in_progress")
  })

  it("持久化 run.json 到磁盘", () => {
    ctx.engine.start("sql2java", "run-002")
    const runJson = join(ctx.dir, "run-002", "run.json")
    expect(existsSync(runJson)).toBe(true)
    const parsed = JSON.parse(readFileSync(runJson, "utf-8"))
    expect(parsed.runId).toBe("run-002")
  })

  it("未知 definition 抛 INVALID_DEFINITION", () => {
    expect(() => ctx.engine.start("unknown", "run-003")).toThrow()
    try {
      ctx.engine.start("unknown", "run-003")
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowEngineError)
      expect(e.code).toBe("INVALID_DEFINITION")
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// advance — 主线无条件前进
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.advance() — 主线前进", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("always-phase 无视 result 前进", () => {
    ctx.engine.start("sql2java", "run-010")
    const result = ctx.engine.advance("run-010", { result: "failed" })
    // inventory → analyze 是 always，所以 failed 也前进
    expect(result.rejected).toBe(false)
    expect(result.run.currentPhase).toBe("analyze")
  })

  it("连续前进 inventory → analyze → plan", () => {
    ctx.engine.start("sql2java", "run-011")
    ctx.engine.advance("run-011") // inventory → analyze
    // analyze 有 needsCrossSchemaValidation，无 artifact 触发 warning → acceptWarnings
    ctx.engine.advance("run-011", { acceptWarnings: true }) // analyze → plan
    const run = ctx.engine.status("run-011")!
    expect(run.currentPhase).toBe("plan")
    expect(run.phaseHistory.filter(e => e.status === "completed")).toHaveLength(2)
  })

  it("非 running 状态拒绝 advance", () => {
    ctx.engine.start("sql2java", "run-012")
    ctx.engine.abort("run-012")
    const result = ctx.engine.advance("run-012")
    expect(result.rejected).toBe(true)
    expect(result.rejectionReason).toContain("aborted")
  })
})

// ═══════════════════════════════════════════════════════════════
// advance — review/verify 分支
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.advance() — review/verify 分支", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  /** 推进到 review 阶段并写入 review-summary（自动接受跨 schema warning） */
  function setupAtReview() {
    ctx.engine.start("sql2java", "run-020")
    // 前进到 review
    const phases = ["inventory", "analyze", "plan", "scaffold", "translate", "dedup"]
    for (const _ of phases) {
      let r = ctx.engine.advance("run-020")
      if (r.rejected && r.warningPending) {
        r = ctx.engine.advance("run-020", { acceptWarnings: true })
      }
      if (r.rejected) throw new Error(`Advance rejected: ${r.rejectionReason}`)
    }
    return ctx.engine.status("run-020")!
  }

  it("review + summary allPassed=true → verify", () => {
    setupAtReview()
    writeArtifact(ctx.dir, "run-020", "review-summary.json", makeReviewSummary({ allPassed: true }))
    const result = ctx.engine.advance("run-020")
    expect(result.rejected).toBe(false)
    expect(result.run.currentPhase).toBe("verify")
  })

  it("review + summary allPassed=false → fix", () => {
    setupAtReview()
    writeArtifact(ctx.dir, "run-020", "review-summary.json", makeReviewSummary({
      allPassed: false,
      packageResults: [
        { packageName: "CORE_PKG", passed: false, score: 50, mustFixCount: 2 },
      ],
      totalMustFix: 2,
      totalTodosRemaining: 1,
    }))
    const result = ctx.engine.advance("run-020")
    expect(result.rejected).toBe(false)
    expect(result.run.currentPhase).toBe("fix")
  })

  it("review 无 summary artifact → 拒绝 (D8)", () => {
    setupAtReview()
    const result = ctx.engine.advance("run-020")
    expect(result.rejected).toBe(true)
    expect(result.rejectionReason).toContain("review-summary.json")
  })

  it("review result 与 allPassed 矛盾 → 拒绝 (D8)", () => {
    setupAtReview()
    writeArtifact(ctx.dir, "run-020", "review-summary.json", makeReviewSummary({ allPassed: false }))
    const result = ctx.engine.advance("run-020", { result: "passed" })
    expect(result.rejected).toBe(true)
  })

  it("verify + summary allPassed=true → completed", () => {
    setupAtReview()
    writeArtifact(ctx.dir, "run-020", "review-summary.json", makeReviewSummary({ allPassed: true }))
    ctx.engine.advance("run-020") // → verify
    writeArtifact(ctx.dir, "run-020", "verify-summary.json", makeVerifySummary({ allPassed: true }))
    const result = ctx.engine.advance("run-020")
    expect(result.rejected).toBe(false)
    expect(result.finished).toBe(true)
    expect(result.run.status).toBe("completed")
    expect(result.run.currentPhase).toBeNull()
  })

  it("verify + summary allPassed=false → fix", () => {
    setupAtReview()
    writeArtifact(ctx.dir, "run-020", "review-summary.json", makeReviewSummary({ allPassed: true }))
    ctx.engine.advance("run-020") // → verify
    writeArtifact(ctx.dir, "run-020", "verify-summary.json", makeVerifySummary({
      allPassed: false,
      compilation: {
        success: false,
        errors: [{ file: "a.java", line: 1, message: "error" }],
      },
      packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 1,
    }))
    const result = ctx.engine.advance("run-020")
    expect(result.rejected).toBe(false)
    expect(result.run.currentPhase).toBe("fix")
  })
})

// ═══════════════════════════════════════════════════════════════
// advance — 被拒时不污染 phaseHistory
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.advance() — 被拒保护", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("被拒后 entry 保持 in_progress", () => {
    ctx.engine.start("sql2java", "run-030")
    // 推进到 review 但不写 summary
    const phases = ["inventory", "analyze", "plan", "scaffold", "translate", "dedup"]
    for (const _ of phases) {
      ctx.engine.advance("run-030")
    }
    const beforeEntry = ctx.engine.findCurrentEntry(ctx.engine.status("run-030")!)
    expect(beforeEntry!.status).toBe("in_progress")

    const result = ctx.engine.advance("run-030")
    expect(result.rejected).toBe(true)

    const afterEntry = ctx.engine.findCurrentEntry(ctx.engine.status("run-030")!)
    expect(afterEntry!.status).toBe("in_progress")
  })
})

// ═══════════════════════════════════════════════════════════════
// confirm
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.confirm()", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("非 paused 状态抛错", () => {
    ctx.engine.start("sql2java", "run-040")
    expect(() => ctx.engine.confirm("run-040")).toThrow()
    try {
      ctx.engine.confirm("run-040")
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowEngineError)
      expect(e.code).toBe("INVALID_STATE")
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// abort
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.abort()", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("设置 aborted 状态，entry 为 failed", () => {
    ctx.engine.start("sql2java", "run-050")
    const run = ctx.engine.abort("run-050")
    expect(run.status).toBe("aborted")
    const entry = ctx.engine.findCurrentEntry(run)
    expect(entry!.status).toBe("failed")
  })
})

// ═══════════════════════════════════════════════════════════════
// status / listRuns
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.status()", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("未知 runId 返回 null", () => {
    expect(ctx.engine.status("unknown")).toBeNull()
  })

  it("已知 runId 返回 run", () => {
    ctx.engine.start("sql2java", "run-060")
    const run = ctx.engine.status("run-060")
    expect(run).not.toBeNull()
    expect(run!.runId).toBe("run-060")
  })
})

describe("WorkflowEngine.listRuns()", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("从磁盘发现 runs", () => {
    ctx.engine.start("sql2java", "run-070")
    ctx.engine.start("sql2java", "run-071")

    // 新引擎（模拟新 session），只有磁盘数据
    const freshEngine = new WorkflowEngine()
    ;(freshEngine as any).artifactsRoot = ctx.dir
    freshEngine.registerDefinition(SQL2JAVA_WORKFLOW)

    const runs = freshEngine.listRuns()
    expect(runs.length).toBeGreaterThanOrEqual(2)
    const ids = runs.map(r => r.runId).sort()
    expect(ids).toContain("run-070")
    expect(ids).toContain("run-071")
  })

  it("空目录返回空数组", () => {
    const runs = ctx.engine.listRuns()
    expect(runs).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════
// loadFromDisk / persist
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.loadFromDisk()", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("有效 JSON 加载成功", () => {
    ctx.engine.start("sql2java", "run-080")
    const run = ctx.engine.loadFromDisk("run-080")
    expect(run.runId).toBe("run-080")
  })

  it("文件不存在抛 NOT_FOUND", () => {
    expect(() => ctx.engine.loadFromDisk("nonexistent")).toThrow()
    try {
      ctx.engine.loadFromDisk("nonexistent")
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowEngineError)
      expect(e.code).toBe("NOT_FOUND")
    }
  })

  it("无效 JSON 抛 CORRUPTED", () => {
    const dir = join(ctx.dir, "run-bad")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "run.json"), "not valid json{{{")
    expect(() => ctx.engine.loadFromDisk("run-bad")).toThrow()
    try {
      ctx.engine.loadFromDisk("run-bad")
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowEngineError)
      expect(e.code).toBe("CORRUPTED")
    }
  })

  it("schema 不匹配抛 VALIDATION_FAILED", () => {
    const dir = join(ctx.dir, "run-schema-bad")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "x" }))
    expect(() => ctx.engine.loadFromDisk("run-schema-bad")).toThrow()
    try {
      ctx.engine.loadFromDisk("run-schema-bad")
    } catch (e: any) {
      expect(e).toBeInstanceOf(WorkflowEngineError)
      expect(e.code).toBe("VALIDATION_FAILED")
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// retry
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine.retry()", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("递增 retryCount", () => {
    ctx.engine.start("sql2java", "run-090")
    const result = ctx.engine.retry("run-090")
    expect(result.retryCount).toBe(1)
    expect(result.exhausted).toBe(false)
    const entry = ctx.engine.findCurrentEntry(ctx.engine.status("run-090")!)
    expect(entry!.status).toBe("in_progress")
  })
})

// ═══════════════════════════════════════════════════════════════
// artifactCache
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine artifactCache", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("同一 advance 周期内缓存命中", () => {
    ctx.engine.start("sql2java", "run-100")
    writeArtifact(ctx.dir, "run-100", "test.json", { value: 42 })

    const dir = join(ctx.dir, "run-100")
    const first = ctx.engine.loadArtifactJson(dir, "test")
    const second = ctx.engine.loadArtifactJson(dir, "test")
    expect(first).toEqual({ value: 42 })
    expect(second).toBe(first) // 同一引用（缓存）
  })

  it("advance 之间缓存清除", () => {
    ctx.engine.start("sql2java", "run-101")
    writeArtifact(ctx.dir, "run-101", "test.json", { value: 1 })

    const dir = join(ctx.dir, "run-101")
    const first = ctx.engine.loadArtifactJson(dir, "test")
    expect(first).toEqual({ value: 1 })

    // advance 会调用 clearArtifactCache
    ctx.engine.advance("run-101")

    // 修改文件
    writeArtifact(ctx.dir, "run-101", "test.json", { value: 2 })
    const second = ctx.engine.loadArtifactJson(dir, "test")
    expect(second).toEqual({ value: 2 })
  })
})

// ═══════════════════════════════════════════════════════════════
// _events.log
// ═══════════════════════════════════════════════════════════════

describe("WorkflowEngine _events.log", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>

  beforeEach(() => { ctx = createEngineWithTempDir() })
  afterEach(() => { ctx.cleanup() })

  it("start 写入 START 事件", () => {
    ctx.engine.start("sql2java", "run-110")
    const logPath = join(ctx.dir, "run-110", "_events.log")
    expect(existsSync(logPath)).toBe(true)
    const content = readFileSync(logPath, "utf-8")
    expect(content).toContain("[START]")
    expect(content).toContain("[run-110]")
  })

  it("advance 写入 ADVANCE 事件", () => {
    ctx.engine.start("sql2java", "run-111")
    ctx.engine.advance("run-111")
    const content = readFileSync(join(ctx.dir, "run-111", "_events.log"), "utf-8")
    expect(content).toContain("[ADVANCE]")
  })
})
