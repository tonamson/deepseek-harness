/**
 * Codex final-text settlement and the review/audit fix loop.
 * Child starts stay on `OrcService`. This module does not call `subagents.start` and does not pass `outputSchema`.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { parseCodexStage, type OrcCodexStage, type OrcNormalizedFinding } from './codex-results.ts'
import type { OrcService } from './index.ts'
import { OrcFindingId, OrcTaskId as brandTaskId } from './projection.ts'
import type {
  OrcCorrelationId,
  OrcDelegation,
  OrcFinding,
  OrcFindingInput,
  OrcReportStatus,
  OrcReviewScope,
  OrcState,
  OrcTaskId,
} from './types.ts'

/** What `OrcService` passes to {@link settleCodexRun} after a Codex start is durable. */
export interface OrcCodexSettlement {
  readonly correlationId: OrcCorrelationId
  readonly stage: OrcCodexStage
  readonly role: string
  readonly taskId?: OrcTaskId
  readonly result: Promise<SubagentResult>
}

/** Findings and iteration handed to the DeepSeek fix step. */
export interface OrcFixRequest {
  readonly taskId: OrcTaskId
  readonly iteration: number
  readonly findings: readonly OrcFinding[]
}

/** Fix step outcome. `failed` stops the loop. `decision` is the durable fix record. */
export type OrcFixWorkResult = { readonly decision: string } | { readonly failed: string }

/**
 * DeepSeek fix for one blocking gate.
 * The dispatcher does not invent a decision or a retry ceiling.
 */
export type OrcFixWork = (input: OrcFixRequest) => Promise<OrcFixWorkResult>

const SETTLED_TASK = 'task review requires a settled task'
const CLEAN_TASKS = 'final review requires every task to be clean'

/**
 * Parse one Codex result and record it.
 * `ok` is recorded only after the stage parser accepts the text. Transport failure, missing text, and malformed text stay blocking.
 * @param service - ORC service that owns the delegation.
 * @param caller - Supervisor that started the run.
 * @param input - correlation, stage, and the one-shot result promise.
 * @returns the projected run after the result event.
 */
export async function settleCodexRun(service: OrcService, caller: Agent, input: OrcCodexSettlement): Promise<OrcState> {
  let settled: SubagentResult
  try {
    settled = await input.result
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return recordParsed(service, caller, input, { status: 'unavailable', ...rawField(message) })
  }
  const rawText = codexFinalText(settled.output)
  if (settled.stopReason !== 'completed') {
    // A non-completed stop can still carry text. That text is evidence, not a clean report.
    return recordParsed(service, caller, input, { status: 'failed', ...rawField(rawText) })
  }
  const parsed = parseCodexStage(input.stage, rawText)
  if (parsed.status !== 'ok') {
    return recordParsed(service, caller, input, { status: parsed.status, ...rawField(parsed.rawText) })
  }
  if (parsed.stage !== input.stage) {
    return recordParsed(service, caller, input, { status: 'malformed', rawText: parsed.rawText })
  }
  if (parsed.stage === 'codex-spec' || parsed.stage === 'codex-plan') {
    return recordParsed(service, caller, input, { status: 'ok', text: parsed.text, rawText: parsed.rawText })
  }
  if (parsed.stage === 'codex-review' || parsed.stage === 'codex-audit') {
    return recordParsed(service, caller, input, {
      status: 'ok',
      rawText: parsed.rawText,
      findings: parsed.findings.map(toFindingInput),
    })
  }
  return assertNever(parsed.stage)
}

/**
 * Start the next Codex spec or plan and wait for its parsed result.
 * The service selects the route from config. This function does not name a model.
 * @param service - ORC service.
 * @param caller - Supervisor.
 * @param signal - cancellation for the one-shot start.
 * @returns the projected run after the result is recorded.
 */
export async function runCodexSpecPlan(service: OrcService, caller: Agent, signal: AbortSignal): Promise<OrcState> {
  const launch = await service.startSpecPlan(caller, signal)
  return service.awaitCodex(caller, launch.correlationId)
}

/**
 * Run Codex review, then Codex audit, then a DeepSeek fix for every blocking finding, until both gates are clean.
 * The next task and final completion are not started here. A settled task is required first.
 * @param service - ORC service.
 * @param caller - Supervisor.
 * @param signal - cancellation for each Codex start.
 * @param fix - DeepSeek fix step. It is not called when the gates have no blocking findings.
 * @returns the projected run at `next_task`, `final_review`, or the blocking phase.
 */
