# sql2java-workflow

基于 AI Agent 的 Oracle PL/SQL → Spring Boot + MyBatis 端到端转译系统。采用确定性状态机驱动的单流水线工作流，以严格 1:1 忠实转换为原则，将 PL/SQL 代码翻译为可编译的 Java 应用。

## 架构概览

```
/sql2java <path>
  │
  ▼
┌──────────────────────────────────────────────────┐
│  .opencode/command/sql2java.md                    │
│  参数解析 → 路由分发 → workflow 工具调用            │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│  Schema 预获取（可选，有 db.properties 时触发）      │
│  schema-fetcher.ts → pg 驱动（PostgreSQL/GaussDB） │
│  产出：ddl-output/ + DDL 文件                      │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
  inventory（第 0 步 scan：确定性预扫描，零 LLM，产出 inventory-index.json）
  → analyze → plan（人工确认）→ scaffold → translate → dedup → review → verify → 完成
                                                ↑       │             │            │
                                                │       │             ↓ (failed)   ↓ (failed)
                                                │       │             fix ←────────┘
                                                │       │             │
                                                └───────┘             └→ fix → review（增量回到触发阶段）
```

**单流水线**：8 个阶段 + 1 个条件分支阶段（fix），一个 runId，无条件前进 + review/verify 失败时进入 fix 循环（增量重做）。fix 完成后直接回到 review 审查，dedup 只在主线 translate 后执行一次。启动前可选执行 Schema 预获取（发现 `db.properties` 时自动连接 PostgreSQL/GaussDB 拉取 DDL）。

## 项目结构

```
sql2java-workflow/
├── .opencode/                        # opencode 框架插件目录
│   ├── command/
│   │   └── sql2java.md               # /sql2java 命令入口
│   ├── agent/
│   │   ├── sql-analyst.md            # inventory + analyze 阶段
│   │   ├── java-architect.md         # plan + scaffold + dedup 阶段
│   │   ├── translator.md             # translate + fix 阶段
│   │   └── reviewer.md               # review + verify 阶段
│   ├── docs/
│   │   └── java-code-spec.md         # 统一 Java 代码规约（自动注入 3 个 agent，支持 --spec 覆盖）
│   ├── workflow/
│   │   ├── engine-core.ts            # 状态机核心
│   │   ├── workflow-definitions.ts   # 工作流定义 + TransitionRule + PHASE_PREREQUISITES
│   │   ├── artifact-schemas.ts       # Artifact Zod Schemas + getArtifactFilename + getPerPackageSchema
│   │   ├── plsql-scanner.ts          # PL/SQL AST/regex 预扫描器
│   │   ├── schema-fetcher.ts         # 数据库 Schema 自动获取（db.properties → ddl-output/，PG/GaussDB）
│   │   ├── refname.ts                # refName 重载规范（生成/解析/校验限定名）
│   │   ├── rejection-guidance.ts     # PHASE_REJECTION_GUIDANCE + enhanceRejection
│   │   ├── cross-platform.ts         # 跨平台文件操作（atomicRename/safeRm/safeWriteFile）
│   │   ├── phase-metrics-collector.ts # 阶段指标采集与报告
│   │   ├── schema-hint-enrichments.ts # D13 Schema Hint 数据定义（阶段校验要求）
│   │   ├── schema-hint-renderer.ts   # D13 Schema Hint 渲染（注入 system prompt）
│   │   ├── ensure-deps.ts            # 依赖自动安装（node_modules 缺失时 npm/bun install）+ findOpencodeDir
│   │   ├── workflow-logger.ts        # 运行日志模块
│   │   ├── wf-util.js                # 工具函数
│   │   ├── constants.ts              # 共享常量（GENERATED_OUTPUT_DIR 等）
│   │   └── type-mappings.ts          # Oracle → Java/JDBC 类型映射表
│   ├── plugins/
│   │   └── workflow-engine.ts        # 插件入口（workflow 工具 + hooks + artifact 校验）
│   └── package.json                  # 依赖：@opencode-ai/plugin, zod, ts-plsql-parser, pg(optional)
├── resources/
│   ├── mfg_erp_sql/                  # 完整示例 PL/SQL 输入（schema/pkg/func/trigger/type）
│   ├── mfg_erp_sql_mini/             # 中等规模示例（子集）
│   └── mfg_erp_sql_tiny/             # 最小示例（快速验证）
├── minimum_feature_design.md         # 最小可行功能设计文档
├── sp-to-fsd-design.md               # 子程序 → FSD 转换设计
├── sql2java-run-diagram.md           # 工作流运行图解
├── sql2java-standard-example.md      # 标准转译示例
├── orchestrator-worker-architecture.md # Orchestrator-Worker 架构设计
├── metrics-report-design.md          # 指标报告设计
├── scalability-risks.md              # 扩展性风险分析
├── test-framework-design.md          # 测试框架设计
├── todo-tracking-design.md           # Todo 追踪设计
├── AGENTS.md                         # Agent 说明
└── README.md
```

