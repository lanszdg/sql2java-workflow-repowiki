# 超大存储过程项目可扩展性风险分析

> 审查时间：2026-06-08（2026-06-15 更新）
> 范围：`.opencode` 工作流引擎（inventory → analyze → plan → scaffold → translate → dedup → review → verify → fix）
> 假设规模：500+ Oracle Package、数千个子程序、百万行级 PL/SQL

---

## 风险总览

| 优先级 | # | 风险点 | 根本原因 | 影响阶段 |
|--------|---|--------|---------|---------|
| 🔴 P0 | 1 | plan 读全量 FSD / analysis-packages | 无硬性读取限制 | plan |
| 🔴 P0 | 2 | analyze 阶段 grep 调用图输出爆炸 | 无输出大小限制 | analyze |
| 🔴 P0 | 3 | 大包翻译超出上下文窗口 | 无子程序级分批 | translate |
| 🔴 P0 | 4 | review 审查大包超出上下文窗口 | 无子程序级分批 | review |
| 🟡 P1 | 5 | 固定批次大小 2-3，不自适应包大小 | 硬编码常量 | inventory / analyze |
| 🟡 P1 | 6 | inventory-index.json 的 callGraph 字段无界增长 | Record 无 cap | inventory / analyze |
| 🟡 P1 | 7 | inventory.json 的 tables[].columns 无界增长 | 无表/列数量限制 | plan / scaffold / translate |
| 🟡 P1 | 8 | advance 时全量 Zod 校验同步阻塞 | O(N) 同步 I/O | 所有阶段 |
| 🟡 P1 | 9 | scaffold 读全量 inventory-packages | 无硬性读取限制 | scaffold |
| 🟢 P2 | 10 | FSD 文件数量爆炸（子程序级粒度） | 5000+ 文件 | analyze / translate |
| 🟢 P2 | 11 | analysis.json callGraph + complexity 无界增长 | Record 无 cap | analyze 及下游 |
| 🟢 P2 | 12 | fix 阶段上游 artifact 列表最庞大 | 通配符 + 无过滤 | fix |
| 🟢 P2 | 13 | 输出截断是事后处理，非预防性 | ~~无 token budget 机制~~ 已部分缓解（L3 质量门控 + 大输出截断） | 所有阶段 |
| 🟢 P2 | 14 | scanner 预扫描全量文件到内存 | 无流式处理 | inventory（预扫描） |

---

## 🔴 P0 — 可能直接导致大模型爆上下文 / 崩溃

### 1. plan 阶段读取全量上游 artifact（含所有 FSD）

**代码位置**：`workflow-definitions.ts:110`

```typescript
plan: [
  "inventory-index.json", "inventory.json", "inventory-packages/*.json",
  "analysis.json", "analysis-packages/*.json", "fsd/*/*.md"
],
```

**问题描述**：

plan 阶段的 `UPSTREAM_ARTIFACTS` 包含三个通配符路径：`inventory-packages/*.json`、`analysis-packages/*.json`、`fsd/*/*.md`。agent 指令中写的是"按需读取"，但**没有任何引擎层面的硬性约束**阻止 agent 一次性读取全部。

**规模估算**：

| Artifact | 单文件大小 | 500 包总量 |
|----------|-----------|-----------|
| `inventory-packages/{PKG}.json` | ~20 KB | ~10 MB |
| `analysis-packages/{PKG}.json` | ~100 KB | ~50 MB |
| `fsd/*/*.md`（5000 个子程序） | ~10 KB | ~50 MB |

即使 agent 只读了一部分，对于 100+ 包的项目，上下文就可能超出大多数模型的 128K token 窗口。

**影响**：plan 阶段直接失败，无法产出 `plan.json`。

> **2026-06-10 更新**：Schema 预获取（D18）已将 DDL 数据获取前置到工作流启动前（通过 `schema-fetcher.ts` 从数据库拉取），减少了 `inventory.json` 中 `tables` 部分的依赖。但 `inventory-packages/*.json` 和 `analysis-packages/*.json` 的通配符读取问题仍未在引擎层面解决。

---

### 2. analyze 阶段 grep 调用图输出爆炸

**代码位置**：`sql-analyst.md:298-299`

```bash
grep -rn '\w\+_\w\+\.\w\+' ${sourcePath}/pkg/ --include="*.sql" | grep -v "^.*--"
```

**问题描述**：

这个 grep 命令匹配所有 `XXX_YYY.ZZZ` 模式的文本，用于构建跨包调用图。对于百万行级 SQL 项目：

