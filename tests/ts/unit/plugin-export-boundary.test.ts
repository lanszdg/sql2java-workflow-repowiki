import { describe, expect, test } from "vitest"

describe("workflow-engine plugin export boundary", () => {
  test("runtime plugin module exposes only opencode plugin entries", async () => {
    const pluginModule = await import("@plugins/workflow-engine")

    expect(Object.keys(pluginModule).sort()).toEqual(["WorkflowEnginePlugin", "server"])
    expect(pluginModule.server).toBe(pluginModule.WorkflowEnginePlugin)
  }, 120_000)
})
