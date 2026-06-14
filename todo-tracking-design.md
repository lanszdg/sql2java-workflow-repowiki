# 方案：通过 TS 代码确定性控制 TUI TodoList

## Context

当前 `/sql2java *` 执行时，TUI 侧边栏是否出现 todolist、内容是什么，完全取决于 LLM 是否主动调用 `todowrite` 工具以及怎么调用。不同模型表现差异大，导致进度追踪不可靠。

**目标**：在 workflow-engine 层面通过 TS 代码确定性控制 todolist 的内容和更新时机，使 TUI 侧边栏始终展示准确的阶段进度。

## 核心发现

1. **`todowrite` 是 opencode 内置工具**，LLM 调用它 → 写入 SQLite → TUI 渲染
2. **primary "build" agent 有 `todowrite` 权限**，subagent 默认 `todowrite: false`（`task.ts:204-205`）
3. **执行模型**：primary agent 执行 `sql2java.md` 命令 → 调用 `workflow` 工具 → 调用 `Agent` 工具 spawn subagent
4. **Plugin hooks**：`experimental.chat.system.transform` 和 `chat.params` 仅在 `currentWorkflowContext` 非空时生效，即仅在 subagent 系统提示词层面生效

## 方案设计

### 思路

**修改两个文件**：
1. **`sql2java.md`** — 添加 `todowrite` 指令，由 primary agent（有权限）在阶段转换时机械式调用
2. **`workflow-engine.ts`** — 在 `advance` 输出中嵌入结构化 `todoUpdate` 数据，primary agent 直接复制到 `todowrite` 调用

这样 TS 代码决定"显示什么"（通过 advance 返回的结构化数据），LLM 只负责"机械搬运"（调用 todowrite 传参）。

### 改动 1：`workflow-engine.ts` — advance 输出嵌入 todo 快照

在 `advance` action 的成功返回中，计算并追加一段结构化的 todo 状态文本：

```typescript
// 新增辅助函数
function buildTodoSnapshot(run: WorkflowRun, completedPhase: string): string {
  const mainPhases = SQL2JAVA_WORKFLOW.phases.filter(p => !p.isFixPhase)
  const currentPhase = run.currentPhase ?? ""

  // 从 phaseHistory 推导已完成阶段
  const completedSet = new Set(
    run.phaseHistory
      .filter(e => e.status === "completed")
      .map(e => e.phase)
  )
  // fix 阶段是条件性的
  const isFixPhase = SQL2JAVA_WORKFLOW.phases.find(p => p.name === currentPhase)?.isFixPhase

  const items = mainPhases.map(p => {
    let status: string
    if (completedSet.has(p.name) || p.name === completedPhase) {
      status = "completed"
    } else if (p.name === currentPhase) {
      status = "in_progress"
    } else {
      status = "pending"
    }
    // 构造对象，统一由 JSON.stringify 序列化（自动转义，description 含引号/换行也安全）
    return { content: `${p.name} — ${p.description}`, status, priority: "high" }
  })

  // fix 阶段追加
  if (isFixPhase || completedSet.has("fix")) {
    items.push({
      content: "fix — 修复审查/验证发现的问题",
      status: currentPhase === "fix" ? "in_progress" : "completed",
      priority: "high",
    })
  }

  // JSON.stringify 负责转义与格式，避免手拼字符串在 description 含 `"` 时破坏 JSON
  return `--todo-update--\n${JSON.stringify(items, null, 2)}\n--end-todo-update--`
}
```

> **改进方向（更深的做法）**：`--todo-update--` 文本 sentinel 把结构化数据塞进模型可见的自由文本、再要求模型原样搬运给 `todowrite`，仍依赖模型忠实转述（可能丢弃/改写/截断）。opencode 工具返回值已支持 `metadata` 字段（`start` action 已用 `metadata: { runId, phase, scanStatus }`），更稳的做法是**直接返回结构化 `metadata.todoUpdate`，由 harness 确定性转交 `todowrite`**，彻底跳过"模型搬运"这一层。本方案先用 sentinel（改动小、立即可用），后续可平滑迁移到 metadata。

在 `advance` 成功时，将 todo snapshot 追加到 `output` 末尾：

```typescript
// 在 return { title: `→ ${adv.run.currentPhase}`, output: ... } 中追加
const todoSnapshot = buildTodoSnapshot(adv.run, completedPhase)
output: `${endBanner}${startBanner}Agent: ${adv.nextPhase?.agentFile}\n\n${todoSnapshot}`
```

同样在 `start` action 成功时也输出初始 todo snapshot。

### 改动 2：`sql2java.md` — 添加 Todo 管理指令

在 sql2java.md 的"工作流程"部分之后添加一个新 section：

```markdown
## Todo 进度追踪（强制执行）

