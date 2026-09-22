---
description: "面向用户与维护者的单次 Grok CLI subagent provider 文档，用于围绕已有官方 Grok 可执行文件安装 Profile Bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-grok

[English](README.md) | 中文

## 概述

当 Profile 需要在父 Session 工作区中单次委派给官方 Grok CLI 时，安装此 Bundle。每次调用都会检查 Host 可执行文件版本，启动一次新的非交互 Grok turn，并只返回最终纯文本。这个包是 Harness provider，不会下载或打包 Grok binary。Host 必须在 `PATH` 中提供 Grok CLI `1.0.40`，也可以通过配置的可执行文件命令提供。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 安装 Bundle

将包安装到目标 Profile，然后重启该 Profile。`pnpm install` 会安装 Harness 包及其 workspace 依赖；它不会安装产品可执行文件。

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-grok
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-grok
dsh --profile <name>
```

启动委派前，验证 Host 上的产品安装：

```sh
grok --version
```

provider 只接受 `grok 1.0.40`。当 binary 不在 subprocess service 的 `PATH` 中时，使用 `command` 指定绝对路径。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `grok` | `ctx.subagents` 上的非空 registry 名称；每个挂载实例都需要唯一值 |
| `command` | `grok` | 由共享 subprocess service 解析的裸可执行文件名或绝对路径 |
| `model` | 原生 Grok 设置 | 可选的非空模型名，会传递给每次 single-turn 调用 |
| `reasoningEffort` | 原生 Grok 设置 | 可选的非空 reasoning effort，会传递给每次 single-turn 调用 |
| `env` | `{}` | 叠加在 subprocess credential scrub 之上的显式子进程环境 |
| `permissionMode` | `dontAsk` | 原生的非交互 Grok permission mode |
| `timeoutMs` | `300000` | 版本验证和委派 turn 的墙钟上限 |
| `disposeGraceMs` | `3000` | 共享 subprocess 终止层级之间的宽限时间 |
| `maxOutputBytes` | `1048576` | 单个最终答案保留的 stdout 最大字节数 |

接受的 `permissionMode` 值为 `default`、`acceptEdits`、`auto`、`dontAsk`、`bypassPermissions` 和 `plan`。provider 原样传递所选模式给 Grok，并始终加入 `--no-subagents`，使委派调用不能创建第二棵产品委派树。

### 暴露工具

每一行工具配置都会把一个 provider 绑定到一个稳定的 model-facing 名称。随附的完整 preset 含有 disabled 模板；只有在安装此 Bundle 后复制 preset 并移除 `disabled`。

```yaml
- id: tool-subagent-grok
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: grok
    toolName: subagent_grok
    backgroundMode: one-shot
    maxDepth: provider-managed
