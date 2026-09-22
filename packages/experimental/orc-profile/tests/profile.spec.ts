/** The experimental bundle must carry one parseable ORC layer. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('ORC profile bundle', () => {
  it('declares a public patch with the configured routes', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-orc': 'workspace:^',
      '@deepseek-ai/dsh-experimental-tool-orc': 'workspace:^',
    })
    const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'), { schema: entryListSchema })
    const inserted = (parsed as { insert?: { id?: string; name?: string }[] }[]).flatMap(entry => entry.insert ?? [])
    expect(inserted.map(entry => entry.id)).toEqual(['orc', 'tool-orc'])
    expect(inserted.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh-experimental-orc',
      '@deepseek-ai/dsh-experimental-tool-orc',
    ])
  })
})
