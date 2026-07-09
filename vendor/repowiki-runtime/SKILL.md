---
name: repowiki
description: Repowiki 三层 Wiki 生成编排器。固定流程：L1 codegraph -> L2 profile facts -> merge knowledge -> L3 scheduler -> L3 skills/LLM agents -> completeness check。业务研发只能通过 L3 skill 配置 templates/rules，不能改主流程。当用户要生成 wiki、中文功能文档、整仓 wiki、大仓 wiki 时使用。
---

# repowiki

Repowiki 是 LingxiCode 的三层 Wiki 生成编排器，不是纯脚本生成器。

## 入口硬约束（默认：跑 repowiki-run.cjs 确定性编排）

进入 repowiki 后，**默认跑确定性编排器**，不要手工串 7 步：

```bash
node "<repowiki技能目录>/repowiki-run.cjs" "<仓根>" --verbose
```

repowiki-run.cjs 是 Node.js 状态机，确定性串完整主流程：

```text
L1 codegraph -> list 模块 -> L2 抽取 -> merge knowledge -> L3 scheduler -> L3 dispatcher(滚动 spawn opencode worker) -> completeness check
```

- 它自己调 codegraph-init / list-services / repowiki-l2 / merge-knowledge / repowiki-l3-scheduler / repowiki-l3-dispatcher / repowiki-progress，按 `.repowiki/*.json` 状态判定每步完成，写 `.repowiki/run-summary.json` 记 currentStage。
- **被 opencode bash 超时 kill 不是失败**：重跑同命令，从 run-summary 的 currentStage 续（与 codegraph-init 接续同构）。
- L1/L3 长任务（建图几小时、worker 几十分钟）会撞 1h bash 超时，重跑续即可。
- 看到 `[run] ALL_DONE. run-summary: ...` 即完成；看到 `[run] STOP: <原因>` 按原因排查（profile-mismatch / L1 failed / fakeDone 等）。
- 随时跑 `repowiki-progress.cjs "<仓根>"` 看阶段进度。

**仅在 run.cjs 不可用**（缺 node / 缺 .cjs / 想单步排错）时，才手工执行下面的步骤 0–7。正常路径不要手工串。

## 总原则

- 剃刀规则：先用最少层次、最少文件、最少协议解决问题。除非已有证据证明现有 claim/task/skill 模型无法满足，否则不要新增工具、上下文包、调度层或兼容分支。
- 用户触发 repowiki 时，默认目标就是完整整仓 wiki。不要再询问“完整生成还是试点生成”。
- 只有缺少必要输入、L3 skill 不存在、或当前运行环境明确无法派发 LLM/Agent 时，才停下来说明阻塞原因。
- L3 是完整执行任务队列，不允许改成“试点生成”“仅生成清单”之类的范围确认问题。
- 不允许用 `General Task — batch 1/2/3` 这种泛泛分批。每个 L3 子 Agent 必须先领取 scheduler 中的具体 task。
- L2/profile 只生产结构化事实，不生成中文业务语义。
- 业务规则只放在 L3 skill 的 `templates/` 和 `rules/`。
- scheduler 只生成任务队列、状态和进度，不写最终 wiki 正文。
- 最终服务清单、功能清单和功能文档必须由 L3 skill/LLM agent 生成业务语义；MD/CSV/XLSX 只能由控制面基于 canonical rows 确定性投影。
- L3 只读 `.repowiki/knowledge/*.json`、`.repowiki/modules.json`、scheduler task 和业务 L3 skill，不扫源码、不调 codegraph、不改 knowledge。
- 不保留脚本直出正文等绕过 L3 skill/LLM agent 的模式。

## 进度

随时可运行：

```bash
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>"
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>" l1
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>" l2
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>" l3
```

默认只打印摘要和真实产物进度，不展开未完成任务列表，避免大仓日志撑爆上下文。需要完整待办时加 `--verbose`：

```bash
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>" l3 --verbose
```

示例：

```text
PROGRESS l1 [########################] 1/1 100.0%
PROGRESS l2 [########------------] 20/58 34.5%
PROGRESS l3 [########------------] 45/116 38.8% outputs=45/116
```

