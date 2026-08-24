/**
 * Directory walker for `get_directory_outline`: collect the TypeScript files
 * of a tree in path order, bounded by a file cap, without following symlinks.
 * @module @econym/dsh-plugin-ast-context/directory
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileOutlineResult, SymbolEntry } from './types.ts'

/** A collected file plus the aggregate count of candidates cut off by the cap. */
export interface CollectedFiles {
  /** Repo-relative TypeScript file paths, in path order. */
  readonly files: readonly string[]
  /** Candidates not collected because the cap was reached. */
  readonly overLimit: number
}

/**
 * Recursively collect the `.ts`/`.tsx` files of a tree, in path order.
 * Hidden entries and `node_modules` are skipped entirely; symlinked
 * directories are not followed (a symlink loop would otherwise recurse
 * forever). The first `maxFiles` paths are collected; the remainder is
 * counted in `overLimit`, so the model knows the outline is partial.
 * @param root - the directory to walk, relative to the process cwd.
 * @param maxFiles - the number of files the outline may cover.
 * @param signal - abort signal checked between directory reads.
 * @returns the collected files and the count cut off by the cap.
 */
export async function collectTypeScriptFiles(
  root: string,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<CollectedFiles> {
  const files: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    signal?.throwIfAborted()
    const directory = stack.pop()
    /* v8 ignore next -- the loop condition guarantees a non-empty stack; the guard answers pop()'s optional type. */
    if (directory === undefined) break
    const entries = await readdir(directory, { withFileTypes: true })
    signal?.throwIfAborted()
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        // Symlinked directories are not followed: entry.isDirectory() is false
        // for a symlink (lstat-based), so a symlinked dir is treated as a
        // non-directory below and skipped — a symlink loop would otherwise
        // recurse forever.
        if (entry.name !== 'node_modules') dirs.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue
      // Declaration files carry only type information, not runtime symbols
      // worth outlining; skip them explicitly rather than via the hidden-dotfile
      // rule (a .d.ts is not "hidden").
      if (path.endsWith('.d.ts')) continue
      files.push(path)
    }
    stack.push(...dirs.sort().reverse())
  }
  files.sort()
  const overLimit = Math.max(0, files.length - maxFiles)
  files.length = Math.min(files.length, maxFiles)
  return { files, overLimit }
}

/**
 * Read one collected file and outline it with the shared extractor, enforcing
 * the byte cap and the symbol cap.
 * @param path - the file to outline.
 * @param extract - extraction callback producing symbols from the file path and text.
 * @param maxBytes - the byte cap, or undefined for no cap.
 * @param signal - abort signal forwarded to the file read.
 * @returns the file outline, or undefined when the file exceeds the byte cap.
 * @throws when the file cannot be read or does not parse.
 */
export async function outlineCollectedFile(
  path: string,
  extract: (path: string, text: string) => SymbolEntry[],
  maxBytes: number | undefined,
  signal: AbortSignal,
): Promise<FileOutlineResult | undefined> {
  const size = (await stat(path)).size
  if (maxBytes !== undefined && size > maxBytes) return undefined
  const text = await readFile(path, { encoding: 'utf8', signal })
  return { path, symbols: extract(path, text) }
}