## Agent 定义

| Agent | Phase | 温度 | 核心职责 |
|-------|-------|------|---------|
| sql-analyst | inventory | 0.1 | scan 预扫描源码生成 inventory-index.json → generateInventory/generateDependencyGraph 产出 per-package 文件 |
| sql-analyst | analyze | 0.1 | 依赖图 + 拓扑排序 + 子程序结构解析 + FSD 生成 |
| java-architect | plan | 0.2 | 架构规划（需人工确认），遵守 Java 代码规约 |
| java-architect | scaffold | 0.2 | 项目骨架 + Entity + Mapper/Service 壳 + 公共模块骨架，遵守 Java 代码规约 |
| java-architect | dedup | 0.2 | 跨包重复代码检测 + 公共模块抽取 |
| translator | translate | 0.1 | 按拓扑序逐包翻译，逐包持久化，遵守 Java 代码规约 + 中文注释 |
| translator | fix | 0.1 | 修复 mustFix 项，产出 FixArtifact |
| reviewer | review | 0.1 | 18 类审查清单（含命名规约/代码格式/OOP/注释语言/版本合规/测试），逐包持久化 |
| reviewer | verify | 0.1 | mvn compile + MyBatis 校验 + 测试执行（arrange→act→assert） |

## 工作流定义

### 阶段配置

| 阶段 | Agent | 最大重试 | 说明 |
|------|-------|---------|------|
| inventory | sql-analyst | 2 | 第 0 步 scan 预扫描源码生成 inventory-index.json，再 generateInventory/generateDependencyGraph 分批编目，per-package 拆分 |
| analyze | sql-analyst | 2 | 依赖分析 + 拓扑排序 + 子程序结构 + FSD |
| plan | java-architect | 1 | 架构规划（需人工确认） |
| scaffold | java-architect | 1 | 项目骨架生成 |
| translate | translator | 3 | 按拓扑序逐包翻译 |
| dedup | java-architect | 2 | 跨包重复代码检测 + 公共模块抽取 |
| review | reviewer | 1 | 按包独立审查 |
| verify | reviewer | 2 | 全局编译 + 按包校验 |
| fix | translator | 3 | 修复 mustFix 项 |

### 条件分支

- **无条件前进**：inventory → analyze → plan → scaffold → translate → dedup → review → verify → 完成
- **fix 循环**：review/verify failed → fix → review → verify（fix 修改翻译后直接回到 review 审查）
- **exhausted 策略**：globalMax=5, phaseMax=5, 任一达限 → `completed_with_issues`

### 分片

analyze / translate / review 按 package 分片（`maxPackagesPerShard=1`，每分片 1 包），基于 `dependency-graph.json.translationOrder`（Tarjan SCC 拓扑序）。analyze/review 拍平 SCC 每包独立分片；translate 保留 SCC 组共处（互依赖包同 session 拿到对方 Java 签名）。分片模式下上游 artifact 收窄到本分片包（`narrowUpstreamForShard`），review 阶段 `translations/*` 收窄到 targetPackages（本分片包），避免 worker 读到全部包越界处理。

## 设计决策

