import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWorkspaceIndex } from '../src/workspace-index.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write one fixture package.json under `root/relDir/package.json`. */
async function writeManifest(relDir: string, manifest: unknown): Promise<void> {
  const dir = join(root!, relDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
}

describe('buildWorkspaceIndex', () => {
  it('scans packages/<group>/<pkg> and vendor/<pkg> manifests into a keyed index', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-arch-guard-workspace-index-'))

    await writeManifest('packages/core/toolsfake', {
      name: '@deepseek-ai/dsh-toolsfake',
      exports: { '.': { default: './lib/index.js' }, './invariant': { default: './lib/invariant.js' } },
      dependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: { '@deepseek-ai/dsh-other': '^1.0.0' },
    })
    await writeManifest('packages/plugins/plugin-fake', {
      name: '@deepseek-ai/dsh-plugin-fake',
      exports: { '.': { default: './lib/index.js' } },
      peerDependencies: { '@deepseek-ai/dsh-toolsfake': 'workspace:^' },
    })
    await writeManifest('packages/other/nameless', {})
    await writeManifest('packages/other/no-exports-field', { name: '@deepseek-ai/dsh-no-exports-field' })
    await writeManifest('vendor/cordisfake', {
      name: '@deepseek-ai/cordis',
      exports: { '.': { default: './lib/index.js' }, './src/*': './src/*' },
    })

    const index = buildWorkspaceIndex(root)

    expect(index.packages.size).toBe(4)

    expect(index.packages.get('@deepseek-ai/dsh-no-exports-field')).toEqual({
      name: '@deepseek-ai/dsh-no-exports-field',
      group: 'other',
      dir: 'packages/other/no-exports-field',
      exports: [],
      dependsOn: [],
    })

    expect(index.packages.get('@deepseek-ai/dsh-toolsfake')).toEqual({
      name: '@deepseek-ai/dsh-toolsfake',
      group: 'core',
      dir: 'packages/core/toolsfake',
      exports: ['.', './invariant'],
      // The non-workspace-protocol devDependency range must not be treated as an in-repo edge.
      dependsOn: ['@deepseek-ai/cordis'],
    })

    expect(index.packages.get('@deepseek-ai/dsh-plugin-fake')).toEqual({
      name: '@deepseek-ai/dsh-plugin-fake',
      group: 'plugins',
      dir: 'packages/plugins/plugin-fake',
      exports: ['.'],
      dependsOn: ['@deepseek-ai/dsh-toolsfake'],
    })

    expect(index.packages.get('@deepseek-ai/cordis')).toEqual({
      name: '@deepseek-ai/cordis',
      group: 'vendor',
      dir: 'vendor/cordisfake',
      exports: ['.', './src/*'],
      dependsOn: [],
    })
  })
})
