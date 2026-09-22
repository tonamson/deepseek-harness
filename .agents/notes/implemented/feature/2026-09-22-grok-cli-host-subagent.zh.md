# Agent Note: Grok CLI 保持为 subagent backend 的 Host 前置条件

Status: implemented

[English](2026-09-22-grok-cli-host-subagent.md) | 中文

## 问题

DeepSeek Harness 需要一个面向模型的官方 Grok CLI subagent tool。现有 Grok 版本由 x.ai 作为 Host executable 分发，而 npm registry 没有固定 `1.0.40` runtime 的官方包。加入名称相近的第三方 npm package 会安装另一种产品集成，并会让 `pnpm install` 看起来提供了受支持的 Grok runtime，实际却不是这样。

## 决策

新的 [`@deepseek-ai/dsh-subagent-grok`](../../../../packages/subagent/subagent-grok/README.zh.md) package 注册单次 `grok` provider 及其 Profile Bundle patch。provider 通过共享 subprocess service 解析配置的 `grok` command，检查 `grok --version`，只接受 `1.0.40`，然后在父 Session cwd 中启动一个新的 `--single` turn。它会显式传递配置的模型、reasoning effort、permission mode、环境、timeout 和输出限制；同时始终禁用 Grok child subagents。

Bundle 不会下载、打包、验证身份、更新或静默替换 Grok executable。Profile 必须在 subprocess `PATH` 中提供官方 binary，或配置绝对 `command`。标准模板中的面向模型的 `subagent_grok` tool 是 opt-in 的；在 `my-coding` 中，它只作为用户明确请求时的一般用途第二意见。现有 Codex review、audit 和 Terra spec/plan 路由仍是权威路由，不会改道到 Grok。

run 只发布非空白的最终 stdout。产品 reasoning、工具活动、原始 stderr、id、命令和工作区 diff 都留在父 Session 之外。共享 subprocess handle 负责取消与 teardown；安全的固定生命周期 diagnostic 报告解析、版本、进程、超时、取消或结果失败，但不复制产品文本。

## 考虑过的替代方案

**打包名为 `grok-cli` 的第三方 npm package。** 不予采纳，因为该包不是官方 x.ai CLI，也不提供固定 runtime。它会引入不受支持的依赖，并制造错误的安装保证。

**在 `pnpm install` 期间下载官方 binary。** 不予采纳，因为官方分发形式是 Host installer 和平台 binary，而不是带有仓库自有完整性记录的有版本 npm dependency。安装过程会把网络、平台、credential 和 supply-chain 行为加入 workspace package manager。

**接受任意 Grok CLI 版本。** 不予采纳，因为 provider 依赖原生 flags 和纯文本输出行为。CLI contract 发生变化时，必须在任务启动前失败，而不是生成未经验证的 model-visible 结果。

**让现有 Codex review、audit 和 spec tool 改用 Grok。** 不予采纳，因为这些路由是 coding preset 中的明确 workflow 保证。Grok 是额外的 opt-in backend，不替换指定的 Codex model 和 effort。

## 后果

需要 Grok 的 Profile 必须安装 Harness Bundle，并另外安装或暴露官方 Grok CLI `1.0.40`。缺少 executable 或版本不匹配会在第一次委派时以安全的 startup 或 version failure 呈现。workspace lockfile 不包含虚假的 Grok runtime，`pnpm install` 仍然保持该 provider 的依赖确定性。

provider 每次调用只有一个新进程和 turn，没有 continuation 或产品 session persistence，也不会在取消后回滚副作用。具名 provider 实例可以共享同一个 package，但必须使用不同工具名。聚焦 unit 与 Loader composition tests 覆盖 argv 构造、版本门控、输出隔离、取消、Bundle 注册、具名实例和不启动产品的 composition 路径。
