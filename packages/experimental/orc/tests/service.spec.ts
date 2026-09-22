import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ContinuableStart, ContinuableStartSpec, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OrcCorrelationId,
  OrcFindingId,
  OrcService,
  OrcTaskId,
  type OrcLaunch,
  type OrcServiceConfig,
} from '../src/index.ts'
import type { OrcDelegationKind, OrcNodeOutcome, OrcReportStatus } from '../src/types.ts'
import * as OrcInvariant from '../src/invariant.ts'

const SIGNAL = new AbortController().signal
const TASK = OrcTaskId('task-a')
const BLOCKING = ['critical', 'high', 'medium'] as const

const CONFIG: OrcServiceConfig = {
  deepseek: {
    subagentProvider: 'deepseek-continuable',
    provider: 'deepseek-route',
    model: 'deepseek-route-model',
    effort: 'deepseek-route-effort',
  },
  codexSpec: {
    subagentProvider: 'codex-spec-provider',
    provider: 'codex-spec-route',
    model: 'spec-route-model',
    effort: 'spec-route-effort',
  },
  codexPlan: {
    subagentProvider: 'codex-plan-provider',
    provider: 'codex-plan-route',
    model: 'plan-route-model',
    effort: 'plan-route-effort',
  },
  codexReview: {
    subagentProvider: 'codex-review-provider',
    provider: 'codex-review-route',
    model: 'review-route-model',
    effort: 'review-route-effort',
  },
  codexAudit: {
    subagentProvider: 'codex-audit-provider',
    provider: 'codex-audit-route',
    model: 'audit-route-model',
    effort: 'audit-route-effort',
  },
  repositoryPath: '/repo/orc',
  skillRequirements: 'superpowers workflow',
  specOutputSchema: 'spec-schema',
  planOutputSchema: 'plan-schema',
  reviewOutputSchema: 'review-schema',
  auditOutputSchema: 'audit-schema',
}

class FakeAgents extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  get(): undefined {
    return undefined
  }

  list(): Agent[] {
    return []
  }
}

class FakePersistence extends Service {
  flushFailure: Error | undefined

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async flush(): Promise<void> {
    if (this.flushFailure !== undefined) {
      const failure = this.flushFailure
      this.flushFailure = undefined
      throw failure
    }
  }
}

class FakeSubagents extends Service {
  readonly continuable: ContinuableStartSpec[] = []
  readonly oneShot: { name: string; request: SubagentStartRequest }[] = []
  failContinuable = false
  failOneShot = false
  oneShotResult: Promise<unknown> = new Promise(() => {})

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    if (this.failOneShot) throw new Error('one-shot start failed')
    this.oneShot.push({ name, request })
    const id = SessionId(`shot-${this.oneShot.length}`)
    return {
      id,
      localAgent: undefined,
      result: this.oneShotResult as SubagentRun['result'],
      dispose: () => Promise.resolve(),
    }
  }

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    if (this.failContinuable) throw new Error('continuable start failed')
    this.continuable.push(spec)
    return { childId: spec.childId ?? SessionId('missing-child'), messageId: 'msg-1' as ContinuableStart['messageId'] }
  }
}

interface Harness {
  ctx: Context
  service: OrcService
  supervisor: Agent
  fake: FakeSubagents
  fiber: { dispose(): Promise<void> }
}

const open: Context[] = []

afterEach(async () => {
  const pending = open.splice(0)
  await Promise.all(pending.map(async (ctx) => {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      // A context that failed during plugin startup has nothing further to release.
      void error
    }
  }))
})

function asAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session, options: {} } as Agent
}

async function setup(config: OrcServiceConfig = CONFIG): Promise<Harness> {
  const ctx = new Context()
  open.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeAgents)
  await ctx.plugin(FakePersistence)
  await ctx.plugin(FakeSubagents)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(OrcInvariant)
  const fiber = await ctx.plugin(OrcService, config)
  return { ctx, service: ctx.orc, supervisor: asAgent(ctx, 'supervisor'), fake: ctx.get('subagents') as FakeSubagents, fiber }
}

function leadInput(taskId: ReturnType<typeof OrcTaskId> = TASK) {
  return {
    role: 'lead' as const,
    taskId,
    prompt: 'lead prompt',
    skillEnvelope: 'superpowers lead',
    writeScope: ['src'],
    acceptanceCriteria: 'report evidence',
    reportingFormat: 'settlement event',
    signal: SIGNAL,
  }
}

function peerInput(taskId: ReturnType<typeof OrcTaskId> = TASK) {
  return { ...leadInput(taskId), role: 'peer' as const, prompt: 'peer prompt', skillEnvelope: 'superpowers peer' }
}


async function userReview(
  service: { planReviewSettled(): Promise<void> },
  session: { append: (type: string, data: unknown) => unknown },
  decision: 'approved' | 'rejected' = 'approved',
): Promise<void> {
  session.append('plan/review', { version: 1, correlation: 'plan-review-1', decision })
  await service.planReviewSettled()
}

async function createRun(harness: Harness): Promise<void> {
  await harness.service.createWorkflow(harness.supervisor, {
    prompt: 'Supervisor prompt',
    skillEnvelope: 'superpowers',
    writeScope: ['repo'],
    acceptanceCriteria: 'run reaches complete',
    reportingFormat: 'durable events',
    blockingSeverities: [...BLOCKING],
  })
}

async function planReady(harness: Harness): Promise<void> {
  await createRun(harness)
  const spec = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
  await harness.service.recordResult(harness.supervisor, {
    correlationId: spec.correlationId,
    stage: 'codex-spec',
    role: 'spec-only',
    status: 'ok',
    text: 'design spec',
  })
  const plan = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
  await harness.service.recordResult(harness.supervisor, {
    correlationId: plan.correlationId,
    stage: 'codex-plan',
    role: 'plan-only',
    status: 'ok',
    text: 'implementation plan',
  })
  expect(harness.service.state(harness.supervisor).phase).toBe('plan_required')
}

async function awaitingApproval(harness: Harness): Promise<void> {
  await planReady(harness)
  await harness.service.advance(harness.supervisor, 'awaiting_user_approval')
}

async function implementing(harness: Harness): Promise<void> {
  await awaitingApproval(harness)
  await userReview(harness.service, harness.supervisor.session)
  await harness.service.assignTask(harness.supervisor, {
    taskId: TASK,
    writeScope: ['src'],
    acceptanceCriteria: 'done task-a',
  })
  await harness.service.advance(harness.supervisor, 'task_implementation')
}