工作流执行期间，你必须使用 `todowrite` 工具维护任务进度，让用户在 TUI 侧边栏看到实时进度。

### 规则

1. `workflow({ action: "start" })` 成功后，**立即**调用 `todowrite`
2. 每次 `workflow({ action: "advance" })` 成功且输出中包含 `--todo-update--` 块时，**立即**用该块中的 JSON 调用 `todowrite`
3. `--todo-update--` 块格式为 `--todo-update--\n[...\n]--end-todo-update--`，提取中间的 JSON 数组直接传给 `todowrite({ todos: <提取的数组> })`
4. **不要修改** `--todo-update--` 中的内容，原样传递即可
5. `todowrite` 调用必须在下一次 `Agent` 或 `workflow` 调用之前完成

### 示例

workflow start 返回后，输出中包含：
```
--todo-update--
[
  {"content": "inventory — 源码扫描编目", "status": "in_progress", "priority": "high"},
  {"content": "analyze — 依赖分析 + 子程序结构解析", "status": "pending", "priority": "high"},
  ...
]
--end-todo-update--
```

你立即调用：
```
todowrite({ todos: <上面的 JSON 数组> })
```

### --phases 模式

`--phases` 模式下，`--todo-update--` 只包含指定阶段，无需特殊处理。

### resume 模式

resume 时同样会有 `--todo-update--`，按照相同规则处理。
```

### 改动 3：`workflow-engine.ts` — start action 输出初始 todo

在 `start` action 的成功返回中，也嵌入初始 todo snapshot：

```typescript
// start action 成功返回时
const todoSnapshot = buildTodoSnapshot(run, "")  // 无 completed phase
return {
  title: "Started",
  output: `${runId} | ${run.currentPhase} | scan: ${scanStatus}${banner}\n\n${todoSnapshot}`,
  metadata: { runId, phase: run.currentPhase, scanStatus },
}
```

### 改动 4：`workflow-engine.ts` — resume/confirm 等场景也输出 todo

在 `confirm`、`fixContinue` action 成功时，也追加 todo snapshot，确保 resume 场景下 primary agent 也能更新 todo。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `.opencode/command/sql2java.md` | 添加 "Todo 进度追踪" section（~30 行） |
| `.opencode/plugins/workflow-engine.ts` | 新增 `buildTodoSnapshot()` 辅助函数（~30 行），在 start/advance/confirm/fixContinue 输出中追加 todo snapshot |

## 不需要改动的文件

- **Agent .md 文件**（sql-analyst.md 等）— subagent 不需要 todowrite 权限
- **workflow-definitions.ts** — 阶段定义不变

## 数据流图

```
┌─────────────────────────────────────────────────────────┐
│  primary "build" agent (有 todowrite 权限)               │
│                                                         │
│  1. 读取 sql2java.md (含 todowrite 指令)                  │
│  2. 调用 workflow({ action: "start" })                    │
│     ← 返回含 --todo-update-- 的输出                      │
│  3. 调用 todowrite({ todos: [...] })  ← 机械搬运         │
│  4. 调用 Agent tool → spawn subagent                     │
│     └─ subagent 执行具体阶段任务                           │
│     └─ subagent 调用 workflow({ action: "advance" })      │
│  5. ← advance 返回含新 --todo-update-- 的输出             │
│  6. 调用 todowrite({ todos: [...] })  ← 机械搬运         │
│  7. 循环 4-6 直到工作流完成                               │
└─────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ┌──────────────┐              ┌──────────────┐
  │ workflow tool │              │ todowrite    │
  │ (TS 代码)     │              │ (opencode    │
  │ 计算 todo    │              │  内置工具)    │
  │ 快照数据      │              │ 写入 SQLite   │
  └──────────────┘              └──────┬───────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │ TUI 侧边栏   │
                                │ 渲染 todolist │
                                └──────────────┘
```

## 验证方法

1. 在 opencode 中执行 `/sql2java * <path>`
2. 观察 TUI 侧边栏是否出现 todolist
3. 检查 todolist 内容是否与 `--todo-update--` 一致
4. 随阶段推进，检查 todo 状态是否正确更新
5. 测试 `--phases` 模式，确认只显示指定阶段
6. 测试 `resume` 模式，确认 todo 状态反映已完成的阶段
