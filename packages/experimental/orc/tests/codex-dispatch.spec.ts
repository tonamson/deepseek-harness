import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ContinuableStart, ContinuableStartSpec, SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runCodexFinalLoop,
  runCodexSpecPlan,
  runCodexTaskLoop,
  type OrcFixWork,
} from '../src/codex-dispatch.ts'
import { OrcService, type OrcLaunch, type OrcServiceConfig } from '../src/index.ts'
import * as OrcInvariant from '../src/invariant.ts'
import {
  codexJsonContract,
  parseCodexAudit,
  parseCodexPlan,
  parseCodexReview,
  parseCodexSpec,
} from '../src/codex-results.ts'
import { renderCodexEnvelope } from '../src/envelope.ts'
import { OrcTaskId } from '../src/projection.ts'
import type { OrcSeverity } from '../src/types.ts'

const TASK = 'task-a'

function finding(stage: 'codex-review' | 'codex-audit', patch: Record<string, unknown> = {}) {
  return {
    id: 'finding-1',
    severity: 'low',
    file: 'src/a.ts',
    location: 'src/a.ts:12',
    evidence: 'index is not checked',
    remediation: 'compare the index to the length',
    status: 'open',
    summary: 'missing bounds check',
    sourceStage: stage,
    taskId: TASK,
    ...patch,
  }
}

function fenced(value: unknown, language = 'json'): string {
  return `\`\`\`${language}\n${JSON.stringify(value)}\n\`\`\``
}

describe('Codex result parser', () => {
  it('accepts a clean spec and plan from JSON text or one JSON code block', () => {
    const spec = JSON.stringify({ stage: 'codex-spec', spec: 'design is complete' })
    expect(parseCodexSpec(spec)).toEqual({
      status: 'ok',
      stage: 'codex-spec',
      rawText: spec,
      text: 'design is complete',
    })
    const plan = { stage: 'codex-plan', plan: 'step 1' }
    expect(parseCodexPlan(fenced(plan))).toEqual({
      status: 'ok',
      stage: 'codex-plan',
      rawText: fenced(plan),
      text: 'step 1',
    })
    expect(parseCodexPlan(fenced(plan, ''))).toEqual({
      status: 'ok',
      stage: 'codex-plan',
      rawText: fenced(plan, ''),
      text: 'step 1',
    })
  })

  it('accepts a clean review and a clean audit as separate documents', () => {
    const review = { stage: 'codex-review', findings: [] }
    const audit = JSON.stringify({ stage: 'codex-audit', findings: [] })
    expect(parseCodexReview(fenced(review))).toEqual({
      status: 'ok',
      stage: 'codex-review',
      rawText: fenced(review),
      findings: [],
    })
    expect(parseCodexAudit(audit)).toEqual({
      status: 'ok',
      stage: 'codex-audit',
      rawText: audit,
      findings: [],
    })
    expect(parseCodexReview(audit).status).toBe('malformed')
    expect(parseCodexAudit(JSON.stringify(review)).status).toBe('malformed')
    expect(parseCodexSpec(JSON.stringify({ stage: 'codex-plan', plan: 'step 1' })).status).toBe('malformed')
  })

  it('keeps blocking findings and does not treat them as a clean empty report', () => {
    for (const severity of ['critical', 'high', 'medium'] as const) {
      const body = {
        stage: 'codex-review' as const,
        findings: [finding('codex-review', { id: `finding-${severity}`, severity })],
      }
      const text = JSON.stringify(body)
      expect(parseCodexReview(text)).toEqual({
        status: 'ok',
        stage: 'codex-review',
        rawText: text,
        findings: body.findings,
      })
    }
  })

  it('keeps low and info findings without rejecting the document', () => {
    const findings = [
      finding('codex-audit', { id: 'finding-low', severity: 'low' }),
      finding('codex-audit', { id: 'finding-info', severity: 'info', summary: 'naming note', file: 'src/b.ts', location: 'src/b.ts:1' }),
    ]
    const text = JSON.stringify({ stage: 'codex-audit', findings })
    expect(parseCodexAudit(text)).toEqual({
      status: 'ok',
      stage: 'codex-audit',
      rawText: text,
      findings,
    })
  })

  it('rejects duplicate findings', () => {
    const sameId = JSON.stringify({
      stage: 'codex-review',
      findings: [finding('codex-review'), finding('codex-review', { summary: 'other', file: 'src/c.ts', location: 'src/c.ts:2' })],
    })
    expect(parseCodexReview(sameId)).toMatchObject({ status: 'malformed', rawText: sameId, reason: 'duplicate finding' })
    const samePlace = JSON.stringify({
      stage: 'codex-audit',
      findings: [finding('codex-audit', { id: 'finding-a' }), finding('codex-audit', { id: 'finding-b' })],
    })
    expect(parseCodexAudit(samePlace)).toMatchObject({ status: 'malformed', reason: 'duplicate finding' })
  })

  it('rejects malformed JSON, prose around a code block, and missing or extra fields', () => {
    expect(parseCodexSpec('{')).toMatchObject({ status: 'malformed', rawText: '{', reason: 'codex result is not JSON' })
    const inner = JSON.stringify({ stage: 'codex-plan', plan: 'step 1' })
    const prose = `The plan follows.\n\`\`\`json\n${inner}\n\`\`\``
    expect(parseCodexPlan(prose)).toMatchObject({ status: 'malformed', rawText: prose, reason: 'codex result is not a JSON document' })
    expect(parseCodexSpec(JSON.stringify({ stage: 'codex-spec' })).status).toBe('malformed')
    expect(parseCodexSpec(JSON.stringify({ stage: 'codex-spec', spec: 'design', notes: 'extra' })).status).toBe('malformed')
    expect(parseCodexSpec(JSON.stringify({ stage: 'codex-spec', spec: '' })).status).toBe('malformed')
    const incomplete = JSON.stringify({
      stage: 'codex-review',
      findings: [{ id: 'finding-1', severity: 'high', summary: 'bounds' }],
    })
    expect(parseCodexReview(incomplete)).toMatchObject({ status: 'malformed', rawText: incomplete })
    const extra = JSON.stringify({ stage: 'codex-review', findings: [], auditFindings: [] })
    expect(parseCodexReview(extra).status).toBe('malformed')
    const resolved = JSON.stringify({
      stage: 'codex-audit',
      findings: [finding('codex-audit', { status: 'resolved' })],
    })
    expect(parseCodexAudit(resolved).status).toBe('malformed')
  })

  it('treats missing text as unavailable and not as a clean report', () => {
    expect(parseCodexReview(undefined)).toEqual({ status: 'unavailable', reason: 'codex result text is missing' })
    expect(parseCodexAudit(' \n ')).toEqual({ status: 'unavailable', reason: 'codex result text is missing' })
    expect(parseCodexSpec(undefined).status).not.toBe('ok')
  })
})

