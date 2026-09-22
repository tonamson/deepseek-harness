/** Public ORC entry: the durable fold and the Cordis orchestration service. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { z } from 'zod'
import { renderCodexEnvelope } from './envelope.ts'
import {
  applyOrc,
  emptyOrcState,
  isOrcEventType,
  OrcCorrelationId,
  OrcNodeId,
  OrcRunId,
} from './projection.ts'
import type {
  OrcCorrelationId as OrcCorrelationIdentity,
  OrcDelegation,
  OrcDelegationKind,
  OrcEvent,
  OrcFindingInput,
  OrcNode,
  OrcNodeId as OrcNodeIdentity,
  OrcNodeOutcome,
  OrcReportStatus,
  OrcReviewScope,
  OrcRole,
  OrcSeverity,
  OrcState,
  OrcTaskId,
  OrcWorkflowPhase,
} from './types.ts'

export type * from './types.ts'
export {
  OrcCorrelationId,
  OrcFindingId,
  OrcNodeId,
  OrcRunId,
  OrcTaskId,
  applyOrc,
  emptyOrcState,
  isOrcEventType,
  projectOrc,
} from './projection.ts'
export { renderCodexEnvelope } from './envelope.ts'
export type { OrcCodexEnvelopeText } from './envelope.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    orc: OrcService
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    orc: OrcState
  }
}

const routeSchema = z.object({
  subagentProvider: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1),
}).strict()

const configSchema = z.object({
  deepseek: routeSchema,
  codexSpec: routeSchema,
  codexPlan: routeSchema,
  codexReview: routeSchema,
  codexAudit: routeSchema,
  repositoryPath: z.string().min(1),
  skillRequirements: z.string().min(1),
  specOutputSchema: z.string().min(1),
  planOutputSchema: z.string().min(1),
  reviewOutputSchema: z.string().min(1),
  auditOutputSchema: z.string().min(1),
}).strict()

/** Validated deployment routes. Execution copies these fields and does not invent models. */
export type OrcServiceConfig = z.infer<typeof configSchema>

/** One configured provider, model, and effort triple. */
export type OrcRouteConfig = z.infer<typeof routeSchema>

/** Fields copied into a Supervisor root. */
export interface OrcCreateWorkflowInput {
  readonly prompt: string
  readonly skillEnvelope: string
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
  readonly reportingFormat: string
  readonly blockingSeverities: readonly OrcSeverity[]
}

/** Lead or Peer creation. The projection accepts only Supervisor → Lead and Lead → Peer. */
export interface OrcSpawnInput {
  readonly role: 'lead' | 'peer'
  readonly taskId: OrcTaskId
  readonly prompt: string
  readonly skillEnvelope: string
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
  readonly reportingFormat: string
  readonly signal: AbortSignal
}

/** Task or branch Codex review/audit request. */
export interface OrcReportRequest {
  readonly scope: OrcReviewScope
  readonly taskId?: OrcTaskId
  readonly signal: AbortSignal
}

/**
 * Correlated child result.
 * `stage`, `role`, and `taskId` must match the open delegation before any event is appended.
 */
export interface OrcResultInput {
  readonly correlationId: OrcCorrelationIdentity
  readonly stage: OrcDelegationKind
  readonly role: string
  readonly taskId?: OrcTaskId
  readonly status?: OrcReportStatus
  readonly text?: string
  readonly findings?: readonly OrcFindingInput[]
  readonly outcome?: OrcNodeOutcome
  readonly evidence?: string
}

/** Handle returned when a child run is opened or recovered. */
export interface OrcLaunch {
  readonly correlationId: OrcCorrelationIdentity
  readonly kind: OrcDelegationKind
  readonly spawned: boolean
  readonly nodeId?: OrcNodeIdentity
}

/** Delegated run recovered from the Supervisor log, with a live handle when this process still has one. */
export interface OrcRegistration {
  readonly correlationId: OrcCorrelationIdentity
  readonly parentId: OrcNodeIdentity
  readonly role: string
  readonly taskId?: OrcTaskId
  readonly stage: OrcDelegationKind
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly nodeId?: OrcNodeIdentity
  /** Absent when the log has no handle from a finished child start. */
  readonly continuation?: {
    readonly kind: 'continuable' | 'one-shot'
    readonly id: string
    readonly messageId?: string
  }
}

