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

/** The body node kinds that declare the member scope of a class or interface. */
const BODY_TYPES: ReadonlySet<string> = new Set(['class_body', 'interface_body'])

/**
 * Extract top-level declared symbols (and their members) from TypeScript text.
 * Declarations wrapped in `export_statement` are unwrapped; anonymous bindings
 * such as `const f = () => {}` are not reported. Member scopes list methods
 * only — fields and property signatures are not part of the outline.
 */
export class AstSymbolExtractor {
  private readonly parser = new Parser()

  constructor() {
    this.parser.setLanguage(typescriptLanguage)
  }

  /**
   * Parse the given text and collect its declared symbols in source order.
   * @param text - the TypeScript source to outline.
   * @returns the top-level declarations, each carrying its member methods.
   * @throws when the text does not parse as a TypeScript program.
   */
  extract(text: string): SymbolEntry[] {
    const root = this.parser.parse(text).rootNode
    if (root.hasError) {
      throw new Error('TypeScript parse failed: the file contains syntax errors')
    }
    return this.collectDeclarations(root)
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
        children: this.collectMembers(inner),
      })
    }
    return symbols
  }

  /** Collect the method members declared in a class or interface body. */
  private collectMembers(declaration: Parser.SyntaxNode): SymbolEntry[] {
    const body = declaration.namedChildren.find(child => BODY_TYPES.has(child.type))
    if (body === undefined) return []
    const members: SymbolEntry[] = []
    for (const member of body.namedChildren) {
      const kind = MEMBER_TYPES[member.type]
      if (kind === undefined) continue
      members.push({ ...this.span(member, kind), children: [] })
    }
    return members
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