export async function runCodexTaskLoop(
  service: OrcService,
  caller: Agent,
  signal: AbortSignal,
  fix: OrcFixWork,
): Promise<OrcState> {
  const state = service.state(caller)
  if (state.phase === 'task_peer_settlement') {
    await service.advance(caller, 'task_review')
  } else if (state.phase !== 'task_review' && state.phase !== 'task_audit') {
    throw new Error(SETTLED_TASK)
  }
  return enforceTaskGates(service, caller, signal, fix)
}

/**
 * Run branch review and branch audit only after every task is clean.
 * A blocking finding reopens that task, records `orc/fix/iteration`, and repeats review and audit.
 * Every blocking task from that pair is repaired before the next branch visit opens.
 * A non-ok post-fix gate does not drop the remaining task ids.
 * Completion is not recorded here.
 * @param service - ORC service.
 * @param caller - Supervisor.
 * @param signal - cancellation for each Codex start.
 * @param fix - DeepSeek fix step for a blocking branch finding.
 * @returns the projected run. A clean pair stays in `final_review`.
 */
export async function runCodexFinalLoop(
  service: OrcService,
  caller: Agent,
  signal: AbortSignal,
  fix: OrcFixWork,
): Promise<OrcState> {
  const initial = service.state(caller)
  if (initial.phase !== 'final_review' || initial.tasks.some(task => task.phase !== 'clean')) {
    throw new Error(CLEAN_TASKS)
  }
  for (;;) {
    if (service.state(caller).phase !== 'final_review') return service.state(caller)
    const taskId = tasksAwaitingBranchFix(caller, service.state(caller))[0]
    if (taskId !== undefined) {
      const repaired = await repairTask(service, caller, fix, taskId, blockingBranchReports(service.state(caller)))
      if (repaired !== undefined) return repaired
      const gated = await enforceTaskGates(service, caller, signal, fix)
      if (gated.phase !== 'final_review') return gated
      continue
    }
    const reviewed = await ensureReport(service, caller, signal, 'codex-review', { scope: 'branch' })
    if (reviewed.report?.status !== 'ok') return reviewed.state
    const audited = await ensureReport(service, caller, signal, 'codex-audit', { scope: 'branch' })
    if (audited.report?.status !== 'ok') return audited.state
    const review = reviewed.report
    const audit = audited.report
    if (!review.blocksProgress && !audit.blocksProgress) return audited.state
    if (tasksAwaitingBranchFix(caller, audited.state).length === 0) return audited.state
  }
}

interface ParsedRecord {
  readonly status: OrcReportStatus
  readonly text?: string
  readonly rawText?: string
  readonly findings?: readonly OrcFindingInput[]
}

/** Record a parsed result. A duplicate finding id stays open and keeps the projection error. */
async function recordParsed(service: OrcService, caller: Agent, input: OrcCodexSettlement, recorded: ParsedRecord): Promise<OrcState> {
  try {
    return await writeResult(service, caller, input, recorded)
  } catch (error: unknown) {
    const current = service.state(caller)
    if (delegationStatus(current, input.correlationId) !== 'open') return current
    if (recorded.status !== 'ok' || isDuplicateFindingRefusal(error)) throw error
    try {
      return await writeResult(service, caller, input, { status: 'malformed', ...rawField(recorded.rawText) })
    } catch (fallback: unknown) {
      const after = service.state(caller)
      if (delegationStatus(after, input.correlationId) !== 'open') return after
      throw fallback
    }
  }
}

/** The fold rejected an id that is already on the run. That is not a malformed Codex document. */
function isDuplicateFindingRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes('duplicate finding id')
}

/** Append one Codex result through the service. */
function writeResult(service: OrcService, caller: Agent, input: OrcCodexSettlement, recorded: ParsedRecord): Promise<OrcState> {
  return service.recordResult(caller, {
    correlationId: input.correlationId,
    stage: input.stage,
    role: input.role,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    status: recorded.status,
    ...(recorded.text === undefined ? {} : { text: recorded.text }),
    ...(recorded.rawText === undefined ? {} : { rawText: recorded.rawText }),
    ...(recorded.findings === undefined ? {} : { findings: recorded.findings }),
  })
}

