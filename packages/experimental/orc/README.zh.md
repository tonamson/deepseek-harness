---
description: "从版本 1 的 orc 事件重放持久的 Supervisor、Lead 与 Peer 工作流。"
kind: "package-reference"
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

对版本 1 事件调用 `projectOrc` 或 `applyOrc`。`startSpecPlan` 需要非空的头脑风暴 `contextRef`，并由它进入 `spec_required`，再进入 `plan_required`。Supervisor 会话上的 `plan/review` 是唯一批准输入。`runTaskLoop` 与 `runFinalLoop` 用 `subagents.sendMessage` 把阻断发现发给现有 Lead，并记录该 Lead 之后的回复。`emptyOrcState` 是 `orc/workflow/created` 之前的状态。被拒绝的事件设置 `failure`，并保持其余字段不变。`OrcService` 在追加前询问该折叠，然后用 `ctx.subagents.startContinuable` 启动可继续的 DeepSeek 子运行，或用 `ctx.subagents.start` 启动 Codex 一次性运行。Codex 启动不传 `outputSchema` 与 `maxDepth`。`renderCodexEnvelope` 用已记录的信封和本次运行的 `blockingSeverities` 生成这段文本；它从配置复制 provider、model 与 effort，并写明只读规则。原生 Codex 子运行不继承 DSH skills 或上下文。角色是 `supervisor`、`lead` 与 `peer`。合法边只有 Supervisor 到 Lead，以及 Lead 到 Peer。不是 supervisor 的调用方会在 spec、计划批准、任务分配、review、audit、完成以及 Codex `recordResult` 开始时被拒绝。`startTask`、`settleTask` 与 `recordFix` 要求调用方是 Supervisor，或拥有该任务的 Lead。Peer 不能创建子节点。Codex 不是角色节点；spec、plan、review 与 audit 是带关联 id 的委托。

Codex 启动被持久化之后，`settleCodexRun` 读取这次一次性运行的最终文本。信封包含该阶段的 JSON 约定，review 约定与 audit 约定不同。`parseCodexSpec`、`parseCodexPlan`、`parseCodexReview` 与 `parseCodexAudit` 各自接受一份 JSON 文档或一个 JSON 代码块，并拒绝多余或缺失的字段。服务只在文档被接受时记录 `ok`。缺失文本、未完成的停止，以及被拒绝的文档都保持阻断，原始答案记在委托上。`runCodexTaskLoop` 分别启动 review 与 audit，对阻断发现项调用调用方提供的修复，并重复这两道门。`runCodexFinalLoop` 只在每个任务都干净之后启动分支一对结果。阻断性的分支发现项通过 `task_fix` 与 `orc/fix/iteration` 重开该任务。这两个循环不追加 `orc/run/completed`。`complete` 会追加，并且只有 Supervisor 可以调用。最终门工具在两条分支报告都为 ok 且不阻断时调用它。

工作流阶段为 `brainstorming`、`spec_required`、`plan_required`、`awaiting_user_approval`、`task_implementation`、`task_peer_settlement`、`task_review`、`task_audit`、`task_fix`、`next_task`、`final_review`、`complete` 与 `failed`。计划批准只来自 source 为 `plan/review` 的 `orc/plan/approval`。服务复制该 review 的 correlation 与会话 seq，忽略不晚于 ok plan result 的 review，并允许更晚的 `approved` review 替换 `rejected`。ok plan 之后到达 `plan_required` 的 review 会进入 `awaiting_user_approval`。阻断严重级别来自 `OrcServiceConfig`，并复制到 `orc/workflow/created`。集合必须包含 `critical`、`high` 与 `medium`；配置还可以列入 `low` 或 `info`。与配置不同的工具集合会被拒绝。非 `ok` 的 review 或 audit 结果阻止推进。当前迭代上的阻断发现项必须先进入 `task_fix`，然后才能进入 `next_task` 或 `final_review`。解决发现项不会清除该委托上的阻断标记。记录下来的发现项会保留 Codex 答案提供的 file、location、evidence、remediation 与 source stage。

