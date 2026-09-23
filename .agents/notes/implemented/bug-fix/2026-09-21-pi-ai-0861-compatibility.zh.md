# Agent Note: pi-ai 0.86.1 升级兼容性

Status: implemented

[English](2026-09-21-pi-ai-0861-compatibility.md) | 中文

## Problem

pi-ai 适配器在编译期分类每一个上游兼容字段，而目录路由只提供已安装包附带的模型 ID。[pi-ai 0.86.1](https://github.com/earendil-works/pi/blob/v0.86.1/packages/ai/CHANGELOG.md) 新增并移除兼容字段、为 `mistral-conversations` 赋予独立的 compat 类型、把 `ToolCall.arguments` 收窄为 `JsonObject`、为提供方入口传入带品牌的 `TranscriptContext`，并重命名 DeepSeek 目录中的 flash ID。若不同步修改适配器，宿主构建会在漂移闸门处失败，且所有使用旧 DeepSeek ID 的 pi-ai 路由测试都解析不到模型。本次升级的动因是 OpenCode Go 提供 `deepseek-v4.1-flash`，而 0.85.1 的冻结目录无法提供该模型。

## Decision

适配器遵循 pi-ai 0.86.1：`packages/llm/llm-pi-ai/package.json` 要求 `^0.86.1`，锁文件将其与 `@earendil-works/pi-telemetry@0.86.1` 一并解析，`pnpm-workspace.yaml` 将两者列入发布年龄策略的豁免。webworker 桩的提供方 ID 表按该版本的 `getBuiltinProviders()` 重写——共 41 个 ID，新增 `meta` 与 `radius`。

0.86 新增的字段全部保持目录所有（withhold），因为上游生成目录只为经过验证的确切模型与传输启用它们：`openai-completions` 上的 `supportsMidConvoSystemMessages` 与 `supportsMidConvoToolAdditions`，`openai-responses` 上的 `supportsMidConvoSystemMessages`，以及 `anthropic-messages` 上的 `sessionAffinityFormat`、`supportsMidConvoSystemMessages` 与 `supportsMidConvoToolChanges`。0.86 移除的字段——`deferredToolsMode` 与 `supportsToolReferences`——同时退出闸门。

`Model.compat` 现在为 `mistral-conversations` 赋予了 compat 类型，因此 `COMPAT_GATES` 新增 `MISTRAL_CONVERSATIONS_COMPAT_GATE`。`ApiWithCompat` 的推导正是迫使新增该条目的原因：pi-ai 赋予 compat 类型的协议会让 `Record` 编译失败，直到有人分类其字段；该协议唯一的字段与同类字段一样由目录所有。

`ToolCall.arguments` 现为 `JsonObject`，因此 `parseArguments` 返回该类型而非 `Record<string, unknown>`。其取值仍是对持久化工具调用文本执行 `JSON.parse` 的结果，回放行为不变。

提供方入口（`ProviderStreams.stream` 与 `streamSimple`）接收只有 `normalizeContext()` 才能产生的带品牌 `TranscriptContext`，而 `Models.stream*` 仍接受普通 `Context` 并在内部完成归一化。因此 `toPiContext` 继续返回 `Context`，只有直接调用提供方的测试需要归一化。

pi-ai 的 `deepseek` 目录路由改为提供 `deepseek-flash`（DeepSeek V4.1 Flash，现支持图像输入），取代 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp`。解析该路由的测试改用新 ID，纯文本能力断言则移到仍保持纯文本输入的 `deepseek-v4-pro`。

两个提供方目录金标文件按目录顺序新增 `meta` 与 `radius`。

## Alternatives considered

**留在 0.85.1，并在 `settings.yaml` 中声明 `deepseek-v4.1-flash`。** 配置中的 `models` 列表是替换而非扩展路由的整个目录，因此部署方必须重述所有保留的模型，并针对仍在变化的目录手工维护新模型的容量与价格。

**升级但不重新分类新增字段。** 闸门的存在就是为了强制做出分类决定；绕过它等于发布一个无人决策过的兼容字段，而这正是 `Record` 键类型所防止的静默漂移。

**把多轮对话中段字段开放为部署开关。** 上游只为经过确切传输验证的模型启用它们，任意网关声明这些字段等于断言一项无人验证的能力；适配器的规则是：目录所有的字段通过命名目录路由来获得。

**在 pi-ai 的 `deepseek` 路由上手工声明 `deepseek-v4-flash` 以保留旧词汇。** 端点已重命名该模型，手工声明的 ID 会把已退役的名称发给提供方，并冻结目录现在仍在维护的价格与能力元数据。

## Consequences

OpenCode Go 现在提供 `deepseek-v4.1-flash`，这正是本次升级的目的；同一版本还把它加入 OpenCode、OpenRouter、Together、Baseten、Hugging Face 以及 Qwen token plan 系列。

在目录 `deepseek` 路由上命名 `deepseek-v4-flash` 的部署必须改用 `deepseek-flash`。没有任何随附默认值改变：Harness 自身的 DeepSeek 路由与 `deepseek-official` 模型词汇仍保留 `deepseek-v4-flash`。

已录制的会话夹具不受影响：它们录制自 `deepseek-official`，并按模型 ID 回放，不涉及目录成员关系。

验证：宿主 TypeScript 构建（`tsc -b tsconfig.host.json`）、`llm-pi-ai` 测试套件（325 项）、扩充后的[兼容性测试](../../../../packages/llm/llm-pi-ai/tests/compat-upgrade.spec.ts)（25 项），以及两个提供方目录金标文件经浏览器通道的验证（`vitest --config vitest.web.config.ts`，14 项）。

0.85.1 的笔记保持有效并双向交叉链接：其中关于哪些字段属于部署控制的理由仍然适用，而版本与字段集合不再适用。
