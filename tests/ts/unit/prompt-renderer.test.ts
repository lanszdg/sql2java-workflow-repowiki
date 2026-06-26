/**
 * prompt-renderer.test.ts — worker .md 模板渲染器测试
 *
 * 验证 renderWorkerPrompt 加载 .md 模板、填占位符、注入动态块、折叠空行；persist/read 落盘往返。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { renderWorkerPrompt, persistWorkOrder, readPersistedWorkOrder, workOrderFileName, getSubtaskTriggerPrompt } from "@workflow/prompt-renderer"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "prompt-renderer-"))
})

describe("renderWorkerPrompt", () => {
  it("analyze 模板：填占位符 + 注入动态块 + 折叠空行", () => {
    const out = renderWorkerPrompt("analyze", {
      shardLabelSuffix: "（分片 1/13）",
      scopeBanner: "⛔⛔⛔ 分片范围硬约束：唯一工作清单 [\"CORE_PKG.get_item\"] ⛔⛔⛔",
      runId: "run-xyz",
      sourcePath: "/proj/sql",
      artifactsDir: "/proj/.workflow-artifacts/run-xyz",
      mainEntryLine: "",
      projectRootLine: "", // analyze 在 plan 之前，无 projectRoot
      upstreamArtifactsList: "- `/proj/.workflow-artifacts/run-xyz/inventory.json`\n- `/proj/.workflow-artifacts/run-xyz/shard-inputs/CORE_PKG/get_item/source.sql`",
      shardInfoBlock: "## 分片信息\n- 本分片序号: 1 / 13\n- 本分片 PROCEDURE 单元列表: CORE_PKG.get_item",
      scopeBlock: "## 本分片单元读取清单\n- 切片目录：shard-inputs/CORE_PKG/get_item/",
      depSignaturesBlock: "", // analyze 无依赖签名
      schemaHint: "## Schema Hint\nunitRefName 必填",
      rejectionErrorBlock: "",
    })
    expect(out).toContain("analyze Worker 任务（分片 1/13）")
    expect(out).toContain("runId: `run-xyz`")
    expect(out).toContain("sourcePath: `/proj/sql`")
    expect(out).toContain("分片范围硬约束")
    expect(out).toContain("shard-inputs/CORE_PKG/get_item/")
    expect(out).toContain("本分片 PROCEDURE 单元列表: CORE_PKG.get_item")
    expect(out).toContain("Schema Hint")
    // 空占位符（mainEntryLine/projectRootLine/depSignaturesBlock/rejectionErrorBlock）不留 {{}}
    expect(out).not.toContain("{{")
    expect(out).not.toContain("}}")
    // 折叠 3+ 空行
    expect(out).not.toMatch(/\n{3,}/)
  })

  it("translate 模板：含依赖签名块 + projectRoot", () => {
    const out = renderWorkerPrompt("translate", {
      shardLabelSuffix: "（分片 2/13）",
      scopeBanner: "⛔⛔⛔ 唯一工作清单 [\"CORE_PKG.create_item__1\"] ⛔⛔⛔",
      runId: "run-xyz",
      sourcePath: "/proj/sql",
      artifactsDir: "/proj/.workflow-artifacts/run-xyz",
      mainEntryLine: "- mainEntry: `CORE_PKG`",
      projectRootLine: "- projectRoot: `/proj/generated/app`  ← Java/项目文件写入此目录",
      upstreamArtifactsList: "- `/proj/.workflow-artifacts/run-xyz/plan.json`",
      shardInfoBlock: "## 分片信息\n- 本分片序号: 2 / 13",
      scopeBlock: "## 单元读取清单\n- 切片目录：shard-inputs/CORE_PKG/create_item__1/",
      depSignaturesBlock: "## 依赖签名\n- CORE_PKG.get_item → com.x.ItemService#getItem",
      schemaHint: "## Schema Hint\nsubprogramMethods 必填",
      rejectionErrorBlock: "",
    })
    expect(out).toContain("translate Worker 任务（分片 2/13）")
    expect(out).toContain("依赖签名")
    expect(out).toContain("com.x.ItemService#getItem")
    expect(out).toContain("projectRoot: `/proj/generated/app`")
    expect(out).toContain("mainEntry: `CORE_PKG`")
    expect(out).not.toContain("{{")
  })

  it("rejectionError 块注入（advance 被拒重 dispatch）", () => {
    const out = renderWorkerPrompt("analyze", {
      shardLabelSuffix: "（分片 1/13）",
      scopeBanner: "banner",
      runId: "r", sourcePath: "s", artifactsDir: "a",
      mainEntryLine: "", projectRootLine: "",
      upstreamArtifactsList: "- a", shardInfoBlock: "", scopeBlock: "",
      depSignaturesBlock: "", schemaHint: "",
      rejectionErrorBlock: "## ⚠️ 上次 advance 被拒绝——必须先修正以下问题\nZod error: ...",
    })
    expect(out).toContain("上次 advance 被拒绝")
    expect(out).toContain("Zod error")
  })

  it("未知 phase 抛错（模板不存在）", () => {
    expect(() => renderWorkerPrompt("review", {})).toThrow(/template not found/)
  })
})

describe("persist / read workOrder", () => {
  it("落盘 + 读取往返（按分片区分文件名）", () => {
    const art = join(dir, "a")
    const content = "# workOrder\n分片 3/13"
    persistWorkOrder(art, "analyze", 2, content)
    const file = join(art, "dispatch-logs", workOrderFileName("analyze", 2))
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf-8")).toBe(content)
    expect(readPersistedWorkOrder(art, "analyze", 2)).toBe(content)
  })

  it("无 shardIndex → 单文件名 {phase}.workOrder.md", () => {
    expect(workOrderFileName("translate", undefined)).toBe("translate.workOrder.md")
    expect(workOrderFileName("analyze", 5)).toBe("analyze-shard5.workOrder.md")
  })

  it("读取不存在的文件 → null（不抛错）", () => {
    expect(readPersistedWorkOrder(join(dir, "nonexistent"), "analyze", 0)).toBeNull()
  })
})

describe("getSubtaskTriggerPrompt", () => {
  it("返回静态触发器（.md 模板，无运行时值，可 review）", () => {
    const t = getSubtaskTriggerPrompt()
    expect(t).toContain("workOrder 已注入你的系统提示")
    expect(t).toContain("WORKER_SUMMARY")
    // 静态：多次调用结果一致（缓存）
    expect(getSubtaskTriggerPrompt()).toBe(t)
    // 不含运行时占位符
    expect(t).not.toContain("{{")
    expect(t).not.toContain("${")
  })
})
