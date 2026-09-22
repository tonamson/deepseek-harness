/** Durable ORC identities, lifecycle states, and version-1 event payloads. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one ORC run stored in the Supervisor session. */
export type OrcRunId = Branded<'OrcRunId'>

/** Identity of one Supervisor, Lead, or Peer node. */
export type OrcNodeId = Branded<'OrcNodeId'>

/** Identity of one implementation task inside an ORC run. */
export type OrcTaskId = Branded<'OrcTaskId'>

/** Identity of one review or audit finding. */
export type OrcFindingId = Branded<'OrcFindingId'>

/** Identity of one delegated spec, plan, review, audit, or child run. */
export type OrcCorrelationId = Branded<'OrcCorrelationId'>

/** DeepSeek work role. Codex workers are not ORC nodes. */
export type OrcRole = 'supervisor' | 'lead' | 'peer'

/**
 * Supervisor lifecycle.
 * `failed` is the terminal failure phase. `complete` is the only success terminal.
 */
export type OrcWorkflowPhase =
  | 'brainstorming'
  | 'spec_required'
  | 'plan_required'
  | 'awaiting_user_approval'
  | 'task_implementation'
  | 'task_peer_settlement'
  | 'task_review'
  | 'task_audit'
  | 'task_fix'
  | 'next_task'
  | 'final_review'
  | 'complete'
  | 'failed'

/** Lifecycle of one role node. */
export type OrcNodePhase = 'active' | 'settled' | 'failed'

/** Lifecycle of one implementation task. */
export type OrcTaskPhase =
  | 'assigned'
  | 'started'
  | 'unsettled'
  | 'settled'
  | 'review'
  | 'audit'
  | 'fix'
  | 'clean'
  | 'failed'

/** Finding severity. Only `critical`, `high`, and `medium` block unless the run raises the set. */
export type OrcSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** Whether a recorded finding is still open. */
export type OrcFindingStatus = 'open' | 'resolved'

/** Outcome of a delegated report. Anything other than `ok` blocks progression. */
export type OrcReportStatus = 'ok' | 'failed' | 'malformed' | 'unavailable'

/** Kind of one correlated delegation. */
export type OrcDelegationKind = 'codex-spec' | 'codex-plan' | 'codex-review' | 'codex-audit' | 'deepseek-node'

/** Open request or a settled report. */
export type OrcDelegationStatus = 'open' | OrcReportStatus

/** How far a review or audit request applies. */
export type OrcReviewScope = 'task' | 'branch'

/** Settlement outcome for a role node. */
export type OrcNodeOutcome = 'settled' | 'failed' | 'timeout' | 'cancelled' | 'incomplete'

/** Version-1 event type owned by the ORC projection. */
export type OrcEventType = keyof OrcEventMap

/** One role node needed to resume the tree without reading a child transcript. */
export interface OrcNode {
  readonly id: OrcNodeId
  readonly parentId?: OrcNodeId
  readonly role: OrcRole
  readonly phase: OrcNodePhase
  readonly taskId?: OrcTaskId
  readonly correlationId?: OrcCorrelationId
  readonly prompt: string
  readonly skillEnvelope: string
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
  readonly reportingFormat: string
  readonly outcome?: OrcNodeOutcome
  readonly evidence?: string
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
}

/** One implementation task and the fix iteration currently in force. */
export interface OrcTask {
  readonly id: OrcTaskId
  readonly phase: OrcTaskPhase
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
  readonly iteration: number
  readonly leadNodeId?: OrcNodeId
  readonly evidence?: string
  readonly fixDecision?: string
}

/** One finding recorded from a review or audit result. */
export interface OrcFinding {
  readonly id: OrcFindingId
  readonly severity: OrcSeverity
  readonly status: OrcFindingStatus
  readonly summary: string
  readonly correlationId: OrcCorrelationId
  readonly scope: OrcReviewScope
  readonly iteration: number
  readonly taskId?: OrcTaskId
  readonly file?: string
  readonly location?: string
  readonly evidence?: string
  readonly remediation?: string
  /** Review or audit stage that produced the finding. */
  readonly sourceStage?: 'codex-review' | 'codex-audit'
}

/**
 * One delegated run.
 * `blocksProgress` is fixed when the result is recorded. Later finding resolution does not clear it.
 */
