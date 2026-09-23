# ORC

English | [中文](orc.zh.md)

ORC projects version-1 `orc/*` events in one Supervisor Session into a durable `OrcState`. The [ORC package](../../packages/experimental/orc/README.md) owns the transition rules and configuration; the [ORC tools](../../packages/experimental/tool-orc/README.md) expose role-scoped operations to agents.

## Identity and roles

`OrcRole` is `supervisor`, `lead`, or `peer`. The Supervisor can create Leads, and a Lead can create Peers for its task; a Peer cannot create children. `OrcNodeIdentity` identifies a role node, `OrcTaskId` identifies a task, and `OrcCorrelationIdentity` identifies one delegated run or report. `OrcNode` retains its role, parent, task, prompt, skill envelope, and settlement. `OrcSpawnInput` supplies the prompt, write scope, acceptance criteria, and reporting format for a child; `OrcLaunch` returns its correlation, spawn status, and optional node id.

## State and phases

`OrcCreateWorkflowInput` creates the Supervisor root from a prompt and role instructions. `OrcWorkflowPhase` runs from brainstorming through spec, plan, approval, task implementation, task review and audit, and final review to completion or failure. `OrcState` retains the phase, role nodes, tasks, delegations, findings, and blocking severity policy. `OrcSeverity` is `critical`, `high`, `medium`, `low`, or `info`; the policy must include the first three.

## Delegated results

`OrcRegistration` describes a delegation recovered from the Supervisor log and carries a continuation only while this process owns one. `OrcResultInput` correlates a parsed Codex result with its requested stage; malformed, unavailable, or failed results block progression. `OrcReportRequest` identifies a task or branch review or audit. A blocking task finding is sent to its existing Lead for a fix, then both gates run again; the final branch pair runs after all tasks are clean. Only the Supervisor can complete the run.

Source types: [`src/types.ts`](../../packages/experimental/orc/src/types.ts) and [`src/index.ts`](../../packages/experimental/orc/src/index.ts).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxorc--orcservice"></a>

### `ctx.orc` — `OrcService`

Cordis service that appends `orc/*` events and launches correlated children. Transition legality comes from `applyOrc`. In-memory handles are not authority.

