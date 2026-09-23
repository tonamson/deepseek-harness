---
description: "Replay a durable Supervisor, Lead, and Peer workflow from version-1 orc events."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-orc

English | [中文](README.zh.md)

## Summary

`dsh-experimental-orc` projects one Supervisor session's `orc/*` events into the role tree, task phases, Codex delegations, and findings needed to resume the workflow without reading child transcripts. `OrcService` appends those events and starts correlated DeepSeek and Codex children. The fold remains the transition authority. The package does not register tools. It is experimental and has no stability promise.

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

Call `projectOrc` or `applyOrc` with version-1 events. `startSpecPlan` requires a non-empty brainstorm `contextRef` and is the operation that enters `spec_required` and then `plan_required`. `plan/review` on the Supervisor session is the only approval input. `runTaskLoop` and `runFinalLoop` send blocking findings to the existing Lead with `subagents.sendMessage` and record that Lead's later reply. `emptyOrcState` is the state before `orc/workflow/created`. A refused event sets `failure` and leaves every other field as it was. `OrcService` asks that fold before it appends, then starts a continuable DeepSeek child with `ctx.subagents.startContinuable` or a Codex one-shot with `ctx.subagents.start`. Codex starts omit `outputSchema` and `maxDepth`. `renderCodexEnvelope` builds that text from the logged envelope and the run's `blockingSeverities`; it copies provider, model, and effort from config and states the read-only rule. Native Codex children do not inherit DSH skills or context. Roles are `supervisor`, `lead`, and `peer`. The legal edges are Supervisor to Lead and Lead to Peer. A caller who is not the supervisor is refused at the start of spec, plan approval, task assignment, review, audit, completion, and a Codex `recordResult`. `startTask`, `settleTask`, and `recordFix` require the supervisor or the Lead that owns the task. A Peer cannot create a child. Codex is not a role node; spec, plan, review, and audit are correlated delegations.

After a Codex start is durable, `settleCodexRun` reads the one-shot final text. The envelope includes that stage's JSON contract, and the review contract is not the audit contract. `parseCodexSpec`, `parseCodexPlan`, `parseCodexReview`, and `parseCodexAudit` each accept one JSON document or one JSON code block and reject extra or missing fields. The service records `ok` only for an accepted document. Missing text, a non-completed stop, and a rejected document stay blocking, and the raw answer is stored on the delegation. `runCodexTaskLoop` starts review and audit separately, calls the supplied fix for blocking findings, and repeats both gates. `runCodexFinalLoop` starts the branch pair only after every task is clean. A blocking branch finding reopens that task with `task_fix` and `orc/fix/iteration`. These loops do not append `orc/run/completed`. `complete` does, and only the Supervisor may call it. The final-gates tool calls it when both branch reports are ok and non-blocking.

The workflow phases are `brainstorming`, `spec_required`, `plan_required`, `awaiting_user_approval`, `task_implementation`, `task_peer_settlement`, `task_review`, `task_audit`, `task_fix`, `next_task`, `final_review`, `complete`, and `failed`. Plan approval is only `orc/plan/approval` with source `plan/review`. The service copies that review's correlation and session seq, ignores a review at or before the ok plan result, and lets a later `approved` review replace `rejected`. A review that arrives in `plan_required` after an ok plan enters `awaiting_user_approval`. Blocking severities come from `OrcServiceConfig` and are copied onto `orc/workflow/created`. The set must include `critical`, `high`, and `medium`; config may also list `low` or `info`. A tool set that differs is refused. A non-ok review or audit result blocks progression. Blocking findings on the current iteration require `task_fix` before `next_task` or `final_review`. Resolving a finding does not clear that delegation. A recorded finding keeps file, location, evidence, remediation, and source stage when the Codex answer supplied them.

