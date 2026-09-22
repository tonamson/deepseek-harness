/** Scoped model-facing ORC tools. Schemas are stable; `OrcService` decides what a call may do. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  OrcCorrelationId,
  OrcError,
  OrcFindingId,
  OrcNodeId,
  OrcTaskId,
  type OrcNode,
  type OrcRole,
  type OrcState,
} from '@deepseek-ai/dsh-experimental-orc'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

export { renderCodexEnvelope } from '@deepseek-ai/dsh-experimental-orc'
export type { OrcCodexEnvelopeText } from '@deepseek-ai/dsh-experimental-orc'

/** Cordis plugin name. */
export const name = 'tool-orc'

/** Services required by the ORC tool plugin. */
export const inject = ['agents', 'orc', 'tools', 'systemPrompt']

/** Stable failure class for an ORC tool call. */
export type OrcToolErrorCode = 'ORC_UNAUTHORIZED' | 'ORC_INVALID_INPUT' | 'ORC_REFUSED'

/**
 * Tool failure with a stable code.
 * `code` is {@link OrcToolErrorCode}. `ORC_REFUSED` preserves the service message.
 * The tool does not turn that refusal into success.
 */
export class OrcToolError extends HarnessError {}

/** Inputs for one role section. Phase and task come from the projected run. */
export interface OrcRoleSectionInput {
  readonly role: OrcRole | 'unassigned'
  readonly parentId?: string | undefined
  readonly phase?: string | undefined
  readonly taskId?: string | undefined
}

/** Inputs for a logged DeepSeek child prompt. */
export interface OrcDeepseekPromptInput {
  readonly role: OrcRole
  readonly parentId?: string | undefined
  readonly phase?: string | undefined
  readonly taskId?: string | undefined
  readonly writeScope: readonly string[]
  readonly acceptanceCriteria: string
  readonly reportingFormat: string
  readonly responsibility: string
}

/** Mounted Superpowers catalog named in every DeepSeek child envelope. */
const SUPERPOWERS_SKILL_CATALOG = [
  'using-superpowers',
  'brainstorming',
  'writing-plans',
  'subagent-driven-development',
  'test-driven-development',
  'requesting-code-review',
  'verification-before-completion',
] as const

const MANDATORY_SKILLS: Record<OrcRole, readonly string[]> = {
  supervisor: ['brainstorming', 'writing-plans', 'requesting-code-review', 'verification-before-completion'],
  lead: ['subagent-driven-development', 'test-driven-development', 'verification-before-completion'],
  peer: ['test-driven-development', 'verification-before-completion'],
}

const PHASES = [
  'brainstorming', 'spec_required', 'plan_required', 'awaiting_user_approval',
  'task_implementation', 'task_peer_settlement', 'task_review', 'task_audit', 'task_fix',
  'next_task', 'final_review', 'complete', 'failed',
] as const

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
const STAGES = ['codex-spec', 'codex-plan', 'codex-review', 'codex-audit', 'deepseek-node'] as const
const OUTCOMES = ['settled', 'failed', 'timeout', 'cancelled', 'incomplete'] as const
const REPORT_STATUSES = ['ok', 'failed', 'malformed', 'unavailable'] as const

/** Between TEAM_POLICY (600) and PTC_ONLY (800). No central ORC slot is allocated. */
const ORC_SECTION_ORDER = 650

const LAUNCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    correlationId: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    spawned: { type: 'boolean', required: true },
    nodeId: { type: 'string' },
  },
} as const

const STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    phase: { type: 'string', required: true },
    runId: { type: 'string' },
    approval: { type: 'string', enum: ['approved', 'rejected'] },
    activeTaskId: { type: 'string' },
  },
} as const

/**
 * Declare one canonical output schema and render it as compact JSON.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by `defineTool`.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function authorityOf(role: OrcRole | 'unassigned'): string {
  switch (role) {
    case 'supervisor':
      return 'may create Leads, sequence tasks, invoke Codex spec, review, and audit, and close the run; may not create a Peer'
    case 'lead':
      return 'may create Peers for this task, settle the task, and run focused checks; may not invoke Codex or create a Lead'
    case 'peer':
      return 'may perform the assigned responsibility and report evidence; may not create children, invoke Codex, approve a plan, skip review or audit, or advance the workflow'
    case 'unassigned':
      return 'may open the ORC workflow; may not spawn, approve a plan, or advance'
    default: {
      const unreachable: never = role
      return unreachable
    }
  }
}

function superpowersWorkflow(role: OrcRole): string {
  return [
    'Superpowers workflow requirements: use the mounted Superpowers skill catalog.',
    `skillCatalog: ${SUPERPOWERS_SKILL_CATALOG.join(', ')}`,
    `mandatory Superpowers skills: ${MANDATORY_SKILLS[role].join(', ')}`,
  ].join('\n')
}

/**
 * Render the role section a DeepSeek agent sees.
 * @param input - role, parent, phase, and task copied from the projected run.
 * @returns the section text. It does not grant authority.
 */
