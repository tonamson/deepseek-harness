---
description: "从版本 1 的 orc 事件重放持久的 Supervisor、Lead 与 Peer 工作流。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-orc

[English](README.md) | 中文

## 概述

`dsh-experimental-orc` 把一个 Supervisor 会话中的 `orc/*` 事件投影为角色树、任务阶段、Codex 委托与发现项，从而无需阅读子会话记录即可恢复工作流。它是纯折叠加上不变量伴随模块。它不注册工具、不生成 Agent，也不追加会话事件。本包是实验性的，没有稳定性承诺。

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

对版本 1 事件调用 `projectOrc` 或 `applyOrc`。`emptyOrcState` 是 `orc/workflow/created` 之前的状态。被拒绝的事件设置 `failure`，并保持其余字段不变。角色是 `supervisor`、`lead` 与 `peer`。合法边只有 Supervisor 到 Lead，以及 Lead 到 Peer。Peer 不能创建子节点。Codex 不是角色节点；spec、plan、review 与 audit 是带关联 id 的委托。

工作流阶段为 `brainstorming`、`spec_required`、`plan_required`、`awaiting_user_approval`、`task_implementation`、`task_peer_settlement`、`task_review`、`task_audit`、`task_fix`、`next_task`、`final_review`、`complete` 与 `failed`。计划批准只来自 source 为 `plan/review` 的 `orc/plan/approval`。阻断严重级别来自 `orc/workflow/created`。载荷必须包含 `critical`、`high` 与 `medium`；一次运行还可以列入 `low` 或 `info`。非 `ok` 的 review 或 audit 结果阻止推进。当前迭代上的阻断发现项必须先进入 `task_fix`，然后才能进入 `next_task` 或 `final_review`。解决发现项不会清除该委托上的阻断标记。

每个 `orc/phase` 事件都写出 `actorNodeId`。缺少行动者会被拒绝，Peer 不能推进工作流。Supervisor 与 Lead 可以。阻断性的分支发现项写出其任务 id。在 `final_review` 中，该行动者把被点名的任务移回 `task_fix`，折叠将该任务的修复迭代加一。缺失或畸形的分支结果仍然阻止完成，并且不算干净。`low` 与 `info` 发现项不阻断，除非该次运行把它们列入 `blockingSeverities`。

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
| [`src/index.ts`](src/index.ts) | 公开的折叠导出 |

`OrcState.failure` 是拒绝原因。`blockingSeverities` 是该次运行的阈值。节点保存角色提示、技能包络、写入范围、验收标准与报告格式。委托保存 Codex 信封与报告状态。`blocksProgress` 在记录结果时固定。

`./invariant` 伴随模块监听 `session/event`，并忽略 `orc/*` 以外的每个类型。它折叠已提交前缀，应用候选事件，并在投影拒绝时报告失败。检查发生在事件被追加之前。

这里不发布编排服务。生成、工具与已发布的会话事件表留在本包之外。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [实验性包](../README.zh.md) — 发布与依赖隔离。
- [ORC 设计](../../../docs/superpowers/specs/2026-09-22-orc-superpowers-orchestration-design.md) — 必需的生命周期、角色与失败行为。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只重放持久的 ORC 事件，不组装模型请求。

#### KV Cache 影响

折叠读取已提交事件，不写入模型请求前缀，因此不会增长或使 KV 缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有编排服务** — 调用方在本包之外追加事件并执行生成、review 与 audit。折叠只接受或拒绝给定的日志。
- **会话事件表** — `orc/*` 不属于已发布的 `SessionEventMap`。伴随模块只在会话追加这些类型时看到它们；本包不改变会话格式版本。
- **每次重开一个任务** — 一次前往 `task_fix` 的 `orc/phase` 只重开被点名的任务。完成仍要等待之后一次干净的分支 review 与 audit。
- **阈值下限** — 一次运行可以把 `low` 或 `info` 加入阻断集合，但不能省略 `critical`、`high` 或 `medium`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
