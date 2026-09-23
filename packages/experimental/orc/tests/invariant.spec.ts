import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  OrcCorrelationId,
  OrcFindingId,
  OrcNodeId,
  OrcRunId,
  OrcTaskId,
} from '../src/projection.ts'
import type {
  OrcEvent,
  OrcNodeId as OrcNodeIdentity,
  OrcNodeOutcome,
  OrcReportStatus,
  OrcReviewScope,
  OrcSeverity,
  OrcTaskId as OrcTaskIdentity,
  OrcWorkflowPhase,
} from '../src/types.ts'
import * as OrcInvariant from '../src/invariant.ts'

const RUN = OrcRunId('run-1')
const SUPERVISOR = OrcNodeId('supervisor')
const LEAD_A = OrcNodeId('lead-a')
const PEER_A = OrcNodeId('peer-a')
const TASK_A = OrcTaskId('task-a')
const TASK_B = OrcTaskId('task-b')
const BLOCKING = ['critical', 'high', 'medium'] as const

let ctx: Context

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(OrcInvariant)
})

function session(): Session {
  return ctx.sessions.create(SessionId(`orc-invariant-${Math.random().toString(36).slice(2)}`))
}

/** Append one payload through the session log without registering its type on SessionEventMap. */
function appendRaw(target: Session, type: string, data: unknown): void {
  const append = target.append.bind(target) as (type: string, data: unknown) => unknown
  append(type, data)
}

/** Append one ORC event. */
function appendOrc(target: Session, event: OrcEvent): void {
  appendRaw(target, event.type, event.data)
}

function appendAll(target: Session, events: readonly OrcEvent[]): void {
  for (const event of events) appendOrc(target, event)
}

function workflow(): OrcEvent {
  return {
    type: 'orc/workflow/created',
    data: {
      version: 1,
      runId: RUN,
      blockingSeverities: [...BLOCKING],
      supervisorNodeId: SUPERVISOR,
      prompt: 'Supervisor prompt',
      skillEnvelope: 'superpowers',
      writeScope: ['repo'],
      acceptanceCriteria: 'run reaches complete',
      reportingFormat: 'durable events',
    },
  }
}

function specRequested(correlationId = 'corr-spec'): OrcEvent {
  return {
    type: 'orc/spec/requested',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId(correlationId),
      contextRef: 'brainstorm-1',
      role: 'spec-only',
      repositoryPath: '/repo',
      skillRequirements: 'superpowers spec',
      outputSchema: 'spec-and-plan',
      readOnly: true,
    },
  }
}

function specResult(): OrcEvent {
  return {
    type: 'orc/spec/result',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId('corr-spec'),
      status: 'ok',
      specText: 'design spec',
    },
  }
}

function phase(to: OrcWorkflowPhase): OrcEvent {
  return { type: 'orc/phase', data: { version: 1, runId: RUN, to, actorNodeId: SUPERVISOR } }
}

function planRequested(): OrcEvent {
  return {
    type: 'orc/plan/requested',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId('corr-plan'),
      contextRef: 'brainstorm-1',
      role: 'plan-only',
      repositoryPath: '/repo',
      skillRequirements: 'superpowers plan',
      outputSchema: 'plan',
      readOnly: true,
    },
  }
}

function planResult(): OrcEvent {
  return {
    type: 'orc/plan/result',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId('corr-plan'),
      status: 'ok',
      planText: 'implementation plan',
    },
  }
}

function node(role: 'lead' | 'peer', nodeId: OrcNodeIdentity, parentId: OrcNodeIdentity, taskId: OrcTaskIdentity, correlationId: string): OrcEvent {
  return {
    type: 'orc/node/created',
    data: {
      version: 1,
      runId: RUN,
      nodeId,
      parentId,
      role,
      taskId,
      correlationId: OrcCorrelationId(correlationId),
      prompt: `${role} prompt`,
      skillEnvelope: 'superpowers',
      writeScope: ['src'],
      acceptanceCriteria: 'report evidence',
      reportingFormat: 'settlement event',
    },
  }
}

function nodeSettled(nodeId: OrcNodeIdentity, outcome: OrcNodeOutcome, evidence?: string): OrcEvent {
  return {
    type: 'orc/node/settled',
    data: {
      version: 1,
      runId: RUN,
      nodeId,
      outcome,
      ...(evidence === undefined ? {} : { evidence }),
    },
  }
}

function taskAssigned(taskId: OrcTaskIdentity): OrcEvent {
  return {
    type: 'orc/task/assigned',
    data: {
      version: 1,
      runId: RUN,
      taskId,
      writeScope: ['src'],
      acceptanceCriteria: `done ${taskId}`,
    },
  }
}

