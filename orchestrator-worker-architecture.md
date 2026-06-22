# Orchestrator-Worker 架构设计方案

> sql2java-workflow 从单 Session 架构演进为分层调度架构的设计文档
>
> 版本：v3.0 | 日期：2026-06-15 | 状态：Draft

---

## 1. 问题分析

### 1.1 当前架构：单 Session 全流程

当前工作流在**一个 Claude session** 内完成所有 8+1 阶段：

```
[Session]
  inventory → analyze → plan → scaffold → translate → dedup → review → verify → done
                                                                    ↘ fix ↗
```

阶段切换通过 `system.transform` hook 动态注入对应 agent 的 prompt 实现，不 spawn 子 agent。

### 1.2 四个核心问题

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| P1 | **上下文爆炸** | 所有阶段的中间产物堆积在同一上下文窗口 | 大型代码仓（数十万行）时 LLM 幻觉率激增，任务无法继续 |
| P2 | **无法并行** | 单 session 线性执行，无依赖的包也无法同时翻译 | 处理时间随包数量线性增长，大型代码仓耗时不可接受 |
| P3 | **权限无隔离** | 单 session 共享同一工具权限集 | translate 阶段不需要 edit 权限却拥有，review 阶段不需要 write 却拥有 |
| P4 | **单点故障** | 任何阶段失败导致整个 run 失败 | 一个包的翻译失败可能阻塞全部后续流程 |

### 1.3 问题严重度与代码仓规模的关系

```
代码仓规模      当前架构可行性      核心瓶颈
─────────────────────────────────────────────────
< 5万行         ✅ 可用             上下文可控
5-20万行        ⚠️ 勉强             上下文紧张，P1 开始显现
20-50万行       ❌ 不可行           P1+P2 同时爆发
> 50万行        ❌ 完全不可行       四个问题同时恶化
```

---

## 2. 设计目标

### 2.1 核心目标

| ID | 目标 | 衡量标准 |
|----|------|----------|
| G1 | **上下文隔离** | 每个执行单元的上下文只包含当前任务所需的信息 |
| G2 | **可并行** | 无依赖的包可同时翻译/审查/验证 |
| G3 | **权限最小化** | 每个执行单元只拥有完成其任务所需的最小工具集 |
| G4 | **故障隔离** | 单个执行单元失败不阻塞其他单元，可独立重试 |
| G5 | **主 agent 不爆炸** | 编排层自身不受代码仓规模影响 |
| G6 | **兼容迁移** | 新架构可从当前架构渐进式迁移，不需要一次性重写 |

### 2.2 非目标

- **跨机器分布式**：本期仅在单机范围内并行
- **实时流式协调**：执行单元间不需要实时通信，通过 artifact 文件松耦合
- **替换 opencode 插件体系**：在现有插件机制上扩展，不重构 opencode 本身

---

## 3. 架构总览

### 3.1 核心洞察：主 agent 做编排，子 agent 做执行

opencode 原生支持 primary / subagent 模式。当前 4 个 agent 文件已声明 `mode: subagent`：
- `sql-analyst.md`（mode: subagent）
- `java-architect.md`（mode: subagent）
- `translator.md`（mode: subagent）
- `reviewer.md`（mode: subagent）

opencode 提供 `SubtaskPartInput` 机制，主 agent 通过它将子任务委托给 subagent，**子任务在独立 session 中执行，主 agent 只接收结果摘要**。这正是解决 P1（上下文爆炸）的关键。

### 3.2 三层架构

```
┌─────────────────────────────────────────────────────────────────┐
│               Primary Agent（编排者，主 session）                │
│                                                                 │
│   职责：状态机驱动 + Worker 调度 + 质量门控 + 聚合 + 异常处理     │
│   上下文：只有全局状态 + 状态矩阵 + Worker Status 摘要           │
│                                                                 │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │              SubtaskPartInput 调用                        │  │
│   │                                                          │  │
│   │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│   │   │  Subagent    │  │  Subagent    │  │  Subagent    │  │  │
│   │   │  Worker      │  │  Worker      │  │  决策点      │  │  │
│   │   │  translate   │  │  review      │  │  部分失败    │  │  │
│   │   │  PKG-A       │  │  PKG-C       │  │  是否放行    │  │  │
│   │   │  (子session) │  │  (子session) │  │  (子session) │  │  │
│   │   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │  │
│   │          │                 │                 │          │  │
│   │          ▼                 ▼                 ▼          │  │
│   │    Worker Status     Worker Status      决策结果        │  │
│   │    (摘要返回)        (摘要返回)         (摘要返回)       │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │           Artifact Contract（文件契约）                    │  │
│   │   dispatch/   │   artifacts/   │   status/   │ summaries/│  │
│   └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 核心原则

1. **主 agent 是编排者，不做具体工作** — 主 agent 通过 SubtaskPartInput 调度子任务，自身只处理状态流转和决策
2. **子 agent 是执行者，天然隔离** — 每个 subagent 在独立子 session 中执行，上下文互不干扰
3. **Artifact 是唯一契约** — 主 agent 和子 agent 之间通过文件系统松耦合
4. **包是并行单元** — 并行型 Worker 按包拆分，包之间天然独立
5. **失败是局部的** — 子 agent 失败只影响其负责的包，不影响其他包的进度
6. **主 agent 永不爆炸** — 主 agent 只持全局状态 + Worker Status 摘要，不受代码仓规模影响

### 3.4 与当前架构的对比

| 维度 | 当前（单 Session） | 新（Primary + Subagent） |
|------|-------------------|--------------------------|
| 上下文 | 全量累积 | 子 agent 隔离，主 agent 只持摘要 |
| 并行 | 不支持 | 按包并行（多个 SubtaskPartInput） |
| 权限 | 全局共享 | 子 agent 各自拥有独立的工具/权限配置 |
| 故障 | 全局失败 | 子 agent 级隔离 + 独立重试 |
| 阶段切换 | system.transform 替换 prompt | SubtaskPartInput 启动新子 session |
| Fix 循环 | 全量重做 | Per-package 增量修复 |
| 决策 | LLM 在 advance 时内联判断 | 独立决策子 agent，上下文极小 |

---

## 4. opencode Subagent 机制

### 4.1 机制概述

opencode 的 subagent 调用链路：

```
Primary Agent (主 session)
  │
  │  通过 SubtaskPartInput 发起子任务
  │  ┌─────────────────────────────────────────┐
  │  │ {                                       │
  │  │   type: "subtask",                      │
  │  │   prompt: "翻译 PKG_ORDER ...",          │
  │  │   description: "translate PKG_ORDER",   │
  │  │   agent: "translator"                   │
  │  │ }                                       │
  │  └─────────────────────────────────────────┘
  │
  ▼
