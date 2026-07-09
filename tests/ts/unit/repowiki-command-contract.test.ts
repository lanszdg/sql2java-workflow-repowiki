import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = process.cwd()

describe("sql2java command Repowiki provider contract", () => {
  it("continues with advance when Provider writes analyze artifacts without worker dispatch", () => {
    const command = readFileSync(join(repoRoot, ".opencode", "command", "sql2java.md"), "utf-8")

    expect(command).toContain("Repowiki Provider fast path")
    expect(command).toContain('metadata.dispatch == false && metadata.nextAction == "advance"')
    expect(command).toContain('workflow({ action: "advance", runId })')
  })
})