const SIGNAL = new AbortController().signal
const TASK_A = OrcTaskId('task-a')
const TASK_B = OrcTaskId('task-b')
const BLOCKING = ['critical', 'high', 'medium'] as const satisfies readonly OrcSeverity[]

const CONFIG: OrcServiceConfig = {
  deepseek: {
    subagentProvider: 'deepseek-continuable',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    effort: 'high',
  },
  codexSpec: {
    subagentProvider: 'codex-spec',
    provider: 'codex-spec',
    model: 'gpt-5.6-terra',
    effort: 'high',
  },
  codexPlan: {
    subagentProvider: 'codex-plan',
    provider: 'codex-plan',
    model: 'gpt-5.6-terra',
    effort: 'high',
  },
  codexReview: {
    subagentProvider: 'codex-review',
    provider: 'codex-review',
    model: 'gpt-5.6-luna',
    effort: 'high',
  },
  codexAudit: {
    subagentProvider: 'codex-audit',
    provider: 'codex-audit',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
  },
  repositoryPath: '/repo/orc',
  skillRequirements: 'superpowers workflow',
  specOutputSchema: 'spec-envelope',
  planOutputSchema: 'plan-envelope',
  reviewOutputSchema: 'review-envelope',
  auditOutputSchema: 'audit-envelope',
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
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async flush(): Promise<void> {}
}

class FakeSubagents extends Service {
  readonly continuable: ContinuableStartSpec[] = []
  readonly oneShot: { name: string; request: SubagentStartRequest }[] = []
  readonly queue: Promise<SubagentResult>[] = []
  failOneShot = false

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  async start(name: string, request: SubagentStartRequest): Promise<{
    id: ReturnType<typeof SessionId>
    localAgent: undefined
    result: Promise<SubagentResult>
    dispose: () => Promise<void>
  }> {
    if (this.failOneShot) throw new Error('one-shot start failed')
    this.oneShot.push({ name, request })
    const result = this.queue.shift() ?? Promise.reject(new Error('unscripted codex result'))
    void result.catch(() => undefined)
    return {
      id: SessionId(`shot-${this.oneShot.length}`),
      localAgent: undefined,
      result,
      dispose: () => Promise.resolve(),
    }
  }

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    this.continuable.push(spec)
    return { childId: spec.childId ?? SessionId('missing-child'), messageId: 'msg-1' as ContinuableStart['messageId'] }
  }
}