| ID | 决策 | 说明 |
|----|------|------|
| D1 | advance condition | LLM 传入 result，引擎匹配 TransitionRule |
| D2 | fix exhausted | 双层策略：globalMax=5, phaseMax=5 |
| D3 | fix 增量重做 | fix 后只重审修改过的包；fix 失败未 exhausted 返回 fixFailed=true（区别于 rejected），LLM 调 retry 重试。fix→review 增量回环注入 previousFindings（上次 mustFix），reviewer 先逐项核对旧问题是否修复，未修复的须再次列入 mustFix |
| D4 | confirm 时序 | waitingForConfirmation=true 时不激活 agent |
| D5 | artifact 写入 | agent 自己写 artifact，advance 时从磁盘做 Zod 校验；fix-failed 时跳过 Zod 校验 |
| D6 | 持久化 | run.json 全量单文件存储 |
| D7 | fix 路由 | fix 完成后固定回到 review（fix→review always） |
| D8 | result 自动推导 | review/verify 阶段引擎从 allPassed 自动推导 result |
| D9 | 跨 Schema 校验 | inventory 阶段 plugin 层校验 index↔inventory 一致；analyze/plan/translate/dedup 完成后校验包名/映射一致性（双格式兼容）；分级 blocking/warning |
| D10 | SCC 处理 | 循环依赖组归为同层数组，各包保持独立 |
| D11 | prompt 注入 | 只注入当前 Phase section + 通用规则 |
| D12 | FixArtifact 校验 | 包名必须在 inventory 中存在（packageNames 优先，旧格式回退 packages[].name），且覆盖所有失败包 |
| D13 | FSD 生成 | analyze 阶段副产物，逐子程序 Markdown 文档 |
| D14 | phase→filename 映射 | getArtifactFilename 处理 phase 名与磁盘文件名不一致（如 translate→translation.json） |
| D15 | OR 前置语义 | PHASE_PREREQUISITES 支持 string[] 数组组（如 fix 的 summary 文件二选一） |
| D16 | fix retry 清理 | retry 时清理残留 fix.json，重置 entry status + completedAt |
| D17 | artifact 缓存 | 单次 advance 内缓存磁盘读取，advance 结束后清除 |
| D18 | Schema 预获取 | 发现 db.properties 时自动连接 PostgreSQL/GaussDB 拉取 DDL 到 ddl-output/，pg 驱动，不侵入 phase 链 |
| D19 | Java 代码规约注入 | docs/java-code-spec.md 统一规约自动注入 java-architect / translator / reviewer 三个 agent |
| D20 | dedup 公共模块抽取 | translate 完成后扫描所有包，检测跨包重复代码（DTO/工具方法/常量/异常类/MyBatis 片段），抽取为共享模块并更新引用；不修改 Service 接口和 SQL 内容 |
| D21 | L3 质量门控 | 确定性数值门控：G1 翻译完成率≥0.8 / G3 review 分数≥70 / G6 测试通过率≥0.7 |
| D22 | rejection guidance | 每阶段的拒绝引导，鼓励重做而非修补 JSON |
| D23 | 跨平台文件操作 | atomicRename/safeRm/safeWriteFile 处理 Windows 文件锁定 |
| D24 | 用户自定义规约 | `--spec` 参数指定 Markdown 规约文件，按 `##` 章节覆盖内置 java-code-spec.md 同名章节，独有章节追加；目录结构从"工程结构"章节提取 |
| D25 | 自然语言参数解析 + run-context | `/sql2java` 支持自然语言输入，先提取 CLI flag（--db_conf/--spec/--mainEntry/--header/--body）再对剩余文本做字段抽取（path/headerPath/bodyPath/dbConf/specConf/mainEntry/phases）；start 时把输入参数 + runId + 目录写入 `run-context.json` 作为稳固快照，resume 时兜底恢复 metadata。源码路径支持单目录（位置 path）或双目录（--header+--body，header 先于 body 处理）；mainEntry 过程级 `[subdir/]PKG.refName` 触发闭包 scope（见 D26）；纯包名/缺省 = 全量翻译 |
| D26 | 过程级入口闭包翻译 | mainEntry 为过程级时，inventory advance 算 callGraph + packageDependency 闭包（`scope-computer.ts`，零 LLM）写入 metadata；analyze/translate 内存过滤 procedureOrder，plan/scaffold/review/dedup/verify 走 metadata + workOrder banner 提示驱动。同包 bare-name 调用边补全（`scanBareCallSites`）。仅常量/类型被引用的包进 scopePackages（scaffold 出壳）不进 scopeUnits。坏入口（拼写错/子程序不存在/subdir 不匹配）→ inventory advance 硬失败，不静默回退全量 |

## 命令用法

支持**自然语言**或 **CLI flag** 两种输入风格。解析器先提取 flag，剩余文本做自然语言参数提取，抽不全的必填字段（源码目录）会追问用户。

