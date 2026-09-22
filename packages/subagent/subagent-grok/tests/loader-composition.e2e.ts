import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS = 60_000
const PRODUCTION_PROFILE_TEST_TIMEOUT_MS = PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS + 15_000

const fixtureDir = fileURLToPath(new URL('./fixtures/loader/', import.meta.url))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'grok.patch.yml')
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  dsh?: { bundle?: { patch?: string } }
}
const bundlePatch = manifest.dsh?.bundle?.patch
if (bundlePatch === undefined) throw new Error('Grok package must declare a Bundle patch')
const bundlePatchPath = join(packageDir, bundlePatch)
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('Grok provider public Loader composition', () => {
  it('loads the Bundle default, named instances, and their tools without starting Grok', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'subagent-grok Loader composition',
      tempDirPrefix: 'dsh-subagent-grok-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, bundlePatchPath],
      tsconfigPath: repoTsconfig,
      processTimeoutMs: PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS,
      env: {
        // Loading the optional package must not resolve or start a Grok binary.
        PATH: '',
      },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      providers: ['grok', 'grok-primary', 'grok-secondary'],
      providerDetails: [
        'grok',
        'grok-primary',
        'grok-secondary',
      ].map(name => ({
        name,
        capabilities: {
          agentOptions: false,
          outputSchema: false,
          depthLimit: false,
          toolFilter: false,
          persona: false,
        },
        inheritsParentContext: false,
      })),
      tools: [
        'subagent_grok',
        'subagent_grok_primary',
        'subagent_grok_secondary',
      ].map(name => ({
        name,
        parameterNames: ['description', 'prompt', 'run_in_background'],
        required: ['description', 'prompt'],
      })),
      jobTools: ['job_kill', 'job_list', 'job_output'],
      starts: 0,
    })
  }, PRODUCTION_PROFILE_TEST_TIMEOUT_MS)
})
