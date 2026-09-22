import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_GROK_PERMISSION_MODE,
  DEFAULT_GROK_TIMEOUT_MS,
  grokArgv,
  parseGrokVersion,
  startGrokRun,
  type GrokRunSpec,
} from '../src/run.ts'

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(signal = new AbortController().signal) {
  return {
    prompt: [{ type: 'text', text: 'Inspect the task' }] satisfies ContentBlock[],
    parent: fakeParent,
    signal,
  }
}

function reader(text: string): SubprocessOutputReader {
  return {
    readFrom: () => ({
      text,
      nextOffset: Buffer.byteLength(text),
      lossy: false,
    }),
  }
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly terminate: ReturnType<typeof vi.fn>
}

function child(options: {
  readonly stdout?: string
  readonly stderr?: string
  readonly pending?: boolean
} = {}): FakeChild {
  let resolveDone!: (outcome: SubprocessOutcome) => void
  const done = new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
  const settle = (outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void => {
    resolveDone(outcome)
  }
  const terminate = vi.fn(() => { settle() })
  if (!options.pending) settle()
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: reader(options.stdout ?? ''),
      stderr: reader(options.stderr ?? ''),
    },
    done,
    terminate,
    waitForExit: async () => true,
  }
  return { handle, settle, terminate }
}

function spec(
  children: readonly FakeChild[],
  spawned: SubprocessSpawnSpec[],
  overrides: Partial<GrokRunSpec> = {},
): GrokRunSpec {
  let index = 0
  return {
    command: 'grok',
    cwd: process.cwd(),
    permissionMode: DEFAULT_GROK_PERMISSION_MODE,
    timeoutMs: DEFAULT_GROK_TIMEOUT_MS,
    env: {},
    disposeGraceMs: 3_000,
    resolveExecutable: async command => command,
    spawn: (spawnSpec) => {
      spawned.push(spawnSpec)
      const next = children[index++]
      if (next === undefined) throw new Error('unexpected child spawn')
      return next.handle
    },
    onStderr: vi.fn(),
    ...overrides,
    maxOutputBytes: overrides.maxOutputBytes ?? 1_048_576,
  }
}

describe('Grok subagent run', () => {
  it('builds a non-interactive single-turn CLI invocation', () => {
    expect(grokArgv({
      command: 'grok',
      cwd: '/workspace',
      prompt: 'Inspect the task',
      model: 'grok-code-fast-1',
      reasoningEffort: 'high',
      permissionMode: 'dontAsk',
    })).toEqual([
      'grok',
      '--single',
      'Inspect the task',
      '--output-format',
      'plain',
      '--cwd',
      '/workspace',
      '--permission-mode',
      'dontAsk',
      '--model',
      'grok-code-fast-1',
      '--reasoning-effort',
      'high',
      '--no-subagents',
    ])
  })

  it('parses the installed 1.0.40 runtime and rejects malformed output', () => {
    expect(parseGrokVersion('grok 1.0.40 (eb1a2256660d) [stable]\n')).toBe('1.0.40')
    expect(parseGrokVersion('grok 1.0.39 (old) [stable]\n')).toBe('1.0.39')
    expect(parseGrokVersion('unexpected output')).toBeUndefined()
  })

  it('checks the CLI, returns stdout, and keeps stderr in the Host sink', async () => {
    const spawned: SubprocessSpawnSpec[] = []
    const stderr: string[] = []
    const run = await startGrokRun(
      request(),
      spec([
        child({ stdout: 'grok 1.0.40 (sha) [stable]\n', stderr: 'version warning\n' }),
        child({ stdout: 'final answer\n', stderr: 'tool diagnostic\n' }),
      ], spawned, { onStderr: (text) => { stderr.push(text) } }),
    )

    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'final answer\n' }],
      stopReason: 'completed',
    })
    expect(stderr).toEqual(['version warning\n', 'tool diagnostic\n'])
    expect(spawned.map(item => item.argv)).toEqual([
      ['grok', '--version'],
      [
        'grok', '--single', 'Inspect the task', '--output-format', 'plain',
        '--cwd', process.cwd(), '--permission-mode', 'dontAsk', '--no-subagents',
      ],
    ])
    await run.dispose()
  })

  it('does not start the task when the runtime version is unsupported', async () => {
    const spawned: SubprocessSpawnSpec[] = []
    await expect(startGrokRun(
      request(),
      spec([child({ stdout: 'grok 1.0.39\n' })], spawned),
    )).rejects.toThrow('stage: version')
    expect(spawned).toHaveLength(1)
  })

  it('terminates the task when the caller cancels', async () => {
    const controller = new AbortController()
    const spawned: SubprocessSpawnSpec[] = []
    const task = child({ pending: true })
    const run = await startGrokRun(
      request(controller.signal),
      spec([child({ stdout: 'grok 1.0.40\n' }), task], spawned),
    )

    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    expect(task.terminate).toHaveBeenCalled()
    await run.dispose()
  })
})
