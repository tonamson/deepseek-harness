/** Version-1 ORC event schemas and the projection reducer. */

import { z } from 'zod'
import type {
  OrcCorrelationId,
  OrcDelegation,
  OrcDelegationKind,
  OrcEvent,
  OrcEventType,
  OrcFindingId,
  OrcNode,
  OrcNodeId,
  OrcProviderSelection,
  OrcReviewScope,
  OrcRunId,
  OrcState,
  OrcTask,
  OrcTaskId,
  OrcWorkflowPhase,
} from './types.ts'

/**
 * Brand one ORC run id.
 * @param id - caller-supplied run identity.
 * @returns the same string branded as an ORC run id.
 */
export function OrcRunId(id: string): OrcRunId {
  return id as OrcRunId
}

/**
 * Brand one ORC node id.
 * @param id - caller-supplied node identity.
 * @returns the same string branded as an ORC node id.
 */
export function OrcNodeId(id: string): OrcNodeId {
  return id as OrcNodeId
}

/**
 * Brand one ORC task id.
 * @param id - caller-supplied task identity.
 * @returns the same string branded as an ORC task id.
 */
export function OrcTaskId(id: string): OrcTaskId {
  return id as OrcTaskId
}

/**
 * Brand one ORC finding id.
 * @param id - caller-supplied finding identity.
 * @returns the same string branded as an ORC finding id.
 */
export function OrcFindingId(id: string): OrcFindingId {
  return id as OrcFindingId
}

/**
 * Brand one ORC correlation id.
 * @param id - caller-supplied delegation identity.
 * @returns the same string branded as an ORC correlation id.
 */
export function OrcCorrelationId(id: string): OrcCorrelationId {
  return id as OrcCorrelationId
}

const ORC_EVENT_TYPES = [
  'orc/workflow/created',
  'orc/node/created',
  'orc/node/settled',
  'orc/spec/requested',
  'orc/spec/result',
  'orc/plan/requested',
  'orc/plan/result',
  'orc/plan/approval',
  'orc/task/assigned',
  'orc/task/started',
  'orc/task/settled',
  'orc/review/requested',
  'orc/review/result',
  'orc/audit/requested',
  'orc/audit/result',
  'orc/finding/resolved',
  'orc/fix/iteration',
  'orc/phase',
  'orc/run/failed',
  'orc/run/completed',
] as const satisfies readonly OrcEventType[]

/**
 * Report whether a session event type belongs to the ORC namespace.
 * @param type - candidate event type.
 * @returns whether `type` is a versioned `orc/*` event.
 */
export function isOrcEventType(type: string): type is OrcEventType {
  return (ORC_EVENT_TYPES as readonly string[]).includes(type)
}

const runIdSchema = z.string().min(1).transform(OrcRunId)
const nodeIdSchema = z.string().min(1).transform(OrcNodeId)
const taskIdSchema = z.string().min(1).transform(OrcTaskId)
const findingIdSchema = z.string().min(1).transform(OrcFindingId)
const correlationIdSchema = z.string().min(1).transform(OrcCorrelationId)
const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])
const reportStatusSchema = z.enum(['ok', 'failed', 'malformed', 'unavailable'])
const selectionSchema = {
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
}
const textListSchema = z.array(z.string().min(1))
const blockingSchema = z.array(severitySchema).min(1).refine(
  values => new Set(values).size === values.length,
  { message: 'blocking severities must be unique' },
).refine(
  values => (['critical', 'high', 'medium'] as const).every(severity => values.includes(severity)),
  { message: 'blockingSeverities must include critical, high, and medium' },
)
const iterationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const workflowPhaseSchema = z.enum([
  'brainstorming',
  'spec_required',
  'plan_required',
  'awaiting_user_approval',
  'task_implementation',
  'task_peer_settlement',
  'task_review',
  'task_audit',
  'task_fix',
  'next_task',
  'final_review',
  'complete',
  'failed',
])

/** Build the shared Codex envelope fields for one literal envelope role. */
function codexFields(role: 'spec-only' | 'plan-only' | 'review-only' | 'audit-only') {
  return {
    role: z.literal(role),
    repositoryPath: z.string().min(1),
    skillRequirements: z.string().min(1),
    outputSchema: z.string().min(1),
    readOnly: z.literal(true),
    ...selectionSchema,
  }
}

const findingInputSchema = z.object({
  id: findingIdSchema,
  severity: severitySchema,
  summary: z.string().min(1),
  taskId: taskIdSchema.optional(),
}).strict()

const workflowCreatedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  blockingSeverities: blockingSchema,
  supervisorNodeId: nodeIdSchema,
  prompt: z.string().min(1),
  skillEnvelope: z.string().min(1),
  writeScope: textListSchema,
  acceptanceCriteria: z.string().min(1),
  reportingFormat: z.string().min(1),
  ...selectionSchema,
}).strict()

const nodeCreatedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  parentId: nodeIdSchema,
  role: z.enum(['lead', 'peer']),
  taskId: taskIdSchema,
  correlationId: correlationIdSchema,
  prompt: z.string().min(1),
  skillEnvelope: z.string().min(1),
  writeScope: textListSchema,
  acceptanceCriteria: z.string().min(1),
  reportingFormat: z.string().min(1),
  ...selectionSchema,
}).strict()

const nodeSettledSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  nodeId: nodeIdSchema,
  outcome: z.enum(['settled', 'failed', 'timeout', 'cancelled', 'incomplete']),
  evidence: z.string().min(1).optional(),
}).strict()

const specRequestedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  correlationId: correlationIdSchema,
  ...codexFields('spec-only'),
}).strict()

const specResultSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  correlationId: correlationIdSchema,
  status: reportStatusSchema,
  specText: z.string().min(1).optional(),
}).strict()

const planRequestedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  correlationId: correlationIdSchema,
  ...codexFields('plan-only'),
}).strict()

const planResultSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  correlationId: correlationIdSchema,
  status: reportStatusSchema,
  planText: z.string().min(1).optional(),
}).strict()

const planApprovalSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  decision: z.enum(['approved', 'rejected']),
  source: z.literal('plan/review'),
}).strict()

const taskAssignedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  taskId: taskIdSchema,
  writeScope: textListSchema,
  acceptanceCriteria: z.string().min(1),
}).strict()

const taskStartedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  taskId: taskIdSchema,
  leadNodeId: nodeIdSchema,
}).strict()

const taskSettledSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  taskId: taskIdSchema,
  leadNodeId: nodeIdSchema,
  evidence: z.string().min(1),
}).strict()

const reviewRequestedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  correlationId: correlationIdSchema,
  scope: z.enum(['task', 'branch']),
  iteration: iterationSchema,
  taskId: taskIdSchema.optional(),
  ...codexFields('review-only'),
}).strict()

const auditRequestedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  correlationId: correlationIdSchema,
  scope: z.enum(['task', 'branch']),
  iteration: iterationSchema,
  taskId: taskIdSchema.optional(),
  ...codexFields('audit-only'),
}).strict()

const reviewResultSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  correlationId: correlationIdSchema,
  status: reportStatusSchema,
  findings: z.array(findingInputSchema),
}).strict()

const findingResolvedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  findingId: findingIdSchema,
}).strict()

const fixIterationSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  taskId: taskIdSchema,
  iteration: iterationSchema,
  decision: z.string().min(1),
  assigneeNodeId: nodeIdSchema.optional(),
}).strict()

const phaseSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  to: workflowPhaseSchema,
  actorNodeId: nodeIdSchema,
  taskId: taskIdSchema.optional(),
}).strict()

const runFailedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  actorNodeId: nodeIdSchema,
  reason: z.string().min(1),
}).strict()

const runCompletedSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  actorNodeId: nodeIdSchema,
}).strict()

const orcEventSchema: z.ZodType<OrcEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('orc/workflow/created'), data: workflowCreatedSchema }).strict(),
  z.object({ type: z.literal('orc/node/created'), data: nodeCreatedSchema }).strict(),
  z.object({ type: z.literal('orc/node/settled'), data: nodeSettledSchema }).strict(),
  z.object({ type: z.literal('orc/spec/requested'), data: specRequestedSchema }).strict(),
  z.object({ type: z.literal('orc/spec/result'), data: specResultSchema }).strict(),
  z.object({ type: z.literal('orc/plan/requested'), data: planRequestedSchema }).strict(),
  z.object({ type: z.literal('orc/plan/result'), data: planResultSchema }).strict(),
  z.object({ type: z.literal('orc/plan/approval'), data: planApprovalSchema }).strict(),
  z.object({ type: z.literal('orc/task/assigned'), data: taskAssignedSchema }).strict(),
  z.object({ type: z.literal('orc/task/started'), data: taskStartedSchema }).strict(),
  z.object({ type: z.literal('orc/task/settled'), data: taskSettledSchema }).strict(),
  z.object({ type: z.literal('orc/review/requested'), data: reviewRequestedSchema }).strict(),
  z.object({ type: z.literal('orc/review/result'), data: reviewResultSchema }).strict(),
  z.object({ type: z.literal('orc/audit/requested'), data: auditRequestedSchema }).strict(),
  z.object({ type: z.literal('orc/audit/result'), data: reviewResultSchema }).strict(),
  z.object({ type: z.literal('orc/finding/resolved'), data: findingResolvedSchema }).strict(),
  z.object({ type: z.literal('orc/fix/iteration'), data: fixIterationSchema }).strict(),
  z.object({ type: z.literal('orc/phase'), data: phaseSchema }).strict(),
  z.object({ type: z.literal('orc/run/failed'), data: runFailedSchema }).strict(),
  z.object({ type: z.literal('orc/run/completed'), data: runCompletedSchema }).strict(),
]) as z.ZodType<OrcEvent>

/**
 * Empty projection used before `orc/workflow/created`.
 * @returns an ORC projection with no run.
 */
export function emptyOrcState(): OrcState {
  return {
    blockingSeverities: [],
    nodes: [],
    tasks: [],
    findings: [],
    delegations: [],
  }
}

/**
 * Fold one candidate event into ORC state.
 * A refused event sets `failure` and does not change the committed fields.
 * @param state - projection of the committed prefix.
 * @param event - candidate `orc/*` event, including malformed input.
 * @returns the next projection, or the same projection plus `failure`.
 */
export function applyOrc(state: OrcState, event: unknown): OrcState {
  if (state.failure !== undefined) return state
  const parsed = parseOrcEvent(event)
  if (typeof parsed === 'string') return { ...state, failure: parsed }
  return reduceOrcEvent(state, parsed)
}

/**
 * Replay a complete ORC event stream from an empty projection.
 * @param events - version-1 ORC events in log order.
 * @returns the projection, including `failure` when a transition was refused.
 */
export function projectOrc(events: readonly OrcEvent[]): OrcState {
  return events.reduce<OrcState>(applyOrc, emptyOrcState())
}

/** Decode one event or return a refusal string. */
function parseOrcEvent(event: unknown): OrcEvent | string {
  const version = declaredVersion(event)
  if (version !== undefined && version !== 1) return `unsupported ORC event version ${String(version)}`
  if (isRecord(event) && typeof event.type === 'string' && !isOrcEventType(event.type)) return 'not an orc event'
  if (isRecord(event) && isRecord(event.data) && event.data.actorNodeId === undefined) {
    if (event.type === 'orc/phase') return 'phase actor is required'
    if (event.type === 'orc/run/completed' || event.type === 'orc/run/failed') return 'run actor is required'
  }
  const parsed = orcEventSchema.safeParse(event)
  if (!parsed.success) return `malformed ORC payload: ${parsed.error.issues.map(issue => issue.message).join('; ')}`
  return parsed.data
}

/** Read `data.version` when the candidate has that field. */
function declaredVersion(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.data) || !('version' in event.data)) return undefined
  return event.data.version
}

/** Whether a value is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Attach a refusal without changing committed ORC fields. */
function refuse(state: OrcState, failure: string): OrcState {
  return { ...state, failure }
}

/** Require an open run and a matching run id. */
function requireRun(state: OrcState, runId: OrcRunId): OrcState | undefined {
  if (state.runId === undefined) return refuse(state, 'supervisor root is required')
  if (state.runId !== runId) return refuse(state, 'run id does not match')
  return undefined
}

