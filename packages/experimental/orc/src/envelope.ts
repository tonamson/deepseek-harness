/**
 * Native Codex task text.
 * Every field is copied from a logged envelope or from the run's blocking severities.
 * The stage JSON contract is prompt text. It is not a provider outputSchema.
 */

import { codexJsonContract } from './codex-results.ts'

/** Inputs for {@link renderCodexEnvelope}. Provider, model, and effort are caller-supplied. */
export interface OrcCodexEnvelopeText {
  readonly role: 'spec-only' | 'plan-only' | 'review-only' | 'audit-only'
  readonly stage: 'codex-spec' | 'codex-plan' | 'codex-review' | 'codex-audit'
  readonly repositoryScope: string
  readonly skillWorkflow: string
  readonly expectedStructuredResult: string
  readonly blockingSeverities: readonly string[]
  readonly provider: string
  readonly model: string
  readonly effort: string
  readonly taskId?: string
  readonly scope?: string
  readonly iteration?: number
}

/**
 * Render the text prompt a native Codex child receives.
 * The result is not an `outputSchema` provider option. Native Codex children do not inherit DSH skills or context.
 * @param fields - logged envelope fields plus the run's blocking severities.
 * @returns one text envelope.
 */
export function renderCodexEnvelope(fields: OrcCodexEnvelopeText): string {
  const lines = [
    `role: ${fields.role}`,
    `stage: ${fields.stage}`,
    `task: ${fields.taskId ?? 'none'}`,
    `repositoryScope: ${fields.repositoryScope}`,
    `skillWorkflow: ${fields.skillWorkflow}`,
    `expectedStructuredResult: ${fields.expectedStructuredResult}`,
    `jsonContract: ${codexJsonContract(fields.stage)}`,
    'severityPolicy: critical, high, and medium block; low and info do not unless blockingSeverities includes them',
    `blockingSeverities: ${fields.blockingSeverities.join(', ')}`,
    'readOnly: true',
    'doNotEdit: true',
    'Do not edit files. Do not create subagents. Do not declare an implementation complete.',
    'Native Codex children do not inherit DSH skills or context.',
    `provider: ${fields.provider}`,
    `model: ${fields.model}`,
    `effort: ${fields.effort}`,
  ]
  if (fields.scope !== undefined) lines.push(`scope: ${fields.scope}`)
  if (fields.iteration !== undefined) lines.push(`iteration: ${String(fields.iteration)}`)
  return lines.join('\n')
}
