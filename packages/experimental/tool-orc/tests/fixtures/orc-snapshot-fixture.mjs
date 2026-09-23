/** Snapshot stand-in for Codex and the plan-review answer. Product ORC tools stay real. */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'orc-snapshot-fixture'
export const inject = ['subagents', 'orc', 'planMode', 'agents', 'sessions', 'tools', 'userQuestions']

const FINDING = {
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

const QUEUES = {
  'codex-spec': [
    { stage: 'codex-spec', spec: 'design is complete' },
    { stage: 'codex-plan', plan: 'ship the task' },
  ],
  'codex-review': [
    { stage: 'codex-review', findings: [FINDING] },
    { stage: 'codex-review', findings: [] },
    { stage: 'codex-review', findings: [] },
  ],
  'codex-audit': [
    { stage: 'codex-audit', findings: [] },
    { stage: 'codex-audit', findings: [] },
    { stage: 'codex-audit', findings: [] },
  ],
}

function codexProvider(providerName) {
  return {
    name: providerName,
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,
    async start() {
      const body = QUEUES[providerName].shift()
      if (body === undefined) throw new Error(`orc snapshot fixture has no ${providerName} result left`)
      return {
        id: SessionId(randomUUID()),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: JSON.stringify(body) }],
          stopReason: 'completed',
        }),
        dispose: () => Promise.resolve(),
      }
    },
  }
}

/**
 * Wait until the Lead has finished a turn and its Peer row exists.
 * @param ctx - ORC snapshot context.
 * @param caller - Supervisor agent.
 * @returns after the Lead is idle.
 */
/** A parked Lead leaves the agent registry. The parent inbox line is the durable completion mark. */
function leadTurnFinished(caller, leadId) {
  const needle = `Background subagent ${leadId} finished`
  return caller.session.snapshotEvents().some(event => {
    if (event.type !== 'agent/inbox/spliced') return false
    const inserted = event.data?.inserted
    if (!Array.isArray(inserted)) return false
    return inserted.some(message => Array.isArray(message?.content) && message.content.some(part =>
      part?.type === 'text' && typeof part.text === 'string' && part.text.includes(needle)))
  })
}

async function whenLeadReady(ctx, caller) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = ctx.orc.state(caller)
    const lead = state.nodes.find(node => node.role === 'lead')
    const peer = state.delegations.some(item => item.kind === 'deepseek-node' && item.role === 'peer')
    if (lead !== undefined && peer && leadTurnFinished(caller, String(lead.id))) return
    await new Promise(resolve => { setTimeout(resolve, 15) })
  }
  const state = ctx.orc.state(caller)
  const lead = state.nodes.find(node => node.role === 'lead')
  const peer = state.delegations.some(item => item.kind === 'deepseek-node' && item.role === 'peer')
  throw new Error(`orc snapshot lead wait timed out lead=${lead === undefined ? 'missing' : String(lead.id)} peer=${peer}`)
}

/** Peer completion has to land before orc_spawn returns, or the Lead turn races the notice. OrcService commits the node before startContinuable. */
async function peerTurnEnded(ctx, childId) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const session = ctx.sessions.get(childId)
    if (session?.snapshotEvents().some(event => event.type === 'turn/end')) return
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  throw new Error('orc snapshot fixture peer did not finish')
}

export function apply(ctx) {
  for (const providerName of ['codex-spec', 'codex-review', 'codex-audit']) {
    ctx.subagents.registerProvider(codexProvider(providerName))
  }
  const startContinuable = ctx.subagents.startContinuable.bind(ctx.subagents)
  ctx.subagents.startContinuable = async (input) => {
    const started = await startContinuable(input)
    if (input.label === 'peer') await peerTurnEnded(ctx, started.childId)
    return started
  }
  ctx.on('user-questions/request', (request, next) => {
    const question = request.questions?.[0]
    if (question?.id !== 'plan-review') return next()
    return { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
  })
  const enablePlan = (agent) => {
    if ((agent.session.header.delegationDepth ?? 0) !== 0) return
    const outcome = ctx.planMode.set(agent, true)
    if (outcome !== 'committed' && outcome !== 'noop') {
      throw new Error(`orc snapshot fixture did not commit plan mode: ${outcome}`)
    }
  }
  ctx.on('agent/created', ({ agent }) => { enablePlan(agent) })
  for (const agent of ctx.agents.list()) enablePlan(agent)
  ctx.tools.register(defineTool({
    name: 'orc_snapshot_wait',
    description: 'Wait until the current ORC Codex result or Lead turn is durable. This snapshot tool does not approve a plan.',
    parameters: {
      until: { type: 'string', enum: ['codex', 'lead'], description: 'codex waits for an open Codex result. lead waits until the Lead is idle and a Peer exists.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('orc_snapshot_wait requires a calling agent')
      await ctx.orc.planReviewSettled()
      const open = ctx.orc.state(caller).delegations.filter(item =>
        item.status === 'open' && item.kind !== 'deepseek-node')
      for (const delegation of open) await ctx.orc.awaitCodex(caller, delegation.correlationId)
      if (args.until === 'lead') await whenLeadReady(ctx, caller)
      const state = ctx.orc.state(caller)
      const lead = state.nodes.find(node => node.role === 'lead')
      const leadDelegation = state.delegations.find(item => item.kind === 'deepseek-node' && item.role === 'lead')
      const peer = state.delegations.find(item => item.kind === 'deepseek-node' && item.role === 'peer')
      const lines = ['ready']
      if (lead !== undefined) lines.push(`leadNodeId=${String(lead.id)}`)
      if (leadDelegation !== undefined) lines.push(`leadCorrelationId=${String(leadDelegation.correlationId)}`)
      if (peer !== undefined) lines.push(`peerCorrelationId=${String(peer.correlationId)}`)
      return { report: lines.join('\n') }
    },
  }))
}
