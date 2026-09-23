import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyOrc, emptyOrcState, projectOrc } from '../src/projection.ts'
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
  OrcState,
  OrcTaskId as OrcTaskIdentity,
  OrcWorkflowPhase,
} from '../src/types.ts'

const RUN = OrcRunId('run-1')
const SUPERVISOR = OrcNodeId('supervisor')
const LEAD_A = OrcNodeId('lead-a')
const PEER_A = OrcNodeId('peer-a')
const TASK_A = OrcTaskId('task-a')
const TASK_B = OrcTaskId('task-b')

const BLOCKING = ['critical', 'high', 'medium'] as const

function replay(events: readonly OrcEvent[]): OrcState {
  const state = projectOrc(events)
  if (state.failure !== undefined) throw new Error(state.failure)
  return state
}

function failure(events: readonly OrcEvent[]): string {
  const state = events.reduce(applyOrc, emptyOrcState())
  if (state.failure === undefined) throw new Error('expected the ORC projection to refuse the stream')
  return state.failure
}

function workflow(blocking: readonly OrcSeverity[] = BLOCKING): OrcEvent {
  return {
    type: 'orc/workflow/created',
    data: {
      version: 1,
      runId: RUN,
      blockingSeverities: [...blocking],
      supervisorNodeId: SUPERVISOR,
      prompt: 'Supervisor prompt',
      skillEnvelope: 'superpowers',
      writeScope: ['repo'],
      acceptanceCriteria: 'run reaches complete',
      reportingFormat: 'durable events',
    },
  }
}

function specRequested(): OrcEvent {
  return {
    type: 'orc/spec/requested',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId('corr-spec'),
      contextRef: 'brainstorm-1',
      role: 'spec-only',
      repositoryPath: '/repo',
      skillRequirements: 'superpowers spec',
      outputSchema: 'spec-and-plan',
      readOnly: true,
    },
  }
}

function specResult(status: OrcReportStatus = 'ok'): OrcEvent {
  return {
    type: 'orc/spec/result',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId('corr-spec'),
      status,
      ...(status === 'ok' ? { specText: 'design spec' } : {}),
    },
  }
}

