/** ORC invariant companion. It checks `orc/*` events against the committed session prefix. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { applyOrc, emptyOrcState, isOrcEventType } from './projection.ts'
import type { OrcState } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-orc'

/** Cordis companion plugin name. */
export const name = 'orc-invariant'

/** Invariant registry required by the companion. */
export const inject = ['invariants']

interface LoggedEvent {
  readonly type: string
  readonly data: unknown
}

interface LoggedSession {
  snapshotEvents(): readonly LoggedEvent[]
}

/** Fold committed `orc/*` events. Events outside that namespace stay out of the fold. */
function committedOrcState(events: readonly LoggedEvent[]): OrcState {
  return events.reduce<OrcState>((state, event) => {
    if (!isOrcEventType(event.type)) return state
    return applyOrc(state, { type: event.type, data: event.data })
  }, emptyOrcState())
}

/**
 * Reject an `orc/*` candidate that the projection refuses.
 * @param ctx - child context owned by the invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [logged, event] = args as [LoggedSession, LoggedEvent | undefined]
    if (event === undefined || !isOrcEventType(event.type)) return
    const prior = committedOrcState(logged.snapshotEvents())
    if (prior.failure !== undefined) {
      fail(`session ORC prefix violates the ORC stream: ${prior.failure}`)
    }
    const next = applyOrc(prior, { type: event.type, data: event.data })
    if (next.failure !== undefined) {
      fail(`ORC event ${event.type} violates the ORC stream: ${next.failure}`)
    }
  }, { global: true })
}

/**
 * Register the package invariant companion.
 * @param ctx - root context that owns the invariant registry.
 * @returns a disposer for this registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
