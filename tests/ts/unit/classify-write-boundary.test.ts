/**
 * classify-write-boundary.test.ts — per-unit 写入边界测试（Phase 1）
 *
 * 验证 unitWriteBoundaryViolation：unit 模式下只允许写本分片 targetUnits（含 cargo FUNCTION）
 * 的 per-unit 产物；聚合文件 / 其他 unit / 非两级路径放行或拦截。
 */

import { describe, it, expect } from "vitest"
import { unitWriteBoundaryViolation } from "@plugins/workflow-engine"

describe("unitWriteBoundaryViolation", () => {
  // 本分片 targetUnits = PKG_A.proc1，cargo = PKG_A.calc_total
  const allowed = new Set(["PROC1", "CALC_TOTAL"])

  it("本 unit 根 per-unit 产物：放行", () => {
    expect(unitWriteBoundaryViolation("analysis-packages/PKG_A/proc1.json", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("fsd/PKG_A/proc1.md", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("translations/PKG_A/proc1.json", allowed)).toBeNull()
  })

  it("cargo FUNCTION per-unit 产物：放行（allowed 含 cargo ref）", () => {
    expect(unitWriteBoundaryViolation("fsd/PKG_A/calc_total.md", allowed)).toBeNull()
  })

  it("其他 unit 的 per-unit 产物：拦截", () => {
    expect(unitWriteBoundaryViolation("analysis-packages/PKG_A/proc2.json", allowed)).not.toBeNull()
    expect(unitWriteBoundaryViolation("fsd/PKG_A/other.md", allowed)).not.toBeNull()
    expect(unitWriteBoundaryViolation("translations/PKG_A/proc2.json", allowed)).not.toBeNull()
  })

  it("聚合文件（一级目录）不匹配两级正则 → 放行", () => {
    expect(unitWriteBoundaryViolation("translations/PKG_A/translation.json", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("translations/PKG_A/review.json", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("translations/PKG_A/verify.json", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("analysis-packages/PKG_A.json", allowed)).toBeNull()
  })

  it("非 per-unit 路径（项目文件 / 其他 artifact）放行", () => {
    expect(unitWriteBoundaryViolation("plan.json", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("scaffold.json", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("shard-inputs/PKG_A/proc1/source.sql", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("src/main/java/com/x/Foo.java", allowed)).toBeNull()
  })

  it("大小写不敏感：ref 大小写不一致仍按大写匹配", () => {
    expect(unitWriteBoundaryViolation("fsd/PKG_A/PROC1.md", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("fsd/PKG_A/Calc_Total.md", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("fsd/PKG_A/PROC2.md", allowed)).not.toBeNull()
  })

  it("allowedRefs 为空/undefined → 不启用边界（包级阶段放行）", () => {
    expect(unitWriteBoundaryViolation("analysis-packages/PKG_A/anyref.json", undefined)).toBeNull()
    expect(unitWriteBoundaryViolation("analysis-packages/PKG_A/anyref.json", new Set())).toBeNull()
  })

  it("反斜杠路径兼容（Windows）", () => {
    expect(unitWriteBoundaryViolation("fsd\\PKG_A\\proc1.md", allowed)).toBeNull()
    expect(unitWriteBoundaryViolation("fsd\\PKG_A\\other.md", allowed)).not.toBeNull()
  })
})