```

`one-shot` 策略让省略或设置为 `false` 的 `run_in_background` 调用保持前台执行。显式设置为 `true` 时，会为共享的 `job_output` 或 `job_kill` 控制返回通用 Job id。

### 可获得的结果

成功的前台调用返回 Grok 的最终纯文本 stdout。后台调用先返回 Job id，之后通过通用 job 控制暴露相同的最终答案。Grok reasoning、工具活动、原始 stderr、产品 session id 和工作区 diff 不会进入父 Session。

### 失败与恢复

第一次委派会解析 `command`、运行 `grok --version`，并在启动任务前拒绝所有不是 `1.0.40` 的版本。缺少可执行文件、不支持的版本、非零退出、空答案、超时或取消都会产生安全的生命周期 diagnostic；原始产品 stderr 只保留在 Host。安装或选择匹配的官方 Grok CLI；如果 Bundle 集合发生变化，再重启 Profile。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

Bundle patch 会注册休眠的默认 provider `grok`。`src/index.ts` 校验部署设置并注册其他具名 provider 实例。`src/run.ts` 负责版本验证、单次 argv 构造、输出收集、取消、超时和安全 diagnostic。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、配置 schema 与 provider 注册 |
| [`src/run.ts`](src/run.ts) | Grok 进程生命周期、版本检查、输出选择与 diagnostic |
| [`cordis.patch.yml`](cordis.patch.yml) | 注册休眠 provider 的 Profile patch 层 |

一次接受的运行会拼接文本块，从父 Session 推导子进程 cwd，通过共享 subprocess service 解析 executable，并检查固定版本。随后启动 `grok --single ... --output-format plain --cwd ... --permission-mode ... --no-subagents`。只有非空白 stdout 会成为 model-visible 内容。subprocess handle 负责取消和整个进程范围的 teardown；stderr 只发送到 Host diagnostic sink。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Subagent subsystem](../../../docs/subsystems/subagent.zh.md) — service contract、provider contract 与 terminal result 语义。
- [dsh-subagent seam](../subagent/README.zh.md) — 本 provider 注册所使用的 registry 与 start API。
- [Codex provider](../subagent-codex/README.zh.md) — coding preset 的 review、audit 和 spec 路由使用的包内 Codex app-server backend。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-grok) — 每个可接受配置字段及其源码声明。

-----

<a id="model-experience"></a>
## 模型体验

### 子请求

#### 模型看到的内容

Grok child 会在新的 single-turn 进程中收到独立的文本任务。它的工作区是父 Session cwd。所选 provider 实例固定 executable、可选模型、reasoning effort、环境、permission mode、timeout 和输出限制。

#### Token 影响

child 为独立的 Grok context 和 turn 付费。只有最终答案返回后，child tokens 才会进入父 context。

#### KV Cache 影响

child request 独立于父 request cache。cache 是否复用取决于 Grok 自己的原生设置和产品 runtime。

### 父调度与结果（间接）

#### 模型看到的内容

通过 `dsh-tool-subagent`，前台调用返回最终 Grok 答案，或带 stop reason 的安全失败 diagnostic。后台调用返回通用 Job acknowledgement，之后返回完成或失败详情。父模型不会收到 Grok reasoning、中间工具活动、原始 stderr、产品 id、命令或工作区 diff。

#### Token 影响

前台输入增加保留的最终答案或 error。后台输入还会增加 Job acknowledgement、完成通知和后续控制结果。child tokens 仍不会进入父 context。

#### KV Cache 影响

父 history 保持 append-only：result、Job notice 或后续控制输出都会添加在可复用 prefix 之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **需要 Host 产品安装** — Bundle 不会下载、验证身份、更新或打包 Grok CLI。精确的 `1.0.40` executable 必须通过配置的 command 和 subprocess execution environment 可用。
- **每次运行只有一个新进程和 turn** — 没有 continuation、resume、pooling、progress stream 或产品 session persistence。
- **provider 与工具是静态选择** — Profile 行固定 provider 名称、可选模型设置和工具绑定；每个暴露的 provider 都需要唯一工具名。
- **原生身份验证仍是权威来源** — provider 不登录、不选择账号、不改写 Grok 设置，也不创建 credential。产品身份验证失败仍是产品 diagnostic。
- **只有最终文本** — reasoning、commentary、中间消息、工具流量、usage、原始 stderr 和工作区 diff 都留在父 Session 之外。
- **没有可选共享能力** — 对于这个单次 backend，共享 provider service 会拒绝 output schema、child persona、工具过滤和 Harness depth enforcement。
- **取消不会回滚副作用** — 取消前已经修改的文件或外部系统不会恢复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

Grok CLI 由 x.ai 作为 Host executable 分发，而不是官方 npm package。因此本包将 binary 保持在 workspace dependency graph 之外，把 runtime compatibility 固定为 `1.0.40`，并在遇到其他版本时 fail closed，而不是默默接受变化后的 CLI contract。

</details>

**Runtime invariant:** 不发布 companion。生命周期配对属于共享 subagent service，managed-range ownership 属于 subprocess service。
