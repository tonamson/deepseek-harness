/**
 * Profile-named Grok CLI one-shot subagent provider. Each accepted run uses
 * the official `grok` executable from the configured subprocess execution
 * world, in the delegating Session's workspace.
 *
 * @module @deepseek-ai/dsh-subagent-grok
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_GROK_PERMISSION_MODE,
  DEFAULT_GROK_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  GROK_PERMISSION_MODES,
  grokStartupFailure,
  startGrokRun,
  type GrokPermissionMode,
  type GrokRunSpec,
} from './run.ts'

export const name = 'subagent-grok'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'grok'
const DEFAULT_COMMAND = 'grok'

/** Deployment-owned Grok executable, model, permission, and process settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `grok`). */
  providerName?: string
  /** Bare executable or absolute path resolved in the subprocess execution world. */
  command?: string
  /** Native Grok model fixed for this provider instance; omitted to inherit Grok settings. */
  model?: string
  /** Native Grok reasoning effort fixed for this provider instance; omitted to inherit Grok settings. */
  reasoningEffort?: string
  /** Explicit environment layered over the subprocess seam's credential scrub. */
  env?: Record<string, string>
  /** Native non-interactive Grok permission mode. */
  permissionMode?: GrokPermissionMode
  /** Wall-clock bound for version check and one delegated task. */
  timeoutMs?: number
  /** Grace in milliseconds between managed-range termination tiers. */
  disposeGraceMs?: number
  /** Maximum final stdout bytes retained for the parent Session. */
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  command: z.string().min(1).default(DEFAULT_COMMAND),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...GROK_PERMISSION_MODES])
    .default(DEFAULT_GROK_PERMISSION_MODE),
  timeoutMs: z.number().default(DEFAULT_GROK_TIMEOUT_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'reasoningEffort'>
  & Pick<Config, 'model' | 'reasoningEffort'>

class GrokProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-grok: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd('subagent-grok', undefined, parentCwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error('subagent-grok: request was aborted before CLI startup')
      }
      const failure = grokStartupFailure(error)
      this.ctx.logger.warn(
        `subagent-grok "${this.name}": child start failed: ${failure.message}`,
      )
      throw failure
    }

    const spec: GrokRunSpec = {
      command: this.config.command,
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      ...this.config.reasoningEffort === undefined ? {} : { reasoningEffort: this.config.reasoningEffort },
      permissionMode: this.config.permissionMode,
      timeoutMs: this.config.timeoutMs,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      maxOutputBytes: this.config.maxOutputBytes,
      resolveExecutable: (command, env, signal) => this.ctx.subprocess.resolveExecutable(command, env, signal),
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onStderr: (text) => {
        try {
          this.ctx.logger.debug(`subagent-grok "${this.name}" stderr: ${text}`)
        } catch {
          // Host logging cannot replace a child result.
        }
      },
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-grok "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startGrokRun(request, spec)
  }
}

/**
 * Register one Profile-named Grok CLI provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - executable, registry name, native settings, and process policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    command: config.command ?? DEFAULT_COMMAND,
    ...config.model === undefined ? {} : { model: config.model },
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_GROK_PERMISSION_MODE,
    timeoutMs: config.timeoutMs as number,
    disposeGraceMs: config.disposeGraceMs as number,
    maxOutputBytes: config.maxOutputBytes as number,
  }
  assertPositiveFinite('subagent-grok', 'timeoutMs', resolved.timeoutMs)
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-grok: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  assertPositiveFinite('subagent-grok', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-grok: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (!Number.isSafeInteger(resolved.maxOutputBytes) || resolved.maxOutputBytes <= 0) {
    throw new Error('subagent-grok: maxOutputBytes must be a positive safe integer')
  }
  ctx.subagents.registerProvider(new GrokProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
