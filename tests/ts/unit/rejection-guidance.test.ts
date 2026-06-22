/**
 * rejection-guidance.test.ts — enhanceRejection 引导语追加逻辑测试
 */

import { describe, it, expect } from "vitest"
import { PHASE_REJECTION_GUIDANCE, enhanceRejection } from "@workflow/rejection-guidance"

// ═══════════════════════════════════════════════════════════════

describe("enhanceRejection", () => {
  const RAW_ERROR = 'Zod validation failed for inventory.json:\n  - packageNames: Array must contain at least 1 element'

  it("已知阶段追加对应引导语", () => {
    const result = enhanceRejection("inventory", RAW_ERROR)
    expect(result).toContain(RAW_ERROR)
    expect(result).toContain("⚠️ 此错误通常意味着")
    expect(result).toContain("重新审视扫描过程")
    expect(result).toContain("而非仅修补 JSON 字段")
    // 引导语在原始错误之后，用双换行分隔
    expect(result).toBe(`${RAW_ERROR}\n\n${PHASE_REJECTION_GUIDANCE["inventory"]}`)
  })

  it("每个已知阶段的引导语都包含关键要素", () => {
    const phases = Object.keys(PHASE_REJECTION_GUIDANCE)
    expect(phases.length).toBeGreaterThanOrEqual(10) // 覆盖所有阶段

    for (const phase of phases) {
      const guidance = PHASE_REJECTION_GUIDANCE[phase]
      // 必须包含警示标记
      expect(guidance).toContain("⚠️")
      // 必须指向"重新执行/审视"执行过程而非"修补字段"
      expect(guidance).toMatch(/重新(审视|执行)/)
      // 必须明确禁止"仅修补 JSON 字段"
      expect(guidance).toContain("而非仅修补 JSON 字段")
    }
  })

  it("未知阶段不追加引导语", () => {
    const result = enhanceRejection("unknown-phase", RAW_ERROR)
    expect(result).toBe(RAW_ERROR)
  })

  it("phase 为 null 时不追加引导语", () => {
    const result = enhanceRejection(null, RAW_ERROR)
    expect(result).toBe(RAW_ERROR)
  })

  it("各阶段引导语内容不同（针对性）", () => {
    const guidances = Object.values(PHASE_REJECTION_GUIDANCE)
    const unique = new Set(guidances)
    // 每个阶段的引导语应该各不相同
    expect(unique.size).toBe(guidances.length)
  })

  it("各阶段引导语包含该阶段特有的执行动作词", () => {
    const phaseActionWords: Record<string, string> = {
      "inventory-index": "扫描",
      "inventory": "扫描",
      "analyze": "分析",
      "plan": "规划",
      "scaffold": "生成",
      "translate": "翻译",
      "review": "审查",
      "verify": "验证",
      "dedup": "去重",
      "fix": "修复",
    }
    for (const [phase, actionWord] of Object.entries(phaseActionWords)) {
      expect(PHASE_REJECTION_GUIDANCE[phase]).toContain(actionWord)
    }
  })
})
