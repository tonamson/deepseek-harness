---
description: "从版本 1 的 orc 事件重放持久的 Supervisor、Lead 与 Peer 工作流。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-orc

[English](README.md) | 中文

## 概述

`dsh-experimental-orc` 把一个 Supervisor 会话中的 `orc/*` 事件投影为角色树、任务阶段、Codex 委托与发现项，从而无需阅读子会话记录即可恢复工作流。`OrcService` 追加这些事件，并启动相互关联的 DeepSeek 与 Codex 子运行。折叠仍是转移是否合法的权威。本包不注册工具。它是实验性的，没有稳定性承诺。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

对版本 1 事件调用 `projectOrc` 或 `applyOrc`。`emptyOrcState` 是 `orc/workflow/created` 之前的状态。被拒绝的事件设置 `failure`，并保持其余字段不变。`OrcService` 在追加前询问该折叠，然后用 `ctx.subagents.startContinuable` 启动可继续的 DeepSeek 子运行，或用 `ctx.subagents.start` 启动 Codex 一次性运行。Codex 启动不传 `outputSchema` 与 `maxDepth`。provider、model 与 effort 来自已校验配置。角色是 `supervisor`、`lead` 与 `peer`。合法边只有 Supervisor 到 Lead，以及 Lead 到 Peer。Peer 不能创建子节点。Codex 不是角色节点；spec、plan、review 与 audit 是带关联 id 的委托。

工作流阶段为 `brainstorming`、`spec_required`、`plan_required`、`awaiting_user_approval`、`task_implementation`、`task_peer_settlement`、`task_review`、`task_audit`、`task_fix`、`next_task`、`final_review`、`complete` 与 `failed`。计划批准只来自 source 为 `plan/review` 的 `orc/plan/approval`。阻断严重级别来自 `orc/workflow/created`。载荷必须包含 `critical`、`high` 与 `medium`；一次运行还可以列入 `low` 或 `info`。非 `ok` 的 review 或 audit 结果阻止推进。当前迭代上的阻断发现项必须先进入 `task_fix`，然后才能进入 `next_task` 或 `final_review`。解决发现项不会清除该委托上的阻断标记。

每个 `orc/phase`、`orc/run/completed` 与 `orc/run/failed` 事件都写出 `actorNodeId`。缺少行动者会被拒绝，Peer 不能推进工作流。Lead 只能走任务内的边：实现、Peer 结算、review、audit 与修复。任务排序、最终审查与终态完成只属于 Supervisor。阻断性的分支发现项写出其任务 id。Supervisor 把该任务移回 `task_fix`，并在回到 review 之前由 `orc/fix/iteration` 记录下一次迭代。一次 `final_review` 只接受一对分支 review 与 audit；仅当最近一次结果为 failed、malformed 或 unavailable 时才允许重试。修复循环返回之后的下一次访问只按那一对新结果判断。缺失或畸形的分支结果仍然阻止完成，并且不算干净。`low` 与 `info` 发现项不阻断，除非该次运行把它们列入 `blockingSeverities`。

事件名与载荷版本保持为版本 1。本包不迁移、改写或删除已发布的会话数据，也不导入 `team/*` 事件。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 品牌化 id、阶段与版本 1 载荷 |
| [`src/projection.ts`](src/projection.ts) | Zod 载荷、`applyOrc` 与 `projectOrc` |
| [`src/invariant.ts`](src/invariant.ts) | 在追加前拒绝非法 `orc/*` 候选事件的伴随模块 |
| [`src/index.ts`](src/index.ts) | 公开的折叠导出与 `OrcService` |

`OrcState.failure` 是拒绝原因。`blockingSeverities` 是该次运行的阈值。节点保存角色提示、技能包络、写入范围、验收标准与报告格式。委托保存 Codex 信封与报告状态。`blocksProgress` 在记录结果时固定。

`./invariant` 伴随模块监听 `session/event`，并忽略 `orc/*` 以外的每个类型。它折叠已提交前缀，应用候选事件，并在投影拒绝时报告失败。检查发生在事件被追加之前。

`OrcService` 注入 agents、sessions、session persistence、session projections 与 subagents。它注册 `orc` 投影并读回该投影。只有当日志行匹配 correlation、stage、role 与 task 时，结果才会被追加。工具与已发布的会话事件表留在本包之外。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [实验性包](../README.zh.md) — 发布与依赖隔离。
- [ORC 设计](../../../docs/superpowers/specs/2026-09-22-orc-superpowers-orchestration-design.md) — 必需的生命周期、角色与失败行为。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 OrcService 启动的可继续 DeepSeek 子代理与一次性 Codex 运行；这些提供方负责组装模型请求。

#### KV Cache 影响

ORC 事件不进入 Supervisor 的派生历史。每个子提示属于独立会话，因此记录委托不会增长 Supervisor 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只从活会话恢复** — `orc/*` 不属于已发布的 `SessionEventMap`。活会话接受这些事件。本构建的持久化读取会拒绝它们，因为它们没有标成 ignorable，所以恢复使用活的 Supervisor 日志，而不是冷启动重开。
- **同一父节点、角色与任务只保留一个未完成子节点** — 该子节点仍打开时，`spawn` 返回它，而不会为同一任务再创建一个 Peer。
- **每次重开一个任务** — 一次前往 `task_fix` 的 `orc/phase` 只重开被点名的任务。`orc/fix/iteration` 在回到 review 之前记录这次修复。完成要等待下一次 `final_review` 访问中干净的分支一对结果。
- **阈值下限** — 一次运行可以把 `low` 或 `info` 加入阻断集合，但不能省略 `critical`、`high` 或 `medium`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