function agentFor(ctx: Context, launch: OrcLaunch): Agent {
  return asAgent(ctx, String(launch.nodeId))
}

describe('ORC service role tree', () => {
  it('rejects config that omits a route field', async () => {
    const ctx = new Context()
    open.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(FakeAgents)
    await ctx.plugin(FakePersistence)
    await ctx.plugin(FakeSubagents)
    const { model: _model, ...codexSpec } = CONFIG.codexSpec
    await expect(ctx.plugin(OrcService, { ...CONFIG, codexSpec })).rejects.toThrow(/invalid ORC config/)
  })

  it('refuses a hidden blocking threshold and records the configured route', async () => {
    const harness = await setup()
    await expect(harness.service.createWorkflow(harness.supervisor, {
      prompt: 'Supervisor prompt',
      skillEnvelope: 'superpowers',
      writeScope: ['repo'],
      acceptanceCriteria: 'run reaches complete',
      reportingFormat: 'durable events',
      blockingSeverities: ['low'],
    })).rejects.toThrow(/critical, high, and medium/)
    expect(harness.service.state(harness.supervisor).runId).toBeUndefined()

    await createRun(harness)
    const state = harness.service.state(harness.supervisor)
    expect(state.phase).toBe('brainstorming')
    expect(state.blockingSeverities).toEqual([...BLOCKING])
    expect(harness.service.roleOf(harness.supervisor)).toBe('supervisor')
    expect(harness.service.childrenOf(harness.supervisor)).toEqual([])
    expect(state.nodes[0]).toMatchObject({
      provider: CONFIG.deepseek.provider,
      model: CONFIG.deepseek.model,
      effort: CONFIG.deepseek.effort,
    })
    const append = harness.supervisor.session.append.bind(harness.supervisor.session) as (type: string, data: unknown) => void
    append('session/end-seed', {})
    expect(harness.service.state(harness.supervisor).phase).toBe('brainstorming')
    expect(harness.ctx.sessionProjections.stateOf(harness.supervisor.session, 'orc')?.phase).toBe('brainstorming')
    const runId = harness.service.state(harness.supervisor).runId
    append('orc/spec/requested', {
      version: 1,
      runId,
      correlationId: 'bare-spec',
      contextRef: 'brainstorm-1',
      role: 'spec-only',
      repositoryPath: '/repo/orc',
      skillRequirements: 'superpowers workflow',
      outputSchema: 'spec-schema',
      readOnly: true,
    })
    const bare = harness.service.registration(harness.supervisor, OrcCorrelationId('bare-spec'))
    expect(bare?.provider).toBeUndefined()
    expect(bare?.model).toBeUndefined()
    expect(bare?.effort).toBeUndefined()
    expect(bare?.role).toBe('spec-only')
    expect(bare?.continuation).toBeUndefined()
    await expect(harness.service.requestReview(harness.supervisor, { scope: 'branch', signal: SIGNAL })).rejects.toThrow(/not allowed/)
    await expect(harness.service.requestReview(harness.supervisor, {
      scope: 'task',
      taskId: TASK,
      signal: SIGNAL,
    })).rejects.toThrow(/not allowed/)
  })

  it('spawns only Supervisor to Lead and Lead to Peer', async () => {
    const harness = await setup()
    const stranger = asAgent(harness.ctx, 'stranger')
    await expect(harness.service.spawn(stranger, leadInput())).rejects.toThrow(/supervisor root is required/)
    expect(harness.fake.continuable).toHaveLength(0)
    expect(harness.service.childrenOf(stranger)).toEqual([])
    expect(harness.service.roleOf(stranger)).toBeUndefined()

    await implementing(harness)
    await expect(harness.service.spawn(harness.supervisor, peerInput())).rejects.toThrow(/supervisor cannot create a peer/)
    expect(harness.fake.continuable).toHaveLength(0)

    const leadLaunch = await harness.service.spawn(harness.supervisor, leadInput())
    const lead = agentFor(harness.ctx, leadLaunch)
    expect(leadLaunch.spawned).toBe(true)
    expect(harness.service.roleOf(lead)).toBe('lead')
    expect(harness.service.childrenOf(harness.supervisor).map(node => node.id)).toEqual([leadLaunch.nodeId])
    expect(harness.fake.continuable).toHaveLength(1)
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: leadLaunch.correlationId,
      stage: 'deepseek-node',
      role: 'lead',
      taskId: TASK,
    })).rejects.toThrow(/node outcome is required/)
    expect(harness.fake.continuable[0]).toMatchObject({
      provider: CONFIG.deepseek.subagentProvider,
      label: 'lead',
      childId: leadLaunch.nodeId,
      request: {
        parent: harness.supervisor,
        agentOptions: {
          provider: CONFIG.deepseek.provider,
          model: CONFIG.deepseek.model,
          reasoningEffort: CONFIG.deepseek.effort,
        },
        prompt: [{ type: 'text', text: 'lead prompt\nsuperpowers lead' }],
      },
    })
    expect(harness.fake.continuable[0]?.request).not.toHaveProperty('outputSchema')
    expect(harness.fake.continuable[0]?.request).not.toHaveProperty('maxDepth')
    const registered = harness.service.registration(harness.supervisor, leadLaunch.correlationId)
    expect(registered).toMatchObject({
      parentId: harness.supervisor.id,
      role: 'lead',
      taskId: TASK,
      stage: 'deepseek-node',
      provider: CONFIG.deepseek.provider,
      model: CONFIG.deepseek.model,
      effort: CONFIG.deepseek.effort,
      continuation: { kind: 'continuable', id: leadLaunch.nodeId, messageId: 'msg-1' },
    })

    await harness.service.startTask(harness.supervisor, { taskId: TASK, leadNodeId: leadLaunch.nodeId! })
    const peerLaunch = await harness.service.spawn(lead, peerInput())
    const peer = agentFor(harness.ctx, peerLaunch)
    expect(harness.service.roleOf(peer)).toBe('peer')
    expect(harness.service.childrenOf(lead).map(node => node.role)).toEqual(['peer'])
    expect(harness.service.childrenOf(peer)).toEqual([])
    await expect(harness.service.spawn(peer, peerInput())).rejects.toThrow(/peer cannot spawn a child/)
    expect(harness.fake.continuable).toHaveLength(2)
    await expect(harness.service.advance(peer, 'task_peer_settlement')).rejects.toThrow(/peer cannot advance/)
    await expect(harness.service.fail(lead, 'lead stop')).rejects.toThrow(/lead cannot fail the run/)
  })
})