export function renderRoleSection(input: OrcRoleSectionInput): string {
  const mandatory = input.role === 'unassigned' ? 'none' : MANDATORY_SKILLS[input.role].join(', ')
  return [
    `role: ${input.role}`,
    `parent: ${input.parentId ?? 'none'}`,
    `authority: ${authorityOf(input.role)}`,
    `phase: ${input.phase ?? 'none'}`,
    `task: ${input.taskId ?? 'none'}`,
    `mandatory Superpowers skills: ${mandatory}`,
  ].join('\n')
}

/**
 * Render the logged prompt and skill envelope for a DeepSeek child.
 * @param input - role, task, scope, and the caller-supplied responsibility.
 * @returns the two strings `spawn` and `createWorkflow` persist.
 */
export function renderDeepseekChildPrompt(input: OrcDeepseekPromptInput): {
  readonly prompt: string
  readonly skillEnvelope: string
} {
  return {
    prompt: [
      renderRoleSection({
        role: input.role,
        parentId: input.parentId,
        phase: input.phase,
        taskId: input.taskId,
      }),
      `writeScope: ${input.writeScope.join(', ')}`,
      `acceptanceCriteria: ${input.acceptanceCriteria}`,
      `reportingFormat: ${input.reportingFormat}`,
      `responsibility: ${input.responsibility}`,
    ].join('\n'),
    skillEnvelope: superpowersWorkflow(input.role),
  }
}

function requiredText(value: string, label: string): string {
  const text = value.trim()
  if (text.length === 0) throw new OrcToolError(`${label} is empty`, 'ORC_INVALID_INPUT')
  return text
}

function requiredList(values: readonly string[], label: string): string[] {
  if (values.length === 0) throw new OrcToolError(`${label} is empty`, 'ORC_INVALID_INPUT')
  return values.map((value, index) => requiredText(value, `${label}[${String(index)}]`))
}

async function refused<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof OrcError) throw new OrcToolError(error.message, 'ORC_REFUSED', { cause: error })
    throw error
  }
}

function requireAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next -- ORC tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new OrcToolError(`${toolName} requires a calling Agent`, 'ORC_INVALID_INPUT')
  return agent
}

function stateView(state: OrcState): InferValue<typeof STATE_SCHEMA> {
  return {
    phase: state.phase ?? 'none',
    ...(state.runId === undefined ? {} : { runId: String(state.runId) }),
    ...(state.approval === undefined ? {} : { approval: state.approval }),
    ...(state.activeTaskId === undefined ? {} : { activeTaskId: String(state.activeTaskId) }),
  }
}

function launchView(launch: { correlationId: string; kind: string; spawned: boolean; nodeId?: string }): InferValue<typeof LAUNCH_SCHEMA> {
  return {
    correlationId: launch.correlationId,
    kind: launch.kind,
    spawned: launch.spawned,
    ...(launch.nodeId === undefined ? {} : { nodeId: launch.nodeId }),
  }
}

function agentOf(context: AssembleContext): Agent | undefined {
  const scope = context.scope
  if (typeof scope === 'object' && 'session' in scope && 'id' in scope) return scope as Agent
  return undefined
}

