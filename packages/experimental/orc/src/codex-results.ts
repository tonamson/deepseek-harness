/**
 * Strict parsers for Codex final text.
 * Codex returns text at this boundary. These parsers do not call a provider and do not read `outputSchema`.
 */

import { z } from 'zod'
import type { OrcSeverity } from './types.ts'

/** Codex delegation stage that returns final text. */
export type OrcCodexStage = 'codex-spec' | 'codex-plan' | 'codex-review' | 'codex-audit'

/**
 * One review or audit finding after a successful parse.
 * `sourceStage` is the document stage, so a review document cannot carry an audit finding.
 */
export interface OrcNormalizedFinding {
  readonly id: string
  readonly severity: OrcSeverity
  readonly file: string
  readonly location: string
  readonly evidence: string
  readonly remediation: string
  readonly status: 'open'
  readonly summary: string
  readonly sourceStage: 'codex-review' | 'codex-audit'
  readonly taskId: string
}

/** Final text that is missing or not the strict envelope. */
export interface OrcCodexParseFailure {
  readonly status: 'malformed' | 'unavailable'
  readonly reason: string
  readonly rawText?: string
}

/** Parsed spec or plan text. `text` is the normalized document, `rawText` is the Codex answer. */
export interface OrcCodexTextSuccess {
  readonly status: 'ok'
  readonly stage: 'codex-spec' | 'codex-plan'
  readonly rawText: string
  readonly text: string
}

/** Parsed review or audit findings. An empty list is a clean gate, not a missing result. */
export interface OrcCodexReportSuccess {
  readonly status: 'ok'
  readonly stage: 'codex-review' | 'codex-audit'
  readonly rawText: string
  readonly findings: readonly OrcNormalizedFinding[]
}

/** Spec, plan, review, or audit parse. Failure is never `ok`. */
export type OrcCodexParsed = OrcCodexTextSuccess | OrcCodexReportSuccess | OrcCodexParseFailure

const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])

/** Build the finding object for one report stage. The stage literal keeps review and audit apart. */
function findingSchema(stage: 'codex-review' | 'codex-audit') {
  return z.object({
    id: z.string().min(1),
    severity: severitySchema,
    file: z.string().min(1),
    location: z.string().min(1),
    evidence: z.string().min(1),
    remediation: z.string().min(1),
    status: z.literal('open'),
    summary: z.string().min(1),
    sourceStage: z.literal(stage),
    taskId: z.string().min(1),
  }).strict()
}

const specSchema = z.object({
  stage: z.literal('codex-spec'),
  spec: z.string().min(1),
}).strict()

const planSchema = z.object({
  stage: z.literal('codex-plan'),
  plan: z.string().min(1),
}).strict()

const reviewSchema = z.object({
  stage: z.literal('codex-review'),
  findings: z.array(findingSchema('codex-review')),
}).strict()

const auditSchema = z.object({
  stage: z.literal('codex-audit'),
  findings: z.array(findingSchema('codex-audit')),
}).strict()

/**
 * Parse a Codex spec answer.
 * @param text - final Codex text, or undefined when the run produced none.
 * @returns the normalized spec, or a blocking failure.
 */
export function parseCodexSpec(text: string | undefined): OrcCodexTextSuccess | OrcCodexParseFailure {
  return parseText(text, 'codex-spec', specSchema, value => value.spec)
}

/**
 * Parse a Codex plan answer.
 * @param text - final Codex text, or undefined when the run produced none.
 * @returns the normalized plan, or a blocking failure.
 */
export function parseCodexPlan(text: string | undefined): OrcCodexTextSuccess | OrcCodexParseFailure {
  return parseText(text, 'codex-plan', planSchema, value => value.plan)
}

/**
 * Parse a Codex review answer.
 * Review findings cannot use the audit stage.
 * @param text - final Codex text, or undefined when the run produced none.
 * @returns normalized review findings, or a blocking failure.
 */
export function parseCodexReview(text: string | undefined): OrcCodexReportSuccess | OrcCodexParseFailure {
  return parseReport(text, 'codex-review', reviewSchema)
}

/**
 * Parse a Codex audit answer.
 * Audit findings cannot use the review stage.
 * @param text - final Codex text, or undefined when the run produced none.
 * @returns normalized audit findings, or a blocking failure.
 */
export function parseCodexAudit(text: string | undefined): OrcCodexReportSuccess | OrcCodexParseFailure {
  return parseReport(text, 'codex-audit', auditSchema)
}

/**
 * JSON object the stage parser accepts.
 * Review and audit each name their own source stage. This text is for the child prompt, not a provider `outputSchema`.
 * @param stage - spec, plan, review, or audit.
 * @returns one line with the required JSON object and, for a report, the finding fields.
 */
