/**
 * Case B：review-detect-swallowed-exception
 *
 * 执行点 = review phase × 含「空 catch（吞异常）」缺陷的 Java fixture。
 * 测的是【reviewer 审查能力】：能否在 collection-exception（#15：禁止空 catch）类别下抓到此缺陷。
 *
 * 判定：纯断言，无 judge —— reviewer 是被测对象，其 procedureReviews[].checks[] 即结论。
 *   - assertCheckFound(ctx, "collection-exception", "major")
 *       命中 = reviewer 能力有效；漏判 = reviewer 有漏洞（.opencode 的 bug，正是测试要发现的）。
 *
 * 依赖来源（Mock 策略表）：
 *   - artifacts/（上游 artifact）= mock 桩（artifact-factory + 手工构造，按 Schema 形状）
 *   - fixture（含缺陷 Java）= 真实手写输入
 *   - agent（reviewer）= 真跑（/sql2java resume 复用预置 run）
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { CaseConfig } from "../../harness"
import { assertCheckFound, assertArtifactExists } from "../../harness"
import { makeInventoryIndex, makePlan, writeArtifactJson } from "../../../ts/helpers/artifact-factory"

const PACKAGE = "BAD_PKG"
const PROJECT_ROOT_REL = "generated/bad-service"
const IMPL_REL = "src/main/java/com/example/bad/service/impl/BadServiceImpl.java"

const config: CaseConfig = {
  name: "review-detect-swallowed-exception",
  phase: "review",
  trigger: "/sql2java resume",

  // ── mock 桩：上游 artifact（按 .opencode Schema 形状构造；writeArtifactJson 走跨平台原子写 + 自动建子目录） ──
  prepareArtifacts: dir => {
    // inventory-index（reviewer 全量审查范围的来源）
    writeArtifactJson(dir, "inventory-index.json", makeInventoryIndex({
      packages: [
        { name: PACKAGE, specFile: "pkg/bad.pks", bodyFile: "pkg/bad.pkb", procedures: [{ name: "DO_SOMETHING", type: "procedure", lineRange: [1, 20] }], estimatedLoc: 20 },
      ],
    }))

    // inventory（Schema 要求 packageNames）
    writeArtifactJson(dir, "inventory.json", {
      sourcePath: "pkg", packageNames: [PACKAGE], tables: [], standaloneProcedures: [], triggers: [], views: [], sequences: [],
    })

    // plan（复用 factory，覆盖映射到 BAD_PKG）
    writeArtifactJson(dir, "plan.json", makePlan({
      packageMappings: [
        { oraclePackage: PACKAGE, javaPackage: "com.example.bad", mapperInterface: "BadMapper", serviceClass: "BadService", serviceImplClass: "BadServiceImpl" },
      ],
    }))

    // scaffold（Schema 形状：projectRoot 指向 fixture Java 所在工程）
    writeArtifactJson(dir, "scaffold.json", {
      projectRoot: PROJECT_ROOT_REL,
      structure: { directories: ["src/main/java/com/example/bad/service/impl"], pomXml: "pom.xml" },
      generated: {
        entities: [],
        mapperInterfaces: [{ file: "src/main/java/com/example/bad/mapper/BadMapper.java", oraclePackage: PACKAGE }],
        serviceShells: [{ file: IMPL_REL, oraclePackage: PACKAGE }],
        commonClasses: [{ file: "src/main/java/com/example/bad/exception/AppException.java", purpose: "业务异常基类" }],
      },
      conventions: "Standard conventions",
    })

    // analysis（AnalysisMetaSchema 形状）
    writeArtifactJson(dir, "analysis.json", {
      callGraph: {},
      packageDependency: {},
      translationOrder: [[PACKAGE]],
      complexity: { [PACKAGE]: { score: 3, patterns: ["exception-block"], riskLevel: "low" } },
      sccGroups: [],
      packageNames: [PACKAGE],
    })

    // analysis-packages/<pkg>（AnalysisPackageSchema 形状）
    writeArtifactJson(join(dir, "analysis-packages"), `${PACKAGE}.json`, {
      packageName: PACKAGE,
      subprograms: [
        {
          name: "DO_SOMETHING",
          blocks: [{ type: "exception-block", oracleLine: 1, description: "EXCEPTION WHEN OTHERS（空处理）", dependencies: [] }],
          variables: [],
          cursors: [],
          exceptionHandlers: [{ name: "OTHERS", actions: ["空 catch，吞异常"] }],
          translationNotes: ["含异常处理块，翻译为 try-catch"],
        },
      ],
    })

    // translations/<pkg>/translation.json（TranslationSchema 形状：声明含缺陷的 Java 文件）
    writeArtifactJson(join(dir, "translations", PACKAGE), "translation.json", {
      packageName: PACKAGE,
      status: "completed",
      completedSubprograms: ["DO_SOMETHING"],
      totalSubprograms: 1,
      files: [{ path: IMPL_REL, role: "service-impl" }],
      decisions: [
        { line: 10, oracleConstruct: "EXCEPTION WHEN OTHERS", javaConstruct: "try-catch(空)", reason: "异常映射（含缺陷：空 catch）", confidence: "high" },
      ],
      todos: [],
    })
  },

  // ── 真实输入：故意写一个空 catch（吞异常）的 Java ──
  prepareFixture: workDir => {
    const implPath = join(workDir, PROJECT_ROOT_REL, IMPL_REL)
    mkdirSync(join(workDir, PROJECT_ROOT_REL, IMPL_REL.replace(/[^/]+$/, "")), { recursive: true })
    writeFileSync(implPath, BAD_SERVICE_IMPL_JAVA)
  },

  // ── 判定（oracle）：reviewer 必须抓到 collection-exception 缺陷 ──
  assertions: [
    ctx => assertArtifactExists(ctx, "review-summary.json"),
    ctx => assertCheckFound(ctx, "collection-exception", "major"),
  ],

  timeout: 600_000,
}

/** 故意含「空 catch（吞异常）」缺陷的 ServiceImpl —— reviewer 应在 collection-exception 下标 major/critical */
const BAD_SERVICE_IMPL_JAVA = `package com.example.bad.service.impl;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 故意含缺陷的 ServiceImpl。
 * 用于测试 reviewer 是否能在 collection-exception（禁止空 catch）类别下抓到此缺陷。
 */
@Service
public class BadServiceImpl implements com.example.bad.service.BadService {
    private static final Logger log = LoggerFactory.getLogger(BadServiceImpl.class);

    @Override
    public void doSomething() {
        try {
            riskyCall();
        } catch (Exception e) {
            // 空 catch：吞掉异常，既不记录也不重抛 —— 违反 java-code-spec「禁止空 catch」
        }
    }

    private void riskyCall() {
        // 占位：模拟可能抛异常的操作
    }
}
`

export default config
