---
description: "Replay a durable Supervisor, Lead, and Peer workflow from version-1 orc events."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-orc

English | [中文](README.zh.md)

## Summary

`dsh-experimental-orc` projects one Supervisor session's `orc/*` events into the role tree, task phases, Codex delegations, and findings needed to resume the workflow without reading child transcripts. It is a pure fold plus an invariant companion. It does not register tools, spawn agents, or append session events. The package is experimental and has no stability promise.

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

Call `projectOrc` or `applyOrc` with version-1 events. `emptyOrcState` is the state before `orc/workflow/created`. A refused event sets `failure` and leaves every other field as it was. Roles are `supervisor`, `lead`, and `peer`. The legal edges are Supervisor to Lead and Lead to Peer. A Peer cannot create a child. Codex is not a role node; spec, plan, review, and audit are correlated delegations.

The workflow phases are `brainstorming`, `spec_required`, `plan_required`, `awaiting_user_approval`, `task_implementation`, `task_peer_settlement`, `task_review`, `task_audit`, `task_fix`, `next_task`, `final_review`, `complete`, and `failed`. Plan approval is only `orc/plan/approval` with source `plan/review`. Blocking severities come from `orc/workflow/created`. The payload must include `critical`, `high`, and `medium`; a run may also list `low` or `info`. A non-ok review or audit result blocks progression. Blocking findings on the current iteration require `task_fix` before `next_task` or `final_review`. Resolving a finding does not clear that delegation.

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
| [`src/index.ts`](src/index.ts) | Public fold exports |

`OrcState.failure` is the refusal string. `blockingSeverities` is the run's threshold. Nodes store the role prompt, skill envelope, write scope, acceptance criteria, and reporting format. Delegations store Codex envelopes and report status. `blocksProgress` is fixed when the result is recorded.

The `./invariant` companion listens for `session/event` and ignores every type outside `orc/*`. It folds the committed prefix, applies the candidate, and reports a failure when the projection refuses it. The check runs before the event is appended.

No orchestration service is published here. Spawn, tools, and the released session event map stay outside this package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication and dependency isolation.
- [ORC design](../../../docs/superpowers/specs/2026-09-22-orc-superpowers-orchestration-design.md) — required lifecycle, roles, and failure behavior.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package only replays durable ORC events and does not assemble a model request.

#### KV Cache effect

The fold reads committed events and writes no model-request prefix, so it does not grow or invalidate a KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No orchestration service** — callers append events and perform spawn, review, and audit outside this package. The fold only accepts or refuses the log it is given.
- **Session event map** — `orc/*` is not part of the released `SessionEventMap`. The companion sees those types only when a session appends them; this package does not change the session format version.
- **Branch findings** — a blocking full-branch finding refuses completion and does not reopen a task, because the branch result carries no task id.
- **Threshold floor** — a run can add `low` or `info` to the blocking set, and it cannot omit `critical`, `high`, or `medium`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