用户可见的 L3 数字进度只能来自 `repowiki-progress.cjs "<仓根>" l3` 或 `repowiki-l3-task.cjs done/fail` 的返回。父 Agent 禁止凭记忆、早期 claim 数、已派发子 Agent 数手写 `x/y 完成`、`待处理 N`。每次准备对用户说“进度/完成/待处理/继续派发”前，必须先重新运行：

```bash
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>" l3
```

然后只摘录 `PROGRESS l3 ...` 这一行或 `# [L3] ...` 摘要中的当前数字，不要输出自造进度块。

> 以下步骤 0–7 是 repowiki-run.cjs 内部流程的参考说明（排错 / fallback 用）。正常路径跑 repowiki-run.cjs，不手工执行。

## 步骤 0：建图

codegraph 是后续事实来源。未建图时先运行：

```bash
node "<repowiki技能目录>/repowiki-codegraph-init.cjs" "<仓根>" --interval 30
```

不要先运行 `codegraph status` 判断是否需要建图。对未初始化仓库，第一条 L1 命令就是上面的静默建图包装器；不要直接运行会大量滚动输出的 `codegraph init ... --index`。

包装器会把原始 CodeGraph 输出写到：

```text
<仓根>/.repowiki/logs/codegraph-init-*.log
<仓根>/.repowiki/codegraph-init.json
```

前台固定信息只在启动/接续时打印一次；运行中只打印 compact 进度线，默认阶段变化、进度每增加 2% 或心跳才打印，`--verbose` 为 1%。详细滚动动画只写入日志，不直接刷屏；需要随时查看快照时运行 `repowiki-progress.cjs`。若会话压缩或前台工具超时，恢复时继续运行同一个包装器命令。包装器会读取 `.repowiki/codegraph-init.json`：`running` 且 pid 存活就继续等待；`running/stopped` 但 pid 已不存在时，先用 CodeGraph status 校验已有索引，若文件数和节点数可读则落成 `done`，否则自动用普通 `index` 接续，不自动 `--force`；`done` 才允许进入 L2。用户不需要人工确认接续，只有用户明确要删除或覆盖 `.codegraph` 这类破坏性操作时才需要确认。

建图/索引是 L1 长任务。必须给它足够长的超时；`lingxicode.bat` 已固化 `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=3600000`。工具调用超时不等于建图失败，也不代表底层进程已经停止。只要日志仍在刷新 `Parsing code` 或 init/index 进程仍在运行，就不要另起 `codegraph status`、`codegraph_codegraph_status` 或重复裸命令。opencode/Codex 的前台等待超时只能触发继续运行包装器、观察包装器单行进度，或告诉用户“建图仍在进行”；不能触发裸状态检查。若只看到等待超时，但没有包装器写出的 `status: done` 或 `status: failed`，默认建图仍在运行或需要包装器自动接续。

L1 完成条件只有一个：`.repowiki/codegraph-init.json` 中 `status` 为 `done`。`codegraph status` 只能作为包装器内部辅助体检，不能由 Agent 直接调用后判断“建图完成”。这是为了避免已有部分索引或旧索引被误认为本轮建图已经完成。

禁止模式：看到 `Parsing code ... <100%` 后输出“建图超时了，检查当前状态”，并调用 `codegraph_codegraph_status`。这会把仍在运行的 L1 长任务误判成失败任务。

L1 完成后禁止输出 text-only response 停下。必须立即运行步骤 2 的 `list-services.cjs`。脚本输出的 `NEXT:` 行已给出具体命令，直接运行。只有 `.repowiki/profile-mismatch.json` 存在（门禁阻塞）才允许停下报告。

## 步骤 1：选择 L2 profile

内置 profile：

```text
auto
dubbo
spring-rest
mq-listener
scheduled-job
batch-job
go-cli
go-http
k8s-controller
oracle-sp
```

