/**
 * Tree-sitter backed symbol-body location and in-place patching for
 * TypeScript sources. The locator and the text transform are pure functions of
 * file text; only {@link patchSymbolBody} touches the filesystem, and it
 * validates the complete next file text before any byte is written.
 *
 * Offsets note: node-tree-sitter reports `startIndex`/`endIndex` as UTF-16
 * code-unit offsets into the JavaScript string it parsed, NOT byte offsets
 * into the UTF-8 encoding. Every slice here is therefore taken on the string;
 * slicing a Buffer with these indices would misplace the span in any file
 * containing non-ASCII text before the target.
 * @module @econym/dsh-plugin-semantic-patcher/patcher
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import Parser from 'tree-sitter'
import TypeScriptGrammars from 'tree-sitter-typescript'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { PatchSymbolBodyResult, SymbolCandidate, SymbolTargetKind } from './types.ts'

const typescriptLanguage = TypeScriptGrammars.typescript as Parser.Language
const tsxLanguage = TypeScriptGrammars.tsx as Parser.Language

/**
 * Pick the grammar for a source file path by extension, exactly as the
 * sibling outline plugin does.
 * @param path - the file path to parse.
 * @returns the TSX grammar for `.tsx` files and the TypeScript grammar otherwise.
 */
export function grammarFor(path: string): Parser.Language {
  return path.endsWith('.tsx') ? tsxLanguage : typescriptLanguage
}

/** Node types whose `body` field is the replaceable body. */
const BODIED_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
])

/** Declaration statements that bind a name to a value at file scope. */
const BINDING_TYPES: ReadonlySet<string> = new Set(['lexical_declaration', 'variable_declaration'])

/** Class members that can carry a replaceable body, mapped to their reported kind. */
const CLASS_MEMBER_KINDS: Readonly<Record<string, SymbolTargetKind>> = {
  method_definition: 'method',
  public_field_definition: 'arrow',
}

/** One located symbol body: its qualified name, kind, and the node to replace. */
interface PatchTarget {
  readonly name: string
  readonly kind: SymbolTargetKind
  readonly body: Parser.SyntaxNode
}

/** Unwrap an `export`/`export default` wrapper to the declaration it carries. */
function unwrapExport(node: Parser.SyntaxNode): Parser.SyntaxNode {
  if (node.type !== 'export_statement') return node
  /* v8 ignore next -- an export_statement wrapper always carries one named child */
  return node.namedChildren[0] ?? node
}

/** The declared name of a node; every form the collectors reach carries one. */
function nameOf(node: Parser.SyntaxNode): string {
  /* v8 ignore next -- collected declaration forms always carry a name field */
  return node.childForFieldName('name')?.text ?? ''
}

/**
 * The replaceable body of a declaration: the `body` field of a function,
 * method, or arrow, or the body of a function-valued initializer. Returns
 * undefined when the declaration binds no function body at all.
 */
function bodyOf(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  if (BODIED_TYPES.has(node.type)) {
    /* v8 ignore next -- every parsed function, method, and arrow carries a body field */
    return node.childForFieldName('body') ?? undefined
  }
  const value = node.childForFieldName('value')
  if (value === null || !BODIED_TYPES.has(value.type)) return undefined
  return bodyOf(value)
}

/** Record one target when the declaration actually carries a replaceable body. */
function pushTarget(targets: PatchTarget[], node: Parser.SyntaxNode, name: string, kind: SymbolTargetKind): void {
  const body = bodyOf(node)
  if (body === undefined) return
  targets.push({ name, kind, body })
}

/** Collect the patchable members declared directly in a class body. */
function collectClassMembers(targets: PatchTarget[], declaration: Parser.SyntaxNode): void {
  const className = nameOf(declaration)
  const body = declaration.childForFieldName('body')
  /* v8 ignore next -- a parsed class_declaration always carries a class_body */
  if (body === null) return
  for (const member of body.namedChildren) {
    const kind = CLASS_MEMBER_KINDS[member.type]
    if (kind === undefined) continue
    pushTarget(targets, member, `${className}.${nameOf(member)}`, kind)
  }
}

/**
 * Collect every patchable symbol in a parsed program, in source order.
 * File-scope functions and function-valued bindings are named directly; class
 * members are named `Class.member` so an overloaded simple name stays
 * addressable.
 */
function collectTargets(root: Parser.SyntaxNode): PatchTarget[] {
  const targets: PatchTarget[] = []
  for (const child of root.namedChildren) {
    const node = unwrapExport(child)
    if (node.type === 'function_declaration') {
      pushTarget(targets, node, nameOf(node), 'function')
    } else if (node.type === 'class_declaration') {
      collectClassMembers(targets, node)
    } else if (BINDING_TYPES.has(node.type)) {
      for (const declarator of node.namedChildren) {
        pushTarget(targets, declarator, nameOf(declarator), 'arrow')
      }
    }
  }
  return targets
}

/** Describe one target for an error message or the candidate listing. */
function describe(target: PatchTarget): SymbolCandidate {
  return {
    name: target.name,
    kind: target.kind,
    line: target.body.startPosition.row + 1,
    endLine: target.body.endPosition.row + 1,
  }
}

/** Render the candidate list appended to a not-found or ambiguity error. */
function renderCandidates(targets: PatchTarget[]): string {
  if (targets.length === 0) return 'this file declares no patchable symbol'
  return targets.map(target => `${target.name} (${target.kind})`).join(', ')
}

/**
 * Parse TypeScript text and reject a tree that carries syntax errors, so a
 * span is never located inside an already-broken parse.
 * @param parser - the configured parser to reuse.
 * @param text - the source text.
 * @param what - the role of this text in the error message.
 * @returns the parsed root node.
 * @throws when the text does not parse cleanly.
 */