每个 `orc/phase`、`orc/run/completed` 与 `orc/run/failed` 事件都写出 `actorNodeId`。缺少行动者会被拒绝，Peer 不能推进工作流。Lead 只能走任务内的边：实现、Peer 结算、review、audit 与修复。任务排序、最终审查与终态完成只属于 Supervisor。阻断性的分支发现项写出其任务 id。Supervisor 把该任务移回 `task_fix`，并在回到 review 之前由 `orc/fix/iteration` 记录下一次迭代。一次 `final_review` 只接受一对分支 review 与 audit；仅当最近一次结果为 failed、malformed 或 unavailable 时才允许重试。修复循环返回之后的下一次访问只按那一对新结果判断。缺失或畸形的分支结果仍然阻止完成，并且不算干净。`low` 与 `info` 发现项不阻断，除非该次运行把它们列入 `blockingSeverities`。

Spec 与 plan 解析会在记录或返回文档文本之前去除首尾空白，保留内部格式和原始 JSON 信封，并拒绝仅含空白的文档。

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
| [`src/envelope.ts`](src/envelope.ts) | 给原生 Codex 子运行的 `renderCodexEnvelope` 文本 |
| [`src/codex-results.ts`](src/codex-results.ts) | Codex spec、plan、review 与 audit 文本的解析器 |
| [`src/codex-dispatch.ts`](src/codex-dispatch.ts) | Codex 最终文本的结算，以及 review、audit 与修复循环 |
| [`src/index.ts`](src/index.ts) | 公开的折叠导出与 `OrcService` |

`OrcState.failure` 是拒绝原因。`blockingSeverities` 是该次运行的阈值。节点保存角色提示、技能包络、写入范围、验收标准与报告格式。委托保存 Codex 信封与报告状态。`blocksProgress` 在记录结果时固定。

`./invariant` 伴随模块监听 `session/event`，并忽略 `orc/*` 以外的每个类型。它折叠已提交前缀，应用候选事件，并在投影拒绝时报告失败。检查发生在事件被追加之前。

`OrcService` 注入 agents、sessions、session persistence、session projections 与 subagents。它注册 `orc` 投影并读回该投影。只有当日志行匹配 correlation、stage、role 与 task 时，结果才会被追加。Codex 请求事件在 `start` 返回后保存 `continuationId`，Lead 或 Peer 节点在 `startContinuable` 返回后保存 `messageId`。没有该句柄的未完成行会被记成阻断失败，并且不会被当作可恢复的子运行。面向模型的工具留在 `@deepseek-ai/dsh-experimental-tool-orc`。本包声明 `orc/*` 会话事件。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [实验性包](../README.zh.md) — 发布与依赖隔离。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 OrcService 启动的可继续 DeepSeek 子代理与一次性 Codex 运行；这些提供方负责组装模型请求。

#### KV Cache 影响

ORC 事件不进入 Supervisor 的派生历史。每个子提示属于独立会话，因此记录委托不会增长 Supervisor 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **本构建可冷启动重开** — `orc/*` 属于本构建的会话词汇，`plan/review` 是批准事件。本构建的持久化读取接受包含它们的日志。早于这次登记的读取器会拒绝该日志，因为这些事件没有标成 ignorable。版本 1 的 `orc/spec/requested` 与 `orc/plan/requested` 要求 `contextRef`。投影恢复已记录的提示、技能包络、任务 id、Codex 文本和批准关联，而不读取子会话 transcript。仍打开的 Codex 行还需要启动它的那个进程里的结果 promise。
- **同一父节点、角色与任务只保留一个未完成子节点** — 该子节点仍打开时，`spawn` 返回它，而不会为同一任务再创建一个 Peer。
- **每次重开一个任务** — 一次前往 `task_fix` 的 `orc/phase` 只重开被点名的任务。`orc/fix/iteration` 在回到 review 之前记录这次修复。完成要等待下一次 `final_review` 访问中干净的分支一对结果。
- **阈值下限** — 一次运行可以把 `low` 或 `info` 加入阻断集合，但不能省略 `critical`、`high` 或 `medium`。
- **Codex 最终文本只留在本进程** — `awaitCodex` 等待发生在本进程的那次启动所返回的结果 promise。后一个进程可以看到未完成的行，但没有那个 promise，因此它拒绝该行，而不会记成干净结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
