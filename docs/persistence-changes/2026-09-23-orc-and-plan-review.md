---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-orc-and-plan-review

English | [中文](2026-09-23-orc-and-plan-review.zh.md)

## Summary

Adds plan/review and the orc/* session events for the ORC workflow.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-orc-and-plan-review
baseline: false
changes:
  - root: "event:orc/audit/requested"
    previous: null
    after: "3fa1c82891b73cf92c549d5cf4c7454109cb662b76a749596a69c6497a1c9a53"
    decision: same-version
  - root: "event:orc/audit/result"
    previous: null
    after: "ca99a6e6d6b11f6df819e5665e2a5b6331cce44a9ae498db816510336f42bdf9"
    decision: same-version
  - root: "event:orc/finding/resolved"
    previous: null
    after: "284d8d0fa51bd0c8b99bf9f57e1605c5796e084ee99a1b07964334fb892188fe"
    decision: same-version
  - root: "event:orc/fix/iteration"
    previous: null
    after: "96bff6d4a7cbafe4bb36d6e27536247e49f91251e0d01c1d7d68856402d3abe1"
    decision: same-version
  - root: "event:orc/node/created"
    previous: null
    after: "4338b079feed6596587eaa4640ee0d192bddb41d2d2d9ea2815a2524d45dac07"
    decision: same-version
  - root: "event:orc/node/settled"
    previous: null
    after: "a36dbf1471dcfa06c8e0f98d56d54897be26b6871843625bad7ed676c1609499"
    decision: same-version
  - root: "event:orc/phase"
    previous: null
    after: "f9247bba55214a3dada2ae8288e6ffdb208bf1f95e0ff3a77696b5ec91fce023"
    decision: same-version
  - root: "event:orc/plan/approval"
    previous: null
    after: "b461c28b1c37dc73bb65274515c90fa213fb625b300a509f587b9dbe66acf5d8"
    decision: same-version
  - root: "event:orc/plan/requested"
    previous: null
    after: "5481a21e1acaf0054dc895dc55beae0bc0862272e7abe8e8368986c2bc6557db"
    decision: same-version
  - root: "event:orc/plan/result"
    previous: null
    after: "765b5bcfbc43b0f5e97ba397211c001115c56c70ed1509bad74a3bf097a43e53"
    decision: same-version
  - root: "event:orc/review/requested"
    previous: null
    after: "dc5583c1edb3c2e0dc89ef950b543dbcd45c09bfdef4a4e1495331555c2c1d02"
    decision: same-version
  - root: "event:orc/review/result"
    previous: null
    after: "4542a82b9afb8e9de2a05792cfa1d20db6d9768d1566fab41dcf7ef86015ddcb"
    decision: same-version
  - root: "event:orc/run/completed"
    previous: null
    after: "42e7eea47917b263695a1e120708f9d82ac464623b81f02a1197ba7c8fbeeb7f"
    decision: same-version
  - root: "event:orc/run/failed"
    previous: null
    after: "06e69ae88bb10ae16e258c337b93737b269f342acd5b937b93b34c0e8431a2d5"
    decision: same-version
  - root: "event:orc/spec/requested"
    previous: null
    after: "881c684de5a471f47e40f0683a54e2fd5114f81c11fdc36207a795321dc9c49e"
    decision: same-version
  - root: "event:orc/spec/result"
    previous: null
    after: "dd8e7921567f741927c3de987a9debf86188991ff6bf0db23c6b1e8ce8c8ddd7"
    decision: same-version
  - root: "event:orc/task/assigned"
    previous: null
    after: "ec0627a65514bdaa92e61a7ba71faf1df0faa69f093cb385dcde826e2f912592"
    decision: same-version
  - root: "event:orc/task/settled"
    previous: null
    after: "dc9fd718619631987854956005a66722f4438d94864fa8a7c08ba145b4160d12"
    decision: same-version
  - root: "event:orc/task/started"
    previous: null
    after: "ee0bd7b2540d178a9bc32ff767e427888f2fde73762413915ec6409fd364bea0"
    decision: same-version
  - root: "event:orc/workflow/created"
    previous: null
    after: "957ac530b3edb18c6d7493c37fd0d4ee31903f218b5fd676f9d15afebaac1ae8"
    decision: same-version
  - root: "event:plan/review"
    previous: null
    after: "2f30fec050667e41cf2da3250324f1d5505567581ed3910f2062dd4bd8f63e94"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New roots in Session format version 3. Existing logs contain none of these events and stay valid. A reader that does not know a type refuses a log that carries it, because these events are required on read. contextRef is required on version-1 orc/spec/requested and orc/plan/requested; those bodies have no earlier optional form. SESSION_FORMAT_VERSION stays 3.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/orc packages/experimental/tool-orc packages/experimental/orc-profile: 98 tests passed. DSH_EXAMPLE_MODE=lib replay of snapshots/session/orc-superpowers passed twice, including spec, plan, plan/review approval, Lead, Peer, review, audit, and the fix iteration.

<a id="dev-note"></a>
## Dev Note

None.
