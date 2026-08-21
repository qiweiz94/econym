// Exercises the pure locator/transform and the on-disk patch writer directly.
// The fixtures cover each supported symbol shape, both failure modes that must
// name candidates, and the guarantee that a rejected patch leaves the original
// bytes on disk.
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applySymbolPatch,
  grammarFor,
  listSymbols,
  patchSymbolBody,
  resolveInsideRoot,
} from '../src/patcher.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write `source` to `name` inside a fresh temp root and return both paths. */
async function fixture(source: string, name: string = 'sample.ts'): Promise<{ root: string; path: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-semantic-patcher-'))
  const path = join(root, name)
  await writeFile(path, source)
  return { root, path }
}

const ts = grammarFor('sample.ts')

describe('applySymbolPatch symbol shapes', () => {
  it('replaces a top-level function body and leaves the rest of the file byte-identical', () => {
    const source = 'const before = 1\nexport function target(a: number) {\n  return a\n}\nconst after = 2\n'
    const { text, result } = applySymbolPatch(source, ts, 'target', '{\n  return 99\n}', 'sample.ts')
    expect(text).toBe('const before = 1\nexport function target(a: number) {\n  return 99\n}\nconst after = 2\n')
    expect(result).toEqual({ symbol: 'target', kind: 'function', line: 2, endLine: 4 })
  })

  it('replaces a class method body addressed by its bare name', () => {
    const source = 'export class Foo {\n  bar() { return 1 }\n}\n'
    const { text, result } = applySymbolPatch(source, ts, 'bar', '{ return 2 }', 'sample.ts')
    expect(text).toBe('export class Foo {\n  bar() { return 2 }\n}\n')
    expect(result).toEqual({ symbol: 'Foo.bar', kind: 'method', line: 2, endLine: 2 })
  })

  it('replaces an arrow function body bound by a lexical declaration', () => {
    const source = 'const handler = (a: number) => {\n  return a\n}\n'
    const { text, result } = applySymbolPatch(source, ts, 'handler', '{\n  return 0\n}', 'sample.ts')
    expect(text).toBe('const handler = (a: number) => {\n  return 0\n}\n')
    expect(result).toEqual({ symbol: 'handler', kind: 'arrow', line: 1, endLine: 3 })
  })

  it('replaces a concise arrow body, which is an expression rather than a block', () => {
    const { text, result } = applySymbolPatch('const twice = (a: number) => a * 2\n', ts, 'twice', 'a * 3', 'sample.ts')
    expect(text).toBe('const twice = (a: number) => a * 3\n')
    expect(result.kind).toBe('arrow')
  })

  it('replaces a var-bound function expression', () => {
    const { text } = applySymbolPatch('var legacy = function (a) { return a }\n', ts, 'legacy', '{ return 1 }', 'sample.ts')
    expect(text).toBe('var legacy = function (a) { return 1 }\n')
  })

  it('replaces a class field holding an arrow function', () => {
    const source = 'class Foo {\n  field = () => { return 1 }\n}\n'
    const { text, result } = applySymbolPatch(source, ts, 'Foo.field', '{ return 2 }', 'sample.ts')
    expect(text).toBe('class Foo {\n  field = () => { return 2 }\n}\n')
    expect(result.symbol).toBe('Foo.field')
  })

  it('patches a .tsx file through the TSX grammar', () => {
    const source = 'export function View() {\n  return <div>old</div>\n}\n'
    const { text } = applySymbolPatch(source, grammarFor('view.tsx'), 'View', '{\n  return <div>new</div>\n}', 'view.tsx')
    expect(text).toBe('export function View() {\n  return <div>new</div>\n}\n')
  })
})

describe('applySymbolPatch offset encoding', () => {
  // Tree-sitter reports UTF-16 code-unit offsets, not UTF-8 byte offsets.
  // Non-ASCII text before the target shifts the two apart, so a Buffer slice
  // would land off the body. This fixture fails loudly if that regresses.
  it('lands on the right span when multibyte text precedes the target', () => {
    const source = '// 中文注释 with an emoji 😀 above the target\nfunction target() { return 1 }\n'
    const { text } = applySymbolPatch(source, ts, 'target', '{ return 2 }', 'sample.ts')
    expect(text).toBe('// 中文注释 with an emoji 😀 above the target\nfunction target() { return 2 }\n')
  })

  it('preserves multibyte text that follows the patched body', () => {
    const source = 'function target() { return 1 }\nconst note = "尾部文字 🎉"\n'
    const { text } = applySymbolPatch(source, ts, 'target', '{ return 2 }', 'sample.ts')
    expect(text).toBe('function target() { return 2 }\nconst note = "尾部文字 🎉"\n')
  })
})

