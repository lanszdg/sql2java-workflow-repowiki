import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  loadRepowikiL2FactsFile,
  runRepowikiL1L2Prepare,
  runRepowikiAnalyzeProvider,
  runRepowikiAnalyzeProviderForDispatch,
  type RepowikiPrepareCommand,
} from "@workflow/repowiki-provider"

function tempArtifacts() {
  const dir = mkdtempSync(join(tmpdir(), "repowiki-provider-"))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function l2Fact(overrides: Record<string, unknown> = {}) {
  return {
    impl_qn: "CORE_PKG",
    package_name: "CORE_PKG",
    method: "get_item",
    signature: "PROCEDURE get_item(p_id IN NUMBER)",
    procedure_type: "PROCEDURE",
    oracle_params: [{ name: "p_id", direction: "IN", oracle_type: "NUMBER", java_type: "Long" }],
    table_facts: [{ table: "INV_TXN", operation: "SELECT" }],
    control_flow: [],
    exception_handlers: [],
    special_syntax: [],
    ...overrides,
  }
}

function fakeRepowikiRoot(base: string) {
  const repowikiDir = join(base, "repowiki-root", "config", "skills", "repowiki")
  const libDir = join(repowikiDir, "lib")
  mkdirSync(libDir, { recursive: true })
  for (const file of [
    join(libDir, "plsql-l1-producer.cjs"),
    join(repowikiDir, "list-services.cjs"),
    join(repowikiDir, "repowiki-l2.cjs"),
    join(repowikiDir, "merge-knowledge.cjs"),
    join(repowikiDir, "repowiki-l3-scheduler.cjs"),
    join(repowikiDir, "repowiki-l3-dispatcher.cjs"),
  ]) {
    writeFileSync(file, "module.exports = {}\n", "utf-8")
  }
  return join(base, "repowiki-root")
}

function fakeDirectRepowikiRuntime(base: string) {
  const runtimeDir = join(base, "repowiki-runtime")
  const libDir = join(runtimeDir, "lib")
  mkdirSync(libDir, { recursive: true })
  for (const file of [
    join(libDir, "plsql-l1-producer.cjs"),
    join(runtimeDir, "list-services.cjs"),
    join(runtimeDir, "repowiki-l2.cjs"),
    join(runtimeDir, "merge-knowledge.cjs"),
    join(runtimeDir, "repowiki-l3-scheduler.cjs"),
    join(runtimeDir, "repowiki-l3-dispatcher.cjs"),
  ]) {
    writeFileSync(file, "module.exports = {}\n", "utf-8")
  }
  return runtimeDir
}

function fakeDirectRepowikiRuntimeWithL3(base: string) {
  return fakeDirectRepowikiRuntime(base)
}

function seedSourceFacts(base: string, facts: Array<Record<string, unknown>> = [l2Fact()]) {
  const sourcePath = join(base, "source")
  const knowledgeDir = join(sourcePath, ".repowiki", "knowledge")
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify({ functions: facts }, null, 2), "utf-8")
  return sourcePath
}

function writeFsdDoc(artifactsDir: string, rel: string, content = "# L3 FSD\n") {
  const file = join(artifactsDir, rel)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, content, "utf-8")
}

function l3Harness(base: string, fsdFiles = ["fsd/CORE_PKG/get_item.md"], facts: Array<Record<string, unknown>> = [l2Fact()]) {
  const sourcePath = seedSourceFacts(base, facts)
  const repowikiRoot = fakeDirectRepowikiRuntimeWithL3(base)
  const l3Runner = (command: RepowikiPrepareCommand) => {
    if (command.name === "l3-dispatcher") {
      for (const rel of fsdFiles) writeFsdDoc(base, rel, `# L3 FSD - ${rel}\n`)
    }
    return { status: 0, stdout: `${command.name} ok` }
  }
  return { sourcePath, repowikiRoot, l3Runner }
}