function phase(to: OrcWorkflowPhase, taskId?: OrcTaskIdentity, actorNodeId: OrcNodeIdentity = SUPERVISOR): OrcEvent {
  return {
    type: 'orc/phase',
    data: {
      version: 1,
      runId: RUN,
      to,
      actorNodeId,
      ...(taskId === undefined ? {} : { taskId }),
    },
  }
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

function approval(decision: 'approved' | 'rejected'): OrcEvent {
  return {
    type: 'orc/plan/approval',
    data: { version: 1, runId: RUN, decision, source: 'plan/review', correlation: 'plan-review-1', reviewSeq: 8 },
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

function taskStarted(taskId: OrcTaskIdentity, leadNodeId: OrcNodeIdentity): OrcEvent {
  return {
    type: 'orc/task/started',
    data: { version: 1, runId: RUN, taskId, leadNodeId },
  }
}

function throughAwaiting(blocking: readonly OrcSeverity[] = BLOCKING): OrcEvent[] {
  return [
    workflow(blocking),
    specRequested(),
    phase('spec_required'),
    specResult(),
    planRequested(),
    phase('plan_required'),
    planResult(),
    phase('awaiting_user_approval'),
  ]
}

/** Legal prefix through the first Peer under the only Supervisor → Lead edge. */
function eventsThroughPeer(): OrcEvent[] {
  return [
    ...throughAwaiting(),
    approval('approved'),
    taskAssigned(TASK_A),
    taskAssigned(TASK_B),
    phase('task_implementation'),
    node('lead', LEAD_A, SUPERVISOR, TASK_A, 'corr-lead-a'),
    taskStarted(TASK_A, LEAD_A),
    node('peer', PEER_A, LEAD_A, TASK_A, 'corr-peer-a'),
  ]
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

function taskSettled(taskId: OrcTaskIdentity, leadNodeId: OrcNodeIdentity): OrcEvent {
  return {
    type: 'orc/task/settled',
    data: { version: 1, runId: RUN, taskId, leadNodeId, evidence: `settled ${taskId}` },
  }
}

function reportRequested(
  kind: 'review' | 'audit',
  correlationId: string,
  scope: OrcReviewScope,
  iteration: number,
  taskId?: OrcTaskIdentity,
): OrcEvent {
  return {
    type: kind === 'review' ? 'orc/review/requested' : 'orc/audit/requested',
    data: {
      version: 1,
      runId: RUN,
      correlationId: OrcCorrelationId(correlationId),
      scope,
      iteration,
      role: kind === 'review' ? 'review-only' : 'audit-only',
      repositoryPath: '/repo',
      skillRequirements: `superpowers ${kind}`,
      outputSchema: 'findings',
      readOnly: true,
      ...(taskId === undefined ? {} : { taskId }),
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
      findings: findings.map(finding => ({
        id: OrcFindingId(finding.id),
        severity: finding.severity,
        summary: finding.summary,
      })),
    },
  }
}

function fixIteration(taskId: OrcTaskIdentity, iteration: number): OrcEvent {
  return {
    type: 'orc/fix/iteration',
    data: {
      version: 1,
      runId: RUN,
      taskId,
      iteration,
      decision: `fix ${taskId} iteration ${iteration}`,
    },
  }
}

function runFailed(reason: string, actorNodeId: OrcNodeIdentity = SUPERVISOR): OrcEvent {
  return { type: 'orc/run/failed', data: { version: 1, runId: RUN, actorNodeId, reason } }
}

function runCompleted(actorNodeId: OrcNodeIdentity = SUPERVISOR): OrcEvent {
  return { type: 'orc/run/completed', data: { version: 1, runId: RUN, actorNodeId } }
}

/** One task through Lead and Peer settlement and into review. */
function throughTaskReview(blocking: readonly OrcSeverity[] = BLOCKING, secondTask = true): OrcEvent[] {
  return [
    ...throughAwaiting(blocking),
    approval('approved'),
    taskAssigned(TASK_A),
    ...(secondTask ? [taskAssigned(TASK_B)] : []),
    phase('task_implementation'),
    node('lead', LEAD_A, SUPERVISOR, TASK_A, 'corr-lead-a'),
    taskStarted(TASK_A, LEAD_A),
    node('peer', PEER_A, LEAD_A, TASK_A, 'corr-peer-a'),
    nodeSettled(PEER_A, 'settled', 'peer evidence'),
    phase('task_peer_settlement'),
    nodeSettled(LEAD_A, 'settled', 'lead evidence'),
    taskSettled(TASK_A, LEAD_A),
    phase('task_review'),
  ]
}

describe('ORC finding identity', () => {
  it('keeps the same id separate across tasks and inferred report stages', () => {
    const state = replay([
      ...throughTaskReview(),
      reportRequested('review', 'rev-a', 'task', 0, TASK_A),
      reportResult('review', 'rev-a', 'ok', [{ id: 'shared', severity: 'low', summary: 'review a' }]),
      phase('task_audit'),
      reportRequested('audit', 'aud-a', 'task', 0, TASK_A),
      reportResult('audit', 'aud-a', 'ok', [{ id: 'shared', severity: 'low', summary: 'audit a' }]),
      phase('next_task'),
      phase('task_implementation'),
      node('lead', OrcNodeId('lead-b'), SUPERVISOR, TASK_B, 'corr-lead-b'),
      taskStarted(TASK_B, OrcNodeId('lead-b')),
      node('peer', OrcNodeId('peer-b'), OrcNodeId('lead-b'), TASK_B, 'corr-peer-b'),
      nodeSettled(OrcNodeId('peer-b'), 'settled', 'peer b'),
      phase('task_peer_settlement'),
      nodeSettled(OrcNodeId('lead-b'), 'settled', 'lead b'),
      taskSettled(TASK_B, OrcNodeId('lead-b')),
      phase('task_review'),
      reportRequested('review', 'rev-b', 'task', 0, TASK_B),
      reportResult('review', 'rev-b', 'ok', [{ id: 'shared', severity: 'low', summary: 'review b' }]),
    ])
    expect(state.findings.map(item => [item.summary, item.taskId, item.correlationId])).toEqual([
      ['review a', TASK_A, OrcCorrelationId('rev-a')],
      ['audit a', TASK_A, OrcCorrelationId('aud-a')],
      ['review b', TASK_B, OrcCorrelationId('rev-b')],
    ])
  })

  it('reopens the same finding id on a later review and still refuses it twice in one report', () => {
    const repeated = replay([
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'rev-1', 'task', 0, TASK_A),
      reportResult('review', 'rev-1', 'ok', [{ id: 'finding-1', severity: 'high', summary: 'bounds' }]),
      phase('task_audit'),
      reportRequested('audit', 'aud-1', 'task', 0, TASK_A),
      reportResult('audit', 'aud-1', 'ok', []),
      phase('task_fix'),
      fixIteration(TASK_A, 1),
      phase('task_review'),
      reportRequested('review', 'rev-2', 'task', 1, TASK_A),
      reportResult('review', 'rev-2', 'ok', [{ id: 'finding-1', severity: 'high', summary: 'still bounds' }]),
    ])
    expect(repeated.findings).toHaveLength(1)
    expect(repeated.findings[0]).toMatchObject({
      summary: 'still bounds',
      status: 'open',
      correlationId: OrcCorrelationId('rev-2'),
      iteration: 1,
    })
    expect(repeated.delegations.filter(item => item.kind === 'codex-review').map(item => item.status)).toEqual(['ok', 'ok'])
    expect(failure([
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'rev-1', 'task', 0, TASK_A),
      reportResult('review', 'rev-1', 'ok', [
        { id: 'finding-1', severity: 'high', summary: 'bounds' },
        { id: 'finding-1', severity: 'high', summary: 'again' },
      ]),
    ])).toMatch(/duplicate finding id/)
  })
})

describe('ORC role edges', () => {
  it('projects the first supervisor root', () => {
    const state = replay([workflow()])
    expect(state.phase).toBe('brainstorming')
    expect(state.runId).toBe(RUN)
    expect(state.nodes[0]).toMatchObject({
      id: SUPERVISOR,
      role: 'supervisor',
      phase: 'active',
    })
    expect(state.nodes[0]?.parentId).toBeUndefined()
  })

  it('accepts only the supervisor to lead and lead to peer edges', () => {
    const state = replay(eventsThroughPeer())
    expect(state.nodes.map(item => [item.role, item.parentId])).toEqual([
      ['supervisor', undefined],
      ['lead', SUPERVISOR],
      ['peer', LEAD_A],
    ])
  })

  it('rejects a lead before the supervisor root', () => {
    expect(failure([node('lead', LEAD_A, SUPERVISOR, TASK_A, 'corr-lead-a')]))
      .toMatch(/supervisor root is required/)
  })

  it('rejects a supervisor to peer edge', () => {
    const prefix = eventsThroughPeer().slice(0, -1)
    expect(failure([...prefix, node('peer', PEER_A, SUPERVISOR, TASK_A, 'corr-peer-a')]))
      .toMatch(/supervisor cannot create a peer/)
  })

  it('rejects a peer child', () => {
    expect(failure([
      ...eventsThroughPeer(),
      node('peer', OrcNodeId('peer-b'), PEER_A, TASK_A, 'corr-peer-b'),
    ])).toMatch(/peer cannot spawn a child/)
  })

  it('records messageId on the open node without adding a second node', () => {
    const created = node('lead', LEAD_A, SUPERVISOR, TASK_A, 'corr-lead-a')
    const state = replay([
      ...throughAwaiting(),
      approval('approved'),
      taskAssigned(TASK_A),
      phase('task_implementation'),
      created,
      { ...created, data: { ...created.data, messageId: 'msg-1' } },
    ])
    expect(state.nodes.filter(item => item.id === LEAD_A)).toHaveLength(1)
    expect(state.delegations.find(item => item.nodeId === LEAD_A)?.messageId).toBe('msg-1')
    expect(failure([
      ...throughAwaiting(),
      approval('approved'),
      taskAssigned(TASK_A),
      phase('task_implementation'),
      created,
      created,
    ])).toMatch(/node already exists/)
  })

  it('does not depend on team events', () => {
    const source = ['../src/projection.ts', '../src/types.ts', '../src/index.ts', '../package.json']
      .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')
    expect(source).not.toMatch(/team\//)
    expect(source).not.toContain('agent-team')
    expect(source).not.toContain('deepseek-flash')
    expect(source).not.toContain('gpt-5.6')
  })
})

describe('ORC transition gates', () => {
  it('requires explicit plan approval before implementation', () => {
    const events = [...throughAwaiting(), phase('task_implementation')]
    const state = events.reduce(applyOrc, emptyOrcState())
    expect(state.failure).toMatch(/plan approval is required before implementation/)
    expect(state.phase).toBe('awaiting_user_approval')
  })

  it('lets a later approved review replace a rejection', () => {
    const rejected = projectOrc([
      ...throughAwaiting(),
      approval('rejected'),
    ])
    expect(rejected.approval).toBe('rejected')
    const replaced = projectOrc([
      ...throughAwaiting(),
      approval('rejected'),
      {
        type: 'orc/plan/approval',
        data: {
          version: 1,
          runId: RUN,
          decision: 'approved',
          source: 'plan/review',
          correlation: 'plan-review-2',
          reviewSeq: 9,
        },
      },
    ])
    expect(replaced.failure).toBeUndefined()
    expect(replaced.approval).toBe('approved')
    expect(replaced.approvalCorrelation).toBe('plan-review-2')
    expect(replaced.approvalReviewSeq).toBe(9)
    const stale = projectOrc([
      ...throughAwaiting(),
      approval('rejected'),
      {
        type: 'orc/plan/approval',
        data: {
          version: 1,
          runId: RUN,
          decision: 'approved',
          source: 'plan/review',
          correlation: 'plan-review-0',
          reviewSeq: 8,
        },
      },
    ])
    expect(stale.failure).toMatch(/already recorded/)
    expect(stale.approval).toBe('rejected')
  })

  it('keeps a rejected plan in awaiting_user_approval and creates no lead', () => {
    const events = [
      ...throughAwaiting(),
      approval('rejected'),
      node('lead', LEAD_A, SUPERVISOR, TASK_A, 'corr-lead-a'),
    ]
    const state = events.reduce(applyOrc, emptyOrcState())
    expect(state.failure).toMatch(/user rejection blocks implementation/)
    expect(state.phase).toBe('awaiting_user_approval')
    expect(state.nodes.map(item => item.role)).toEqual(['supervisor'])
  })

  it('keeps a failed spec in spec_required', () => {
    const events = [workflow(), specRequested(), phase('spec_required'), specResult('failed'), phase('plan_required')]
    const state = events.reduce(applyOrc, emptyOrcState())
    expect(state.failure).toMatch(/codex spec failure blocks plan/)
    expect(state.phase).toBe('spec_required')
  })

  it('requires task settlement before review', () => {
    const events = [
      ...eventsThroughPeer(),
      nodeSettled(PEER_A, 'settled', 'peer evidence'),
      phase('task_peer_settlement'),
      nodeSettled(LEAD_A, 'settled', 'lead evidence'),
      phase('task_review'),
    ]
    const state = events.reduce(applyOrc, emptyOrcState())
    expect(state.failure).toMatch(/task settlement is required before review/)
    expect(state.phase).toBe('task_peer_settlement')
  })

  it('leaves the task unsettled after peer timeout', () => {
    const events = [...eventsThroughPeer(), nodeSettled(PEER_A, 'timeout'), taskSettled(TASK_A, LEAD_A)]
    expect(failure(events)).toMatch(/lead task is unsettled/)
  })

  it('does not treat a failed lead as ready for review', () => {
    const events = [
      ...eventsThroughPeer().slice(0, -1),
      nodeSettled(LEAD_A, 'failed', 'startup failed'),
      phase('task_peer_settlement'),
    ]
    expect(failure(events)).toMatch(/lead startup failure blocks peer settlement/)
  })

  it('requires both a review result and an audit result', () => {
    const review = throughTaskReview()
    const missingReview = review.reduce(applyOrc, emptyOrcState())
    const skippedAudit = [...review, phase('task_audit')].reduce(applyOrc, emptyOrcState())
    expect(skippedAudit.failure).toMatch(/review result is missing/)
    expect(skippedAudit.phase).toBe('task_review')

    const audited = [
      ...review,
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      phase('next_task'),
    ].reduce(applyOrc, emptyOrcState())
    expect(audited.failure).toMatch(/audit result is missing/)
    expect(audited.phase).toBe('task_audit')
    expect(missingReview.failure).toBeUndefined()
  })

  it.each(['critical', 'high', 'medium'] as const)(
    'routes an unresolved %s finding to fix instead of the next task',
    (severity) => {
      const reviewed = [
        ...throughTaskReview(),
        reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
        reportResult('review', 'corr-review-a', 'ok', [{ id: 'finding-block', severity, summary: 'blocks' }]),
        phase('task_audit'),
        reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
        reportResult('audit', 'corr-audit-a', 'ok'),
      ]
      const advanced = [...reviewed, phase('next_task')].reduce(applyOrc, emptyOrcState())
      const resolved = [
        ...reviewed,
        { type: 'orc/finding/resolved', data: { version: 1, runId: RUN, findingId: OrcFindingId('finding-block') } },
        phase('next_task'),
      ].reduce(applyOrc, emptyOrcState())
      const fixed = [...reviewed, phase('task_fix')].reduce(applyOrc, emptyOrcState())
      expect(advanced.failure).toMatch(/blocking findings require fix/)
      expect(resolved.failure).toMatch(/blocking findings require fix/)
      expect(fixed.failure).toBeUndefined()
      expect(fixed.phase).toBe('task_fix')
    },
  )

  it('records low and info findings without blocking the next task', () => {
    const state = replay([
      ...throughTaskReview(),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok', [{ id: 'finding-low', severity: 'low', summary: 'nit' }]),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok', [{ id: 'finding-info', severity: 'info', summary: 'note' }]),
      phase('next_task'),
    ])
    expect(state.phase).toBe('next_task')
    expect(state.findings.map(finding => finding.severity)).toEqual(['low', 'info'])
    expect(state.tasks.find(task => task.id === TASK_A)?.phase).toBe('clean')
  })

  it('blocks low findings when the run raises the threshold', () => {
    const raised = ['critical', 'high', 'medium', 'low'] as const
    const events = [
      ...throughTaskReview(raised),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok', [{ id: 'finding-low', severity: 'low', summary: 'nit' }]),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('next_task'),
    ]
    expect(failure(events)).toMatch(/blocking findings require fix/)
  })

  it('requires a clean audit before the next task or final review', () => {
    const base = [
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
    ]
    expect(failure([...base, phase('final_review')])).toMatch(/audit result is missing/)
    const unavailable = [
      ...base,
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'unavailable'),
      phase('final_review'),
    ]
    expect(failure(unavailable)).toMatch(/audit result is unavailable and blocks progression/)
    const clean = replay([
      ...base,
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
    ])
    expect(clean.phase).toBe('final_review')
    expect(failure([...base, reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A), reportResult('audit', 'corr-audit-a', 'ok'), phase('next_task')]))
      .toMatch(/no remaining task/)
  })

  it('refuses an illegal phase jump and a duplicate correlation id', () => {
    expect(failure([workflow(), phase('complete')])).toMatch(/illegal phase jump from brainstorming to complete/)
    expect(failure([workflow(), specRequested(), specRequested()])).toMatch(/duplicate correlation id/)
  })

  it('records terminal failure and refuses later advancement', () => {
    const failed = replay([workflow(), runFailed('disposed')])
    expect(failed.phase).toBe('failed')
    expect(failed.terminalReason).toBe('disposed')
    expect(failure([workflow(), runFailed('disposed'), phase('spec_required')])).toMatch(/run has failed/)
  })

  it('replays spec, approval, fix, the next task, and final completion', () => {
    const state = replay([
      ...throughTaskReview(),
      reportRequested('review', 'corr-review-a0', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a0', 'ok', [{ id: 'finding-medium', severity: 'medium', summary: 'blocks' }]),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a0', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a0', 'ok'),
      phase('task_fix'),
      fixIteration(TASK_A, 1),
      phase('task_review'),
      reportRequested('review', 'corr-review-a1', 'task', 1, TASK_A),
      reportResult('review', 'corr-review-a1', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a1', 'task', 1, TASK_A),
      reportResult('audit', 'corr-audit-a1', 'ok'),
      phase('next_task'),
      phase('task_implementation'),
      node('lead', OrcNodeId('lead-b'), SUPERVISOR, TASK_B, 'corr-lead-b'),
      taskStarted(TASK_B, OrcNodeId('lead-b')),
      node('peer', OrcNodeId('peer-b'), OrcNodeId('lead-b'), TASK_B, 'corr-peer-b'),
      nodeSettled(OrcNodeId('peer-b'), 'settled', 'peer b'),
      phase('task_peer_settlement'),
      nodeSettled(OrcNodeId('lead-b'), 'settled', 'lead b'),
      taskSettled(TASK_B, OrcNodeId('lead-b')),
      phase('task_review'),
      reportRequested('review', 'corr-review-b', 'task', 0, TASK_B),
      reportResult('review', 'corr-review-b', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-b', 'task', 0, TASK_B),
      reportResult('audit', 'corr-audit-b', 'ok'),
      phase('final_review'),
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      reportResult('review', 'corr-branch-review', 'ok'),
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok'),
      runCompleted(),
    ])
    expect(state.phase).toBe('complete')
    expect(state.approval).toBe('approved')
    expect(state.specText).toBe('design spec')
    expect(state.planText).toBe('implementation plan')
    expect(state.tasks.map(task => [task.id, task.phase, task.iteration])).toEqual([
      [TASK_A, 'clean', 1],
      [TASK_B, 'clean', 0],
    ])
    expect(state.findings).toEqual([
      expect.objectContaining({ id: OrcFindingId('finding-medium'), severity: 'medium', status: 'open' }),
    ])
    expect(failure([
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
      runCompleted(),
    ])).toMatch(/branch review result is missing/)
  })

  it('rejects a phase append with no actor', () => {
    expect(failure([
      workflow(),
      specRequested(),
      { type: 'orc/phase', data: { version: 1, runId: RUN, to: 'spec_required' } } as OrcEvent,
    ])).toMatch(/phase actor is required/)
  })

  it('rejects a peer actor and accepts a lead actor', () => {
    expect(failure([
      ...eventsThroughPeer(),
      {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'task_peer_settlement', actorNodeId: PEER_A },
      },
    ])).toMatch(/peer cannot advance the workflow/)
    const advanced = replay([
      ...eventsThroughPeer(),
      {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'task_peer_settlement', actorNodeId: LEAD_A },
      },
    ])
    expect(advanced.phase).toBe('task_peer_settlement')
    expect(failure([
      workflow(),
      specRequested(),
      {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'spec_required', actorNodeId: OrcNodeId('missing') },
      },
    ])).toMatch(/phase actor is missing/)
  })

  it('reopens the owning task from a blocking branch finding', () => {
    const prefix: OrcEvent[] = [
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      {
        type: 'orc/review/result',
        data: {
          version: 1,
          runId: RUN,
          correlationId: OrcCorrelationId('corr-branch-review'),
          status: 'ok',
          findings: [{
            id: OrcFindingId('finding-branch'),
            severity: 'medium',
            summary: 'branch block',
            taskId: TASK_A,
          }],
        },
      },
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok'),
    ]
    expect(failure([...prefix, runCompleted()])).toMatch(/blocking findings require fix/)
    const reopened = replay([
      ...prefix,
      {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'task_fix', actorNodeId: SUPERVISOR, taskId: TASK_A },
      },
    ])
    expect(reopened.phase).toBe('task_fix')
    expect(reopened.activeTaskId).toBe(TASK_A)
    expect(reopened.tasks.find(task => task.id === TASK_A)).toMatchObject({ phase: 'fix', iteration: 0 })
    expect(failure([
      ...prefix,
      {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'task_fix', actorNodeId: SUPERVISOR, taskId: TASK_A },
      },
      phase('task_review'),
    ])).toMatch(/fix iteration is required before review/)
    const resumed = replay([
      ...prefix,
      {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'task_fix', actorNodeId: SUPERVISOR, taskId: TASK_A },
      },
      fixIteration(TASK_A, 1),
      phase('task_review'),
    ])
    expect(resumed.phase).toBe('task_review')
    expect(resumed.tasks.find(task => task.id === TASK_A)).toMatchObject({ iteration: 1, fixDecision: 'fix task-a iteration 1' })
  })

  it('does not reopen a task for a low branch finding or a malformed branch result', () => {
    const base = [
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
    ]
    const low = replay([
      ...base,
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      reportResult('review', 'corr-branch-review', 'ok', [{ id: 'finding-low', severity: 'low', summary: 'nit' }]),
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok', [{ id: 'finding-info', severity: 'info', summary: 'note' }]),
      runCompleted(),
    ])
    expect(low.phase).toBe('complete')
    expect(failure([
      ...base,
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      reportResult('review', 'corr-branch-review', 'ok', [{ id: 'finding-low', severity: 'low', summary: 'nit' }]),
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok'),
      {
        type: 'orc/phase',
        data: { version: 1, runId: RUN, to: 'task_fix', actorNodeId: SUPERVISOR, taskId: TASK_A },
      },
    ])).toMatch(/blocking branch finding is required/)
    expect(failure([
      ...base,
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      reportResult('review', 'corr-branch-review', 'malformed'),
      runCompleted(),
    ])).toMatch(/branch review result is malformed and blocks progression/)
  })

  it('replaces a non-ok task report and judges the latest row', () => {
    const reviewed = [
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'malformed'),
    ]
    const replaced = replay([
      ...reviewed,
      reportRequested('review', 'corr-review-a2', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a2', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'malformed'),
      reportRequested('audit', 'corr-audit-a2', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a2', 'ok'),
      phase('final_review'),
    ])
    expect(replaced.phase).toBe('final_review')
    expect(replaced.delegations.filter(item => item.kind === 'codex-review').at(-1)?.status).toBe('ok')
    expect(failure([
      ...reviewed,
      reportRequested('review', 'corr-review-a2', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a2', 'ok'),
      reportRequested('review', 'corr-review-a3', 'task', 0, TASK_A),
    ])).toMatch(/review is already requested/)
  })

  it('does not let a same-visit clean branch pair erase a blocking pair', () => {
    const blocking = [
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      {
        type: 'orc/review/result' as const,
        data: {
          version: 1 as const,
          runId: RUN,
          correlationId: OrcCorrelationId('corr-branch-review'),
          status: 'ok' as const,
          findings: [{
            id: OrcFindingId('finding-branch'),
            severity: 'medium' as const,
            summary: 'branch block',
            taskId: TASK_A,
          }],
        },
      },
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok'),
    ]
    expect(failure([
      ...blocking,
      reportRequested('review', 'corr-branch-review-2', 'branch', 1),
    ])).toMatch(/branch request iteration does not match this final review/)
    expect(failure([
      ...blocking,
      reportRequested('review', 'corr-branch-review-2', 'branch', 0),
    ])).toMatch(/branch review is already requested/)
    expect(failure([...blocking, runCompleted()])).toMatch(/blocking findings require fix/)
  })

  it('accepts a clean branch pair only after a fix returns to final review', () => {
    const blocking = [
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      {
        type: 'orc/review/result' as const,
        data: {
          version: 1 as const,
          runId: RUN,
          correlationId: OrcCorrelationId('corr-branch-review'),
          status: 'ok' as const,
          findings: [{
            id: OrcFindingId('finding-branch'),
            severity: 'high' as const,
            summary: 'branch block',
            taskId: TASK_A,
          }],
        },
      },
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok'),
      phase('task_fix', TASK_A),
      fixIteration(TASK_A, 1),
      phase('task_review'),
      reportRequested('review', 'corr-review-a1', 'task', 1, TASK_A),
      reportResult('review', 'corr-review-a1', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a1', 'task', 1, TASK_A),
      reportResult('audit', 'corr-audit-a1', 'ok'),
      phase('final_review'),
    ]
    const state = replay([
      ...blocking,
      reportRequested('review', 'corr-branch-review-2', 'branch', 1),
      reportResult('review', 'corr-branch-review-2', 'ok'),
      reportRequested('audit', 'corr-branch-audit-2', 'branch', 1),
      reportResult('audit', 'corr-branch-audit-2', 'ok'),
      runCompleted(),
    ])
    expect(state.phase).toBe('complete')
    expect(state.tasks.find(task => task.id === TASK_A)).toMatchObject({ phase: 'clean', iteration: 1 })
  })

  it('retries an unavailable branch result in the same final review', () => {
    const state = replay([
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      reportResult('review', 'corr-branch-review', 'unavailable'),
      reportRequested('review', 'corr-branch-review-2', 'branch', 0),
      reportResult('review', 'corr-branch-review-2', 'ok'),
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok'),
      runCompleted(),
    ])
    expect(state.phase).toBe('complete')
  })

  it('keeps a second task from starting or settling while another task is in flight', () => {
    expect(failure([
      ...eventsThroughPeer(),
      nodeSettled(LEAD_A, 'settled', 'lead settled early'),
      node('lead', OrcNodeId('lead-b'), SUPERVISOR, TASK_B, 'corr-lead-b'),
    ])).toMatch(/another task is in flight/)
    expect(failure([
      ...eventsThroughPeer(),
      taskStarted(TASK_B, LEAD_A),
    ])).toMatch(/another task is in flight/)
    expect(failure([
      ...eventsThroughPeer(),
      {
        type: 'orc/task/settled',
        data: { version: 1, runId: RUN, taskId: TASK_B, leadNodeId: LEAD_A, evidence: 'not the active task' },
      },
    ])).toMatch(/task settlement requires the active task/)
  })

  it('fails a task on startup failure and leaves timeout unsettled', () => {
    expect(replay([
      ...eventsThroughPeer(),
      nodeSettled(PEER_A, 'failed', 'startup failed'),
    ]).tasks.find(task => task.id === TASK_A)?.phase).toBe('failed')
    expect(replay([
      ...eventsThroughPeer(),
      nodeSettled(LEAD_A, 'failed', 'startup failed'),
    ]).tasks.find(task => task.id === TASK_A)?.phase).toBe('failed')
    expect(replay([
      ...eventsThroughPeer(),
      nodeSettled(PEER_A, 'timeout'),
    ]).tasks.find(task => task.id === TASK_A)?.phase).toBe('unsettled')
    expect(replay([
      ...eventsThroughPeer(),
      nodeSettled(PEER_A, 'cancelled'),
    ]).tasks.find(task => task.id === TASK_A)?.phase).toBe('unsettled')
    expect(replay([
      ...eventsThroughPeer(),
      nodeSettled(PEER_A, 'incomplete'),
    ]).tasks.find(task => task.id === TASK_A)?.phase).toBe('unsettled')
  })

  it('keeps sequencing, final review, and completion on the supervisor', () => {
    const audited = [
      ...throughTaskReview(),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
    ]
    expect(failure([...audited, phase('next_task', undefined, LEAD_A)])).toMatch(/lead cannot advance this phase/)
    expect(failure([...audited, phase('final_review', undefined, LEAD_A)])).toMatch(/lead cannot advance this phase/)
    expect(replay([...audited, phase('next_task')]).phase).toBe('next_task')
    const ready = [
      ...throughTaskReview(BLOCKING, false),
      reportRequested('review', 'corr-review-a', 'task', 0, TASK_A),
      reportResult('review', 'corr-review-a', 'ok'),
      phase('task_audit'),
      reportRequested('audit', 'corr-audit-a', 'task', 0, TASK_A),
      reportResult('audit', 'corr-audit-a', 'ok'),
      phase('final_review'),
      reportRequested('review', 'corr-branch-review', 'branch', 0),
      reportResult('review', 'corr-branch-review', 'ok'),
      reportRequested('audit', 'corr-branch-audit', 'branch', 0),
      reportResult('audit', 'corr-branch-audit', 'ok'),
    ]
    expect(failure([...ready, runCompleted(LEAD_A)])).toMatch(/lead cannot complete the run/)
    expect(failure([...ready, runCompleted(PEER_A)])).toMatch(/peer cannot advance the workflow/)
    expect(failure([
      ...ready,
      { type: 'orc/run/completed', data: { version: 1, runId: RUN } } as OrcEvent,
    ])).toMatch(/run actor is required/)
    expect(failure([...eventsThroughPeer(), runFailed('disposed', LEAD_A)])).toMatch(/lead cannot fail the run/)
    expect(failure([...eventsThroughPeer(), runFailed('disposed', PEER_A)])).toMatch(/peer cannot advance the workflow/)
    expect(replay([...ready, runCompleted()]).phase).toBe('complete')
  })
})
