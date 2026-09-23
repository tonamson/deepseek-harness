/** Cold reopen of a Loader-mounted ORC service through JSONL. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-plan-mode'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ContinuableStart, ContinuableStartSpec, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  OrcFindingId,
  OrcService,
  OrcTaskId,
  projectOrc,
  type OrcEvent,
  type OrcEventMap,
  type OrcServiceConfig,
} from '../src/index.ts'
import * as OrcInvariant from '../src/invariant.ts'

const SIGNAL = new AbortController().signal
const TASK = OrcTaskId('task-a')
const ROOTS: string[] = []
const OPEN: Context[] = []

const CONFIG: OrcServiceConfig = {
  deepseek: { subagentProvider: 'deepseek-continuable', provider: 'deepseek-route', model: 'deepseek-route-model', effort: 'high' },
  codexSpec: { subagentProvider: 'codex-spec-provider', provider: 'codex-spec-route', model: 'spec-route-model', effort: 'high' },
  codexPlan: { subagentProvider: 'codex-plan-provider', provider: 'codex-plan-route', model: 'plan-route-model', effort: 'high' },
  codexReview: { subagentProvider: 'codex-review-provider', provider: 'codex-review-route', model: 'review-route-model', effort: 'high' },
  codexAudit: { subagentProvider: 'codex-audit-provider', provider: 'codex-audit-route', model: 'audit-route-model', effort: 'xhigh' },
  repositoryPath: '/repo/orc',
  skillRequirements: 'superpowers workflow',
  specOutputSchema: 'spec-schema',
  planOutputSchema: 'plan-schema',
  reviewOutputSchema: 'review-schema',
  auditOutputSchema: 'audit-schema',
  blockingSeverities: ['critical', 'high', 'medium'],
}

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type OrcPayloads = { [Type in keyof OrcEventMap]: SessionEventMap[Type] }
const orcPayloadsMatchSessionMap: Exact<OrcEventMap, OrcPayloads> = true

it('replays the authored ORC corpus through durable completion before its final tool result', async () => {
  const text = await readFile(new URL('../../../../snapshots/session/orc-superpowers/session.v3.jsonl', import.meta.url), 'utf8')
  const rows = text.trim().split('\n').map(line => JSON.parse(line) as SessionEvent)
  const orcEvents = rows.filter(row => row.type.startsWith('orc/')) as unknown as OrcEvent[]
  expect(projectOrc(orcEvents)).toMatchObject({ phase: 'complete' })
  const completed = rows.findIndex(row => row.type === 'orc/run/completed')
  expect(rows[completed]).toEqual({
    type: 'orc/run/completed',
    data: { version: 1, runId: '{{workflow:1}}', actorNodeId: '{{session:1}}' },
  })
  expect(rows[completed - 1]?.type).toBe('orc/audit/result')
  const next = rows[completed + 1]
  expect(next?.type).toBe('tool/result')
  if (next?.type !== 'tool/result') throw new Error('completion must precede the final tool result')
  const result = next.data.message.content[0]
  expect(result).toMatchObject({ type: 'tool-result', toolCallId: 'call-final-gates', isError: false })
  if (result?.type !== 'tool-result') throw new Error('final tool result is missing')
  const content = result.content[0]
  if (content?.type !== 'text') throw new Error('final tool result has no state text')
  expect(JSON.parse(content.text)).toEqual({ phase: 'complete', runId: '{{workflow:1}}', approval: 'approved' })
})

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

class FakeSubagents extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    void name
    void request
    return {
      id: SessionId('codex-open'),
      localAgent: undefined,
      result: new Promise(() => {}),
      dispose: () => Promise.resolve(),
    }
  }

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    return { childId: spec.childId ?? SessionId('missing-child'), messageId: 'msg-1' as ContinuableStart['messageId'] }
  }
}

function asAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session, options: {} } as Agent
}

async function dispose(ctx: Context): Promise<void> {
  try {
    await ctx.fiber.dispose()
  } catch (error: unknown) {
    void error
  }
}

afterEach(async () => {
  await Promise.all(OPEN.splice(0).map(dispose))
  await Promise.all(ROOTS.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(root: string): Promise<{ ctx: Context; service: OrcService; supervisor: Agent }> {
  const ctx = new Context()
  OPEN.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
  await ctx.plugin(FakeAgents)
  await ctx.plugin(FakeSubagents)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(OrcInvariant)
  await ctx.plugin(OrcService, CONFIG)
  return { ctx, service: ctx.orc, supervisor: asAgent(ctx, 'supervisor') }
}

describe('ORC loader composition', () => {
  it('keeps every orc payload on SessionEventMap', () => {
    expect(orcPayloadsMatchSessionMap).toBe(true)
  })

  it('reopens spec, approval, peer, and fix events from JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orc-reopen-'))
    ROOTS.push(root)
    const harness = await mount(root)
    const { service, supervisor } = harness
    await service.createWorkflow(supervisor, {
      prompt: 'Supervisor prompt',
      skillEnvelope: 'superpowers supervisor',
      writeScope: ['repo'],
      acceptanceCriteria: 'run reaches review',
      reportingFormat: 'durable events',
    })
    const spec = await service.startSpecPlan(supervisor, 'brainstorm-notes', SIGNAL)
    await service.recordResult(supervisor, {
      correlationId: spec.correlationId,
      stage: 'codex-spec',
      role: 'spec-only',
      status: 'ok',
      text: 'design spec',
      rawText: '{"stage":"codex-spec","spec":"design spec"}',
    })
    const plan = await service.startSpecPlan(supervisor, 'brainstorm-notes', SIGNAL)
    await service.recordResult(supervisor, {
      correlationId: plan.correlationId,
      stage: 'codex-plan',
      role: 'plan-only',
      status: 'ok',
      text: 'implementation plan',
      rawText: '{"stage":"codex-plan","plan":"implementation plan"}',
    })
    supervisor.session.append('plan/review', { version: 1, correlation: 'plan-review-1', decision: 'approved' })
    await service.planReviewSettled()
    await service.assignTask(supervisor, {
      taskId: TASK,
      writeScope: ['src'],
      acceptanceCriteria: 'parser exists',
    })
    await service.advance(supervisor, 'task_implementation')
    const leadLaunch = await service.spawn(supervisor, {
      role: 'lead',
      taskId: TASK,
      prompt: 'lead prompt',
      skillEnvelope: 'superpowers lead',
      writeScope: ['src'],
      acceptanceCriteria: 'parser exists',
      reportingFormat: 'event',
      signal: SIGNAL,
    })
    if (leadLaunch.nodeId === undefined) throw new Error('lead id is required')
    await service.startTask(supervisor, { taskId: TASK, leadNodeId: leadLaunch.nodeId })
    const lead = asAgent(harness.ctx, String(leadLaunch.nodeId))
    const peerLaunch = await service.spawn(lead, {
      role: 'peer',
      taskId: TASK,
      prompt: 'peer prompt',
      skillEnvelope: 'superpowers peer',
      writeScope: ['src'],
      acceptanceCriteria: 'parser exists',
      reportingFormat: 'event',
      signal: SIGNAL,
    })
    await service.recordResult(supervisor, {
      correlationId: peerLaunch.correlationId,
      stage: 'deepseek-node',
      role: 'peer',
      taskId: TASK,
      outcome: 'settled',
      evidence: 'peer done',
    })
    await service.advance(lead, 'task_peer_settlement')
    await service.recordResult(supervisor, {
      correlationId: leadLaunch.correlationId,
      stage: 'deepseek-node',
      role: 'lead',
      taskId: TASK,
      outcome: 'settled',
      evidence: 'lead done',
    })
    await service.settleTask(lead, { taskId: TASK, leadNodeId: leadLaunch.nodeId, evidence: 'task done' })
    await service.advance(lead, 'task_review')
    const review = await service.requestReview(supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await service.recordResult(supervisor, {
      correlationId: review.correlationId,
      stage: 'codex-review',
      role: 'review-only',
      taskId: TASK,
      status: 'ok',
      rawText: '{"stage":"codex-review","findings":[{"id":"finding-1"}]}',
      findings: [{
        id: OrcFindingId('finding-1'),
        severity: 'high',
        summary: 'missing null check',
        taskId: TASK,
        file: 'src/a.ts',
        location: 'src/a.ts:3',
        evidence: 'null',
        remediation: 'check',
        sourceStage: 'codex-review',
      }],
    })
    await service.advance(lead, 'task_audit')
    const audit = await service.requestAudit(supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await service.recordResult(supervisor, {
      correlationId: audit.correlationId,
      stage: 'codex-audit',
      role: 'audit-only',
      taskId: TASK,
      status: 'ok',
      rawText: '{"stage":"codex-audit","findings":[]}',
      findings: [],
    })
    await service.advance(supervisor, 'task_fix')
    await service.recordFix(supervisor, { taskId: TASK, iteration: 1, decision: 'fix the null check', assigneeNodeId: leadLaunch.nodeId })
    await service.advance(lead, 'task_review')
    const cleanReview = await service.requestReview(supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await service.recordResult(supervisor, {
      correlationId: cleanReview.correlationId,
      stage: 'codex-review',
      role: 'review-only',
      taskId: TASK,
      status: 'ok',
      findings: [],
    })
    await service.advance(lead, 'task_audit')
    const cleanAudit = await service.requestAudit(supervisor, { scope: 'task', taskId: TASK, signal: SIGNAL })
    await service.recordResult(supervisor, {
      correlationId: cleanAudit.correlationId,
      stage: 'codex-audit',
      role: 'audit-only',
      taskId: TASK,
      status: 'ok',
      findings: [],
    })
    const sessionId = supervisor.session.id
    const durable = await harness.ctx.sessionPersistence.create(supervisor.session.header)
    await durable.append(supervisor.session.snapshotEvents())
    await durable.close()
    await dispose(harness.ctx)
    OPEN.splice(OPEN.indexOf(harness.ctx), 1)

    const reader = new Context()
    OPEN.push(reader)
    await reader.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
    const handle = await reader.sessionPersistence.open(sessionId, 'read')
    let events: readonly SessionEvent[]
    try {
      events = (await handle.read()).events
    } finally {
      await handle.close()
    }
    const orc = projectOrc(events.flatMap((event): OrcEvent[] => {
      if (!event.type.startsWith('orc/')) return []
      return [{ type: event.type, data: event.data } as OrcEvent]
    }))
    expect(orc.failure).toBeUndefined()
    const supervisorNode = orc.nodes.find(node => node.role === 'supervisor')
    const leadNode = orc.nodes.find(node => node.role === 'lead')
    const peerNode = orc.nodes.find(node => node.role === 'peer')
    expect(supervisorNode).toMatchObject({ prompt: 'Supervisor prompt', skillEnvelope: 'superpowers supervisor' })
    expect(leadNode).toMatchObject({ prompt: 'lead prompt', skillEnvelope: 'superpowers lead', taskId: TASK })
    expect(peerNode).toMatchObject({ prompt: 'peer prompt', skillEnvelope: 'superpowers peer', taskId: TASK })
    expect(orc.delegations.filter(item => item.kind === 'codex-spec' || item.kind === 'codex-plan').map(item => item.contextRef))
      .toEqual(['brainstorm-notes', 'brainstorm-notes'])
    expect(orc.specText).toBe('design spec')
    expect(orc.planText).toBe('implementation plan')
    expect(orc.delegations.find(item => item.kind === 'codex-spec')?.rawText).toContain('design spec')
    expect(orc.approval).toBe('approved')
    expect(orc.approvalCorrelation).toBe('plan-review-1')
    expect(events.some(event => event.type === 'plan/review' && event.data.decision === 'approved' && event.data.correlation === 'plan-review-1')).toBe(true)
    expect(orc.tasks[0]).toMatchObject({ id: TASK, fixDecision: 'fix the null check', iteration: 1 })
    expect(orc.findings.map(finding => finding.summary)).toEqual(['missing null check'])
    const reviewRows = orc.delegations.filter(item => item.kind === 'codex-review')
    expect(reviewRows.map(item => item.blocksProgress)).toEqual([true, false])
    const auditRows = orc.delegations.filter(item => item.kind === 'codex-audit')
    expect(auditRows.every(item => item.status === 'ok')).toBe(true)
  })
})