```ts cordis-catalog
/**
 * Wait until plan/review events observed so far have been applied.
 * A review that is not an approval leaves the run unapproved.
 * @returns after the queued reviews settle.
 */
planReviewSettled(): Promise<void>

/**
 * Open a Supervisor run on the caller's session.
 * @param caller - Supervisor agent. Its id becomes the root node id.
 * @param input - prompt and scope. Blocking severities are copied from config.
 * @returns the projected run.
 */
async createWorkflow(caller: Agent, input: OrcCreateWorkflowInput): Promise<OrcState>

/**
 * Read the caller's role from the Supervisor log.
 * @param caller - live agent whose id is a node id.
 * @returns the role, or undefined when the id is not in a run.
 */
roleOf(caller: Agent): OrcRole | undefined

/**
 * Read direct children from the Supervisor log.
 * @param caller - live agent whose id is a node id.
 * @returns child nodes in creation order.
 */
childrenOf(caller: Agent): readonly OrcNode[]

/**
 * Project the caller's ORC run from its Supervisor log.
 * @param caller - any agent in the run, or the Supervisor.
 * @returns the current projection.
 */
state(caller: Agent): OrcState

/**
 * Recover one delegated run from the Supervisor log.
 * @param caller - any agent in the run.
 * @param correlationId - delegation id.
 * @returns the registry row, or undefined when the log has no such id.
 */
registration(caller: Agent, correlationId: OrcCorrelationIdentity): OrcRegistration | undefined

/**
 * Open the next legal Codex spec or plan run, or return the open one.
 * A caller who is not the supervisor is refused before the fold runs.
 * @param caller - Supervisor agent.
 * @param contextRef - completed brainstorm or context reference. Blank text is refused.
 * @param signal - cancellation before the one-shot run is published.
 * @returns the correlated launch.
 */
async startSpecPlan(caller: Agent, contextRef: string, signal: AbortSignal): Promise<OrcLaunch>

/**
 * Run task review, audit, and the Lead fix until both gates are clean or one result blocks.
 * The fix callback delivers findings to the existing Lead. It does not invent a decision.
 * @param caller - Supervisor agent.
 * @param signal - cancellation for each Codex start and the Lead message.
 * @returns the projected run.
 */
runTaskLoop(caller: Agent, signal: AbortSignal): Promise<OrcState>

/**
 * Run the branch review and audit. A blocking finding is sent to that task's Lead.
 * @param caller - Supervisor agent.
 * @param signal - cancellation for each Codex start and the Lead message.
 * @returns the projected run.
 */
runFinalLoop(caller: Agent, signal: AbortSignal): Promise<OrcState>

/**
 * Assign one implementation task while approval is still open.
 * A caller who is not the supervisor is refused before the fold runs.
 * @param caller - Supervisor agent.
 * @param input - task id, write scope, and acceptance criteria.
 * @returns the projected run.
 */
async assignTask(caller: Agent, input: { readonly taskId: OrcTaskId readonly writeScope: readonly string[] readonly acceptanceCriteria: string }): Promise<OrcState>

/**
 * Create a Lead or Peer and start its continuable DeepSeek run.
 * @param caller - parent agent. The projection refuses every other edge.
 * @param input - role, task, and logged prompt fields.
 * @returns the correlated node.
 */
async spawn(caller: Agent, input: OrcSpawnInput): Promise<OrcLaunch>

/**
 * Record that the named Lead started the active task.
 * The caller must be the supervisor or the Lead that owns the task.
 * @param caller - supervisor, or the Lead named by `leadNodeId`.
 * @param input - task id and Lead node id.
 * @returns the projected run.
 */
async startTask(caller: Agent, input: { readonly taskId: OrcTaskId; readonly leadNodeId: OrcNodeIdentity }): Promise<OrcState>

/**
 * Record Lead settlement after the projection accepts it.
 * The caller must be the supervisor or the Lead that owns the task.
 * @param caller - supervisor, or the Lead named by `leadNodeId`.
 * @param input - task id, Lead node id, and evidence.
 * @returns the projected run.
 */
async settleTask(caller: Agent, input: { readonly taskId: OrcTaskId readonly leadNodeId: OrcNodeIdentity readonly evidence: string }): Promise<OrcState>

/**
 * Open a Codex review run, or return the open one for this scope.
 * A caller who is not the supervisor is refused before the fold runs.
 * @param caller - Supervisor agent.
 * @param input - task or branch scope.
 * @returns the correlated launch.
 */
async requestReview(caller: Agent, input: OrcReportRequest): Promise<OrcLaunch>

/**
 * Open a Codex audit run, or return the open one for this scope.
 * A caller who is not the supervisor is refused before the fold runs.
 * @param caller - Supervisor agent.
 * @param input - task or branch scope.
 * @returns the correlated launch.
 */
async requestAudit(caller: Agent, input: OrcReportRequest): Promise<OrcLaunch>

/**
 * Append a delegated result after the log row matches the expected run.
 * A Codex stage is refused unless the caller is the supervisor. That check runs before correlation matching.
 * @param caller - Supervisor for a Codex result, or the node recording a DeepSeek outcome.
 * @param input - correlation, stage, role, task, and result fields.
 * @returns the projected run.
 */
async recordResult(caller: Agent, input: OrcResultInput): Promise<OrcState>

/**
 * Record the fix decision for the active task.
 * The caller must be the supervisor or the Lead that owns the task.
 * @param caller - supervisor, or the Lead that owns `taskId`.
 * @param input - task id, next iteration, and decision text.
 * @returns the projected run.
 */
async recordFix(caller: Agent, input: { readonly taskId: OrcTaskId readonly iteration: number readonly decision: string readonly assigneeNodeId?: OrcNodeIdentity }): Promise<OrcState>

/**
 * Advance the workflow when the projection accepts the caller's edge.
 * @param caller - actor node.
 * @param to - requested phase.
 * @param taskId - task id when the edge names one.
 * @returns the projected run.
 */
async advance(caller: Agent, to: OrcWorkflowPhase, taskId?: OrcTaskId): Promise<OrcState>

/**
 * Record terminal failure. Only the Supervisor actor is accepted.
 * @param caller - actor node.
 * @param reason - durable failure text.
 * @returns the projected run.
 */
async fail(caller: Agent, reason: string): Promise<OrcState>

/**
 * Record terminal success after a clean branch review and audit.
 * Only the Supervisor may call this. The final-gates tool is the caller that checks the pair first.
 * @param caller - Supervisor agent.
 * @returns the projected run in `complete`.
 */
async complete(caller: Agent): Promise<OrcState>

/**
 * Blocking severities pinned by deployment config.
 * @returns the configured set. Tool arguments cannot replace it.
 */
configuredBlockingSeverities(): readonly OrcSeverity[]

/**
 * Wait until the in-process Codex final text for this correlation is recorded.
 * If storage rejected every result append, a later call retries a blocking settlement with the retained text.
 * A new process can see the open row and still have no result promise. This refuses that row instead of recording a clean report.
 * @param caller - Supervisor that owns the run.
 * @param correlationId - delegation id returned by the Codex start.
 * @returns the projected run after the parsed or blocking result is recorded.
 */
async awaitCodex(caller: Agent, correlationId: OrcCorrelationIdentity): Promise<OrcState>
```

Types: [Agent](core.md)

Source: [`packages/experimental/orc/src/index.ts`](../../packages/experimental/orc/src/index.ts)
<!-- END GENERATED cordis-surface -->
