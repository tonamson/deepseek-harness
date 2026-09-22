---
description: "Role-scoped ORC tools and Superpowers prompt envelopes over ctx.orc."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-orc

English | [中文](README.zh.md)

## Summary

This package lets a model open and advance a Supervisor, Lead, and Peer workflow through one stable tool catalog. Every role receives the same schemas. `OrcService` accepts or refuses the call. Choose it when an explicit ORC profile should delegate spec and plan work to Codex and implementation to DeepSeek children. The package is experimental and has no stability promise.

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

Add this package on top of `@deepseek-ai/dsh-experimental-orc`. The plugin takes no config. Provider, model, and effort stay on the ORC service config. Once mounted, every agent gets the same ORC tools and a role section. A Peer call that spawns, approves a plan, requests Codex, or advances another task fails at execution. The prompt text does not grant that authority.

### When to choose it

Choose it for an opt-in Supervisor workflow. Do not mount it on a profile that should keep flat Agent Teams behavior. `tool-agent-team` is unchanged.

### Smallest working example

Load the ORC service, then this plugin:

```yaml
- id: tool-orc
  name: '@deepseek-ai/dsh-experimental-tool-orc'
```

The service config supplies the DeepSeek route, the four Codex routes, the repository path, the skill workflow text, and the expected result text for each Codex stage.

### What the model can do

The catalog is one list for every role:

- **Open and supervise** — `orc_create_workflow`, `orc_request_spec_plan`, `orc_assign_task`, `orc_request_review`, `orc_request_audit`, `orc_run_task_gates`, `orc_run_final_gates`, `orc_advance`, and `orc_fail`.
- **Create and settle** — `orc_spawn`, `orc_start_task`, and `orc_settle_task`.
- **Report** — `orc_record_result` records a DeepSeek node only. Codex spec, plan, review, and audit results are not a model tool. `orc_record_fix` records a fix decision.

`orc_request_spec_plan` takes `context_ref` and is the only call that enters `spec_required` or `plan_required`. No ORC tool accepts an approval decision. `orc_run_task_gates` and `orc_run_final_gates` send blocking findings to the existing Lead. Review and audit stay separate. A malformed or missing Codex result stays a service failure.

### Logged model input

`orc_create_workflow` and `orc_spawn` pass `prompt` and `skillEnvelope` into the service, which appends them on `orc/workflow/created` or `orc/node/created` and sends them to the DeepSeek child. Codex tools call `startSpecPlan`, `requestReview`, or `requestAudit`. Those methods send `renderCodexEnvelope` text built from the logged envelope fields and the run's `blockingSeverities`. They do not pass an `outputSchema` option. Native Codex children do not inherit DSH skills, tools, or context; the envelope is the task text.

### What success and failure look like

A successful call returns compact JSON with the phase or the correlation id. A refused call is a tool error. `ORC_UNAUTHORIZED` means this role cannot perform the operation. `ORC_INVALID_INPUT` means an id or list was empty, before the service ran. `ORC_REFUSED` repeats the service message, including `peer cannot spawn a child` and `peer cannot advance the workflow`. An unknown phase or stage is `INVALID_ARGS` from the schema and does not append an event.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter registers the same `defineTool` schemas on each agent scope. Execution reads `ctx.orc` and throws `OrcToolError` for a malformed id or a role the service does not itself reject, such as a Peer requesting Codex. Spawn, advance, and fail go to the service, which remains the transition authority.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, role sections, DeepSeek child prompts, and the tool catalog |

No runtime invariant companion is published. The ORC projection and `OrcService` own the durable relations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [orc package](../orc/README.md) — the service, fold, and Codex envelope these tools call.

-----

<a id="model-experience"></a>
## Model Experience

### ORC system prompt

#### What the model sees

Each agent gets one `orc:role` section. The text states `role`, `parent`, `authority`, `phase`, `task`, and `mandatory Superpowers skills`. Supervisor, Lead, and Peer sections differ. The section also carries the Superpowers workflow requirements for that role, or the unassigned sentence before a run exists. DeepSeek child prompts logged by `orc_spawn` repeat the role section plus `skillCatalog: using-superpowers, brainstorming, writing-plans, subagent-driven-development, test-driven-development, requesting-code-review, verification-before-completion`. Codex text is separate and says `Native Codex children do not inherit DSH skills or context.` Tool schemas stay complete across roles; execution returns `ORC_UNAUTHORIZED` or `ORC_REFUSED` for a call the role cannot make. Approval is a logged `plan/review` event, not a tool argument.

##### Role section

```markdown
role: peer
parent: lead-1
authority: may perform the assigned responsibility and report evidence; may not create children, invoke Codex, approve a plan, skip review or audit, or advance the workflow
phase: task_implementation
task: task-a
mandatory Superpowers skills: test-driven-development, verification-before-completion
```

#### Token effect

The role section is rendered on each assembly from the projected run, so a phase change rewrites that section. Tool schemas are a fixed per-request cost and do not change with role. Child prompts and Codex envelopes are separate requests, not extra Supervisor system text.

#### KV Cache effect

A phase, task, or role change rewrites `orc:role` and invalidates the system prefix from that section onward. The tool schema list stays stable across those changes, so schema tokens after an unchanged prefix can still be reused. Codex requests are new one-shot prompts and do not extend the DeepSeek prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Approval is not a tool** — the service copies `approved` or `rejected` only from a version-1 `plan/review` event on the Supervisor session. `dismissed`, `/plan off`, and `plan/mode` do not approve.
- **Prompt text is not authority** — the section tells the model its role. `OrcService` still refuses a Peer spawn or phase change.
- **Native Codex children are outside DSH** — they do not inherit skills, tools, or session context. Only the envelope text reaches them.
- **Experimental prototype with no stability promise** — schemas can change while the package incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