/** Register the complete ORC catalog in one exact Agent scope. */
function install(agent: Agent, ctx: Context): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  const requireSupervisor = (caller: Agent, action: string): void => {
    const role = ctx.orc.roleOf(caller) ?? 'unassigned'
    if (role !== 'supervisor') throw new OrcToolError(`${role} cannot ${action}`, 'ORC_UNAUTHORIZED')
  }
  const nodeOf = (caller: Agent): OrcNode | undefined => {
    return ctx.orc.state(caller).nodes.find(node => String(node.id) === String(caller.id))
  }
  const leadNodeIdFor = (caller: Agent, requested: string | undefined): string => {
    const role = ctx.orc.roleOf(caller) ?? 'unassigned'
    if (role === 'peer' || role === 'unassigned') {
      throw new OrcToolError(`${role} cannot settle a task`, 'ORC_UNAUTHORIZED')
    }
    if (role === 'lead') {
      if (requested !== undefined && requested !== caller.id) {
        throw new OrcToolError('lead cannot settle another task', 'ORC_UNAUTHORIZED')
      }
      return caller.id
    }
    if (requested === undefined) throw new OrcToolError('lead node id is empty', 'ORC_INVALID_INPUT')
    return requiredText(requested, 'lead node id')
  }
  const bindResult = (caller: Agent, correlationId: string, taskId: string | undefined): void => {
    const role = ctx.orc.roleOf(caller) ?? 'unassigned'
    if (role === 'unassigned') throw new OrcToolError('unassigned cannot record a result', 'ORC_UNAUTHORIZED')
    if (role === 'supervisor') return
    const node = nodeOf(caller)
    if (node === undefined) throw new OrcToolError('caller is not an ORC node', 'ORC_UNAUTHORIZED')
    if (taskId !== undefined && node.taskId !== undefined && taskId !== String(node.taskId)) {
      throw new OrcToolError('caller cannot record another task', 'ORC_UNAUTHORIZED')
    }
    if (role === 'peer' && String(node.correlationId) !== correlationId) {
      throw new OrcToolError('peer cannot record another task result', 'ORC_UNAUTHORIZED')
    }
    if (role === 'lead') {
      const target = ctx.orc.state(caller).nodes.find(item => String(item.correlationId) === correlationId)
      if (target === undefined || (String(target.id) !== String(node.id) && String(target.parentId) !== String(node.id))) {
        throw new OrcToolError('lead cannot record another task result', 'ORC_UNAUTHORIZED')
      }
    }
  }
  try {
    register(scoped.systemPrompt.section({
      name: 'orc:role',
      order: ORC_SECTION_ORDER,
      interpolate: false,
      text(context) {
        const caller = agentOf(context)
        const role = caller === undefined ? 'unassigned' : ctx.orc.roleOf(caller) ?? 'unassigned'
        const state = caller === undefined ? undefined : ctx.orc.state(caller)
        const node = state?.nodes.find(item => caller !== undefined && String(item.id) === String(caller.id))
        const taskId = node?.taskId ?? state?.activeTaskId ?? state?.tasks[0]?.id
        const workflow = role === 'unassigned'
          ? 'Superpowers workflow requirements apply when the workflow opens.'
          : superpowersWorkflow(role)
        const logged = node?.skillEnvelope
        return [
          renderRoleSection({
            role,
            parentId: node?.parentId,
            phase: state?.phase,
            taskId: taskId === undefined ? undefined : String(taskId),
          }),
          workflow,
          ...(logged !== undefined && logged !== workflow ? [logged] : []),
        ].join('\n')
      },
    }))

    register(scoped.tools.register(defineTool({
      name: 'orc_create_workflow',
      description: 'Open the ORC workflow on this agent. Does not approve a plan or start implementation.',
      parameters: {
        responsibility: { type: 'string', required: true, description: 'Brainstorm or task context recorded in the Supervisor prompt.' },
        write_scope: { type: 'array', required: true, items: { type: 'string' }, description: 'Repository paths the run may write.' },
        acceptance_criteria: { type: 'string', required: true, description: 'How the run is accepted.' },
        reporting_format: { type: 'string', required: true, description: 'How children report results.' },
        blocking_severities: {
          type: 'array',
          required: true,
          items: { type: 'string', enum: SEVERITIES },
          description: 'Severities that block progress. The service rejects a set that omits critical, high, and medium.',
        },
      },
      output: jsonOutput(STATE_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_create_workflow')
        const role = ctx.orc.roleOf(caller)
        if (role === 'lead' || role === 'peer') throw new OrcToolError(`${role} cannot open a workflow`, 'ORC_UNAUTHORIZED')
        const writeScope = requiredList(args.write_scope, 'write scope')
        const rendered = renderDeepseekChildPrompt({
          role: 'supervisor',
          phase: 'brainstorming',
          writeScope,
          acceptanceCriteria: requiredText(args.acceptance_criteria, 'acceptance criteria'),
          reportingFormat: requiredText(args.reporting_format, 'reporting format'),
          responsibility: requiredText(args.responsibility, 'responsibility'),
        })
        const state = await refused(() => ctx.orc.createWorkflow(caller, {
          prompt: rendered.prompt,
          skillEnvelope: rendered.skillEnvelope,
          writeScope,
          acceptanceCriteria: requiredText(args.acceptance_criteria, 'acceptance criteria'),
          reportingFormat: requiredText(args.reporting_format, 'reporting format'),
          blockingSeverities: args.blocking_severities,
        }))
        return stateView(state)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'orc_request_spec_plan',
      description: 'Start the next Codex spec or plan run. This is the only transition into spec_required or plan_required. Only the Supervisor may call this.',
      parameters: {
        context_ref: {
          type: 'string',
          required: true,
          description: 'Completed brainstorm or context reference. Prompt text cannot replace this argument.',
        },
      },
      output: jsonOutput(LAUNCH_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_request_spec_plan')
        requireSupervisor(caller, 'invoke Codex')
        const launch = await refused(() => ctx.orc.startSpecPlan(
          caller,
          requiredText(args.context_ref, 'context reference'),
          exec.signal,
        ))
        return launchView({
          correlationId: String(launch.correlationId),
          kind: launch.kind,
          spawned: launch.spawned,
          ...(launch.nodeId === undefined ? {} : { nodeId: String(launch.nodeId) }),
        })
      },
    })))

    const registerLoop = (toolName: 'orc_run_task_gates' | 'orc_run_final_gates', description: string): void => {
      register(scoped.tools.register(defineTool({
        name: toolName,
        description,
        parameters: {},
        output: jsonOutput(STATE_SCHEMA),
        async execute(_args, exec) {
          const caller = requireAgent(exec.agent, toolName)
          requireSupervisor(caller, 'invoke Codex')
          const state = await refused(() => toolName === 'orc_run_task_gates'
            ? ctx.orc.runTaskLoop(caller, exec.signal)
            : ctx.orc.runFinalLoop(caller, exec.signal))
          return stateView(state)
        },
      })))
    }
    registerLoop('orc_run_task_gates', 'Run task review, task audit, and the existing Lead fix until both gates are clean or one result blocks. Only the Supervisor may call this.')
    registerLoop('orc_run_final_gates', 'Run branch review and branch audit. A blocking finding is sent to that task Lead. Only the Supervisor may call this.')

    register(scoped.tools.register(defineTool({
      name: 'orc_assign_task',
      description: 'Assign one implementation task. Only the Supervisor may call this.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Stable task id.' },
        write_scope: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths this task may write.' },
        acceptance_criteria: { type: 'string', required: true, description: 'How this task is accepted.' },
      },
      output: jsonOutput(STATE_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_assign_task')
        requireSupervisor(caller, 'assign a task')
        const state = await refused(() => ctx.orc.assignTask(caller, {
          taskId: OrcTaskId(requiredText(args.task_id, 'task id')),
          writeScope: requiredList(args.write_scope, 'write scope'),
          acceptanceCriteria: requiredText(args.acceptance_criteria, 'acceptance criteria'),
        }))
        return stateView(state)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'orc_spawn',
      description: 'Create one Lead or Peer for a task. The service allows only Supervisor to Lead and Lead to Peer.',
      parameters: {
        role: { type: 'string', required: true, enum: ['lead', 'peer'], description: 'Child role.' },
        task_id: { type: 'string', required: true, description: 'Task the child works on.' },
        responsibility: { type: 'string', required: true, description: 'Bounded responsibility recorded in the child prompt.' },
        write_scope: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths the child may write.' },
        acceptance_criteria: { type: 'string', required: true, description: 'How the child is accepted.' },
        reporting_format: { type: 'string', required: true, description: 'How the child reports evidence.' },
      },
      output: jsonOutput(LAUNCH_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_spawn')
        const state = ctx.orc.state(caller)
        const writeScope = requiredList(args.write_scope, 'write scope')
        const taskId = requiredText(args.task_id, 'task id')
        const rendered = renderDeepseekChildPrompt({
          role: args.role,
          parentId: caller.id,
          phase: state.phase,
          taskId,
          writeScope,
          acceptanceCriteria: requiredText(args.acceptance_criteria, 'acceptance criteria'),
          reportingFormat: requiredText(args.reporting_format, 'reporting format'),
          responsibility: requiredText(args.responsibility, 'responsibility'),
        })
        const launch = await refused(() => ctx.orc.spawn(caller, {
          role: args.role,
          taskId: OrcTaskId(taskId),
          prompt: rendered.prompt,
          skillEnvelope: rendered.skillEnvelope,
          writeScope,
          acceptanceCriteria: requiredText(args.acceptance_criteria, 'acceptance criteria'),
          reportingFormat: requiredText(args.reporting_format, 'reporting format'),
          signal: exec.signal,
        }))
        return launchView({
          correlationId: String(launch.correlationId),
          kind: launch.kind,
          spawned: launch.spawned,
          ...(launch.nodeId === undefined ? {} : { nodeId: String(launch.nodeId) }),
        })
      },
    })))

    const registerLeadTask = (toolName: 'orc_start_task' | 'orc_settle_task', description: string, evidence: boolean): void => {
      register(scoped.tools.register(defineTool({
        name: toolName,
        description,
        parameters: {
          task_id: { type: 'string', required: true, description: 'Task id.' },
          lead_node_id: { type: 'string', description: 'Lead node id. A Lead caller may omit it. A Peer cannot name another Lead.' },
          ...(evidence ? { evidence: { type: 'string', required: true, description: 'Settlement evidence.' } } : {}),
        },
        output: jsonOutput(STATE_SCHEMA),
        async execute(args, exec) {
          const caller = requireAgent(exec.agent, toolName)
          const taskId = OrcTaskId(requiredText(args.task_id, 'task id'))
          const leadNodeId = OrcNodeId(leadNodeIdFor(caller, args.lead_node_id))
          const state = await refused(() => evidence
            ? ctx.orc.settleTask(caller, { taskId, leadNodeId, evidence: requiredText(args.evidence ?? '', 'evidence') })
            : ctx.orc.startTask(caller, { taskId, leadNodeId }))
          return stateView(state)
        },
      })))
    }
    registerLeadTask('orc_start_task', 'Record that the named Lead started the task.', false)
    registerLeadTask('orc_settle_task', 'Record Lead settlement for the task.', true)

    const registerReport = (toolName: 'orc_request_review' | 'orc_request_audit'): void => {
      register(scoped.tools.register(defineTool({
        name: toolName,
        description: toolName === 'orc_request_review'
          ? 'Open a Codex review. Review does not include audit. Only the Supervisor may call this.'
          : 'Open a Codex audit. Audit does not include review. Only the Supervisor may call this.',
        parameters: {
          scope: { type: 'string', required: true, enum: ['task', 'branch'], description: 'Task review or final branch review.' },
          task_id: { type: 'string', description: 'Active task id. Omit for a branch run.' },
        },
        output: jsonOutput(LAUNCH_SCHEMA),
        async execute(args, exec) {
          const caller = requireAgent(exec.agent, toolName)
          requireSupervisor(caller, 'invoke Codex')
          const taskId = args.task_id === undefined ? undefined : OrcTaskId(requiredText(args.task_id, 'task id'))
          const input = { scope: args.scope, signal: exec.signal, ...(taskId === undefined ? {} : { taskId }) }
          const launch = await refused(() => toolName === 'orc_request_review'
            ? ctx.orc.requestReview(caller, input)
            : ctx.orc.requestAudit(caller, input))
          return launchView({
            correlationId: String(launch.correlationId),
            kind: launch.kind,
            spawned: launch.spawned,
            ...(launch.nodeId === undefined ? {} : { nodeId: String(launch.nodeId) }),
          })
        },
      })))
    }
    registerReport('orc_request_review')
    registerReport('orc_request_audit')

    register(scoped.tools.register(defineTool({
      name: 'orc_record_result',
      description: 'Record a DeepSeek node result. A Peer may record only its own run. A Lead may record itself or its children. Codex results are not accepted.',
      parameters: {
        correlation_id: { type: 'string', required: true, description: 'Delegation correlation id.' },
        stage: { type: 'string', required: true, enum: STAGES, description: 'Delegated stage.' },
        delegation_role: { type: 'string', required: true, description: 'Role stored on the delegation.' },
        task_id: { type: 'string', description: 'Task id when the delegation has one.' },
        status: { type: 'string', enum: REPORT_STATUSES, description: 'Codex report status.' },
        text: { type: 'string', description: 'Spec or plan text.' },
        outcome: { type: 'string', enum: OUTCOMES, description: 'DeepSeek node outcome.' },
        evidence: { type: 'string', description: 'Evidence for a node outcome.' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              severity: { type: 'string', required: true, enum: SEVERITIES },
              summary: { type: 'string', required: true },
              task_id: { type: 'string' },
            },
          },
          description: 'Review or audit findings. Do not treat a missing result as an empty list.',
        },
      },
      output: jsonOutput(STATE_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_record_result')
        if (args.stage !== 'deepseek-node') throw new OrcToolError('cannot record a codex result', 'ORC_UNAUTHORIZED')
        const correlationId = requiredText(args.correlation_id, 'correlation id')
        const taskId = args.task_id === undefined ? undefined : requiredText(args.task_id, 'task id')
        bindResult(caller, correlationId, taskId)
        const findings = args.findings?.map(finding => ({
          id: OrcFindingId(requiredText(finding.id, 'finding id')),
          severity: finding.severity,
          summary: requiredText(finding.summary, 'finding summary'),
          ...(finding.task_id === undefined ? {} : { taskId: OrcTaskId(requiredText(finding.task_id, 'finding task id')) }),
        }))
        const state = await refused(() => ctx.orc.recordResult(caller, {
          correlationId: OrcCorrelationId(correlationId),
          stage: args.stage,
          role: requiredText(args.delegation_role, 'delegation role'),
          ...(taskId === undefined ? {} : { taskId: OrcTaskId(taskId) }),
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.text === undefined ? {} : { text: args.text }),
          ...(args.outcome === undefined ? {} : { outcome: args.outcome }),
          ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
          ...(findings === undefined ? {} : { findings }),
        }))
        return stateView(state)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'orc_record_fix',
      description: 'Record the fix decision for the active task. A Peer cannot call this.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Task id.' },
        iteration: { type: 'integer', required: true, description: 'Next fix iteration.' },
        decision: { type: 'string', required: true, description: 'Fix decision text.' },
        assignee_node_id: { type: 'string', description: 'Optional node assigned the fix.' },
      },
      output: jsonOutput(STATE_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_record_fix')
        const taskId = requiredText(args.task_id, 'task id')
        const role = ctx.orc.roleOf(caller) ?? 'unassigned'
        if (role === 'peer' || role === 'unassigned') throw new OrcToolError(`${role} cannot record a fix`, 'ORC_UNAUTHORIZED')
        if (role === 'lead' && String(nodeOf(caller)?.taskId) !== taskId) {
          throw new OrcToolError('lead cannot record a fix for another task', 'ORC_UNAUTHORIZED')
        }
        const assignee = args.assignee_node_id === undefined ? undefined : OrcNodeId(requiredText(args.assignee_node_id, 'assignee node id'))
        const state = await refused(() => ctx.orc.recordFix(caller, {
          taskId: OrcTaskId(taskId),
          iteration: args.iteration,
          decision: requiredText(args.decision, 'decision'),
          ...(assignee === undefined ? {} : { assigneeNodeId: assignee }),
        }))
        return stateView(state)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'orc_advance',
      description: 'Advance the workflow. A Peer cannot advance. A Lead cannot take a Supervisor edge or name another task.',
      parameters: {
        to: { type: 'string', required: true, enum: PHASES, description: 'Requested phase.' },
        task_id: { type: 'string', description: 'Task id when the edge names one.' },
      },
      output: jsonOutput(STATE_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_advance')
        const taskId = args.task_id === undefined ? undefined : requiredText(args.task_id, 'task id')
        const role = ctx.orc.roleOf(caller) ?? 'unassigned'
        if (taskId !== undefined && role !== 'supervisor' && String(nodeOf(caller)?.taskId) !== taskId) {
          throw new OrcToolError('caller cannot advance another task', 'ORC_UNAUTHORIZED')
        }
        const state = await refused(() => ctx.orc.advance(caller, args.to, taskId === undefined ? undefined : OrcTaskId(taskId)))
        return stateView(state)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'orc_fail',
      description: 'Record terminal failure. Only the Supervisor actor is accepted by the service.',
      parameters: {
        reason: { type: 'string', required: true, description: 'Durable failure text.' },
      },
      output: jsonOutput(STATE_SCHEMA),
      async execute(args, exec) {
        const caller = requireAgent(exec.agent, 'orc_fail')
        const state = await refused(() => ctx.orc.fail(caller, requiredText(args.reason, 'reason')))
        return stateView(state)
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/**
 * Install the ORC catalog on every live agent and on agents published later.
 * @param ctx - context with agents, orc, tools, and systemPrompt.
 * @returns nothing. Disposal removes the scoped registrations.
 */
export function apply(ctx: Context): void {
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent)) return
    installed.set(agent, install(agent, ctx))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-orc.scopedTools()')
}