Subagent Session (子 session)
  │  - 独立的上下文窗口
  │  - 使用 agent .md 文件定义的 prompt + tools + permissions
  │  - 可以调用 read/write/bash 等工具
  │  - 完成后返回结果摘要给主 agent
  │
  ▼
Primary Agent (主 session)
  │  收到子任务的输出摘要
  │  不继承子 session 的完整上下文
  │  继续下一步编排
```

### 4.2 关键 API 类型

从 opencode SDK 类型定义（`@opencode-ai/sdk`）中提取：

```typescript
// 子任务输入 — 主 agent 通过此类型发起子任务
type SubtaskPartInput = {
  type: "subtask"
  prompt: string        // 子任务的完整指令
  description: string   // 子任务描述（UI 展示用）
  agent: string         // 目标 subagent 名称
}

// Agent 配置 — 定义 subagent 的行为
type AgentConfig = {
  mode?: "subagent" | "primary" | "all"
  temperature?: number
  tools?: { [key: string]: boolean }
  permission?: {
    edit?: "ask" | "allow" | "deny"
    bash?: "ask" | "allow" | "deny" | { [key: string]: "ask" | "allow" | "deny" }
    // ...
  }
  maxSteps?: number
  description?: string
  // ...
}

// Session 关系 — 子 session 有 parentID 指向父 session
type Session = {
  id: string
  parentID?: string     // 子 session 指向主 session
  // ...
}
```

### 4.3 对 P1-P4 的解决

| 问题 | Subagent 机制如何解决 |
|------|---------------------|
| P1 上下文爆炸 | 每个 subagent 是独立子 session，上下文互不干扰。主 agent 只接收摘要 |
| P2 无法并行 | 多个 SubtaskPartInput 可同时发起，opencode 调度多个子 session 并行执行 |
| P3 权限无隔离 | 每个 subagent 有独立的 tools + permission 配置（在 agent .md 的 frontmatter 中） |
| P4 单点故障 | 子 session 失败只影响该子任务，主 agent 可独立重试或跳过 |

---

## 5. 核心概念

### 5.1 Primary Agent（编排者）

Primary Agent 是工作流的主 session，负责全局编排。它的职责：

- **状态机管理**：推进全局阶段，维护 per-package 状态矩阵
- **任务调度**：通过 SubtaskPartInput 将工作委托给 subagent
- **质量门控**：执行 L1-L3 校验（确定性代码逻辑，通过 workflow 工具实现）
- **聚合**：从 Worker Status 的 metrics 聚合阶段摘要
- **异常处理**：处理 Worker 超时/失败，决定重试或跳过

**关键约束**：Primary Agent 的上下文中**永远不包含**上游 artifact 的完整内容，只包含：
- 当前阶段名 + 全局状态
- Per-package 状态矩阵（包名 + 状态 + 关键指标）
- Worker Status 摘要（子 agent 返回的结果摘要）
- 质量门控结果

### 5.2 Worker Subagent（执行者）

Worker 是通过 SubtaskPartInput 调用的 subagent，在独立子 session 中执行。它的职责：

- **执行具体任务**：翻译一个包、审查一个包、验证一个包
- **写入 artifact**：将产出物写入约定的路径
- **汇报状态**：写入 Worker Status 文件 + 返回结果摘要

Worker 的特征：
- **上下文隔离**：独立子 session，只接收 Work Order + 必要的上游 artifact
- **权限受限**：通过 agent .md 的 tools/permission 配置独立控制
- **生命周期短**：完成即退出，子 session 不保留
- **可重试**：失败后主 agent 可独立重新调度

### 5.3 Decision Subagent（决策点）

少数场景需要 LLM 的判断力，通过专用的决策 subagent 实现：

| 决策点 | 触发条件 | 上下文 | 决策类型 |
|--------|---------|--------|---------|
| 部分失败可否放行 | 部分 Worker failed，比例在 10%-30% | 状态矩阵 + 失败摘要 | Yes/No + 理由 |
| fix 策略 | fix 循环中，某个包已 fix 2次仍未通过 | fix 历史 + 失败模式 | 继续/跳过/降级 |
| dedup 合并决策 | 多个包有相似代码 | 代码片段摘要 | 合并/保留 |

**决策 subagent 的关键优势**：
- 独立子 session，**上下文完全隔离**，不污染主 agent
- 上下文极小（通常 < 2K tokens）
- 决策结果通过子 session 返回值传回主 agent，主 agent 只看结论
- 可以配置专用的 temperature / maxSteps，不影响主流程

### 5.4 Worker 分类

| 类型 | 定义 | 阶段 | 并行性 |
|------|------|------|--------|
| **全局型 Worker** | 处理全局性任务，产出非 per-package 的 artifact | inventory, plan, scaffold, dedup | 串行 |
| **并行型 Worker** | 处理 per-package 任务，产出 per-package artifact | analyze, translate, review, verify, fix | 可并行 |

### 5.5 Artifact Contract（文件契约）

主 agent 和子 agent 之间的通信**通过文件系统**进行（补充 SubtaskPartInput 的 prompt 传递）：

```
.workflow-artifacts/{runId}/
├── run.json                         # 全局状态（主 agent 读写）
├── dispatch/                        # 主 agent → 子 agent：工作指令
│   ├── inventory.json               # 全局型：{phase}.json
│   ├── plan.json
│   ├── translate~PKG_ORDER.json     # 并行型：{phase}~{package}.json
│   └── review~PKG_ORDER.json
├── status/                          # 子 agent → 主 agent：执行状态
│   ├── inventory.json
│   ├── plan.json
│   ├── translate~PKG_ORDER.json
│   └── review~PKG_ORDER.json
├── summaries/                       # 阶段摘要（主 agent 生成，供后续子 agent 参考）
│   ├── inventory-summary.json
│   ├── analyze-summary.json
│   └── translate-summary.json
├── inventory-index.json              # 全局 artifact
├── inventory-packages/               # Per-package artifact
├── translations/                     # 子 agent 产出物
├── review-summary.json               # 最终聚合摘要
└── verify-summary.json
```

### 5.6 Work Order（工作指令）

Work Order 是 dispatch 文件的内容，通过 SubtaskPartInput 的 `prompt` 字段传递给子 agent：

```typescript
interface WorkOrder {
  orderId: string
  runId: string
  phase: string
  workerType: "global" | "parallel"
  packages: string[]
  requiredArtifacts: string[]        // 子 agent 需要读取的上游 artifact 路径
  outputArtifacts: string[]          // 子 agent 需要写入的 artifact 路径
  upstreamSummaries?: string[]       // 阶段摘要（供全局型 Worker 了解上游全貌）
  incrementalContext?: {
    targetPackages: string[]
    triggerPhase: "review" | "verify"
    failureSummary: string
  }
  execution: {
    agentFile: string                // 目标 subagent 名称（如 "translator"）
    phaseSection: string             // subagent .md 中的 Phase section 名
    temperature: number
    tools: string[]
    maxRetries: number
    timeoutMs: number
  }
}
```

### 5.7 Worker Status（执行状态）

子 agent 完成后写入的状态报告：

```typescript
interface WorkerStatus {
  orderId: string
  phase: string
  workerType: "global" | "parallel"
  packages: string[]
  status: "completed" | "failed" | "timeout"
  startedAt: string
  completedAt: string
  metrics: {
    completedSubprograms?: number
    totalSubprograms?: number
    score?: number
    passedTests?: number
    totalTests?: number
    [key: string]: number | undefined
  }
  failureReason?: string
}
```

---

## 6. 详细设计

### 6.1 阶段执行矩阵

| 阶段 | Worker 类型 | 目标 Subagent | 输入 | 输出 | 并行性 |
|------|------------|-------------|------|------|--------|
| inventory | 全局型 | sql-analyst | sourcePath | inventory-index.json, inventory-packages/*.json | 串行（内部分批） |
| analyze | 并行型 | sql-analyst | inventory-packages/{PKG} | analysis-packages/{PKG}, fsd/{PKG} | 按包并行 |
| plan | 全局型 | java-architect | inventory-summary + analyze-summary | plan.json | 串行 |
| scaffold | 全局型 | java-architect | plan.json | scaffold.json + generated/ | 串行 |
| translate | 并行型 | translator | inventory-packages/{PKG}, analysis-packages/{PKG}, plan.json, scaffold.json, fsd/{PKG} | translations/{PKG} | 按包并行（拓扑排序） |
| dedup | 全局型 | java-architect | translate-summary + translations/ | dedup.json | 串行 |
| review | 并行型 | reviewer | translations/{PKG}, plan.json | translations/{PKG}/review.json | 按包并行 |
| verify | 并行型 | reviewer | translations/{PKG}, scaffold.json | translations/{PKG}/verify.json | 按包并行 |
| fix | 并行型 | translator | translations/{PKG}, review/verify 结果 | translations/{PKG} (修改) | 按失败包并行 |

### 6.2 主 Agent 编排循环

主 agent 是工作流的驱动核心。它通过调用 `workflow` 工具获取状态，通过 `SubtaskPartInput` 调度子任务：

```
Primary Agent 主循环
│
├── 1. 读 run.json → 确定当前阶段
│
├── 2. 判断阶段类型
│   ├── 全局型 → 创建 1 个 Work Order
│   └── 并行型 → 计算拓扑排序 → 创建 N 个 Work Order
│
├── 3. 调度子 agent
│   ├── 写入 dispatch/ 文件
│   ├── 通过 SubtaskPartInput 调用目标 subagent
│   │   { type: "subtask", agent: "translator",
│   │     prompt: "<Work Order 内容>", description: "translate PKG_A" }
│   └── 等待子 agent 完成（子 session 执行，主 agent 接收结果摘要）
│
├── 4. 收集 Worker Status → 更新状态矩阵
│   ├── 子 agent 完成后写入 status/ 文件
│   └── 主 agent 读取 status/ 更新状态矩阵
│
├── 5. 执行质量门控（L1-L3，确定性代码）
│   ├── 全部通过 → 推进到下一阶段
│   ├── 部分 failed → 判断是否需要决策子 agent
│   │   ├── 需要决策 → SubtaskPartInput 调用决策 subagent
│   │   └── 不需要 → 直接进入 fix 循环
│   └── 全部 failed → completed_with_issues
│
└── 6. 回到 1
```

### 6.3 Per-Package 状态矩阵

主 agent 维护一个 per-package 的状态矩阵：

```typescript
interface PackagePhaseState {
  package: string
  phase: string
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped"
  workerOrderId?: string
  retryCount: number
  lastAttemptAt?: string
  failureReason?: string
}