describe('ORC supervisor authority', () => {
  it('refuses spec, approval, and assignment from a caller who is not the supervisor', async () => {
    const harness = await setup()
    await createRun(harness)
    const intruder = { id: SessionId('intruder'), session: harness.supervisor.session, options: {} } as Agent
    await expect(harness.service.startSpecPlan(intruder, 'brainstorm-1', SIGNAL)).rejects.toThrow(/only the supervisor/)
    expect(harness.fake.oneShot).toHaveLength(0)
    expect(harness.service.state(harness.supervisor).phase).toBe('brainstorming')

    const spec = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    await harness.service.recordResult(harness.supervisor, {
      correlationId: spec.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'design spec',
    })
    const plan = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    await harness.service.recordResult(harness.supervisor, {
      correlationId: plan.correlationId,
      stage: 'codex-plan',
      role: 'plan-only',
      status: 'ok',
      text: 'implementation plan',
    })
    await harness.service.advance(harness.supervisor, 'awaiting_user_approval')
    const mode = harness.supervisor.session.append.bind(harness.supervisor.session) as (type: string, data: unknown) => void
    mode('plan/mode', { active: false })
    await harness.service.planReviewSettled()
    expect(harness.service.state(harness.supervisor).approval).toBeUndefined()
    await expect(harness.service.assignTask(intruder, {
      taskId: TASK,
      writeScope: ['src'],
      acceptanceCriteria: 'done',
    })).rejects.toThrow(/only the supervisor/)
    expect(harness.service.state(harness.supervisor).approval).toBeUndefined()
    expect(harness.service.state(harness.supervisor).tasks).toEqual([])
    await userReview(harness.service, harness.supervisor.session)
    expect(harness.service.state(harness.supervisor).approval).toBe('approved')
  })

  it('records a review that arrives in plan_required and ignores one from before the plan', async () => {
    const stale = await setup()
    await createRun(stale)
    stale.supervisor.session.append('plan/review', { version: 1, correlation: 'old-exit', decision: 'approved' })
    await stale.service.planReviewSettled()
    const spec = await stale.service.startSpecPlan(stale.supervisor, 'brainstorm-1', SIGNAL)
    await stale.service.recordResult(stale.supervisor, {
      correlationId: spec.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'design spec',
    })
    const plan = await stale.service.startSpecPlan(stale.supervisor, 'brainstorm-1', SIGNAL)
    await stale.service.recordResult(stale.supervisor, {
      correlationId: plan.correlationId,
      stage: 'codex-plan',
      role: 'plan-only',
      status: 'ok',
      text: 'implementation plan',
    })
    await stale.fiber.dispose()
    await stale.ctx.plugin(OrcService, CONFIG)
    const resumed = stale.ctx.orc
    await resumed.planReviewSettled()
    expect(resumed.state(stale.supervisor).phase).toBe('plan_required')
    expect(resumed.state(stale.supervisor).approval).toBeUndefined()
    await resumed.advance(stale.supervisor, 'awaiting_user_approval')
    expect(resumed.state(stale.supervisor).approval).toBeUndefined()

    const harness = await setup()
    await planReady(harness)
    const session = harness.supervisor.session
    session.append('plan/review', { version: 1, correlation: 'exit-inline', decision: 'rejected' })
    await expect(harness.service.assignTask(harness.supervisor, {
      taskId: TASK,
      writeScope: ['src'],
      acceptanceCriteria: 'done task-a',
    })).rejects.toThrow(/user rejection blocks implementation/)
    expect(harness.service.state(harness.supervisor).phase).toBe('awaiting_user_approval')
    expect(harness.service.state(harness.supervisor).approval).toBe('rejected')
    session.append('plan/review', { version: 1, correlation: 'exit-after-reject', decision: 'approved' })
    await harness.service.planReviewSettled()
    const state = harness.service.state(harness.supervisor)
    expect(state.approval).toBe('approved')
    expect(state.approvalCorrelation).toBe('exit-after-reject')
    const logged = session.snapshotEvents().map(event => ({
      type: event.type as string,
      seq: event.seq,
      data: event.data as { status?: string; correlation?: string; decision?: string; reviewSeq?: number; source?: string },
    }))
    const planSeq = logged.find(event => event.type === 'orc/plan/result' && event.data.status === 'ok')?.seq
    const review = logged.find(event => event.type === 'plan/review' && event.data.correlation === 'exit-after-reject')
    const approval = logged.find(event => event.type === 'orc/plan/approval' && event.data.decision === 'approved')
    expect(review?.seq).toBeGreaterThan(planSeq ?? -1)
    expect(approval?.data).toMatchObject({
      source: 'plan/review',
      correlation: 'exit-after-reject',
      reviewSeq: review?.seq,
    })
    await harness.service.assignTask(harness.supervisor, {
      taskId: TASK,
      writeScope: ['src'],
      acceptanceCriteria: 'done task-a',
    })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await expect(harness.service.spawn(harness.supervisor, leadInput())).resolves.toMatchObject({ spawned: true })
  })

  it('rejects planReviewSettled when the approval append fails and still accepts a later review', async () => {
    const harness = await setup()
    await planReady(harness)
    const session = harness.supervisor.session
    const original = session.append.bind(session) as (type: string, data: unknown) => unknown
    let refuseApproval = true
    session.append = ((type: string, data: unknown) => {
      if (refuseApproval && type === 'orc/plan/approval') throw new Error('approval append refused')
      return original(type, data)
    }) as typeof session.append
    original('plan/review', { version: 1, correlation: 'exit-blocked', decision: 'approved' })
    await expect(harness.service.planReviewSettled()).rejects.toThrow(/approval append refused/)
    expect(harness.service.state(harness.supervisor).approval).toBeUndefined()
    refuseApproval = false
    original('plan/review', { version: 1, correlation: 'exit-after-failure', decision: 'approved' })
    await harness.service.planReviewSettled()
    expect(harness.service.state(harness.supervisor).approval).toBe('approved')
    expect(harness.service.state(harness.supervisor).approvalCorrelation).toBe('exit-after-failure')
  })
})