- grep 输出可能有 **数万到数十万行**
- 正则 `\w\+_\w\+\.\w\+` 会误匹配大量非调用关系的内容（列引用 `ORDER_DETAIL.QUANTITY`、绑定变量等）
- 全部输出涌入 LLM 上下文后直接爆掉

**影响**：analyze 阶段的调用图构建步骤失败，无法产出完整的 `analysis.json`。

---

### 3. 大包翻译超出上下文窗口

**代码位置**：`translator.md:91-102`（输入列表）+ `translator.md:119-135`（工作步骤）

**问题描述**：

translator 翻译单个包时需要同时加载：

| 输入 | 大包估算 |
|------|---------|
| `.pks` + `.pkb` 源文件 | 3000-5000 行 PL/SQL |
| `analysis-packages/{pkg}.json` | 50-100 KB（30 个子程序 × blocks/variables/cursors） |
| `plan.json`（映射规则） | ~5 KB（固定） |
| `scaffold.json`（项目结构） | ~10 KB（固定） |
| 可选 FSD 文档（30 个子程序） | ~300 KB |

一个有 30+ 子程序的大包，单次翻译的上下文输入可达 **数十万 token**。而 translator 的指令是"逐子程序翻译"，但**没有子程序级别的分批机制**——agent 必须在一次 LLM 调用中处理完整个包的所有子程序。

**影响**：translate 阶段对大包直接失败，或 LLM 被截断导致产出不完整的 Java 代码。

---

### 4. review 审查大包超出上下文窗口

**代码位置**：`reviewer.md:89-119`

**问题描述**：

review 对每个包需要同时读取：

| 输入 | 大包估算 |
|------|---------|
| PL/SQL 源码（`.pks` + `.pkb`） | 3000-5000 行 |
| Java 翻译代码（Mapper + XML + Service + DTO） | 2000-4000 行 |
| `analysis-packages/{pkg}.json` | 50-100 KB |
| `translations/{pkg}/translation.json` | 10-50 KB |

review 需要按 **10 类审查清单**逐项检查每个子程序，逐行对照 PL/SQL 和 Java 代码。对于 30+ 子程序的大包，上下文输入 + 输出（`procedureReviews` 中每个子程序 10 个 check）轻松超过上下文窗口。

而且 review **没有包内分批机制**——必须在一个包的审查中完成所有子程序的检查。

**影响**：review 阶段对大包审查失败或被截断，`review.json` 产出不完整。

---

## 🟡 P1 — 可能导致性能问题或间接触发上下文溢出

### 5. 固定批次大小 2-3，不自适应包大小

**代码位置**：`sql-analyst.md:110`、`sql-analyst.md:271`、`sql-analyst.md:332`

```
必须按批次处理，每批 2-3 个包
```

**问题描述**：

批次大小是**硬编码的固定常量**，不根据包的实际代码量或子程序数调整：

- **过大风险**：2 个各 5000 行的包放一批 → 单批上下文可能 200K+ token，爆掉
- **过小浪费**：10 个各 50 行的包分成 4 批 → LLM 调用次数翻倍，时间和成本浪费

**建议**：基于 `inventory-index.json` 中的 `estimatedLoc` 字段动态计算批次大小（如设定单批最大 2000 LOC 上限）。

---

### 6. inventory-index.json 的 callGraph 字段无界增长

**代码位置**：`artifact-schemas.ts:59`、`plsql-scanner.ts:429-455`

```typescript
// artifact-schemas.ts
callGraph: z.record(z.array(z.string())).optional(),

// plsql-scanner.ts — 提取 PKG.PROC 调用关系
const key = `${pkg}.${proc}`
if (!callGraph[key]) callGraph[key] = []
```

**问题描述**：

scanner 预扫描时把所有 `PKG.PROC` 模式的调用关系放入 `callGraph`。500 个包 × 平均 10 个子程序 = **5000 个 key**，每个 key 对应一个 string 数组。虽然标记为 `optional`，但若存在，agent 读取时会占用大量上下文。

且 scanner 的正则只匹配 `XXX_YYY.ZZZ` 模式，不区分"真正的跨包调用"和"表名.列名引用"，误报率较高。

---

### 7. inventory.json 的 tables[].columns 无界增长

**代码位置**：`artifact-schemas.ts:113-123`

```typescript
tables: z.array(z.object({
  name: z.string(),
  ddlFile: z.string().optional(),
  columns: z.array(z.object({
    name: z.string(),
    oracleType: z.string(),
    nullable: z.boolean(),
    isPrimaryKey: z.boolean(),
    defaultValue: z.string().optional(),
  })),
})),
```

**问题描述**：