interface LiveContinuation {
  readonly kind: 'continuable' | 'one-shot'
  readonly id: string
  readonly messageId?: string
}

/** Thrown when the projection refuses a transition or the service cannot record it. */
export class OrcError extends Error {
  /** Stable refusal code. Service and tool results route on this, not on message text. */
  readonly code = 'ORC_REFUSED' as const

  /**
   * @param message - projection refusal or append failure.
   * @param options - optional cause.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OrcError'
  }
}

const orcProjectionDefinition = {
  key: 'orc' as const,
  stateVersion: 1,
  stateSchema: z.any() as z.ZodType<OrcState>,
  init(): OrcState {
    return emptyOrcState()
  },
  apply(state: OrcState, event: SessionEvent): OrcState {
    const type = event.type as string
    if (!isOrcEventType(type)) return state
    return applyOrc(state, { type, data: event.data })
  },
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codexPrompt(fields: {
  readonly role: 'spec-only' | 'plan-only' | 'review-only' | 'audit-only'
  readonly stage: 'codex-spec' | 'codex-plan' | 'codex-review' | 'codex-audit'
  readonly repositoryPath: string
  readonly skillRequirements: string
  readonly outputSchema: string
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly blockingSeverities: readonly string[]
  readonly scope?: string
  readonly taskId?: string
  readonly iteration?: number
}): ContentBlock[] {
  return [{
    type: 'text',
    text: renderCodexEnvelope({
      role: fields.role,
      stage: fields.stage,
      repositoryScope: fields.repositoryPath,
      skillWorkflow: fields.skillRequirements,
      expectedStructuredResult: fields.outputSchema,
      blockingSeverities: fields.blockingSeverities,
      provider: fields.provider,
      model: fields.model,
      effort: fields.effort,
      ...(fields.scope === undefined ? {} : { scope: fields.scope }),
      ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
      ...(fields.iteration === undefined ? {} : { iteration: fields.iteration }),
    }),
  }]
}

/**
 * Cordis service that appends `orc/*` events and launches correlated children.
 * Transition legality comes from `applyOrc`. In-memory handles are not authority.
 */
export class OrcService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  private readonly config: OrcServiceConfig
  private readonly live = new Map<string, LiveContinuation>()

