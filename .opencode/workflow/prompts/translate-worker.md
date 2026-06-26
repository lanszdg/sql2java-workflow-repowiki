# translate Worker 任务{{shardLabelSuffix}}

{{scopeBanner}}

执行工作流 `{{runId}}` 的 **translate** 阶段（PL/SQL → Java 翻译，分片 map）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**（advance/confirm/retry/abort/dispatch/fixContinue/start）。方法论见你的 agent 指南（translator.md）；本卡只给本分片的具体数据与范围。

## Runtime Context

- runId: `{{runId}}`
- phase: `translate`
- sourcePath: `{{sourcePath}}`
- artifactsDir: `{{artifactsDir}}`
{{mainEntryLine}}
{{projectRootLine}}

## 上游 artifact（只读这些）

{{upstreamArtifactsList}}

{{shardInfoBlock}}
{{scopeBlock}}
{{depSignaturesBlock}}

## 输出

- per-unit 翻译产物：`translations/{pkg}/{ref}.json`（符合 UnitTranslationSchema；聚合 `translations/{pkg}/translation.json` 由 engine 自动 merge，**不直接写**）
- Java 文件：写入 Runtime Context 中 `projectRoot` 指定的目录（绝对路径，与 scaffold 阶段同目录）。同包多 unit 共享的 Service/ServiceImpl/Mapper 文件用 **read 已有 + edit 追加方法**，勿覆盖 prior unit 内容。
- Worker Status：`{{artifactsDir}}/status/translate.json`

## 硬约束

- ⛔ **你的完整任务已在本提示中**（由引擎注入系统提示）。**禁止 Read 任何 `.workOrder.md` 文件**——那是审计追溯用，不是你的输入；也禁止 Read `dispatch-logs/` 下任何文件。任务就在这里，直接执行。
- ⛔ **只翻译本分片 targetUnits 列出的 PROCEDURE 单元**，禁止处理其他 unit。
- ⛔ **源码只读 `shard-inputs/{pkg}/{ref}/source.sql`**（引擎已预切）。禁止 read 整包 body/spec、`inventory-packages/{pkg}.json`、`analysis-packages/{pkg}.json`。子程序结构读 `shard-inputs/{pkg}/{ref}/analysis-slice.json`。
- ⛔ **跨包/同包跨单元调用签名查下方「依赖签名」预注入块**（引擎已按 callGraph 内联）。禁止 read `translations/{pkg}/translation.json`。预注入块标 `// TODO` 的目标（尚未翻译）照抄占位，由 review/fix 兜底。
- ⛔ `analysis.json` 里其他包/单元只是参考，不是工作清单。

## 指令

1. 读 Runtime Context 上游 artifact + 本分片切片（`shard-inputs/...`）+ 依赖签名块。
2. 按 procedureOrder 顺序逐 unit 翻译（根 + cargo FUNCTION），写 per-unit JSON + Java 文件。
3. 写 Worker Status。
4. 输出 WORKER_SUMMARY。

{{schemaHint}}
{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY`。
