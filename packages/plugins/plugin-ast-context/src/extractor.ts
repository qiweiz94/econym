/**
 * Tree-sitter backed symbol outline extraction for TypeScript sources.
 * The extractor is a pure function of file text: it owns no state beyond the
 * parser instance and never touches the filesystem.
 * @module @deepseek-ai/dsh-plugin-ast-context/extractor
 */

import Parser from 'tree-sitter'
import TypeScriptGrammars from 'tree-sitter-typescript'
import type { SymbolEntry, SymbolKind } from './types.ts'

const typescriptLanguage = TypeScriptGrammars.typescript as Parser.Language
const tsxLanguage = TypeScriptGrammars.tsx as Parser.Language

/**
 * Pick the grammar for a source file path by extension.
 * @param path - the file path to outline.
 * @returns the TSX grammar for `.tsx` files and the TypeScript grammar otherwise.
 */
export function grammarFor(path: string): Parser.Language {
  return path.endsWith('.tsx') ? tsxLanguage : typescriptLanguage
}

/** Declaration node types reported at file scope, mapped to their outline kind. */
const DECLARATION_TYPES: Readonly<Record<string, SymbolKind>> = {
  function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
}

/** Member node types reported inside class and interface bodies. */
const MEMBER_TYPES: Readonly<Record<string, SymbolKind>> = {
  method_definition: 'function',
  method_signature: 'function',
}

/** Node types collected from a symbol's body, mapped to their outline kind. */
const BODY_SYMBOL_TYPES: Readonly<Record<string, SymbolKind>> = {
  ...DECLARATION_TYPES,
  ...MEMBER_TYPES,
}

/** The body node kinds that declare the scope of a reported symbol. */
const BODY_TYPES: ReadonlySet<string> = new Set(['class_body', 'interface_body', 'statement_block'])

/**
 * Extract top-level declared symbols (and their nested declarations) from
 * TypeScript text. Declarations wrapped in `export_statement` are unwrapped;
 * anonymous bindings such as `const f = () => {}` are not reported. Each
 * reported symbol lists the declarations and method members declared directly
 * in its body, one body level deep per symbol; namespaces are not reported.
 */
export class AstSymbolExtractor {
  private readonly parser = new Parser()

  /**
   * Create an extractor over the TypeScript or TSX grammar.
   * @param grammar - the grammar to parse with; defaults to plain TypeScript.
   */
  constructor(grammar: Parser.Language = typescriptLanguage) {
    this.parser.setLanguage(grammar)
  }

  /**
   * Parse the given text and collect its declared symbols in source order.
   * @param text - the TypeScript source to outline.
   * @param maxSymbols - report at most this many symbols at any nesting depth;
   * exceeding the bound throws so the caller surfaces an error result instead
   * of a partial outline.
   * @returns the top-level declarations, each carrying the declarations and
   * method members of its body.
   * @throws when the text does not parse as a TypeScript program, or when the
   * outline exceeds {@link maxSymbols}.
   */
  extract(text: string, maxSymbols?: number): SymbolEntry[] {
    const root = this.parser.parse(text).rootNode
    if (root.hasError) {
      throw new Error('TypeScript parse failed: the file contains syntax errors')
    }
    const symbols = this.collectDeclarations(root)
    const total = symbols.reduce((count, symbol) => count + 1 + this.countChildren(symbol.children), 0)
    if (maxSymbols !== undefined && total > maxSymbols) {
      throw new Error(`outline exceeds ${maxSymbols} symbols; read the file directly or narrow the path`)
    }
    return symbols
  }

  /** Count every symbol in a member list, including nested members. */
  private countChildren(children: SymbolEntry[]): number {
    return children.reduce((count, child) => count + 1 + this.countChildren(child.children), 0)
  }

  /** Collect declaration symbols from the direct named children of a node. */
  private collectDeclarations(node: Parser.SyntaxNode): SymbolEntry[] {
    const symbols: SymbolEntry[] = []
    for (const child of node.namedChildren) {
      const inner = unwrapExport(child)
      const kind = DECLARATION_TYPES[inner.type]
      if (kind === undefined) continue
      symbols.push({
        ...this.span(inner, kind),
        children: this.collectChildren(inner),
      })
    }
    return symbols
  }

  /** Collect the declarations and method members declared directly in a symbol's body. */
  private collectChildren(declaration: Parser.SyntaxNode): SymbolEntry[] {
    const body = declaration.namedChildren.find(child => BODY_TYPES.has(child.type))
    if (body === undefined) return []
    const children: SymbolEntry[] = []
    for (const child of body.namedChildren) {
      const kind = BODY_SYMBOL_TYPES[child.type]
      if (kind === undefined) continue
      children.push({ ...this.span(child, kind), children: this.collectChildren(child) })
    }
    return children
  }

  /** Build the identity and source span of one symbol, without its member list. */
  private span(node: Parser.SyntaxNode, kind: SymbolKind): Omit<SymbolEntry, 'children'> {
    return {
      kind,
      /* v8 ignore next -- reported declaration kinds always carry a name
         field; anonymous default exports parse as expressions, never here */
      name: node.childForFieldName('name')?.text ?? '',
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    }
  }
}

/** Unwrap an `export_statement`/`export default` wrapper to the declaration it carries. */
function unwrapExport(node: Parser.SyntaxNode): Parser.SyntaxNode {
  if (node.type !== 'export_statement') return node
  /* v8 ignore next -- an export_statement wrapper always carries one declaration child */
  return node.namedChildren[0] ?? node
}