// 示例：translate 阶段的状态矩阵（200 个包中）
// ┌──────────┬───────────┬────────────┐
// │ Package  │ Status    │ Retries    │
// ├──────────┼───────────┼────────────┤
// │ PKG_001  │ completed │ 0          │  ← 150 个已完成
// │ PKG_002  │ failed    │ 2          │  ← 5 个失败
// │ PKG_003  │ in_progress│ 0         │  ← 3 个进行中
// │ PKG_004  │ pending   │ 0          │  ← 42 个待处理
// └──────────┴───────────┴────────────┘
```

状态矩阵在主 agent 上下文中只占极小空间：每行 ~30 tokens，200 个包 ~6K tokens，远小于上下文窗口。

### 6.4 子 Agent 生命周期

```
              Primary Agent                    Worker Subagent (子 session)
                 │                                │
  1. 创建 Work Order │                            │
    写入 dispatch/    │                            │
                 │                                │
  2. 调度子 agent    │                            │
    SubtaskPartInput │                            │
    ─────────────────────────────────────────────▶│
                 │                                │
                 │              3. 读取 Work Order │
                 │              4. 读取上游 artifact
                 │              5. 执行任务        │
                 │              6. 写入产出物      │
                 │              7. 写入 Worker Status
                 │                                │
  8. 接收子 session 结果摘要                       │
    ◀─────────────────────────────────────────────│
                 │                                │
  9. 读 status/ 更新状态矩阵                      │
  10. 质量门控 + 决定下一步                       │
                 │                                │