describe('ORC delegated results', () => {
  it('ignores child output until the run, task, stage, and role match', async () => {
    const harness = await setup()
    await createRun(harness)
    const launch = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(launch.spawned).toBe(true)
    expect(launch.kind).toBe('codex-spec')
    expect(harness.service.state(harness.supervisor).phase).toBe('spec_required')
    expect(harness.service.state(harness.supervisor).specText).toBeUndefined()
    const shot = harness.fake.oneShot[0]
    expect(shot?.name).toBe(CONFIG.codexSpec.subagentProvider)
    expect(shot?.request.outputSchema).toBeUndefined()
    expect(shot?.request.maxDepth).toBeUndefined()
    expect(shot?.request.agentOptions).toBeUndefined()
    expect(shot?.request.prompt).toEqual([{
      type: 'text',
      text: [
        'role: spec-only',
        'stage: codex-spec',
        'task: none',
        'repositoryScope: /repo/orc',
        'skillWorkflow: superpowers workflow',
        'expectedStructuredResult: spec-schema',
        'jsonContract: {"stage":"codex-spec","spec":"<non-empty string>"}',
        'severityPolicy: critical, high, and medium block; low and info do not unless blockingSeverities includes them',
        'blockingSeverities: critical, high, medium',
        'readOnly: true',
        'doNotEdit: true',
        'Do not edit files. Do not create subagents. Do not declare an implementation complete.',
        'Native Codex children do not inherit DSH skills or context.',
        'provider: codex-spec-route',
        'model: spec-route-model',
        'effort: spec-route-effort',
        'contextRef: brainstorm-1',
      ].join('\n'),
    }])
    await Promise.resolve()
    expect(harness.service.state(harness.supervisor).specText).toBeUndefined()
    expect(harness.service.state(harness.supervisor).delegations[0]?.status).toBe('open')

    const before = harness.supervisor.session.snapshotEvents().length
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: OrcCorrelationId('missing'),
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'nope',
    })).rejects.toThrow(/unknown correlation id/)
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: launch.correlationId,
      stage: 'codex-plan',
      role: 'spec-only',
      status: 'ok',
      text: 'nope',
    })).rejects.toThrow(/stage/)
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: launch.correlationId,
      stage: 'codex-spec',
      role: 'plan-only',
      status: 'ok',
      text: 'nope',
    })).rejects.toThrow(/role/)
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: launch.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      taskId: TASK,
      status: 'ok',
      text: 'nope',
    })).rejects.toThrow(/task/)
    expect(harness.supervisor.session.snapshotEvents()).toHaveLength(before)
    expect(harness.service.state(harness.supervisor).specText).toBeUndefined()
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: launch.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
    })).rejects.toThrow(/report status is required/)
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: launch.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
    })).rejects.toThrow(/requires text/)

    await harness.service.recordResult(harness.supervisor, {
      correlationId: launch.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'design spec',
    })
    expect(harness.service.state(harness.supervisor).specText).toBe('design spec')
    const plan = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: plan.correlationId,
      stage: 'codex-plan',
      role: 'plan-only',
      status: 'ok',
    })).rejects.toThrow(/requires text/)
    await harness.service.recordResult(harness.supervisor, {
      correlationId: plan.correlationId,
      stage: 'codex-plan',
      role: 'plan-only',
      status: 'malformed',
    })
    expect(harness.service.state(harness.supervisor).delegations.at(-1)).toMatchObject({
      status: 'malformed',
      blocksProgress: true,
    })
    expect(harness.service.registration(harness.supervisor, launch.correlationId)).toMatchObject({
      stage: 'codex-spec',
      role: 'spec-only',
      provider: CONFIG.codexSpec.provider,
      model: CONFIG.codexSpec.model,
      effort: CONFIG.codexSpec.effort,
      continuation: { kind: 'one-shot', id: 'shot-1' },
    })
  })

  it('records Codex failure, malformed output, and missing output as blocking', async () => {
    const harness = await setup()
    await createRun(harness)
    harness.fake.failOneShot = true
    await expect(harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/one-shot start failed/)
    expect(harness.fake.oneShot).toHaveLength(0)
    let state = harness.service.state(harness.supervisor)
    expect(state.phase).toBe('spec_required')
    expect(state.delegations[0]).toMatchObject({ kind: 'codex-spec', status: 'failed', blocksProgress: true })
    await expect(harness.service.advance(harness.supervisor, 'plan_required')).rejects.toThrow(/codex spec failure blocks plan/)

    const rejected = Promise.reject(new Error('result rejected'))
    void rejected.catch(() => undefined)
    harness.fake.failOneShot = false
    harness.fake.oneShotResult = rejected
    const retry = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    state = await harness.service.awaitCodex(harness.supervisor, retry.correlationId)
    expect(retry.spawned).toBe(true)
    expect(state.specText).toBeUndefined()
    expect(state.delegations.at(-1)).toMatchObject({ status: 'unavailable', blocksProgress: true, rawText: 'result rejected' })
    await expect(harness.service.advance(harness.supervisor, 'plan_required')).rejects.toThrow(/failure/)

    harness.fake.oneShotResult = new Promise(() => {})
    const missing = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    await harness.service.recordResult(harness.supervisor, {
      correlationId: missing.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'unavailable',
    })
    expect(harness.service.state(harness.supervisor).delegations.at(-1)).toMatchObject({
      status: 'unavailable',
      blocksProgress: true,
    })
    await expect(harness.service.recordResult(harness.supervisor, {
      correlationId: missing.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'late',
    })).rejects.toThrow(/already settled|correlation/)
  })

  it('leaves timeout, cancellation, and incomplete peers unsettled and fails startup', async () => {
    const harness = await setup()
    await implementing(harness)
    harness.fake.failContinuable = true
    await expect(harness.service.spawn(harness.supervisor, leadInput())).rejects.toThrow(/continuable start failed/)
    expect(harness.service.state(harness.supervisor).tasks[0]?.phase).toBe('failed')
    expect(harness.service.state(harness.supervisor).phase).toBe('task_implementation')
    expect(harness.service.state(harness.supervisor).delegations.at(-1)).toMatchObject({
      status: 'failed',
      blocksProgress: true,
    })
    await expect(harness.service.advance(harness.supervisor, 'task_peer_settlement')).rejects.toThrow(/lead/)

    const outcomes: OrcNodeOutcome[] = ['timeout', 'cancelled', 'incomplete']
    for (const outcome of outcomes) {
      const again = await setup()
      await implementing(again)
      const leadLaunch = await again.service.spawn(again.supervisor, leadInput())
      await again.service.startTask(again.supervisor, { taskId: TASK, leadNodeId: leadLaunch.nodeId! })
      const peerLaunch = await again.service.spawn(agentFor(again.ctx, leadLaunch), peerInput())
      await again.service.recordResult(again.supervisor, {
        correlationId: peerLaunch.correlationId,
        stage: 'deepseek-node',
        role: 'peer',
        taskId: TASK,
        outcome,
        ...(outcome === 'timeout' ? {} : { evidence: outcome }),
      })
      const state = again.service.state(again.supervisor)
      expect(state.nodes.find(node => node.id === peerLaunch.nodeId)?.outcome).toBe(outcome)
      expect(state.tasks[0]?.phase).toBe('unsettled')
      expect(state.delegations.find(item => item.correlationId === peerLaunch.correlationId)).toMatchObject({
        status: 'failed',
        blocksProgress: true,
      })
      await expect(again.service.settleTask(again.supervisor, {
        taskId: TASK,
        leadNodeId: leadLaunch.nodeId!,
        evidence: 'not yet',
      })).rejects.toThrow(/unsettled|peer settlement/)
    }
  })

  it('fails closed when the session append rejects', async () => {
    const harness = await setup()
    const session = harness.supervisor.session
    const original = session.append.bind(session)
    session.append = () => {
      throw new Error('disk full')
    }
    await expect(harness.service.createWorkflow(harness.supervisor, {
      prompt: 'Supervisor prompt',
      skillEnvelope: 'superpowers',
      writeScope: ['repo'],
      acceptanceCriteria: 'run reaches complete',
      reportingFormat: 'durable events',
      blockingSeverities: [...BLOCKING],
    })).rejects.toThrow(/ORC append failed: disk full/)
    expect(harness.service.state(harness.supervisor).runId).toBeUndefined()
    session.append = original

    await implementing(harness)
    const leadSession = harness.supervisor.session
    harness.fake.startContinuable = async () => {
      throw 'continuable boom'
    }
    const append = leadSession.append.bind(leadSession)
    leadSession.append = ((type: string, data: unknown) => {
      if (type === 'orc/node/settled') throw new Error('failure append rejected')
      return (append as (eventType: string, eventData: unknown) => unknown)(type, data)
    }) as Session['append']
    await expect(harness.service.spawn(harness.supervisor, leadInput())).rejects.toBeInstanceOf(AggregateError)
    const state = harness.service.state(harness.supervisor)
    expect(state.phase).toBe('task_implementation')
    expect(state.delegations.some(item => item.kind === 'deepseek-node' && item.status === 'open')).toBe(true)

    const specAppend = await setup()
    await createRun(specAppend)
    const specSession = specAppend.supervisor.session
    const specAppendOriginal = specSession.append.bind(specSession)
    specSession.append = ((type: string, data: unknown) => {
      if (type === 'orc/spec/result') throw new Error('spec failure append rejected')
      return (specAppendOriginal as (eventType: string, eventData: unknown) => unknown)(type, data)
    }) as Session['append']
    specAppend.fake.failOneShot = true
    await expect(specAppend.service.startSpecPlan(specAppend.supervisor, 'brainstorm-1', SIGNAL)).rejects.toBeInstanceOf(AggregateError)
    expect(specAppend.service.state(specAppend.supervisor).delegations[0]?.status).toBe('open')
    expect(specAppend.service.state(specAppend.supervisor).delegations[0]?.continuationId).toBeUndefined()
    specSession.append = specAppendOriginal
    specAppend.fake.failOneShot = false
    await expect(specAppend.service.startSpecPlan(specAppend.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/no continuation handle/)
    expect(specAppend.service.state(specAppend.supervisor).delegations[0]).toMatchObject({
      status: 'failed',
      blocksProgress: true,
    })
    expect(specAppend.service.state(specAppend.supervisor).phase).toBe('spec_required')
    expect(specAppend.fake.oneShot).toHaveLength(0)
    const retry = await specAppend.service.startSpecPlan(specAppend.supervisor, 'brainstorm-1', SIGNAL)
    expect(retry.spawned).toBe(true)
    expect(retry.correlationId).not.toBe(specAppend.service.state(specAppend.supervisor).delegations[0]?.correlationId)

    const reviewAppend = await setup()
    await atTaskReview(reviewAppend)
    reviewAppend.fake.failOneShot = true
    await expect(reviewAppend.service.requestReview(reviewAppend.supervisor, {
      scope: 'task',
      taskId: TASK,
      signal: SIGNAL,
    })).rejects.toThrow(/one-shot start failed/)
    expect(reviewAppend.service.state(reviewAppend.supervisor).delegations.at(-1)).toMatchObject({
      kind: 'codex-review',
      status: 'failed',
      blocksProgress: true,
    })

    const reviewAggregate = await setup()
    await atTaskReview(reviewAggregate)
    const reviewSession = reviewAggregate.supervisor.session
    const reviewOriginal = reviewSession.append.bind(reviewSession)
    reviewSession.append = ((type: string, data: unknown) => {
      if (type === 'orc/review/result') throw new Error('review failure append rejected')
      return (reviewOriginal as (eventType: string, eventData: unknown) => unknown)(type, data)
    }) as Session['append']
    reviewAggregate.fake.failOneShot = true
    await expect(reviewAggregate.service.requestAudit(reviewAggregate.supervisor, {
      scope: 'task',
      taskId: TASK,
      signal: SIGNAL,
    })).rejects.toThrow(/not allowed|task_audit/)
    await expect(reviewAggregate.service.requestReview(reviewAggregate.supervisor, {
      scope: 'task',
      taskId: TASK,
      signal: SIGNAL,
    })).rejects.toBeInstanceOf(AggregateError)
    expect(reviewAggregate.service.state(reviewAggregate.supervisor).delegations.some(item =>
      item.kind === 'codex-review' && item.status === 'open')).toBe(true)
    reviewSession.append = reviewOriginal
    await expect(reviewAggregate.service.requestReview(reviewAggregate.supervisor, {
      scope: 'task',
      taskId: TASK,
      signal: SIGNAL,
    })).rejects.toThrow(/no continuation handle/)
    expect(reviewAggregate.service.state(reviewAggregate.supervisor).delegations.some(item =>
      item.kind === 'codex-review' && item.status === 'failed' && item.blocksProgress)).toBe(true)
    expect(reviewAggregate.fake.oneShot.some(call => call.name === CONFIG.codexReview.subagentProvider)).toBe(false)
  })

  it('closes an open Codex row when phase append or flush fails and does not resume it', async () => {
    const flushed = await setup()
    await createRun(flushed)
    const persistence = flushed.ctx.get('sessionPersistence') as FakePersistence
    persistence.flushFailure = new Error('flush failed')
    await expect(flushed.service.startSpecPlan(flushed.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/flush failed/)
    expect(flushed.service.state(flushed.supervisor).phase).toBe('spec_required')
    expect(flushed.service.state(flushed.supervisor).delegations.at(-1)).toMatchObject({
      status: 'failed',
      blocksProgress: true,
    })
    const again = await flushed.service.startSpecPlan(flushed.supervisor, 'brainstorm-1', SIGNAL)
    expect(again.spawned).toBe(true)
    expect(flushed.fake.oneShot).toHaveLength(2)

    const phased = await setup()
    await createRun(phased)
    const phaseSession = phased.supervisor.session
    const phaseAppend = phaseSession.append.bind(phaseSession)
    let phaseFailed = false
    phaseSession.append = ((type: string, data: unknown) => {
      if (type === 'orc/phase' && !phaseFailed) {
        phaseFailed = true
        throw new Error('phase append failed')
      }
      return (phaseAppend as (eventType: string, eventData: unknown) => unknown)(type, data)
    }) as Session['append']
    await expect(phased.service.startSpecPlan(phased.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/phase append failed/)
    expect(phased.service.state(phased.supervisor).phase).toBe('spec_required')
    expect(phased.service.state(phased.supervisor).delegations.at(-1)).toMatchObject({
      status: 'failed',
      blocksProgress: true,
    })
    const retried = await phased.service.startSpecPlan(phased.supervisor, 'brainstorm-1', SIGNAL)
    expect(retried.spawned).toBe(true)
  })

  it('does not resume an open row that never received a continuation handle', async () => {
    const spec = await setup()
    await createRun(spec)
    const specSession = spec.supervisor.session
    const appendSpec = specSession.append.bind(specSession) as (type: string, data: unknown) => void
    const runId = spec.service.state(spec.supervisor).runId
    appendSpec('orc/spec/requested', {
      version: 1,
      runId,
      correlationId: 'partial-spec',
      contextRef: 'brainstorm-1',
      role: 'spec-only',
      repositoryPath: '/repo/orc',
      skillRequirements: 'superpowers workflow',
      outputSchema: 'spec-schema',
      readOnly: true,
    })
    expect(spec.service.registration(spec.supervisor, OrcCorrelationId('partial-spec'))?.continuation).toBeUndefined()
    await expect(spec.service.startSpecPlan(spec.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/no continuation handle/)
    expect(spec.fake.oneShot).toHaveLength(0)
    expect(spec.service.state(spec.supervisor).delegations[0]).toMatchObject({ status: 'failed', blocksProgress: true })
    expect(spec.service.state(spec.supervisor).phase).toBe('spec_required')
    const started = await spec.service.startSpecPlan(spec.supervisor, 'brainstorm-1', SIGNAL)
    expect(started.spawned).toBe(true)
    expect(spec.service.state(spec.supervisor).delegations.at(-1)?.continuationId).toBe('shot-1')
    await spec.service.recordResult(spec.supervisor, {
      correlationId: started.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'design spec',
    })
    appendSpec('orc/plan/requested', {
      version: 1,
      runId,
      correlationId: 'partial-plan',
      contextRef: 'brainstorm-1',
      role: 'plan-only',
      repositoryPath: '/repo/orc',
      skillRequirements: 'superpowers workflow',
      outputSchema: 'plan-schema',
      readOnly: true,
    })
    await expect(spec.service.startSpecPlan(spec.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/no continuation handle/)
    expect(spec.fake.oneShot).toHaveLength(1)
    expect(spec.service.state(spec.supervisor).delegations.find(item => item.correlationId === OrcCorrelationId('partial-plan'))).toMatchObject({
      status: 'failed',
      blocksProgress: true,
    })

    const lead = await setup()
    await implementing(lead)
    const leadRun = lead.service.state(lead.supervisor).runId
    const appendLead = lead.supervisor.session.append.bind(lead.supervisor.session) as (type: string, data: unknown) => void
    appendLead('orc/node/created', {
      version: 1,
      runId: leadRun,
      nodeId: 'partial-lead',
      parentId: lead.supervisor.id,
      role: 'lead',
      taskId: TASK,
      correlationId: 'partial-lead',
      prompt: 'lead prompt',
      skillEnvelope: 'superpowers lead',
      writeScope: ['src'],
      acceptanceCriteria: 'report evidence',
      reportingFormat: 'settlement event',
    })
    expect(lead.service.registration(lead.supervisor, OrcCorrelationId('partial-lead'))?.continuation).toBeUndefined()
    await expect(lead.service.spawn(lead.supervisor, leadInput())).rejects.toThrow(/no continuation handle/)
    expect(lead.fake.continuable).toHaveLength(0)
    expect(lead.service.state(lead.supervisor).tasks[0]?.phase).toBe('failed')
    expect(lead.service.state(lead.supervisor).delegations.at(-1)).toMatchObject({ status: 'failed', blocksProgress: true })

    const audit = await setup()
    const reviewed = await atTaskReview(audit)
    const auditReview = await audit.service.requestReview(audit.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await recordReport(audit, auditReview.correlationId, 'codex-review', 'review-only', 'ok', TASK)
    await audit.service.advance(reviewed.lead, 'task_audit')
    const auditRun = audit.service.state(audit.supervisor).runId
    const appendAudit = audit.supervisor.session.append.bind(audit.supervisor.session) as (type: string, data: unknown) => void
    appendAudit('orc/audit/requested', {
      version: 1,
      runId: auditRun,
      correlationId: 'partial-audit',
      scope: 'task',
      iteration: 0,
      taskId: TASK,
      role: 'audit-only',
      repositoryPath: '/repo/orc',
      skillRequirements: 'superpowers workflow',
      outputSchema: 'audit-schema',
      readOnly: true,
    })
    const shots = audit.fake.oneShot.length
    await expect(audit.service.requestAudit(audit.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })).rejects.toThrow(/no continuation handle/)
    expect(audit.fake.oneShot).toHaveLength(shots)
    expect(audit.service.state(audit.supervisor).delegations.find(item => item.correlationId === OrcCorrelationId('partial-audit'))).toMatchObject({
      status: 'failed',
      blocksProgress: true,
    })
  })
})

describe('ORC resume and later gates', () => {
  it('reconstructs an open Codex run from the session log without a second child', async () => {
    const harness = await setup()
    await createRun(harness)
    const launch = await harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(harness.fake.oneShot).toHaveLength(1)
    expect(harness.service.state(harness.supervisor).phase).toBe('spec_required')
    await harness.fiber.dispose()
    expect(() => harness.service.state(harness.supervisor)).toThrow(/ORC projection is not registered/)
    await harness.ctx.plugin(OrcService, CONFIG)
    const resumed = harness.ctx.orc
    const again = await resumed.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(again.spawned).toBe(false)
    expect(again.correlationId).toBe(launch.correlationId)
    expect(harness.fake.oneShot).toHaveLength(1)
    expect(resumed.state(harness.supervisor).phase).toBe('spec_required')
    expect(resumed.registration(harness.supervisor, launch.correlationId)).toMatchObject({
      stage: 'codex-spec',
      role: 'spec-only',
      continuation: { kind: 'one-shot', id: 'shot-1' },
    })
    await resumed.recordResult(harness.supervisor, {
      correlationId: launch.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'resumed spec',
    })
    expect(resumed.state(harness.supervisor).specText).toBe('resumed spec')
  })

  it('reuses an open Lead from the log and does not spawn another', async () => {
    const harness = await setup()
    await implementing(harness)
    const launch = await harness.service.spawn(harness.supervisor, leadInput())
    expect(harness.fake.continuable).toHaveLength(1)
    await harness.fiber.dispose()
    await harness.ctx.plugin(OrcService, CONFIG)
    const resumed = harness.ctx.orc
    const again = await resumed.spawn(harness.supervisor, leadInput())
    expect(again.spawned).toBe(false)
    expect(again.nodeId).toBe(launch.nodeId)
    expect(harness.fake.continuable).toHaveLength(1)
    expect(resumed.state(harness.supervisor).phase).toBe('task_implementation')
    expect(resumed.registration(harness.supervisor, launch.correlationId)?.continuation).toEqual({
      kind: 'continuable',
      id: launch.nodeId,
      messageId: 'msg-1',
    })
    expect(resumed.state(harness.supervisor).delegations.find(item => item.correlationId === launch.correlationId)?.messageId).toBe('msg-1')
  })

  it('keeps review and audit separate through fix and final branch gates', async () => {
    const harness = await setup()
    await implementing(harness)
    const leadLaunch = await harness.service.spawn(harness.supervisor, leadInput())
    const lead = agentFor(harness.ctx, leadLaunch)
    await harness.service.startTask(harness.supervisor, { taskId: TASK, leadNodeId: leadLaunch.nodeId! })
    const peerLaunch = await harness.service.spawn(lead, peerInput())
    await harness.service.recordResult(harness.supervisor, {
      correlationId: peerLaunch.correlationId,
      stage: 'deepseek-node',
      role: 'peer',
      taskId: TASK,
      outcome: 'settled',
      evidence: 'peer done',
    })
    await harness.service.advance(lead, 'task_peer_settlement')
    await harness.service.recordResult(harness.supervisor, {
      correlationId: leadLaunch.correlationId,
      stage: 'deepseek-node',
      role: 'lead',
      taskId: TASK,
      outcome: 'settled',
      evidence: 'lead done',
    })
    await harness.service.settleTask(lead, { taskId: TASK, leadNodeId: leadLaunch.nodeId!, evidence: 'task done' })
    await harness.service.advance(lead, 'task_review')

    const peer = agentFor(harness.ctx, peerLaunch)
    const reviewShots = harness.fake.oneShot.length
    await expect(harness.service.requestReview(peer, { scope: 'task', taskId: TASK, signal: SIGNAL })).rejects.toThrow(/only the supervisor/)
    await expect(harness.service.recordResult(peer, {
      correlationId: OrcCorrelationId('not-open'),
      stage: 'codex-review',
      role: 'review-only',
      taskId: TASK,
      status: 'ok',
      findings: [],
    })).rejects.toThrow(/only the supervisor/)
    expect(harness.fake.oneShot).toHaveLength(reviewShots)
    expect(harness.service.state(harness.supervisor).delegations.some(item => item.kind === 'codex-review')).toBe(false)

    const review = await harness.service.requestReview(harness.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    const reviewShot = harness.fake.oneShot.at(-1)
    expect(reviewShot?.name).toBe(CONFIG.codexReview.subagentProvider)
    expect(reviewShot?.request.outputSchema).toBeUndefined()
    expect(reviewShot?.request.maxDepth).toBeUndefined()
    expect(reviewShot?.request.agentOptions).toBeUndefined()
    expect(harness.fake.oneShot.at(-1)?.request.prompt[0]?.text).toContain('review-only')
    await harness.service.recordResult(harness.supervisor, {
      correlationId: review.correlationId,
      stage: 'codex-review',
      role: 'review-only',
      taskId: TASK,
      status: 'ok',
      findings: [{ id: OrcFindingId('finding-medium'), severity: 'medium', summary: 'bounds check' }],
    })
    expect(harness.service.state(harness.supervisor).delegations.at(-1)?.blocksProgress).toBe(true)
    await harness.service.advance(lead, 'task_audit')
    const auditShots = harness.fake.oneShot.length
    await expect(harness.service.requestAudit(peer, { scope: 'task', taskId: TASK, signal: SIGNAL })).rejects.toThrow(/only the supervisor/)
    await expect(harness.service.recordResult(peer, {
      correlationId: review.correlationId,
      stage: 'codex-audit',
      role: 'audit-only',
      taskId: TASK,
      status: 'ok',
      findings: [],
    })).rejects.toThrow(/only the supervisor/)
    expect(harness.fake.oneShot).toHaveLength(auditShots)
    const audit = await harness.service.requestAudit(harness.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    expect(harness.fake.oneShot.at(-1)?.name).toBe(CONFIG.codexAudit.subagentProvider)
    expect(review.correlationId).not.toBe(audit.correlationId)
    await harness.service.recordResult(harness.supervisor, {
      correlationId: audit.correlationId,
      stage: 'codex-audit',
      role: 'audit-only',
      taskId: TASK,
      status: 'ok',
      findings: [],
    })
    await expect(harness.service.advance(harness.supervisor, 'next_task')).rejects.toThrow(/blocking findings require fix/)
    await harness.service.advance(harness.supervisor, 'task_fix')
    await harness.service.recordFix(harness.supervisor, { taskId: TASK, iteration: 1, decision: 'fix bounds' })
    const assigned = await setup()
    const assignedReview = await atTaskReview(assigned)
    const assignedReport = await assigned.service.requestReview(assigned.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await assigned.service.recordResult(assigned.supervisor, {
      correlationId: assignedReport.correlationId,
      stage: 'codex-review',
      role: 'review-only',
      taskId: TASK,
      status: 'ok',
      findings: [{ id: OrcFindingId('finding-assigned'), severity: 'high', summary: 'assigned fix' }],
    })
    await assigned.service.advance(assignedReview.lead, 'task_audit')
    const assignedAudit = await assigned.service.requestAudit(assigned.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await recordReport(assigned, assignedAudit.correlationId, 'codex-audit', 'audit-only', 'ok', TASK)
    await assigned.service.advance(assigned.supervisor, 'task_fix')
    await assigned.service.recordFix(assigned.supervisor, {
      taskId: TASK,
      iteration: 1,
      decision: 'assign the fix',
      assigneeNodeId: assignedReview.leadLaunch.nodeId!,
    })
    expect(harness.service.state(harness.supervisor).tasks[0]).toMatchObject({ iteration: 1, fixDecision: 'fix bounds' })

    await userReview(harness.service, harness.supervisor.session)
    expect(harness.service.state(harness.supervisor).phase).not.toBe('awaiting_user_approval')
    expect(harness.service.state(harness.supervisor).approval).toBe('approved')
    await harness.service.fail(harness.supervisor, 'stop the run')
    expect(harness.service.state(harness.supervisor).phase).toBe('failed')
    expect(harness.service.state(harness.supervisor).terminalReason).toBe('stop the run')
  })

  it('requires a clean task audit before branch review and does not approve from plan mode', async () => {
    const harness = await setup()
    await awaitingApproval(harness)
    expect(harness.supervisor.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)
    await expect(harness.service.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/not allowed|already requested/)
    await userReview(harness.service, harness.supervisor.session, 'rejected')
    await expect(harness.service.assignTask(harness.supervisor, {
      taskId: TASK,
      writeScope: ['src'],
      acceptanceCriteria: 'done task-a',
    })).rejects.toThrow(/user rejection blocks implementation/)
    expect(harness.service.state(harness.supervisor).approval).toBe('rejected')

    const clean = await setup()
    await implementing(clean)
    const leadLaunch = await clean.service.spawn(clean.supervisor, leadInput())
    const lead = agentFor(clean.ctx, leadLaunch)
    await clean.service.startTask(clean.supervisor, { taskId: TASK, leadNodeId: leadLaunch.nodeId! })
    const peerLaunch = await clean.service.spawn(lead, peerInput())
    await settleNode(clean, peerLaunch, 'peer')
    await clean.service.advance(lead, 'task_peer_settlement')
    await settleNode(clean, leadLaunch, 'lead')
    await clean.service.settleTask(lead, { taskId: TASK, leadNodeId: leadLaunch.nodeId!, evidence: 'task done' })
    await clean.service.advance(lead, 'task_review')
    const review = await clean.service.requestReview(clean.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    const reviewAgain = await clean.service.requestReview(clean.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    expect(reviewAgain).toMatchObject({ spawned: false, correlationId: review.correlationId })
    await recordReport(clean, review.correlationId, 'codex-review', 'review-only', 'ok', TASK)
    await clean.service.advance(lead, 'task_audit')
    const audit = await clean.service.requestAudit(clean.supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await recordReport(clean, audit.correlationId, 'codex-audit', 'audit-only', 'ok', TASK)
    await expect(clean.service.advance(lead, 'final_review')).rejects.toThrow(/lead cannot advance/)
    await clean.service.advance(clean.supervisor, 'final_review')
    const branchReview = await clean.service.requestReview(clean.supervisor, { scope: 'branch', signal: SIGNAL })
    const branchAudit = await clean.service.requestAudit(clean.supervisor, { scope: 'branch', signal: SIGNAL })
    expect(branchReview.correlationId).not.toBe(branchAudit.correlationId)
    expect(clean.fake.oneShot.filter(call => call.name === CONFIG.codexReview.subagentProvider)).toHaveLength(2)
    expect(clean.fake.oneShot.filter(call => call.name === CONFIG.codexAudit.subagentProvider)).toHaveLength(2)
    await recordReport(clean, branchReview.correlationId, 'codex-review', 'review-only', 'unavailable')
    await expect(clean.service.fail(clean.supervisor, 'still blocked')).resolves.toMatchObject({ phase: 'failed' })
  })
})

async function atTaskReview(harness: Harness): Promise<{ lead: Agent; leadLaunch: OrcLaunch }> {
  await implementing(harness)
  const leadLaunch = await harness.service.spawn(harness.supervisor, leadInput())
  const lead = agentFor(harness.ctx, leadLaunch)
  await harness.service.startTask(harness.supervisor, { taskId: TASK, leadNodeId: leadLaunch.nodeId! })
  const peerLaunch = await harness.service.spawn(lead, peerInput())
  await settleNode(harness, peerLaunch, 'peer')
  await harness.service.advance(lead, 'task_peer_settlement')
  await settleNode(harness, leadLaunch, 'lead')
  await harness.service.settleTask(lead, { taskId: TASK, leadNodeId: leadLaunch.nodeId!, evidence: 'task done' })
  await harness.service.advance(lead, 'task_review')
  return { lead, leadLaunch }
}

async function settleNode(harness: Harness, launch: OrcLaunch, role: 'lead' | 'peer'): Promise<void> {
  await harness.service.recordResult(harness.supervisor, {
    correlationId: launch.correlationId,
    stage: 'deepseek-node',
    role,
    taskId: TASK,
    outcome: 'settled',
    evidence: `${role} done`,
  })
}

async function recordReport(
  harness: Harness,
  correlationId: ReturnType<typeof OrcCorrelationId>,
  stage: Extract<OrcDelegationKind, 'codex-review' | 'codex-audit'>,
  role: 'review-only' | 'audit-only',
  status: OrcReportStatus,
  taskId?: ReturnType<typeof OrcTaskId>,
): Promise<void> {
  await harness.service.recordResult(harness.supervisor, {
    correlationId,
    stage,
    role,
    ...(taskId === undefined ? {} : { taskId }),
    status,
  })
}