interface Harness {
  ctx: Context
  service: OrcService
  supervisor: Agent
  fake: FakeSubagents
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

async function setup(): Promise<Harness> {
  const ctx = new Context()
  open.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeAgents)
  await ctx.plugin(FakePersistence)
  await ctx.plugin(FakeSubagents)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(OrcInvariant)
  await ctx.plugin(OrcService, CONFIG)
  return { ctx, service: ctx.orc, supervisor: asAgent(ctx, 'supervisor'), fake: ctx.get('subagents') as unknown as FakeSubagents }
}

function textResult(text: string, stopReason: SubagentResult['stopReason'] = 'completed'): SubagentResult {
  return { output: [{ type: 'text', text }], stopReason }
}

function reportResult(stage: 'codex-review' | 'codex-audit', findings: ReturnType<typeof finding>[]): SubagentResult {
  return textResult(JSON.stringify({ stage, findings }))
}

function promptOf(call: { request: SubagentStartRequest } | undefined): string {
  const block = call?.request.prompt[0]
  if (block === undefined || block.type !== 'text') throw new Error('codex prompt is missing')
  return block.text
}

function eventTypes(harness: Harness): string[] {
  return harness.supervisor.session.snapshotEvents().map(event => event.type)
}

function branchMarks(harness: Harness): string[] {
  return harness.supervisor.session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'orc/review/requested' && event.type !== 'orc/audit/requested' && event.type !== 'orc/fix/iteration') return []
    const data = event.data as { scope?: string; iteration?: number; taskId?: string }
    if (event.type === 'orc/fix/iteration') return [`fix:${data.taskId ?? ''}`]
    if (data.scope !== 'branch') return []
    const kind = event.type === 'orc/review/requested' ? 'review' : 'audit'
    return [`${kind}:${String(data.iteration)}`]
  })
}