function fakeRepowikiRootWithLegacyRendererModules(base: string) {
  const root = fakeRepowikiRoot(base)
  const libDir = join(root, "config", "skills", "repowiki", "lib")
  writeFileSync(join(libDir, "fsd-facts-compiler.cjs"), `
if (process.env.REPOWIKI_RENDER_BRIDGE !== "1") {
  throw new Error('require() async module "' + __filename + '" is unsupported. use "await import()" instead.');
}
module.exports = {
  compileFsdFacts(fact, context) {
    return {
      identity: {
        id: fact.impl_qn + "." + fact.method,
        packageName: fact.impl_qn,
        subprogramName: fact.method,
        refName: fact.method,
        kind: fact.procedure_type || "PROCEDURE",
        outputPath: context.outputPath || "fsd/" + fact.impl_qn + "/" + fact.method + ".md"
      },
      signature: { raw: fact.signature, params: fact.oracle_params || [], return: null }
    };
  }
};
`, "utf-8")
  writeFileSync(join(libDir, "fsd-facts-renderer.cjs"), `
module.exports = {
  renderFsdMarkdown(facts) {
    return "# FSD - " + facts.identity.id + "\\n\\n## Overview\\n- Signature: " + facts.signature.raw + "\\n";
  }
};
`, "utf-8")
  return root
}

function fakeDirectRepowikiRuntimeWithLegacyRendererModules(base: string) {
  const root = fakeDirectRepowikiRuntime(base)
  const libDir = join(root, "lib")
  writeFileSync(join(libDir, "fsd-facts-compiler.cjs"), `
module.exports.compileFsdFacts = (fact, context) => ({
  identity: { id: fact.impl_qn + "." + fact.method, packageName: fact.impl_qn, subprogramName: fact.method, outputPath: context.outputPath },
  signature: { raw: fact.signature },
  sourceFact: fact
});
`, "utf-8")
  writeFileSync(join(libDir, "fsd-facts-renderer.cjs"), `
module.exports.renderFsdMarkdown = (facts) => "# Direct Runtime FSD - " + facts.identity.id + "\\n";
`, "utf-8")
  fakeBundledNode(root)
  return root
}

function fakeBundledNode(repowikiRoot: string) {
  const nodePath = join(repowikiRoot, "config", "bin", "codegraph", "node.exe")
  mkdirSync(join(repowikiRoot, "config", "bin", "codegraph"), { recursive: true })
  writeFileSync(nodePath, "", "utf-8")
  return nodePath
}