### 自然语言（推荐）

```
/sql2java 帮我把 /path/sql 下的存储过程转成 java，配置在 db.properties，主入口是 ORDER_PKG
/sql2java 帮我把 resources/mfg_erp_sql_tiny 的存储过程转成 java，入口为 pkg/CORE_PKG.bulk_receive
/sql2java /path/sql                          # 纯路径 → 端到端全流程
/sql2java 看下状态                            # → status
/sql2java 继续上次                            # → resume
```

### CLI flag（兼容老语法）

```
/sql2java <path>                              # 端到端全流程
/sql2java --db_conf db.properties <path>      # 指定数据库配置文件
/sql2java --spec project-spec.md <path>       # 指定用户自定义代码规约文件
/sql2java --mainEntry pkg/CORE_PKG.bulk_receive <path>  # 过程级入口：只译入口及其调用闭包；纯包名=全量
/sql2java --dedupRules dedup-rules.json <path> # 指定 dedup 排除/强制复用规则
/sql2java --header <header_dir> --body <body_dir>  # 双目录模式：包头/包体分两目录
/sql2java status                              # 查看工作流状态
/sql2java resume                              # 断点续传
/sql2java --phases plan,scaffold <path>       # 指定阶段执行
```

### 源码目录模式（单目录 / 双目录）

PL/SQL 包头（声明）和包体（实现）可按以下方式提供：

- **单目录模式**（默认）：位置 `<path>` 指向一个目录，scanner 递归扫描其下所有 `.sql/.pks/.pkb/.pls`，按包名配对 spec/body。header/body 同根时推荐此模式。
- **双目录模式**（`--header <dir> --body <dir>`）：包头和包体在两个独立目录时使用。scanner 先扫 headerPath、再扫 bodyPath，**保证 header 先于 body 处理**（`extractPackageHeader` 会整表重建 procedures，header 先处理才能让 body-only 私有过程随后补入而不被覆盖丢失）。

**路径解析（宽容规则）**——按给出的路径数路由（位置 `path` + `--header` + `--body` 各算一个）：

| 路径数 | 形式 | 模式 |
|---|---|---|
| 1 | 位置 `path` / 仅 `--header` / 仅 `--body` | 单目录，`sourcePath` = 该路径 |
| 2 | `--header h --body b` / `--header h` + 位置 / `--body b` + 位置 | 双目录（带 `--header` 的是 header 角色，另一为 body） |
| 0 / 3 | — | ❌ 报错（追问/冲突） |

> 双目录模式下 body 文件路径存绝对路径（不在 headerPath 下），下游 `readSource`/`absSrc` 已兼容绝对路径解析。`sourcePath`（用于 runId / `project-spec.md` 查找 / `db.properties` 定位）派生为 `headerPath`。

### 可提取参数

| 字段 | 必填 | 缺省规则 |
|------|------|----------|
| `path`（PL/SQL 源码目录） | 条件必填 | `--header`+`--body` 双目录模式可不提供；否则抽不出则追问用户，不自行编造 |
| `headerPath` / `bodyPath` | 否 | 双目录模式：包头/包体目录；二者同时给则启用双目录模式（见上） |
| `dbConf`（db.properties 路径） | 否 | 在 `path`（或 `headerPath`）下自动查找 `db.properties` |
| `specConf`（规约文件） | 否 | 在 `path`（或 `headerPath`）下找 `project-spec.md`；没有用内置默认规约 |
| `mainEntry`（翻译入口） | 否 | 过程级 `[subdir/]PKG.refName` 触发闭包 scope 模式；纯包名/缺省则全量翻译 |
| `dedupRules`（dedup 规则文件） | 否 | dedup 阶段的 exclude/force 覆盖规则；缺省=无覆盖 |
| `phases` / `mode` | 否 | `status` / `resume` / 指定阶段 / 端到端全流程 |

解析结果连同用户原始输入写入 `.workflow-artifacts/{runId}/run-context.json`，`resume` 时作为输入参数的兜底事实源。

### 过程级入口闭包翻译（mainEntry）

`mainEntry` 支持两种形态：

