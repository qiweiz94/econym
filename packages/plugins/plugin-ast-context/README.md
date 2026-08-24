# @econym/dsh-plugin-ast-context

English | [中文](README.zh.md)

The model-facing `get_file_outline` and `get_directory_outline` tools: parse local TypeScript (`.ts` or `.tsx`) files with tree-sitter and report their declared symbols with 1-based line spans, so the model can orient before reading a large file or tree.

## What it does

Registers two tools on `ctx.tools`:

- `get_file_outline(path)` reads one file from disk, parses it with the matching `tree-sitter` grammar (TypeScript for `.ts`, TSX for `.tsx`), and returns a canonical `FileOutlineResult`: `{ path, symbols }` where each `SymbolEntry` carries `kind` (`function` | `class` | `interface` | `type` | `enum`), `name`, 1-based `line`/`endLine`, and `children` (the declarations and methods declared directly in the symbol's body). Declarations wrapped in `export` statements are reported under their real name; the model-facing renderer prints one line per symbol with members indented under their owner.
- `get_directory_outline(path)` walks the directory tree, outlines each `.ts`/`.tsx` file it finds (hidden entries and `node_modules` are ignored, symlinked directories are not followed, and `.d.ts` declaration files are skipped because they carry only types, not outlinable runtime symbols), and returns `{ path, files, skippedFiles }` where `files` is one `FileOutlineResult` per outlined file in path order.

A file that does not parse (syntax errors) or cannot be read fails the file call as an `isError` result; in a directory outline such a file is counted in `skippedFiles` instead of failing the whole call. Outlines are bounded: a file larger than `maxBytes` (default 2 MiB), an outline with more symbols than `maxSymbols` (default 2,000), or a directory with more candidate files than `maxFiles` (default 200) is refused — the directory outline reports the cap overflow in `skippedFiles` rather than truncating silently.

## Extraction scope

The outline is a pure function of file text: top-level `function`/`class`/`interface`/`type` alias/`enum` declarations in source order, plus the declarations and method members declared directly in each symbol's body (`class_body`/`interface_body`/`statement_block`), one body level deep per symbol. Class fields, property signatures, lexical declarations (`const f = () => {}`), namespaces, and declarations inside nested control-flow blocks are not reported.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`get_file_outline` and `get_directory_outline` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-ast-context): one required `path` string each, the structured `symbols` array of `kind`/`name`/`line`/`endLine`/`children`, and the directory variant's per-file `files` array and `skippedFiles` count. Plugin config (`maxBytes` default 2 MiB, `maxSymbols` default 2,000, `maxFiles` default 200) is validated at load and fails loud on invalid values; it changes no schema field, only whether a call resolves or returns a directing error result.

#### Token effect

Fixed schema cost on every request where the tools are visible; the call result scales with the number of declared symbols in the outlined file — and for the directory tool, with the number of files under `maxFiles`.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the parse result itself is produced inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **Two grammars** — `.ts` and `.tsx` use the `tree-sitter-typescript` grammars; other languages (`.js`, `.mts`, `.cts`) are not supported yet.
- **Shallow outline** — one body level deep per symbol; declarations nested in control-flow blocks and namespaces (and their contents) are not reported.
- **Anonymous bindings omitted** — lexical declarations (`const`, `let`, `var`) and anonymous functions are not part of the outline, so function-valued constants do not appear.
- **Single call per file** — no batch mode beyond the directory walk; the model calls `get_file_outline` once per file.
- **Directory outline walks the tree** — the walk is bounded by `maxFiles` but costs a full `readdir` pass; huge trees may take a while even when the outline is small.
- **Declaration files skipped** — `.d.ts` files are intentionally not outlined (they declare types, not runtime symbols); the walk also ignores hidden entries, `node_modules`, and does not follow symlinked directories.