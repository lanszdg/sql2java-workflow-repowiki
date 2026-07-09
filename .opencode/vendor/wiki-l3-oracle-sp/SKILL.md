---
name: wiki-l3-oracle-sp
description: Repowiki Oracle PL/SQL 存过 FSD 生成 skill。drop-in 替换 sql2java-workflow 的 fsd/{PKG}/{subprogram}.md 生成。基于 L2 抽取的确定性事实 + 16-killer 确定性扫描 + 转化映射规则.md 查表，生成 6 板块 FSD。LLM 仅填 4 类散文字段（功能摘要/翻译策略/业务规则/控制流文字描述），其余全确定性。
---

# wiki-l3-oracle-sp

Repowiki Oracle PL/SQL 存过 FSD 生成 L3 业务 skill。用于 `oracle-sp` profile 的仓库，**drop-in 替换 sql2java-workflow 的 `fsd/{PKG}/{subprogram}.md`**，下游 translator 直接按本包 FSD 实施翻译。

## 定位（一句话，不再漂）

repowiki 产 `fsd/{PKG}/{subprogram}.md`，**只产 FSD，不产**：服务/功能清单、中文业务命名、outline 整库大纲（属 plan）。

FSD 完整对齐 `sp-to-fsd-design.md` 样例的 6 板块深度：板块2 含**列→Java 字段映射表**（Oracle 列 → Java 字段名推荐），板块3 含**跨包调用 → Service 注入关系表**。Java 字段名映射按 `转化映射规则.md` 查表（snake_case → camelCase），属于 FSD 必须产出的翻译说明书内容。

差异化价值：sql2java 的 FSD 板块6 由 LLM 现生成，repowiki 把 FSD 做成"**确定性为主、LLM 只填散文**"，更可靠（FSD 驱动 translator 写 Java，错一处→Java 错一处）。

## 产物与命名契约

- **路径**：`fsd/{PKG}/{subprogram}.md`
  - `{PKG}` = Oracle 包名**大写**（如 `CORE_PKG`）；独立过程用虚拟包 `__STANDALONE_*__`
  - `{subprogram}` = 子程序名**小写 snake_case**（如 `bulk_receive`）
  - **不使用中文业务名建目录**（避免与 sql2java 技术命名冲突）
- **重载** = `{name}__{序号}.md`（1-based 全带序号，按 inventory 出现序）
- **自包含**：禁"详见 xxx"占位符，每板块写实际内容
- **板块6固定收尾**：需手动审查表必有，无则"（无）"行

## 适用场景

- 仓库以 `.pks`/`.pkb`/`.sql` 为主，PL/SQL 存过为业务入口
- L1 codegraph 不支持 PL/SQL 解析，L2 用正则从文本抽取事实 + 16-killer 确定性扫描
- L3 基于 L2 facts 生成 FSD，不读源码

## FSD 6 板块 → 数据来源（确定性 vs LLM）

| 板块 | 字段 | 来源 | 确定性 |
|---|---|---|---|
| **概览** | 子程序名/类型/签名/参数表 | L2 facts（`signature`/`oracle_params`/`oracleToJava`） | ✅ 确定 |
| | 功能摘要 | L3 LLM | ⚠️ LLM |
| | 翻译策略 | 据命中 killer 集合归纳 | 半确定 |
| **表映射** | 表名/操作/关键条件/关键列 | L2 `table_facts` | ✅ 确定 |
| **依赖** | 目标包/目标子程序(refName)/功能 | L2 `cross_package_calls` | ✅ 只客观调用 |
| | 序列/常量依赖 | L2 `sequence_deps`/`constant_deps` | ✅ 确定 |
| **业务规则** | 编号校验/计算/边界 | L3 LLM（据 control_flow + 表操作归纳） | ⚠️ LLM |
| **控制流** | mermaid + 异常路径表 | L2 `control_flow`/`exception_handlers` | ✅ 骨架确定 |
| **转化规约** | 转化映射表 | 16-killer 扫描 + `转化映射规则.md` 查表 | ✅ **全确定，不 LLM** |
| | 事务边界 | L2（COMMIT/ROLLBACK/PRAGMA） | ✅ 确定 |
| | 需手动审查表 | high 风险 killer → 自动入表 | ✅ 确定 |

## FSD 章节强制要求

必须严格包含以下 6 个二级章节（不带编号，顺序固定）：
- 概览（含翻译策略）
- 表结构映射
- 依赖分析
- 业务规则
- 控制流与异常（含 mermaid 控制流图）
- 特殊语法转化规约（含转化映射表 + 事务边界 + 需手动审查的构造）