/** Apply one parsed event. A refusal keeps every committed field and sets `failure`. */
function reduceOrcEvent(state: OrcState, event: OrcEvent): OrcState {
  switch (event.type) {
    case 'orc/workflow/created':
      return createWorkflow(state, event)
    case 'orc/node/created':
      return createNode(state, event)
    case 'orc/node/settled':
      return settleNode(state, event)
    case 'orc/spec/requested':
      return requestCodex(state, event, 'codex-spec', ['brainstorming', 'spec_required'])
    case 'orc/spec/result':
      return recordCodexText(state, event, 'codex-spec', 'spec_required', 'specText')
    case 'orc/plan/requested':
      return requestCodex(state, event, 'codex-plan', ['plan_required'])
    case 'orc/plan/result':
      return recordCodexText(state, event, 'codex-plan', 'plan_required', 'planText')
    case 'orc/plan/approval':
      return approvePlan(state, event)
    case 'orc/task/assigned':
      return assignTask(state, event)
    case 'orc/task/started':
      return startTask(state, event)
    case 'orc/task/settled':
      return settleTask(state, event)
    case 'orc/review/requested':
      return requestReport(state, event, 'codex-review')
    case 'orc/audit/requested':
      return requestReport(state, event, 'codex-audit')
    case 'orc/review/result':
      return recordReport(state, event, 'codex-review')
    case 'orc/audit/result':
      return recordReport(state, event, 'codex-audit')
    case 'orc/finding/resolved':
      return resolveFinding(state, event)
    case 'orc/fix/iteration':
      return recordFix(state, event)
    case 'orc/phase':
      return changePhase(state, event)
    case 'orc/run/failed':
      return failRun(state, event)
    case 'orc/run/completed':
      return completeRun(state, event)
    default:
      return assertNever(event)
  }
}

/** Open a run on its Supervisor root. */
function createWorkflow(state: OrcState, event: Extract<OrcEvent, { type: 'orc/workflow/created' }>): OrcState {
  if (state.runId !== undefined) return refuse(state, 'workflow already exists')
  const data = event.data
  const supervisor: OrcNode = {
    id: data.supervisorNodeId,
    role: 'supervisor',
    phase: 'active',
    prompt: data.prompt,
    skillEnvelope: data.skillEnvelope,
    writeScope: data.writeScope,
    acceptanceCriteria: data.acceptanceCriteria,
    reportingFormat: data.reportingFormat,
    ...(data.provider === undefined ? {} : { provider: data.provider }),
    ...(data.model === undefined ? {} : { model: data.model }),
    ...(data.effort === undefined ? {} : { effort: data.effort }),
  }
  return {
    ...state,
    runId: data.runId,
    phase: 'brainstorming',
    blockingSeverities: [...data.blockingSeverities],
    nodes: [supervisor],
  }
}