export interface OrcDelegation {
  readonly correlationId: OrcCorrelationId
  readonly kind: OrcDelegationKind
  readonly status: OrcDelegationStatus
  readonly scope: 'workflow' | OrcReviewScope
  readonly iteration: number
  readonly blocksProgress: boolean
  readonly taskId?: OrcTaskId
  readonly nodeId?: OrcNodeId
  readonly role?: string
  readonly repositoryPath?: string
  readonly skillRequirements?: string
  readonly outputSchema?: string
  readonly readOnly?: true
  readonly prompt?: string
  readonly skillEnvelope?: string
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly text?: string
  /** Codex final text before normalization. Present once that answer is recorded. */
  readonly rawText?: string
  /**
   * Codex subagent run id. Present only after `start` returned.
   * An open row without it is not a running child.
   */
  readonly continuationId?: string
  /**
   * Continuable inbox message id. Present only after `startContinuable` returned.
   * DeepSeek `nodeId` is the child session id.
   */
  readonly messageId?: string
  /** Completed brainstorm or context reference copied from a spec or plan request. */
  readonly contextRef?: string
  readonly findingIds: readonly OrcFindingId[]
}

/**
 * Complete ORC projection.
 * `failure` is a refused transition and leaves every other field unchanged.
 */
export interface OrcState {
  readonly runId?: OrcRunId
  readonly phase?: OrcWorkflowPhase
  readonly blockingSeverities: readonly OrcSeverity[]
  readonly nodes: readonly OrcNode[]
  readonly tasks: readonly OrcTask[]
  readonly activeTaskId?: OrcTaskId
  readonly findings: readonly OrcFinding[]
  readonly delegations: readonly OrcDelegation[]
  readonly approval?: 'approved' | 'rejected'
  readonly specText?: string
  readonly planText?: string
  readonly terminalReason?: string
  /**
   * Final-review visit, starting at 0 on the first entry and increasing on each return.
   * Branch report iterations must match this visit.
   */
  readonly branchVisit?: number
  readonly failure?: string
}

/** Caller-supplied model selection copied onto a delegation. Never invented by the reducer. */
export interface OrcProviderSelection {
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
}

/** Explicit Codex envelope persisted so a native child does not inherit DSH context implicitly. */
export interface OrcCodexEnvelope extends OrcProviderSelection {
  readonly role: 'spec-only' | 'plan-only' | 'review-only' | 'audit-only'
  readonly repositoryPath: string
  readonly skillRequirements: string
  readonly outputSchema: string
  readonly readOnly: true
  /** Subagent run id. Omitted when the request is recorded before start returns. */
  readonly continuationId?: string
}

/** Version-1 payload that opens a run and its Supervisor root. */
export interface OrcWorkflowCreated extends OrcProviderSelection {
  readonly version: 1
  readonly runId: OrcRunId
  readonly blockingSeverities: readonly OrcSeverity[]
  readonly supervisorNodeId: OrcNodeId
  readonly prompt: string
  readonly skillEnvelope: string
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
  readonly reportingFormat: string
}

/** Version-1 payload that creates a Lead or Peer under an existing parent. */
export interface OrcNodeCreated extends OrcProviderSelection {
  readonly version: 1
  readonly runId: OrcRunId
  readonly nodeId: OrcNodeId
  readonly parentId: OrcNodeId
  readonly role: 'lead' | 'peer'
  readonly taskId: OrcTaskId
  readonly correlationId: OrcCorrelationId
  readonly prompt: string
  readonly skillEnvelope: string
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
  readonly reportingFormat: string
  /** Inbox message id. Omitted when the node is recorded before startContinuable returns. */
  readonly messageId?: string
}

/** Version-1 payload that settles a role node. */
export interface OrcNodeSettled {
  readonly version: 1
  readonly runId: OrcRunId
  readonly nodeId: OrcNodeId
  readonly outcome: OrcNodeOutcome
  readonly evidence?: string
}

/** Version-1 Codex spec request. */
export interface OrcSpecRequested extends OrcCodexEnvelope {
  readonly version: 1
  readonly runId: OrcRunId
  readonly correlationId: OrcCorrelationId
  /** Completed brainstorm or context reference. Prompt text is not a substitute. */
  readonly contextRef: string
  readonly role: 'spec-only'
}

/** Version-1 Codex spec result. */
export interface OrcSpecResult {
  readonly version: 1
  readonly runId: OrcRunId
  readonly correlationId: OrcCorrelationId
  readonly status: OrcReportStatus
  readonly specText?: string
  /** Codex final text before normalization. */
  readonly rawText?: string
}

/** Version-1 Codex plan request. */
export interface OrcPlanRequested extends OrcCodexEnvelope {
  readonly version: 1
  readonly runId: OrcRunId
  readonly correlationId: OrcCorrelationId
  /** Completed brainstorm or context reference. Prompt text is not a substitute. */
  readonly contextRef: string
  readonly role: 'plan-only'
}

/** Version-1 Codex plan result. */
export interface OrcPlanResult {
  readonly version: 1
  readonly runId: OrcRunId
  readonly correlationId: OrcCorrelationId
  readonly status: OrcReportStatus
  readonly planText?: string
  /** Codex final text before normalization. */
  readonly rawText?: string
}

