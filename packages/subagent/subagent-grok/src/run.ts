/**
 * One-shot Grok CLI lifecycle: resolve the official host executable, verify its
 * pinned version, run one non-interactive prompt, and publish only its final
 * stdout text through the shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-grok/run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  deadline,
  type Deadline,
} from '@deepseek-ai/dsh-timeout'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** The Grok CLI version this provider has been tested against. */
export const GROK_CLI_VERSION = '1.0.40'

/** Grok CLI permission modes that do not require a human interaction. */
export const GROK_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const

/** Native Grok permission mode accepted by a provider instance. */
export type GrokPermissionMode = typeof GROK_PERMISSION_MODES[number]

/** Safe default for unattended Grok CLI runs. */
export const DEFAULT_GROK_PERMISSION_MODE: GrokPermissionMode = 'dontAsk'

/** Default wall-clock bound for one Grok CLI delegation. */
export const DEFAULT_GROK_TIMEOUT_MS = 300_000

/** Default grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Default maximum final stdout bytes retained for the parent Session. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576

interface GrokArgvInput {
  readonly command: string
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly permissionMode: GrokPermissionMode
}

/**
 * Build one explicit, non-interactive Grok CLI invocation.
 * @param input - executable, workspace, task, and native run settings.
 * @returns argv passed directly to the subprocess service.
 */
export function grokArgv(input: GrokArgvInput): string[] {
  return [
    input.command,
    '--single', input.prompt,
    '--output-format', 'plain',
    '--cwd', input.cwd,
    '--permission-mode', input.permissionMode,
    ...(input.model === undefined ? [] : ['--model', input.model]),
    ...(input.reasoningEffort === undefined ? [] : ['--reasoning-effort', input.reasoningEffort]),
    '--no-subagents',
  ]
}

/**
 * Extract the semantic version from `grok --version` output.
 * @param output - stdout returned by the host executable.
 * @returns the parsed version, or `undefined` when the output is not Grok CLI output.
 */
export function parseGrokVersion(output: string): string | undefined {
  return /^\s*grok\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?)(?:\s|$)/m.exec(output)?.[1]
}

/**
 * Validate a one-shot text task before crossing the CLI process boundary.
 * @param prompt - content blocks accepted from the shared subagent service.
 * @returns the exact concatenated task text.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-grok: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-grok: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-grok: the one-shot task must not be empty')
  }
  return texts.join('')
}

/** Fully resolved inputs for one Grok CLI run. */
export interface GrokRunSpec {
  /** Bare executable name or configured absolute Grok CLI path. */
  readonly command: string
  /** Parent Session workspace supplied to the CLI. */
  readonly cwd: string
  /** Profile-selected native Grok model; omitted to preserve native settings. */
  readonly model?: string
  /** Profile-selected native Grok reasoning effort; omitted to preserve native settings. */
  readonly reasoningEffort?: string
  /** Profile-selected non-interactive permission mode. */
  readonly permissionMode: GrokPermissionMode
  /** Wall-clock deadline for version check and task execution. */
  readonly timeoutMs: number
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Executable resolution in the subprocess provider's execution world. */
  readonly resolveExecutable: (
    command: string,
    env: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ) => Promise<string>
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Host-only stderr sink; never included in the model-visible result. */
  readonly onStderr?: (text: string) => void
  /** Host diagnostic sink for a product failure. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
  /** Maximum retained stdout bytes for a successful answer. */
  readonly maxOutputBytes: number
}

type GrokFailureStage = 'resolve' | 'version' | 'run' | 'process' | 'teardown'
type GrokFailureCategory = 'version' | 'invalid-result' | 'process' | 'unknown'

interface GrokFailureFacts {
  readonly stage: GrokFailureStage
  readonly category: GrokFailureCategory
  readonly outcome?: SubprocessOutcome
}

