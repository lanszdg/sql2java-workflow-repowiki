import { describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const contract = require(join(process.cwd(), "vendor", "repowiki-runtime", "lib", "l3-skill-contract.cjs"))

describe("Repowiki L3 skill contract", () => {
  it("lets wiki-l3-oracle-sp write docs under the sql2java artifacts root", () => {
    const envName = "REPOWIKI_L3_DOCS_ROOT"
    const previous = process.env[envName]
    process.env[envName] = join(process.cwd(), ".workflow-artifacts", "run-123")
    try {
      const manifest = {
        docsDir: "fsd",
        docsRootEnv: envName,
      }

      expect(contract.docsDir("D:/source/project", manifest).replace(/\\/g, "/"))
        .toMatch(/\.workflow-artifacts\/run-123\/fsd$/)
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
    }
  })

  it("loads wiki-l3-oracle-sp manifest from the vendored Lingxi skill layout", () => {
    const baseDir = join(process.cwd(), "vendor", "repowiki-runtime")
    const skillDir = contract.skillDir(baseDir, "wiki-l3-oracle-sp").replace(/\\/g, "/")
    const manifest = contract.loadManifest(baseDir, "wiki-l3-oracle-sp")

    expect(skillDir).toMatch(/vendor\/lingxicode-runtime\/config\/skills\/wiki-l3-oracle-sp$/)
    expect(manifest.docsDir).toBe("fsd")
    expect(manifest.capabilities.serviceList).toBe(false)
    expect(manifest.capabilities.functionList).toBe(false)
    expect(manifest.capabilities.functionDocGuide).toBe(false)
  })
})
