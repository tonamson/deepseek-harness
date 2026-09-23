---
description: "The one-shot Grok CLI subagent provider for users and maintainers installing a Profile Bundle around an existing official Grok executable."
kind: "package-bundle"
---

# @deepseek-ai/dsh-subagent-grok

English | [中文](README.zh.md)

## Summary

Install this Bundle when a Profile needs one-shot delegation to the official Grok CLI in the parent Session's workspace. Each call checks the host executable version, starts one fresh non-interactive Grok turn, and returns only final plain text. The package is a Harness provider and does not download or package the Grok binary. The Host must provide Grok CLI `1.0.40` on `PATH`, or through the configured executable command.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install the Bundle

Install the package into the target Profile and restart that Profile. `pnpm install` installs the Harness package and its workspace dependencies; it does not install the product executable.

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-grok
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-grok
dsh --profile <name>
```

Before starting a delegation, verify the Host product installation:

```sh
grok --version
```

The provider accepts only `grok 1.0.40`. Use `command` for an absolute path when the binary is not on the subprocess service's `PATH`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `grok` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value |
| `command` | `grok` | Bare executable or absolute path resolved by the shared subprocess service |
| `model` | native Grok settings | Optional non-empty model name passed to each single-turn call |
| `reasoningEffort` | native Grok settings | Optional non-empty reasoning effort passed to each single-turn call |
| `env` | `{}` | Explicit child environment layered over the subprocess credential scrub |
| `permissionMode` | `dontAsk` | Native non-interactive Grok permission mode |
| `timeoutMs` | `300000` | Wall-clock bound for version verification and the delegated turn |
| `disposeGraceMs` | `3000` | Grace between shared subprocess termination tiers |
| `maxOutputBytes` | `1048576` | Maximum retained stdout bytes for one final answer |

The accepted `permissionMode` values are `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, and `plan`. The provider passes the selected mode to Grok unchanged and always adds `--no-subagents` so a delegated call cannot create a second product delegation tree.

### Expose the tool

Each tool row binds one provider to one stable model-facing name. The shipped full presets include a disabled template; copy the preset and remove `disabled` only after installing this Bundle.

```yaml
- id: tool-subagent-grok
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: grok
    toolName: subagent_grok
    backgroundMode: one-shot
    maxDepth: provider-managed
```

The `one-shot` policy keeps omitted or `false` `run_in_background` calls in the foreground. An explicit `true` returns a generic Job id for the shared `job_output` or `job_kill` controls.

### What you get

A successful foreground call returns Grok's final plain-text stdout. A background call returns a Job id first and later exposes the same final answer through the generic job controls. Grok reasoning, tool activity, raw stderr, product session ids, and workspace diffs stay outside the parent Session.

### Failure and recovery

The first delegation resolves `command`, runs `grok --version`, and rejects every version other than `1.0.40` before starting the task. A missing executable, unsupported version, non-zero exit, empty answer, timeout, or cancellation produces a safe lifecycle diagnostic; raw product stderr is host-only. Install or select the matching official Grok CLI, then restart the Profile if its Bundle set changed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Bundle patch registers the dormant default provider `grok`. `src/index.ts` validates deployment settings and registers additional named provider instances. `src/run.ts` owns version verification, one-shot argv construction, output collection, cancellation, timeout, and safe diagnostics.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, config schema, and provider registration |
| [`src/run.ts`](src/run.ts) | Grok process lifecycle, version check, output selection, and diagnostics |
| [`cordis.patch.yml`](cordis.patch.yml) | Profile patch layer that registers the dormant provider |

One accepted run concatenates text blocks, derives the child cwd from the parent Session, resolves the executable through the shared subprocess service, and checks the pinned version. It then starts `grok --single ... --output-format plain --cwd ... --permission-mode ... --no-subagents`. Only nonblank stdout becomes model-visible content. The subprocess handle owns cancellation and whole-range teardown; stderr is sent only to the Host diagnostic sink.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [Codex provider](../subagent-codex/README.md) — the package-owned Codex app-server backend used by the coding preset's review, audit, and spec routes.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-grok) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child request

#### What the model sees

The Grok child receives the standalone text task in a fresh single-turn process. Its workspace is the parent Session cwd. The selected provider instance fixes the executable, optional model, reasoning effort, environment, permission mode, timeout, and output limit.

#### Token effect

The child pays for an independent Grok context and turn. Child tokens do not enter the parent's context until the final answer is returned.

#### KV Cache effect

The child request is independent of the parent request cache. Cache reuse depends on Grok's own native settings and product runtime.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call returns the final Grok answer or a safe failure diagnostic with the stop reason. A background call returns a generic Job acknowledgement and later completion or failure details. The parent never receives Grok reasoning, intermediate tool activity, raw stderr, product ids, commands, or workspace diffs.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the Job acknowledgement, completion notice, and later control results. Child tokens still do not enter the parent context.

#### KV Cache effect

The parent history remains append-only: a result, Job notice, or later control output is added after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Host product installation is required** — the Bundle does not download, authenticate, update, or package Grok CLI. The exact `1.0.40` executable must be available through the configured command and subprocess execution environment.
- **One fresh process and turn per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Static provider and tool selection** — Profile rows fix provider names, optional model settings, and tool bindings; each exposed provider needs a unique tool name.
- **Native authentication remains authoritative** — the provider does not log in, select an account, rewrite Grok settings, or create a credential. Product authentication failures remain product diagnostics.
- **Final text only** — reasoning, commentary, intermediate messages, tool traffic, usage, raw stderr, and workspace diffs stay outside the parent Session.
- **No optional shared capabilities** — output schemas, child personas, tool filtering, and Harness depth enforcement are rejected by the shared provider service for this one-shot backend.
- **Cancellation does not roll back side effects** — files or external systems changed before cancellation are not restored.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Grok CLI is distributed by x.ai as a host executable rather than an official npm package. This package therefore keeps the binary outside the workspace dependency graph, pins runtime compatibility to `1.0.40`, and fails closed on another version instead of silently accepting a changed CLI contract.

</details>

**Runtime invariant:** No companion is published. Lifecycle pairing belongs to the shared subagent service, and managed-range ownership belongs to the subprocess service.
