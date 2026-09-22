import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContinuableStart, ContinuableStartSpec, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  OrcService,
  OrcTaskId,
  type OrcLaunch,
  type OrcServiceConfig,
} from '@deepseek-ai/dsh-experimental-orc'
import * as toolOrc from '../src/index.ts'
import { renderCodexEnvelope, renderDeepseekChildPrompt, renderRoleSection } from '../src/index.ts'

const SIGNAL = new AbortController().signal
const TASK = 'task-a'
const BLOCKING = ['critical', 'high', 'medium'] as const
const TOOL_NAMES = [
  'orc_advance',
  'orc_assign_task',
  'orc_create_workflow',
  'orc_fail',
  'orc_record_fix',
  'orc_record_plan_decision',
  'orc_record_result',
  'orc_request_audit',
  'orc_request_review',
  'orc_request_spec_plan',
  'orc_settle_task',
  'orc_spawn',
  'orc_start_task',
]

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

class FakePersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async flush(): Promise<void> {}
}

class FakeSubagents extends Service {
  readonly continuable: ContinuableStartSpec[] = []
  readonly oneShot: { name: string; request: SubagentStartRequest }[] = []

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    this.oneShot.push({ name, request })
    return {
      id: SessionId(`shot-${this.oneShot.length}`),
      localAgent: undefined,
      result: Promise.resolve({ output: [{ type: 'text', text: 'child text' }], stopReason: 'completed' }),
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
  supervisor: Agent
  orc: OrcService
  fake: FakeSubagents
}

const open: Context[] = []
let callNumber = 0

afterEach(async () => {
  const pending = open.splice(0)
  await Promise.all(pending.map(async (ctx) => {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      void error
    }
  }))
})

async function publishAgent(ctx: Context, id: string): Promise<Agent> {
  let agent!: Agent
  await ctx.plugin(Object.assign(async (inner: Context) => {
    const session = inner.sessions.create(SessionId(id))
    const created = { id: session.id, session, options: {} } as Agent
    Object.assign(created, { ctx: createScope(inner, created).ctx })
    agent = created
    await inner.agents.register(created)
  }, { inject: ['sessions', 'agents', 'tools', 'systemPrompt'] }))
  return agent
}

async function setup(): Promise<Harness> {
  const ctx = new Context()
  open.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FakePersistence)
  await ctx.plugin(FakeSubagents)
  await ctx.plugin(OrcService, CONFIG)
  await ctx.plugin(toolOrc)
  const supervisor = await publishAgent(ctx, 'supervisor')
  return { ctx, supervisor, orc: ctx.orc, fake: ctx.get('subagents') as FakeSubagents }
}

function execute(ctx: Context, agent: Agent | undefined, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`orc-call-${++callNumber}`),
    name,
    arguments: args,
    signal: SIGNAL,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function errorCode(result: Awaited<ReturnType<typeof execute>>): string | undefined {
  if (!result.isError) return undefined
  const info: unknown = result.error?.info
  if (typeof info !== 'object' || info === null || !('code' in info)) return undefined
  return typeof info.code === 'string' ? info.code : undefined
}

async function promptOf(ctx: Context, agent: Agent): Promise<string> {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return renderPrompt(await ctx.systemPrompt.assemble({ scope }))
}

function orcSchemas(tools: { name: string; parameters: unknown }[]): string {
  return JSON.stringify(tools.filter(tool => TOOL_NAMES.includes(tool.name)).map(tool => ({
    name: tool.name,
    parameters: tool.parameters,
  })))
}

async function schemasOf(ctx: Context, agent: Agent): Promise<string> {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  const assembly = await ctx.systemPrompt.assemble({ scope })
  return orcSchemas(assembly.tools)
}

async function openWorkflow(harness: Harness): Promise<void> {
  await harness.orc.createWorkflow(harness.supervisor, {
    prompt: 'Supervisor prompt',
    skillEnvelope: 'superpowers supervisor',
    writeScope: ['repo'],
    acceptanceCriteria: 'run reaches complete',
    reportingFormat: 'durable events',
    blockingSeverities: [...BLOCKING],
  })
}