describe('applySymbolPatch failure modes', () => {
  it('fails loud with the candidate list when the symbol is not found', () => {
    const source = 'function alpha() {}\nclass Foo {\n  beta() {}\n}\n'
    expect(() => applySymbolPatch(source, ts, 'missing', '{}', 'sample.ts'))
      .toThrow(/no patchable symbol named "missing" in sample\.ts; candidates: alpha \(function\), Foo\.beta \(method\)/)
  })

  it('reports an empty file as declaring no patchable symbol', () => {
    expect(() => applySymbolPatch('const plain = 1\n', ts, 'plain', '{}', 'sample.ts'))
      .toThrow(/candidates: this file declares no patchable symbol/)
  })

  it('fails loud on an ambiguous bare name and lists the qualified candidates', () => {
    const source = 'class Foo {\n  run() {}\n}\nclass Bar {\n  run() {}\n}\n'
    expect(() => applySymbolPatch(source, ts, 'run', '{}', 'sample.ts'))
      .toThrow(/"run" is ambiguous in sample\.ts: 2 symbols match\. Disambiguate with one of: Foo\.run, Bar\.run/)
  })

  it('resolves an ambiguous bare name once it is qualified', () => {
    const source = 'class Foo {\n  run() { return 1 }\n}\nclass Bar {\n  run() { return 2 }\n}\n'
    const { text, result } = applySymbolPatch(source, ts, 'Bar.run', '{ return 3 }', 'sample.ts')
    expect(text).toBe('class Foo {\n  run() { return 1 }\n}\nclass Bar {\n  run() { return 3 }\n}\n')
    expect(result.symbol).toBe('Bar.run')
  })

  it('prefers an exact qualified match over a simple-name match elsewhere', () => {
    const source = 'function run() { return 1 }\nclass Foo {\n  run() { return 2 }\n}\n'
    const { result } = applySymbolPatch(source, ts, 'run', '{ return 3 }', 'sample.ts')
    expect(result.symbol).toBe('run')
    expect(result.kind).toBe('function')
  })

  it('refuses to locate a span inside a file that already has syntax errors', () => {
    expect(() => applySymbolPatch('function broken( {\n', ts, 'broken', '{}', 'sample.ts'))
      .toThrow(/sample\.ts does not parse as TypeScript/)
  })

  it('refuses a replacement body that would break the file', () => {
    expect(() => applySymbolPatch('function target() { return 1 }\n', ts, 'target', '{ return ( }', 'sample.ts'))
      .toThrow(/the patched sample\.ts \(left unchanged\) does not parse as TypeScript/)
  })
})

describe('listSymbols collection scope', () => {
  it('reports every supported shape and skips declarations with no function body', () => {
    const source = [
      'export function alpha() {}',
      'const beta = () => {}',
      'const plain = 1',
      'const { destructured } = plain',
      'let bare',
      'export default function () { return 1 }',
      'export class Foo {',
      '  gamma() {}',
      '  static delta() {}',
      '  epsilon = () => {}',
      '  typedField: string = "x"',
      '  untyped = 1',
      '  declare declared: number',
      '  static { }',
      '}',
      'interface Ignored { method(): void }',
      '',
    ].join('\n')
    expect(listSymbols(source, ts, 'sample.ts').map(entry => `${entry.kind} ${entry.name}`)).toEqual([
      'function alpha',
      'arrow beta',
      'method Foo.gamma',
      'method Foo.delta',
      'arrow Foo.epsilon',
    ])
  })

  it('reports the body span of each symbol, not the declaration span', () => {
    const [only] = listSymbols('function alpha() {\n  return 1\n}\n', ts, 'sample.ts')
    expect(only).toEqual({ name: 'alpha', kind: 'function', line: 1, endLine: 3 })
  })

  it('propagates a parse failure rather than returning a partial list', () => {
    expect(() => listSymbols('function broken( {\n', ts, 'sample.ts'))
      .toThrow(/sample\.ts does not parse as TypeScript/)
  })
})