/** Review then audit for the active task until both gates are clean or one result is blocking. */
async function enforceTaskGates(service: OrcService, caller: Agent, signal: AbortSignal, fix: OrcFixWork): Promise<OrcState> {
  for (;;) {
    const state = service.state(caller)
    const taskId = state.activeTaskId
    if (taskId === undefined || (state.phase !== 'task_review' && state.phase !== 'task_audit')) throw new Error(SETTLED_TASK)
    if (state.phase === 'task_review') {
      const reviewed = await ensureReport(service, caller, signal, 'codex-review', { scope: 'task', taskId })
      if (reviewed.report?.status !== 'ok') return reviewed.state
      await service.advance(caller, 'task_audit')
    }
    const current = service.state(caller)
    const review = reportOf(current, 'codex-review', 'task', taskId)
    if (review?.status !== 'ok') return current
    const audited = await ensureReport(service, caller, signal, 'codex-audit', { scope: 'task', taskId })
    if (audited.report?.status !== 'ok') return audited.state
    const audit = audited.report
    if (review.blocksProgress || audit.blocksProgress) {
      const repaired = await repairTask(service, caller, fix, taskId, [review, audit])
      if (repaired !== undefined) return repaired
      continue
    }
    const remaining = audited.state.tasks.some(task => task.id !== taskId && task.phase !== 'clean')
    return remaining ? service.advance(caller, 'next_task') : service.advance(caller, 'final_review')
  }
}

/** Record the fix, or fail the run when the fix step cannot continue. Returns undefined when review can run again. */
async function repairTask(
  service: OrcService,
  caller: Agent,
  fix: OrcFixWork,
  taskId: OrcTaskId,
  reports: readonly OrcDelegation[],
): Promise<OrcState | undefined> {
  const before = service.state(caller)
  const task = before.tasks.find(item => item.id === taskId)
  if (task === undefined) throw new Error(SETTLED_TASK)
  if (before.phase !== 'task_fix') {
    await service.advance(caller, 'task_fix', before.phase === 'final_review' ? taskId : undefined)
  }
  const findings = blockingFindings(service.state(caller), reports).filter(finding => finding.taskId === taskId)
  let work: OrcFixWorkResult
  try {
    work = await fix({ taskId, iteration: task.iteration + 1, findings })
  } catch (error: unknown) {
    return service.fail(caller, error instanceof Error ? error.message : String(error))
  }
  if ('failed' in work) return service.fail(caller, work.failed)
  await service.recordFix(caller, { taskId, iteration: task.iteration + 1, decision: work.decision })
  await service.advance(caller, 'task_review')
  return undefined
}

/**
 * Use the current ok report, or start one when it is missing or not ok.
 * An ok review is not requested again. A non-ok audit is returned by the caller of this helper.
 */
async function ensureReport(
  service: OrcService,
  caller: Agent,
  signal: AbortSignal,
  kind: 'codex-review' | 'codex-audit',
  input: { readonly scope: OrcReviewScope; readonly taskId?: OrcTaskId },
): Promise<{ readonly state: OrcState; readonly report: OrcDelegation | undefined }> {
  const current = service.state(caller)
  const existing = reportOf(current, kind, input.scope, input.taskId)
  if (existing?.status === 'ok') return { state: current, report: existing }
  const state = await openGate(service, caller, signal, kind, input)
  return { state, report: reportOf(state, kind, input.scope, input.taskId) }
}

/** Start one review or audit and wait for its own result. */
async function openGate(
  service: OrcService,
  caller: Agent,
  signal: AbortSignal,
  kind: 'codex-review' | 'codex-audit',
  input: { readonly scope: OrcReviewScope; readonly taskId?: OrcTaskId },
): Promise<OrcState> {
  const request = { scope: input.scope, signal, ...(input.taskId === undefined ? {} : { taskId: input.taskId }) }
  const launch = kind === 'codex-review'
    ? await service.requestReview(caller, request)
    : await service.requestAudit(caller, request)
  return service.awaitCodex(caller, launch.correlationId)
}

/** Delegation recorded for this scope and iteration. */
function reportOf(
  state: OrcState,
  kind: 'codex-review' | 'codex-audit',
  scope: OrcReviewScope,
  taskId: OrcTaskId | undefined,
): OrcDelegation | undefined {
  const task = taskId === undefined ? undefined : state.tasks.find(item => item.id === taskId)
  const iteration = scope === 'branch' ? state.branchVisit : task?.iteration
  let found: OrcDelegation | undefined
  for (const item of state.delegations) {
    if (item.kind === kind && item.scope === scope && item.iteration === iteration && item.taskId === taskId) found = item
  }
  return found
}

interface BranchSide {
  readonly ok: boolean
  readonly tasks: readonly OrcTaskId[]
}

/**
 * Blocking task ids from branch pairs whose review and audit are both ok, until a later `orc/fix/iteration`.
 * A non-ok gate does not erase the ids that were not repaired yet.
 */