非 Dubbo 项目必须先选对 profile。Spring Controller、MQ、Job、Batch、Go CLI、Go HTTP、Kubernetes controller、Oracle PL/SQL 存过(oracle-sp) 等入口发现属于 L2 profile，不属于 L3 skill。默认使用 `auto` 让 L2 依次尝试内置 profile（含 `oracle-sp`，纯 Oracle PL/SQL 仓——func/pkg/trigger/type/schema 等 `.sql/.pks/.pkb` 目录——会命中它，不要因它"不像代码仓"就当 profile-mismatch 阻塞，也不要去问用户）；显式指定单个 profile 时，只验证这个 profile。

Go/Kubernetes profile 的默认边界是运行/架构入口，不包括 `vendor/`、`third_party/`、`_test.go`、`test/`、`testing/`、`testdata/`、`examples/` 和生成代码。需要样例/测试 wiki 时应新增明确 profile，不能混进默认 L2。

如果仓库不属于内置 profile 覆盖范围，必须阻塞在 L2 profile 门禁：保留 L1 CodeGraph 结果，不写空 `modules.json`，不进入 L2 抽取、merge 或 L3，并说明需要补 L2 profile/adapter 后从步骤 1 重跑。不要用 L3 skill 弥补 L2 入口发现，也不要改用默认 `dubbo` 继续跑。

## 步骤 2：枚举模块

```bash
node "<repowiki技能目录>/list-services.cjs" "<仓根>" --profile auto
```

禁止用 `list-services.cjs --help` 当作探测命令。`--help` 只看用法，不产生 `.repowiki/modules.json`。

单个 profile 枚举为 0，只代表该 profile 不匹配，不能写状态；`auto` 会继续尝试其他内置 profile。只有所有候选 profile 都为 0，才触发 L2 profile 门禁阻塞，并写出：

```text
<仓根>/.repowiki/profile-mismatch.json
```

看到这个文件时，下一步是补 L2 profile/adapter 或改选正确 profile，再从步骤 1 重跑；不是进入 L3。

产物：

```text
<仓根>/.repowiki/modules.json
```

模块枚举完成后禁止输出 text-only response 停下询问。必须立即运行步骤 3 的 `repowiki-l2.cjs --all`。脚本输出的 `NEXT:` 行已给出具体命令，直接运行。只有 `profile-mismatch.json` 存在才允许停下报告门禁。

## 步骤 3：L2 抽取 knowledge

```bash
node "<repowiki技能目录>/repowiki-l2.cjs" "<仓根>" --all
```

`--all` 会读取 `.repowiki/modules.json`，按每个模块自己的 `profile` 分别抽取。只有明确要限定单一技术栈时，才额外传 `--profile <PROFILE>`。

产物：

```text
<仓根>/.repowiki/knowledge/parts/*.json
```

L2 抽取完成后禁止输出 text-only response 停下。必须立即运行步骤 4 的 `merge-knowledge.cjs`。脚本输出的 `NEXT:` 行已给出具体命令，直接运行。

## 步骤 4：合并 knowledge

```bash
node "<repowiki技能目录>/merge-knowledge.cjs" "<仓根>/.repowiki/knowledge"
```

产物：

```text
<仓根>/.repowiki/knowledge/services.json
<仓根>/.repowiki/knowledge/functions.json
<仓根>/.repowiki/knowledge/downstream.json
```

## 步骤 5：初始化 L3 调度

进入 L3 前先打印一次阶段状态，让用户知道 L2/merge 已完成、下一步进入 L3：

```bash
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>"
```

然后初始化 L3 队列：

```bash
node "<repowiki技能目录>/repowiki-l3-scheduler.cjs" "<仓根>" --concurrency 20
```

`--l3-skill` 省略时 scheduler 从 modules.json 的 profile 自动推断（oracle-sp→wiki-l3-oracle-sp，dubbo/spring-rest/其他→wiki-l3-icbc）。只有用户明确指定其他业务 skill 时才传 `--l3-skill <L3_SKILL>`。

产物：

```text
<仓根>/.repowiki/l3-scheduler/tasks.json
<仓根>/.repowiki/l3-scheduler/metadata/*.json
<仓根>/.repowiki/l3-scheduler/zero-functions.json
<仓根>/.repowiki/l3-scheduler/state.json
```