200+ 张表 × 平均 30 列 = **6000+ 列定义**在 `inventory.json` 中。这个文件在 plan、scaffold、translate 三个阶段都被列为上游 artifact，每次都可能被读入上下文。

**规模估算**：200 张表 × 30 列 × ~80 字节/列 ≈ **4.8 MB JSON**。

---

### 8. advance 时全量 Zod 校验同步阻塞

**代码位置**：`workflow-engine.ts:324-445`

**问题描述**：

每次 `advance` 操作时，引擎会**同步遍历所有 per-package 文件**执行 Zod 校验：

- `validateAnalysisPackages`：读取 500 个 `analysis-packages/{PKG}.json`
- per-package 校验：读取 500 个 `translations/{PKG}/xxx.json`

每个文件执行 `readFileSync` → `JSON.parse` → `Zod.safeParse`，合计 500-1500 次同步 I/O。不会爆 LLM 上下文（引擎内部操作），但可能导致 **advance 操作超时或严重卡顿**（尤其在低配机器上）。

---

### 9. scaffold 读全量 inventory-packages

**代码位置**：`workflow-definitions.ts:111`

```typescript
scaffold: ["plan.json", "inventory-index.json", "inventory.json", "inventory-packages/*.json"],
```

**问题描述**：

scaffold 需要为每个表生成 Entity 类、为每个类型定义生成 DTO。agent 需要理解所有包的类型系统（`types[].definition`），可能将全量 `inventory-packages/*.json` 读入上下文。500 个包 × 20 KB = **~10 MB**。

---

## 🟢 P2 — 设计上的可扩展性隐患

### 10. FSD 文件数量爆炸

**代码位置**：`sql-analyst.md:363-405`

**问题描述**：

FSD 按子程序粒度生成，每个子程序一个 `.md` 文件。500 个包 × 平均 10 个子程序 = **5000 个 FSD 文件**。

- analyze 阶段验证时需遍历所有 FSD 做完整性检查（`for f in inventory-packages/*.json` 循环对比）
- FSD "自包含规则"要求每个文件包含完整表映射、依赖分析、业务规则等，导致跨文件内容大量重复
- 下游阶段（translate, plan）如果误读全量 FSD 会触发 P0 风险

---

### 11. analysis.json 的 callGraph + complexity 无界增长

**代码位置**：`artifact-schemas.ts:202-213`

```typescript
callGraph: z.record(z.array(z.string())),
packageDependency: z.record(z.array(z.string())),
complexity: z.record(z.object({
  score: z.number().min(1).max(10),
  patterns: z.array(z.string()),
  riskLevel: z.enum(["low", "medium", "high"]),
})),
```

**问题描述**：

- `callGraph`：5000 个子程序的调用关系，每个 key 对应一个 string 数组
- `complexity`：500 个包的复杂度记录，每个含 `patterns` 数组
- `packageDependency`：500 个包的跨包依赖

三者合计，`analysis.json` 在大项目中可能达到 **数 MB**。这个文件在 plan、translate、review、fix 四个阶段都被读取。

---

### 12. fix 阶段上游 artifact 列表最庞大

**代码位置**：`workflow-definitions.ts:115-121`

```typescript
fix: [
  "analysis.json", "analysis-packages/*.json", "plan.json", "scaffold.json",
  "review-summary.json", "verify-summary.json",
  "translations/*/translation.json", "translations/*/review.json",
  "translations/*/verify.json",
],
```

**问题描述**：

fix 阶段的上游 artifact 是所有阶段中最多的（9 类文件）。虽然 fix 只处理 `targetPackages` 指定的包，但 agent 指令中没有明确说"只读 targetPackages 相关文件"。如果 agent 读取了所有 translations 目录下的文件，上下文会立即溢出。

---

### 13. 输出截断是事后处理，非预防性（⚠ 已部分缓解）

**代码位置**：`workflow-engine.ts` — `truncateStringsDeep`

> **2026-06-15 更新**：已实现两层缓解措施：
> 1. **大输出截断**（`tool.execute.after` hook）：对 JSON 输出超过 50KB 时递归截断字符串（>10KB）
> 2. **L3 质量门控**（D21）：translate/review/verify 三个阶段 advance 时执行确定性数值阈值检查（G1 翻译完成率≥0.8 / G3 review 分数≥70 / G6 测试通过率≥0.7），门控不通过直接 rejected，避免下游阶段处理不完整数据
>
> 但以下预防性机制仍缺失：

```typescript
"tool.execute.after": async (input: any, output: any) => {
  const j = JSON.stringify(output)
  if (j?.length > 50000) {
    truncateStringsDeep(output, 10000)
  }
}
```