/** Version-1 explicit plan approval. This is not a plan-mode flag. */
export interface OrcPlanApproval {
  readonly version: 1
  readonly runId: OrcRunId
  readonly decision: 'approved' | 'rejected'
  readonly source: 'plan/review'
}

/** Version-1 task assignment. */
export interface OrcTaskAssigned {
  readonly version: 1
  readonly runId: OrcRunId
  readonly taskId: OrcTaskId
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
}

/** Version-1 task start, naming the Lead that owns the task. */
export interface OrcTaskStarted {
  readonly version: 1
  readonly runId: OrcRunId
  readonly taskId: OrcTaskId
  readonly leadNodeId: OrcNodeId
}

/** Version-1 Lead task settlement. */
export interface OrcTaskSettled {
  readonly version: 1
  readonly runId: OrcRunId
  readonly taskId: OrcTaskId
  readonly leadNodeId: OrcNodeId
  readonly evidence: string
}

/** Version-1 review or audit request. */
export interface OrcReviewRequested extends OrcCodexEnvelope {
  readonly version: 1
  readonly runId: OrcRunId
  readonly correlationId: OrcCorrelationId
  readonly scope: OrcReviewScope
  readonly iteration: number
  readonly taskId?: OrcTaskId
}

/**
 * One finding carried by a review or audit result before it is stored.
 * A blocking branch finding names the task it reopens.
 */
export interface OrcFindingInput {
  readonly id: OrcFindingId
  readonly severity: OrcSeverity
  readonly summary: string
  readonly taskId?: OrcTaskId
  readonly file?: string
  readonly location?: string
  readonly evidence?: string
  readonly remediation?: string
  /** Review or audit stage that produced the finding. It must match the result event. */
  readonly sourceStage?: 'codex-review' | 'codex-audit'
}

/** Version-1 review or audit result. */
export interface OrcReviewResult {
  readonly version: 1
  readonly runId: OrcRunId
  readonly correlationId: OrcCorrelationId
  readonly status: OrcReportStatus
  readonly findings: readonly OrcFindingInput[]
  /** Codex final text before normalization. */
  readonly rawText?: string
}

/** Version-1 finding resolution. Resolution does not by itself advance the run. */
export interface OrcFindingResolved {
  readonly version: 1
  readonly runId: OrcRunId
  readonly findingId: OrcFindingId
}

/** Version-1 fix-loop decision for one task. */
export interface OrcFixIteration {
  readonly version: 1
  readonly runId: OrcRunId
  readonly taskId: OrcTaskId
  readonly iteration: number
  readonly decision: string
  readonly assigneeNodeId?: OrcNodeId
}

/**
 * Version-1 guarded phase transition.
 * `actorNodeId` is the node advancing the workflow. A Peer cannot.
 * A Lead may take only the task-local edges. Sequencing, final review, and completion stay with the Supervisor.
 */
export interface OrcPhaseTransition {
  readonly version: 1
  readonly runId: OrcRunId
  readonly to: OrcWorkflowPhase
  readonly actorNodeId: OrcNodeId
  readonly taskId?: OrcTaskId
}

/** Version-1 terminal failure. Only the Supervisor may record it. */
export interface OrcRunFailed {
  readonly version: 1
  readonly runId: OrcRunId
  readonly actorNodeId: OrcNodeId
  readonly reason: string
}

/** Version-1 terminal completion. Only the Supervisor may record it. */
export interface OrcRunCompleted {
  readonly version: 1
  readonly runId: OrcRunId
  readonly actorNodeId: OrcNodeId
}

/** Version-1 ORC payloads keyed by event type. */
export interface OrcEventMap {
  'orc/workflow/created': OrcWorkflowCreated
  'orc/node/created': OrcNodeCreated
  'orc/node/settled': OrcNodeSettled
  'orc/spec/requested': OrcSpecRequested
  'orc/spec/result': OrcSpecResult
  'orc/plan/requested': OrcPlanRequested
  'orc/plan/result': OrcPlanResult
  'orc/plan/approval': OrcPlanApproval
  'orc/task/assigned': OrcTaskAssigned
  'orc/task/started': OrcTaskStarted
  'orc/task/settled': OrcTaskSettled
  'orc/review/requested': OrcReviewRequested
  'orc/review/result': OrcReviewResult
  'orc/audit/requested': OrcReviewRequested
  'orc/audit/result': OrcReviewResult
  'orc/finding/resolved': OrcFindingResolved
  'orc/fix/iteration': OrcFixIteration
  'orc/phase': OrcPhaseTransition
  'orc/run/failed': OrcRunFailed
  'orc/run/completed': OrcRunCompleted
}

/** One version-1 ORC log event. The session envelope is not part of this package. */
export type OrcEvent = {
  [Type in OrcEventType]: {
    readonly type: Type
    readonly data: OrcEventMap[Type]
  }
}[OrcEventType]