function leadInput(taskId: ReturnType<typeof OrcTaskId>) {
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

async function createRun(harness: Harness, blocking: readonly OrcSeverity[] = BLOCKING): Promise<void> {
  await harness.service.createWorkflow(harness.supervisor, {
    prompt: 'Supervisor prompt',
    skillEnvelope: 'superpowers',
    writeScope: ['repo'],
    acceptanceCriteria: 'run reaches complete',
    reportingFormat: 'durable events',
    blockingSeverities: [...blocking],
  })
}

async function approveWorkflow(harness: Harness, blocking?: readonly OrcSeverity[]): Promise<void> {
  await createRun(harness, blocking)
  const spec = JSON.stringify({ stage: 'codex-spec', spec: 'design is complete' })
  harness.fake.queue.push(Promise.resolve(textResult(spec)))
  await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
  const plan = JSON.stringify({ stage: 'codex-plan', plan: 'ship the task' })
  harness.fake.queue.push(Promise.resolve(textResult(plan)))
  await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
  await harness.service.advance(harness.supervisor, 'awaiting_user_approval')
  const append = harness.supervisor.session.append.bind(harness.supervisor.session) as (type: string, data: unknown) => void
  append('plan/review', { version: 1, correlation: 'plan-review-1', decision: 'approved' })
  await harness.service.planReviewSettled()
}

async function settleNode(harness: Harness, launch: OrcLaunch, role: 'lead' | 'peer', taskId: ReturnType<typeof OrcTaskId>): Promise<void> {
  await harness.service.recordResult(harness.supervisor, {
    correlationId: launch.correlationId,
    stage: 'deepseek-node',
    role,
    taskId,
    outcome: 'settled',
    evidence: `${role} done`,
  })
}

async function settleTask(harness: Harness, taskId: ReturnType<typeof OrcTaskId>): Promise<OrcLaunch> {
  const leadLaunch = await harness.service.spawn(harness.supervisor, leadInput(taskId))
  if (leadLaunch.nodeId === undefined) throw new Error('lead id is missing')
  const lead = asAgent(harness.ctx, String(leadLaunch.nodeId))
  await harness.service.startTask(harness.supervisor, { taskId, leadNodeId: leadLaunch.nodeId })
  const peerLaunch = await harness.service.spawn(lead, { ...leadInput(taskId), role: 'peer', prompt: 'peer prompt' })
  await settleNode(harness, peerLaunch, 'peer', taskId)
  await harness.service.advance(harness.supervisor, 'task_peer_settlement')
  await settleNode(harness, leadLaunch, 'lead', taskId)
  await harness.service.settleTask(harness.supervisor, { taskId, leadNodeId: leadLaunch.nodeId, evidence: 'task done' })
  return leadLaunch
}

function countKind(harness: Harness, kind: 'codex-review' | 'codex-audit'): number {
  return harness.service.state(harness.supervisor).delegations.filter(item => item.kind === kind).length
}

describe('Codex dispatch', () => {
  it('routes spec and plan through the configured Codex Terra routes', async () => {
    const harness = await setup()
    await createRun(harness)
    const specRaw = JSON.stringify({ stage: 'codex-spec', spec: 'design is complete' })
    harness.fake.queue.push(Promise.resolve(textResult(specRaw)))
    const specState = await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(specState.specText).toBe('design is complete')
    expect(specState.delegations[0]).toMatchObject({
      kind: 'codex-spec',
      status: 'ok',
      provider: 'codex-spec',
      model: 'gpt-5.6-terra',
      effort: 'high',
      rawText: specRaw,
      blocksProgress: false,
    })
    const specCall = harness.fake.oneShot[0]
    expect(specCall?.name).toBe(CONFIG.codexSpec.subagentProvider)
    expect(specCall?.request.outputSchema).toBeUndefined()
    expect(specCall?.request.maxDepth).toBeUndefined()
    const specPrompt = promptOf(specCall)
    expect(specPrompt).toContain('stage: codex-spec')
    expect(specPrompt).toContain('model: gpt-5.6-terra')
    expect(specPrompt).toContain('effort: high')
    expect(specPrompt).toContain('expectedStructuredResult: spec-envelope')
    expect(specPrompt).toContain(codexJsonContract('codex-spec'))
    expect(specPrompt).not.toContain('plan-envelope')
    expect(specCall?.request.outputSchema).toBeUndefined()

    const planRaw = JSON.stringify({ stage: 'codex-plan', plan: 'ship the task' })
    harness.fake.queue.push(Promise.resolve(textResult(planRaw)))
    const planState = await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(planState.planText).toBe('ship the task')
    expect(planState.delegations[0]?.correlationId).not.toBe(planState.delegations[1]?.correlationId)
    expect(planState.delegations[1]).toMatchObject({
      kind: 'codex-plan',
      status: 'ok',
      provider: 'codex-plan',
      model: 'gpt-5.6-terra',
      effort: 'high',
      rawText: planRaw,
    })
    const planCall = harness.fake.oneShot[1]
    expect(planCall?.name).toBe(CONFIG.codexPlan.subagentProvider)
    expect(planCall?.request.outputSchema).toBeUndefined()
    const planPrompt = promptOf(planCall)
    expect(planPrompt).toContain('stage: codex-plan')
    expect(planPrompt).toContain('model: gpt-5.6-terra')
    expect(planPrompt).toContain('effort: high')
    expect(planPrompt).toContain('expectedStructuredResult: plan-envelope')
    expect(planPrompt).not.toContain('spec-envelope')
  })

  it('reads only text blocks and records them on the delegation', async () => {
    const harness = await setup()
    await createRun(harness)
    const visible = JSON.stringify({ stage: 'codex-spec', spec: 'visible' })
    harness.fake.queue.push(Promise.resolve({
      output: [
        { type: 'reasoning', text: JSON.stringify({ stage: 'codex-spec', spec: 'hidden' }) },
        { type: 'text', text: visible },
      ],
      stopReason: 'completed',
    }))
    const state = await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(state.specText).toBe('visible')
    expect(state.delegations[0]?.rawText).toBe(visible)
  })

  it('records unparseable, missing, and non-completed Codex text as blocking', async () => {
    const harness = await setup()
    await createRun(harness)
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    const malformed = await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(malformed.specText).toBeUndefined()
    expect(malformed.delegations[0]).toMatchObject({ status: 'malformed', blocksProgress: true, rawText: 'not json' })
    await expect(harness.service.advance(harness.supervisor, 'plan_required')).rejects.toThrow(/codex spec failure blocks plan/)

    const rejected = Promise.reject(new Error('socket closed'))
    void rejected.catch(() => undefined)
    harness.fake.queue.push(rejected)
    const unavailable = await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(unavailable.specText).toBeUndefined()
    expect(unavailable.delegations.at(-1)).toMatchObject({ status: 'unavailable', blocksProgress: true, rawText: 'socket closed' })

    const raw = JSON.stringify({ stage: 'codex-spec', spec: 'do not accept' })
    harness.fake.queue.push(Promise.resolve(textResult(raw, 'error')))
    const failed = await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(failed.specText).toBeUndefined()
    expect(failed.delegations.at(-1)).toMatchObject({ status: 'failed', blocksProgress: true, rawText: raw })

    harness.fake.queue.push(Promise.resolve({ output: [], stopReason: 'completed' }))
    const missing = await runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)
    expect(missing.delegations.at(-1)).toMatchObject({ status: 'unavailable', blocksProgress: true })
    expect(missing.delegations.at(-1)?.rawText).toBeUndefined()
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('leaves a Codex startup failure blocking', async () => {
    const harness = await setup()
    await createRun(harness)
    harness.fake.failOneShot = true
    await expect(runCodexSpecPlan(harness.service, harness.supervisor, 'brainstorm-1', SIGNAL)).rejects.toThrow(/one-shot start failed/)
    expect(harness.service.state(harness.supervisor).delegations[0]).toMatchObject({
      kind: 'codex-spec',
      status: 'failed',
      blocksProgress: true,
    })
    expect(harness.service.state(harness.supervisor).specText).toBeUndefined()
  })

  it('does not start review before the DeepSeek task is settled', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    const shots = harness.fake.oneShot.length
    const fix: OrcFixWork = async () => ({ decision: 'unused' })
    await expect(runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)).rejects.toThrow(/settled task/)
    expect(harness.fake.oneShot).toHaveLength(shots)
    expect(harness.fake.continuable).toHaveLength(0)
    expect(harness.service.state(harness.supervisor).phase).toBe('task_implementation')
  })

  it('runs distinct review and audit routes and does not fix low or info findings', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fixes: string[] = []
    const fix: OrcFixWork = async () => {
      fixes.push('called')
      return { decision: 'unused' }
    }
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [
      finding('codex-review', { id: 'finding-low', severity: 'low' }),
    ])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [
      finding('codex-audit', { id: 'finding-info', severity: 'info', summary: 'naming note', file: 'src/b.ts', location: 'src/b.ts:1' }),
    ])))
    const state = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(fixes).toEqual([])
    expect(state.phase).toBe('final_review')
    expect(state.tasks[0]).toMatchObject({ phase: 'clean', iteration: 0 })
    expect(state.findings.map(item => item.severity)).toEqual(['low', 'info'])
    expect(state.findings[0]).toMatchObject({
      file: 'src/a.ts',
      location: 'src/a.ts:12',
      evidence: 'index is not checked',
      remediation: 'compare the index to the length',
      status: 'open',
      sourceStage: 'codex-review',
    })
    const review = state.delegations.find(item => item.kind === 'codex-review')
    const audit = state.delegations.find(item => item.kind === 'codex-audit')
    expect(review?.correlationId).not.toBe(audit?.correlationId)
    expect(review).toMatchObject({
      status: 'ok',
      blocksProgress: false,
      provider: 'codex-review',
      model: 'gpt-5.6-luna',
      effort: 'high',
      outputSchema: 'review-envelope',
    })
    expect(audit).toMatchObject({
      status: 'ok',
      blocksProgress: false,
      provider: 'codex-audit',
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
      outputSchema: 'audit-envelope',
    })
    const reportCalls = harness.fake.oneShot.slice(-2)
    expect(reportCalls.map(call => call.name)).toEqual(['codex-review', 'codex-audit'])
    expect(reportCalls[0]?.request.outputSchema).toBeUndefined()
    expect(reportCalls[1]?.request.outputSchema).toBeUndefined()
    expect(promptOf(reportCalls[0])).toContain('stage: codex-review')
    expect(promptOf(reportCalls[0])).toContain('model: gpt-5.6-luna')
    expect(promptOf(reportCalls[0])).toContain('effort: high')
    expect(promptOf(reportCalls[0])).toContain('expectedStructuredResult: review-envelope')
    expect(promptOf(reportCalls[0])).not.toContain('audit-envelope')
    expect(promptOf(reportCalls[1])).toContain('stage: codex-audit')
    expect(promptOf(reportCalls[1])).toContain('effort: xhigh')
    expect(promptOf(reportCalls[1])).toContain('expectedStructuredResult: audit-envelope')
    expect(promptOf(reportCalls[1])).not.toContain('review-envelope')
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
    expect(eventTypes(harness)).not.toContain('orc/fix/iteration')
  })

  it('fixes one blocking cycle and then accepts a clean audit', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const seen: { id: string; sourceStage?: string; file?: string }[] = []
    const fix: OrcFixWork = async (input) => {
      seen.push(...input.findings.map(item => ({
        id: item.id,
        ...(item.sourceStage === undefined ? {} : { sourceStage: item.sourceStage }),
        ...(item.file === undefined ? {} : { file: item.file }),
      })))
      return { decision: 'fix bounds' }
    }
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [
      finding('codex-review', { id: 'finding-high', severity: 'high' }),
    ])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [
      finding('codex-audit', { id: 'finding-medium', severity: 'medium', summary: 'token check', file: 'src/token.ts', location: 'src/token.ts:4' }),
    ])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(seen).toEqual([
      { id: 'finding-high', sourceStage: 'codex-review', file: 'src/a.ts' },
      { id: 'finding-medium', sourceStage: 'codex-audit', file: 'src/token.ts' },
    ])
    expect(state.phase).toBe('final_review')
    expect(state.tasks[0]).toMatchObject({ phase: 'clean', iteration: 1, fixDecision: 'fix bounds' })
    expect(countKind(harness, 'codex-review')).toBe(2)
    expect(countKind(harness, 'codex-audit')).toBe(2)
    expect(eventTypes(harness).filter(type => type === 'orc/fix/iteration')).toHaveLength(1)
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('repeats review and audit across multiple fix cycles', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const iterations: number[] = []
    const fix: OrcFixWork = async (input) => {
      iterations.push(input.iteration)
      return { decision: `fix ${input.iteration}` }
    }
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [finding('codex-review', { id: 'finding-1', severity: 'critical' })])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [finding('codex-review', { id: 'finding-2', severity: 'high' })])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(iterations).toEqual([1, 2])
    expect(state.phase).toBe('final_review')
    expect(state.tasks[0]?.iteration).toBe(2)
    expect(countKind(harness, 'codex-review')).toBe(3)
    expect(countKind(harness, 'codex-audit')).toBe(3)
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('stops after a failed fix without another review or completion', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ failed: 'tests stayed red' })
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [finding('codex-review', { id: 'finding-high', severity: 'high' })])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(state.phase).toBe('failed')
    expect(state.terminalReason).toBe('tests stayed red')
    expect(countKind(harness, 'codex-review')).toBe(1)
    expect(countKind(harness, 'codex-audit')).toBe(1)
    expect(eventTypes(harness)).not.toContain('orc/fix/iteration')
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
    expect(harness.fake.continuable).toHaveLength(2)
  })

  it('treats a low finding as blocking only when the run lists it', async () => {
    const harness = await setup()
    await approveWorkflow(harness, [...BLOCKING, 'low'])
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fixes: number[] = []
    const fix: OrcFixWork = async (input) => {
      fixes.push(input.iteration)
      return { decision: 'fix the nit' }
    }
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [finding('codex-review', { id: 'finding-low', severity: 'low' })])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(fixes).toEqual([1])
    expect(state.phase).toBe('final_review')
    expect(state.delegations.find(item => item.kind === 'codex-review' && item.iteration === 0)?.blocksProgress).toBe(true)
  })

  it('does not start the next task or final review while a task gate is malformed', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_B, writeScope: ['docs'], acceptanceCriteria: 'done too' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ decision: 'unused' })
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    const state = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(state.phase).toBe('task_review')
    expect(countKind(harness, 'codex-review')).toBe(1)
    expect(countKind(harness, 'codex-audit')).toBe(0)
    expect(state.tasks.find(task => task.id === TASK_B)?.phase).toBe('assigned')
    expect(harness.fake.continuable).toHaveLength(2)
    expect(harness.fake.oneShot.some(call => promptOf(call).includes('scope: branch'))).toBe(false)
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('does not start final review or audit until every task is clean', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_B, writeScope: ['docs'], acceptanceCriteria: 'done too' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ decision: 'unused' })
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const gated = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(gated.phase).toBe('next_task')
    expect(gated.tasks.find(task => task.id === TASK_A)?.phase).toBe('clean')
    expect(gated.tasks.find(task => task.id === TASK_B)?.phase).toBe('assigned')
    expect(harness.fake.continuable).toHaveLength(2)
    const shots = harness.fake.oneShot.length
    await expect(runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)).rejects.toThrow(/every task to be clean/)
    expect(harness.fake.oneShot).toHaveLength(shots)
    expect(harness.fake.oneShot.some(call => promptOf(call).includes('scope: branch'))).toBe(false)
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('returns a blocking final finding to DeepSeek fix before any completion', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const seen: { scope?: string; sourceStage?: string; iteration: number }[] = []
    const fix: OrcFixWork = async (input) => {
      seen.push(...input.findings.map(item => ({
        ...(item.scope === undefined ? {} : { scope: item.scope }),
        ...(item.sourceStage === undefined ? {} : { sourceStage: item.sourceStage }),
        iteration: input.iteration,
      })))
      return { decision: 'fix the branch finding' }
    }
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [finding('codex-review', { id: 'finding-branch', severity: 'high' })])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const prepared = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(prepared.phase).toBe('final_review')
    const state = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(seen).toEqual([{ scope: 'branch', sourceStage: 'codex-review', iteration: 1 }])
    expect(state.phase).toBe('final_review')
    expect(state.branchVisit).toBe(1)
    expect(state.tasks[0]).toMatchObject({ phase: 'clean', iteration: 1 })
    const latest = state.delegations.filter(item => item.scope === 'branch' && item.iteration === state.branchVisit)
    expect(latest.map(item => item.kind).sort()).toEqual(['codex-audit', 'codex-review'])
    expect(latest.every(item => item.status === 'ok' && item.blocksProgress === false)).toBe(true)
    expect(eventTypes(harness).filter(type => type === 'orc/fix/iteration')).toEqual(['orc/fix/iteration'])
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
    const reopened = harness.supervisor.session.snapshotEvents().some((event) => {
      if (event.type !== 'orc/phase') return false
      const data = event.data as { to?: string; taskId?: string }
      return data.to === 'task_fix' && data.taskId === TASK_A
    })
    expect(reopened).toBe(true)
    expect(harness.fake.continuable).toHaveLength(2)
  })

  it('does not finish when the final review text is unparseable', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ decision: 'unused' })
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    const state = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(state.phase).toBe('final_review')
    expect(state.delegations.at(-1)).toMatchObject({ kind: 'codex-review', scope: 'branch', status: 'malformed', blocksProgress: true })
    expect(state.delegations.some(item => item.kind === 'codex-audit' && item.scope === 'branch')).toBe(false)
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
    expect(eventTypes(harness)).not.toContain('orc/fix/iteration')
  })

  it('repairs every blocking task on one branch pair before the next visit', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_B, writeScope: ['docs'], acceptanceCriteria: 'done too' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async input => ({ decision: `fix ${input.taskId}` })
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    expect((await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)).phase).toBe('next_task')
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_B)
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    expect((await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)).phase).toBe('final_review')
    const tasks: string[] = []
    const both: OrcFixWork = async (input) => {
      tasks.push(String(input.taskId))
      return { decision: `fix ${input.taskId}` }
    }
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [
      finding('codex-review', { id: 'finding-a', severity: 'critical', taskId: 'task-a' }),
    ])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [
      finding('codex-audit', { id: 'finding-b', severity: 'high', taskId: 'task-b', summary: 'audit block', file: 'src/b.ts', location: 'src/b.ts:3' }),
    ])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, both)
    expect(tasks).toEqual(['task-a', 'task-b'])
    expect(branchMarks(harness)).toEqual(['review:0', 'audit:0', 'fix:task-a', 'fix:task-b', 'review:2', 'audit:2'])
    expect(state.phase).toBe('final_review')
    expect(state.branchVisit).toBe(2)
    expect(state.tasks.map(task => task.iteration)).toEqual([1, 1])
    const latest = state.delegations.filter(item => item.scope === 'branch' && item.iteration === 2)
    expect(latest.every(item => item.status === 'ok' && item.blocksProgress === false)).toBe(true)
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('repairs the second blocking task after the first post-fix gate is non-ok', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_B, writeScope: ['docs'], acceptanceCriteria: 'done too' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const tasks: string[] = []
    const fix: OrcFixWork = async (input) => {
      tasks.push(String(input.taskId))
      return { decision: `fix ${input.taskId}` }
    }
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    expect((await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)).phase).toBe('next_task')
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_B)
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    expect((await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)).phase).toBe('final_review')
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [
      finding('codex-review', { id: 'finding-a', severity: 'critical', taskId: 'task-a' }),
    ])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [
      finding('codex-audit', { id: 'finding-b', severity: 'high', taskId: 'task-b', summary: 'audit block', file: 'src/b.ts', location: 'src/b.ts:3' }),
    ])))
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    const blocked = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(blocked.phase).toBe('task_review')
    expect(tasks).toEqual(['task-a'])
    expect(branchMarks(harness)).toEqual(['review:0', 'audit:0', 'fix:task-a'])
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const resumed = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(resumed.phase).toBe('final_review')
    expect(resumed.branchVisit).toBe(1)
    expect(tasks).toEqual(['task-a'])
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(tasks).toEqual(['task-a', 'task-b'])
    expect(branchMarks(harness)).toEqual(['review:0', 'audit:0', 'fix:task-a', 'fix:task-b', 'review:2', 'audit:2'])
    expect(state.phase).toBe('final_review')
    expect(state.branchVisit).toBe(2)
    expect(state.delegations.filter(item => item.scope === 'branch' && item.iteration === 2).every(item => item.status === 'ok' && item.blocksProgress === false)).toBe(true)
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('uses the latest branch row when a malformed review is retried', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ decision: 'unused' })
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    const blocked = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(blocked.delegations.filter(item => item.scope === 'branch' && item.kind === 'codex-review').at(-1)?.status).toBe('malformed')
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    const reviews = state.delegations.filter(item => item.scope === 'branch' && item.kind === 'codex-review')
    const audits = state.delegations.filter(item => item.scope === 'branch' && item.kind === 'codex-audit')
    expect(reviews.map(item => item.status)).toEqual(['malformed', 'ok'])
    expect(audits.map(item => item.status)).toEqual(['ok'])
    expect(state.phase).toBe('final_review')
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('resumes a branch visit at audit when review is already ok', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ decision: 'fix the branch finding' })
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [
      finding('codex-review', { id: 'finding-branch', severity: 'high' }),
    ])))
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    const blocked = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(blocked.phase).toBe('final_review')
    expect(eventTypes(harness)).not.toContain('orc/fix/iteration')
    expect(blocked.delegations.filter(item => item.scope === 'branch' && item.kind === 'codex-audit').at(-1)?.status).toBe('malformed')
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexFinalLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(branchMarks(harness)).toEqual(['review:0', 'audit:0', 'audit:0', 'fix:task-a', 'review:1', 'audit:1'])
    expect(state.phase).toBe('final_review')
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('retries a non-ok task gate without requesting the ok side again', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ decision: 'unused' })
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    const reviewBlocked = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(reviewBlocked.phase).toBe('task_review')
    expect(countKind(harness, 'codex-audit')).toBe(0)
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [])))
    harness.fake.queue.push(Promise.resolve(textResult('not json')))
    const auditBlocked = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(auditBlocked.phase).toBe('task_audit')
    expect(countKind(harness, 'codex-review')).toBe(2)
    expect(auditBlocked.delegations.filter(item => item.kind === 'codex-audit').at(-1)?.status).toBe('malformed')
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    const state = await runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)
    expect(state.phase).toBe('final_review')
    expect(countKind(harness, 'codex-review')).toBe(2)
    expect(state.delegations.filter(item => item.kind === 'codex-audit').map(item => item.status)).toEqual(['malformed', 'ok'])
    expect(eventTypes(harness)).not.toContain('orc/run/completed')
  })

  it('leaves a reused finding id open instead of recording a malformed gate', async () => {
    const harness = await setup()
    await approveWorkflow(harness)
    await harness.service.assignTask(harness.supervisor, { taskId: TASK_A, writeScope: ['src'], acceptanceCriteria: 'done' })
    await harness.service.advance(harness.supervisor, 'task_implementation')
    await settleTask(harness, TASK_A)
    const fix: OrcFixWork = async () => ({ decision: 'fix bounds' })
    const reused = finding('codex-review', { id: 'finding-reused', severity: 'high' })
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [reused])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-audit', [])))
    harness.fake.queue.push(Promise.resolve(reportResult('codex-review', [reused])))
    await expect(runCodexTaskLoop(harness.service, harness.supervisor, SIGNAL, fix)).rejects.toThrow(/duplicate finding id/)
    const reviews = harness.service.state(harness.supervisor).delegations.filter(item => item.kind === 'codex-review')
    expect(reviews.map(item => item.status)).toEqual(['ok', 'open'])
    expect(reviews[1]?.rawText).toBeUndefined()
    expect(harness.service.state(harness.supervisor).phase).toBe('task_review')
  })

  it('puts each stage JSON contract in the envelope without a provider outputSchema', () => {
    const shared = {
      repositoryScope: '/repo/orc',
      skillWorkflow: 'superpowers workflow',
      blockingSeverities: ['critical', 'high', 'medium'],
      provider: 'copied-provider',
      model: 'copied-model',
      effort: 'copied-effort',
    }
    const review = renderCodexEnvelope({
      ...shared,
      role: 'review-only',
      stage: 'codex-review',
      expectedStructuredResult: 'review-envelope',
    })
    const audit = renderCodexEnvelope({
      ...shared,
      role: 'audit-only',
      stage: 'codex-audit',
      expectedStructuredResult: 'audit-envelope',
    })
    expect(review).toContain('expectedStructuredResult: review-envelope')
    expect(review).toContain(codexJsonContract('codex-review'))
    expect(audit).toContain(codexJsonContract('codex-audit'))
    expect(review).toContain('"file":"<non-empty>"')
    expect(review).toContain('"sourceStage":"codex-review"')
    expect(review).not.toContain('"sourceStage":"codex-audit"')
    expect(audit).toContain('"sourceStage":"codex-audit"')
    expect(audit).not.toContain('"sourceStage":"codex-review"')
    expect(codexJsonContract('codex-spec')).toContain('"spec":"<non-empty string>"')
    expect(codexJsonContract('codex-spec')).not.toContain('findings')
    expect(codexJsonContract('codex-review')).not.toBe(codexJsonContract('codex-audit'))
  })
})