export function codexJsonContract(stage: OrcCodexStage): string {
  switch (stage) {
    case 'codex-spec':
      return '{"stage":"codex-spec","spec":"<non-empty string>"}'
    case 'codex-plan':
      return '{"stage":"codex-plan","plan":"<non-empty string>"}'
    case 'codex-review':
      return `{"stage":"codex-review","findings":[]} finding:${findingContract('codex-review')}`
    case 'codex-audit':
      return `{"stage":"codex-audit","findings":[]} finding:${findingContract('codex-audit')}`
    default:
      return assertNever(stage)
  }
}

/** Finding fields for one report stage. `sourceStage` is not shared with the other report. */
function findingContract(stage: 'codex-review' | 'codex-audit'): string {
  return `{"id":"<non-empty>","severity":"critical|high|medium|low|info","file":"<non-empty>","location":"<non-empty>","evidence":"<non-empty>","remediation":"<non-empty>","status":"open","summary":"<non-empty>","sourceStage":"${stage}","taskId":"<non-empty>"}`
}

/**
 * Parse final text for the stage that produced it.
 * @param stage - spec, plan, review, or audit. Review and audit do not share a schema.
 * @param text - final Codex text, or undefined when the run produced none.
 * @returns the stage parser result.
 */
export function parseCodexStage(stage: OrcCodexStage, text: string | undefined): OrcCodexParsed {
  switch (stage) {
    case 'codex-spec':
      return parseCodexSpec(text)
    case 'codex-plan':
      return parseCodexPlan(text)
    case 'codex-review':
      return parseCodexReview(text)
    case 'codex-audit':
      return parseCodexAudit(text)
    default:
      return assertNever(stage)
  }
}

/** Parse a spec or plan envelope. */
function parseText<T extends { readonly stage: 'codex-spec' | 'codex-plan' }>(
  text: string | undefined,
  stage: 'codex-spec' | 'codex-plan',
  schema: z.ZodType<T>,
  read: (value: T) => string,
): OrcCodexTextSuccess | OrcCodexParseFailure {
  const document = readDocument(text)
  if ('status' in document) return document
  const parsed = schema.safeParse(document.value)
  if (!parsed.success) return invalid(document.rawText)
  return { status: 'ok', stage, rawText: document.rawText, text: read(parsed.data) }
}

/** Parse a review or audit envelope. */
function parseReport<T extends { readonly findings: readonly OrcNormalizedFinding[] }>(
  text: string | undefined,
  stage: 'codex-review' | 'codex-audit',
  schema: z.ZodType<T>,
): OrcCodexReportSuccess | OrcCodexParseFailure {
  const document = readDocument(text)
  if ('status' in document) return document
  const parsed = schema.safeParse(document.value)
  if (!parsed.success) return invalid(document.rawText)
  if (duplicateFinding(parsed.data.findings) !== undefined) {
    return { status: 'malformed', rawText: document.rawText, reason: 'duplicate finding' }
  }
  return { status: 'ok', stage, rawText: document.rawText, findings: parsed.data.findings }
}

/** Decode one JSON document or a single fenced JSON block. Prose around a fence is rejected. */
function readDocument(text: string | undefined): { readonly rawText: string; readonly value: unknown } | OrcCodexParseFailure {
  if (text === undefined || text.trim().length === 0) {
    return { status: 'unavailable', reason: 'codex result text is missing' }
  }
  const rawText = text.trim()
  const body = jsonBody(rawText)
  if (body === undefined) return { status: 'malformed', rawText, reason: 'codex result is not a JSON document' }
  try {
    return { rawText, value: JSON.parse(body) }
  } catch (error: unknown) {
    // JSON.parse throws SyntaxError for every non-JSON document. The status stays malformed.
    void error
    return { status: 'malformed', rawText, reason: 'codex result is not JSON' }
  }
}

/**
 * Return the JSON body of a raw document or one opening fence.
 * A language tag other than `json`, or any fence that is not the whole text, is rejected.
 */
function jsonBody(rawText: string): string | undefined {
  if (rawText.startsWith('```') || rawText.includes('```')) {
    const fence = /^```([A-Za-z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(rawText)
    if (fence === null) return undefined
    if (fence[1] !== undefined && fence[1] !== 'json') return undefined
    const body = fence[2]
    if (body === undefined) return undefined
    const trimmed = body.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
  return rawText
}

/** Same id, or the same file, location, and summary twice. */
function duplicateFinding(findings: readonly OrcNormalizedFinding[]): string | undefined {
  const ids = new Set<string>()
  const places = new Set<string>()
  for (const finding of findings) {
    const place = `${finding.file}\0${finding.location}\0${finding.summary}`
    if (ids.has(finding.id) || places.has(place)) return 'duplicate finding'
    ids.add(finding.id)
    places.add(place)
  }
  return undefined
}

/** Schema rejection. The raw answer is kept so the recorded result can be replayed. */
function invalid(rawText: string): OrcCodexParseFailure {
  return { status: 'malformed', rawText, reason: 'codex result fields are invalid' }
}

/** Close the stage union. */
function assertNever(value: never): never {
  throw new Error(`unexpected Codex stage ${String(value)}`)
}