- **过程级** `[subdir/]PKG.refName`（如 `pkg/CORE_PKG.bulk_receive`）：触发**闭包 scope 模式**——只翻译该入口 PROCEDURE/FUNCTION 及其直接/间接调用的全部子程序，跨子目录、跨包自动收拢。重载子程序入口须显式写 refName（如 `PKG.get_param__2`），裸名撞重载会被拒绝。
- **包级**（纯包名如 `ORDER_PKG`，旧用法）/ 缺省：全量翻译整个项目。

闭包由 `workflow/scope-computer.ts` 纯函数计算（零 LLM）：

- `scopeUnits` = 沿 `callGraph` 正向 BFS 的被调用子程序 → 映射 unit（owned FUNCTION 折叠进 owner，孤儿 FUNCTION 自身）
- `scopePackages` = `scopeUnits` 所属包 ∪ 沿 `packageDependency`（含常量/类型引用）正向 BFS 到达的包；仅常量/类型被引用的包进 `scopePackages`（scaffold 出壳）不进 `scopeUnits`

各阶段按 scope 收敛：analyze/translate 内存过滤 `procedureOrder`（不改盘上 dependency-graph.json），plan/scaffold/review/dedup/verify 走 metadata + workOrder banner 提示驱动。同包 bare-name 调用（`helper_proc()` 无包前缀）由 `scanBareCallSites` 补边，否则会漏译。

**示例**（`resources/mfg_erp_sql_tiny` fixture）：

```
/sql2java 帮我把 resources/mfg_erp_sql_tiny 的存储过程转成 java，入口为 pkg/CORE_PKG.bulk_receive
```

`bulk_receive` 体内调同包 `log_error(...)`（裸名）并引用 `base_pkg.c_dir_in`（跨包常量），算出的闭包：

| 集合 | 内容 | 说明 |
|------|------|------|
| `scopeUnits` | `CORE_PKG.bulk_receive`, `CORE_PKG.log_error` | 入口 + 其 bare-name 调用的 helper（同包裸名边补全） |
| `scopePackages` | `CORE_PKG`, `BASE_PKG` | `BASE_PKG` 仅常量被引用 → scaffold 出壳，不译过程体 |

入口不可解析（拼写错 / 子程序不存在 / subdir 不匹配）→ inventory advance **硬失败**，不静默回退全量翻译。

## 运行环境要求

工作流以**最低可运行版本**为基线，所有 mvn 驱动的阶段（dedup 的 `mvn pmd:cpd`、verify 的 `mvn compile/test`）必须能在该基线跑：

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| **Node.js** | 18+ | 运行 opencode 插件 + vitest（`ensure-deps` 自动 npm/bun 装 `.opencode/node_modules`） |
| **JDK** | **8**（1.8） | 生成项目目标 Java 8（`docs/java-code-spec.md` 唯一事实来源）；maven-pmd-plugin 3.21.2 + PMD 6.55.0 最低 JDK 8 |
| **Apache Maven** | **3.5+** | Spring Boot 2.7 要求 Maven 3.5+（maven-pmd-plugin 3.21.2 仅需 3.2.5，3.5 为绑定最低） |
| maven-pmd-plugin | 3.21.2（硬编码 `dedup-scanner.ts`） | 自带 PMD 6.55.0；Maven 首次运行自动下载缓存 `~/.m2`，无需手动装 PMD |

- **dedup 工具链校验**：dedup dispatch 前 `dedup-scanner.checkToolchain()` 解析 `mvn --version`（一次性给 Maven + Java 版本），JDK < 8 或 Maven < 3.5 → 优雅跳过 dedup（写占位 `dedup.json` 标 `skipped:true`），pipeline 继续。verify 阶段若 mvn/JDK 缺失亦跳过编译（`compileSkipped`）。
- **跨平台**：mvn + jar 跨平台（Win/Linux/macOS），Maven 自带 `mvn.cmd`/`mvn` 脚本路由；不下载 PMD dist zip、不用 native/WASM 解析器。
- **Java 目标与插件版本耦合**：maven-pmd-plugin 3.21.2 绑定 Java 8 目标（PMD 6.x）。若将来 `docs/java-code-spec.md` 把目标升到 Java 17/21，需同步把 `dedup-scanner.ts` 的 `PMD_PLUGIN_COORD` 提到 3.22+（自带 PMD 7.x，支持 Java 17/21 语法）。

## 后台运行长程任务

