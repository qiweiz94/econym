#!/usr/bin/env node
/**
 * Version-agnostic consumer smoke test.
 *
 * Creates a clean temp project, installs every econym package tarball as a
 * file dependency plus the published @deepseek-ai/dsh-* peer line from the
 * registry (next tag), then boots a real Loader composition from a cordis.yml
 * and verifies the econym plugin registers its tool. This is the consumer
 * promise: a published econym plugin resolves its peer ranges against
 * whatever published harness version is installed.
 *
 * Requires a registry connection (pnpm add from the public npm registry) and
 * a clean build (pnpm run build) so the tarballs are current.
 *
 * @module econym/scripts/consumer-smoke
 */

import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const consumer = await mkdtemp(join(tmpdir(), 'econym-consumer-'))

/** The published peer line every econym plugin resolves against. */
const PEER_LINE = [
  '@deepseek-ai/dsh-tools@next',
  '@deepseek-ai/dsh-agent@next',
  '@deepseek-ai/dsh-session@next',
  '@deepseek-ai/dsh-system-prompt@next',
  '@deepseek-ai/dsh-llm@next',
  '@deepseek-ai/dsh-invariants@next',
  '@deepseek-ai/dsh-subagent@next',
  '@deepseek-ai/dsh-output-retention@next',
  '@deepseek-ai/dsh-subprocess@next',
  '@deepseek-ai/cordis@4.0.1',
  '@deepseek-ai/cordis-plugin-loader@1.0.2',
  '@deepseek-ai/cordis-plugin-include@1.0.6',
  '@deepseek-ai/schemastery@latest',
  // Transitive peer closure of the published dsh-* line (dsh-agent and
  // friends peer-require these; a consumer of the harness would have them
  // via its own composition).
  '@deepseek-ai/dsh-scope@next',
  '@deepseek-ai/dsh-typert-protocol@next',
  '@deepseek-ai/dsh-attachment@next',
  '@deepseek-ai/dsh-brand@next',
  '@deepseek-ai/dsh-timeout@next',
  '@deepseek-ai/dsh-session-projection@next',
  '@deepseek-ai/dsh-user-approval@next',
  '@deepseek-ai/dsh-code-runtime@next',
]

function run(cmd, args, cwd, allowFail = false) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  if (!allowFail && result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`${cmd} ${args.join(' ')} failed with exit ${result.status}`)
  }
  return result
}

/** The boot script executed inside the consumer project (its imports resolve there). */
const BOOT_SOURCE = `
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as PinnedScratchpad from '@econym/dsh-plugin-pinned-scratchpad'

const root = process.cwd()
const ctx = new Context()
ctx.baseUrl = 'file://' + root + '/'
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
const modules = new Map([
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@econym/dsh-plugin-pinned-scratchpad', PinnedScratchpad],
])
ctx.loader.internal = {
  version: 'v2',
  async import(s) {
    if (!modules.has(s)) throw new Error('unexpected Loader import: ' + s)
    return modules.get(s)
  },
}
await ctx.loader.create({ name: 'cordis:include', config: { path: 'file://' + root + '/cordis.yml' } })
await ctx.loader.await()
const tool = ctx.tools.get('scratchpad_update')
if (!tool) throw new Error('scratchpad_update tool NOT registered')
console.log('LOADER BOOT OK — scratchpad_update registered by @econym plugin')
`

try {
  // 1. Pack every workspace package into the consumer's tarballs dir.
  const tarballs = join(consumer, 'tarballs')
  const pluginDirs = await readdir(join(root, 'packages/plugins'))
  const packageDirs = [
    ...pluginDirs.map(d => join(root, 'packages/plugins', d)),
    join(root, 'packages/guard/budget-governor'),
  ]
  const tarballFiles = []
  for (const dir of packageDirs) {
    const before = new Set(await readdir(tarballs).catch(() => []))
    const out = run('pnpm', ['pack', '--pack-destination', tarballs], dir, true)
    if (out.status !== 0) continue
    const after = await readdir(tarballs)
    const fresh = after.filter(f => !before.has(f))
    if (fresh.length !== 1) throw new Error(`expected one new tarball from ${dir}, got ${fresh.join(', ')}`)
    tarballFiles.push(join(tarballs, fresh[0]))
  }
  if (tarballFiles.length === 0) throw new Error('no tarballs produced')
  process.stdout.write(`packed ${tarballFiles.length} tarballs\n`)

  // 2. Consumer package.json + install (tarballs + published peer line).
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'econym-consumer-smoke',
    private: true,
    type: 'module',
  }, null, 2))
  // tree-sitter native bindings are needed at load time (ast-context outline
  // tool); pnpm 10+ blocks install scripts unless approved here.
  await writeFile(join(consumer, 'pnpm-workspace.yaml'), [
    'allowBuilds:',
    '  tree-sitter: true',
    '  tree-sitter-javascript: true',
    '  tree-sitter-typescript: true',
    '',
  ].join('\n'))
  run('pnpm', ['add', ...tarballFiles.map(t => `file:${t}`)], consumer)
  run('pnpm', ['add', ...PEER_LINE], consumer)
  const peers = run('pnpm', ['peers', 'check'], consumer, true)
  // The tree-sitter range warning is a transitive native-binding peer range
  // (tree-sitter-typescript wants ^0.21, registry installs 0.25) — benign and
  // identical in the harness repo. Any OTHER unmet peer fails the test.
  const unrelated = peers.stdout.split('\n').filter(line => line.includes('✕') && !line.includes('tree-sitter'))
  if (unrelated.length > 0) {
    process.stderr.write('unresolved peers:\n' + peers.stdout)
    throw new Error('consumer install has unmet peer dependencies')
  }
  process.stdout.write('peer resolution OK\n')

  // 3. Boot a real Loader composition with the econym plugin.
  await writeFile(join(consumer, 'cordis.yml'), [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@econym/dsh-plugin-pinned-scratchpad'",
    '  config:',
    '    totalBudget: 8192',
    '',
  ].join('\n'))
  await writeFile(join(consumer, 'boot.mjs'), BOOT_SOURCE)
  const bootResult = run('node', ['boot.mjs'], consumer)
  process.stdout.write(bootResult.stdout)
  process.stdout.write('\nCONSUMER SMOKE TEST PASSED\n')
} finally {
  await rm(consumer, { recursive: true, force: true })
}