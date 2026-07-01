/**
 * Case C：translate-cross-package-call
 *
 * 执行点 = translate phase × 跨包调用对接。
 * 测【translator 跨包调用是否用真实方法名】：A.create_order 调用 B.get_by_id，
 * B 已先翻译（预置 translations/B/translation.json 含 subprogramMethods），断言 A 生成的
 * Java 调用了 B 的真实方法名（来自 subprogramMethods，而非命名约定猜测）。
 *
 * 区分度设计：B.get_by_id 的真实 Java 方法名刻意设为 `fetchRecordById`（**偏离** get_by_id→getById
 * 的命名约定）。translator 只有读了 B 的 subprogramMethods 才会用 fetchRecordById；若靠命名猜测
 * 会生成 getById，断言即失败。
 *
 * 判定：纯断言。
 *   - assertGeneratedFileExists(OrderServiceImpl.java)
 *   - assertJavaMatches 调用了 B 的真实方法 fetchRecordById
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { CaseConfig } from "../../harness"
import { assertGeneratedFileExists, assertJavaMatches } from "../../harness"
import {
  makeInventoryIndex, makeInventory, makeInventoryPackage,
  makePlan, makeScaffold, makeDependencyGraphMeta, makeAnalysisPackage,
  makeTranslation, writeArtifactJson,
} from "../../../ts/helpers/artifact-factory"

const PKG_A = "ORDER_PKG" // 调用方（待翻译）
const PKG_B = "UTIL_PKG" // 被调用（叶子，已预置翻译）
const SOURCE_DIR_REL = "src-sql"
const PROJECT_ROOT_REL = "generated/order-service"
/** B.get_by_id 的真实 Java 方法名 —— 刻意偏离命名约定，验证 translator 读了 subprogramMethods */
const B_METHOD = "fetchRecordById"