```

**关键**：步骤 8 中主 agent 只接收子 session 的**结果摘要**（通过 SubtaskPartInput 的返回机制），不继承子 session 的完整上下文。

### 6.5 并行执行模型

#### 6.5.1 执行策略

```typescript
type ExecutionStrategy =
  | { mode: "sequential" }                           // 逐个调度子 agent
  | { mode: "parallel"; maxConcurrency: number }     // 并行调度多个子 agent
  | { mode: "batch"; batchSize: number }             // 分批调度
```

| 阶段 | Worker 类型 | 默认策略 | 理由 |
|------|------------|---------|------|
| inventory | 全局型 | sequential | 全局型只有 1 个 Worker |
| analyze | 并行型 | batch(3) | 包间有弱依赖（callGraph），分批可减少后续批次的上下文 |
| plan | 全局型 | sequential | 全局型 |
| scaffold | 全局型 | sequential | 全局型 |
| translate | 并行型 | parallel(maxConcurrency) | 包间独立，最大化并行 |
| dedup | 全局型 | sequential | 全局型 |
| review | 并行型 | parallel(maxConcurrency) | 包间独立 |
| verify | 并行型 | parallel(maxConcurrency) | 包间独立 |
| fix | 并行型 | parallel(maxConcurrency) | 只修复失败包 |

#### 6.5.2 翻译拓扑排序

translate 阶段需要尊重包间的调用依赖：

```
层级 0（无依赖）：PKG_UTIL, PKG_CONST
层级 1（依赖层级0）：PKG_ORDER（依赖 PKG_UTIL）
层级 2（依赖层级1）：PKG_REPORT（依赖 PKG_ORDER）

执行：层级0 并行 → 全部完成 → 层级1 并行 → ...
```

拓扑排序由主 agent 通过确定性代码计算（从 inventory-index.json 的 callGraph → Kahn 算法），有环依赖的包降级为串行。

#### 6.5.3 并行度控制

```typescript
interface ParallelConfig {
  maxConcurrency: number        // 默认：min(cpuCores - 2, 8)
  workerTimeoutMs: number       // 默认：600_000 (10min)
  retryDelayMs: number          // 默认：5_000
}
```

### 6.6 容错与重试

#### 6.6.1 Worker 级重试

```
Worker 子 agent 失败
  │
  ├── retryCount < maxRetries?
  │   ├── Yes → 重新调度该子 agent（新 SubtaskPartInput，相同 package）
  │   │         retryCount++
  │   └── No  → 标记该 package 为 "failed"
  │             检查 exhausted 上限
  │
  └── Worker 超时?
      └── 主 agent 中止子 session → 视为失败 → 走上述重试逻辑
```

**子 agent 失败不影响主 agent**：主 agent 的上下文中没有子 session 的推理过程，只有失败状态。重试时启动新的子 session，干净无残留。

#### 6.6.2 阶段级容错

```
可并行阶段完成
  │
  ├── 全部 completed → advance
  ├── 部分 failed
  │   ├── failed < 10% → 自动 advance（带 warning）
  │   ├── 10% ≤ failed < 30% → 调用决策 subagent
  │   └── failed ≥ 30% → 进入 fix 循环
  └── 全部 failed → completed_with_issues
