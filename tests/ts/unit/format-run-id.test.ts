/**
 * format-run-id.test.ts — runId 生成测试
 *
 * 格式：run-<project>-YYYYMMDD-HHMMSS
 * project = sourcePath 的 basename（净化），缺失用 unknown。
 */

import { describe, it, expect } from "vitest"
import { formatRunId } from "@plugins/workflow-engine"

describe("formatRunId", () => {
  it("格式为 run-<basename>-YYYYMMDD-HHMMSS", () => {
    const id = formatRunId("/home/user/procurement")
    expect(id).toMatch(/^run-procurement-\d{8}-\d{6}$/)
  })

  it("取最终路径段作为 project", () => {
    expect(formatRunId("/a/b/c/order_mgmt")).toMatch(/^run-order_mgmt-\d{8}-\d{6}$/)
    expect(formatRunId("C:\\Users\\me\\procurement")).toMatch(/^run-procurement-\d{8}-\d{6}$/)
  })

  it("兼容尾部斜杠", () => {
    expect(formatRunId("/a/b/procurement/")).toMatch(/^run-procurement-\d{8}-\d{6}$/)
  })

  it("净化非文件名安全字符为 _（折叠连续、去首尾）", () => {
    expect(formatRunId("/a/my project.v2")).toMatch(/^run-my_project_v2-\d{8}-\d{6}$/)
    expect(formatRunId("/a/包名 中文")).toMatch(/^run-____-\d{8}-\d{6}$|^run-[a-zA-Z0-9_-]+-\d{8}-\d{6}$/)
  })

  it("sourcePath 缺失/空/纯斜杠 → 用 unknown 占位", () => {
    expect(formatRunId()).toMatch(/^run-unknown-\d{8}-\d{6}$/)
    expect(formatRunId("")).toMatch(/^run-unknown-\d{8}-\d{6}$/)
    expect(formatRunId("///")).toMatch(/^run-unknown-\d{8}-\d{6}$/)
  })

  it("同一秒内多次调用 project 部分稳定（时间戳一致时 runId 一致）", () => {
    const a = formatRunId("/x/proj")
    const b = formatRunId("/x/proj")
    // 同步连续调用大概率同一秒；project 段必相同
    expect(a.replace(/^run-proj-/, "")).toBe(b.replace(/^run-proj-/, ""))
    expect(a.startsWith("run-proj-")).toBe(true)
  })
})
