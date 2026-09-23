# ORC

[English](orc.md) | 中文

ORC 将一个 Supervisor Session 中的版本 1 `orc/*` 事件投影为持久的 `OrcState`。[ORC 包](../../packages/experimental/orc/README.zh.md)负责状态转换规则和配置；[ORC 工具](../../packages/experimental/tool-orc/README.zh.md)向 agent 提供按角色限制的操作。

## 身份与角色

`OrcRole` 为 `supervisor`、`lead` 或 `peer`。Supervisor 可以创建 Lead；Lead 可以为自己的任务创建 Peer；Peer 不能创建子节点。`OrcNodeIdentity` 标识角色节点，`OrcTaskId` 标识任务，`OrcCorrelationIdentity` 标识一次委派运行或报告。`OrcNode` 保留角色、父节点、任务、提示词、技能说明和结算状态。`OrcSpawnInput` 提供子节点的提示词、写入范围、验收条件和报告格式；`OrcLaunch` 返回关联标识、启动状态和可选的节点标识。

## 状态与阶段

`OrcCreateWorkflowInput` 根据提示词和角色指令创建 Supervisor 根节点。`OrcWorkflowPhase` 从头脑风暴依次经过规格、计划、审批、任务实现、任务审查与审计以及最终审查，到达完成或失败。`OrcState` 保留阶段、角色节点、任务、委派、发现和阻断严重程度策略。`OrcSeverity` 为 `critical`、`high`、`medium`、`low` 或 `info`；策略必须包含前三种。

## 委派结果

`OrcRegistration` 描述从 Supervisor 日志恢复的委派；仅当本进程仍持有续接句柄时才包含该句柄。`OrcResultInput` 将已解析的 Codex 结果与请求阶段关联；格式错误、不可用或失败的结果会阻断推进。`OrcReportRequest` 标识任务级或分支级审查与审计。阻断性任务发现交给原 Lead 修复，随后重新运行两项检查；所有任务通过后才运行最终分支检查。只有 Supervisor 可以完成运行。

类型来源：[`src/types.ts`](../../packages/experimental/orc/src/types.ts) 和 [`src/index.ts`](../../packages/experimental/orc/src/index.ts)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/orc/src/index.ts`](../../packages/experimental/orc/src/index.ts)
<!-- END GENERATED cordis-surface -->
