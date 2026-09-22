/** Package-owned durable plan-mode invariants. @module @deepseek-ai/dsh-plan-mode/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-plan-mode'

/** Cordis companion plugin name. */
export const name = 'plan-mode-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one `plan/mode` or `plan/review` event before it reaches the durable log.
 * Both are standalone events: an idle selection commits between turns and a
 * mid-turn selection commits at the step boundary, so no turn-enclosure
 * relation exists — only the payload shape is checkable.
 */
const REVIEW_DECISIONS = new Set(['approved', 'rejected', 'dismissed'])

function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'plan/mode') {
    const active = (event.data as { active?: unknown }).active
    if (typeof active !== 'boolean') {
      fail(`plan/mode carries invalid active state ${JSON.stringify(active)}; expected a boolean`)
    }
    return
  }
  if (event.type !== 'plan/review') return
  const data = event.data as { version?: unknown; correlation?: unknown; decision?: unknown }
  if (data.version !== 1 || typeof data.correlation !== 'string' || data.correlation.length === 0
    || typeof data.decision !== 'string' || !REVIEW_DECISIONS.has(data.decision)) {
    fail(`plan/review carries invalid payload ${JSON.stringify(event.data)}; expected version 1, a correlation, and approved, rejected, or dismissed`)
  }
}

/** Install validation for loaded and newly appended plan-mode state. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const seed = (session: Session): void => {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents()) validateEvent(event, fail)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the plan-mode invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
