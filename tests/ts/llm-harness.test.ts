/**
 * llm-harness.test.ts — Oracle 自测层（Mock 策略表落地）
 *
 * 用【构造的、非真实 agent 产出】的 review.json / translation.json / Java 串当输入，
 * 验证 harness 断言函数判定正确（像单测 expect）。并验证 prepareExecutionPoint 用真实引擎
 * 把 run.json 推进到目标 phase、上游 artifact 就位 —— 全程不调 opencode。
 *
 * 语义边界：这层只证明「断言函数能正确识别正确的产出」，不证明 agent 能产出正确的东西。
 * 后者是 L2 live 用例的事。
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  prepareExecutionPoint,
  RUN_ID,
  assertCheckFound,
  assertDecision,
  assertJavaMatches,
  assertGeneratedFileExists,
  severityRank,
  type CaseContext,
} from "../llm/harness"

function makeCtx(overrides: Partial<CaseContext> = {}): CaseContext {
  return { artifacts: {}, generatedFiles: {}, stdout: "", workDir: "/tmp", runId: RUN_ID, ...overrides }
}

describe("severityRank", () => {
  it("critical > major > minor > info", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("major"))
    expect(severityRank("major")).toBeGreaterThan(severityRank("minor"))
    expect(severityRank("minor")).toBeGreaterThan(severityRank("info"))
    expect(severityRank(undefined)).toBe(0)
  })
})

describe("assertCheckFound（reviewer 能力断言）", () => {
  // review 改项目级单文件：review.json = { packages: [{ procedureReviews, ... }] }
  const reviewWith = (checks: unknown[]) => ({
    packages: [{ packageName: "BAD_PKG", procedureReviews: [{ procedure: "doSomething", checks }] }],
  })

  it("命中 category=collection-exception + passed=false + severity=major → 通过", () => {
    const ctx = makeCtx({
      artifacts: {
        "review.json": reviewWith([
          { category: "collection-exception", passed: false, severity: "major", detail: "空 catch" },
        ]),
      },
    })
    expect(assertCheckFound(ctx, "collection-exception", "major").passed).toBe(true)
  })

  it("severity 低于阈值（minor）→ 不通过", () => {
    const ctx = makeCtx({
      artifacts: {
        "review.json": reviewWith([
          { category: "collection-exception", passed: false, severity: "minor", detail: "空 catch" },
        ]),
      },
    })
    expect(assertCheckFound(ctx, "collection-exception", "major").passed).toBe(false)
  })

  it("passed=true（非缺陷）→ 不通过", () => {
    const ctx = makeCtx({
      artifacts: {
        "review.json": reviewWith([
          { category: "collection-exception", passed: true, severity: "critical", detail: "ok" },
        ]),
      },
    })
    expect(assertCheckFound(ctx, "collection-exception", "major").passed).toBe(false)
  })

  it("category 不符 → 不通过", () => {
    const ctx = makeCtx({
      artifacts: {
        "review.json": reviewWith([
          { category: "naming-convention", passed: false, severity: "critical", detail: "命名" },
        ]),
      },
    })
    expect(assertCheckFound(ctx, "collection-exception", "major").passed).toBe(false)
  })

  it("critical 也满足 major 阈值 → 通过", () => {
    const ctx = makeCtx({
      artifacts: {
        "review.json": reviewWith([
          { category: "collection-exception", passed: false, severity: "critical", detail: "空 catch" },
        ]),
      },
    })
    expect(assertCheckFound(ctx, "collection-exception", "major").passed).toBe(true)
  })
})

describe("assertDecision（translator 产出）", () => {
  it("decisions 含 EXCEPTION→try-catch → 通过", () => {
    const ctx = makeCtx({
      artifacts: {
        "translations/EXC_PKG/translation.json": {
          decisions: [{ oracleConstruct: "EXCEPTION WHEN OTHERS", javaConstruct: "try-catch", reason: "异常映射", confidence: "high" }],
        },
      },
    })
    expect(assertDecision(ctx, "EXCEPTION", "try-catch").passed).toBe(true)
    expect(assertDecision(ctx, "EXCEPTION").passed).toBe(true)
  })

  it("缺该映射 → 不通过", () => {
    const ctx = makeCtx({
      artifacts: {
        "translations/EXC_PKG/translation.json": {
          decisions: [{ oracleConstruct: "FOR rec IN cursor", javaConstruct: "for-each", reason: "游标", confidence: "high" }],
        },
      },
    })
    expect(assertDecision(ctx, "EXCEPTION").passed).toBe(false)
  })
})

describe("assertJavaMatches / assertGeneratedFileExists", () => {
  const CATCH_JAVA = "public void doSomething() {\n  try { risky(); }\n  catch (Exception e) { log.error(\"x\", e); throw e; }\n}"

  it("含非空 catch → 通过", () => {
    const ctx = makeCtx({ generatedFiles: { "generated/exc/src/ExcServiceImpl.java": CATCH_JAVA } })
    expect(assertJavaMatches(ctx, "**/ExcServiceImpl.java", /catch\s*\([^)]+\)\s*\{[\s\S]*?\}/).passed).toBe(true)
    expect(assertGeneratedFileExists(ctx, "**/ExcServiceImpl.java").passed).toBe(true)
  })

  it("无 catch → 不通过", () => {
    const ctx = makeCtx({ generatedFiles: { "generated/exc/src/ExcServiceImpl.java": "public void doSomething() {}\n" } })
    expect(assertJavaMatches(ctx, "**/ExcServiceImpl.java", /catch\s*\([^)]+\)\s*\{[\s\S]*?\}/).passed).toBe(false)
  })

  it("文件不存在 → 不通过", () => {
    const ctx = makeCtx({ generatedFiles: {} })
    expect(assertGeneratedFileExists(ctx, "**/ExcServiceImpl.java").passed).toBe(false)
  })
})

