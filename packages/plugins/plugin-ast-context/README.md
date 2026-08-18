# @deepseek-ai/dsh-plugin-ast-context

English | [中文](README.zh.md)

The model-facing `get_file_outline` tool: parse a local TypeScript file with tree-sitter and report its declared symbols with 1-based line spans, so the model can orient before reading a large file.

## What it does

Registers one tool, `get_file_outline(path)`, on `ctx.tools`. The tool reads the file from disk, parses it with the `tree-sitter` TypeScript grammar, and returns a canonical `FileOutlineResult`: `{ path, symbols }` where each `SymbolEntry` carries `kind` (`function` | `class` | `interface` | `type` | `enum`), `name`, 1-based `line`/`endLine`, and `children` (the declarations and methods declared directly in the symbol's body). Declarations wrapped in `export` statements are reported under their real name; the model-facing renderer prints one line per symbol with members indented under their owner.

A file that does not parse (syntax errors) or cannot be read fails the call as an `isError` result. Outlines are bounded: a file larger than `maxBytes` (default 2 MiB) or an outline with more symbols than `maxSymbols` (default 2,000) is refused with a directing error result rather than truncated.

## Extraction scope

The outline is a pure function of file text: top-level `function`/`class`/`interface`/`type` alias/`enum` declarations in source order, plus the declarations and method members declared directly in each symbol's body (`class_body`/`interface_body`/`statement_block`), one body level deep per symbol. Class fields, property signatures, lexical declarations (`const f = () => {}`), namespaces, and declarations inside nested control-flow blocks are not reported.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`get_file_outline` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-ast-context): one required `path` string and the structured `symbols` array of `kind`/`name`/`line`/`endLine`/`children`. Plugin config (`maxBytes` default 2 MiB, `maxSymbols` default 2,000) is validated at load and fails loud on invalid values; it changes no schema field, only whether a call resolves or returns a directing error result.

#### Token effect

Fixed schema cost on every request where the tool is visible; the call result scales with the number of declared symbols in the outlined file.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the parse result itself is produced inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **TypeScript only** — the extractor loads the TypeScript grammar; `.tsx` and other languages are not supported yet.
- **Shallow outline** — one body level deep per symbol; declarations nested in control-flow blocks and namespaces (and their contents) are not reported.
- **Anonymous bindings omitted** — lexical declarations (`const`, `let`, `var`) and anonymous functions are not part of the outline, so function-valued constants do not appear.
- **Single call per file** — no batch mode or directory walk; the model calls the tool once per file.