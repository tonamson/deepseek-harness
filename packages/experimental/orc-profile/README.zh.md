---
description: "挂载严格 Supervisor、Lead 与 Peer 工作流的可选 profile 层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-orc-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-orc-profile` 是在 `@deepseek-ai/dsh-base` 之后挂载 [ORC](../orc/README.zh.md) 及其[工具](../tool-orc/README.zh.md)的可选 profile 层。patch 写入 DeepSeek 与 Codex 路由。随附 profile 都不会启用它。把它加到需要运行严格工作流的 profile。标准 agent preset 不引用本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本包加到已初始化的 profile，然后选择编码 preset。只有挂上本包工具行时才存在的 ORC 角色段会调用 `orc_request_spec_plan` 与 `exit_plan_mode`：

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-orc-profile
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，以及名为 `codex-spec`、`codex-review` 与 `codex-audit` 的 Codex 提供方。移除本包时，bundle 也会从 profile 的层列表中移除。

配置的路由是：Supervisor、Lead 与 Peer 使用 `deepseek-official` / `deepseek-flash` / `high`；spec 与 plan 使用 `gpt-5.6-terra` / `high`；review 使用 `gpt-5.6-luna` / `high`；audit 使用 `gpt-5.6-luna` / `xhigh`。`repositoryPath` 为 `.`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。它插入 ORC 服务与工具插件，不禁用标准 preset 的工具。

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 路由配置与插件行 |
| [`src/index.ts`](src/index.ts) | 空模块入口 |
| — | 不发布运行时 invariant companion；本包仅携带静态 profile patch。工作流状态由 ORC 服务负责。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ORC 服务](../orc/README.zh.md) — 阶段规则与 Codex 结算。
- [ORC 工具](../tool-orc/README.zh.md) — 面向模型的目录。
- [实验包](../README.zh.md) — 发布策略。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 agent preset 与 `@deepseek-ai/dsh-experimental-tool-orc`；它们拥有 persona 与工具目录。

#### KV Cache 影响

本包没有影响。子代理提示在各自的会话里。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **本 bundle 不注册 Codex 提供方** — 没有 `codex-spec`、`codex-review` 与 `codex-audit` 的 profile 无法启动这些运行。
- **这份 patch 不改已有 profile** — 未添加本 bundle 的 profile 保持原样。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
