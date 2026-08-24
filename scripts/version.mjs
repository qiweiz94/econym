#!/usr/bin/env node
/**
 * Bump every workspace package to the given version and rewrite their
 * cross-references. One command per release:
 *
 *   node scripts/version.mjs 0.1.0-rc.6
 *
 * Every econym package shares one lockstep version (pre-release stance: no
 * external consumers, so no independent versioning). The script rewrites each
 * package.json `version`, commits via the caller, and reminds about the tag.
 *
 * @module econym/scripts/version
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(version)) {
  process.stderr.write('usage: node scripts/version.mjs <version>   e.g. 0.1.0-rc.6\n')
  process.exit(1)
}

const dirs = [
  ...['arch-guard', 'ast-context', 'diagnostic-sifter', 'doc-sync-automator', 'impacted-tests',
    'pinned-scratchpad', 'semantic-patcher', 'subagent-router', 'telemetry-recorder', 'worktree-sandbox']
    .map(p => `packages/plugins/plugin-${p}`),
  'packages/guard/budget-governor',
]

let changed = 0
for (const dir of dirs) {
  const file = resolve(root, dir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  const before = pkg.version
  pkg.version = version
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  process.stdout.write(`${pkg.name}: ${before} -> ${version}\n`)
  changed++
}
process.stdout.write(`\n${changed} packages bumped to ${version}\n`)
process.stdout.write('next: git add -A && git commit -m "release: v' + version + '" && git tag v' + version + '\n')