sql2java 工作流涉及多个阶段，完整转译耗时较长。可通过 opencode 的非交互模式在后台无人值守运行。

### 前置条件

- 使用 `--dangerously-skip-permissions` 自动批准权限（包括 plan 阶段的 confirm）
- 配合 `resume` 可在 LLM 上下文溢出或中断后断点续传

### 方案一：nohup 后台直接运行

```bash
nohup opencode run "/sql2java /path/to/plsql" \
  --dangerously-skip-permissions \
  --format json \
  -m zai-coding-plan/glm-5.1 \
  > sql2java-output.json 2>&1 &
```

### 方案二：headless 服务 + 挂载执行

```bash
# 启动后台服务
opencode serve --port 4096 &

# 挂载到服务上执行
opencode run "/sql2java /path/to/plsql" \
  --attach http://localhost:4096 \
  --dangerously-skip-permissions \
  --format json \
  -m zai-coding-plan/glm-5.1
```

### 方案三：断点续传（中断后恢复）

```bash
nohup opencode run "/sql2java resume" \
  --dangerously-skip-permissions \
  --format json \
  -m zai-coding-plan/glm-5.1 \
  >> sql2java-output.json 2>&1 &
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `run "message"` | 非交互模式，处理完 prompt 后退出 |
| `--format json` | 原始 JSON 事件流输出（适合脚本解析）；`default` 为可读文本 |
| `--dangerously-skip-permissions` | 自动批准所有权限，无需人工确认 |
| `-m zai-coding-plan/glm-5.1` | 指定模型（可用 `opencode models` 查看全部可用模型） |
| `--attach <url>` | 连接到已运行的 headless 服务 |

### 查看可用模型

```bash
opencode models                  # 列出所有
opencode models zai-coding-plan  # 只看 z.ai 模型
```

## Artifact 存储

```
.workflow-artifacts/{runId}/
├── run.json                             # WorkflowRun 持久化
├── run-context.json                     # 输入参数 + 目录稳固快照（start 时写一次，resume 兜底）
├── inventory-index.json                 # 预扫描索引（machine-generated，inventory 阶段 scan action 生成）
├── inventory-packages/                  # 逐包 inventory（LLM enriched）
│   ├── PKG_ORDER.json
│   ├── PKG_UTIL.json
│   └── __STANDALONE_FN_ABC_CLASS__.json # standalone 过程虚拟包
├── inventory.json                       # 索引 + DDL 数据（tables/triggers/views/sequences）
├── analysis-packages/                   # 逐包子程序结构
│   ├── exc_pkg.json
│   └── util_pkg.json
├── dependency-graph.json                        # 全局元数据（callGraph + topology + complexity）
├── plan.json
├── scaffold.json
├── dedup.json                           # dedup 阶段产出（跨包重复代码检测 + 公共模块抽取）
├── fix.json                             # fix 阶段产出（每次 fix 覆盖）
├── fsd/{package}/{subprogram}.md        # FSD 文档（analyze 阶段副产物）
├── translations/{package}/
│   ├── translation.json
│   ├── review.json
│   └── verify.json
├── review-summary.json
├── verify-summary.json
└── _events.log

源码目录下（有 db.properties 时自动生成）：
{sourcePath}/
├── db.properties                        # 数据库配置（用户放置，properties 格式）
└── ddl-output/                          # Schema 预获取产出
    ├── .sql2java-generated              # 标记文件（generator: sql2java-schema-fetcher）
    ├── tables/
    │   └── {TABLE_NAME}.sql
    ├── triggers/
    │   └── {TRIGGER_NAME}.sql
    ├── views/
    │   └── {VIEW_NAME}.sql
    ├── sequences/
    │   └── {SEQUENCE_NAME}.sql
    └── types/
        └── {TYPE_NAME}.sql
