import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectTypeScriptFiles } from '../src/directory.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function tree(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ast-directory-'))
  const dirs = ['a', 'b', 'b/c', '.hidden', 'node_modules', 'b/.hidden-inner']
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(root, 'a', 'one.ts'), 'export function one() {}\n')
  await writeFile(join(root, 'a', 'two.tsx'), 'export function two() {}\n')
  await writeFile(join(root, 'b', 'three.ts'), 'export function three() {}\n')
  await writeFile(join(root, 'b', 'c', 'four.ts'), 'export function four() {}\n')
  await writeFile(join(root, 'b', 'readme.md'), 'not typescript\n')
  await writeFile(join(root, 'b', 'data.json'), '{}')
  await writeFile(join(root, '.hidden', 'five.ts'), 'export function five() {}\n')
  await writeFile(join(root, '.hidden', 'other.txt'), 'text')
  await writeFile(join(root, 'node_modules', 'six.ts'), 'export function six() {}\n')
  await writeFile(join(root, 'b', '.hidden-inner', 'seven.ts'), 'export function seven() {}\n')
  await symlink(join(root, 'a'), join(root, 'b', 'loop'))
  return root
}

describe('collectTypeScriptFiles', () => {
  it('collects nested .ts and .tsx files in path order, skipping hidden entries, node_modules, and non-TypeScript files', async () => {
    const rootDir = await tree()
    const collected = await collectTypeScriptFiles(rootDir, 200)
    expect(collected.files).toEqual([
      join(rootDir, 'a', 'one.ts'),
      join(rootDir, 'a', 'two.tsx'),
      join(rootDir, 'b', 'c', 'four.ts'),
      join(rootDir, 'b', 'three.ts'),
    ])
    expect(collected.overLimit).toBe(0)
  })

  it('does not follow symlinked directories', async () => {
    const rootDir = await tree()
    const collected = await collectTypeScriptFiles(join(rootDir, 'b'), 200)
    expect(collected.files.some(file => file.includes('loop'))).toBe(false)
    expect(collected.files).toEqual([
      join(rootDir, 'b', 'c', 'four.ts'),
      join(rootDir, 'b', 'three.ts'),
    ])
  })

  it('caps the collection at maxFiles and counts the rest as overLimit', async () => {
    const rootDir = await tree()
    const collected = await collectTypeScriptFiles(rootDir, 2)
    expect(collected.files).toEqual([
      join(rootDir, 'a', 'one.ts'),
      join(rootDir, 'a', 'two.tsx'),
    ])
    expect(collected.overLimit).toBe(2)
  })

  it('collects nothing from an empty directory', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-ast-directory-empty-'))
    root = empty
    const collected = await collectTypeScriptFiles(empty, 200)
    expect(collected.files).toEqual([])
    expect(collected.overLimit).toBe(0)
  })
})