**问题描述**：

输出截断在 `tool.execute.after` hook 中执行，属于**事后处理**。只能截断已返回的结构化输出中的长字符串字段，**无法防止 LLM 在生成过程中因输入过大而爆上下文**。

缺失的预防机制：
- 无 token budget 预算（发送前估算输入 token 数）
- 无文件大小阈值（读取 artifact 前检查文件大小）
- 无动态批次调整（根据输入量自动缩小批次）

---

### 14. scanner 预扫描全量文件到内存

**代码位置**：`plsql-scanner.ts:131-132`、`plsql-scanner.ts:469-470`

```typescript
const code = readFileSync(filePath, "utf-8")
```

**问题描述**：

scanner 逐文件 `readFileSync` 全部源码到内存做 AST/regex 解析。虽然单文件是串行处理的，但对于有数千个 SQL 文件的大型项目，中间数据结构（`packages` Map、`callGraph` Record）会持续增长。不会爆 LLM 上下文（scanner 不经过 LLM），但**超大项目可能导致 Node.js 堆内存不足**。

---

## 根因分析

所有风险点归结为**同一个模式**：

> **上游 artifact 路径使用了通配符（`*.json`、`*/*.md`），agent 指令中写了"按需读取"或"分批处理"的软约束，但缺乏引擎层面的硬性防护。**

中型项目（50-100 包）时，LLM 能自律遵守这些软约束。超大项目（500+ 包）时，通配符匹配的文件总量巨大，LLM 很容易失控——要么误读全部文件爆上下文，要么产出不完整的结果。

### 缺失的防护机制清单

| 机制 | 当前状态 | 理想状态 |
|------|---------|---------|
| Token budget 预算 | ❌ 无 | 发送 LLM 前估算输入 token，超限自动裁剪 |
| 文件大小阈值 | ❌ 无 | 读取 artifact 前检查文件大小，超限拒绝或摘要 |
| 动态批次大小 | ❌ 固定 2-3 | 基于 LOC / 子程序数自适应 |
| 子程序级分批 | ❌ 无 | translate/review 按子程序分批处理 |
| grep 输出截断 | ❌ 无 | analyze 调用图 grep 结果限制行数 |
| artifact 体积监控 | ❌ 无 | 写入时检查大小，超限告警或拆分 |
| 引擎级读取白名单 | ❌ 通配符 | 只注入当前批次需要的文件路径 |
| 大输出截断 | ✅ 已实现 | `truncateStringsDeep` 递归截断 >10KB 字符串 |
| Schema 预获取 | ✅ 已实现 | `schema-fetcher.ts` 前置拉取 DDL，减少 inventory.json 构建负担 |
| Java 代码规约注入 | ✅ 已实现 | `docs/java-code-spec.md` 自动注入，减少 agent .md 文件体积 |
| L3 质量门控 | ✅ 已实现 | 确定性数值阈值（G1/G3/G6），门控不通过直接 rejected |
| refName 重载规范 | ✅ 已实现 | 重载子程序用 `{name}__{序号}` 消除歧义 |
| 跨 Schema 分级校验 | ✅ 已实现 | blocking（必须修正）/ warning（显式确认），避免误报卡流程 |

---

## 修复优先级建议

### 短期（不改架构）

1. **grep 输出截断**：analyze 阶段的 grep 命令加上 `| head -5000` 或类似限制
2. **动态批次大小**：基于 `inventory-index.json` 的 `estimatedLoc` 字段动态计算批次
3. **agent 指令强化**：在所有 agent .md 文件中添加明确的读取上限警告（如"禁止一次读取超过 100KB 的 artifact 文件"）
4. **advance 校验异步化**：`validateArtifactOnDisk` 改为异步批量处理，避免同步阻塞

### 中期（需要一定重构）

5. **子程序级分批**：translate 和 review 阶段支持按子程序分批处理大包
6. **artifact 大小监控**：写入 artifact 时检查文件大小，超限自动拆分或摘要
7. **fix 阶段路径过滤**：引擎层根据 `targetPackages` 过滤 `UPSTREAM_ARTIFACTS`，只注入相关文件路径
8. **inventory.json 分页**：`tables` 部分拆分为 `inventory-tables.json`，按需读取

### 长期（架构变更）

9. **Token budget 系统**：在 `chat.params` hook 中估算输入 token，超限自动裁剪非关键内容
10. **摘要 + 按需展开机制**：大 artifact 生成摘要版本供全局参考，细节按需加载
11. **流式 scanner**：预扫描改为流式处理，避免全量加载到内存
