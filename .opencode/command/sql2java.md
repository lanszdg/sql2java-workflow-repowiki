---
description: "Oracle PL/SQL → Spring Boot + MyBatis 端到端转译命令。支持全流程、断点续传、指定阶段执行和状态查看。"
permission:
  tool: allow
  bash: allow
---

# /sql2java — SQL 转译工作流

你是 Oracle PL/SQL → Spring Boot + MyBatis 翻译工作流的执行引擎。
使用 `workflow` 工具驱动多阶段状态机，按阶段调用不同 Agent。

**运行时**：本提示词中的 bash 命令使用 `bun .opencode/workflow/wf-util.js <cmd>` 形式调用工具脚本。

## 参数解析

解析 `$ARGUMENTS`，按以下规则路由：

### 语法

```
/sql2java [--db_conf <config_path>] [--structure <structure_file>] <phases> <path>
```

- `--db_conf <config_path>`: 可选。指定数据库配置文件路径（db.xml，Oracle JDBC 连接描述符格式）。未指定时自动在 `<path>` 目录下查找 `db.xml`
- `--structure <structure_file>`: 可选。Java 项目目录结构定义文件（Markdown tree 格式）。未指定时自动在 `<path>` 目录下查找 `project-structure.md`。都没有则使用默认 Maven 结构
- `<phases>`: 可选。逗号分隔的阶段名，或模式关键字
- `<path>`: PL/SQL 源码目录路径

### 参数提取顺序

1. 从 `$ARGUMENTS` 中提取 `--db_conf <path>`，记为 `dbConf`，从参数中移除
2. 从 `$ARGUMENTS` 中提取 `--structure <path>`，记为 `structureConf`，从参数中移除
3. 按以下规则路由剩余参数

### 已知阶段名

inventory, analyze, plan, scaffold, translate, dedup, review, verify, fix

### 模式关键字

- `status` — 查询工作流状态
- `resume` — 断点续传

### 路由规则

1. **`status`** → 调用 `workflow({ action: "status" })` 显示运行状态，结束
2. **`resume`** → 执行断点续传流程（见分支 2）
3. **指定阶段 + 路径** → 执行指定阶段流程（见分支 3）
4. **纯路径** → 端到端全流程（见分支 4）

## 可用 Agent

| Agent | 阶段 | 职责 |
|-------|------|------|
| sql-analyst | inventory, analyze | 扫描源码编目、依赖分析、FSD 生成 |
| java-architect | plan, scaffold, dedup | 架构规划、骨架生成、公共模块抽取 |
| translator | translate, fix | IR → Java/MyBatis 代码 |
| reviewer | review, verify | 翻译质量审查、编译验证 |

## 工作流程

```
inventory → analyze → plan → scaffold → translate → dedup → review → verify → 完成
                                                ↑       │             │
                                                │       ↓ (failed)   ↓ (failed)
                                                │       fix ←────────┘
                                                └───────┘ (fix → dedup → review)
```

## 进度跟踪（todowrite — 必须执行，非可选）

为了让用户在 sidebar 持续看到"当前执行到哪一步"，**必须**用 opencode 内置 `todowrite` 工具维护阶段进度 todo（每次都调用，不要依赖模型自发判断——那是"有时出现有时不出现"的根因）：

1. **`workflow({ action: "start" })` 成功后立即**调用 `todowrite`，写入主线 8 阶段，首个 `in_progress`、其余 `pending`：
   `inventory`(in_progress) · `analyze` · `plan` · `scaffold` · `translate` · `dedup` · `review` · `verify`
   - `--phases` 指定子集时，只列指定阶段，首个 `in_progress`

2. **每次 `workflow({ action: "advance" })` 返回新阶段 banner 后立即**再次调用 `todowrite` 全量更新：
   - 刚完成的阶段 → `completed`
   - banner 显示的新阶段 → `in_progress`
   - 其余保持不变

3. **fix 分支**：进入 fix 阶段时在列表末尾追加 `fix：修复 review/verify 问题`(in_progress)；fix 结束回到 dedup/review 时移除该项。

> `todowrite` 每次调用需传入**完整** todo 列表（每项 `{ content, status }`，status ∈ `pending`/`in_progress`/`completed`/`cancelled`），不是单条增量。**每次 advance 都必须更新 todowrite**——这是让进度条固定显示的关键。banner 里的 `📌 调用 todowrite...` 提醒即为此。

---

## 分支 1：--status

1. 调用 `workflow({ action: "list" })` 获取所有 run
2. 如果有 run，展示最近一次 run 的详细状态：
   ```
   workflow({ action: "status", runId: "<最新 runId>" })
   ```
3. 展示 runId、status、currentPhase、phaseHistory
4. 结束

---