describe("prepareExecutionPoint（真实引擎推进，不调 opencode）", () => {
  it("推进到 review：currentPhase=review, status=running, 上游 artifact 就位", () => {
    const workDir = mkdtempSync(join(tmpdir(), "sql2java-oracle-"))
    try {
      prepareExecutionPoint({
        workDir,
        phase: "review",
        prepareArtifacts: dir => {
          writeFileSync(join(dir, "inventory-index.json"), '{"packages":[{"name":"BAD_PKG"}]}')
          writeFileSync(join(dir, "plan.json"), '{"x":1}')
          writeFileSync(join(dir, "scaffold.json"), '{"x":1}')
          writeFileSync(join(dir, "analysis.json"), '{"x":1}')
        },
      })
      const runDir = join(workDir, ".workflow-artifacts", RUN_ID)
      const runJson = JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8"))
      expect(runJson.currentPhase).toBe("review")
      expect(runJson.status).toBe("running")
      expect(existsSync(join(runDir, "inventory-index.json"))).toBe(true)
    } finally {
      // mkdtempSync 在 tmpdir，由 OS 清理；显式不删避免额外依赖
    }
  })

  it("推进到 translate：currentPhase=translate", () => {
    const workDir = mkdtempSync(join(tmpdir(), "sql2java-oracle-"))
    prepareExecutionPoint({
      workDir,
      phase: "translate",
      sourcePath: "src-sql",
      prepareArtifacts: dir => {
        writeFileSync(join(dir, "inventory-index.json"), '{"packages":[{"name":"EXC_PKG"}]}')
      },
    })
    const runJson = JSON.parse(readFileSync(join(workDir, ".workflow-artifacts", RUN_ID, "run.json"), "utf-8"))
    expect(runJson.currentPhase).toBe("translate")
    expect(runJson.metadata.sourcePath).toBe("src-sql")
  })
})
