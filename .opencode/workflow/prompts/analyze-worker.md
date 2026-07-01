# analyze Worker 任务{{shardLabelSuffix}}

{{scopeBanner}}

执行工作流 `{{runId}}` 的 **analyze** 阶段（子程序结构解析 + FSD 生成，分片 map）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**（advance/confirm/retry/abort/dispatch/fixContinue/start）。方法论见你的 agent 指南（sql-analyst.md）；本卡只给本分片的具体数据与范围。

## Runtime Context

- runId: `{{runId}}`
- phase: `analyze`
- sourcePath: `{{sourcePath}}`
- artifactsDir: `{{artifactsDir}}`
{{mainEntryLine}}
{{projectRootLine}}
{{scopeLine}}

## 上游 artifact（只读这些）

{{upstreamArtifactsList}}

{{shardInfoBlock}}
{{scopeBlock}}

## 输出

- per-unit 结构：`analysis-packages/{pkg}/{ref}.json`（符合 UnitAnalysisSchema；本 unit 根 + cargo FUNCTION 的子程序结构）
- FSD 文档：`fsd/{pkg}/{ref}.md`（根 + 每个 cargo FUNCTION 各一份）
- 聚合 `analysis-packages/{pkg}.json` 由 engine 在分片 advance 后自动 merge，**agent 不直接写**
- Worker Status：`{{artifactsDir}}/status/analyze.json`（**最后一步写**，须含 `shardIndex` = 分片信息里的 shardIndex（1-based，与「本分片序号」一致）—— advance 完成门控，未写/不匹配则 advance 被拒）

## 硬约束

- ⛔ **你的完整任务已在本提示中**（由引擎注入系统提示）。**禁止 Read 任何 `.workOrder.md` 文件**——那是审计追溯用，不是你的输入；也禁止 Read `dispatch-logs/` 下任何文件。任务就在这里，直接执行。
- ⛔ **只处理本分片 targetUnits 列出的 PROCEDURE 单元**，禁止处理/读源码/生成 FSD for 任何其他 unit（会有别的分片做，重复 = 产物冲突）。
- ⛔ **源码只读 `shard-inputs/{pkg}/{ref}/source.sql`**（引擎已按 lineRange 预切本 unit 根 + cargo 的源码片段）。禁止 read 整个包 body/header 文件、`inventory-packages/{pkg}.json`、`analysis-packages/{pkg}.json`。
- ⛔ `dependency-graph.json` / `inventory.json` 里列出的其他包/单元只是参考信息，**不是你的工作清单**。
- refName 由 targetUnits（根 ref）+ `dependency-graph.json.functionOwnership`（cargo ref）给出，直接用作文件名，无需自己数重载。

## 指令

1. 读 Runtime Context 的上游 artifact（使用上方完整路径）+ 本分片切片（`shard-inputs/...`）。
2. 对每个 targetUnit 解析子程序结构 + 生成 FSD，逐 unit 写盘（per-unit JSON + FSD）。
3. 写 Worker Status。
4. 输出 WORKER_SUMMARY + TASK_STATUS（TASK_STATUS 必须是回复最后一段文本，见系统提示「阶段完成输出」）。

{{schemaHint}}
{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`（最后一段）。