```

## PL/SQL 预扫描器

`.opencode/workflow/plsql-scanner.ts` 在 inventory 阶段执行确定性扫描（worker 第 0 步调 `workflow({action:"scan"})`，零 LLM），不占用上下文窗口。产出 `inventory-index.json` 供 inventory 阶段后续 `generateInventory`/`generateDependencyGraph` 消费。

| 模式 | 实现 | 触发条件 |
|------|------|---------|
| **AST** | `@griffithswaite/ts-plsql-parser`（ANTLR4） | parser 安装成功 |
| **Regex 降级** | Node.js fs + 正则 + 行号追踪 | parser 安装失败 |

**提取内容**：Package header/body 结构（`headerFile`/`bodyFile` + procedure/function 签名 + 包级 types/variables/constants）、DDL 对象（table/trigger/view/sequence）、调用关系图（PKG.PROC 模式）、standalone 过程（独立 CREATE PROCEDURE/FUNCTION）。

> 字段命名：包声明文件记为 `headerFile`（非 `specFile`——`spec` 在本系统专指 Java 代码规约，见 `--spec`）。`classifyFile` 按文件**内容**判定 header（`CREATE PACKAGE`）/ body（`CREATE PACKAGE BODY`），与扩展名无关，故全 `.sql` 后缀项目也能正确识别。

**单/双目录**：单目录模式 `headerFile`/`bodyFile` 存相对 `sourcePath` 的路径；双目录模式（`--header`+`--body`）header 文件相对 `headerPath`、body 文件存绝对路径（下游 `readSource`/`absSrc` 已兼容绝对）。多根遍历以 root 顺序为主排序键，保证 header 先于 body 处理（保住 body-only 私有过程）。

**standalone 虚拟包**：独立存储过程/函数（不属于任何 package）注入为 `__STANDALONE_{NAME}__` 虚拟包加入 packages，复用 per-package 流水线全链路处理（每过程一包规避爆上下文，不引入通用包拆分）。`standaloneProcedures` 字段保留作 metrics。Java 包名映射归入 `standalone` 子包。

**Regex 模式已知处理**：
- BEGIN/END 深度追踪排除 `END IF` / `END LOOP` / `END CASE`
- 支持无参过程检测（`PROCEDURE init IS`）
- 多 CREATE 语句 matchAll 全量提取（一个 .sql 多个 standalone）
- 跨行块注释 `/* */` 剥离，避免污染 BEGIN/END 深度计数
- 过程嵌套栈：局部过程不截断外层 lineRange
- 超长参数列表过程识别（不设行数上限）

## Schema 预获取

`.opencode/workflow/schema-fetcher.ts` 在工作流启动前执行，当发现 `db.properties` 配置文件时自动连接 PostgreSQL/GaussDB 拉取 schema 元数据。pg 驱动为 optionalDependencies（`53a5d3b` 已入库，离线/内网开箱即用）。

| 特性 | 说明 |
|------|------|
| **触发条件** | `--db_conf` 参数或 `{sourcePath}/db.properties` 自动发现；无配置则跳过（DDL-only 模式） |
| **连接方式** | `pg` 驱动（纯 JS，Node.js 原生，PostgreSQL/GaussDB 兼容） |
| **获取内容** | 表（列/约束）、触发器、视图、序列、对象类型（Object Types） |
| **输出目录** | `{sourcePath}/ddl-output/`，含 `.sql2java-generated` 标记文件 |
| **幂等性** | 重新运行时清理旧输出后重新生成 |
| **配置格式** | properties 格式（`db.url`/`db.username`/`db.password` 必填，可选 `db.schema` 默认 `public`、`db.ssl`、`fetch*` 开关） |
| **安全建议** | 密码可引用环境变量，连接用户只需 SELECT 权限 |

## Java 代码规约注入

`.opencode/docs/java-code-spec.md` 定义统一的 Java 代码规约，工作流引擎在构建 system prompt 时自动注入到 java-architect、translator、reviewer 三个 agent 中。

| 规约板块 | 内容 |
|---------|------|
| 命名风格 | UpperCamelCase、lowerCamelCase、常量全大写、ServiceImpl 后缀、布尔属性无 is 前缀 |
| 常量定义 | 禁止魔法值、long 后缀大写 L |
| 代码格式 | 4 空格缩进、120 字符行宽、大括号风格 |
| OOP 规约 | @Override、包装类型、BigDecimal 精度、构造方法无业务逻辑 |
| 集合与异常 | 集合初始化大小、entrySet 遍历、try-with-resources、禁止空 catch |
| 注释规约 | **中文注释**（Javadoc/行内/TODO）、@author/@date、枚举注释 |
| ORM 映射 | MyBatis resultMap、#{} 参数绑定 |
| 工程结构 | 包分层（entity/mapper/service/dto/exception） |

**严重级别**：违反【强制】规则 → major/critical，违反【推荐】→ minor/info。**出现英文注释标记为 major 级别问题。**

### 用户自定义规约（--spec）

通过 `--spec` 参数提供自定义规约文件，按 `##` 章节覆盖内置 `java-code-spec.md` 的同名章节：

