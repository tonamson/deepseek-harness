# Agent Note: Grok CLI stays a Host prerequisite for the subagent backend

Status: implemented

English | [中文](2026-09-22-grok-cli-host-subagent.zh.md)

## Problem

DeepSeek Harness needs a model-facing subagent tool for the official Grok CLI. The available Grok release is distributed as a Host executable by x.ai, while the npm registry does not provide an official package for the pinned `1.0.40` runtime. Adding a similarly named third-party npm package would install a different product integration and would make `pnpm install` appear to provide a supported Grok runtime when it does not.

## Decision

The new [`@deepseek-ai/dsh-subagent-grok`](../../../../packages/subagent/subagent-grok/README.md) package registers a one-shot `grok` provider and its Profile Bundle patch. The provider resolves the configured `grok` command through the shared subprocess service, checks `grok --version`, accepts only `1.0.40`, and starts one fresh `--single` turn in the parent Session cwd. It passes the configured model, reasoning effort, permission mode, environment, timeout, and output limit explicitly; it always disables Grok child subagents.

The Bundle does not download, package, authenticate, update, or silently substitute the Grok executable. A Profile must supply the official binary on the subprocess `PATH`, or configure an absolute `command`. The model-facing `subagent_grok` tool is opt-in in the standard templates and is active in `my-coding` only as an explicitly requested general-purpose second opinion. The existing Codex review, audit, and Terra spec/plan routes remain authoritative and are not redirected to Grok.

The run publishes only nonblank final stdout. Product reasoning, tool activity, raw stderr, ids, commands, and workspace diffs remain outside the parent Session. The shared subprocess handle owns cancellation and teardown, while safe fixed lifecycle diagnostics report resolution, version, process, timeout, cancellation, or result failures without copying product text.

## Alternatives considered

**Bundle a third-party npm package named `grok-cli`.** Rejected because the package is not the official x.ai CLI and does not provide the pinned runtime. It would create an unsupported dependency and a misleading install guarantee.

**Download the official binary during `pnpm install`.** Rejected because the official distribution is a Host installer and platform binary rather than a versioned npm dependency with a repository-owned integrity record. Installation would add network, platform, credential, and supply-chain behavior to the workspace package manager.

**Accept any Grok CLI version.** Rejected because the provider relies on native flags and plain-output behavior. A changed CLI contract must fail before a task starts instead of producing an unverified model-visible result.

**Route the existing Codex review, audit, and spec tools through Grok.** Rejected because those routes are explicit workflow guarantees in the coding preset. Grok is an opt-in additional backend, not a replacement for their assigned Codex models and efforts.

## Consequences

Profiles that want Grok must install the Harness Bundle and separately install or expose official Grok CLI `1.0.40`. A missing executable or version mismatch is visible on the first delegation as a safe startup or version failure. The workspace lockfile contains no fake Grok runtime and `pnpm install` remains deterministic with respect to this provider.

The provider has one fresh process and turn per call, no continuation or product-session persistence, and no rollback of side effects after cancellation. Named provider instances can share the package while using distinct tool names. Focused unit and Loader composition tests cover argv construction, version gating, output isolation, cancellation, Bundle registration, named instances, and the no-start composition path.
