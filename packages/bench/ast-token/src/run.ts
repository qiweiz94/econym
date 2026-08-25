/**
 * CLI runner: measure the AST-guided read path against naive full reads over
 * the bundled fixtures and print a table. Run with `pnpm bench` from this
 * package, or `pnpm --filter @econym/bench-ast-token bench` from the root.
 *
 * @module @econym/bench-ast-token/run
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureFile, formatResult } from './measure.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export async function run(): Promise<void> {
  const files = (await readdir(fixturesDir)).filter(f => f.endsWith('.ts'))
  const results = []
  for (const file of files) {
    const text = await readFile(join(fixturesDir, file), 'utf8')
    results.push(measureFile(file, text))
  }
  const totalNaive = results.reduce((sum, r) => sum + r.naiveTokens, 0)
  const totalGuided = results.reduce((sum, r) => sum + r.guidedTokens, 0)
  const overall = ((totalNaive - totalGuided) / totalNaive) * 100

  for (const r of results) console.log(formatResult(r))
  console.log(`\noverall  ${totalNaive} → ${totalGuided} tokens, ${overall.toFixed(1)}% saved across ${results.length} files`)
  console.log('note: tokens are a chars/4 estimate — a reproducible local yardstick, not provider-billed spend.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