## 分支 2：--resume（断点续传）

1. 调用 `workflow({ action: "resume" })` — 引擎自动从磁盘找到最新 run 并返回恢复策略
2. 根据 `metadata.resumeStrategy` 决定行为：

### 策略路由

| resumeStrategy | 行为 |
|------|------|
| `no_runs` | 报错 "No workflow runs found. Start with /sql2java \<path\>" |
| `corrupted` | 提示用户 run 数据损坏，建议新建 run |
| `already_completed` | 输出完成信息，结束 |
| `continue_phase` | 自动确认（兼容旧版本 paused 状态）并继续执行。对 translate/review/verify，使用 `metadata.skippedPackages` 跳过已完成的包（见下方阶段内恢复策略） |
| `restart_phase` | 调用 `workflow({ action: "start", runId })` 激活 run，从头执行当前阶段 |

3. 激活 run 后进入当前阶段，阶段内恢复策略：
   - **translate**：检查 `translations/*/translation.json`，跳过 `status=completed` 的包；对 `status=partial` 的包，读取 `completedSubprograms` 跳过已完成的子程序
   - **review / verify**：检查已有的 per-package artifact，跳过已完成包
   - **其他阶段**：直接重新执行

---

## 分支 3：--phases（指定阶段执行）

### 格式

```
/sql2java plan,scaffold /path/to/sql
```

### 步骤

1. **校验阶段名**：确认所有阶段名合法（在已知阶段名列表中），且按工作流顺序排列：
   ```
   inventory → analyze → plan → scaffold → translate → review → verify → fix
   ```

2. **校验前置 artifact**：检查目标阶段的必需 artifact 是否存在于 `.workflow-artifacts/` 目录下：

   | 目标阶段 | 必须存在的 artifact |
   |---------|-------------------|
   | analyze | inventory-index.json + inventory.json + inventory-packages/ |
   | plan | inventory-index.json + inventory.json + inventory-packages/ + analysis.json + analysis-packages/ |
   | scaffold | plan.json + inventory-index.json + inventory.json + inventory-packages/ |
   | translate | inventory-index.json + inventory.json + inventory-packages/ + analysis.json + analysis-packages/ + plan.json + scaffold.json |
   | review | plan.json + scaffold.json + analysis.json + analysis-packages/ |
   | verify | plan.json + scaffold.json |
   | fix | analysis.json + analysis-packages/ + plan.json + scaffold.json + review-summary.json 或 verify-summary.json + translations/ |

   使用 bash 检查文件存在性：
   ```bash
   bun .opencode/workflow/wf-util.js find-json .workflow-artifacts
   ```

   **OR 语义**：标注为 "A 或 B" 的前置项只需至少一个存在即可（如 fix 阶段的 `review-summary.json 或 verify-summary.json`）。

   缺少前置 → 报错退出，列出缺失文件。

3. **启动工作流**：
   ```javascript
   workflow({ action: "start", sourcePath: "<path>" })
   ```

4. **连续 advance 跳过前面的阶段**：对指定阶段之前的每个阶段调用：
   ```javascript
   workflow({ action: "advance", runId, result: "passed" })
   ```

5. **遇到 requiresConfirmation 阶段自动 confirm**：
   当 advance 返回 `waitingForConfirmation: true` 时，自动调用：
   ```javascript
   workflow({ action: "confirm", runId })
   ```
   --phases 语义等价于用户隐式确认。

6. **执行指定阶段**：按顺序执行指定阶段的列表，每个阶段完成后 advance。

---

## 分支 4：默认全流程

### 步骤

1. **校验 path**：确认路径存在
   ```bash
   bun .opencode/workflow/wf-util.js exists <path>
   ```
   引擎在扫描后会自动校验目录包含可处理文件（package、table、trigger 或 standalone procedure），无需手动检查文件类型。

1.5 **Schema 预获取**

   数据库配置按以下顺序查找（优先级从高到低）：

   1. `--db_conf` 参数指定的路径（`dbConf` 变量）
   2. `<path>/db.xml`（项目根目录自动发现）

   ```bash
   # 按优先级检测
   bun .opencode/workflow/wf-util.js exists <path>/db.xml
   ```

   - **有配置（db.xml）** → workflow start 会自动连接数据库获取 schema，生成 DDL 文件到 `<path>/ddl-output/` 目录下（即使已有 PL/SQL 文件也会获取），然后继续正常流程
   - **无配置** → 跳过 schema 获取，直接使用已有的 SQL/PLSQL 文件