describe("Repowiki analyze provider", () => {
  it("uses wiki-l3-oracle-sp L3 output instead of renderer markdown for FSD", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      const knowledgeDir = join(sourcePath, ".repowiki", "knowledge")
      const sql2javaRunner = join(t.dir, "lingxicode.bat")
      mkdirSync(knowledgeDir, { recursive: true })
      writeFileSync(sql2javaRunner, "@echo off\n", "utf-8")
      writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify({ functions: [l2Fact()] }, null, 2), "utf-8")
      const repowikiRoot = fakeDirectRepowikiRuntimeWithL3(t.dir)
      const commands: string[] = []

      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath,
        targetUnits: ["CORE_PKG.get_item"],
        l2Facts: [l2Fact()],
        repowikiRoot,
        env: { SQL2JAVA_HOME: t.dir },
        l3Runner: (command) => {
          commands.push(command.name)
          expect(command.env?.REPOWIKI_L3_DOCS_ROOT).toBe(t.dir)
          if (command.name === "l3-dispatcher") {
            expect(command.args).toEqual(expect.arrayContaining(["--runner", sql2javaRunner]))
          }
          if (command.name === "l3-dispatcher") {
            const fsdDir = join(t.dir, "fsd", "CORE_PKG")
            mkdirSync(fsdDir, { recursive: true })
            writeFileSync(join(fsdDir, "get_item.md"), "# L3 FSD - CORE_PKG.get_item\n", "utf-8")
          }
          return { status: 0, stdout: `${command.name} ok` }
        },
      })

      expect(result.status).toBe("completed")
      expect(commands).toEqual(["l3-scheduler", "l3-dispatcher"])
      expect(readFileSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"), "utf-8")).toContain("L3 FSD")
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it("skips without writing artifacts when disabled", () => {
    const t = tempArtifacts()
    try {
      const result = runRepowikiAnalyzeProvider({
        enabled: false,
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        l2Facts: [l2Fact()],
      })

      expect(result.status).toBe("skipped")
      expect(existsSync(join(t.dir, "analysis-packages"))).toBe(false)
      expect(existsSync(join(t.dir, "fsd"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("returns needs_l2_fact and does not write empty docs when target fact is missing", () => {
    const t = tempArtifacts()
    try {
      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        l2Facts: [],
      })

      expect(result.status).toBe("needs_l2_fact")
      expect(result.missingFacts).toEqual(["CORE_PKG.get_item"])
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(false)
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"))).toBe(false)
      expect(existsSync(join(t.dir, "status", "analyze.json"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("writes sql2java analyze artifacts from Repowiki L2 facts", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir)
      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath: l3.sourcePath,
        targetUnits: ["CORE_PKG.get_item"],
        l2Facts: [l2Fact()],
        repowikiRoot: l3.repowikiRoot,
        l3Runner: l3.l3Runner,
        shardIndex: 3,
        now: () => "2026-07-08T00:00:00.000Z",
      })

      expect(result.status).toBe("completed")
      expect(result.writtenArtifacts).toEqual([
        "analysis-packages/CORE_PKG/get_item.json",
        "fsd/CORE_PKG/get_item.md",
      ])

      const unitJson = JSON.parse(readFileSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"), "utf-8"))
      expect(unitJson).toMatchObject({
        unitRefName: "get_item",
        packageName: "CORE_PKG",
        subprograms: [{ name: "get_item" }],
      })

      const fsd = readFileSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"), "utf-8")
      expect(fsd).toContain("L3 FSD")

      const status = JSON.parse(readFileSync(join(t.dir, "status", "analyze.json"), "utf-8"))
      expect(status).toMatchObject({
        phase: "analyze",
        shardIndex: 3,
        status: "completed",
        artifacts: [
          "analysis-packages/CORE_PKG/get_item.json",
          "fsd/CORE_PKG/get_item.md",
        ],
      })
    } finally {
      t.cleanup()
    }
  })

  it("writes only current targetUnits even when Repowiki facts contain extra subprograms", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir)
      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath: l3.sourcePath,
        targetUnits: ["CORE_PKG.get_item"],
        l2Facts: [
          l2Fact(),
          l2Fact({ impl_qn: "CORE_PKG", package_name: "CORE_PKG", method: "archive_item" }),
          l2Fact({ impl_qn: "OTHER_PKG", package_name: "OTHER_PKG", method: "get_item" }),
        ],
        repowikiRoot: l3.repowikiRoot,
        l3Runner: l3.l3Runner,
      })

      expect(result.status).toBe("completed")
      expect(result.writtenArtifacts).toEqual([
        "analysis-packages/CORE_PKG/get_item.json",
        "fsd/CORE_PKG/get_item.md",
      ])
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "archive_item.md"))).toBe(false)
      expect(existsSync(join(t.dir, "fsd", "OTHER_PKG", "get_item.md"))).toBe(false)
      expect(existsSync(join(t.dir, "analysis-packages", "OTHER_PKG", "get_item.json"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("does not use sql2java inventory fallback as formal FSD input when Repowiki L2 misses a target unit", () => {
    const t = tempArtifacts()
    try {
      const subprogramDir = join(t.dir, "subprograms")
      mkdirSync(subprogramDir, { recursive: true })
      writeFileSync(join(subprogramDir, "CORE_PKG.GET_ITEM.json"), JSON.stringify({
        name: "GET_ITEM",
        type: "FUNCTION",
        belongToPackage: "CORE_PKG",
        parameters: [
          { name: "P_ID", type: "NUMBER", mode: "IN" },
        ],
        returnType: "t_item%ROWTYPE",
        bodyLocation: { absolutePath: "pkg/core_pkg.sql", lineRange: [47, 54] },
      }, null, 2), "utf-8")

      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath: seedSourceFacts(t.dir, []),
        targetUnits: ["CORE_PKG.GET_ITEM"],
        l2Facts: [],
      })

      expect(result.status).toBe("needs_l2_fact")
      expect(result.missingFacts).toEqual(["CORE_PKG.GET_ITEM"])
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "GET_ITEM.json"))).toBe(false)
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "GET_ITEM.md"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("matches specified overloaded target refs and rejects missing overload refs", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir, ["fsd/CORE_PKG/get_item__2.md"], [l2Fact({ overload_index: 2 })])
      const matched = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath: l3.sourcePath,
        targetUnits: ["CORE_PKG.get_item__2"],
        l2Facts: [l2Fact({ overload_index: 2 })],
        repowikiRoot: l3.repowikiRoot,
        l3Runner: l3.l3Runner,
      })

      expect(matched.status).toBe("completed")
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item__2.md"))).toBe(true)

      const missing = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.archive_item__2"],
        l2Facts: [l2Fact({ method: "archive_item", overload_index: 1 })],
      })

      expect(missing.status).toBe("needs_l2_fact")
      expect(missing.missingFacts).toEqual(["CORE_PKG.archive_item__2"])
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "archive_item__2.md"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("matches overloaded target refs by sql2java subprogram signature when Repowiki facts omit overload index", () => {
    const t = tempArtifacts()
    try {
      const subprogramDir = join(t.dir, "subprograms")
      mkdirSync(subprogramDir, { recursive: true })
      writeFileSync(join(subprogramDir, "CORE_PKG.CREATE_ITEM__1.json"), JSON.stringify({
        name: "CREATE_ITEM",
        belongToPackage: "CORE_PKG",
        overloadIndex: 1,
        parameters: [
          { name: "P_CODE", type: "VARCHAR2", mode: "IN" },
          { name: "P_NAME", type: "VARCHAR2", mode: "IN" },
          { name: "P_TYPE", type: "VARCHAR2", mode: "IN" },
          { name: "P_ID", type: "NUMBER", mode: "OUT" },
        ],
      }), "utf-8")
      writeFileSync(join(subprogramDir, "CORE_PKG.CREATE_ITEM__2.json"), JSON.stringify({
        name: "CREATE_ITEM",
        belongToPackage: "CORE_PKG",
        overloadIndex: 2,
        parameters: [
          { name: "P_CODE", type: "VARCHAR2", mode: "IN" },
          { name: "P_NAME", type: "VARCHAR2", mode: "IN" },
          { name: "P_TYPE", type: "VARCHAR2", mode: "IN" },
          { name: "P_COST", type: "NUMBER", mode: "IN" },
          { name: "P_ID", type: "NUMBER", mode: "OUT" },
        ],
      }), "utf-8")
      const l3 = l3Harness(t.dir, [
        "fsd/CORE_PKG/CREATE_ITEM__1.md",
        "fsd/CORE_PKG/CREATE_ITEM__2.md",
      ])

      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath: l3.sourcePath,
        targetUnits: ["CORE_PKG.CREATE_ITEM__1", "CORE_PKG.CREATE_ITEM__2"],
        l2Facts: [
          l2Fact({
            method: "create_item",
            signature: "PROCEDURE create_item(p_code IN VARCHAR2, p_name IN VARCHAR2, p_type IN VARCHAR2, p_id OUT NUMBER)",
            oracle_params: [
              { name: "p_code", direction: "IN", oracle_type: "VARCHAR2" },
              { name: "p_name", direction: "IN", oracle_type: "VARCHAR2" },
              { name: "p_type", direction: "IN", oracle_type: "VARCHAR2" },
              { name: "p_id", direction: "OUT", oracle_type: "NUMBER" },
            ],
          }),
          l2Fact({
            method: "create_item",
            signature: "PROCEDURE create_item(p_code IN VARCHAR2, p_name IN VARCHAR2, p_type IN VARCHAR2, p_cost IN NUMBER, p_id OUT NUMBER)",
            oracle_params: [
              { name: "p_code", direction: "IN", oracle_type: "VARCHAR2" },
              { name: "p_name", direction: "IN", oracle_type: "VARCHAR2" },
              { name: "p_type", direction: "IN", oracle_type: "VARCHAR2" },
              { name: "p_cost", direction: "IN", oracle_type: "NUMBER" },
              { name: "p_id", direction: "OUT", oracle_type: "NUMBER" },
            ],
          }),
        ],
        repowikiRoot: l3.repowikiRoot,
        l3Runner: l3.l3Runner,
      })

      expect(result.status).toBe("completed")
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "CREATE_ITEM__1.md"))).toBe(true)
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "CREATE_ITEM__2.md"))).toBe(true)

      const unit1 = JSON.parse(readFileSync(join(t.dir, "analysis-packages", "CORE_PKG", "CREATE_ITEM__1.json"), "utf-8"))
      const unit2 = JSON.parse(readFileSync(join(t.dir, "analysis-packages", "CORE_PKG", "CREATE_ITEM__2.json"), "utf-8"))
      expect(unit1.subprograms[0].variables.map((param: any) => param.name)).toEqual(["p_code", "p_name", "p_type", "p_id"])
      expect(unit2.subprograms[0].variables.map((param: any) => param.name)).toEqual(["p_code", "p_name", "p_type", "p_cost", "p_id"])
    } finally {
      t.cleanup()
    }
  })

  it("matches sql2java synthetic standalone package refs to Repowiki standalone facts", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir, ["fsd/__STANDALONE_FN_ABC_CLASS__/FN_ABC_CLASS.md"])
      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath: l3.sourcePath,
        targetUnits: ["__STANDALONE_FN_ABC_CLASS__.FN_ABC_CLASS"],
        l2Facts: [
          l2Fact({
            impl_qn: "__STANDALONE__",
            package_name: "__STANDALONE__",
            method: "fn_abc_class",
            signature: "FUNCTION fn_abc_class(p_cum_pct IN NUMBER) RETURN VARCHAR2",
            procedure_type: "FUNCTION",
            oracle_params: [{ name: "p_cum_pct", direction: "IN", oracle_type: "NUMBER" }],
          }),
        ],
        repowikiRoot: l3.repowikiRoot,
        l3Runner: l3.l3Runner,
      })

      expect(result.status).toBe("completed")
      expect(existsSync(join(t.dir, "fsd", "__STANDALONE_FN_ABC_CLASS__", "FN_ABC_CLASS.md"))).toBe(true)
      expect(existsSync(join(t.dir, "analysis-packages", "__STANDALONE_FN_ABC_CLASS__", "FN_ABC_CLASS.json"))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it("loads Repowiki functions.json object shape", () => {
    const t = tempArtifacts()
    try {
      const factsFile = join(t.dir, "functions.json")
      writeFileSync(factsFile, JSON.stringify({ functions: [l2Fact()] }, null, 2), "utf-8")

      const facts = loadRepowikiL2FactsFile(factsFile)

      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ impl_qn: "CORE_PKG", method: "get_item" })
    } finally {
      t.cleanup()
    }
  })

  it("dispatch hook writes artifacts and asks orchestrator to advance instead of spawning analyze worker", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir)
      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true },
        sourcePath: l3.sourcePath,
        l2Facts: [l2Fact()],
        repowikiRoot: l3.repowikiRoot,
        l3Runner: l3.l3Runner,
        shardIndex: 2,
        now: () => "2026-07-08T00:00:00.000Z",
      })

      expect(result.handled).toBe(true)
      expect(result.response?.metadata).toMatchObject({
        runId: "run-test",
        phase: "analyze",
        repowikiProvider: true,
        dispatch: false,
        nextAction: "advance",
      })
      expect(result.response?.output).toContain("workflow({ action: \"advance\"")
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"))).toBe(true)
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it("dispatch hook returns needs_l2_fact without spawning worker or writing empty docs", () => {
    const t = tempArtifacts()
    try {
      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true },
        l2Facts: [],
      })

      expect(result.handled).toBe(true)
      expect(result.response?.metadata).toMatchObject({
        dispatch: false,
        nextAction: "prepare_l2",
        status: "needs_l2_fact",
      })
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(false)
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("does not auto-prepare missing facts unless the explicit switch is enabled", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })
      const commands: string[] = []

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true },
        sourcePath,
        env: {},
        prepareRunner: (command) => {
          commands.push(command.name)
          return { status: 0 }
        },
      })

      expect(result.handled).toBe(true)
      expect(result.response?.metadata).toMatchObject({
        dispatch: false,
        nextAction: "prepare_l2",
        status: "needs_l2_fact",
      })
      expect(commands).toEqual([])
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("returns repair_provider when auto-prepare cannot produce Repowiki facts", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true, repowikiAutoPrepare: true },
        sourcePath,
        env: {},
      })

      expect(result.handled).toBe(true)
      expect(result.response?.metadata).toMatchObject({
        dispatch: false,
        nextAction: "repair_provider",
        status: "failed",
      })
      expect(String(result.response?.metadata.error)).toMatch(/Repowiki runtime unavailable|list-services failed/)
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("returns repair_provider and writes no analyze artifacts when a Repowiki prepare command fails", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })
      const repowikiRoot = fakeRepowikiRoot(t.dir)
      const commands: string[] = []

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true, repowikiAutoPrepare: true, repowikiRoot },
        sourcePath,
        repowikiRoot,
        env: {},
        prepareRunner: (command) => {
          commands.push(command.name)
          return command.name === "list-services"
            ? { status: 4, stderr: "no oracle-sp modules" }
            : { status: 0 }
        },
      })

      expect(commands).toEqual(["plsql-l1", "list-services"])
      expect(result.response?.metadata).toMatchObject({
        dispatch: false,
        nextAction: "repair_provider",
        status: "failed",
      })
      expect(String(result.response?.metadata.error)).toContain("list-services failed")
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"))).toBe(false)
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it("auto-prepares Repowiki L1/L2 facts and then writes sql2java analyze artifacts", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })
      const repowikiRoot = fakeRepowikiRoot(t.dir)
      const commands: RepowikiPrepareCommand[] = []
      const l3Runner = (command: RepowikiPrepareCommand) => {
        if (command.name === "l3-dispatcher") {
          writeFsdDoc(t.dir, "fsd/CORE_PKG/get_item.md", "# L3 FSD - CORE_PKG.get_item\n")
        }
        return { status: 0, stdout: `${command.name} ok` }
      }

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true, repowikiAutoPrepare: true, repowikiRoot },
        sourcePath,
        repowikiRoot,
        env: {},
        prepareRunner: (command) => {
          commands.push(command)
          if (command.name === "merge-knowledge") {
            const knowledgeDir = command.env?.REPOWIKI_WORK_DIR
              ? join(command.env.REPOWIKI_WORK_DIR, "knowledge")
              : join(sourcePath, ".repowiki", "knowledge")
            mkdirSync(knowledgeDir, { recursive: true })
            writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify({ functions: [l2Fact()] }, null, 2), "utf-8")
          }
          return { status: 0 }
        },
        l3Runner,
        now: () => "2026-07-08T00:00:00.000Z",
      })

      expect(commands.map((command) => command.name)).toEqual([
        "plsql-l1",
        "list-services",
        "repowiki-l2",
        "merge-knowledge",
      ])
      expect(commands[1].args).toContain("--profile")
      expect(commands[1].args).toContain("oracle-sp")
      expect(result.response?.metadata).toMatchObject({
        dispatch: false,
        nextAction: "advance",
        status: "completed",
      })
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"))).toBe(true)
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it("keeps Repowiki L1/L2 working files inside the workflow run artifacts", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })
      const repowikiRoot = fakeRepowikiRoot(t.dir)
      const workDir = join(t.dir, "repowiki-work")

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true, repowikiAutoPrepare: true, repowikiRoot },
        sourcePath,
        repowikiRoot,
        env: {},
        prepareRunner: (command) => {
          expect(command.env?.REPOWIKI_WORK_DIR).toBe(workDir)
          if (command.name === "merge-knowledge") {
            const knowledgeDir = join(workDir, "knowledge")
            mkdirSync(knowledgeDir, { recursive: true })
            writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify({ functions: [l2Fact()] }, null, 2), "utf-8")
          }
          return { status: 0 }
        },
        l3Runner: (command) => {
          expect(command.env?.REPOWIKI_WORK_DIR).toBe(workDir)
          if (command.name === "l3-dispatcher") {
            writeFsdDoc(t.dir, "fsd/CORE_PKG/get_item.md", "# L3 FSD - CORE_PKG.get_item\n")
          }
          return { status: 0, stdout: `${command.name} ok` }
        },
        now: () => "2026-07-08T00:00:00.000Z",
      })

      expect(result.response?.metadata.status).toBe("completed")
      expect(existsSync(join(workDir, "knowledge", "functions.json"))).toBe(true)
      expect(existsSync(join(sourcePath, ".repowiki"))).toBe(false)

      const prepareStatus = JSON.parse(readFileSync(join(t.dir, "status", "repowiki-prepare.json"), "utf-8"))
      expect(prepareStatus.factsFile).toBe(join(workDir, "knowledge", "functions.json"))
    } finally {
      t.cleanup()
    }
  })

  it("does not persist sensitive child process environment in Repowiki L3 status", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir)
      const secret = "sk-test-secret-value"

      const result = runRepowikiAnalyzeProvider({
        enabled: true,
        artifactsDir: t.dir,
        sourcePath: l3.sourcePath,
        targetUnits: ["CORE_PKG.get_item"],
        l2Facts: [l2Fact()],
        repowikiRoot: l3.repowikiRoot,
        env: { OPENAI_API_KEY: secret },
        l3Runner: l3.l3Runner,
        now: () => "2026-07-08T00:00:00.000Z",
      })

      expect(result.status).toBe("completed")
      const l3Status = readFileSync(join(t.dir, "status", "repowiki-l3.json"), "utf-8")
      expect(l3Status).not.toContain("OPENAI_API_KEY")
      expect(l3Status).not.toContain(secret)
    } finally {
      t.cleanup()
    }
  })

  it("auto-prepares once per run before L3 consumes Repowiki facts", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })

      const repowikiRoot = fakeRepowikiRoot(t.dir)
      const commands: string[] = []
      const l3Commands: string[] = []
      const options = {
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.GET_ITEM"],
        metadata: { repowikiAnalyzeProvider: true, repowikiAutoPrepare: true, repowikiRoot },
        sourcePath,
        repowikiRoot,
        env: {},
        prepareRunner: (command: RepowikiPrepareCommand) => {
          commands.push(command.name)
          if (command.name === "merge-knowledge") {
            const knowledgeDir = command.env?.REPOWIKI_WORK_DIR
              ? join(command.env.REPOWIKI_WORK_DIR, "knowledge")
              : join(sourcePath, ".repowiki", "knowledge")
            mkdirSync(knowledgeDir, { recursive: true })
            writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify({ functions: [l2Fact({ method: "GET_ITEM" })] }, null, 2), "utf-8")
          }
          return { status: 0 }
        },
        l3Runner: (command: RepowikiPrepareCommand) => {
          l3Commands.push(command.name)
          if (command.name === "l3-dispatcher") {
            writeFsdDoc(t.dir, "fsd/CORE_PKG/GET_ITEM.md", "# L3 FSD - CORE_PKG.GET_ITEM\n")
          }
          return { status: 0, stdout: `${command.name} ok` }
        },
        now: () => "2026-07-08T00:00:00.000Z",
      }

      const first = runRepowikiAnalyzeProviderForDispatch(options)
      const second = runRepowikiAnalyzeProviderForDispatch(options)

      expect(first.response?.metadata.status).toBe("completed")
      expect(second.response?.metadata.status).toBe("completed")
      expect(commands).toEqual(["plsql-l1", "list-services", "repowiki-l2", "merge-knowledge"])
      expect(l3Commands).toEqual(["l3-scheduler", "l3-dispatcher"])
      expect(existsSync(join(t.dir, "status", "repowiki-prepare.json"))).toBe(true)
      expect(existsSync(join(t.dir, "status", "repowiki-l3.json"))).toBe(true)

      const unitJson = JSON.parse(readFileSync(join(t.dir, "analysis-packages", "CORE_PKG", "GET_ITEM.json"), "utf-8"))
      expect(unitJson.subprograms[0].translationNotes).not.toContain("source: sql2java-inventory-fallback")
    } finally {
      t.cleanup()
    }
  })

  it("exposes a thin Repowiki prepare runner without copying Repowiki algorithms", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })
      const repowikiRoot = fakeRepowikiRoot(t.dir)
      const commands: string[] = []

      const result = runRepowikiL1L2Prepare({
        sourcePath,
        repowikiRoot,
        env: {},
        runner: (command) => {
          commands.push(command.name)
          if (command.name === "merge-knowledge") {
            const knowledgeDir = join(sourcePath, ".repowiki", "knowledge")
            mkdirSync(knowledgeDir, { recursive: true })
            writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify({ functions: [l2Fact()] }, null, 2), "utf-8")
          }
          return { status: 0 }
        },
      })

      expect(result.status).toBe("completed")
      expect(result.factsFile).toBe(join(sourcePath, ".repowiki", "knowledge", "functions.json"))
      expect(commands).toEqual(["plsql-l1", "list-services", "repowiki-l2", "merge-knowledge"])
    } finally {
      t.cleanup()
    }
  })

  it("accepts a direct vendored Repowiki runtime instead of requiring config skills layout", () => {
    const t = tempArtifacts()
    try {
      const repowikiRoot = fakeDirectRepowikiRuntime(t.dir)
      const commands: RepowikiPrepareCommand[] = []
      const sourcePath = join(t.dir, "repo")
      mkdirSync(sourcePath, { recursive: true })
      const result = runRepowikiL1L2Prepare({
        sourcePath,
        repowikiRoot,
        nodePath: process.execPath,
        runner: (step) => {
          commands.push(step)
          const knowledgeDir = join(sourcePath, ".repowiki", "knowledge")
          mkdirSync(knowledgeDir, { recursive: true })
          if (step.name === "merge-knowledge") {
            writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify([l2Fact()]), "utf-8")
          }
          return { status: 0 }
        },
      })

      expect(result.status).toBe("completed")
      expect(commands.map((cmd) => cmd.args[0])).toEqual([
        join(repowikiRoot, "lib", "plsql-l1-producer.cjs"),
        join(repowikiRoot, "list-services.cjs"),
        join(repowikiRoot, "repowiki-l2.cjs"),
        join(repowikiRoot, "merge-knowledge.cjs"),
      ])
    } finally {
      t.cleanup()
    }
  })

  it("uses the bundled Lingxi node for Repowiki prepare commands", () => {
    const t = tempArtifacts()
    try {
      const sourcePath = join(t.dir, "source")
      mkdirSync(sourcePath, { recursive: true })
      const repowikiRoot = fakeRepowikiRoot(t.dir)
      const bundledNode = fakeBundledNode(repowikiRoot)
      const commands: RepowikiPrepareCommand[] = []

      const result = runRepowikiL1L2Prepare({
        sourcePath,
        repowikiRoot,
        env: {},
        runner: (command) => {
          commands.push(command)
          if (command.name === "merge-knowledge") {
            const knowledgeDir = join(sourcePath, ".repowiki", "knowledge")
            mkdirSync(knowledgeDir, { recursive: true })
            writeFileSync(join(knowledgeDir, "functions.json"), JSON.stringify({ functions: [l2Fact()] }, null, 2), "utf-8")
          }
          return { status: 0 }
        },
      })

      expect(result.status).toBe("completed")
      expect(commands.map((command) => command.command)).toEqual([
        bundledNode,
        bundledNode,
        bundledNode,
        bundledNode,
      ])
    } finally {
      t.cleanup()
    }
  })

  it("dispatch hook reads default sourcePath .repowiki knowledge functions.json", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir)

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true, repowikiRoot: l3.repowikiRoot },
        sourcePath: l3.sourcePath,
        repowikiRoot: l3.repowikiRoot,
        l3Runner: l3.l3Runner,
      })

      expect(result.handled).toBe(true)
      expect(result.response?.metadata.nextAction).toBe("advance")
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it("uses wiki-l3-oracle-sp even when legacy renderer modules exist", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir)
      const repowikiRoot = fakeRepowikiRootWithLegacyRendererModules(t.dir)

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true, repowikiRoot },
        sourcePath: l3.sourcePath,
        repowikiRoot,
        env: { REPOWIKI_NODE_PATH: process.execPath },
        l3Runner: l3.l3Runner,
      })

      expect(result.response?.metadata).toMatchObject({
        dispatch: false,
        nextAction: "advance",
        status: "completed",
      })
      expect(readFileSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"), "utf-8")).toContain("L3 FSD")
    } finally {
      t.cleanup()
    }
  })

  it("uses wiki-l3-oracle-sp with a direct vendored Repowiki runtime", () => {
    const t = tempArtifacts()
    try {
      const l3 = l3Harness(t.dir)
      const repowikiRoot = fakeDirectRepowikiRuntimeWithLegacyRendererModules(t.dir)

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true, repowikiRoot },
        sourcePath: l3.sourcePath,
        repowikiRoot,
        env: { REPOWIKI_NODE_PATH: process.execPath },
        l3Runner: l3.l3Runner,
      })

      expect(result.providerResult?.status).toBe("completed")
      expect(readFileSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"), "utf-8")).toContain("L3 FSD")
    } finally {
      t.cleanup()
    }
  })

  it("dispatch hook returns repair feedback for malformed functions.json without throwing", () => {
    const t = tempArtifacts()
    try {
      const factsFile = join(t.dir, "bad-functions.json")
      writeFileSync(factsFile, "{not-json", "utf-8")

      const result = runRepowikiAnalyzeProviderForDispatch({
        currentPhase: "analyze",
        runId: "run-test",
        artifactsDir: t.dir,
        targetUnits: ["CORE_PKG.get_item"],
        metadata: { repowikiAnalyzeProvider: true },
        l2FactsFile: factsFile,
      })

      expect(result.handled).toBe(true)
      expect(result.response?.metadata).toMatchObject({
        dispatch: false,
        nextAction: "repair_provider",
        status: "failed",
      })
      expect(existsSync(join(t.dir, "fsd", "CORE_PKG", "get_item.md"))).toBe(false)
      expect(existsSync(join(t.dir, "analysis-packages", "CORE_PKG", "get_item.json"))).toBe(false)
    } finally {
      t.cleanup()
    }
  })
})
