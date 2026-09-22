---
description: "Opt-in profile layer that mounts the strict Supervisor, Lead, and Peer workflow."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-orc-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-orc-profile` is an opt-in profile layer that mounts [ORC](../orc/README.md) and its [tools](../tool-orc/README.md) after `@deepseek-ai/dsh-base`. The patch sets the DeepSeek and Codex routes. No shipped profile enables it. Add it to a profile that should run the strict workflow. The standard agent preset does not name this package.

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

Add the package to an initialized profile, then select the coding preset whose persona calls `orc_request_spec_plan` and `exit_plan_mode`:

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-orc-profile
```

The profile must already contain `@deepseek-ai/dsh-base` and the Codex provider rows named `codex-spec`, `codex-review`, and `codex-audit`. Removing the package removes the bundle from the profile's layer list.

The configured routes are `deepseek-official` / `deepseek-flash` / `high` for Supervisor, Lead, and Peer; `gpt-5.6-terra` / `high` for spec and plan; `gpt-5.6-luna` / `high` for review; and `gpt-5.6-luna` / `xhigh` for audit. `repositoryPath` is `.`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runtime content is [`cordis.patch.yml`](cordis.patch.yml). It inserts the ORC service and the tool plugin. It does not disable the standard preset's tools.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Route config and plugin rows |
| [`src/index.ts`](src/index.ts) | Empty module entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ORC service](../orc/README.md) — phase rules and Codex settlement.
- [ORC tools](../tool-orc/README.md) — the model-facing catalog.
- [Experimental packages](../README.md) — publication policy.

-----

<a id="model-experience"></a>
## Model Experience

### ORC routes

#### What the model sees

The persona and tool catalog belong to the agent preset and [`@deepseek-ai/dsh-experimental-tool-orc`](../tool-orc/README.md). This bundle only publishes the service config those tools read.

#### KV Cache effect

None from this package. Child prompts are separate sessions.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Codex provider rows are not registered here. A profile without `codex-spec`, `codex-review`, and `codex-audit` cannot start those runs. The patch does not change a profile that has not added this bundle.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
