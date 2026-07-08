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
  makeInventory,
  makePlan, makeScaffold, makePackageArtifact, makeSubprogramArtifact, makeAnalysisPackage,
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
    writeArtifactJson(dir, "inventory.json", {
      sourcePath: SOURCE_DIR_REL, packageNames: [PKG_B, PKG_A], tables: [{ name: "T_ORDER", columns: [{ name: "CUST_ID", oracleType: "NUMBER", nullable: true, isPrimaryKey: false }] }], standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })

    // packages（新形状：packages/{PKG}.json，PackageArtifactSchema；取代旧 inventory-packages/）
    writeArtifactJson(join(dir, "packages"), `${PKG_B}.json`, makePackageArtifact({
      packageName: PKG_B,
      absolutePaths: [`${SOURCE_DIR_REL}/UTIL_PKG.pkb`],
      headerPath: null,
      bodyPath: `${SOURCE_DIR_REL}/UTIL_PKG.pkb`,
      functions: ["GET_BY_ID"],
      procedures: [],
      estimatedLoc: 10,
      complexity: { score: 2, patterns: [], riskLevel: "low" },
    }))
    writeArtifactJson(join(dir, "packages"), `${PKG_A}.json`, makePackageArtifact({
      packageName: PKG_A,
      absolutePaths: [`${SOURCE_DIR_REL}/ORDER_PKG.pkb`],
      headerPath: null,
      bodyPath: `${SOURCE_DIR_REL}/ORDER_PKG.pkb`,
      functions: [],
      procedures: ["CREATE_ORDER"],
      estimatedLoc: 20,
      complexity: { score: 3, patterns: ["cross-package-call"], riskLevel: "low" },
    }))

    // subprograms（新形状：subprograms/{PKG.METHOD}.json，含 directCalls —— 依赖图按需推导取代旧 dependency-graph.json）
    // ORDER_PKG.CREATE_ORDER 调用 UTIL_PKG.GET_BY_ID → packageDependency ORDER_PKG→UTIL_PKG → translationOrder [[UTIL_PKG],[ORDER_PKG]]
    writeArtifactJson(join(dir, "subprograms"), `${PKG_A}.CREATE_ORDER.json`, makeSubprogramArtifact({
      name: "CREATE_ORDER", type: "PROCEDURE", belongToPackage: PKG_A,
      bodyLocation: { absolutePath: `${SOURCE_DIR_REL}/ORDER_PKG.pkb`, lineRange: [1, 20] },
      parameters: [{ name: "P_CUST_ID", type: "NUMBER", mode: "IN", defaultExpression: null }],
      returnType: null, loc: 20,
      directCalls: [{ package: PKG_B, name: "GET_BY_ID", line: 5, kind: "function" }],
    }))
    writeArtifactJson(join(dir, "subprograms"), `${PKG_B}.GET_BY_ID.json`, makeSubprogramArtifact({
      name: "GET_BY_ID", type: "FUNCTION", belongToPackage: PKG_B,
      bodyLocation: { absolutePath: `${SOURCE_DIR_REL}/UTIL_PKG.pkb`, lineRange: [1, 10] },
      parameters: [{ name: "P_ID", type: "NUMBER", mode: "IN", defaultExpression: null }],
      returnType: "VARCHAR2", loc: 10, directCalls: [],
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

    // analysis（拓扑序：B 叶子先、A 后；callGraph 由 buildDependencyGraph 从 subprograms.directCalls 按需推导）
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
