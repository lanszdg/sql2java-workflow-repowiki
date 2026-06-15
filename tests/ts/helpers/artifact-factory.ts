/**
 * Artifact Factory — 构建有效 artifact JSON 对象，供测试使用
 *
 * 每个函数返回对应阶段的有效 artifact 数据。
 * 可通过展开 + 覆写的方式生成变体。
 *
 * 注意：本文件被 vitest（tests/ts）与 tsx（case.config.ts）双重加载，故对 .opencode
 * 用相对路径引入（@workflow 别名只在 vitest 生效）。
 */

import { safeWriteFile } from "../../../.opencode/workflow/cross-platform"
import { join } from "node:path"

// ── Inventory Index ──────────────────────────────────────────

export function makeInventoryIndex(overrides: Record<string, unknown> = {}) {
  return {
    sourcePath: "/test/source",
    scannedAt: "2026-06-01T00:00:00.000Z",
    scannerUsed: "regex" as const,
    packages: [
      {
        name: "CORE_PKG",
        specFile: "pkg/core_pkg.pks",
        bodyFile: "pkg/core_pkg.pkb",
        procedures: [
          { name: "GET_ITEM", type: "function" as const, lineRange: [10, 50] as [number, number] },
          { name: "SET_ITEM", type: "procedure" as const, lineRange: [52, 90] as [number, number] },
        ],
        estimatedLoc: 200,
      },
    ],
    tables: [{ name: "ITEMS", ddlFile: "schema/tables.sql" }],
    triggers: [{ name: "TRG_ITEM_AUD", sourceFile: "trigger/trg_item_audit.sql" }],
    views: [],
    sequences: [{ name: "SEQ_ITEM_ID", sourceFile: "schema/sequences.sql" }],
    standaloneProcedures: [],
    ...overrides,
  }
}

// ── Inventory (full) ─────────────────────────────────────────

export function makeInventory(overrides: Record<string, unknown> = {}) {
  return {
    sourcePath: "/test/source",
    totalPackages: 1,
    packages: [
      {
        name: "CORE_PKG",
        specFile: "pkg/core_pkg.pks",
        bodyFile: "pkg/core_pkg.pkb",
        procedureCount: 2,
        procedures: [
          { name: "GET_ITEM", type: "function", oracleLine: 10 },
          { name: "SET_ITEM", type: "procedure", oracleLine: 52 },
        ],
        estimatedLoc: 200,
        complexityGroup: "medium" as const,
        dependencies: [],
      },
    ],
    tables: [{ name: "ITEMS", ddlFile: "schema/tables.sql" }],
    triggers: [{ name: "TRG_ITEM_AUD", sourceFile: "trigger/trg_item_audit.sql" }],
    views: [],
    sequences: [{ name: "SEQ_ITEM_ID", sourceFile: "schema/sequences.sql" }],
    ...overrides,
  }
}

// ── Analysis Meta ────────────────────────────────────────────

/** analysis.json — 全局元数据（callGraph key 用 PKG.refName） */
export function makeAnalysisMeta(overrides: Record<string, unknown> = {}) {
  return {
    callGraph: { "CORE_PKG.GET_ITEM": [], "CORE_PKG.SET_ITEM": [] },
    packageDependency: { CORE_PKG: [] },
    translationOrder: [["CORE_PKG"]],
    complexity: { CORE_PKG: { score: 3, patterns: [], riskLevel: "low" as const } },
    sccGroups: [],
    packageNames: ["CORE_PKG"],
    ...overrides,
  }
}

// ── Plan ─────────────────────────────────────────────────────

export function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    targetProject: {
      artifactId: "item-service",
      groupId: "com.example",
      packageBase: "com.example.item",
      javaVersion: "17",
      springBootVersion: "3.2.0",
    },
    packageMappings: [
      {
        oraclePackage: "CORE_PKG",
        javaPackage: "com.example.item",
        mapperInterface: "ItemMapper",
        serviceClass: "ItemService",
        serviceImplClass: "ItemServiceImpl",
      },
    ],
    rules: {
      namingConvention: "camelCase",
      nullHandling: "optional",
      exceptionStrategy: "spring-data",
      logFramework: "slf4j",
    },
    typeMappings: {},
    manualReviewList: [],
    conventions: "Standard conventions",
    ...overrides,
  }
}

// ── Scaffold ─────────────────────────────────────────────────