Every `orc/phase`, `orc/run/completed`, and `orc/run/failed` event names `actorNodeId`. A missing actor is refused, and a Peer cannot advance the workflow. A Lead may take only the task-local edges: implementation, peer settlement, review, audit, and fix. Sequencing, final review, and terminal completion stay with the Supervisor. A blocking branch finding names its task id. The Supervisor moves that task to `task_fix`, and `orc/fix/iteration` records the next iteration before review. One final-review visit accepts one branch review and one branch audit, plus a retry only when the latest result is failed, malformed, or unavailable. A later visit, after that fix loop returns, is judged on its own pair. A missing or malformed branch result still blocks completion and is not clean. Low and info findings do not block unless the run lists them in `blockingSeverities`.

Finding identity includes the id, source stage, review scope, and owning task. A later report updates that lineage; another stage, scope, or task keeps a separate finding even when it uses the same id. Duplicate ids within one report are refused. Fix requests include only blocking findings correlated with the selected reports.

Spec and plan parsing removes surrounding whitespace from the document text before it is logged or returned, preserves internal formatting and the raw JSON envelope, and rejects whitespace-only documents.

Event names and payload version stay at version 1. This package does not migrate, rewrite, or delete released session data, and it does not import `team/*` events.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Branded ids, phases, and version-1 payloads |
| [`src/projection.ts`](src/projection.ts) | Zod payloads, `applyOrc`, and `projectOrc` |
| [`src/invariant.ts`](src/invariant.ts) | Companion that refuses an `orc/*` candidate before append |
| [`src/envelope.ts`](src/envelope.ts) | `renderCodexEnvelope` text for a native Codex child |
| [`src/codex-results.ts`](src/codex-results.ts) | Parsers for Codex spec, plan, review, and audit text |
| [`src/codex-dispatch.ts`](src/codex-dispatch.ts) | Codex final-text settlement and the review/audit fix loop |
| [`src/index.ts`](src/index.ts) | Public fold exports and `OrcService` |

`OrcState.failure` is the refusal string. `blockingSeverities` is the run's threshold. Nodes store the role prompt, skill envelope, write scope, acceptance criteria, and reporting format. Delegations store Codex envelopes and report status. `blocksProgress` is fixed when the result is recorded.

The `./invariant` companion listens for `session/event` and ignores every type outside `orc/*`. It folds the committed prefix, applies the candidate, and reports a failure when the projection refuses it. The check runs before the event is appended.

`OrcService` injects agents, sessions, session persistence, session projections, and subagents. It registers an `orc` projection and reads that projection back. A result appends only when the log row matches the correlation, stage, role, and task. Codex request events store `continuationId` after `start` returns, and a Lead or Peer node stores `messageId` after `startContinuable` returns. An open row without that handle is closed as a blocking failure and is not resumed. Model-facing tools stay in `@deepseek-ai/dsh-experimental-tool-orc`. This package declares the `orc/*` session events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication and dependency isolation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through continuable DeepSeek children and one-shot Codex runs started by OrcService; those providers own model-request assembly.

#### KV Cache effect

ORC events stay off the Supervisor derived history. Each child prompt is a separate session, so recording a delegation does not grow the Supervisor prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Cold reopen in this build** — `orc/*` is part of this build's session vocabulary, and `plan/review` is the approval event. A persistence reader in this build accepts a log that contains them. A reader that predates the registration refuses that log because the events are not ignorable. Version-1 `orc/spec/requested` and `orc/plan/requested` require `contextRef`. The projection restores recorded prompts, skill envelopes, task ids, Codex text, and the approval correlation without reading child transcripts. An open Codex row still needs the result promise from the process that started it.
- **One open child per parent, role, and task** — while that child is open, `spawn` returns it instead of creating another peer for the same task.
- **One task per reopen** — one `orc/phase` to `task_fix` reopens only the named task. `orc/fix/iteration` records that fix before review. Completion waits for the next final-review visit's clean branch pair.
- **Threshold floor** — a run can add `low` or `info` to the blocking set, and it cannot omit `critical`, `high`, or `medium`.
- **Codex final text stays in this process** — `awaitCodex` waits on the result promise from the start that happened here. A later process can see the open row and still have no promise, so it refuses that row instead of recording a clean report.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