/** Create a Lead or Peer when the parent edge and task phase are legal. */
function createNode(state: OrcState, event: Extract<OrcEvent, { type: 'orc/node/created' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  if (state.nodes.some(node => node.id === data.nodeId)) return refuse(state, 'node already exists')
  const parent = state.nodes.find(node => node.id === data.parentId)
  if (parent === undefined) return refuse(state, 'parent node is missing')
  if (parent.role === 'peer') return refuse(state, 'peer cannot spawn a child')
  if (parent.role === 'supervisor' && data.role === 'peer') return refuse(state, 'supervisor cannot create a peer')
  if (parent.role === 'lead' && data.role !== 'peer') return refuse(state, 'lead cannot create a lead')
  if (parent.role === 'supervisor' && data.role !== 'lead') return refuse(state, 'supervisor cannot create a peer')
  const duplicate = rejectDuplicateCorrelation(state, data.correlationId)
  if (duplicate !== undefined) return duplicate
  if (state.approval === 'rejected') return refuse(state, 'user rejection blocks implementation')
  if (state.approval !== 'approved') return refuse(state, 'plan approval is required before implementation')
  if (state.phase !== 'task_implementation') return refuse(state, 'role node requires task implementation')
  const task = taskById(state, data.taskId)
  if (task === undefined) return refuse(state, 'task is not assigned')
  if (data.role === 'lead') {
    if (task.phase !== 'assigned') return refuse(state, 'task is not waiting for a lead')
    if (state.tasks.some(item => item.id !== task.id && taskInFlight(item))) {
      return refuse(state, 'another task is in flight')
    }
    if (state.nodes.some(node => node.role === 'lead' && node.phase === 'active')) {
      return refuse(state, 'a lead is already active')
    }
  } else if (parent.taskId !== data.taskId) {
    return refuse(state, 'peer task does not match its lead')
  } else if (parent.phase !== 'active') {
    return refuse(state, 'lead is not active')
  }
  const node: OrcNode = {
    id: data.nodeId,
    parentId: data.parentId,
    role: data.role,
    phase: 'active',
    taskId: data.taskId,
    correlationId: data.correlationId,
    prompt: data.prompt,
    skillEnvelope: data.skillEnvelope,
    writeScope: [...data.writeScope],
    acceptanceCriteria: data.acceptanceCriteria,
    reportingFormat: data.reportingFormat,
    ...selectionOf(data),
  }
  const delegation: OrcDelegation = {
    correlationId: data.correlationId,
    kind: 'deepseek-node',
    status: 'open',
    scope: 'task',
    iteration: task.iteration,
    blocksProgress: false,
    taskId: data.taskId,
    nodeId: data.nodeId,
    role: data.role,
    prompt: data.prompt,
    skillEnvelope: data.skillEnvelope,
    findingIds: [],
    ...selectionOf(data),
  }
  return { ...state, nodes: [...state.nodes, node], delegations: [...state.delegations, delegation] }
}

/** Record a node outcome. `failed` fails the task. Timeout, cancellation, and incomplete evidence leave it unsettled. */
function settleNode(state: OrcState, event: Extract<OrcEvent, { type: 'orc/node/settled' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  const node = nodeById(state, data.nodeId)
  if (node === undefined) return refuse(state, 'node is missing')
  if (node.phase !== 'active') return refuse(state, 'node is already settled')
  const settled = data.outcome === 'settled'
  const nextNode: OrcNode = {
    ...node,
    phase: settled ? 'settled' : 'failed',
    outcome: data.outcome,
    ...(data.evidence === undefined ? {} : { evidence: data.evidence }),
  }
  let next: OrcState = {
    ...state,
    nodes: state.nodes.map(item => item.id === node.id ? nextNode : item),
    delegations: state.delegations.map(item => item.nodeId === node.id
      ? { ...item, status: settled ? 'ok' : 'failed', blocksProgress: !settled, ...(data.evidence === undefined ? {} : { text: data.evidence }) }
      : item),
  }
  if (node.taskId !== undefined && !settled) {
    next = mapTask(next, node.taskId, (task) => {
      if (task.phase === 'failed') return task
      return { ...task, phase: data.outcome === 'failed' ? 'failed' : 'unsettled' }
    })
  }
  return next
}

/** Open one Codex spec or plan delegation. The caller supplies any provider selection. */
function requestCodex(
  state: OrcState,
  event: Extract<OrcEvent, { type: 'orc/spec/requested' | 'orc/plan/requested' }>,
  kind: 'codex-spec' | 'codex-plan',
  allowed: readonly OrcWorkflowPhase[],
): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  const duplicate = rejectDuplicateCorrelation(state, data.correlationId)
  if (duplicate !== undefined) return duplicate
  if (state.phase === undefined || !allowed.includes(state.phase)) {
    const label = kind === 'codex-spec' ? 'codex spec' : 'codex plan'
    return refuse(state, `${label} request is not allowed in this phase`)
  }
  if (state.delegations.some(item => item.kind === kind && (item.status === 'open' || item.status === 'ok'))) {
    const label = kind === 'codex-spec' ? 'codex spec' : 'codex plan'
    return refuse(state, `${label} is already requested`)
  }
  const delegation: OrcDelegation = {
    correlationId: data.correlationId,
    kind,
    status: 'open',
    scope: 'workflow',
    iteration: 0,
    blocksProgress: false,
    role: data.role,
    repositoryPath: data.repositoryPath,
    skillRequirements: data.skillRequirements,
    outputSchema: data.outputSchema,
    readOnly: true,
    findingIds: [],
    ...selectionOf(data),
  }
  return { ...state, delegations: [...state.delegations, delegation] }
}

/** Close a Codex spec or plan delegation. Only `ok` stores text and can be left later. */
function recordCodexText(
  state: OrcState,
  event: Extract<OrcEvent, { type: 'orc/spec/result' | 'orc/plan/result' }>,
  kind: 'codex-spec' | 'codex-plan',
  allowed: OrcWorkflowPhase,
  field: 'specText' | 'planText',
): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  if (state.phase !== allowed) {
    const label = kind === 'codex-spec' ? 'codex spec' : 'codex plan'
    return refuse(state, `${label} result is not allowed in this phase`)
  }
  const delegation = delegationByCorrelation(state, data.correlationId)
  if (delegation === undefined) return refuse(state, 'unknown correlation id')
  if (delegation.kind !== kind) return refuse(state, 'correlation kind does not match')
  if (delegation.status !== 'open') return refuse(state, 'delegation is already settled')
  const text = field === 'specText'
    ? (event.type === 'orc/spec/result' ? event.data.specText : undefined)
    : (event.type === 'orc/plan/result' ? event.data.planText : undefined)
  if (data.status === 'ok' && (text === undefined || text.length === 0)) {
    const label = kind === 'codex-spec' ? 'codex spec' : 'codex plan'
    return refuse(state, `${label} result requires text`)
  }
  return {
    ...state,
    ...(data.status === 'ok' && text !== undefined ? { [field]: text } : {}),
    delegations: state.delegations.map(item => item.correlationId === data.correlationId
      ? { ...item, status: data.status, blocksProgress: data.status !== 'ok', ...(text === undefined || data.status !== 'ok' ? {} : { text }) }
      : item),
  }
}

