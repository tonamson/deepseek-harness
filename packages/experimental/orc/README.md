---
description: "Replay a durable Supervisor, Lead, and Peer workflow from version-1 orc events."
kind: "package-library"
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

Call `projectOrc` or `applyOrc` with version-1 events. `emptyOrcState` is the state before `orc/workflow/created`. A refused event sets `failure` and leaves every other field as it was. `OrcService` asks that fold before it appends, then starts a continuable DeepSeek child with `ctx.subagents.startContinuable` or a Codex one-shot with `ctx.subagents.start`. Codex starts omit `outputSchema` and `maxDepth`. `renderCodexEnvelope` builds that text from the logged envelope and the run's `blockingSeverities`; it copies provider, model, and effort from config and states the read-only rule. Native Codex children do not inherit DSH skills or context. Roles are `supervisor`, `lead`, and `peer`. The legal edges are Supervisor to Lead and Lead to Peer. A Peer cannot create a child. Codex is not a role node; spec, plan, review, and audit are correlated delegations.

The workflow phases are `brainstorming`, `spec_required`, `plan_required`, `awaiting_user_approval`, `task_implementation`, `task_peer_settlement`, `task_review`, `task_audit`, `task_fix`, `next_task`, `final_review`, `complete`, and `failed`. Plan approval is only `orc/plan/approval` with source `plan/review`. Blocking severities come from `orc/workflow/created`. The payload must include `critical`, `high`, and `medium`; a run may also list `low` or `info`. A non-ok review or audit result blocks progression. Blocking findings on the current iteration require `task_fix` before `next_task` or `final_review`. Resolving a finding does not clear that delegation.

Every `orc/phase`, `orc/run/completed`, and `orc/run/failed` event names `actorNodeId`. A missing actor is refused, and a Peer cannot advance the workflow. A Lead may take only the task-local edges: implementation, peer settlement, review, audit, and fix. Sequencing, final review, and terminal completion stay with the Supervisor. A blocking branch finding names its task id. The Supervisor moves that task to `task_fix`, and `orc/fix/iteration` records the next iteration before review. One final-review visit accepts one branch review and one branch audit, plus a retry only when the latest result is failed, malformed, or unavailable. A later visit, after that fix loop returns, is judged on its own pair. A missing or malformed branch result still blocks completion and is not clean. Low and info findings do not block unless the run lists them in `blockingSeverities`.

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
| [`src/index.ts`](src/index.ts) | Public fold exports and `OrcService` |

`OrcState.failure` is the refusal string. `blockingSeverities` is the run's threshold. Nodes store the role prompt, skill envelope, write scope, acceptance criteria, and reporting format. Delegations store Codex envelopes and report status. `blocksProgress` is fixed when the result is recorded.

The `./invariant` companion listens for `session/event` and ignores every type outside `orc/*`. It folds the committed prefix, applies the candidate, and reports a failure when the projection refuses it. The check runs before the event is appended.

`OrcService` injects agents, sessions, session persistence, session projections, and subagents. It registers an `orc` projection and reads that projection back. A result appends only when the log row matches the correlation, stage, role, and task. Codex request events store `continuationId` after `start` returns, and a Lead or Peer node stores `messageId` after `startContinuable` returns. An open row without that handle is closed as a blocking failure and is not resumed. Tools and the released session event map stay outside this package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication and dependency isolation.
- [ORC design](../../../docs/superpowers/specs/2026-09-22-orc-superpowers-orchestration-design.md) — required lifecycle, roles, and failure behavior.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through continuable DeepSeek children and one-shot Codex runs started by OrcService; those providers own model-request assembly.

#### KV Cache effect

ORC events stay off the Supervisor derived history. Each child prompt is a separate session, so recording a delegation does not grow the Supervisor prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Live resume only** — `orc/*` is not part of the released `SessionEventMap`. The live session accepts the events. A persistence reader in this build refuses them because they are not ignorable, so recovery uses the live Supervisor log rather than a cold reopen.
- **One open child per parent, role, and task** — while that child is open, `spawn` returns it instead of creating another peer for the same task.
- **One task per reopen** — one `orc/phase` to `task_fix` reopens only the named task. `orc/fix/iteration` records that fix before review. Completion waits for the next final-review visit's clean branch pair.
- **Threshold floor** — a run can add `low` or `info` to the blocking set, and it cannot omit `critical`, `high`, or `medium`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