async function finishFromOpenSpec(harness: Harness): Promise<void> {
  const task = OrcTaskId(TASK)
  const spec = await harness.orc.startSpecPlan(harness.supervisor, SIGNAL)
  await harness.orc.recordResult(harness.supervisor, {
    correlationId: spec.correlationId,
    stage: 'codex-spec',
    role: 'spec-only',
    status: 'ok',
    text: 'design spec',
  })
  await harness.orc.advance(harness.supervisor, 'plan_required', task)
  const plan = await harness.orc.startSpecPlan(harness.supervisor, SIGNAL)
  await harness.orc.recordResult(harness.supervisor, {
    correlationId: plan.correlationId,
    stage: 'codex-plan',
    role: 'plan-only',
    status: 'ok',
    text: 'implementation plan',
  })
  await harness.orc.advance(harness.supervisor, 'awaiting_user_approval')
  await harness.orc.approvePlan(harness.supervisor, 'approved')
  await harness.orc.assignTask(harness.supervisor, {
    taskId: task,
    writeScope: ['src'],
    acceptanceCriteria: 'done task-a',
  })
  await harness.orc.advance(harness.supervisor, 'task_implementation')
}

async function reachImplementation(harness: Harness): Promise<void> {
  await openWorkflow(harness)
  await finishFromOpenSpec(harness)
}

function leadInput() {
  return {
    role: 'lead' as const,
    taskId: OrcTaskId(TASK),
    prompt: 'lead prompt',
    skillEnvelope: 'superpowers lead',
    writeScope: ['src'],
    acceptanceCriteria: 'report evidence',
    reportingFormat: 'settlement event',
    signal: SIGNAL,
  }
}

function peerInput() {
  return { ...leadInput(), role: 'peer' as const, prompt: 'peer prompt', skillEnvelope: 'superpowers peer' }
}

async function publishLaunch(ctx: Context, launch: OrcLaunch): Promise<Agent> {
  if (launch.nodeId === undefined) throw new Error('launch has no node id')
  return publishAgent(ctx, String(launch.nodeId))
}

