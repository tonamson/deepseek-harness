# Agent Note: pi-ai 0.86.1 upgrade compatibility

Status: implemented

English | [中文](2026-09-21-pi-ai-0861-compatibility.zh.md)

## Problem

The pi-ai adapter classifies every upstream compatibility field at compile time, and a catalog route serves exactly the model ids the installed package ships. [pi-ai 0.86.1](https://github.com/earendil-works/pi/blob/v0.86.1/packages/ai/CHANGELOG.md) adds and removes compatibility fields, gives `mistral-conversations` a compat type of its own, narrows `ToolCall.arguments` to `JsonObject`, hands provider entry points a branded `TranscriptContext`, and renames the DeepSeek catalog flash id. Upgrading without touching the adapter fails the host build at the drift gates and leaves every pi-ai route test that names the old DeepSeek id without a model. The bump is driven by OpenCode Go serving `deepseek-v4.1-flash`, a model the 0.85.1 catalog cannot offer.

## Decision

The adapter follows pi-ai 0.86.1: `packages/llm/llm-pi-ai/package.json` requires `^0.86.1`, the lockfile resolves it beside `@earendil-works/pi-telemetry@0.86.1`, and `pnpm-workspace.yaml` exempts both from the release-age policy. The webworker stub's provider-id table is rewritten from that version's `getBuiltinProviders()` — 41 ids, adding `meta` and `radius`.

Every field 0.86 adds stays catalog-owned (withheld), because upstream's generated catalog enables it only for the exact models and transports it verified: `supportsMidConvoSystemMessages` and `supportsMidConvoToolAdditions` on `openai-completions`, `supportsMidConvoSystemMessages` on `openai-responses`, and `sessionAffinityFormat`, `supportsMidConvoSystemMessages`, and `supportsMidConvoToolChanges` on `anthropic-messages`. The fields 0.86 removes — `deferredToolsMode` and `supportsToolReferences` — leave the gates.

`Model.compat` now gives `mistral-conversations` a compat type, so `COMPAT_GATES` gains `MISTRAL_CONVERSATIONS_COMPAT_GATE`. The `ApiWithCompat` derivation is what forced the entry: a protocol pi-ai gives a compat type fails the `Record` until someone classifies its fields, and this protocol's single field is catalog-owned like its siblings.

`ToolCall.arguments` is `JsonObject`, so `parseArguments` returns that type instead of `Record<string, unknown>`. The values remain `JSON.parse` output of the durable tool-call text, so replay behavior is unchanged.

Provider entry points (`ProviderStreams.stream` and `streamSimple`) take the branded `TranscriptContext` that only `normalizeContext()` produces, while `Models.stream*` still accepts the plain `Context` and normalizes internally. `toPiContext` therefore keeps returning `Context`; only the test that calls a provider directly normalizes.

The pi-ai `deepseek` catalog route serves `deepseek-flash` (DeepSeek V4.1 Flash, now multimodal) in place of `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`. Specs that resolve that route follow the new id, and the text-only capability assertion moves to `deepseek-v4-pro`, which keeps text-only input.

The two provider-directory goldens gain `meta` and `radius` in catalog order.

## Alternatives considered

**Stay on 0.85.1 and declare `deepseek-v4.1-flash` in `settings.yaml`.** A configured `models` list replaces the route's whole catalog rather than extending it, so the deployment would restate every model it keeps and hand-maintain the new one's capacities and pricing against a catalog that keeps moving.

**Bump without reclassifying the new fields.** The gates exist to force the classification decision; casting past them ships a compatibility field nobody decided about, which is the silent drift the `Record` key type prevents.

**Expose the mid-conversation fields as deployment switches.** Upstream enables them only for models verified against the exact transport, so a gateway claiming them would assert a capability nothing checked; the adapter's rule is that a catalog-owned field is named by naming the catalog route.

**Hand-declare `deepseek-v4-flash` on the pi-ai `deepseek` route to keep the old vocabulary.** The endpoint renamed the model, so the hand-declared id would send a retired name to the provider and freeze cost and capability metadata the catalog now maintains.

## Consequences

OpenCode Go now serves `deepseek-v4.1-flash`, which is what the bump was for; the same release also adds it to OpenCode, OpenRouter, Together, Baseten, Hugging Face, and the Qwen token plans.

A deployment that named `deepseek-v4-flash` on a catalog `deepseek` route must move to `deepseek-flash`. No shipped default changes: the harness's own DeepSeek routes and the `deepseek-official` model vocabulary keep `deepseek-v4-flash`.

Recorded session fixtures are untouched. They were recorded against `deepseek-official` and replayed by model id, so catalog membership never enters.

Verification: the host TypeScript build (`tsc -b tsconfig.host.json`), the `llm-pi-ai` suite (325 tests), the extended [compatibility tests](../../../../packages/llm/llm-pi-ai/tests/compat-upgrade.spec.ts) (25 tests), and the two web provider-directory goldens through the browser lane (`vitest --config vitest.web.config.ts`, 14 tests).

The 0.85.1 note stays active and cross-linked: its rationale for which fields are deployment controls still governs, while its version and field set do not.