不得增减章节，不得使用编号标题（通用校验拒绝 `## 1. 概览` 形式）。

## 16-killer 确定性扫描

L2 `parseSpecialSyntax` 对齐 sql2java `plsql-scanner.ts`，扫描 16+ 个 killer 构造（覆盖 case1 全集）：

| killer | Java/MyBatis 等价（查表） | 风险 |
|---|---|---|
| FORALL SAVE EXCEPTIONS | MyBatis batch executor + 异常收集 | high |
| FORALL | MyBatis batch executor | medium |
| SQL%BULK_EXCEPTIONS | BatchUpdateException.getUpdateCounts() | high |
| EXECUTE IMMEDIATE | JdbcTemplate 动态 SQL | high |
| DBMS_SQL | JdbcTemplate + 动态列 RowMapper | high |
| MERGE INTO | MyBatis insertOrUpdate | medium |
| MODEL | Java 端按期迭代计算 | high |
| CONNECT BY | 递归 SQL 或 Java 递归方法 | high |
| WITH FUNCTION | 独立 Service 方法 | medium |
| MULTISET | Set.removeAll/retainAll 或 SQL 改写 | medium |
| PRAGMA AUTONOMOUS_TRANSACTION | @Transactional(REQUIRES_NEW) | medium |
| COMMIT | Spring 事务自动提交 | low |
| ROLLBACK | Spring 事务回滚 | low |
| CONDITIONAL_COMPILE ($IF) | 日志级别 / 配置开关 | medium |
| DBMS_SCHEDULER | @Scheduled / Quartz / XXL-JOB | medium |
| NOCOPY | Java 引用传递（无直接等价） | low |

> 完整映射表见 `rules/转化映射规则.md`。板块6 转化映射 = **确定性 join 本表，LLM 绝不自由编 Java 等价**。

## 翻译策略归纳规则

据本子程序命中的 killer 集合归纳翻译策略（板块1）：
- 命中 FORALL_SAVE_EXCEPTIONS + MERGE → "MyBatis batch executor + 异常收集 + insertOrUpdate"
- 命中 EXECUTE_IMMEDIATE → "JdbcTemplate 动态 SQL"
- 命中 PRAGMA_AUTONOMOUS_TRANSACTION → "Spring REQUIRES_NEW 事务"
- 命中 DBMS_SCHEDULER → "@Scheduled 定时任务"
- 无命中 killer → "标准 MyBatis Mapper + Service 调用"

## 语义来源（重要）

L3 禁止读源码。确定性来源优先级：
1. L2 facts（`signature`/`oracle_params`/`table_facts`/`control_flow`/`exception_handlers`/`special_syntax`）
2. 16-killer 扫描结果 + `转化映射规则.md` 查表
3. 存过名/包名按业务语义推断（如 `bulk_receive` → 批量接收）
4. 模板要求但事实无法支撑的硬字段才填"需人工复核"，不得编造

## 禁止

- 禁止重新扫描源码 / 调用 codegraph / 修改 knowledge
- 禁止用脚本伪造业务语义或直出清单
- 禁止把 PL/SQL 存过写成 DSF 服务或 HTTP 接口
- 禁止省略业务规则 / mermaid 控制流图 / 转化映射表
- **禁止 LLM 自由编 Java 等价**——板块6 转化映射 = 确定性查表（`转化映射规则.md`）
- **禁止产 outline.md**（整库大纲）——那是 plan 阶段的产物

## 必须（对齐 `sp-to-fsd-design.md` 样例）

- **板块2 必须产出列→Java 字段映射表**：每张表一张，列含 `列名/Oracle类型/Java类型/Java字段名/可空/主键/本SP使用`，Java 字段名按 `转化映射规则.md` 的 snake_case → camelCase 查表（非 LLM 自由发挥）。
- **板块3 必须产出 Service 注入表**：本子程序翻译后 ServiceImpl 需注入的 Service 字段（`字段名/类型/来源包/用途`），跨包调用转 @Autowired 注入。
- **板块1 必须产出转换策略 5 项分解**：服务映射 / 参数封装 / 返回类型 / 设计模式 / 异常处理。
- **板块4 必须按 4 类分表**：校验规则 / 计算逻辑 / 状态流转 / 边界条件。
- **板块5 简单子程序可省略 mermaid**：分支 ≤ 3 且无循环时允许文字描述替代；复杂子程序（分支 > 3 或含循环/异常处理）必须 mermaid + 分支表 + 循环表 + 异常表。
