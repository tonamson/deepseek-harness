/** The shipped Web patch declares the migrated coding preset and its optional routes. */
import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

interface Entry {
  id: string
  name: string
  disabled?: boolean
  config?: EntryConfig | Entry[]
}

interface EntryConfig {
  id?: string
  prefix?: string
  provider?: string
  toolName?: string
  plugins?: Entry[]
}

function fields(entry: Entry | undefined): EntryConfig {
  return entry?.config && !Array.isArray(entry.config) ? entry.config : {}
}

function myCodingPreset(): Entry {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dsh: { bundle: { patch: string[] } }
  }
  expect(manifest.dsh.bundle.patch).toContain('./presets/standard.patch.yml')
  const patch = yaml.load(
    readFileSync(new URL('../presets/standard.patch.yml', import.meta.url), 'utf8'),
    { schema: entryListSchema },
  ) as Array<{ insert: Entry[] }>
  const rows = patch.flatMap(operation => operation.insert ?? [])
  expect(rows.map(row => row.id)).toContain('preset-standard')
  const preset = rows.find(row => row.id === 'preset-my-coding')
  expect(preset).toBeDefined()
  return preset!
}

describe('my-coding Web preset', () => {
  it('ships as a selectable declaration with the DeepSeek supervisor instructions', () => {
    const preset = myCodingPreset()
    expect(preset.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(fields(preset).id).toBe('my-coding')
    const persona = fields(preset).plugins?.find(row => row.id === 'persona')
    expect(fields(persona).prefix).toContain('coding supervisor')
    expect(fields(persona).prefix).toContain('orc_request_spec_plan')
    expect(fields(persona).prefix).toContain('DeepSeek Lead and Peer')
  })

  it('grants distinct Codex spec, review, audit and requested Grok delegation tools', () => {
    const delegation = fields(myCodingPreset()).plugins?.find(row => row.id === 'delegation')
    const tools = Array.isArray(delegation?.config) ? delegation.config : []
    expect(tools.filter(row => row.name === '@deepseek-ai/dsh-tool-subagent' && fields(row).provider?.startsWith('codex-'))
      .map(row => [fields(row).provider, fields(row).toolName, row.disabled])).toEqual([
      ['codex-spec', 'subagent_codex_spec', undefined],
      ['codex-review', 'subagent_codex_review', undefined],
      ['codex-audit', 'subagent_codex_audit', undefined],
    ])
    expect(tools.find(row => row.id === 'tool-subagent-grok')).toMatchObject({
      config: { provider: 'grok', toolName: 'subagent_grok' },
    })
  })
})