这个脚本只初始化任务和状态，不生成最终 wiki。任务包含服务清单、功能清单、功能文档说明和每个功能文档；服务清单/功能清单的 MD/CSV/XLSX 由控制面在 `commands.done` 时从 canonical rows 确定性导出，后续统一纳入 L3 进度。

scheduler 初始化完成后禁止输出 text-only response 停下询问"是否继续"。必须立即按 `dispatch` 数派发 worker。脚本输出的 `NEXT:` 行已给出 dispatcher 命令，直接运行；或读 `repowiki-progress.cjs "<仓根>" l3 --line` 的 dispatch 数派发对应数量子 Agent。

## 步骤 6：L3 skill/LLM agent 生成 wiki

执行前必须确认 scheduler 已初始化，再滚动派发 L3 子 Agent。不要在这里询问用户是否继续完整生成。

父 Agent 只负责控制面调度，禁止在派发前读取或理解以下文件：

```text
config/skills/<L3_SKILL>/SKILL.md
config/skills/<L3_SKILL>/templates/*
config/skills/<L3_SKILL>/rules/*
<仓根>/.repowiki/l3-scheduler/tasks.json
<仓根>/.repowiki/knowledge/functions.json
<仓根>/.repowiki/knowledge/downstream.json
```

这些内容由子 Agent 在 claim 后按 `businessContext` 和 `factContext` 使用。父 Agent 如果为了排错需要读取，必须先说明是在排错；正常生成路径不要读。

父 Agent 派发子 Agent 时，必须使用 `l3-worker-prompt.md` 作为固定任务说明。父 Agent 只替换其中的占位符：

```text
<REPO>                -> 仓根
<REPOWIKI_SKILL_DIR>  -> repowiki 技能目录
<AGENT_NAME>          -> 唯一子 Agent 名称
<KIND>                -> 可选 task 类型；默认留空
```

不要把 “生成 batch 1/2/3” 作为子 Agent 任务说明。子 Agent 必须自己 claim 一个具体 task。

子 Agent 领取任务必须使用控制面脚本：

```bash
node "<repowiki技能目录>/repowiki-l3-task.cjs" claim "<仓根>" --agent <AGENT_NAME>
```

领取结果为 `NO_TASK` 时说明当前没有可领取任务。领取到 JSON 后，必须使用其中的 `businessContext`、`factContext`、`commands.done`、`commands.fail`。完成后：

```bash
node "<repowiki技能目录>/repowiki-l3-task.cjs" done "<仓根>" --id <TASK_ID> --agent <AGENT_NAME>
```

领取结果为 `NO_SLOT` 时表示并发已满，父 Agent 等任意子 Agent 完成后再派发新的子 Agent，不要改小 scheduler 并发或重新初始化队列。

失败时：

```bash
node "<repowiki技能目录>/repowiki-l3-task.cjs" fail "<仓根>" --id <TASK_ID> --agent <AGENT_NAME> --error "<ERROR>"
```

L3 派发就一条命令——直接运行通用滚动调度器，它自己把 `dispatch` 协议落成闭环、滚动派发 worker 到 ALL_DONE：
```bash
node "<repowiki技能目录>/repowiki-l3-dispatcher.cjs" "<仓根>"
```

调度器会循环读取 `repowiki-progress.cjs "<仓根>" l3 --line`，只补发 `dispatch` 个 worker，并把已经启动但尚未 claim 的 worker 计入保留槽位，避免“20 个全结束后再来 20 个”的固定批次退化。worker 的 runner（包根下 `bin/opencode.exe` 或 `lingxicode.bat`）由调度器自己用绝对路径检测——**不要自己写 shell（`if exist`/`where`/`ls`）去判断 runner 在不在**：这类检查容易因 CMD 变量展开或 PATH 差异给出假阴性，把好端端的调度器误判成"不可用"。**直接跑上面这条命令**；只有当调度器本身退出并报 `runner not found` 时，才改用下面的手工协议。不要默认走手工 Task 派发，也不要纠结"本轮派 8 个还是 20 个"——补发数量调度器会按 `dispatch` 处理。

父 Agent 的手工并发策略是 `dispatch` 驱动的滚动调度，不是固定批次：