describe('resolveInsideRoot repository guard', () => {
  it('accepts a relative path inside the root', () => {
    expect(resolveInsideRoot('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
  })

  it('accepts an absolute path inside the root', () => {
    expect(resolveInsideRoot('/repo', '/repo/src/a.ts')).toBe('/repo/src/a.ts')
  })

  it('rejects a relative path that escapes the root', () => {
    expect(() => resolveInsideRoot('/repo', '../outside/a.ts'))
      .toThrow(/refusing to patch \.\.\/outside\/a\.ts: the path resolves outside the repository root \/repo/)
  })

  it('rejects the parent directory itself', () => {
    expect(() => resolveInsideRoot('/repo', '..')).toThrow(/resolves outside the repository root/)
  })

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveInsideRoot('/repo', '/etc/passwd')).toThrow(/resolves outside the repository root/)
  })

  it('rejects the root itself, which is a directory rather than a file', () => {
    expect(() => resolveInsideRoot('/repo', '.')).toThrow(/resolves outside the repository root/)
  })

  it('rejects a sibling directory sharing the root name prefix', () => {
    expect(() => resolveInsideRoot('/repo', '/repo-evil/a.ts')).toThrow(/resolves outside the repository root/)
  })
})

describe('patchSymbolBody on disk', () => {
  it('commits an accepted patch and reports the replaced span', async () => {
    const { root: base, path } = await fixture('export function target() {\n  return 1\n}\n')
    const result = await patchSymbolBody({ root: base, path, symbol: 'target', newBody: '{\n  return 2\n}' })
    expect(result).toEqual({ path, symbol: 'target', kind: 'function', line: 1, endLine: 3 })
    expect(await readFile(path, 'utf8')).toBe('export function target() {\n  return 2\n}\n')
  })

  it('resolves a path relative to the configured root', async () => {
    const { root: base, path } = await fixture('function target() { return 1 }\n')
    await patchSymbolBody({ root: base, path: 'sample.ts', symbol: 'target', newBody: '{ return 2 }' })
    expect(await readFile(path, 'utf8')).toBe('function target() { return 2 }\n')
  })

  it('preserves the file permission bits across the atomic replacement', async () => {
    const { root: base, path } = await fixture('function target() { return 1 }\n')
    await chmod(path, 0o640)
    await patchSymbolBody({ root: base, path, symbol: 'target', newBody: '{ return 2 }' })
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  it('leaves the file byte-for-byte unchanged when the replacement would not parse', async () => {
    const original = 'function target() {\n  return 1\n}\n'
    const { root: base, path } = await fixture(original)
    await expect(patchSymbolBody({ root: base, path, symbol: 'target', newBody: '{ return ( }' }))
      .rejects.toThrow(/does not parse as TypeScript/)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('leaves the file unchanged when the symbol is ambiguous', async () => {
    const original = 'class Foo {\n  run() {}\n}\nclass Bar {\n  run() {}\n}\n'
    const { root: base, path } = await fixture(original)
    await expect(patchSymbolBody({ root: base, path, symbol: 'run', newBody: '{}' }))
      .rejects.toThrow(/is ambiguous/)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('refuses a path outside the root before it touches the filesystem', async () => {
    const { root: base } = await fixture('function target() {}\n')
    await expect(patchSymbolBody({ root: base, path: '../escape.ts', symbol: 'target', newBody: '{}' }))
      .rejects.toThrow(/resolves outside the repository root/)
  })

  it('refuses a file larger than maxBytes without reading it', async () => {
    const { root: base, path } = await fixture('function target() { return 1 }\n')
    await expect(patchSymbolBody({ root: base, path, symbol: 'target', newBody: '{}', maxBytes: 4 }))
      .rejects.toThrow(/file is \d+ bytes, exceeding the 4-byte patch limit/)
  })

  it('accepts a file within maxBytes', async () => {
    const { root: base, path } = await fixture('function target() { return 1 }\n')
    await patchSymbolBody({ root: base, path, symbol: 'target', newBody: '{ return 2 }', maxBytes: 1_000 })
    expect(await readFile(path, 'utf8')).toBe('function target() { return 2 }\n')
  })

  it('honours an abort signal raised before the read', async () => {
    const { root: base, path } = await fixture('function target() { return 1 }\n')
    const controller = new AbortController()
    controller.abort()
    await expect(patchSymbolBody({ root: base, path, symbol: 'target', newBody: '{}', signal: controller.signal }))
      .rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('function target() { return 1 }\n')
  })
})
