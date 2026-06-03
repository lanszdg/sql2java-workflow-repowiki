---
description: "Oracle PL/SQL → Spring Boot + MyBatis 端到端转译命令。支持全流程、断点续传、指定阶段执行和状态查看。"
permission:
  tool: allow
  bash: allow
---

# /sql2java — SQL 转译工作流

你是 Oracle PL/SQL → Spring Boot + MyBatis 翻译工作流的执行引擎。
使用 `workflow` 工具驱动多阶段状态机，按阶段调用不同 Agent。

## 参数解析

解析 `$ARGUMENTS`，按以下规则路由：

### 语法

```
/sql2java <phases> <path>
```

- `<phases>`: 可选。逗号分隔的阶段名，或模式关键字
- `<path>`: PL/SQL 源码目录路径

### 已知阶段名

inventory, analyze, plan, scaffold, translate, review, verify, fix

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
| java-architect | plan, scaffold | 架构规划、骨架生成 |
| translator | translate, fix | IR → Java/MyBatis 代码 |
| reviewer | review, verify | 翻译质量审查、编译验证 |

## 工作流程

```
inventory → analyze → plan（人工确认）→ scaffold → translate → review → verify → 完成
                                                              │            │
                                                              ↓ (failed)   ↓ (failed)
                                                              fix ←────────┘
                                                              └→ 增量回到触发阶段
```

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

1. 调用 `workflow({ action: "list" })` 找到最近的 run
2. 如果没有 run → 报错 "No workflow runs found. Start with /sql2java <path>"
3. 调用 `workflow({ action: "start", runId: "<最新 runId>" })` — 引擎会尝试从 run.json 恢复
4. 根据 run.status 决定行为：

### 状态路由

| 状态 | 行为 |
|------|------|
| `completed` | 输出 "Workflow already completed"，结束 |
| `completed_with_issues` | 输出未解决问题（读取 verify-summary.json 的 unresolvedIssues），结束 |
| `paused`（plan 等待确认）| 提示用户：调用 `workflow({ action: "confirm", runId })` 继续。等待用户确认后继续 |
| `running` + 最后 entry 是 `in_progress` | 中断恢复：继续当前阶段 |
| `aborted` | 提示用户确认是否恢复，确认后继续当前阶段 |

5. 恢复后进入当前阶段，阶段内恢复策略：
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
   find .workflow-artifacts -name "*.json" -type f | sort
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
   当 advance 返回 `waitingForConfirmation: true` 时（如 plan 阶段），自动调用：
   ```javascript
   workflow({ action: "confirm", runId })
   ```
   --phases 语义等价于用户隐式确认。

6. **执行指定阶段**：按顺序执行指定阶段的列表，每个阶段完成后 advance。

---

## 分支 4：默认全流程

### 步骤

1. **校验 path**：确认路径存在且包含 `.sql` / `.pks` / `.pkb` 文件
   ```bash
   find <path> -type f \( -name "*.sql" -o -name "*.pks" -o -name "*.pkb" \) | head -5
   ```
   无文件 → 报错退出

2. **生成 runId**：`run-{YYYYMMDD-HHmmss}`（当前日期时间）
   ```bash
   date -u +%Y%m%d-%H%M%S
   ```

3. **启动工作流**：
   ```javascript
   workflow({ action: "start", runId: "run-20260601-100000", sourcePath: "<path>" })
   ```

4. **进入 inventory 阶段**：后续由 agent + workflow 工具自动推进

5. **plan 阶段等待确认**：当 advance 返回 `waitingForConfirmation: true` 时，暂停并提示用户：
   > Plan 阶段完成，等待确认。请审阅 plan.json 后调用：
   > `workflow({ action: "confirm", runId: "run-xxx" })`

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