```

#### 6.6.3 决策 Subagent 的调用

当需要 LLM 判断时，主 agent 通过 SubtaskPartInput 调用决策 subagent：

```typescript
// 主 agent 发起的决策子任务
{
  type: "subtask",
  agent: "reviewer",   // 或专用决策 agent
  prompt: `你是工作流决策助手。当前情况：

  translate 阶段完成，200 个包中 25 个失败。
  失败原因分类：18个超时，7个翻译质量不达标。
  质量门控 G1：完成率 87.5%（阈值 80%）✅

  是否允许跳过失败包继续推进？请回答 YES 或 NO，并说明理由。`,
  description: "决策：部分失败是否放行"
}
```

决策 subagent 在独立子 session 中执行，**完全不污染主 agent 的上下文**。主 agent 只收到 "YES，理由：..." 的简要结果。

### 6.7 权限隔离

每个 subagent 通过 agent .md 的 frontmatter 拥有独立的权限配置：

| 阶段 | 目标 Subagent | tools | 读取范围 | 写入范围 |
|------|-------------|-------|---------|---------|
| inventory | sql-analyst | read, bash, write | sourcePath | inventory-packages/ |
| analyze | sql-analyst | read, bash, write | inventory-packages/{target} | analysis-packages/{target}, fsd/{target} |
| plan | java-architect | read, bash, write, edit | summaries/ | plan.json |
| translate | translator | read, bash, write, edit | inventory-packages/{target}, analysis-packages/{target}, plan.json, scaffold.json, fsd/{target} | translations/{target} |
| review | reviewer | read, bash, write | analysis-packages/{target}, translations/{target}, plan.json | translations/{target}/review.json |
| verify | reviewer | read, bash, write | translations/{target}, scaffold.json | translations/{target}/verify.json |
| fix | translator | read, bash, write, edit | analysis-packages/{target}, translations/{target}, review/verify 结果 | translations/{target} |
| 决策 | reviewer | read | status/ | — |

**与当前架构的关键区别**：当前架构中权限通过 `system.transform` hook 在同一 session 内切换，本质上还是共享的。新架构中每个 subagent 是独立 session，权限天然隔离。

---

## 7. 上下文管理

### 7.1 各角色的上下文预算

| 角色 | 上下文来源 | 规模估算（200包代码仓） | 是否可控 |
|------|-----------|----------------------|---------|
| 主 agent | 状态矩阵 + Worker Status 摘要 + 质量门控结果 | < 10K tokens | ✅ |
| 全局型 Worker | Work Order + 阶段摘要 + 必要的完整 artifact | 5-30K tokens | ⚠️ 见 7.3 |
| 并行型 Worker | Work Order + 目标包的上游 artifact | 5-20K tokens | ✅ |
| 决策 Worker | 状态矩阵 + 失败摘要 | < 2K tokens | ✅ |

### 7.2 主 Agent 上下文详细分析

主 agent 的上下文由以下部分组成：

```
┌─ Primary Agent Context ────────────────────────┐
│                                                 │
│ 1. System Prompt（静态，来自主 agent 定义）       │
│    └─ 编排规则 + workflow 工具使用指南           │
│    ~2K tokens                                   │
│                                                 │
│ 2. Runtime Context（动态，每次调度时刷新）        │
│    ├─ 当前阶段名 + runId + sourcePath           │
│    ├─ Per-package 状态矩阵                      │
│    │  └─ 200 packages × ~30 tokens = 6K tokens │
│    ├─ 质量门控结果                               │
│    │  └─ ~200 tokens                            │
│    └─ Fix 追踪                                  │
│       └─ ~100 tokens                            │
│    ~7K tokens                                   │
│                                                 │
│ 3. Worker Status 摘要（子 agent 返回）           │
│    └─ 每个子 agent 只返回结果摘要，非完整输出     │
│    └─ ~1K tokens / subagent                     │
│    └─ 200 个包 × 1K = 200K tokens？ ❌          │
│                                                 │
└─────────────────────────────────────────────────┘
```

**问题**：如果 200 个子 agent 各返回 1K tokens 的摘要，主 agent 仍会爆炸。

**解决**：主 agent 不保留每个子 agent 的返回摘要，而是：
1. 子 agent 完成后写入 `status/{phase}~{package}.json`
2. 主 agent 读取 status 文件，更新状态矩阵（只提取 status + metrics 字段）
3. 子 agent 的返回摘要通过 `tool.execute.after` hook 截断

这样，主 agent 的上下文中只有**状态矩阵**（紧凑的表格数据），而非每个子 agent 的完整输出。

### 7.3 全局型 Worker 的上下文保护

全局型 Worker 是最有可能爆炸的环节。三层保护：

**第一层：摘要优先**

```
plan Worker 的输入（使用摘要）：
  analyze-summary.json     (~2K tokens)  ← 替代 200 个 analysis-packages/*.json (~500K tokens)
  inventory-summary.json   (~1K tokens)  ← 替代 200 个 inventory-packages/*.json (~200K tokens)
  plan.json schema 提示    (~1K tokens)
  ──────────────────────────
  总计：~4K tokens ✅
```

**第二层：按需回查**

plan Worker 如果需要对某个包的详细分析做决策，可以**按需读取**该包的完整 analysis-package：

```
prompt 中的指令：
  "先读 analyze-summary.json 了解全局，如果某个包的架构决策需要更多细节，
   再读取 analysis-packages/{PKG_NAME}.json 获取详细信息"
```

**第三层：分批处理**

如果即使摘要也很大（如 500+ 包），plan Worker 可以分批：

```
plan Worker（分批模式）：
  批次1：读 PKG_001 ~ PKG_100 的摘要 → 产出 plan-part1.json
  批次2：读 PKG_101 ~ PKG_200 的摘要 → 产出 plan-part2.json
  ...
  主 agent 合并所有 part → plan.json
```

### 7.4 并行型 Worker 的上下文

并行型 Worker 天然隔离，只看目标包的输入：

```
translate Worker (PKG_ORDER) 的输入：
  inventory-packages/PKG_ORDER.json     (~5K tokens)
  analysis-packages/PKG_ORDER.json      (~10K tokens)
  plan.json (只读 PKG_ORDER 的映射)     (~1K tokens)
  scaffold.json (只读目录结构)           (~1K tokens)
  fsd/PKG_ORDER/*.md                    (~3K tokens)
  ────────────────────────────────────────
  总计：~20K tokens ✅
```

### 7.5 大包拆分

对于单个超大包（>50 子程序或 >5000 行），Worker 上下文仍可能溢出：

```
PKG_HUGE (8000行, 60个子程序)
  │
  ├── Worker-1: PKG_HUGE.subset-A (前30个子程序)
  ├── Worker-2: PKG_HUGE.subset-B (后30个子程序)
  └── Worker-merge: 合并 subset-A + subset-B → PKG_HUGE 完整翻译
```

### 7.6 摘要协议

每个阶段完成后，主 agent 聚合 Worker Status 生成**摘要**，供后续 Worker 参考：

```typescript
interface PhaseSummary {
  phase: string
  totalPackages: number
  packages: Array<{
    name: string
    status: "completed" | "failed" | "skipped"
    keyMetrics: Record<string, number>
  }>
  globalMetrics: Record<string, number>
  warnings: string[]
}
```

---

## 8. 状态机演进

### 8.1 当前状态机

```
inventory → analyze → plan → scaffold → translate → dedup → review → verify → done
                                                              ↘      ↗
                                                                fix
```

### 8.2 新状态机

```
inventory → analyze → plan → scaffold → translate → dedup → review → verify → done
   │           │         │       │          │          │        │        │
   ▼           ▼         ▼       ▼          ▼          ▼        ▼        ▼
 [全局W]   [并行W]  [全局W]  [全局W]    [并行W]    [全局W]  [并行W]  [并行W]
  sql-       sql-    java-   java-     translator  java-   reviewer reviewer
  analyst   analyst  architect architect            architect
                                                  ↘      ↗
                                                    fix
                                                  [并行W]
                                                 translator
```

每个阶段都是通过 SubtaskPartInput 调度的 Worker subagent。

### 8.3 run.json 扩展

```typescript
interface WorkflowRun {
  runId: string
  definitionId: string
  currentPhase: string | null
  status: "running" | "paused" | "completed" | "completed_with_issues" | "aborted"
  phaseHistory: PhaseHistoryEntry[]
  // ── 新增 ──
  packageStates: Record<string, Record<string, PackagePhaseState>>
  workerLog: WorkerLogEntry[]
  fixTracking: FixTracking
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

interface PackagePhaseState {
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped"
  workerOrderId?: string
  retryCount: number
  lastAttemptAt?: string
  failureReason?: string
}

interface WorkerLogEntry {
  orderId: string
  phase: string
  workerType: "global" | "parallel"
  packages: string[]
  status: "dispatched" | "running" | "completed" | "failed" | "timeout"
  startedAt: string
  completedAt?: string
  metrics?: Record<string, number>
}

interface FixTracking {
  globalCount: number
  byPhase: Record<string, number>
  byPackage: Record<string, number>
}
```

### 8.4 advance 语义变化

当前：LLM 主动调用 `workflow({ action: "advance" })` 推进阶段

新架构：主 agent 通过 workflow 工具读取状态，根据子 agent 返回的结果**自动判断**是否推进

```typescript
// 层1：Worker 完成 → 主 agent 读取 status/ → 更新状态矩阵
// 层2：所有 Worker 完成 → 主 agent 执行质量门控 → 判断是否 advance
// 层3：需要决策 → 调用决策 subagent → 根据决策结果执行
```

---

## 9. Fix 循环重设计

### 9.1 Per-Package Fix

```
review 阶段（Workers 并行）
  ├── PKG_A: passed ✅
  ├── PKG_B: failed ❌
  └── PKG_C: passed ✅

主 agent 判断：1/3 failed (33%) → 进入 fix 循环

fix 阶段
  └── 只调度 PKG_B 的 Fix Worker（新子 session）

re-review 阶段
  └── 只 re-review PKG_B（PKG_A/C 的 review 结果保留）

verify 阶段
  └── PKG_A, PKG_B, PKG_C 全部 verify（verify 是确定性的，成本低）
```

### 9.2 Fix 追踪

```typescript
fixTracking: {
  globalCount: 5,
  byPhase: { review: 3, verify: 2 },
  byPackage: {
    PKG_B: 2,               // PKG_B 已 fix 2 次
    PKG_C: 1,               // PKG_C 已 fix 1 次
  }
}
```

**三层耗尽**：
- 全局：`globalCount >= globalMax`（默认 5）
- Per-phase：`byPhase[triggerPhase] >= phaseMax`（默认 5）
- Per-package：`byPackage[pkgName] >= packageFixMax`（默认 3，**新增**）
- 任一达限 → 该维度不再 fix

### 9.3 Fix Worker 的上下文优势

当前架构中，fix 阶段需要保留全量上下文（之前所有推理 + 审查结果），上下文非常臃肿。

新架构中，Fix Worker 是独立的子 session，只包含：
- 目标包的 translation artifact
- 审查/验证失败摘要
- 目标包的上游 artifact

**上下文从"全量累积"变为"只看失败包"**，干净且聚焦。

---

## 10. 聚合与质量门控

### 10.1 聚合策略

主 agent 从 Worker Status 聚合阶段摘要：

```typescript
function aggregateSummary(
  phase: string,
  workerStatuses: WorkerStatus[]
): PhaseSummary & QualityGateResult {
  const completed = workerStatuses.filter(s => s.status === "completed")
  const totalSubprograms = completed.reduce((s, w) => s + (w.metrics.totalSubprograms ?? 0), 0)
  const completedSubprograms = completed.reduce((s, w) => s + (w.metrics.completedSubprograms ?? 0), 0)
  const completionRatio = totalSubprograms > 0 ? completedSubprograms / totalSubprograms : 0

  return {
    phase,
    totalPackages: workerStatuses.length,
    completedPackages: completed.length,
    failedPackages: workerStatuses.length - completed.length,
    packages: workerStatuses.map(w => ({
      name: w.packages[0],
      status: w.status === "completed" ? "completed" : "failed",
      keyMetrics: w.metrics,
    })),
    globalMetrics: { completionRatio },
    qualityGates: {
      G1: { passed: completionRatio >= 0.8, value: completionRatio },
    },
    warnings: [],
  }
}
```

### 10.2 质量门控适配

| 门控 | 当前数据来源 | 新数据来源 |
|------|------------|-----------|
| L1 (rejection) | advance 时检查 artifact | Worker Status + artifact 抽检 |
| L2 (cross-schema) | loadArtifactJson 读完整 artifact | Worker Status + 摘要 |
| L3 (quality gates) | loadArtifactJson 逐包读取 | Worker Status.metrics（零读取） |

**关键优化**：L3 门控完全基于 Worker Status 的 metrics，主 agent **不需要读取任何 artifact 文件**。

---

## 11. 主 Agent 与子 Agent 的协同

### 11.1 协同方式总览

```
            Primary Agent (主 session)              Worker Subagent (子 session)
                 │                                        │
  ┌──────────────┼────────────────────────────────────────┼───────────────┐
  │              │                                        │               │
  │  1. 写 dispatch/ 文件                                 │               │
  │  ───────────▶│                                        │               │
  │              │                                        │               │
  │  2. 通过 SubtaskPartInput 调度子 agent                │               │
  │  ────────────────────────────────────────────────────▶│               │
  │              │                                        │               │
  │              │                    3. 读 Work Order     │               │
  │              │                    4. 读上游 artifact    │               │
  │              │                    5. 执行任务           │               │
  │              │                    6. 写产出物           │               │
  │              │                    7. 写 Worker Status   │               │
  │              │                                        │               │
  │  8. 接收子 session 结果摘要                            │               │
  │  ◀────────────────────────────────────────────────────│               │
  │              │                                        │               │
  │  9. 读 status/ 更新状态矩阵                           │               │
  │  10. 质量门控                                         │               │
  │  11. 决定下一步                                       │               │
  │              │                                        │               │
  │  如果需要决策：                                       │               │
  │  通过 SubtaskPartInput 调用决策 subagent              │               │
  │  ────────────────────────────────────────────────────▶│ (决策子session)│
  │  ◀────────────────────────────────────────────────────│               │
  │  执行决策    │                                        │               │
  │              │                                        │               │
  └──────────────┼────────────────────────────────────────┼───────────────┘
```

### 11.2 主 Agent 为什么不会爆炸

| 主 agent 的工作 | 上下文来源 | 上下文增量 |
|----------------|-----------|-----------|
| 读写 run.json | workflow 工具返回 | ~500 tokens |
| 创建 Work Order | 代码逻辑 | ~200 tokens |
| 调度子 agent | SubtaskPartInput 发出 | ~300 tokens |
| 接收子 agent 结果 | 子 session 返回摘要 | ~500-1000 tokens |
| 更新状态矩阵 | 内部数据结构 | ~0（原地更新） |
| 质量门控 | workflow 工具返回 | ~200 tokens |
| 决策 subagent | 子 session 返回决策 | ~200 tokens |

**每个 Worker 的上下文增量**：~1-2K tokens（调度 + 结果摘要）

**200 个包的全流程**：~200-400K tokens？❌ 仍然可能爆炸

### 11.3 主 Agent 的上下文压实

关键机制：**主 agent 不累积每个 Worker 的返回摘要**。

```
错误做法（累积）：
  [Worker-1 摘要] + [Worker-2 摘要] + ... + [Worker-200 摘要]
  → 200 × 1K = 200K tokens ❌

正确做法（压实）：
  Worker 完成 → 读取 status/ → 更新状态矩阵 → 丢弃摘要
  主 agent 上下文始终只有：状态矩阵 + 最近一次操作的上下文
  → ~10K tokens ✅
```

实现方式：
1. Worker 完成后，主 agent 通过 `workflow({ action: "complete" })` 工具汇报完成
2. workflow 工具内部读取 status/ 文件，返回紧凑的状态矩阵更新（而非完整摘要）
3. 主 agent 只看到"PKG_A: completed, 25/25 subprograms"，而非翻译细节

这需要 `workflow` 工具的 `complete` action 做数据压实——只返回状态矩阵的增量更新。

---

## 12. 迁移策略

### 12.1 渐进式迁移路线

```
Phase 1: SubtaskPartInput 调度 + 上下文隔离（解决 P1+P3+P4）
  ├── 引入 WorkOrder / WorkerStatus 类型
  ├── 主 agent 通过 SubtaskPartInput 调度 Worker
  ├── 所有阶段改为 Worker 模式（先顺序执行，但上下文隔离）
  ├── 引入 per-package 状态矩阵
  ├── 质量门控改为读 Worker Status
  ├── workflow 工具新增 complete action（含数据压实）
  └── 去除 system.transform 的 prompt 替换逻辑

Phase 2: Per-Package Fix 循环（优化 fix 效率）
  ├── 引入 byPackage fix 追踪
  ├── fix 阶段改为只调度失败包的 Worker
  └── 决策 subagent 机制

Phase 3: 并行执行（解决 P2）
  ├── Worker 调度器（支持 sequential/parallel/batch）
  ├── 翻译拓扑排序
  └── Worker 超时处理

Phase 4: 摘要协议 + 全局型 Worker 优化
  ├── 主 agent 自动聚合阶段摘要
  ├── plan Worker 改为读摘要
  ├── dedup Worker 改为读摘要
  └── 按需回查机制

Phase 5: 大包拆分 + 高级特性
  ├── 超大包子程序级拆分
  ├── 跨包翻译风格一致性（Work Order 注入风格参考）
  └── per-run token budget
```

### 12.2 Phase 1 最小改动清单

1. **新增主 agent 定义**（`.opencode/agent/orchestrator.md`）：
   - `mode: primary`
   - `tools: { read: true, bash: true, write: true, workflow: true }`
   - prompt：编排规则 + 状态矩阵管理 + SubtaskPartInput 调度规则

2. **engine-core.ts**：
   - 新增 `PackagePhaseState`, `WorkerLogEntry` 类型
   - `WorkflowRun` 增加 `packageStates`, `workerLog` 字段
   - 新增 `onWorkerComplete()` 自动流转逻辑

3. **workflow-engine.ts (plugin)**：
   - 新增 `workflow({ action: "complete" })` action：Worker 汇报完成 + 数据压实
   - `tool.execute.after` hook：处理 `Agent` / `Task` 工具返回的子 agent 结果
   - 去除 `system.transform` 的 prompt 替换逻辑（改由 SubtaskPartInput 驱动）

4. **workflow-definitions.ts**：
   - `PhaseConfig` 增加 `workerType: "global" | "parallel"` 字段

5. **agent .md 文件**：
   - 微调：改为"只处理 Work Order 中指定的包"
   - 保持 `mode: subagent` 不变

6. **命令入口**（`.opencode/command/sql2java.md`）：
   - 改为使用 `orchestrator` 主 agent

### 12.3 兼容性保证

- **向后兼容**：旧版 run.json 可被新版引擎加载（`packageStates` 缺失时从 `phaseHistory` 推导）
- **API 兼容**：`workflow({ action: "advance" })` 仍可用（内部转为 `complete` + 自动判断）
- **行为兼容**：小代码仓（< 5万行）的行为与当前一致，只是上下文更干净
- **Agent 兼容**：现有 4 个 subagent .md 文件只需微调 prompt，不改 mode/tools/permissions

---

## 13. 权衡与开放问题

### 13.1 已知权衡

| 权衡 | 选择 | 代价 |
|------|------|------|
| 隔离 vs 延续 | Per-Worker 子 session 隔离 | Worker 看不到其他包的翻译（可能风格不一致） |
| 摘要 vs 完整 | 摘要优先 | 全局型 Worker 可能遗漏细节（但可按需回查） |
| 顺序 vs 并行 | 先顺序后并行 | Phase 1-2 无并行收益 |
| 子 session vs 内执行 | SubtaskPartInput | 每次子 session 启动有冷启动开销（~1-2s） |

### 13.2 开放问题

1. **子 agent 结果摘要的粒度**：SubtaskPartInput 返回给主 agent 的摘要是多大？需要实测确认。如果太大，需要通过 `tool.execute.after` hook 截断。
   - **可能方案**：在 agent .md 的 prompt 中要求"最后输出 Worker Status JSON，其余内容不返回"

2. **并行 SubtaskPartInput 的行为**：主 agent 同时发起多个 SubtaskPartInput 时，opencode 是否真的并行执行？还是串行排队？需要实测。
   - **可能方案**：如不支持并行，可通过 `opencode run` CLI 补充（Phase 5+）

3. **子 session 的工具可用性**：subagent 是否可以使用 `workflow` 工具？如果不能，子 agent 如何汇报完成？
   - **可能方案**：子 agent 通过 `write` 工具写入 status/ 文件，主 agent 通过 `workflow({ action: "complete" })` 触发后续逻辑

4. **跨包翻译一致性**：不同 Worker 可能翻译出不同风格的 Java 代码
   - **可能方案**：在 Work Order 的 prompt 中注入"风格参考"——已完成包的翻译摘要

5. **全局型 Worker 的上下文上限**：即使有摘要协议，500+ 包的 plan 阶段仍可能紧张
   - **可能方案**：plan 也按包组拆分，再合并

6. **成本控制**：每个 Worker 是独立的子 session，各自的 system prompt 需要独立注入
   - **可能方案**：子 agent 的 system prompt 尽量精简（只含 agent .md 的 common + phase section）

---

## 附录 A：v1.0 → v2.0 → v3.0 变更摘要

| 维度 | v1.0 | v2.0 | v3.0 |
|------|------|------|------|
| Supervisor 本质 | 长驻 LLM session | 确定性引擎 + LLM 决策点 | **Primary Agent + SubtaskPartInput** |
| Worker 执行方式 | 内执行/CLI 子进程 | 内执行/CLI 子进程 | **SubtaskPartInput → subagent 子 session** |
| 决策点 | 不涉及 | LLM 决策点（未明确实现） | **决策 subagent，独立子 session** |
| 隔离机制 | prompt 替换（同 session） | prompt 替换 + CLI（混合） | **子 session 天然隔离** |
| 并行机制 | 不支持 | CLI 子进程并行 | **SubtaskPartInput 并行（待实测）** |
| 权限隔离 | 无 | 路径白名单 | **subagent 独立 tools/permission** |
| 主 session 爆炸风险 | ❌ 有 | ⚠️ 减缓但未根治 | ✅ 数据压实 + 摘要返回 |

## 附录 B：术语表

| 术语 | 定义 |
|------|------|
| Primary Agent | 主 agent，负责编排调度，通过 SubtaskPartInput 调用子 agent |
| Worker Subagent | 执行具体任务的子 agent，在独立子 session 中运行 |
| Decision Subagent | 执行判断性决策的子 agent，上下文极小，独立子 session |
| SubtaskPartInput | opencode 原生的子任务调用机制，主 agent 通过它委托子任务 |
| Work Order | 主 agent → 子 agent 的工作指令（dispatch/ 文件 + SubtaskPartInput prompt） |
| Worker Status | 子 agent → 主 agent 的执行状态报告（status/ 文件） |
| 摘要协议 | 主 agent 聚合的精简摘要，供后续子 agent 参考 |
| 状态矩阵 | 所有包在当前阶段的状态汇总（主 agent 上下文中的紧凑数据结构） |
| 数据压实 | 子 agent 结果摘要经 workflow 工具压缩为状态矩阵增量，避免主 agent 上下文累积 |

## 附录 C：配置参考

```typescript
export const SQL2JAVA_WORKER_CONFIG = {
  execution: {
    defaultStrategy: "sequential" as const,
    maxConcurrency: 4,
    workerTimeoutMs: 600_000,
    retryDelayMs: 5_000,
  },
  fix: {
    globalMax: 5,
    phaseMax: 5,
    packageFixMax: 3,
  },
  split: {
    subprogramThreshold: 50,
    linesThreshold: 5000,
  },
  qualityGates: {
    completionRatio: 0.8,
    reviewPassScore: 70,
    testPassRatio: 0.7,
  },
  decisionPoints: {
    failedRatioLow: 0.1,
    failedRatioHigh: 0.3,
  },
  compaction: {
    // 数据压实：workflow complete action 返回给主 agent 的最大摘要大小
    maxSummaryTokens: 500,
  },
}
```
