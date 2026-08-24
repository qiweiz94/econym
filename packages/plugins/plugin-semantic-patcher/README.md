# @econym/dsh-plugin-semantic-patcher

English | [中文](README.zh.md)

The model-facing `patch_symbol_body` tool: replace the body of one named TypeScript symbol in place, located in the parsed syntax tree with tree-sitter rather than by matching text, so an edit lands on the declaration the model named even when the same body text appears elsewhere in the file.

## What it does

Registers one tool on `ctx.tools`:

- `patch_symbol_body(path, symbol, newBody)` reads one file from disk, parses it with the matching `tree-sitter` grammar (TypeScript for `.ts`, TSX for `.tsx`), locates the named symbol's body node, and replaces exactly that node's source span. It returns `{ path, symbol, kind, line, endLine }`, where `symbol` is the fully qualified name that was matched, `kind` is `function` | `method` | `arrow`, and `line`/`endLine` are the 1-based span of the body that was replaced.

The `symbol` argument accepts a bare name (`target`) or a dotted qualification (`Class.method`). A bare name that matches exactly one symbol is used; if it matches several, the call fails and lists the qualified candidates instead of guessing. An exact qualified match always wins over a bare-name match elsewhere in the file, so `Class.method` is the escape hatch for any collision.

`newBody` replaces the body node verbatim: pass the braces for a block body (`{ return 1 }`), or the bare expression for a concise arrow body (`a * 2`).

## Safety guarantees

- **Repository confinement** — `path` is resolved against the configured `cwd` (default `process.cwd()`); a path resolving to the root itself or outside it is refused before the filesystem is touched.
- **No patch into a broken file** — the original text is parsed first and a tree carrying syntax errors is rejected, so a span is never located inside an unreliable parse.
- **Validated before written** — the complete next file text is built and re-parsed in memory; only a clean parse is committed. A `newBody` that would break the file fails the call with the file still byte-for-byte the original, so there is no window in which a broken file exists on disk.
- **Atomic commit** — the accepted text is written through `writeFileAtomic`, which renames a sibling over the target and carries the file's existing permission bits onto the replacement inode.
- **Bounded** — a file larger than `maxBytes` (default 2 MiB) is refused rather than parsed.

## Patchable scope

File-scope `function` declarations, file-scope `const`/`let`/`var` bindings whose value is an arrow function or function expression, and class members: `method_definition` (including getters, setters, `static`, and `async` forms) and class fields whose value is an arrow function. Class members are named `Class.member`. Interface method signatures, abstract members, fields holding non-function values, namespaces, and declarations nested inside control-flow blocks or other function bodies are not patchable.

## Parser stack

Native `tree-sitter` with `tree-sitter-typescript`, in `dependencies`, matching [`plugin-ast-context`](../plugin-ast-context/README.md) exactly — the same package versions, the same `import Parser from 'tree-sitter'` in-process CST parse, and the same `grammarFor` extension split. The repository builds those native bindings once (`allowBuilds` in `pnpm-workspace.yaml`); this package introduces no second parser stack.

Note that node-tree-sitter reports `startIndex`/`endIndex` as **UTF-16 code-unit offsets** into the parsed JavaScript string, not UTF-8 byte offsets. Every span slice here is taken on the string; slicing a `Buffer` with those indices would misplace the edit in any file containing non-ASCII text before the target. Fixtures with CJK text and emoji before and after the target hold that behaviour.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`patch_symbol_body` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-semantic-patcher): three required strings (`path`, `symbol`, `newBody`) and a structured result of `path`/`symbol`/`kind`/`line`/`endLine`. Plugin config (`cwd`, `maxBytes` default 2 MiB) is validated at load and fails loud on invalid values; it changes no schema field, only whether a call resolves or returns a directing error result.

#### Token effect

Fixed schema cost on every request where the tool is visible. The call cost is dominated by `newBody`, which the model writes; the result is a fixed handful of fields regardless of file size, so a patch costs far less to confirm than re-reading the edited file.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the parse and the patched text are produced inside the call and never enter the request prefix.

## Known Limitations and Deferred Work

- **Two grammars** — `.ts` and `.tsx` use the `tree-sitter-typescript` grammars; other languages (`.js`, `.mts`, `.cts`) are not supported yet.
- **One body level** — only file-scope declarations and direct class members are addressable; a function declared inside another function's body cannot be named.
- **Validate-before-write, not write-then-restore** — the refusal path is implemented by never writing, so a rejected patch leaves the original file untouched rather than restoring it from a backup. The observable guarantee is the same and strictly stronger; there is deliberately no window in which the file on disk does not parse.
- **Rendered as a generic edit card, not a diff** — `presentCall` is a pure function of `args`, and the body being replaced is not in `args`: finding it requires parsing the file. A `diff` card would have to invent or omit its `oldText`, so the call presents as `generic`/`edit` with the file location, matching `str_replace_editor`'s `insert` command for the same reason. Rendering a true diff would need a presentation seam that can read the pre-call file.
- **Whole-body replacement only** — there is no anchored or partial edit within a body; the model supplies the complete replacement body.
- **No formatting pass** — `newBody` is inserted verbatim. Indentation and style are the caller's responsibility; the tool checks only that the result parses.
- **Overloads not distinguished** — two members sharing a qualified name (a class name declared twice) are reported as ambiguous and cannot be patched without editing the file another way.
- **Durability out of scope** — the atomic rename is not followed by an `fsync` of the file or its parent directory, matching `@deepseek-ai/dsh-atomic-write`'s documented scope.
