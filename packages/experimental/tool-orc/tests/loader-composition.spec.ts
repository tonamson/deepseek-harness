/** Loader composition and the strict ORC lifecycle. Standard presets stay without ORC. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContinuableStart, ContinuableStartSpec, SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import UserQuestionService, { type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import PlanModeController, { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import { OrcService, OrcTaskId, type OrcServiceConfig } from '@deepseek-ai/dsh-experimental-orc'
import * as toolOrc from '../src/index.ts'

const ROOT = resolve(import.meta.dirname, '../../../..')
const PROFILE_PATCH = resolve(ROOT, 'packages/experimental/orc-profile/cordis.patch.yml')
const MY_CODING = resolve(ROOT, 'packages/preset/agent-presets/presets/my-coding/agent.cordis.yml')
const STANDARD = resolve(ROOT, 'packages/preset/agent-presets/presets/standard/agent.cordis.yml')
const SIGNAL = new AbortController().signal
const TASK = OrcTaskId('task-a')

interface Inserted {
  id?: string
  name?: string
  config?: OrcServiceConfig
}

function inserted(path: string): Inserted[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a patch list`)
  return (parsed as { insert?: Inserted[] }[]).flatMap(entry => entry.insert ?? [])
}

function profileConfig(): OrcServiceConfig {
  const config = inserted(PROFILE_PATCH).find(row => row.id === 'orc')?.config
  if (config === undefined) throw new Error('ORC profile has no service config')
  return config
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
  readonly sent: { targetId: string; text: string }[] = []
  readonly queue: Promise<SubagentResult>[] = []
  owner: Context

  constructor(ctx: Context) {
    super(ctx, 'subagents')
    this.owner = ctx
  }

  async start(name: string, request: SubagentStartRequest): Promise<{
    id: ReturnType<typeof SessionId>
    localAgent: undefined
    result: Promise<SubagentResult>
    dispose: () => Promise<void>
  }> {
    this.oneShot.push({ name, request })
    const result = this.queue.shift() ?? new Promise<SubagentResult>(() => {})
    return {
      id: SessionId(`shot-${String(this.oneShot.length)}`),
      localAgent: undefined,
      result,
      dispose: () => Promise.resolve(),
    }
  }

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    this.continuable.push(spec)
    const id = spec.childId ?? SessionId('missing-child')
    if (this.owner.agents.get(id) === undefined) {
      await this.owner.plugin(Object.assign(async (inner: Context) => {
        const session = inner.sessions.create(id)
        const created = { id: session.id, session, options: {}, status: 'idle' } as Agent
        Object.assign(created, { ctx: createScope(inner, created).ctx })
        await inner.agents.register(created)
      }, { inject: ['sessions', 'agents', 'tools', 'systemPrompt'] }))
    }
    return { childId: id, messageId: 'msg-1' as ContinuableStart['messageId'] }
  }

  async sendMessage(
    _sender: Agent,
    targetId: ReturnType<typeof SessionId>,
    content: readonly ContentBlock[],
  ): Promise<string> {
    const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    this.sent.push({ targetId: String(targetId), text })
    const lead = this.owner.agents.get(targetId)
    if (lead === undefined) throw new Error('lead is not admitted')
    lead.session.append('turn/start', { turn: 1 })
    lead.session.append('step/start', { turn: 1, step: 1 })
    lead.session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `fixed ${String(targetId)}` }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
      }),
    }, { surfaceOp: 'append' })
    lead.session.append('step/end', { turn: 1, step: 1 })
    lead.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return 'fix-message'
  }
}

interface Harness {
  ctx: Context
  supervisor: Agent
  orc: OrcService
  fake: FakeSubagents
}

const open: Context[] = []
const temps: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (ctx) => {
    try {
      await ctx.fiber.dispose()
    } catch (error: unknown) {
      void error
    }
  }))
  await Promise.all(temps.splice(0).map(async path => rm(path, { recursive: true, force: true })))
})

async function publishAgent(ctx: Context, id: string): Promise<Agent> {
  let agent!: Agent
  await ctx.plugin(Object.assign(async (inner: Context) => {
    const session = inner.sessions.create(SessionId(id))
    const created = { id: session.id, session, options: {}, status: 'idle' } as Agent
    Object.assign(created, { ctx: createScope(inner, created).ctx })
    agent = created
    await inner.agents.register(created)
  }, { inject: ['sessions', 'agents', 'tools', 'systemPrompt'] }))
  return agent
}

async function boot(config: OrcServiceConfig): Promise<Harness> {
  const ctx = new Context()
  open.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(FakePersistence)
  await ctx.plugin(FakeSubagents)
  ;(ctx.get('subagents') as FakeSubagents).owner = ctx
  await ctx.plugin(OrcService, config)
  await ctx.plugin(PlanModeController, { section: 'Plan the change. Do not edit files.' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(toolOrc)
  const supervisor = await publishAgent(ctx, 'supervisor')
  return { ctx, supervisor, orc: ctx.orc, fake: ctx.get('subagents') as FakeSubagents }
}

async function openWorkflow(harness: Harness): Promise<void> {
  await harness.orc.createWorkflow(harness.supervisor, {
    prompt: 'Supervisor prompt',
    skillEnvelope: 'superpowers supervisor',
    writeScope: ['repo'],
    acceptanceCriteria: 'run reaches complete',
    reportingFormat: 'durable events',
    blockingSeverities: ['critical', 'high', 'medium'],
  })
}

function codexText(stage: 'codex-spec' | 'codex-plan' | 'codex-review' | 'codex-audit', body: unknown): SubagentResult {
  return { output: [{ type: 'text', text: JSON.stringify(body) }], stopReason: 'completed' }
}

async function answerReview(harness: Harness, selected: string[]): Promise<void> {
  harness.ctx.on('user-questions/request', (_request: AskUserQuestionRequest) => Promise.resolve({
    answers: [{ id: 'plan-review', selected }],
  }))
  harness.ctx.planMode.set(harness.supervisor, true)
  const result = await harness.ctx.tools.execute({
    callId: ToolCallId('call-exit-lifecycle'),
    name: EXIT_PLAN_MODE,
    arguments: { plan: '# Ship the task\n\nImplement the parser.' },
    signal: SIGNAL,
    agent: harness.supervisor,
  })
  if (selected[0] === 'Approve' && result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
  await harness.orc.planReviewSettled()
}

async function specAndPlan(harness: Harness): Promise<void> {
  harness.fake.queue.push(Promise.resolve(codexText('codex-spec', { stage: 'codex-spec', spec: 'design is complete' })))
  await harness.orc.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
  await harness.orc.awaitCodex(harness.supervisor, harness.orc.state(harness.supervisor).delegations[0]!.correlationId)
  harness.fake.queue.push(Promise.resolve(codexText('codex-plan', { stage: 'codex-plan', plan: 'ship the task' })))
  await harness.orc.startSpecPlan(harness.supervisor, 'brainstorm-1', SIGNAL)
  const plan = harness.orc.state(harness.supervisor).delegations.find(item => item.kind === 'codex-plan')
  if (plan === undefined) throw new Error('plan did not start')
  await harness.orc.awaitCodex(harness.supervisor, plan.correlationId)
  await harness.orc.advance(harness.supervisor, 'awaiting_user_approval')
}

describe('ORC profile composition', () => {
  it('boots the selected profile with ORC routes and leaves the standard preset unchanged', () => {
    const rows = inserted(PROFILE_PATCH)
    const orc = rows.find(row => row.id === 'orc')
    expect(orc).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-orc',
      config: {
        deepseek: { subagentProvider: 'spawn', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
        codexSpec: { subagentProvider: 'codex-spec', provider: 'codex-spec', model: 'gpt-5.6-terra', effort: 'high' },
        codexPlan: { subagentProvider: 'codex-spec', provider: 'codex-spec', model: 'gpt-5.6-terra', effort: 'high' },
        codexReview: { subagentProvider: 'codex-review', provider: 'codex-review', model: 'gpt-5.6-luna', effort: 'high' },
        codexAudit: { subagentProvider: 'codex-audit', provider: 'codex-audit', model: 'gpt-5.6-luna', effort: 'xhigh' },
      },
    })
    expect(rows.find(row => row.id === 'tool-orc')).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-tool-orc',
    })
    const coding = readFileSync(MY_CODING, 'utf8')
    const standard = readFileSync(STANDARD, 'utf8')
    expect(coding).toContain('orc_request_spec_plan')
    expect(coding).not.toContain('@deepseek-ai/dsh-experimental-orc')
    expect(standard).not.toContain('orc_request_spec_plan')
    expect(standard).not.toContain('@deepseek-ai/dsh-experimental-orc')
    expect(standard).not.toContain('@deepseek-ai/dsh-experimental-tool-orc')
  })

  it('loads the profile rows through Loader and does not mount them for a standard context', async () => {
    const rows = inserted(PROFILE_PATCH)
    const root = await mkdtemp(join(tmpdir(), 'dsh-orc-profile-'))
    temps.push(root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, yaml.dump(rows))
    const ctx = new Context()
    open.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FakePersistence)
    await ctx.plugin(FakeSubagents)
    ;(ctx.get('subagents') as FakeSubagents).owner = ctx
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-experimental-orc', OrcService],
      ['@deepseek-ai/dsh-experimental-tool-orc', toolOrc],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const supervisor = await publishAgent(ctx, 'loader-supervisor')
    const names = (await ctx.systemPrompt.assemble({ scope: scopeOf(supervisor.ctx) })).tools.map(tool => tool.name)
    expect(names).toContain('orc_request_spec_plan')
    expect(names).toContain('orc_run_task_gates')
    expect(names).not.toContain('orc_record_plan_decision')
    await ctx.orc.createWorkflow(supervisor, {
      prompt: 'Supervisor prompt',
      skillEnvelope: 'superpowers',
      writeScope: ['repo'],
      acceptanceCriteria: 'done',
      reportingFormat: 'events',
      blockingSeverities: ['critical', 'high', 'medium'],
    })
    const fake = ctx.get('subagents') as FakeSubagents
    fake.queue.push(Promise.resolve(codexText('codex-spec', { stage: 'codex-spec', spec: 'design is complete' })))
    await ctx.orc.startSpecPlan(supervisor, 'brainstorm-1', SIGNAL)
    expect(fake.oneShot[0]?.name).toBe('codex-spec')
    expect(JSON.stringify(fake.oneShot[0]?.request.prompt)).toContain('gpt-5.6-terra')
    expect(JSON.stringify(fake.oneShot[0]?.request.prompt)).toContain('contextRef: brainstorm-1')
    expect(fake.continuable).toHaveLength(0)

    const plain = new Context()
    open.push(plain)
    await mountAgentLoopTestDependencies(plain)
    const plainAgent = await publishAgent(plain, 'standard-agent')
    const plainNames = (await plain.systemPrompt.assemble({ scope: scopeOf(plainAgent.ctx) })).tools.map(tool => tool.name)
    expect(plainNames.some(name => name.startsWith('orc_'))).toBe(false)
    expect(plain.get('orc')).toBeUndefined()
  })
})

describe('ORC plan approval and fix loop', () => {
  it('does not start a Lead before exit_plan_mode approval', async () => {
    const harness = await boot(profileConfig())
    await openWorkflow(harness)
    await expect(harness.orc.startSpecPlan(harness.supervisor, '   ', SIGNAL)).rejects.toThrow(/context reference/)
    await expect(harness.orc.spawn(harness.supervisor, {
      role: 'lead',
      taskId: TASK,
      prompt: 'lead',
      skillEnvelope: 'skills',
      writeScope: ['src'],
      acceptanceCriteria: 'done',
      reportingFormat: 'event',
      signal: SIGNAL,
    })).rejects.toThrow(/plan approval/)
    expect(harness.fake.continuable).toHaveLength(0)

    await specAndPlan(harness)
    expect(harness.orc.state(harness.supervisor).phase).toBe('awaiting_user_approval')
    expect(harness.fake.continuable).toHaveLength(0)
    const mode = harness.supervisor.session.append.bind(harness.supervisor.session) as (type: string, data: unknown) => void
    mode('plan/mode', { active: false })
    await harness.orc.planReviewSettled()
    expect(harness.orc.state(harness.supervisor).approval).toBeUndefined()

    await answerReview(harness, ['Keep planning'])
    expect(harness.orc.state(harness.supervisor).approval).toBe('rejected')
    await expect(harness.orc.spawn(harness.supervisor, {
      role: 'lead',
      taskId: TASK,
      prompt: 'lead',
      skillEnvelope: 'skills',
      writeScope: ['src'],
      acceptanceCriteria: 'done',
      reportingFormat: 'event',
      signal: SIGNAL,
    })).rejects.toThrow(/user rejection/)
    expect(harness.fake.continuable).toHaveLength(0)
  })

  it('approves from exit_plan_mode, then creates a Lead and Peer, then fixes through that Lead', async () => {
    const harness = await boot(profileConfig())
    await openWorkflow(harness)
    await specAndPlan(harness)
    await answerReview(harness, ['Approve'])
    expect(harness.supervisor.session.snapshotEvents().some(event =>
      event.type === 'plan/review' && event.data.decision === 'approved' && event.data.correlation === 'call-exit-lifecycle',
    )).toBe(true)
    expect(harness.orc.state(harness.supervisor).approval).toBe('approved')
    expect(harness.fake.continuable).toHaveLength(0)

    await harness.orc.assignTask(harness.supervisor, {
      taskId: TASK,
      writeScope: ['src'],
      acceptanceCriteria: 'parser exists',
    })
    await harness.orc.advance(harness.supervisor, 'task_implementation')
    const leadLaunch = await harness.orc.spawn(harness.supervisor, {
      role: 'lead',
      taskId: TASK,
      prompt: 'lead prompt',
      skillEnvelope: 'superpowers lead',
      writeScope: ['src'],
      acceptanceCriteria: 'parser exists',
      reportingFormat: 'event',
      signal: SIGNAL,
    })
    const lead = harness.ctx.agents.get(SessionId(String(leadLaunch.nodeId)))
    if (lead === undefined || leadLaunch.nodeId === undefined) throw new Error('lead was not admitted')
    await harness.orc.startTask(harness.supervisor, { taskId: TASK, leadNodeId: leadLaunch.nodeId })
    const peerLaunch = await harness.orc.spawn(lead, {
      role: 'peer',
      taskId: TASK,
      prompt: 'peer prompt',
      skillEnvelope: 'superpowers peer',
      writeScope: ['src'],
      acceptanceCriteria: 'parser exists',
      reportingFormat: 'event',
      signal: SIGNAL,
    })
    expect(harness.fake.continuable).toHaveLength(2)
    expect(harness.orc.roleOf(lead)).toBe('lead')
    const peer = harness.ctx.agents.get(SessionId(String(peerLaunch.nodeId)))
    if (peer === undefined) throw new Error('peer was not admitted')
    expect(harness.orc.roleOf(peer)).toBe('peer')
    await expect(harness.orc.spawn(peer, {
      role: 'peer',
      taskId: TASK,
      prompt: 'nested',
      skillEnvelope: 'no',
      writeScope: ['src'],
      acceptanceCriteria: 'no',
      reportingFormat: 'event',
      signal: SIGNAL,
    })).rejects.toThrow(/peer cannot spawn/)

    await harness.orc.recordResult(lead, {
      correlationId: peerLaunch.correlationId,
      stage: 'deepseek-node',
      role: 'peer',
      taskId: TASK,
      outcome: 'settled',
      evidence: 'peer done',
    })
    await harness.orc.recordResult(harness.supervisor, {
      correlationId: leadLaunch.correlationId,
      stage: 'deepseek-node',
      role: 'lead',
      taskId: TASK,
      outcome: 'settled',
      evidence: 'lead done',
    })
    await harness.orc.advance(harness.supervisor, 'task_peer_settlement')
    await harness.orc.settleTask(harness.supervisor, {
      taskId: TASK,
      leadNodeId: leadLaunch.nodeId,
      evidence: 'task done',
    })

    const finding = {
      id: 'finding-1',
      severity: 'high',
      file: 'src/a.ts',
      location: 'src/a.ts:3',
      evidence: 'null',
      remediation: 'check',
      status: 'open',
      summary: 'missing null check',
      sourceStage: 'codex-review',
      taskId: 'task-a',
    }
    harness.fake.queue.push(Promise.resolve(codexText('codex-review', { stage: 'codex-review', findings: [finding] })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-audit', { stage: 'codex-audit', findings: [] })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-review', { stage: 'codex-review', findings: [] })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-audit', { stage: 'codex-audit', findings: [] })))
    const gated = await harness.orc.runTaskLoop(harness.supervisor, SIGNAL)
    expect(harness.fake.sent).toHaveLength(1)
    expect(harness.fake.sent[0]?.targetId).toBe(String(leadLaunch.nodeId))
    expect(harness.fake.sent[0]?.text).toContain('missing null check')
    expect(gated.tasks[0]?.fixDecision).toBe(`fixed ${String(leadLaunch.nodeId)}`)
    expect(gated.phase).toBe('final_review')
    expect(harness.fake.oneShot.map(call => call.name)).toEqual(['codex-spec', 'codex-spec', 'codex-review', 'codex-audit', 'codex-review', 'codex-audit'])

    harness.fake.queue.push(Promise.resolve(codexText('codex-review', {
      stage: 'codex-review',
      findings: [{ ...finding, id: 'finding-branch', sourceStage: 'codex-review', summary: 'branch drift' }],
    })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-audit', { stage: 'codex-audit', findings: [] })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-review', { stage: 'codex-review', findings: [] })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-audit', { stage: 'codex-audit', findings: [] })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-review', { stage: 'codex-review', findings: [] })))
    harness.fake.queue.push(Promise.resolve(codexText('codex-audit', { stage: 'codex-audit', findings: [] })))
    const finalState = await harness.orc.runFinalLoop(harness.supervisor, SIGNAL)
    expect(harness.fake.sent.length).toBeGreaterThan(1)
    expect(harness.fake.sent.at(-1)?.text).toContain('branch drift')
    expect(finalState.phase).toBe('final_review')
    expect(finalState.tasks.every(task => task.phase === 'clean')).toBe(true)
    const visible = (await harness.ctx.systemPrompt.assemble({ scope: scopeOf(harness.supervisor.ctx) })).tools.map(tool => tool.name)
    expect(visible).toContain('orc_run_final_gates')
    expect(visible).toContain('orc_spawn')
  })

  it('keeps dismissed review and a missing question channel from approving', async () => {
    const dismissed = await boot(profileConfig())
    await openWorkflow(dismissed)
    await specAndPlan(dismissed)
    dismissed.ctx.on('user-questions/request', () => Promise.reject(Object.assign(
      new Error('the user cancelled ask_user_question'),
      { name: 'UserQuestionError', code: 'ASK_CANCELLED' },
    )))
    dismissed.ctx.planMode.set(dismissed.supervisor, true)
    const result = await dismissed.ctx.tools.execute({
      callId: ToolCallId('call-exit-dismissed'),
      name: EXIT_PLAN_MODE,
      arguments: { plan: '# Ship the task\n\nImplement the parser.' },
      signal: SIGNAL,
      agent: dismissed.supervisor,
    })
    expect(result.isError).toBe(true)
    await dismissed.orc.planReviewSettled()
    expect(dismissed.orc.state(dismissed.supervisor).approval).toBeUndefined()
    expect(dismissed.fake.continuable).toHaveLength(0)

    const missing = await boot(profileConfig())
    await openWorkflow(missing)
    await specAndPlan(missing)
    missing.ctx.planMode.set(missing.supervisor, true)
    const unloaded = await missing.ctx.tools.execute({
      callId: ToolCallId('call-exit-missing'),
      name: EXIT_PLAN_MODE,
      arguments: { plan: '# Ship the task\n\nImplement the parser.' },
      signal: SIGNAL,
      agent: missing.supervisor,
    })
    expect(unloaded.isError).toBe(true)
    await missing.orc.planReviewSettled()
    expect(missing.supervisor.session.snapshotEvents().some(event => event.type === 'plan/review')).toBe(false)
    expect(missing.orc.state(missing.supervisor).approval).toBeUndefined()
  })
})