function tasksAwaitingBranchFix(caller: Agent, state: OrcState): OrcTaskId[] {
  const pending: OrcTaskId[] = []
  const visits = new Map<number, { review?: BranchSide; audit?: BranchSide; committed: boolean }>()
  for (const event of loggedEvents(caller)) {
    if (event.type === 'orc/fix/iteration') {
      const taskId = loggedTaskId(event.data)
      const index = taskId === undefined ? -1 : pending.findIndex(id => id === taskId)
      if (index !== -1) pending.splice(index, 1)
      continue
    }
    if (event.type !== 'orc/review/result' && event.type !== 'orc/audit/result') continue
    const logged = loggedBranchResult(event.data, state)
    if (logged === undefined) continue
    const pair = visits.get(logged.visit) ?? { committed: false }
    const side: BranchSide = { ok: logged.ok, tasks: logged.tasks }
    if (event.type === 'orc/review/result') pair.review = side
    else pair.audit = side
    visits.set(logged.visit, pair)
    if (!pair.committed && pair.review?.ok === true && pair.audit?.ok === true) {
      for (const taskId of [...pair.review.tasks, ...pair.audit.tasks]) {
        if (!pending.includes(taskId)) pending.push(taskId)
      }
      pair.committed = true
    }
  }
  return pending
}

/**
 * Rows on the live Supervisor log.
 * `orc/*` is not part of `SessionEventMap`, so the typed snapshot hides those rows. The values are still present.
 */
function loggedEvents(caller: Agent): readonly { readonly type: string; readonly data: unknown }[] {
  const events: { type: string; data: unknown }[] = []
  for (const event of caller.session.snapshotEvents()) {
    events.push({ type: event.type, data: event.data })
  }
  return events
}

/** Ok blocking branch reports. Repair filters them down to one task. */
function blockingBranchReports(state: OrcState): OrcDelegation[] {
  return state.delegations.filter(item => item.scope === 'branch' && item.status === 'ok' && item.blocksProgress)
}

/** Branch result fields, or undefined when the row is not a branch delegation. */
function loggedBranchResult(data: unknown, state: OrcState): { visit: number; ok: boolean; tasks: OrcTaskId[] } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  if (typeof record.status !== 'string' || typeof record.correlationId !== 'string') return undefined
  const delegation = state.delegations.find(item => item.correlationId === record.correlationId)
  if (delegation === undefined || delegation.scope !== 'branch') return undefined
  const tasks: OrcTaskId[] = []
  if (record.status === 'ok' && Array.isArray(record.findings)) {
    for (const finding of record.findings) {
      if (typeof finding !== 'object' || finding === null) continue
      const item = finding as Record<string, unknown>
      if (typeof item.taskId !== 'string' || typeof item.severity !== 'string') continue
      if (!state.blockingSeverities.some(severity => severity === item.severity)) continue
      const taskId = brandTaskId(item.taskId)
      if (!tasks.includes(taskId)) tasks.push(taskId)
    }
  }
  return { visit: delegation.iteration, ok: record.status === 'ok', tasks }
}

/** Task id on an `orc/fix/iteration` payload. */
function loggedTaskId(data: unknown): OrcTaskId | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const taskId = (data as { taskId?: unknown }).taskId
  return typeof taskId === 'string' ? brandTaskId(taskId) : undefined
}

/** Findings on these reports whose severity is in the run's blocking set. */
function blockingFindings(state: OrcState, reports: readonly OrcDelegation[]): OrcFinding[] {
  const ids = new Set(reports.flatMap(report => report.findingIds))
  return state.findings.filter(finding => ids.has(finding.id) && state.blockingSeverities.includes(finding.severity))
}

/** Current status, or `open` when the row is missing. */
function delegationStatus(state: OrcState, correlationId: OrcCorrelationId): string {
  return state.delegations.find(item => item.correlationId === correlationId)?.status ?? 'open'
}

/** Omit blank text. The result schema rejects an empty raw string. */
function rawField(text: string | undefined): { readonly rawText?: string } {
  if (text === undefined || text.length === 0) return {}
  return { rawText: text }
}

/** Copy a parsed finding onto the result event. */
function toFindingInput(finding: OrcNormalizedFinding): OrcFindingInput {
  return {
    id: OrcFindingId(finding.id),
    severity: finding.severity,
    summary: finding.summary,
    taskId: brandTaskId(finding.taskId),
    file: finding.file,
    location: finding.location,
    evidence: finding.evidence,
    remediation: finding.remediation,
    sourceStage: finding.sourceStage,
  }
}

/** Close a stage union. */
function assertNever(value: never): never {
  throw new Error(`unexpected Codex stage ${String(value)}`)
}

/**
 * Join text blocks from a Codex result.
 * Other block types are not the final answer.
 */
function codexFinalText(output: readonly ContentBlock[]): string | undefined {
  let text = ''
  for (const block of output) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      default:
        // Content blocks are merge-extensible. Reasoning and tool blocks stay out of the parsed answer.
        break
    }
  }
  const trimmed = text.trim()
  return trimmed.length === 0 ? undefined : trimmed
}