function throughTaskReview(): OrcEvent[] {
  return [
    workflow(),
    specRequested(),
    phase('spec_required'),
    specResult(),
    planRequested(),
    phase('plan_required'),
    planResult(),
    phase('awaiting_user_approval'),
    { type: 'orc/plan/approval', data: { version: 1, runId: RUN, decision: 'approved', source: 'plan/review', correlation: 'plan-review-1', reviewSeq: 8 } },
    taskAssigned(TASK_A),
    taskAssigned(TASK_B),
    phase('task_implementation'),
    node('lead', LEAD_A, SUPERVISOR, TASK_A, 'corr-lead-a'),
    { type: 'orc/task/started', data: { version: 1, runId: RUN, taskId: TASK_A, leadNodeId: LEAD_A } },
    node('peer', PEER_A, LEAD_A, TASK_A, 'corr-peer-a'),
    nodeSettled(PEER_A, 'settled', 'peer evidence'),
    phase('task_peer_settlement'),
    nodeSettled(LEAD_A, 'settled', 'lead evidence'),
    { type: 'orc/task/settled', data: { version: 1, runId: RUN, taskId: TASK_A, leadNodeId: LEAD_A, evidence: 'settled task-a' } },
    phase('task_review'),
  ]
}

function reportRequested(kind: 'review' | 'audit', correlationId: string, scope: OrcReviewScope, iteration: number): OrcEvent {
  return {
    type: kind === 'review' ? 'orc/review/requested' : 'orc/audit/requested',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId(correlationId),
      scope,
      iteration,
      taskId: TASK_A,
      role: kind === 'review' ? 'review-only' : 'audit-only',
      repositoryPath: '/repo',
      skillRequirements: `superpowers ${kind}`,
      outputSchema: 'findings',
      readOnly: true,
    },
  }
}

function reportResult(
  kind: 'review' | 'audit',
  correlationId: string,
  status: OrcReportStatus,
  findings: readonly { id: string; severity: OrcSeverity; summary: string }[] = [],
): OrcEvent {
  return {
    type: kind === 'review' ? 'orc/review/result' : 'orc/audit/result',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId(correlationId),
      status,
      findings: findings.map(finding => ({ id: OrcFindingId(finding.id), severity: finding.severity, summary: finding.summary })),
    },
  }
}

describe('ORC stream invariant', () => {
  it('rejects a malformed orc payload before publication', () => {
    const current = session()
    expect(() => {
      appendRaw(current, 'orc/workflow/created', { version: 2 })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-experimental-orc',
    }))
    expect(current.snapshotEvents()).toEqual([])
  })

  it('rejects an illegal phase jump and a duplicate correlation id', () => {
    const jumped = session()
    appendOrc(jumped, workflow())
    expect(() => {
      appendOrc(jumped, phase('complete'))
    }).toThrow(/illegal phase jump from brainstorming to complete/)
    expect(jumped.snapshotEvents()).toHaveLength(1)

    const duplicated = session()
    appendAll(duplicated, [workflow(), specRequested()])
    expect(() => {
      appendOrc(duplicated, specRequested())
    }).toThrow(/duplicate correlation id/)
    expect(duplicated.snapshotEvents()).toHaveLength(2)
  })

  it('rejects a missing reviewer or auditor result', () => {
    const missingReview = session()
    appendAll(missingReview, throughTaskReview())
    expect(() => {
      appendOrc(missingReview, phase('task_audit'))
    }).toThrow(/review result is missing/)

    const missingAudit = session()
    appendAll(missingAudit, [
      ...throughTaskReview(),
      reportRequested('review', 'corr-review-a', 'task', 0),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
    ])
    expect(() => {
      appendOrc(missingAudit, phase('next_task'))
    }).toThrow(/audit result is missing/)
  })

  it('rejects advancement while a blocking finding is recorded', () => {
    const current = session()
    appendAll(current, [
      ...throughTaskReview(),
      reportRequested('review', 'corr-review-a', 'task', 0),
      reportResult('review', 'corr-review-a', 'ok', [{ id: 'finding-block', severity: 'medium', summary: 'blocks' }]),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0),
      reportResult('audit', 'corr-audit-a', 'ok'),
    ])
    const committed = current.snapshotEvents().length
    expect(() => {
      appendOrc(current, phase('next_task'))
    }).toThrow(/blocking findings require fix/)
    expect(current.snapshotEvents()).toHaveLength(committed)
  })

  it('rejects a phase append with no actor or a peer actor before publication', () => {
    const missing = session()
    appendAll(missing, [workflow(), specRequested()])
    const kept = missing.snapshotEvents().length
    expect(() => {
      appendRaw(missing, 'orc/phase', { version: 1, runId: RUN, to: 'spec_required' })
    }).toThrow(/phase actor is required/)
    expect(missing.snapshotEvents()).toHaveLength(kept)

    const peer = session()
    appendAll(peer, throughTaskReview().slice(0, -1))
    const peerKept = peer.snapshotEvents().length
    expect(() => {
      appendOrc(peer, {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'task_review', actorNodeId: PEER_A },
      })
    }).toThrow(/peer cannot advance the workflow/)
    expect(peer.snapshotEvents()).toHaveLength(peerKept)
  })

  it('ignores events outside the orc namespace', () => {
    const current = session()
    expect(() => {
      appendRaw(current, 'note/kept', { text: 'not orc' })
    }).not.toThrow()
    expect(current.snapshotEvents()).toHaveLength(1)
  })
})