function parseClean(parser: Parser, text: string, what: string): Parser.SyntaxNode {
  const root = parser.parse(text).rootNode
  if (root.hasError) throw new Error(`${what} does not parse as TypeScript: the text contains syntax errors`)
  return root
}

/** The trailing segment of a qualified name, used for simple-name matching. */
function simpleName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? name : name.slice(dot + 1)
}

/**
 * Resolve one symbol request against the collected targets. An exact
 * qualified-name match wins outright; otherwise the simple name is matched
 * across every target.
 * @throws when nothing matches, or when the request is ambiguous.
 */
function selectTarget(targets: PatchTarget[], symbol: string, path: string): PatchTarget {
  const exact = targets.filter(target => target.name === symbol)
  const matches = exact.length > 0 ? exact : targets.filter(target => simpleName(target.name) === symbol)
  const [first] = matches
  if (first === undefined) {
    throw new Error(
      `no patchable symbol named "${symbol}" in ${path}; candidates: ${renderCandidates(targets)}`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `"${symbol}" is ambiguous in ${path}: ${matches.length} symbols match. `
      + `Disambiguate with one of: ${matches.map(target => target.name).join(', ')}`,
    )
  }
  return first
}

/** The complete next file text plus the metadata describing what was replaced. */
export interface AppliedPatch {
  /** The full patched file text. */
  readonly text: string
  /** What was replaced, for the tool result. */
  readonly result: Omit<PatchSymbolBodyResult, 'path'>
}

/**
 * Locate `symbol` in `text` and return the file text with only that symbol's
 * body replaced by `newBody`. Nothing is written: the caller decides what to
 * do with the validated text. The patched text is re-parsed here, so a
 * `newBody` that would break the file fails before it can reach disk.
 * @param text - the current file text.
 * @param grammar - the grammar matching the file's extension.
 * @param symbol - the symbol name, optionally qualified as `Class.member`.
 * @param newBody - the replacement body source, including its braces for a
 * block body, or the expression for a concise arrow body.
 * @param path - the path used in error messages.
 * @returns the patched text and the replaced span's metadata.
 * @throws when the original or the patched text fails to parse, when no
 * symbol matches, or when the request is ambiguous.
 */
export function applySymbolPatch(
  text: string,
  grammar: Parser.Language,
  symbol: string,
  newBody: string,
  path: string,
): AppliedPatch {
  const parser = new Parser()
  parser.setLanguage(grammar)
  const root = parseClean(parser, text, path)
  const target = selectTarget(collectTargets(root), symbol, path)
  const { body } = target
  // UTF-16 code-unit offsets: slice the string, never a Buffer.
  const patched = text.slice(0, body.startIndex) + newBody + text.slice(body.endIndex)
  parseClean(parser, patched, `the patched ${path} (left unchanged)`)
  const span = describe(target)
  return {
    text: patched,
    result: { symbol: target.name, kind: span.kind, line: span.line, endLine: span.endLine },
  }
}

/**
 * List every patchable symbol in `text`, in source order. Exposed so a caller
 * can surface the candidate set without attempting a patch.
 * @param text - the source text.
 * @param grammar - the grammar matching the file's extension.
 * @param path - the path used in the parse-failure message.
 * @returns one entry per patchable symbol.
 * @throws when the text does not parse.
 */
export function listSymbols(text: string, grammar: Parser.Language, path: string): SymbolCandidate[] {
  const parser = new Parser()
  parser.setLanguage(grammar)
  return collectTargets(parseClean(parser, text, path)).map(describe)
}

/**
 * Resolve `path` inside `root` and refuse anything that escapes it.
 * @param root - the repository root every patch must stay inside.
 * @param path - the caller-supplied path, absolute or root-relative.
 * @returns the absolute resolved path.
 * @throws when the path resolves to the root itself or outside it.
 */
export function resolveInsideRoot(root: string, path: string): string {
  const base = resolve(root)
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to patch ${path}: the path resolves outside the repository root ${base}`)
  }
  return target
}

/** Everything {@link patchSymbolBody} needs to perform one patch. */
export interface PatchSymbolBodyOptions {
  /** The repository root; a path resolving outside it is refused. */
  root: string
  /** The file to patch, absolute or relative to {@link root}. */
  path: string
  /** The symbol name, optionally qualified as `Class.member`. */
  symbol: string
  /** The replacement body source. */
  newBody: string
  /** Refuse files larger than this many bytes. */
  maxBytes?: number | undefined
  /** Abort signal honoured while the file is read. */
  signal?: AbortSignal | undefined
}

/**
 * Replace one named symbol's body in a file on disk. The next file text is
 * built and re-parsed in memory first, so a rejected patch never reaches the
 * file: on any failure the original bytes are still the ones on disk. The
 * accepted text is committed with an atomic rename that preserves the file's
 * existing permission bits.
 * @param options - the patch request.
 * @returns the metadata describing the replaced span.
 * @throws when the path escapes the root, the file is too large, the original
 * or patched text fails to parse, or the symbol is missing or ambiguous.
 */
export async function patchSymbolBody(options: PatchSymbolBodyOptions): Promise<PatchSymbolBodyResult> {
  const absolute = resolveInsideRoot(options.root, options.path)
  const stats = await stat(absolute)
  if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
    throw new Error(
      `file is ${stats.size} bytes, exceeding the ${options.maxBytes}-byte patch limit; narrow the edit or raise maxBytes`,
    )
  }
  const text = await readFile(absolute, { encoding: 'utf8', signal: options.signal })
  const applied = applySymbolPatch(text, grammarFor(absolute), options.symbol, options.newBody, options.path)
  await writeFileAtomic(absolute, applied.text, { mode: stats.mode & 0o777 })
  return { path: options.path, ...applied.result }
}