function failureDiagnostic(facts: GrokFailureFacts): string {
  const fields = [
    'product: Grok CLI',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== undefined) {
    fields.push(`exit code: ${facts.outcome.exitCode}`)
  }
  if (facts.outcome?.signal !== null && facts.outcome?.signal !== undefined) {
    fields.push(`signal: ${facts.outcome.signal}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class GrokFailure extends Error {
  constructor(
    readonly facts: GrokFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-grok: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'GrokFailure'
  }
}

/**
 * Convert an unpublished startup failure into a safe fixed diagnostic.
 * @param cause - host-side failure retained only on the Error cause chain.
 * @returns a safe startup error.
 */
export function grokStartupFailure(cause: unknown): Error {
  return new GrokFailure({ stage: 'resolve', category: 'unknown' }, cause)
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function collectedText(child: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  const read = child.collected[stream]?.readFrom(0)
  if (read === undefined) return ''
  if (read.lossy) {
    throw new GrokFailure({
      stage: stream === 'stdout' ? 'run' : 'process',
      category: 'invalid-result',
    })
  }
  return read.text
}

function reportStderr(spec: GrokRunSpec, child: SubprocessHandle): void {
  const read = child.collected.stderr?.readFrom(0)
  if (read === undefined || read.text.length === 0) return
  try {
    spec.onStderr?.(read.text)
  } catch {
    // Host diagnostics cannot replace the product result or failure.
  }
}

interface CommandResult {
  readonly child: SubprocessHandle
  readonly outcome: SubprocessOutcome
  readonly stdout: string
}

async function runCommand(
  spec: GrokRunSpec,
  argv: readonly string[],
  signal: AbortSignal,
  stage: 'version' | 'run',
): Promise<CommandResult> {
  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv,
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: spec.maxOutputBytes },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: spec.disposeGraceMs,
      signal,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new GrokFailure({ stage, category: 'unknown' }, thrown(error))
  }

  try {
    const outcome = await child.done
    reportStderr(spec, child)
    return {
      child,
      outcome,
      stdout: collectedText(child, 'stdout'),
    }
  } catch (error: unknown) {
    try {
      reportStderr(spec, child)
    } catch {
      // A failed diagnostic read must not hide the process failure.
    }
    child.terminate()
    await child.waitForExit().catch(() => {})
    if (error instanceof GrokFailure) throw error
    throw new GrokFailure({ stage, category: 'unknown' }, thrown(error))
  }
}

function assertSuccessfulOutcome(outcome: SubprocessOutcome): void {
  if (outcome.exitCode === 0 && outcome.signal === null) return
  throw new GrokFailure({ stage: 'process', category: 'process', outcome })
}

function abortError(message: string): Error {
  return new Error(`subagent-grok: ${message}`)
}

/**
 * Start one verified Grok CLI child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - executable, workspace, native settings, and process policy.
 * @returns the published run after version validation and task spawn.
 */
export async function startGrokRun(
  request: SubagentStartRequest,
  spec: GrokRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw abortError('request was aborted before CLI startup')
  }

  const timeout: Deadline = deadline(request.signal, spec.timeoutMs, 'GROK_TIMEOUT')
  let executable: string
  let child: SubprocessHandle
  try {
    executable = await spec.resolveExecutable(spec.command, spec.env, timeout.signal)
    const version = await runCommand(spec, [executable, '--version'], timeout.signal, 'version')
    assertSuccessfulOutcome(version.outcome)
    if (parseGrokVersion(version.stdout) !== GROK_CLI_VERSION) {
      throw new GrokFailure({ stage: 'version', category: 'version' })
    }
    if (timeout.signal.aborted) {
      throw abortError('request was aborted before CLI publication')
    }
    child = spec.spawn({
      argv: grokArgv({
        command: executable,
        cwd: spec.cwd,
        prompt,
        ...spec.model === undefined ? {} : { model: spec.model },
        ...spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort },
        permissionMode: spec.permissionMode,
      }),
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: spec.maxOutputBytes },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: spec.disposeGraceMs,
      signal: timeout.signal,
      env: spec.env,
    })
  } catch (error: unknown) {
    timeout[Symbol.dispose]()
    if (timeout.signal.aborted || request.signal.aborted) {
      throw abortError('request was aborted before CLI publication')
    }
    if (error instanceof GrokFailure) throw error
    throw grokStartupFailure(error)
  }

  const requestCancel = (): void => {
    child.terminate()
  }
  const onAbort = (): void => { requestCancel() }
  const onTimeout = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  timeout.signal.addEventListener('abort', onTimeout, { once: true })

  let diagnostic: string | undefined
  const collectOutput = (): ContentBlock[] => {
    try {
      const output = collectedText(child, 'stdout')
      return output.length === 0 ? [] : [{ type: 'text', text: output }]
    } catch {
      return []
    }
  }
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async (): Promise<SubagentResult> => {
      try {
        const outcome = await child.done
        reportStderr(spec, child)
        const output = collectedText(child, 'stdout')
        assertSuccessfulOutcome(outcome)
        if (output.trim().length === 0) {
          throw new GrokFailure({ stage: 'run', category: 'invalid-result', outcome })
        }
        return {
          output: [{ type: 'text', text: output }],
          stopReason: 'completed',
        }
      } catch (error: unknown) {
        if (error instanceof GrokFailure) {
          diagnostic = failureDiagnostic(error.facts)
          throw error
        }
        const failure = new GrokFailure({ stage: 'process', category: 'unknown' }, thrown(error))
        diagnostic = failureDiagnostic(failure.facts)
        throw failure
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => timeout.signal.aborted || request.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      try {
        requestCancel()
        await child.waitForExit()
        await child.done.catch(() => {})
      } catch (error: unknown) {
        const failure = new GrokFailure({ stage: 'teardown', category: 'unknown' }, thrown(error))
        spec.onError?.(failure, 'error')
        throw failure
      } finally {
        request.signal.removeEventListener('abort', onAbort)
        timeout.signal.removeEventListener('abort', onTimeout)
        timeout[Symbol.dispose]()
      }
    },
  })
}
