/**
 * Case A：translate-exception-mapping
 *
 * 执行点 = translate phase × 仅含一个 EXCEPTION WHEN OTHERS 块的最小 PL/SQL。
 * 测的是【translator 产出正确性】：能否把 EXCEPTION 块正确映射为不吞异常的 try-catch。
 *
 * 判定：断言 + judge 配合。
 *   - assertGeneratedFileExists("ExcServiceImpl.java" 的 glob)
 *   - assertJavaMatches(catch 块存在且非空)
 *   - assertDecision("EXCEPTION WHEN OTHERS" → try-catch)
 *   - judge（ENABLE_JUDGE=1）：rubric 引用 java-code-spec 异常处理条款，喂该 catch 片段
 *
 * 依赖来源（Mock 策略表）：
 *   - artifacts/（上游 artifact）= mock 桩（artifact-factory + 手工构造）
 *   - fixture（最小 PL/SQL）= 真实手写输入
 *   - agent（translator）= 真跑（/sql2java resume 复用预置 run）
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { CaseConfig } from "../../harness"
import { assertGeneratedFileExists, assertJavaMatches, assertDecision } from "../../harness"
import { makeInventoryIndex, makePlan, writeArtifactJson } from "../../../ts/helpers/artifact-factory"

const PACKAGE = "EXC_PKG"
const SOURCE_DIR_REL = "src-sql"
const PROJECT_ROOT_REL = "generated/exc-service"

const config: CaseConfig = {
  name: "translate-exception-mapping",
  phase: "translate",
  trigger: "/sql2java resume",
  sourcePath: SOURCE_DIR_REL,

  // ── mock 桩：translate 前置 artifact（writeArtifactJson 走跨平台原子写 + 自动建子目录） ──
  prepareArtifacts: dir => {
    writeArtifactJson(dir, "inventory-index.json", makeInventoryIndex({
      packages: [
        { name: PACKAGE, specFile: "pkg/exc.pks", bodyFile: `${SOURCE_DIR_REL}/EXC_PKG.pkb`, procedures: [{ name: "SAVE_MSG", type: "procedure", lineRange: [1, 20] }], estimatedLoc: 20 },
      ],
    }))

    writeArtifactJson(dir, "inventory.json", {
      sourcePath: SOURCE_DIR_REL, packageNames: [PACKAGE], tables: [{ name: "T_APP_LOG", columns: [{ name: "MESSAGE", oracleType: "VARCHAR2", nullable: true, isPrimaryKey: false }] }], standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })

    // inventory-packages（translate 前置要求；有 procedures 的包必须有 bodyFile）
    writeArtifactJson(join(dir, "inventory-packages"), `${PACKAGE}.json`, {
      packageName: PACKAGE,
      bodyFile: `${SOURCE_DIR_REL}/EXC_PKG.pkb`,
      procedures: [
        { name: "SAVE_MSG", type: "procedure", params: [{ name: "P_MSG", oracleType: "VARCHAR2", direction: "IN" }], lineRange: [1, 20], loc: 20 },
      ],
      types: [],
      variables: [],
      constants: [],
    })

    writeArtifactJson(dir, "plan.json", makePlan({
      packageMappings: [
        { oraclePackage: PACKAGE, javaPackage: "com.example.exc", mapperInterface: "ExcMapper", serviceClass: "ExcService", serviceImplClass: "ExcServiceImpl" },
      ],
    }))

    writeArtifactJson(dir, "scaffold.json", {
      projectRoot: PROJECT_ROOT_REL,
      structure: { directories: ["src/main/java/com/example/exc/service/impl"], pomXml: "pom.xml" },
      generated: {
        entities: [{ file: "src/main/java/com/example/exc/entity/AppLog.java", tableName: "T_APP_LOG" }],
        mapperInterfaces: [{ file: "src/main/java/com/example/exc/mapper/ExcMapper.java", oraclePackage: PACKAGE }],
        serviceShells: [{ file: "src/main/java/com/example/exc/service/impl/ExcServiceImpl.java", oraclePackage: PACKAGE }],
        commonClasses: [{ file: "src/main/java/com/example/exc/exception/AppException.java", purpose: "业务异常基类" }],
      },
      conventions: "Standard conventions",
    })

    writeArtifactJson(dir, "analysis.json", {
      callGraph: {},
      packageDependency: {},
      translationOrder: [[PACKAGE]],
      complexity: { [PACKAGE]: { score: 3, patterns: ["exception-block"], riskLevel: "low" } },
      sccGroups: [],
      packageNames: [PACKAGE],
    })

    writeArtifactJson(join(dir, "analysis-packages"), `${PACKAGE}.json`, {
      packageName: PACKAGE,
      subprograms: [
        {
          name: "SAVE_MSG",
          blocks: [{ type: "exception-block", oracleLine: 6, description: "EXCEPTION WHEN OTHERS：回滚 + 记录 + 重抛", dependencies: [] }],
          variables: [],
          cursors: [],
          exceptionHandlers: [{ name: "OTHERS", actions: ["ROLLBACK", "log_error(SQLERRM)", "RAISE"] }],
          translationNotes: ["异常块应映射为 catch：记录日志后重抛，不得吞异常"],
        },
      ],
    })
  },

  // ── 真实输入：仅含一个 EXCEPTION WHEN OTHERS 块的最小 PL/SQL ──
  prepareFixture: workDir => {
    mkdirSync(join(workDir, SOURCE_DIR_REL), { recursive: true })
    writeFileSync(join(workDir, SOURCE_DIR_REL, "EXC_PKG.pkb"), EXC_PKG_PKB)
  },

  // ── 判定（oracle）──
  assertions: [
    ctx => assertGeneratedFileExists(ctx, "**/ExcServiceImpl.java"),
    // 仅机械验「存在 catch 块且 body 非空」（\s*\S 要求 { 后至少一个非空白）；空 catch `catch (Exception e) {}` 不匹配。
    // 「不吞异常 / 正确重抛」是语义判定，靠下方 judge（需 ENABLE_JUDGE=1），断言无法覆盖。
    ctx => assertJavaMatches(ctx, "**/ExcServiceImpl.java", /catch\s*\([^)]+\)\s*\{\s*\S[\s\S]*?\}/),
    // 只验 translator 识别到 EXCEPTION 构造并产出 decision；javaConstruct 是散文式（如 "catch (Exception e)"），
    // 不含字面 "try-catch"，故不传 javaConstruct 做硬匹配（否则正确产出也会 false-fail）。
    ctx => assertDecision(ctx, "EXCEPTION WHEN OTHERS"),
  ],

  // ── judge（仅语义点；ENABLE_JUDGE=1 时生效）──
  judge: {
    rubric:
      "判断生成的 Java 是否符合 java-code-spec 异常处理条款：EXCEPTION WHEN OTHERS 应映射为 try-catch，" +
      "catch 块不得为空、不得仅 e.getMessage() 丢弃堆栈，必须包装重抛或 log.error(\"...\", e)。" +
      "参考 translator.md 异常映射表与 reviewer.md #5 exception-mapping / #15 collection-exception。",
    targetSelector: ctx => {
      const file = Object.entries(ctx.generatedFiles).find(([k]) => k.endsWith("ExcServiceImpl.java"))
      const content = file?.[1] ?? ""
      const m = content.match(/catch\s*\([^)]+\)\s*\{[\s\S]*?\}/)
      return m ? m[0] : content.slice(0, 1200)
    },
    threshold: 70,
  },

  timeout: 600_000,
}

/** 最小 PL/SQL：EXCEPTION WHEN OTHERS → 记录 + 重抛（translator 应映射为非空 catch，不吞异常） */
const EXC_PKG_PKB = `CREATE OR REPLACE PACKAGE BODY EXC_PKG IS
  PROCEDURE save_msg(p_msg IN VARCHAR2) IS
  BEGIN
    INSERT INTO t_app_log(message) VALUES(p_msg);
    COMMIT;
  EXCEPTION
    WHEN OTHERS THEN
      ROLLBACK;
      log_error(SQLERRM);
      RAISE;
  END save_msg;
END EXC_PKG;
/
`

export default config
