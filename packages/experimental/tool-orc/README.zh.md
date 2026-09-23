---
description: "基于 ctx.orc 的按角色 ORC 工具与 Superpowers 提示信封。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-orc

[English](README.md) | 中文

## 概述

本包让模型通过一份稳定的工具目录打开并推进 Supervisor、Lead 与 Peer 工作流。每个角色收到同一套 schema。调用是否成立由 `OrcService` 决定。当显式的 ORC profile 要把 spec 与 plan 交给 Codex、把实现交给 DeepSeek 子运行时选用它。本包是实验性的，没有稳定性承诺。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包加在 `@deepseek-ai/dsh-experimental-orc` 之上。插件没有配置。provider、model 与 effort 留在 ORC 服务配置里。挂载后，每个 agent 得到同一套 ORC 工具和一个角色段落。Peer 若尝试创建子运行、批准计划、请求 Codex 或推进另一个任务，会在执行时失败。提示文本并不授予这些权限。

### 何时选用

用于显式打开的 Supervisor 工作流。不要把它挂到仍应保持扁平 Agent Teams 行为的 profile 上。`tool-agent-team` 不变。

### 最小可用示例

先加载 ORC 服务，再加载本插件：

```yaml
- id: tool-orc
  name: '@deepseek-ai/dsh-experimental-tool-orc'
```

服务配置提供 DeepSeek 路由、四条 Codex 路由、仓库路径、技能工作流文本，以及每个 Codex 阶段的预期结果文本。

### 模型能做什么

目录对每个角色都是同一份：

- **打开并监督** — `orc_create_workflow`、`orc_request_spec_plan`、`orc_assign_task`、`orc_request_review`、`orc_request_audit`、`orc_run_task_gates`、`orc_run_final_gates`、`orc_advance` 与 `orc_fail`。
- **创建并结算** — `orc_spawn`、`orc_start_task` 与 `orc_settle_task`。
- **报告** — `orc_record_result` 只记录 DeepSeek 节点。Codex 的 spec、plan、review 与 audit 结果不是模型工具。`orc_record_fix` 记录修复决定。

`orc_request_spec_plan` 接收 `context_ref`，并且是进入 `spec_required` 或 `plan_required` 的唯一调用。没有 ORC 工具接受批准决定。`orc_run_task_gates` 与 `orc_run_final_gates` 把阻断发现发给现有 Lead。review 与 audit 仍是两个工具。畸形或缺失的 Codex 结果仍是服务失败。

### 已记录的模型输入

`orc_create_workflow` 与 `orc_spawn` 把 `prompt` 和 `skillEnvelope` 交给服务。服务把它们追加到 `orc/workflow/created` 或 `orc/node/created`，并发送给 DeepSeek 子运行。Codex 工具调用 `startSpecPlan`、`requestReview` 或 `requestAudit`。这些方法发送的是 `renderCodexEnvelope` 文本，由已记录的信封字段和该次运行的 `blockingSeverities` 组成。它们不传 `outputSchema` 选项。原生 Codex 子运行不继承 DSH skills、工具或上下文；信封就是任务文本。

### 成功和失败是什么样

成功调用返回紧凑 JSON，带有阶段或 correlation id。被拒绝的调用是工具错误。`ORC_UNAUTHORIZED` 表示这个角色不能执行该操作。`ORC_INVALID_INPUT` 表示 id 或列表为空，且发生在服务调用之前。`ORC_REFUSED` 重复服务消息，包括 `peer cannot spawn a child` 与 `peer cannot advance the workflow`。未知阶段是 schema 的 `INVALID_ARGS`，不会追加事件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

适配器在每个 agent 作用域上注册同一套 `defineTool` schema。执行时读取 `ctx.orc`。对于服务自身不按角色拒绝的操作，例如 Peer 请求 Codex，工具抛出 `OrcToolError`。spawn、advance 与 fail 交给服务，服务仍是转移是否合法的权威。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、角色段落、DeepSeek 子提示与工具目录 |

不发布运行时不变量伴随模块。ORC 投影与 `OrcService` 拥有持久关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [orc 包](../orc/README.zh.md) — 这些工具调用的服务、折叠与 Codex 信封。

-----

<a id="model-experience"></a>
## 模型体验

### ORC 系统提示

#### 模型看到什么

每个 agent 得到一个 `orc:role` 段落。文本写明 `role`、`parent`、`authority`、`phase`、`task` 与 `mandatory Superpowers skills`。Supervisor、Lead 与 Peer 的段落不同。该段落还带有该角色的 Superpowers 工作流要求；运行尚未打开时则是未分配句子。`orc_spawn` 记入日志的 DeepSeek 子提示会重复角色段落，并带有 `skillCatalog: using-superpowers, brainstorming, writing-plans, subagent-driven-development, test-driven-development, requesting-code-review, verification-before-completion`。Codex 文本是另一份，并写明 `Native Codex children do not inherit DSH skills or context.` 工具 schema 不随角色缩减；角色不能执行的调用返回 `ORC_UNAUTHORIZED` 或 `ORC_REFUSED`。批准来自已记录的 `plan/review` 事件，而不是工具参数。

##### 角色段落

```markdown
DeepSeek ORC worker follows the role section below.

role: peer

parent: lead-1

authority: may perform the assigned responsibility and report evidence; may not create children, invoke Codex, approve a plan, skip review or audit, or advance the workflow

phase: task_implementation

task: task-a

mandatory Superpowers skills: test-driven-development, verification-before-completion
```

#### Token 影响

角色段落在每次组装时按投影出的运行重写，因此阶段变化会改写该段落。工具 schema 是固定的每次请求成本，不随角色变化。子提示与 Codex 信封是各自的请求，不是额外的 Supervisor 系统文本。

#### KV 缓存影响

阶段、任务或角色变化会重写 `orc:role`，并使该段落之后的系统前缀失效。工具 schema 列表在这些变化中保持稳定，因此未改变前缀之后的 schema token 仍可复用。Codex 请求是新的一次性提示，不会延长 DeepSeek 前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **批准不是工具** — 服务只从 Supervisor 会话上、seq 晚于 ok plan result 的 version-1 `plan/review` 复制 `approved` 或 `rejected`，并复制该 correlation。更晚的 `approved` review 会替换 `rejected`。`dismissed`、`/plan off`、缺失的提问通道与 `plan/mode` 都不会批准。
- **提示文本不是权限** — 段落告诉模型它的角色。Peer 的 spawn 或阶段变化仍由 `OrcService` 拒绝。
- **原生 Codex 子运行在 DSH 之外** — 它们不继承 skills、工具或会话上下文。只有信封文本会到达它们。
- **实验性原型，没有稳定性承诺** — schema 在孵化期间可以改变。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