/** Record the explicit plan/review decision. This does not read plan mode. */
function approvePlan(state: OrcState, event: Extract<OrcEvent, { type: 'orc/plan/approval' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  if (state.phase !== 'awaiting_user_approval') return refuse(state, 'plan approval requires awaiting user approval')
  const plan = latestDelegation(state, 'codex-plan')
  if (plan === undefined || plan.status === 'open') return refuse(state, 'codex plan result is missing')
  if (plan.status !== 'ok') return refuse(state, 'codex plan failure blocks approval')
  if (state.approval !== undefined) return refuse(state, 'plan approval is already recorded')
  return { ...state, approval: data.decision }
}

/** Assign one implementation task after approval and before the first Lead. */
function assignTask(state: OrcState, event: Extract<OrcEvent, { type: 'orc/task/assigned' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  if (state.approval === 'rejected') return refuse(state, 'user rejection blocks implementation')
  if (state.approval !== 'approved') return refuse(state, 'plan approval is required before implementation')
  if (state.phase !== 'awaiting_user_approval') return refuse(state, 'task assignment is closed')
  if (state.tasks.some(task => task.id === data.taskId)) return refuse(state, 'task already exists')
  const task: OrcTask = {
    id: data.taskId,
    phase: 'assigned',
    writeScope: [...data.writeScope],
    acceptanceCriteria: data.acceptanceCriteria,
    iteration: 0,
  }
  return { ...state, tasks: [...state.tasks, task] }
}

/** Mark the approved task started by its Lead. */
function startTask(state: OrcState, event: Extract<OrcEvent, { type: 'orc/task/started' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  if (state.phase !== 'task_implementation') return refuse(state, 'task start requires task implementation')
  const task = taskById(state, data.taskId)
  if (task === undefined || task.phase !== 'assigned') return refuse(state, 'task is not assigned')
  if (state.tasks.some(item => item.id !== task.id && taskInFlight(item))) {
    return refuse(state, 'another task is in flight')
  }
  const lead = nodeById(state, data.leadNodeId)
  if (lead === undefined || lead.role !== 'lead' || lead.taskId !== task.id || lead.phase !== 'active') {
    return refuse(state, 'lead does not own the task')
  }
  return {
    ...mapTask(state, task.id, current => ({ ...current, phase: 'started', leadNodeId: data.leadNodeId })),
    activeTaskId: task.id,
  }
}

/**
 * Accept Lead settlement only after the Lead and every Peer settled.
 * Peer timeout, cancellation, or incomplete evidence refuses with the task left unsettled.
 */
function settleTask(state: OrcState, event: Extract<OrcEvent, { type: 'orc/task/settled' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  const task = taskById(state, data.taskId)
  if (task === undefined) return refuse(state, 'task is not assigned')
  if (state.activeTaskId !== task.id) return refuse(state, 'task settlement requires the active task')
  const lead = nodeById(state, data.leadNodeId)
  if (lead === undefined || lead.role !== 'lead' || lead.taskId !== task.id) {
    return refuse(state, 'lead does not own the task')
  }
  const peers = state.nodes.filter(node => node.parentId === lead.id && node.role === 'peer')
  const peersSettled = peers.every(peer => peer.outcome === 'settled')
  if (!peersSettled || lead.outcome !== 'settled' || task.phase === 'unsettled' || task.phase === 'failed') {
    return refuse(state, 'lead task is unsettled')
  }
  if (state.phase !== 'task_peer_settlement') return refuse(state, 'task settlement requires peer settlement')
  if (task.phase === 'settled') return refuse(state, 'task is already settled')
  return mapTask(state, task.id, current => ({ ...current, phase: 'settled', evidence: data.evidence }))
}

/** Open a task or branch review/audit delegation for the current iteration. */
function requestReport(
  state: OrcState,
  event: Extract<OrcEvent, { type: 'orc/review/requested' | 'orc/audit/requested' }>,
  kind: 'codex-review' | 'codex-audit',
): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  const duplicate = rejectDuplicateCorrelation(state, data.correlationId)
  if (duplicate !== undefined) return duplicate
  const label = kind === 'codex-review' ? 'review' : 'audit'
  const expectedPhase = data.scope === 'branch'
    ? 'final_review'
    : (kind === 'codex-review' ? 'task_review' : 'task_audit')
  if (state.phase !== expectedPhase) return refuse(state, `${label} request is not allowed in this phase`)
  let taskId = data.taskId
  if (data.scope === 'branch') {
    if (taskId !== undefined) return refuse(state, `branch ${label} request cannot name a task`)
    if (state.branchVisit === undefined || data.iteration !== state.branchVisit) {
      return refuse(state, 'branch request iteration does not match this final review')
    }
    const latest = latestBranch(state, kind)
    if (latest !== undefined && (latest.status === 'open' || latest.status === 'ok')) {
      return refuse(state, `branch ${label} is already requested`)
    }
    taskId = undefined
  } else {
    const task = activeTask(state)
    if (taskId === undefined || task === undefined || task.id !== taskId) {
      return refuse(state, `${label} request task does not match the active task`)
    }
    if (data.iteration !== task.iteration) return refuse(state, `${label} request iteration does not match the task`)
    if (findReport(state, kind, data.scope, data.iteration, taskId) !== undefined) {
      return refuse(state, `${label} is already requested`)
    }
  }
  const delegation: OrcDelegation = {
    correlationId: data.correlationId,
    kind,
    status: 'open',
    scope: data.scope,
    iteration: data.iteration,
    blocksProgress: false,
    ...(taskId === undefined ? {} : { taskId }),
    role: data.role,
    repositoryPath: data.repositoryPath,
    skillRequirements: data.skillRequirements,
    outputSchema: data.outputSchema,
    readOnly: true,
    findingIds: [],
    ...selectionOf(data),
  }
  return { ...state, delegations: [...state.delegations, delegation] }
}

/** Record a review or audit result. Non-ok status and blocking severities stick on the delegation. */
function recordReport(
  state: OrcState,
  event: Extract<OrcEvent, { type: 'orc/review/result' | 'orc/audit/result' }>,
  kind: 'codex-review' | 'codex-audit',
): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  const delegation = delegationByCorrelation(state, data.correlationId)
  if (delegation === undefined) return refuse(state, 'unknown correlation id')
  if (delegation.kind !== kind || (delegation.scope !== 'task' && delegation.scope !== 'branch')) {
    return refuse(state, 'correlation kind does not match')
  }
  if (delegation.status !== 'open') return refuse(state, 'delegation is already settled')
  const seen = new Set<string>()
  for (const finding of data.findings) {
    if (seen.has(finding.id) || state.findings.some(existing => existing.id === finding.id)) {
      return refuse(state, 'duplicate finding id')
    }
    seen.add(finding.id)
    if (finding.taskId !== undefined && delegation.scope === 'task' && finding.taskId !== delegation.taskId) {
      return refuse(state, 'finding task does not match the report')
    }
    if (delegation.scope === 'branch' && data.status === 'ok' && state.blockingSeverities.includes(finding.severity)) {
      if (finding.taskId === undefined) return refuse(state, 'branch finding requires an owning task')
      if (taskById(state, finding.taskId) === undefined) return refuse(state, 'branch finding task is not assigned')
    }
  }
  const scope: OrcReviewScope = delegation.scope
  const blocksProgress = data.status !== 'ok'
    || data.findings.some(finding => state.blockingSeverities.includes(finding.severity))
  return {
    ...state,
    findings: [
      ...state.findings,
      ...data.findings.map((finding) => {
        const taskId = finding.taskId ?? delegation.taskId
        return {
          id: finding.id,
          severity: finding.severity,
          status: 'open' as const,
          summary: finding.summary,
          correlationId: delegation.correlationId,
          scope,
          iteration: delegation.iteration,
          ...(taskId === undefined ? {} : { taskId }),
        }
      }),
    ],
    delegations: state.delegations.map(item => item.correlationId === data.correlationId
      ? { ...item, status: data.status, blocksProgress, findingIds: data.findings.map(finding => finding.id) }
      : item),
  }
}

/** Mark one finding resolved. Resolution does not clear `blocksProgress` on its delegation. */
function resolveFinding(state: OrcState, event: Extract<OrcEvent, { type: 'orc/finding/resolved' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  const finding = state.findings.find(item => item.id === data.findingId)
  if (finding === undefined) return refuse(state, 'finding is missing')
  if (finding.status === 'resolved') return refuse(state, 'finding is already resolved')
  return {
    ...state,
    findings: state.findings.map(item => item.id === data.findingId ? { ...item, status: 'resolved' } : item),
  }
}

/** Record the fix decision and the next review iteration for the active task. */
function recordFix(state: OrcState, event: Extract<OrcEvent, { type: 'orc/fix/iteration' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  if (state.phase !== 'task_fix') return refuse(state, 'fix iteration requires task fix')
  const task = taskById(state, data.taskId)
  if (task === undefined || state.activeTaskId !== task.id) {
    return refuse(state, 'fix iteration task does not match the active task')
  }
  const audited = latestSettledIteration(state, 'codex-audit', task.id)
  if (audited === undefined) return refuse(state, 'audit result is missing')
  if (task.iteration > audited) return refuse(state, 'fix iteration is already recorded')
  if (data.iteration !== task.iteration + 1) return refuse(state, 'fix iteration does not match the task')
  if (data.assigneeNodeId !== undefined) {
    const assignee = nodeById(state, data.assigneeNodeId)
    if (assignee === undefined || assignee.taskId !== task.id) return refuse(state, 'fix assignee is not a task node')
  }
  return mapTask(state, task.id, current => ({
    ...current,
    phase: 'fix',
    iteration: data.iteration,
    fixDecision: data.decision,
  }))
}

/** Move the workflow when the actor, the edge, and its required events are present. */
function changePhase(state: OrcState, event: Extract<OrcEvent, { type: 'orc/phase' }>): OrcState {
  const data = event.data
  const invalid = requireMutableRun(state, data.runId)
  if (invalid !== undefined) return invalid
  const from = state.phase
  if (from === undefined) return refuse(state, 'supervisor root is required')
  const actorBlock = phaseActorBlock(state, data.actorNodeId, from, data.to)
  if (actorBlock !== undefined) return refuse(state, actorBlock)
  if (!legalPhaseEdge(from, data.to)) return refuse(state, `illegal phase jump from ${from} to ${data.to}`)
  const blocked = phaseBlock(state, from, data.to, data.taskId)
  if (blocked !== undefined) return refuse(state, blocked)
  if (from === 'final_review' && data.to === 'task_fix' && data.taskId !== undefined) {
    return commitBranchReopen(state, data.taskId)
  }
  return commitPhase(state, data.to)
}

/** Terminal failure. Later events are refused. */
function failRun(state: OrcState, event: Extract<OrcEvent, { type: 'orc/run/failed' }>): OrcState {
  const invalid = requireRun(state, event.data.runId)
  if (invalid !== undefined) return invalid
  if (state.phase === 'failed') return refuse(state, 'run has failed')
  if (state.phase === 'complete') return refuse(state, 'run is complete')
  const actorBlock = supervisorActorBlock(state, event.data.actorNodeId, 'lead cannot fail the run')
  if (actorBlock !== undefined) return refuse(state, actorBlock)
  return { ...state, phase: 'failed', terminalReason: event.data.reason }
}

/** Terminal success after the latest branch review and audit are clean. */
function completeRun(state: OrcState, event: Extract<OrcEvent, { type: 'orc/run/completed' }>): OrcState {
  const invalid = requireMutableRun(state, event.data.runId)
  if (invalid !== undefined) return invalid
  const actorBlock = supervisorActorBlock(state, event.data.actorNodeId, 'lead cannot complete the run')
  if (actorBlock !== undefined) return refuse(state, actorBlock)
  if (state.phase !== 'final_review') {
    return refuse(state, `illegal phase jump from ${state.phase ?? 'brainstorming'} to complete`)
  }
  const review = latestBranch(state, 'codex-review')
  const reviewProblem = reportProblem('branch review', review)
  if (reviewProblem !== undefined) return refuse(state, reviewProblem)
  if (review?.blocksProgress === true) return refuse(state, 'blocking findings require fix')
  const audit = latestBranch(state, 'codex-audit')
  const auditProblem = reportProblem('branch audit', audit)
  if (auditProblem !== undefined) return refuse(state, auditProblem)
  if (audit?.blocksProgress === true) return refuse(state, 'blocking findings require fix')
  return { ...state, phase: 'complete' }
}

/** Refuse when the run is missing, mismatched, failed, or complete. */
function requireMutableRun(state: OrcState, runId: OrcRunId): OrcState | undefined {
  const invalid = requireRun(state, runId)
  if (invalid !== undefined) return invalid
  if (state.phase === 'failed') return refuse(state, 'run has failed')
  if (state.phase === 'complete') return refuse(state, 'run is complete')
  return undefined
}

/** Refuse a correlation id already stored on a node or delegation. */
function rejectDuplicateCorrelation(state: OrcState, correlationId: OrcCorrelationId): OrcState | undefined {
  const known = state.delegations.some(item => item.correlationId === correlationId)
    || state.nodes.some(node => node.correlationId === correlationId)
  return known ? refuse(state, 'duplicate correlation id') : undefined
}

/** Copy caller-supplied provider selection without inventing a provider or model. */
function selectionOf(data: OrcProviderSelection): OrcProviderSelection {
  return {
    ...(data.provider === undefined ? {} : { provider: data.provider }),
    ...(data.model === undefined ? {} : { model: data.model }),
    ...(data.effort === undefined ? {} : { effort: data.effort }),
  }
}

/** Whether `from` may move to `to` before event preconditions are checked. */
function legalPhaseEdge(from: OrcWorkflowPhase, to: OrcWorkflowPhase): boolean {
  switch (from) {
    case 'brainstorming':
      return to === 'spec_required'
    case 'spec_required':
      return to === 'plan_required'
    case 'plan_required':
      return to === 'awaiting_user_approval'
    case 'awaiting_user_approval':
      return to === 'task_implementation'
    case 'task_implementation':
      return to === 'task_peer_settlement'
    case 'task_peer_settlement':
      return to === 'task_review'
    case 'task_review':
      return to === 'task_audit'
    case 'task_audit':
      return to === 'task_fix' || to === 'next_task' || to === 'final_review'
    case 'task_fix':
      return to === 'task_review'
    case 'next_task':
      return to === 'task_implementation'
    case 'final_review':
      return to === 'task_fix'
    case 'complete':
    case 'failed':
      return false
    default:
      return assertNever(from)
  }
}

/** Return the refusal for one legal edge, or undefined when the edge may commit. */
function phaseBlock(
  state: OrcState,
  from: OrcWorkflowPhase,
  to: OrcWorkflowPhase,
  taskId?: OrcTaskId,
): string | undefined {
  switch (from) {
    case 'brainstorming':
      return state.delegations.some(item => item.kind === 'codex-spec') ? undefined : 'codex spec request is missing'
    case 'spec_required':
      return textResultBlock(state, 'codex-spec', 'codex spec result is missing', 'codex spec failure blocks plan')
    case 'plan_required':
      return textResultBlock(state, 'codex-plan', 'codex plan result is missing', 'codex plan failure blocks approval')
    case 'awaiting_user_approval':
      if (state.approval === 'rejected') return 'user rejection blocks implementation'
      if (state.approval !== 'approved') return 'plan approval is required before implementation'
      if (state.tasks.length === 0) return 'task assignment is required before implementation'
      return undefined
    case 'task_implementation':
      return peerSettlementBlock(state)
    case 'task_peer_settlement': {
      const task = activeTask(state)
      return task?.phase === 'settled' ? undefined : 'task settlement is required before review'
    }
    case 'task_review':
      return taskReportProblem(state, 'codex-review', 'review')
    case 'task_audit':
      return leaveAudit(state, to)
    case 'task_fix':
      return leaveFix(state)
    case 'next_task':
      return undefined
    case 'final_review':
      return to === 'task_fix' ? branchReopenBlock(state, taskId) : `illegal phase jump from ${from} to ${to}`
    case 'complete':
    case 'failed':
      return `illegal phase jump from ${from} to ${to}`
    default:
      return assertNever(from)
  }
}

/** Require an ok Codex spec or plan before leaving its phase. */
function textResultBlock(state: OrcState, kind: 'codex-spec' | 'codex-plan', missing: string, failed: string): string | undefined {
  const delegation = latestDelegation(state, kind)
  if (delegation === undefined || delegation.status === 'open') return missing
  return delegation.status === 'ok' ? undefined : failed
}

/** Refuse peer settlement when the active Lead failed to start. */
function peerSettlementBlock(state: OrcState): string | undefined {
  const task = activeTask(state)
  const lead = task?.leadNodeId === undefined ? undefined : nodeById(state, task.leadNodeId)
  if (task === undefined || lead === undefined) return 'lead is required before peer settlement'
  if (lead.outcome !== undefined && lead.outcome !== 'settled') return 'lead startup failure blocks peer settlement'
  return undefined
}

/** Refuse leaving task audit without both current-iteration reports. */
function leaveAudit(state: OrcState, to: OrcWorkflowPhase): string | undefined {
  const task = activeTask(state)
  if (task === undefined) return 'audit result is missing'
  const auditProblem = taskReportProblem(state, 'codex-audit', 'audit')
  if (auditProblem !== undefined) return auditProblem
  const reviewProblem = taskReportProblem(state, 'codex-review', 'review')
  if (reviewProblem !== undefined) return reviewProblem
  const review = findReport(state, 'codex-review', 'task', task.iteration, task.id)
  const audit = findReport(state, 'codex-audit', 'task', task.iteration, task.id)
  const findingsBlock = review?.blocksProgress === true || audit?.blocksProgress === true
  if (findingsBlock && to !== 'task_fix') return 'blocking findings require fix'
  if (!findingsBlock && to === 'task_fix') return 'illegal phase jump from task_audit to task_fix'
  const remaining = state.tasks.some(item => item.id !== task.id && item.phase !== 'clean')
  if (to === 'next_task' && !remaining) return 'no remaining task'
  if (to === 'final_review' && remaining) return 'remaining task requires next_task'
  return undefined
}

/** Refuse returning to review until `orc/fix/iteration` records the next iteration. */
function leaveFix(state: OrcState): string | undefined {
  const task = activeTask(state)
  if (task === undefined) return 'fix iteration is required before review'
  const audited = latestSettledIteration(state, 'codex-audit', task.id)
  if (task.fixDecision === undefined || audited === undefined || task.iteration <= audited) {
    return 'fix iteration is required before review'
  }
  return undefined
}

/** Refuse a Peer, a missing node, or a Lead on an edge the Supervisor owns. */
function phaseActorBlock(state: OrcState, actorNodeId: OrcNodeId, from: OrcWorkflowPhase, to: OrcWorkflowPhase): string | undefined {
  const actor = nodeById(state, actorNodeId)
  if (actor === undefined) return 'phase actor is missing'
  if (actor.role === 'peer') return 'peer cannot advance the workflow'
  if (actor.role === 'lead' && !taskLocalEdge(from, to)) return 'lead cannot advance this phase'
  return undefined
}

/** Task implementation, settlement, review, audit, and the fix loop. Sequencing is not included. */
function taskLocalEdge(from: OrcWorkflowPhase, to: OrcWorkflowPhase): boolean {
  return (from === 'task_implementation' && to === 'task_peer_settlement')
    || (from === 'task_peer_settlement' && to === 'task_review')
    || (from === 'task_review' && to === 'task_audit')
    || (from === 'task_audit' && to === 'task_fix')
    || (from === 'task_fix' && to === 'task_review')
}

/** Terminal and sequencing events belong to the Supervisor. */
function supervisorActorBlock(state: OrcState, actorNodeId: OrcNodeId, leadMessage: string): string | undefined {
  const actor = nodeById(state, actorNodeId)
  if (actor === undefined) return 'run actor is missing'
  if (actor.role === 'peer') return 'peer cannot advance the workflow'
  if (actor.role !== 'supervisor') return leadMessage
  return undefined
}

/** Refuse reopening a task that has no blocking branch finding. */
function branchReopenBlock(state: OrcState, taskId: OrcTaskId | undefined): string | undefined {
  if (taskId === undefined) return 'branch reopen requires a task id'
  if (taskById(state, taskId) === undefined) return 'task is not assigned'
  if (!hasBlockingBranchFinding(state, taskId)) return 'blocking branch finding is required'
  return undefined
}

/** Whether an ok branch report recorded a blocking finding for this task. */
function hasBlockingBranchFinding(state: OrcState, taskId: OrcTaskId): boolean {
  return state.findings.some((finding) => {
    if (finding.scope !== 'branch' || finding.taskId !== taskId) return false
    if (!state.blockingSeverities.includes(finding.severity)) return false
    const delegation = delegationByCorrelation(state, finding.correlationId)
    return delegation?.status === 'ok' && delegation.blocksProgress === true
  })
}

/** Return one task to fix. `orc/fix/iteration` records the next iteration. */
function commitBranchReopen(state: OrcState, taskId: OrcTaskId): OrcState {
  return {
    ...mapTask(state, taskId, task => ({ ...task, phase: 'fix' })),
    phase: 'task_fix',
    activeTaskId: taskId,
  }
}

/** Missing or non-ok report refusal for the active task's current iteration. */
function taskReportProblem(state: OrcState, kind: 'codex-review' | 'codex-audit', label: string): string | undefined {
  const task = activeTask(state)
  if (task === undefined) return `${label} result is missing`
  return reportProblem(label, findReport(state, kind, 'task', task.iteration, task.id))
}

/** Refusal for one report delegation. `ok` is not a refusal, even when findings block later. */
function reportProblem(label: string, delegation: OrcDelegation | undefined): string | undefined {
  if (delegation === undefined || delegation.status === 'open') return `${label} result is missing`
  if (delegation.status === 'ok') return undefined
  if (delegation.status === 'unavailable') return `${label} result is unavailable and blocks progression`
  if (delegation.status === 'malformed') return `${label} result is malformed and blocks progression`
  return `${label} result is failed and blocks progression`
}

/** Commit a phase, updating the active task when the edge owns that change. */
function commitPhase(state: OrcState, to: OrcWorkflowPhase): OrcState {
  const task = activeTask(state)
  if (to === 'final_review') {
    const cleaned = task === undefined
      ? state
      : mapTask(state, task.id, current => ({ ...current, phase: 'clean' }))
    const { activeTaskId: _activeTaskId, ...rest } = cleaned
    return { ...rest, phase: 'final_review', branchVisit: (state.branchVisit ?? -1) + 1 }
  }
  if (task !== undefined && to === 'next_task') {
    const { activeTaskId: _activeTaskId, ...rest } = mapTask(state, task.id, current => ({ ...current, phase: 'clean' }))
    return { ...rest, phase: to }
  }
  if (task !== undefined && (to === 'task_review' || to === 'task_audit' || to === 'task_fix')) {
    const phase = to === 'task_review' ? 'review' : to === 'task_audit' ? 'audit' : 'fix'
    return { ...mapTask(state, task.id, current => ({ ...current, phase })), phase: to }
  }
  return { ...state, phase: to }
}

/** Replace one task by id. */
function mapTask(state: OrcState, taskId: OrcTaskId, update: (task: OrcTask) => OrcTask): OrcState {
  return { ...state, tasks: state.tasks.map(task => task.id === taskId ? update(task) : task) }
}

/** Active task, when one has been started and not yet left behind. */
function activeTask(state: OrcState): OrcTask | undefined {
  return state.activeTaskId === undefined ? undefined : taskById(state, state.activeTaskId)
}

/** Find one task by id. */
function taskById(state: OrcState, taskId: OrcTaskId): OrcTask | undefined {
  return state.tasks.find(task => task.id === taskId)
}

/** Find one node by id. */
function nodeById(state: OrcState, nodeId: OrcNodeId): OrcNode | undefined {
  return state.nodes.find(node => node.id === nodeId)
}

/** Find one delegation by correlation id. */
function delegationByCorrelation(state: OrcState, correlationId: OrcCorrelationId): OrcDelegation | undefined {
  return state.delegations.find(item => item.correlationId === correlationId)
}

/** Last branch report of one kind in the current final-review visit. */
function latestBranch(state: OrcState, kind: 'codex-review' | 'codex-audit'): OrcDelegation | undefined {
  if (state.branchVisit === undefined) return undefined
  let found: OrcDelegation | undefined
  for (const item of state.delegations) {
    if (item.kind === kind && item.scope === 'branch' && item.iteration === state.branchVisit) found = item
  }
  return found
}

/** A task that has left assignment and is neither clean nor failed. */
function taskInFlight(task: OrcTask): boolean {
  return task.phase !== 'assigned' && task.phase !== 'clean' && task.phase !== 'failed'
}

/** Last delegation of one kind, optionally limited to a review scope. */
function latestDelegation(state: OrcState, kind: OrcDelegationKind, scope?: 'workflow' | OrcReviewScope): OrcDelegation | undefined {
  let found: OrcDelegation | undefined
  for (const item of state.delegations) {
    if (item.kind === kind && (scope === undefined || item.scope === scope)) found = item
  }
  return found
}

/** Exact review or audit slot for one scope, iteration, and optional task. */
function findReport(
  state: OrcState,
  kind: 'codex-review' | 'codex-audit',
  scope: OrcReviewScope,
  iteration: number,
  taskId: OrcTaskId | undefined,
): OrcDelegation | undefined {
  return state.delegations.find(item => item.kind === kind
    && item.scope === scope
    && item.iteration === iteration
    && (taskId === undefined ? item.taskId === undefined : item.taskId === taskId))
}

/** Highest settled review or audit iteration for one task. */
function latestSettledIteration(state: OrcState, kind: 'codex-review' | 'codex-audit', taskId: OrcTaskId): number | undefined {
  let iteration: number | undefined
  for (const item of state.delegations) {
    if (item.kind === kind && item.taskId === taskId && item.status !== 'open') iteration = item.iteration
  }
  return iteration
}

/** Close a closed event union. */
function assertNever(value: never): never {
  throw new Error(`unexpected ORC event ${String(value)}`)
}