/** scaffold.json — 对齐 ScaffoldSchema */
export function makeScaffold(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: "generated/item-service",
    structure: {
      directories: ["src/main/java/com/example/item"],
      pomXml: "pom.xml",
    },
    generated: {
      entities: [],
      mapperInterfaces: [{ file: "src/main/java/com/example/item/mapper/ItemMapper.java", oraclePackage: "CORE_PKG" }],
      serviceShells: [{ file: "src/main/java/com/example/item/service/impl/ItemServiceImpl.java", oraclePackage: "CORE_PKG" }],
      commonClasses: [],
    },
    conventions: "Standard conventions",
    ...overrides,
  }
}

// ── Inventory Package（逐包）─────────────────────────────────

/** inventory-packages/{PKG}.json — 对齐 InventoryPackageSchema */
export function makeInventoryPackage(overrides: Record<string, unknown> = {}) {
  return {
    packageName: "CORE_PKG",
    specFile: "pkg/core_pkg.pks",
    bodyFile: "pkg/core_pkg.pkb",
    procedures: [
      {
        name: "GET_ITEM",
        type: "function" as const,
        params: [{ name: "P_ID", oracleType: "NUMBER", direction: "IN" as const }],
        lineRange: [10, 50] as [number, number],
        loc: 40,
      },
    ],
    types: [],
    variables: [],
    constants: [],
    ...overrides,
  }
}

// ── Analysis Package（逐包）──────────────────────────────────

/** analysis-packages/{PKG}.json — 对齐 AnalysisPackageSchema */
export function makeAnalysisPackage(overrides: Record<string, unknown> = {}) {
  return {
    packageName: "CORE_PKG",
    subprograms: [
      {
        name: "GET_ITEM",
        blocks: [{ type: "sql-statement" as const, oracleLine: 12, description: "SELECT INTO 查询", dependencies: [] }],
        variables: [],
        cursors: [],
        exceptionHandlers: [],
        translationNotes: "按 id 查询",
      },
    ],
    ...overrides,
  }
}

// ── Translation (per package) ────────────────────────────────

/** translations/{PKG}/translation.json — 对齐 TranslationSchema（含 subprogramMethods） */
export function makeTranslation(overrides: Record<string, unknown> = {}) {
  return {
    packageName: "CORE_PKG",
    status: "completed" as const,
    completedSubprograms: ["GET_ITEM"],
    totalSubprograms: 1,
    files: [{ path: "service/ItemService.java", role: "service-impl" }],
    decisions: [],
    todos: [],
    subprogramMethods: [
      { oracleName: "GET_ITEM", javaClass: "com.example.item.ItemService", javaMethod: "getItem" },
    ],
    ...overrides,
  }
}

// ── Review Summary ───────────────────────────────────────────

export function makeReviewSummary(overrides: Record<string, unknown> = {}) {
  return {
    allPassed: true,
    packageResults: [
      { packageName: "CORE_PKG", passed: true, score: 85, mustFixCount: 0 },
    ],
    totalMustFix: 0,
    totalTodosRemaining: 0,
    ...overrides,
  }
}

// ── Verify Summary ───────────────────────────────────────────

export function makeVerifySummary(overrides: Record<string, unknown> = {}) {
  return {
    allPassed: true,
    compilation: { success: true, errors: [] },
    packageResults: [
      { packageName: "CORE_PKG", passed: true, mybatisValid: true },
    ],
    // testExecution 为必填（VerifySummarySchema BREAKING），含必填 testFiles[]
    testExecution: {
      executed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      testFiles: ["src/test/java/com/example/item/ItemServiceTest.java"],
    },
    totalTodosRemaining: 0,
    ...overrides,
  }
}

// ── Dedup ────────────────────────────────────────────────────

export function makeDedup(overrides: Record<string, unknown> = {}) {
  return {
    scanStats: {
      totalPackages: 1,
      totalFilesScanned: 10,
      duplicateGroupsFound: 0,
    },
    extractedModules: [],
    packageChanges: [],
    metrics: {
      filesExtracted: 0,
      filesModified: 0,
      linesRemoved: 0,
      linesAdded: 0,
    },
    ...overrides,
  }
}

// ── Fix Artifact ─────────────────────────────────────────────

export function makeFixArtifact(overrides: Record<string, unknown> = {}) {
  return {
    fixedPackages: ["CORE_PKG"],
    fixSummary: "Fixed compilation errors in CORE_PKG",
    ...overrides,
  }
}

// ── 写入 artifact JSON（跨平台原子写） ───────────────────────

/**
 * 将 artifact 数据以 JSON 写入目录（跨平台原子写：tmp→rename，避免半写状态）。
 * 供 case.config.ts 的 prepareArtifacts 复用，替代裸 writeFileSync(JSON.stringify(...))。
 */
export function writeArtifactJson(dir: string, filename: string, data: unknown): void {
  safeWriteFile(join(dir, filename), JSON.stringify(data))
}