```markdown
## 【强制】Java 版本与框架配置（唯一事实来源）

- **Java 版本**: 17
- **Spring Boot 版本**: 3.2.x

## (一) 命名风格

1. 【强制】方法名使用 snake_case（公司内部规范）

## 工程结构

src/main/java/{packageBase}/controller
src/main/java/{packageBase}/service
```

**合并规则**：
- 用户 `##` 标题与内置**精确匹配** → 覆盖该章节
- 用户独有的 `##` 章节 → 追加到末尾
- 用户未覆盖的内置章节 → 保留默认
- `## 工程结构` 等目录结构章节 → 自动提取路径列表

**文件发现优先级**：`--spec <path>` → `<sourcePath>/project-spec.md`

## Workflow Engine 核心方法

| 方法 | 说明 |
|------|------|
| `start(defId, runId, metadata)` | 创建 WorkflowRun，进入第一个 phase |
| `advance(runId, { result, acceptWarnings })` | 完成当前 phase → 匹配 TransitionRule → 推进 |
| `confirm(runId)` | paused → running，激活 agent |
| `retry(runId)` | 重置当前 entry，递增 retryCount |
| `abort(runId)` | 终止工作流 |
| `status(runId)` | 查询当前状态 |
| `listRuns()` | 列出所有 run |
| `loadFromDisk(runId)` | 从 run.json 恢复 |
| `fixContinue(runId)` | fix 循环继续（exhausted 后新 epoch） |
| `registerDefinition(def)` | 注册工作流定义 |
| `validateCrossSchema()` | 跨 Schema 语义校验（D9，blocking/warning 分级） |
| `validateInventoryIndexConsistency()` | inventory ↔ index 一致性校验 |
| `validateQualityGates()` | L3 确定性数值门控检查（D21，实际执行逻辑） |
| `isFixExhausted()` | 双层 exhausted 判定（D2） |
| `handleFixAdvance()` | fix 阶段特殊处理（D3/D7/D12） |
| `deriveReviewResult()` | review/verify result 自动推导（D8） |
| `extractPackageNames()` | 双格式包名提取（packageNames 优先，旧格式回退） |
| `clearArtifactCache()` | advance 结束后清除 artifact 缓存（D17） |

## Artifact Schema 工具函数

| 函数 | 说明 |
|------|------|
| `getArtifactFilename(phase)` | phase 名 → 磁盘文件名映射（D14） |
| `getSchemaForPhase(phase)` | 根据阶段名查找对应 Zod Schema |
| `getPerPackageSchema(phase)` | 获取 translation/review/verify 的 per-package schema |
| `getAnalysisPackageSchema()` | 获取 analysis per-package schema |
| `getInventoryPackageSchema()` | 获取 inventory per-package schema |
| `getSummarySchema(phase)` | 根据阶段名获取 summary schema |

## 技术栈

- **运行框架**：[opencode](https://opencode.ai) AI Agent 插件（`@opencode-ai/plugin` 1.16.2）
- **Workflow Engine**：TypeScript 确定性状态机
- **SQL 解析**：AST 预扫描（`@griffithswaite/ts-plsql-parser` ^1.0.5）+ regex 降级 + LLM 语义补充
- **Schema 获取**：pg 驱动（可选依赖，有 db.properties 时自动启用，PostgreSQL/GaussDB）
- **Schema 校验**：Zod ^3.23.0
- **Agent 定义**：Markdown（按 `## Phase: xxx` 分节，位于 `.opencode/agent/`）
- **代码规约**：`docs/java-code-spec.md`（自动注入 agent system prompt），支持 `--spec` 用户自定义覆盖
- **LLM**：Claude API
- **目标框架**：Spring Boot + MyBatis + Lombok + Maven

## 输入输出

- **输入**：一组 PL/SQL 文件（.sql / .pks / .pkb / .pls），单目录或 `--header`+`--body` 双目录，参见 `resources/mfg_erp_sql/` 示例
- **输出**：可编译的 Java 项目（Spring Boot + MyBatis + Lombok）+ 转译过程记录（artifacts）