const config: CaseConfig = {
  name: "translate-cross-package-call",
  phase: "translate",
  trigger: "/sql2java resume",
  sourcePath: SOURCE_DIR_REL,

  prepareArtifacts: dir => {
    // inventory-index（两包，B 叶子在前）
    writeArtifactJson(dir, "inventory-index.json", makeInventoryIndex({
      packages: [
        { name: PKG_B, headerFile: "pkg/util.pks", bodyFile: `${SOURCE_DIR_REL}/UTIL_PKG.pkb`, procedures: [{ name: "get_by_id", type: "function", lineRange: [1, 10] }], estimatedLoc: 10 },
        { name: PKG_A, headerFile: "pkg/order.pks", bodyFile: `${SOURCE_DIR_REL}/ORDER_PKG.pkb`, procedures: [{ name: "create_order", type: "procedure", lineRange: [1, 20] }], estimatedLoc: 20 },
      ],
    }))

    writeArtifactJson(dir, "inventory.json", {
      sourcePath: SOURCE_DIR_REL, packageNames: [PKG_B, PKG_A], tables: [{ name: "T_ORDER", columns: [{ name: "CUST_ID", oracleType: "NUMBER", nullable: true, isPrimaryKey: false }] }], standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })

    // inventory-packages（两包）
    writeArtifactJson(join(dir, "inventory-packages"), `${PKG_B}.json`, makeInventoryPackage({
      packageName: PKG_B,
      bodyFile: `${SOURCE_DIR_REL}/UTIL_PKG.pkb`,
      procedures: [{ name: "get_by_id", type: "function", params: [{ name: "P_ID", oracleType: "NUMBER", direction: "IN" }], lineRange: [1, 10], loc: 10 }],
    }))
    writeArtifactJson(join(dir, "inventory-packages"), `${PKG_A}.json`, makeInventoryPackage({
      packageName: PKG_A,
      bodyFile: `${SOURCE_DIR_REL}/ORDER_PKG.pkb`,
      procedures: [{ name: "create_order", type: "procedure", params: [{ name: "P_CUST_ID", oracleType: "NUMBER", direction: "IN" }], lineRange: [1, 20], loc: 20 }],
    }))

    // plan（两包映射）
    writeArtifactJson(dir, "plan.json", makePlan({
      packageMappings: [
        { oraclePackage: PKG_B, javaPackage: "com.example.util", mapperInterface: "UtilMapper", serviceClass: "UtilService", serviceImplClass: "UtilServiceImpl" },
        { oraclePackage: PKG_A, javaPackage: "com.example.order", mapperInterface: "OrderMapper", serviceClass: "OrderService", serviceImplClass: "OrderServiceImpl" },
      ],
    }))

    // scaffold（A 的骨架）
    writeArtifactJson(dir, "scaffold.json", makeScaffold({
      projectRoot: PROJECT_ROOT_REL,
      structure: { directories: ["src/main/java/com/example/order/service/impl"], pomXml: "pom.xml" },
      generated: {
        entities: [],
        mapperInterfaces: [{ file: "src/main/java/com/example/order/mapper/OrderMapper.java", oraclePackage: PKG_A }],
        serviceShells: [{ file: "src/main/java/com/example/order/service/impl/OrderServiceImpl.java", oraclePackage: PKG_A }],
        commonClasses: [],
      },
    }))

    // analysis（拓扑序：B 叶子先、A 后；callGraph 用 refName key）
    writeArtifactJson(dir, "dependency-graph.json", makeDependencyGraphMeta({
      callGraph: {
        "ORDER_PKG.create_order": ["UTIL_PKG.get_by_id"],
        "UTIL_PKG.get_by_id": [],
      },
      packageDependency: { ORDER_PKG: ["UTIL_PKG"], UTIL_PKG: [] },
      translationOrder: [[PKG_B], [PKG_A]],
      complexity: {
        [PKG_B]: { score: 2, patterns: [], riskLevel: "low" },
        [PKG_A]: { score: 3, patterns: ["cross-package-call"], riskLevel: "low" },
      },
      packageNames: [PKG_B, PKG_A],
    }))

    writeArtifactJson(join(dir, "analysis-packages"), `${PKG_B}.json`, makeAnalysisPackage({
      packageName: PKG_B,
      subprograms: [{ name: "get_by_id", blocks: [{ type: "sql-statement", oracleLine: 3, description: "SELECT INTO 查询", dependencies: [] }], variables: [], cursors: [], exceptionHandlers: [], translationNotes: ["按 id 查询"] }],
    }))
    writeArtifactJson(join(dir, "analysis-packages"), `${PKG_A}.json`, makeAnalysisPackage({
      packageName: PKG_A,
      subprograms: [{
        name: "create_order",
        blocks: [{ type: "call", oracleLine: 5, description: "调用 UTIL_PKG.get_by_id", dependencies: ["UTIL_PKG.get_by_id"] }],
        variables: [], cursors: [], exceptionHandlers: [],
        translationNotes: ["调用 util 包查询后建单（跨包调用）"],
      }],
    }))

    // ★ 关键预置：B 已翻译（含 subprogramMethods）—— A 翻译时读它对接跨包调用
    writeArtifactJson(join(dir, "translations", PKG_B), "translation.json", makeTranslation({
      packageName: PKG_B,
      completedSubprograms: ["get_by_id"],
      files: [
        { path: `${PROJECT_ROOT_REL}/src/main/java/com/example/util/service/UtilService.java`, role: "service" },
        { path: `${PROJECT_ROOT_REL}/src/main/java/com/example/util/service/impl/UtilServiceImpl.java`, role: "service-impl" },
      ],
      decisions: [{ line: 3, oracleConstruct: "SELECT INTO", javaConstruct: "UtilMapper.selectById", reason: "查询映射", confidence: "high" }],
      subprogramMethods: [
        { oracleName: "get_by_id", javaClass: "com.example.util.UtilService", javaMethod: B_METHOD, javaFile: `${PROJECT_ROOT_REL}/src/main/java/com/example/util/service/UtilService.java` },
      ],
    }))

    // FSD：A.create_order（板块 3 列直接依赖 B.get_by_id —— 客观调用关系，不预估 Java 映射）
    mkdirSync(join(dir, "fsd", PKG_A), { recursive: true })
    writeFileSync(join(dir, "fsd", PKG_A, "create_order.md"), FSD_CREATE_ORDER)
  },

  // A 的 PL/SQL（create_order 调用 UTIL_PKG.get_by_id）
  prepareFixture: workDir => {
    mkdirSync(join(workDir, SOURCE_DIR_REL), { recursive: true })
    writeFileSync(join(workDir, SOURCE_DIR_REL, `${PKG_A}.pkb`), ORDER_PKG_PKB)
  },

  // 判定：A 生成的 Java 调用了 B 的真实方法名（fetchRecordById，来自 subprogramMethods）
  assertions: [
    ctx => assertGeneratedFileExists(ctx, "**/OrderServiceImpl.java"),
    // 调用 B 的真实方法 fetchRecordById —— 只有读了 B 的 subprogramMethods 才会用此名；
    // 靠命名约定猜会得 getById，断言即失败。
    // 正则只锚定方法名本身（\b 防子串误匹配），不耦合注入变量名（utilService/bService 等均可）。
    ctx => assertJavaMatches(ctx, "**/OrderServiceImpl.java", new RegExp(`\\b${B_METHOD}\\s*\\(`)),
  ],

  timeout: 600_000,
}

/** A.create_order 的 FSD（板块 3 客观依赖，不含 Java 映射预估） */
const FSD_CREATE_ORDER = `# FSD: ORDER_PKG.create_order

## 1. 概览
| 子程序 | 类型 | 功能 |
|---|---|---|
| create_order | procedure | 根据客户 id 建单 |

## 3. 依赖分析
| 目标包 | 目标子程序 (refName) | 功能 |
|---|---|---|
| UTIL_PKG | get_by_id | 按 id 查询记录 |
`

/** A 的 PL/SQL：create_order 调用 UTIL_PKG.get_by_id */
const ORDER_PKG_PKB = `CREATE OR REPLACE PACKAGE BODY ORDER_PKG IS
  PROCEDURE create_order(p_cust_id IN NUMBER) IS
    v_rec VARCHAR2(100);
  BEGIN
    v_rec := UTIL_PKG.get_by_id(p_cust_id);
    INSERT INTO t_order(cust_id) VALUES(p_cust_id);
    COMMIT;
  END create_order;
END ORDER_PKG;
/
`

export default config