function promptText(blocks: readonly ContentBlock[] | undefined): string {
  return (blocks ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('dsh-tool-orc', () => {
  it('registers one stable catalog and distinct role sections', async () => {
    const harness = await setup()
    const before = await schemasOf(harness.ctx, harness.supervisor)
    const initial = await promptOf(harness.ctx, harness.supervisor)
    expect(initial).toContain('role: unassigned')
    expect(initial).toContain('Superpowers workflow requirements apply when the workflow opens.')
    await reachImplementation(harness)
    const leadLaunch = await harness.orc.spawn(harness.supervisor, leadInput())
    const lead = await publishLaunch(harness.ctx, leadLaunch)
    await harness.orc.startTask(harness.supervisor, { taskId: OrcTaskId(TASK), leadNodeId: leadLaunch.nodeId! })
    const peerLaunch = await harness.orc.spawn(lead, peerInput())
    const peer = await publishLaunch(harness.ctx, peerLaunch)

    const supervisorTools = (await harness.ctx.systemPrompt.assemble({ scope: scopeOf(harness.supervisor.ctx) }))
      .tools.map(tool => tool.name).filter(name => TOOL_NAMES.includes(name)).sort()
    const leadTools = (await harness.ctx.systemPrompt.assemble({ scope: scopeOf(lead.ctx) }))
      .tools.map(tool => tool.name).filter(name => TOOL_NAMES.includes(name)).sort()
    const peerTools = (await harness.ctx.systemPrompt.assemble({ scope: scopeOf(peer.ctx) }))
      .tools.map(tool => tool.name).filter(name => TOOL_NAMES.includes(name)).sort()
    expect(supervisorTools).toEqual(TOOL_NAMES)
    expect(leadTools).toEqual(TOOL_NAMES)
    expect(peerTools).toEqual(TOOL_NAMES)
    expect(await schemasOf(harness.ctx, lead)).toBe(await schemasOf(harness.ctx, harness.supervisor))
    expect(await schemasOf(harness.ctx, peer)).toBe(await schemasOf(harness.ctx, harness.supervisor))
    expect(await schemasOf(harness.ctx, harness.supervisor)).toBe(before)

    const supervisorPrompt = await promptOf(harness.ctx, harness.supervisor)
    const leadPrompt = await promptOf(harness.ctx, lead)
    const peerPrompt = await promptOf(harness.ctx, peer)
    expect(supervisorPrompt).toContain('role: supervisor')
    expect(supervisorPrompt).toContain('parent: none')
    expect(supervisorPrompt).toContain('may create Leads')
    expect(supervisorPrompt).toContain('phase: task_implementation')
    expect(supervisorPrompt).toContain('task: task-a')
    expect(supervisorPrompt).toContain('mandatory Superpowers skills: brainstorming, writing-plans, requesting-code-review, verification-before-completion')
    expect(leadPrompt).toContain('role: lead')
    expect(leadPrompt).toContain('parent: supervisor')
    expect(leadPrompt).toContain('may create Peers')
    expect(leadPrompt).toContain('may not invoke Codex')
    expect(leadPrompt).toContain('phase: task_implementation')
    expect(leadPrompt).toContain('task: task-a')
    expect(leadPrompt).toContain('mandatory Superpowers skills: subagent-driven-development, test-driven-development, verification-before-completion')
    expect(peerPrompt).toContain('role: peer')
    expect(peerPrompt).toContain('may not create children')
    expect(peerPrompt).toContain('phase: task_implementation')
    expect(peerPrompt).toContain('task: task-a')
    expect(peerPrompt).toContain('mandatory Superpowers skills: test-driven-development, verification-before-completion')
    expect(peerPrompt).not.toContain('mandatory Superpowers skills: brainstorming')
    expect(supervisorPrompt).not.toBe(leadPrompt)
    expect(leadPrompt).not.toBe(peerPrompt)
    expect(renderRoleSection({
      role: 'peer',
      parentId: 'lead-1',
      phase: 'task_implementation',
      taskId: TASK,
    })).toContain('role: peer')
  })

  it('rejects peer spawn, approval, Codex gates, and advancing another task', async () => {
    const harness = await setup()
    await reachImplementation(harness)
    const leadLaunch = await harness.orc.spawn(harness.supervisor, leadInput())
    const lead = await publishLaunch(harness.ctx, leadLaunch)
    await harness.orc.startTask(harness.supervisor, { taskId: OrcTaskId(TASK), leadNodeId: leadLaunch.nodeId! })
    const peerLaunch = await harness.orc.spawn(lead, peerInput())
    const peer = await publishLaunch(harness.ctx, peerLaunch)
    const continuable = harness.fake.continuable.length
    const shots = harness.fake.oneShot.length
    const phase = harness.orc.state(harness.supervisor).phase

    const spawned = await execute(harness.ctx, peer, 'orc_spawn', {
      role: 'peer',
      task_id: TASK,
      responsibility: 'nested work',
      write_scope: ['src'],
      acceptance_criteria: 'evidence',
      reporting_format: 'result',
    })
    expect(spawned.isError).toBe(true)
    expect(text(spawned)).toMatch(/peer cannot spawn/)
    expect(harness.fake.continuable).toHaveLength(continuable)

    const approved = await execute(harness.ctx, peer, 'orc_record_plan_decision', {
      decision: 'approved',
      source: 'plan/review',
    })
    expect(approved.isError).toBe(true)
    expect(errorCode(approved)).toBe('ORC_UNAUTHORIZED')
    expect(text(approved)).toMatch(/cannot approve a plan/)
    expect(harness.orc.state(harness.supervisor).approval).toBe('approved')

    const review = await execute(harness.ctx, peer, 'orc_request_review', { scope: 'task', task_id: TASK })
    const audit = await execute(harness.ctx, peer, 'orc_request_audit', { scope: 'task', task_id: TASK })
    expect(errorCode(review)).toBe('ORC_UNAUTHORIZED')
    expect(errorCode(audit)).toBe('ORC_UNAUTHORIZED')
    expect(text(review)).toMatch(/cannot invoke Codex/)
    expect(harness.fake.oneShot).toHaveLength(shots)

    const skipped = await execute(harness.ctx, peer, 'orc_advance', { to: 'next_task', task_id: TASK })
    expect(skipped.isError).toBe(true)
    expect(text(skipped)).toMatch(/peer cannot advance/)
    expect(harness.orc.state(harness.supervisor).phase).toBe(phase)

    const other = await execute(harness.ctx, peer, 'orc_advance', { to: 'task_peer_settlement', task_id: 'other-task' })
    expect(errorCode(other)).toBe('ORC_UNAUTHORIZED')
    expect(text(other)).toMatch(/cannot advance another task/)
    expect(harness.orc.state(harness.supervisor).phase).toBe(phase)

    const leadCodex = await execute(harness.ctx, lead, 'orc_request_spec_plan', {})
    expect(errorCode(leadCodex)).toBe('ORC_UNAUTHORIZED')
    expect(harness.fake.oneShot).toHaveLength(shots)

    const peerStart = await execute(harness.ctx, peer, 'orc_start_task', {
      task_id: TASK,
      lead_node_id: String(leadLaunch.nodeId),
    })
    expect(errorCode(peerStart)).toBe('ORC_UNAUTHORIZED')
    const peerSettle = await execute(harness.ctx, peer, 'orc_settle_task', {
      task_id: TASK,
      evidence: 'no',
      lead_node_id: String(leadLaunch.nodeId),
    })
    expect(errorCode(peerSettle)).toBe('ORC_UNAUTHORIZED')
    const peerFix = await execute(harness.ctx, peer, 'orc_record_fix', {
      task_id: TASK,
      iteration: 1,
      decision: 'fix',
    })
    expect(errorCode(peerFix)).toBe('ORC_UNAUTHORIZED')
    const leadOtherFix = await execute(harness.ctx, lead, 'orc_record_fix', {
      task_id: 'other-task',
      iteration: 1,
      decision: 'no',
    })
    expect(errorCode(leadOtherFix)).toBe('ORC_UNAUTHORIZED')
    const leadFix = await execute(harness.ctx, lead, 'orc_record_fix', {
      task_id: TASK,
      iteration: 1,
      decision: 'later',
    })
    expect(errorCode(leadFix)).toBe('ORC_REFUSED')
    const peerOpen = await execute(harness.ctx, peer, 'orc_create_workflow', {
      responsibility: 'no',
      write_scope: ['src'],
      acceptance_criteria: 'no',
      reporting_format: 'events',
      blocking_severities: [...BLOCKING],
    })
    expect(errorCode(peerOpen)).toBe('ORC_UNAUTHORIZED')
    const peerAssign = await execute(harness.ctx, peer, 'orc_assign_task', {
      task_id: 'task-b',
      write_scope: ['src'],
      acceptance_criteria: 'no',
    })
    expect(errorCode(peerAssign)).toBe('ORC_UNAUTHORIZED')
    const peerResult = await execute(harness.ctx, peer, 'orc_record_result', {
      correlation_id: 'not-the-peer',
      stage: 'deepseek-node',
      delegation_role: 'peer',
      task_id: TASK,
      outcome: 'settled',
    })
    expect(errorCode(peerResult)).toBe('ORC_UNAUTHORIZED')
    const ownCorrelation = String(harness.orc.state(harness.supervisor).nodes.find(node => node.role === 'peer')?.correlationId)
    const wrongTask = await execute(harness.ctx, peer, 'orc_record_result', {
      correlation_id: ownCorrelation,
      stage: 'deepseek-node',
      delegation_role: 'peer',
      task_id: 'other-task',
      outcome: 'settled',
    })
    expect(errorCode(wrongTask)).toBe('ORC_UNAUTHORIZED')
    expect(text(wrongTask)).toMatch(/another task/)
    const leadResult = await execute(harness.ctx, lead, 'orc_record_result', {
      correlation_id: 'not-a-child',
      stage: 'deepseek-node',
      delegation_role: 'peer',
      outcome: 'settled',
    })
    expect(errorCode(leadResult)).toBe('ORC_UNAUTHORIZED')
    const otherLead = await execute(harness.ctx, lead, 'orc_settle_task', {
      task_id: TASK,
      evidence: 'x',
      lead_node_id: 'other-lead',
    })
    expect(errorCode(otherLead)).toBe('ORC_UNAUTHORIZED')

    const named = await execute(harness.ctx, harness.supervisor, 'orc_advance', { to: 'next_task', task_id: 'other-task' })
    expect(errorCode(named)).toBe('ORC_REFUSED')
    expect(harness.orc.state(harness.supervisor).phase).toBe(phase)
    const again = await execute(harness.ctx, harness.supervisor, 'orc_record_plan_decision', {
      decision: 'rejected',
      source: 'plan/review',
    })
    expect(errorCode(again)).toBe('ORC_REFUSED')
    expect(harness.orc.state(harness.supervisor).approval).toBe('approved')
    const lateAssign = await execute(harness.ctx, harness.supervisor, 'orc_assign_task', {
      task_id: 'task-b',
      write_scope: ['docs'],
      acceptance_criteria: 'docs',
    })
    expect(errorCode(lateAssign)).toBe('ORC_REFUSED')
    const lateSpec = await execute(harness.ctx, harness.supervisor, 'orc_request_spec_plan', {})
    expect(errorCode(lateSpec)).toBe('ORC_REFUSED')
    const earlyReview = await execute(harness.ctx, harness.supervisor, 'orc_request_review', { scope: 'task', task_id: TASK })
    expect(errorCode(earlyReview)).toBe('ORC_REFUSED')
    const earlyAudit = await execute(harness.ctx, harness.supervisor, 'orc_request_audit', { scope: 'branch' })
    expect(errorCode(earlyAudit)).toBe('ORC_REFUSED')
    expect(harness.fake.oneShot).toHaveLength(shots)
    const restarted = await execute(harness.ctx, lead, 'orc_start_task', { task_id: TASK })
    const sameLead = await execute(harness.ctx, lead, 'orc_start_task', {
      task_id: TASK,
      lead_node_id: String(lead.id),
    })
    expect(errorCode(sameLead)).toBe('ORC_REFUSED')
    expect(errorCode(restarted)).toBe('ORC_REFUSED')
    const missingStart = await execute(harness.ctx, harness.supervisor, 'orc_start_task', { task_id: TASK })
    expect(errorCode(missingStart)).toBe('ORC_INVALID_INPUT')
    const supervisorStart = await execute(harness.ctx, harness.supervisor, 'orc_start_task', {
      task_id: TASK,
      lead_node_id: String(leadLaunch.nodeId),
    })
    expect(errorCode(supervisorStart)).toBe('ORC_REFUSED')
    const missingLead = await execute(harness.ctx, harness.supervisor, 'orc_settle_task', { task_id: TASK, evidence: 'x' })
    expect(errorCode(missingLead)).toBe('ORC_INVALID_INPUT')
    const unsettled = await execute(harness.ctx, lead, 'orc_settle_task', { task_id: TASK, evidence: 'not yet' })
    expect(errorCode(unsettled)).toBe('ORC_REFUSED')
    const blankFix = await execute(harness.ctx, harness.supervisor, 'orc_record_fix', {
      task_id: ' ',
      iteration: 1,
      decision: 'fix',
    })
    expect(errorCode(blankFix)).toBe('ORC_INVALID_INPUT')
    const earlyFix = await execute(harness.ctx, harness.supervisor, 'orc_record_fix', {
      task_id: TASK,
      iteration: 1,
      decision: 'fix the bug',
    })
    expect(errorCode(earlyFix)).toBe('ORC_REFUSED')
    const nestedLead = await execute(harness.ctx, lead, 'orc_spawn', {
      role: 'lead',
      task_id: TASK,
      responsibility: 'another lead',
      write_scope: ['src'],
      acceptance_criteria: 'no',
      reporting_format: 'event',
    })
    expect(text(nestedLead)).toMatch(/lead cannot create a lead/)
    expect(harness.fake.continuable).toHaveLength(continuable)
    const own = harness.orc.state(harness.supervisor).nodes.find(node => node.role === 'peer')
    const leadRecordsPeer = await execute(harness.ctx, lead, 'orc_record_result', {
      correlation_id: String(own?.correlationId),
      stage: 'deepseek-node',
      delegation_role: 'peer',
      task_id: TASK,
      outcome: 'settled',
      evidence: 'lead saw the peer finish',
    })
    expect(leadRecordsPeer.isError, text(leadRecordsPeer)).toBe(false)
    const recorded = await execute(harness.ctx, peer, 'orc_record_result', {
      correlation_id: String(own?.correlationId),
      stage: 'deepseek-node',
      delegation_role: 'peer',
      task_id: TASK,
      outcome: 'settled',
      evidence: 'peer evidence',
    })
    expect(errorCode(recorded)).toBe('ORC_REFUSED')
    const blankReason = await execute(harness.ctx, harness.supervisor, 'orc_fail', { reason: ' ' })
    expect(errorCode(blankReason)).toBe('ORC_INVALID_INPUT')
    const peerFail = await execute(harness.ctx, peer, 'orc_fail', { reason: 'stop' })
    expect(text(peerFail)).toMatch(/peer cannot/)
    const failed = await execute(harness.ctx, harness.supervisor, 'orc_fail', { reason: 'stop the run' })
    expect(failed.isError, text(failed)).toBe(false)
    expect(harness.orc.state(harness.supervisor).phase).toBe('failed')
  })

  it('puts Superpowers requirements in DeepSeek prompts and the native envelope in Codex prompts', async () => {
    const review = renderCodexEnvelope({
      role: 'review-only',
      stage: 'codex-review',
      repositoryScope: '/repo/orc',
      skillWorkflow: 'superpowers workflow',
      expectedStructuredResult: 'review-schema',
      blockingSeverities: ['critical', 'high', 'medium', 'low'],
      provider: 'copied-provider',
      model: 'copied-model',
      effort: 'copied-effort',
      taskId: TASK,
      scope: 'task',
      iteration: 2,
    })
    expect(review).toContain('role: review-only')
    expect(review).toContain('stage: codex-review')
    expect(review).toContain('task: task-a')
    expect(review).toContain('repositoryScope: /repo/orc')
    expect(review).toContain('skillWorkflow: superpowers workflow')
    expect(review).toContain('expectedStructuredResult: review-schema')
    expect(review).toContain('severityPolicy: critical, high, and medium block; low and info do not unless blockingSeverities includes them')
    expect(review).toContain('blockingSeverities: critical, high, medium, low')
    expect(review).toContain('readOnly: true')
    expect(review).toContain('doNotEdit: true')
    expect(review).toContain('Do not edit files.')
    expect(review).toContain('Do not create subagents.')
    expect(review).toContain('Do not declare an implementation complete.')
    expect(review).toContain('Native Codex children do not inherit DSH skills or context.')
    expect(review).toContain('provider: copied-provider')
    expect(review).toContain('model: copied-model')
    expect(review).toContain('effort: copied-effort')
    expect(review).not.toContain('gpt-5')
    expect(review).not.toContain('deepseek-flash')

    const audit = renderCodexEnvelope({
      role: 'audit-only',
      stage: 'codex-audit',
      repositoryScope: '/repo/orc',
      skillWorkflow: 'superpowers workflow',
      expectedStructuredResult: 'audit-schema',
      blockingSeverities: [...BLOCKING],
      provider: 'audit-provider',
      model: 'audit-model',
      effort: 'audit-effort',
      scope: 'branch',
    })
    expect(audit).toContain('role: audit-only')
    expect(audit).toContain('stage: codex-audit')
    expect(audit).toContain('task: none')
    expect(audit).toContain('doNotEdit: true')
    expect(audit).toContain('readOnly: true')
    expect(audit).not.toBe(review)

    const child = renderDeepseekChildPrompt({
      role: 'peer',
      parentId: 'lead-1',
      phase: 'task_implementation',
      taskId: TASK,
      writeScope: ['src'],
      acceptanceCriteria: 'evidence',
      reportingFormat: 'result event',
      responsibility: 'implement the parser',
    })
    expect(child.skillEnvelope).toContain('Superpowers workflow requirements')
    for (const skill of ['using-superpowers', 'brainstorming', 'writing-plans', 'subagent-driven-development', 'test-driven-development', 'requesting-code-review', 'verification-before-completion']) {
      expect(child.skillEnvelope).toContain(skill)
    }
    expect(child.prompt).toContain('role: peer')
    expect(child.prompt).toContain('task: task-a')
    expect(`${child.prompt}\n${child.skillEnvelope}`).toContain('Superpowers workflow requirements')

    const harness = await setup()
    const opened = await execute(harness.ctx, harness.supervisor, 'orc_create_workflow', {
      responsibility: 'brainstorm the workflow',
      write_scope: ['repo'],
      acceptance_criteria: 'run reaches complete',
      reporting_format: 'durable events',
      blocking_severities: [...BLOCKING],
    })
    expect(opened.isError, text(opened)).toBe(false)
    const openedPrompt = await promptOf(harness.ctx, harness.supervisor)
    expect(openedPrompt).toContain('role: supervisor')
    expect(openedPrompt).toContain('Superpowers workflow requirements')
    expect(openedPrompt).not.toContain('Superpowers workflow requirements apply when the workflow opens.')
    const spec = await execute(harness.ctx, harness.supervisor, 'orc_request_spec_plan', {})
    expect(spec.isError, text(spec)).toBe(false)
    const shot = harness.fake.oneShot.at(-1)
    expect(shot?.request.outputSchema).toBeUndefined()
    expect(shot?.request.maxDepth).toBeUndefined()
    expect(promptText(shot?.request.prompt)).toBe(renderCodexEnvelope({
      role: 'spec-only',
      stage: 'codex-spec',
      repositoryScope: CONFIG.repositoryPath,
      skillWorkflow: CONFIG.skillRequirements,
      expectedStructuredResult: CONFIG.specOutputSchema,
      blockingSeverities: [...BLOCKING],
      provider: CONFIG.codexSpec.provider,
      model: CONFIG.codexSpec.model,
      effort: CONFIG.codexSpec.effort,
    }))

    await finishFromOpenSpec(harness)
    const spawned = await execute(harness.ctx, harness.supervisor, 'orc_spawn', {
      role: 'lead',
      task_id: TASK,
      responsibility: 'split the task',
      write_scope: ['src'],
      acceptance_criteria: 'peers report evidence',
      reporting_format: 'settlement event',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const leadPrompt = promptText(harness.fake.continuable.at(-1)?.request.prompt)
    expect(leadPrompt).toContain('Superpowers workflow requirements')
    expect(leadPrompt).toContain('using-superpowers')
    expect(leadPrompt).toContain('role: lead')
    expect(leadPrompt).toContain('task: task-a')
    expect(harness.fake.continuable.at(-1)?.request).not.toHaveProperty('outputSchema')
    const logged = harness.orc.state(harness.supervisor).nodes.find(node => node.role === 'lead')
    expect(logged?.skillEnvelope).toContain('Superpowers workflow requirements')
    expect(leadPrompt).toContain(logged?.skillEnvelope ?? 'missing skill envelope')
    expect(leadPrompt).toContain(logged?.prompt ?? 'missing prompt')
  })

  it('rejects malformed identifiers and stages before the service', async () => {
    const harness = await setup()
    const unassigned = await execute(harness.ctx, harness.supervisor, 'orc_record_result', {
      correlation_id: 'early',
      stage: 'codex-spec',
      delegation_role: 'spec-only',
    })
    expect(errorCode(unassigned)).toBe('ORC_UNAUTHORIZED')
    await openWorkflow(harness)
    const events = (): number => harness.supervisor.session.snapshotEvents().length
    const before = events()
    const shots = harness.fake.oneShot.length

    const stage = await execute(harness.ctx, harness.supervisor, 'orc_advance', { to: 'sideways' })
    expect(stage.isError).toBe(true)
    expect(errorCode(stage)).toBe('INVALID_ARGS')
    expect(events()).toBe(before)
    expect(harness.orc.state(harness.supervisor).phase).toBe('brainstorming')

    const blankTask = await execute(harness.ctx, harness.supervisor, 'orc_assign_task', {
      task_id: ' ',
      write_scope: ['src'],
      acceptance_criteria: 'done',
    })
    expect(errorCode(blankTask)).toBe('ORC_INVALID_INPUT')
    expect(harness.orc.state(harness.supervisor).tasks).toEqual([])
    expect(events()).toBe(before)

    const blankCorrelation = await execute(harness.ctx, harness.supervisor, 'orc_record_result', {
      correlation_id: '',
      stage: 'codex-spec',
      delegation_role: 'spec-only',
    })
    expect(errorCode(blankCorrelation)).toBe('ORC_INVALID_INPUT')
    expect(events()).toBe(before)

    const badStage = await execute(harness.ctx, harness.supervisor, 'orc_record_result', {
      correlation_id: 'corr-1',
      stage: 'codex-skip',
      delegation_role: 'spec-only',
    })
    expect(errorCode(badStage)).toBe('INVALID_ARGS')
    expect(events()).toBe(before)
    expect(harness.fake.oneShot).toHaveLength(shots)

    const emptyScope = await execute(harness.ctx, harness.supervisor, 'orc_create_workflow', {
      responsibility: 'again',
      write_scope: [],
      acceptance_criteria: 'done',
      reporting_format: 'events',
      blocking_severities: [...BLOCKING],
    })
    expect(errorCode(emptyScope)).toBe('ORC_INVALID_INPUT')
    expect(harness.orc.state(harness.supervisor).runId).toBeDefined()
    expect(events()).toBe(before)

    const invented = await execute(harness.ctx, harness.supervisor, 'orc_record_plan_decision', {
      source: 'plan/review',
    })
    expect(errorCode(invented)).toBe('INVALID_ARGS')
    expect(harness.orc.state(harness.supervisor).approval).toBeUndefined()
    expect(events()).toBe(before)

    const blankFinding = await execute(harness.ctx, harness.supervisor, 'orc_record_result', {
      correlation_id: 'corr-1',
      stage: 'codex-review',
      delegation_role: 'review-only',
      findings: [{ id: ' ', severity: 'high', summary: 'bug' }],
    })
    expect(errorCode(blankFinding)).toBe('ORC_INVALID_INPUT')
    const mapped = await execute(harness.ctx, harness.supervisor, 'orc_record_result', {
      correlation_id: 'missing',
      stage: 'codex-review',
      delegation_role: 'review-only',
      findings: [{ id: 'f-1', severity: 'low', summary: 'note', task_id: TASK }],
    })
    expect(errorCode(mapped)).toBe('ORC_REFUSED')
    const blankScopeItem = await execute(harness.ctx, harness.supervisor, 'orc_spawn', {
      role: 'lead',
      task_id: TASK,
      responsibility: 'work',
      write_scope: [' '],
      acceptance_criteria: 'done',
      reporting_format: 'event',
    })
    expect(errorCode(blankScopeItem)).toBe('ORC_INVALID_INPUT')
    expect(events()).toBe(before)
    expect(harness.fake.oneShot).toHaveLength(shots)
  })
})