1. 先运行：

```bash
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>" l3 --line
```

2. 只读取这一行里的 `running=<当前>/<并发上限>`、`ready=<可领取任务数>`、`blocked=<等待上游任务数>`、`dispatch=<本轮应补发数>`。
3. 本轮只启动 `dispatch` 个子 Agent；`dispatch=0` 时不要盲目启动子 Agent，`dispatch=1` 时只能启动 1 个，不能说“派发更多 worker”或“加速处理”。
4. 任意子 Agent 完成后，重新运行同一条 `progress --line`，按新的 `dispatch` 继续补发。
5. 如 `ready=0 blocked>0 running>0`，说明 DAG 下游任务尚未就绪，只等待已有子 Agent 完成，不新开 worker。
6. 如 `ready=0 blocked>0 running=0`，说明 DAG 上游未成功完成或状态异常，先查看失败/打回原因，不要继续派发。
7. 如出现 `status=ALL_DONE`，停止派发。

不要一开始按 `concurrency` 盲目启动一批，也不要等一整批全部完成才进入下一批。只有 `dispatch>1` 时才可以描述为“批量补发”；`dispatch=1` 只能描述为“派发 1 个 worker”。对用户展示进度时，必须使用刚刚读取的 `PROGRESS l3 ... --line`，不要复述旧的 `x/y` 文案。

每个 L3 子 Agent：

- 必须先运行 `repowiki-l3-task.cjs claim` 领取一个具体 task。
- 必须按 claim 返回的 `businessContext` 读取业务 `SKILL.md`、`templates/`、`rules/`，并按这些业务规则生成。
- 必须使用 claim 返回的 `factContext`，只处理当前 task。
- 不要读取 `tasks.json`；function-doc 子 Agent 不要读取全量 `functions.json`、全量 `downstream.json`，除非 `factContext` 缺少必填事实。
- function-doc 子 Agent 生成当前功能文档和 sidecar metadata。
- aggregate task 子 Agent 根据 `businessContext`、`factContext` 中允许的合并 knowledge 路径和必要事实生成 service/function canonical rows；控制面在 `commands.done` 时校验 rows 并确定性投影 MD/CSV/XLSX。
- 子 Agent 不扫源码、不调 codegraph、不修改 `.repowiki/knowledge/*.json`。
- 完成后必须运行 claim 返回的 `commands.done`，由控制面脚本校验输出文件存在且非空，再设置 `completed_by: "l3-skill"`。
- 子 Agent 只处理一个 task，运行 `commands.done` 或 `commands.fail` 后必须结束；禁止继续 `claim next`、禁止在同一个子 Agent 内串行处理多个 task。

服务清单、功能清单的业务语义由 L3 skill/LLM 生成到 canonical rows；MD/CSV/XLSX 只由 repowiki 脚本按业务 skill 的 columns.conf 投影，不再由子 Agent 各自理解格式。

L3 子 Agent 不要把完整清单、CSV 或功能文档正文粘贴到会话输出。完成一个 task 时只返回简短状态：

```text
[L3-task] done id=<task-id> progress=<done>/<total> running=<n>/<concurrency> ready=<n> blocked=<n> dispatch=<n> failed=<n> pending=<n> output=<path>
```

## 步骤 7：完整性校验

```bash
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>"
node "<repowiki技能目录>/repowiki-progress.cjs" "<仓根>" l3
```

必须看到：

```text
ALL_DONE l3
```

`ALL_DONE l3` 只代表 state done、真实输出文件和失败数同时满足。若出现 `fakeDone>0` 或 `FAKE_DONE`，说明历史 state 标记完成但产物不存在/过小，必须继续由 L3 子 Agent 重新领取生成。

## 业务 L3 skill

复制：

```text
config/skills/wiki-l3-default
-> config/skills/wiki-l3-<业务名>
```

只改：

```text
SKILL.md
templates/服务清单.columns.conf
templates/功能清单.columns.conf
templates/功能文档.md
rules/*.md
```

业务 L3 skill 不能改主流程，不能写 `.repowiki/knowledge/*.json`，不能调用 codegraph 重新发现事实。