  /**
   * @param ctx - context with agents, sessions, session persistence, projections, and subagents.
   * @param config - validated provider, model, effort, and Codex envelope fields.
   */
  constructor(ctx: Context, config: OrcServiceConfig) {
    super(ctx, 'orc')
    const parsed = configSchema.safeParse(config)
    if (!parsed.success) {
      throw new OrcError(`invalid ORC config: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    }
    this.config = parsed.data
    ctx.effect(() => {
      const disposeProjection = ctx.sessionProjections.register(orcProjectionDefinition)
      return () => {
        disposeProjection()
      }
    })
  }

  /**
   * Open a Supervisor run on the caller's session.
   * @param caller - Supervisor agent. Its id becomes the root node id.
   * @param input - prompt, scope, and caller-supplied blocking severities.
   * @returns the projected run.
   */
  async createWorkflow(caller: Agent, input: OrcCreateWorkflowInput): Promise<OrcState> {
    const route = this.config.deepseek
    return this.commit(caller.session, {
      type: 'orc/workflow/created',
      data: {
        version: 1,
        runId: OrcRunId(randomUUID()),
        blockingSeverities: [...input.blockingSeverities],
        supervisorNodeId: OrcNodeId(caller.id),
        prompt: input.prompt,
        skillEnvelope: input.skillEnvelope,
        writeScope: [...input.writeScope],
        acceptanceCriteria: input.acceptanceCriteria,
        reportingFormat: input.reportingFormat,
        provider: route.provider,
        model: route.model,
        effort: route.effort,
      },
    })
  }

  /**
   * Read the caller's role from the Supervisor log.
   * @param caller - live agent whose id is a node id.
   * @returns the role, or undefined when the id is not in a run.
   */
  roleOf(caller: Agent): OrcRole | undefined {
    return this.locate(this.callerAgent(caller))?.node.role
  }

  /**
   * Read direct children from the Supervisor log.
   * @param caller - live agent whose id is a node id.
   * @returns child nodes in creation order.
   */
  childrenOf(caller: Agent): readonly OrcNode[] {
    const located = this.locate(this.callerAgent(caller))
    if (located === undefined) return []
    return located.state.nodes.filter(node => node.parentId === located.node.id)
  }

  /**
   * Project the caller's ORC run from its Supervisor log.
   * @param caller - any agent in the run, or the Supervisor.
   * @returns the current projection.
   */
  state(caller: Agent): OrcState {
    return this.readState(this.sessionFor(caller))
  }

  /**
   * Recover one delegated run from the Supervisor log.
   * @param caller - any agent in the run.
   * @param correlationId - delegation id.
   * @returns the registry row, or undefined when the log has no such id.
   */
  registration(caller: Agent, correlationId: OrcCorrelationIdentity): OrcRegistration | undefined {
    const state = this.readState(this.sessionFor(caller))
    const delegation = state.delegations.find(item => item.correlationId === correlationId)
    if (delegation === undefined || delegation.role === undefined) return undefined
    const node = delegation.nodeId === undefined
      ? undefined
      : state.nodes.find(item => item.id === delegation.nodeId)
    const supervisor = state.nodes.find(item => item.role === 'supervisor')
    // A delegation is stored only after the supervisor root exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- supervisor root is present for every delegation
    const parentId = node?.parentId ?? supervisor!.id
    const live = this.live.get(correlationId)
    const continuation = live ?? this.persistedContinuation(delegation)
    return {
      correlationId,
      parentId,
      role: delegation.role,
      ...(delegation.taskId === undefined ? {} : { taskId: delegation.taskId }),
      stage: delegation.kind,
      ...(delegation.provider === undefined ? {} : { provider: delegation.provider }),
      ...(delegation.model === undefined ? {} : { model: delegation.model }),
      ...(delegation.effort === undefined ? {} : { effort: delegation.effort }),
      ...(delegation.nodeId === undefined ? {} : { nodeId: delegation.nodeId }),
      ...(continuation === undefined ? {} : { continuation }),
    }
  }

  /**
   * Open the next legal Codex spec or plan run, or return the open one.
   * @param caller - agent acting for the Supervisor session.
   * @param signal - cancellation before the one-shot run is published.
   * @returns the correlated launch.
   */
  async startSpecPlan(caller: Agent, signal: AbortSignal): Promise<OrcLaunch> {
    const session = this.sessionFor(caller)
    const state = this.readState(session)
    const runId = this.requireRun(state)
    const open = state.delegations.find(item =>
      (item.kind === 'codex-spec' || item.kind === 'codex-plan') && item.status === 'open')
    if (open !== undefined) {
      if (open.continuationId !== undefined) return this.launchFrom(open, false)
      await this.closeUnstarted(session, caller, open)
      throw new OrcError('delegated run has no continuation handle')
    }
    const correlationId = OrcCorrelationId(randomUUID())
    const spec = this.codexRequest(runId, correlationId, 'codex-spec')
    const specFailure = applyOrc(state, spec).failure
    if (specFailure === undefined) {
      return this.launchCodex(caller, session, spec, this.config.codexSpec, 'spec_required', signal)
    }
    const plan = this.codexRequest(runId, correlationId, 'codex-plan')
    if (applyOrc(state, plan).failure === undefined) {
      return this.launchCodex(caller, session, plan, this.config.codexPlan, undefined, signal)
    }
    throw new OrcError(specFailure)
  }

  /**
   * Record an explicit `plan/review` decision. This does not read plan mode.
   * @param caller - agent acting for the Supervisor session.
   * @param decision - approved or rejected.
   * @returns the projected run.
   */
  async approvePlan(caller: Agent, decision: 'approved' | 'rejected'): Promise<OrcState> {
    const session = this.sessionFor(caller)
    return this.commit(session, {
      type: 'orc/plan/approval',
      data: { version: 1, runId: this.requireRun(this.readState(session)), decision, source: 'plan/review' },
    })
  }

  /**
   * Assign one implementation task while approval is still open.
   * @param caller - agent acting for the Supervisor session.
   * @param input - task id, write scope, and acceptance criteria.
   * @returns the projected run.
   */
  async assignTask(caller: Agent, input: {
    readonly taskId: OrcTaskId
    readonly writeScope: readonly string[]
    readonly acceptanceCriteria: string
  }): Promise<OrcState> {
    const session = this.sessionFor(caller)
    return this.commit(session, {
      type: 'orc/task/assigned',
      data: {
        version: 1,
        runId: this.requireRun(this.readState(session)),
        taskId: input.taskId,
        writeScope: [...input.writeScope],
        acceptanceCriteria: input.acceptanceCriteria,
      },
    })
  }

  /**
   * Create a Lead or Peer and start its continuable DeepSeek run.
   * @param caller - parent agent. The projection refuses every other edge.
   * @param input - role, task, and logged prompt fields.
   * @returns the correlated node.
   */
  async spawn(caller: Agent, input: OrcSpawnInput): Promise<OrcLaunch> {
    const actor = this.callerAgent(caller)
    const session = this.sessionFor(actor)
    const state = this.readState(session)
    const runId = this.requireRun(state)
    const parentId = OrcNodeId(actor.id)
    const open = state.delegations.find((item) => {
      if (item.kind !== 'deepseek-node' || item.status !== 'open' || item.role !== input.role || item.taskId !== input.taskId) {
        return false
      }
      return state.nodes.find(node => node.id === item.nodeId)?.parentId === parentId
    })
    if (open !== undefined) {
      if (open.messageId !== undefined) return this.launchFrom(open, false)
      await this.closeUnstarted(session, actor, open)
      throw new OrcError('delegated run has no continuation handle')
    }
    const route = this.config.deepseek
    const nodeId = OrcNodeId(randomUUID())
    const correlationId = OrcCorrelationId(randomUUID())
    const event: OrcEvent = {
      type: 'orc/node/created',
      data: {
        version: 1,
        runId,
        nodeId,
        parentId: OrcNodeId(actor.id),
        role: input.role,
        taskId: input.taskId,
        correlationId,
        prompt: input.prompt,
        skillEnvelope: input.skillEnvelope,
        writeScope: [...input.writeScope],
        acceptanceCriteria: input.acceptanceCriteria,
        reportingFormat: input.reportingFormat,
        provider: route.provider,
        model: route.model,
        effort: route.effort,
      },
    }
    const refused = applyOrc(state, event)
    if (refused.failure !== undefined) throw new OrcError(refused.failure)
    try {
      const started = await this.ctx.subagents.startContinuable({
        provider: route.subagentProvider,
        label: input.role,
        childId: SessionId(nodeId),
        request: {
          prompt: [{ type: 'text', text: `${input.prompt}\n${input.skillEnvelope}` }],
          parent: actor,
          agentOptions: {
            provider: route.provider,
            model: route.model,
            reasoningEffort: ReasoningEffortId(route.effort),
          },
        },
        signal: input.signal,
      })
      const messageId = String(started.messageId)
      await this.commit(session, { type: 'orc/node/created', data: { ...event.data, messageId } })
      this.live.set(correlationId, { kind: 'continuable', id: started.childId, messageId })
      return { correlationId, kind: 'deepseek-node', spawned: true, nodeId }
    } catch (error: unknown) {
      try {
        await this.ensureRequestClosed(session, actor, event, correlationId, undefined, {
          type: 'orc/node/settled',
          data: { version: 1, runId, nodeId, outcome: 'failed', evidence: errorText(error) },
        })
      } catch (appendError: unknown) {
        throw new AggregateError([error, appendError], 'ORC child startup and durable failure append both failed')
      }
      throw error
    }
  }

  /**
   * Record that the named Lead started the active task.
   * @param caller - agent acting for the Supervisor session.
   * @param input - task id and Lead node id.
   * @returns the projected run.
   */
  async startTask(caller: Agent, input: { readonly taskId: OrcTaskId; readonly leadNodeId: OrcNodeIdentity }): Promise<OrcState> {
    const session = this.sessionFor(caller)
    return this.commit(session, {
      type: 'orc/task/started',
      data: { version: 1, runId: this.requireRun(this.readState(session)), taskId: input.taskId, leadNodeId: input.leadNodeId },
    })
  }

  /**
   * Record Lead settlement after the projection accepts it.
   * @param caller - agent acting for the Supervisor session.
   * @param input - task id, Lead node id, and evidence.
   * @returns the projected run.
   */
  async settleTask(caller: Agent, input: {
    readonly taskId: OrcTaskId
    readonly leadNodeId: OrcNodeIdentity
    readonly evidence: string
  }): Promise<OrcState> {
    const session = this.sessionFor(caller)
    return this.commit(session, {
      type: 'orc/task/settled',
      data: {
        version: 1,
        runId: this.requireRun(this.readState(session)),
        taskId: input.taskId,
        leadNodeId: input.leadNodeId,
        evidence: input.evidence,
      },
    })
  }

  /**
   * Open a Codex review run, or return the open one for this scope.
   * @param caller - agent acting for the Supervisor session.
   * @param input - task or branch scope.
   * @returns the correlated launch.
   */
  requestReview(caller: Agent, input: OrcReportRequest): Promise<OrcLaunch> {
    return this.requestReport(caller, input, 'codex-review')
  }

  /**
   * Open a Codex audit run, or return the open one for this scope.
   * @param caller - agent acting for the Supervisor session.
   * @param input - task or branch scope.
   * @returns the correlated launch.
   */
  requestAudit(caller: Agent, input: OrcReportRequest): Promise<OrcLaunch> {
    return this.requestReport(caller, input, 'codex-audit')
  }

  /**
   * Append a delegated result after the log row matches the expected run.
   * @param caller - agent acting for the Supervisor session.
   * @param input - correlation, stage, role, task, and result fields.
   * @returns the projected run.
   */
  async recordResult(caller: Agent, input: OrcResultInput): Promise<OrcState> {
    const session = this.sessionFor(caller)
    const found = this.registration(caller, input.correlationId)
    if (found === undefined) throw new OrcError('unknown correlation id')
    if (found.stage !== input.stage) throw new OrcError('correlation stage does not match')
    if (found.role !== input.role) throw new OrcError('correlation role does not match')
    if (found.taskId !== input.taskId) throw new OrcError('correlation task does not match')
    const runId = this.requireRun(this.readState(session))
    return this.commit(session, this.resultEvent(runId, input, found.nodeId))
  }

  /**
   * Record the fix decision for the active task.
   * @param caller - agent acting for the Supervisor session.
   * @param input - task id, next iteration, and decision text.
   * @returns the projected run.
   */
  async recordFix(caller: Agent, input: {
    readonly taskId: OrcTaskId
    readonly iteration: number
    readonly decision: string
    readonly assigneeNodeId?: OrcNodeIdentity
  }): Promise<OrcState> {
    const session = this.sessionFor(caller)
    return this.commit(session, {
      type: 'orc/fix/iteration',
      data: {
        version: 1,
        runId: this.requireRun(this.readState(session)),
        taskId: input.taskId,
        iteration: input.iteration,
        decision: input.decision,
        ...(input.assigneeNodeId === undefined ? {} : { assigneeNodeId: input.assigneeNodeId }),
      },
    })
  }

  /**
   * Advance the workflow when the projection accepts the caller's edge.
   * @param caller - actor node.
   * @param to - requested phase.
   * @param taskId - task id when the edge names one.
   * @returns the projected run.
   */
  async advance(caller: Agent, to: OrcWorkflowPhase, taskId?: OrcTaskId): Promise<OrcState> {
    const actor = this.callerAgent(caller)
    const session = this.sessionFor(actor)
    return this.commit(session, {
      type: 'orc/phase',
      data: {
        version: 1,
        runId: this.requireRun(this.readState(session)),
        to,
        actorNodeId: OrcNodeId(actor.id),
        ...(taskId === undefined ? {} : { taskId }),
      },
    })
  }

  /**
   * Record terminal failure. Only the Supervisor actor is accepted.
   * @param caller - actor node.
   * @param reason - durable failure text.
   * @returns the projected run.
   */
  async fail(caller: Agent, reason: string): Promise<OrcState> {
    const actor = this.callerAgent(caller)
    const session = this.sessionFor(actor)
    return this.commit(session, {
      type: 'orc/run/failed',
      data: { version: 1, runId: this.requireRun(this.readState(session)), actorNodeId: OrcNodeId(actor.id), reason },
    })
  }

  private callerAgent(caller: Agent): Agent {
    return this.ctx.agents.get(caller.id) ?? caller
  }

  private sessionFor(caller: Agent): Session {
    return this.locate(caller)?.session ?? caller.session
  }

  private locate(caller: Agent): { session: Session; state: OrcState; node: OrcNode } | undefined {
    const id = OrcNodeId(caller.id)
    for (const session of this.ctx.sessions.list()) {
      const state = this.readState(session)
      const node = state.nodes.find(item => item.id === id)
      if (node !== undefined) return { session, state, node }
    }
    return undefined
  }

  private readState(session: Session): OrcState {
    const state = this.ctx.sessionProjections.stateOf(session, 'orc')
    if (state === undefined) throw new OrcError('ORC projection is not registered')
    return state
  }

  private requireRun(state: OrcState): ReturnType<typeof OrcRunId> {
    if (state.runId === undefined) throw new OrcError('supervisor root is required')
    return state.runId
  }

  private launchFrom(delegation: OrcDelegation, spawned: boolean): OrcLaunch {
    return {
      correlationId: delegation.correlationId,
      kind: delegation.kind,
      spawned,
      ...(delegation.nodeId === undefined ? {} : { nodeId: delegation.nodeId }),
    }
  }

  private async commit(session: Session, event: OrcEvent): Promise<OrcState> {
    const next = applyOrc(this.readState(session), event)
    if (next.failure !== undefined) throw new OrcError(next.failure)
    const append = session.append.bind(session) as (type: string, data: unknown) => void
    try {
      append(event.type, event.data)
    } catch (error: unknown) {
      throw new OrcError(`ORC append failed: ${errorText(error)}`, { cause: error })
    }
    await this.ctx.sessions.flush(session)
    await this.ctx.sessionPersistence.flush()
    return this.readState(session)
  }

  private persistedContinuation(delegation: OrcDelegation): LiveContinuation | undefined {
    if (delegation.kind === 'deepseek-node') {
      if (delegation.messageId === undefined) return undefined
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a deepseek delegation stores its node id
      return { kind: 'continuable', id: delegation.nodeId!, messageId: delegation.messageId }
    }
    if (delegation.continuationId === undefined) return undefined
    return { kind: 'one-shot', id: delegation.continuationId }
  }

  private startupFailure(runId: ReturnType<typeof OrcRunId>, open: OrcDelegation, evidence: string): OrcEvent {
    const correlationId = open.correlationId
    if (open.kind === 'deepseek-node') {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a deepseek delegation stores its node id
      const nodeId = open.nodeId!
      return { type: 'orc/node/settled', data: { version: 1, runId, nodeId, outcome: 'failed', evidence } }
    }
    if (open.kind === 'codex-spec') {
      return { type: 'orc/spec/result', data: { version: 1, runId, correlationId, status: 'failed' } }
    }
    if (open.kind === 'codex-plan') {
      return { type: 'orc/plan/result', data: { version: 1, runId, correlationId, status: 'failed' } }
    }
    if (open.kind === 'codex-review') {
      return { type: 'orc/review/result', data: { version: 1, runId, correlationId, status: 'failed', findings: [] } }
    }
    return { type: 'orc/audit/result', data: { version: 1, runId, correlationId, status: 'failed', findings: [] } }
  }

  /** Close an open row that has no persisted start handle. Spec results need `spec_required` first. */
  private async closeUnstarted(session: Session, caller: Agent, open: OrcDelegation): Promise<void> {
    const runId = this.requireRun(this.readState(session))
    if (open.kind === 'codex-spec' && this.readState(session).phase !== 'spec_required') {
      await this.commit(session, {
        type: 'orc/phase',
        data: { version: 1, runId, to: 'spec_required', actorNodeId: OrcNodeId(caller.id) },
      })
    }
    await this.commit(session, this.startupFailure(runId, open, 'delegated run has no continuation handle'))
  }

  /** Record the request if it is missing, the spec phase if it is missing, then the blocking result if the row is still open. */
  private async ensureRequestClosed(
    session: Session,
    caller: Agent,
    request: OrcEvent,
    correlationId: OrcCorrelationIdentity,
    phase: OrcWorkflowPhase | undefined,
    failure: OrcEvent,
  ): Promise<void> {
    if (!this.readState(session).delegations.some(item => item.correlationId === correlationId)) {
      await this.commit(session, request)
    }
    const runId = this.requireRun(this.readState(session))
    if (phase !== undefined && this.readState(session).phase !== phase) {
      await this.commit(session, {
        type: 'orc/phase',
        data: { version: 1, runId, to: phase, actorNodeId: OrcNodeId(caller.id) },
      })
    }
    await this.commit(session, failure)
  }

  private codexRequest(
    runId: ReturnType<typeof OrcRunId>,
    correlationId: OrcCorrelationIdentity,
    kind: 'codex-spec' | 'codex-plan',
  ): Extract<OrcEvent, { type: 'orc/spec/requested' | 'orc/plan/requested' }> {
    const spec = kind === 'codex-spec'
    const route = spec ? this.config.codexSpec : this.config.codexPlan
    const envelope = {
      repositoryPath: this.config.repositoryPath,
      skillRequirements: this.config.skillRequirements,
      outputSchema: spec ? this.config.specOutputSchema : this.config.planOutputSchema,
      readOnly: true as const,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
    }
    if (spec) return { type: 'orc/spec/requested', data: { version: 1, runId, correlationId, role: 'spec-only', ...envelope } }
    return { type: 'orc/plan/requested', data: { version: 1, runId, correlationId, role: 'plan-only', ...envelope } }
  }

  private async launchCodex(
    caller: Agent,
    session: Session,
    event: Extract<OrcEvent, { type: 'orc/spec/requested' | 'orc/plan/requested' }>,
    route: OrcRouteConfig,
    phase: OrcWorkflowPhase | undefined,
    signal: AbortSignal,
  ): Promise<OrcLaunch> {
    const correlationId = event.data.correlationId
    const runId = event.data.runId
    const failure: OrcEvent = event.type === 'orc/spec/requested'
      ? { type: 'orc/spec/result', data: { version: 1, runId, correlationId, status: 'failed' } }
      : { type: 'orc/plan/result', data: { version: 1, runId, correlationId, status: 'failed' } }
    try {
      // Codex advertises no start capabilities. Provider-managed depth sends no maxDepth and no outputSchema.
      const run = await this.ctx.subagents.start(route.subagentProvider, {
        label: event.data.role,
        prompt: codexPrompt({
          role: event.data.role,
          stage: event.type === 'orc/spec/requested' ? 'codex-spec' : 'codex-plan',
          repositoryPath: event.data.repositoryPath,
          skillRequirements: event.data.skillRequirements,
          outputSchema: event.data.outputSchema,
          provider: route.provider,
          model: route.model,
          effort: route.effort,
          blockingSeverities: this.readState(session).blockingSeverities,
        }),
        parent: caller,
        signal,
      })
      const continuationId = String(run.id)
      const requested: typeof event = event.type === 'orc/spec/requested'
        ? { type: 'orc/spec/requested', data: { ...event.data, continuationId } }
        : { type: 'orc/plan/requested', data: { ...event.data, continuationId } }
      await this.commit(session, requested)
      if (phase !== undefined && this.readState(session).phase !== phase) {
        await this.commit(session, {
          type: 'orc/phase',
          data: { version: 1, runId, to: phase, actorNodeId: OrcNodeId(caller.id) },
        })
      }
      this.live.set(correlationId, { kind: 'one-shot', id: continuationId })
      this.watch(run)
      return { correlationId, kind: event.type === 'orc/spec/requested' ? 'codex-spec' : 'codex-plan', spawned: true }
    } catch (error: unknown) {
      try {
        await this.ensureRequestClosed(session, caller, event, correlationId, phase, failure)
      } catch (appendError: unknown) {
        throw new AggregateError([error, appendError], 'ORC child startup and durable failure append both failed')
      }
      throw error
    }
  }

  private async requestReport(caller: Agent, input: OrcReportRequest, kind: 'codex-review' | 'codex-audit'): Promise<OrcLaunch> {
    const session = this.sessionFor(caller)
    const state = this.readState(session)
    const runId = this.requireRun(state)
    const taskId = input.scope === 'branch' ? undefined : input.taskId
    const open = state.delegations.find(item => item.kind === kind
      && item.status === 'open'
      && item.scope === input.scope
      && item.taskId === taskId)
    if (open !== undefined) {
      if (open.continuationId !== undefined) return this.launchFrom(open, false)
      await this.closeUnstarted(session, caller, open)
      throw new OrcError('delegated run has no continuation handle')
    }
    const review = kind === 'codex-review'
    const route = review ? this.config.codexReview : this.config.codexAudit
    const correlationId = OrcCorrelationId(randomUUID())
    const iteration = input.scope === 'branch'
      ? (state.branchVisit ?? 0)
      : (state.tasks.find(task => task.id === taskId)?.iteration ?? 0)
    const envelope = {
      role: review ? 'review-only' as const : 'audit-only' as const,
      repositoryPath: this.config.repositoryPath,
      skillRequirements: this.config.skillRequirements,
      outputSchema: review ? this.config.reviewOutputSchema : this.config.auditOutputSchema,
      readOnly: true as const,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
    }
    const event: OrcEvent = review
      ? {
        type: 'orc/review/requested',
        data: { version: 1, runId, correlationId, scope: input.scope, iteration, ...envelope, ...(taskId === undefined ? {} : { taskId }) },
      }
      : {
        type: 'orc/audit/requested',
        data: { version: 1, runId, correlationId, scope: input.scope, iteration, ...envelope, ...(taskId === undefined ? {} : { taskId }) },
      }
    const failure: OrcEvent = review
      ? { type: 'orc/review/result', data: { version: 1, runId, correlationId, status: 'failed', findings: [] } }
      : { type: 'orc/audit/result', data: { version: 1, runId, correlationId, status: 'failed', findings: [] } }
    const refused = applyOrc(this.readState(session), event)
    if (refused.failure !== undefined) throw new OrcError(refused.failure)
    try {
      const run = await this.ctx.subagents.start(route.subagentProvider, {
        label: envelope.role,
        prompt: codexPrompt({
          role: envelope.role,
          stage: kind,
          repositoryPath: envelope.repositoryPath,
          skillRequirements: envelope.skillRequirements,
          outputSchema: envelope.outputSchema,
          provider: route.provider,
          model: route.model,
          effort: route.effort,
          blockingSeverities: state.blockingSeverities,
          scope: input.scope,
          ...(taskId === undefined ? {} : { taskId }),
          iteration,
        }),
        parent: caller,
        signal: input.signal,
      })
      const continuationId = String(run.id)
      const requested: OrcEvent = review
        ? { type: 'orc/review/requested', data: { ...event.data, continuationId } }
        : { type: 'orc/audit/requested', data: { ...event.data, continuationId } }
      await this.commit(session, requested)
      this.live.set(correlationId, { kind: 'one-shot', id: continuationId })
      this.watch(run)
      return { correlationId, kind, spawned: true }
    } catch (error: unknown) {
      try {
        await this.ensureRequestClosed(session, caller, event, correlationId, undefined, failure)
      } catch (appendError: unknown) {
        throw new AggregateError([error, appendError], 'ORC child startup and durable failure append both failed')
      }
      throw error
    }
  }

  private resultEvent(runId: ReturnType<typeof OrcRunId>, input: OrcResultInput, nodeId: OrcNodeIdentity | undefined): OrcEvent {
    const correlationId = input.correlationId
    if (input.stage === 'deepseek-node') {
      if (input.outcome === undefined) throw new OrcError('node outcome is required')
      return {
        type: 'orc/node/settled',
        data: {
          version: 1,
          runId,
          // deepseek-node delegations are created with a node id.
          // oxlint-disable-next-line typescript/no-non-null-assertion -- node id is stored on every deepseek delegation
          nodeId: nodeId!,
          outcome: input.outcome,
          ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        },
      }
    }
    if (input.status === undefined) throw new OrcError('report status is required')
    const status = input.status
    if (input.stage === 'codex-spec') {
      return {
        type: 'orc/spec/result',
        data: { version: 1, runId, correlationId, status, ...(status === 'ok' && input.text !== undefined ? { specText: input.text } : {}) },
      }
    }
    if (input.stage === 'codex-plan') {
      return {
        type: 'orc/plan/result',
        data: { version: 1, runId, correlationId, status, ...(status === 'ok' && input.text !== undefined ? { planText: input.text } : {}) },
      }
    }
    const findings = [...(input.findings ?? [])]
    return input.stage === 'codex-review'
      ? { type: 'orc/review/result', data: { version: 1, runId, correlationId, status, findings } }
      : { type: 'orc/audit/result', data: { version: 1, runId, correlationId, status, findings } }
  }

  private watch(run: { readonly result: Promise<unknown> }): void {
    run.result.then(() => undefined, () => undefined)
  }
}

export default OrcService
