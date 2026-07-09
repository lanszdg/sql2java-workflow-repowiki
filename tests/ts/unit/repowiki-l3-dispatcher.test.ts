import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const dispatcher = require("../../../vendor/repowiki-runtime/repowiki-l3-dispatcher.cjs")

describe("Repowiki L3 dispatcher worker invocation", () => {
  it("passes the long worker prompt through an attachment instead of the command line", () => {
    const args = dispatcher.buildWorkerRunArgs({
      repo: "D:\\repo",
      model: "",
    }, "l3-worker-test", "D:\\repo\\.repowiki\\logs\\l3-dispatcher\\prompts\\l3-worker-test.prompt.md")

    expect(args).toEqual(expect.arrayContaining([
      "--file",
      "D:\\repo\\.repowiki\\logs\\l3-dispatcher\\prompts\\l3-worker-test.prompt.md",
    ]))
    const message = String(args.find((item) => String(item).includes("attached L3 worker prompt")) || "")
    expect(message).toContain("attached L3 worker prompt")
    expect(args.indexOf(message)).toBeLessThan(args.indexOf("--file"))
    expect(message.length).toBeLessThan(300)
    expect(args.join("\n")).not.toContain("commands.done")
  })

  it("preserves Windows lowercase path when building worker environment", () => {
    const env = dispatcher.runnerEnv({
      path: "C:\\Windows\\System32;C:\\Windows",
    })

    expect(env.PATH).toContain("C:\\Windows\\System32")
    expect(env.PATH).toContain("C:\\Windows")
  })

  it("builds Windows batch runner invocation through cmd call without escaped command quotes", () => {
    const plan = dispatcher.windowsBatSpawnPlan("D:\\repo with space\\lingxicode.bat", [
      "run",
      "--dir",
      "D:\\repo with space\\src",
      "Read the attached prompt.",
    ], "C:\\Windows\\System32\\cmd.exe")

    expect(plan.command).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(plan.args.slice(0, 4)).toEqual(["/d", "/s", "/c", "call"])
    expect(plan.args[4]).toBe("D:\\repo with space\\lingxicode.bat")
    expect(plan.args.join(" ")).not.toContain("\\\"")
  })
})