1.6 **项目结构定义查找**

   按以下顺序查找（优先级从高到低）：

   1. `--structure` 参数指定的路径（`structureConf` 变量）
   2. `<path>/project-structure.md`（项目根目录自动发现）

   ```bash
   # 按优先级检测
   bun .opencode/workflow/wf-util.js exists <path>/project-structure.md
   ```

   - **有定义文件** → 传递给 workflow start，scaffold 阶段将使用自定义目录结构
   - **无定义文件** → 使用默认 Maven 结构（硬编码在 agent prompt 中）

2. **生成 runId**：`run-{YYYYMMDD-HHmmss}`（当前日期时间）
   ```bash
   bun .opencode/workflow/wf-util.js timestamp
   ```

3. **启动工作流**：
   ```javascript
   workflow({ action: "start", runId: "run-20260601-100000", sourcePath: "<path>", dbConf: dbConf, structureConf: structureConf })
   ```

4. **进入 inventory 阶段**：后续由 agent + workflow 工具自动推进

---

## 阶段依赖

| 阶段 | 前置产物 |
|------|---------|
| inventory | 无 |
| analyze | inventory-index.json + inventory.json + inventory-packages/ |
| plan | inventory-index.json + inventory.json + inventory-packages/ + analysis.json + analysis-packages/ |
| scaffold | plan.json + inventory-index.json + inventory.json + inventory-packages/ |
| translate | inventory-index.json + inventory.json + inventory-packages/ + analysis.json + analysis-packages/ + plan.json + scaffold.json |
| review | plan.json + scaffold.json + analysis.json + analysis-packages/ |
| verify | plan.json + scaffold.json |
| fix | analysis.json + analysis-packages/ + plan.json + scaffold.json + review-summary.json 或 verify-summary.json + translations/ |

---

## 数据库配置参考

当项目目录下放置 `db.xml` 文件时，工作流启动时会自动连接数据库获取 schema 并生成 DDL 文件。
即使项目已包含 PL/SQL 文件（.pks/.pkb），有 db.xml 配置时仍会拉取 schema 以获取完整的表结构定义。

### 配置文件位置

- **推荐**：放在项目源码目录下（如 `example_project/db.xml`），自动发现
- **显式指定**：通过 `--db_conf /path/to/db.xml` 参数指定

### 示例（Service Name，推荐）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<database>
  <url>jdbc:oracle:thin:@db-host.example.com:1521/ORCLCDB</url>
  <user>schema_reader</user>
  <password>env:ORACLE_DB_PASSWORD</password>
  <schema>ERP_OWNER</schema>
  <tableFilter>T_%</tableFilter>
</database>
```

### 示例（SID，旧式连接）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<database>
  <url>jdbc:oracle:thin:@db-host.example.com:1521:ORCLCDB</url>
  <user>schema_reader</user>
  <password>env:ORACLE_DB_PASSWORD</password>
  <schema>ERP_OWNER</schema>
</database>
```

### 示例（TNS 描述符）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<database>
  <url>jdbc:oracle:thin:@(description=(address=(host=db-host)(port=1521))(connect_data=(service_name=ORCLCDB)))</url>
  <user>schema_reader</user>
  <password>env:ORACLE_DB_PASSWORD</password>
</database>
```

### 配置项说明

| XML 标签 | 必填 | 默认值 | 说明 |
|----------|------|--------|------|
| `<url>` | 是 | — | Oracle JDBC 连接 URL（支持 Service Name、SID、TNS 描述符三种格式） |
| `<user>` | 是 | — | 数据库用户名 |
| `<password>` | 是 | — | 密码。支持 `env:VAR_NAME` 引用环境变量（推荐），也可直接写明文 |
| `<schema>` | 否 | user 大写 | 要获取 schema 的 Oracle owner |
| `<fetchTables>` | 否 | `true` | 是否获取表定义 |
| `<fetchTriggers>` | 否 | `true` | 是否获取触发器 |
| `<fetchViews>` | 否 | `true` | 是否获取视图 |
| `<fetchSequences>` | 否 | `true` | 是否获取序列 |
| `<fetchObjectTypes>` | 否 | `true` | 是否获取对象类型 |
| `<tableFilter>` | 否 | — | 表名过滤（SQL LIKE 语法，如 `T_%`） |
| `<triggerFilter>` | 否 | — | 触发器名过滤 |
| `<viewFilter>` | 否 | — | 视图名过滤 |
| `<sequenceFilter>` | 否 | — | 序列名过滤 |
| `<typeFilter>` | 否 | — | 对象类型名过滤 |

### 安全建议

- **密码**：优先使用 `<password>env:ORACLE_DB_PASSWORD</password>` 引用环境变量，避免明文写入配置文件
- **权限**：连接用户只需 `SELECT` 权限（访问 `all_tab_columns`、`all_constraints` 等数据字典视图），建议创建只读账号
- **版本控制**：建议将 db.xml 加入 .gitignore，避免密码泄露
