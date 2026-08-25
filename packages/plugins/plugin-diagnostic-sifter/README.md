# @econym/dsh-plugin-diagnostic-sifter

English | [中文](README.zh.md)

The model-facing `run_diagnostic_check` tool: run the repository's typecheck (`tsc -b`) or a scoped test run (`vitest run`) through the subprocess capability, then sift the captured output into root-cause diagnostics — downstream module-resolution cascades suppressed and counted, exact duplicates merged, test output trimmed to failed-assertion detail — bounded by the output-retention envelope.

## What it does

Registers one tool on `ctx.tools`:

- `run_diagnostic_check(command, targetPath?)` spawns the configured `tsc -b` build or `vitest run`, optionally scoped to `targetPath` (a project/directory for `typecheck`, a file or directory for `test`), and returns the sifted diagnostics: `rootCauses` (file, line, code, message), `suppressedCascadeCount`, `deduplicatedCount`, `truncated`, and `success`/`exitCode`/`signal`.

A failing exit that produced no parseable diagnostics — or output the sifter did not recognize at all — is reported as `parseFailure: true` carrying the bounded raw output, never silently read as `success: false` with an empty diagnostic list.

## Sifting model

- **tsc**: `TSC_LOCATED`/`TSC_GLOBAL` parse `tsc --pretty false`'s per-file and config-level diagnostic lines (indented continuation lines merge into the preceding diagnostic, keeping a multi-line elaboration as one root cause).
- **Cascade suppression**: a `TS2307` (cannot find module) or `TS2724` (no exported member) diagnostic is suppressed only when the module specifier its message names resolves — by basename, not real module resolution — to a file that ALSO has its own retained diagnostic in the same run. An independently missing module that happens to share one of these codes, with no matching retained diagnostic, is kept as its own root cause.
- **vitest**: the reporter's ` FAIL ` blocks are parsed into one root cause per failed test, keeping the assertion message and its `- Expected`/`+ Received` diff while dropping passing-test lines, code frames, and stack-frame noise; the failing test's own frame is preferred as the root-cause location over a deeper helper-function frame.
- **Dedupe**: exact-duplicate diagnostics (same file, line, code, message) merge into one, counted in `deduplicatedCount`.

## Output retention envelope

`maxOutputBytes` (default 15 KB) bounds three things through `@deepseek-ai/dsh-output-retention`'s `TextRetainer` (`head` strategy): each spawned stream (`stdout`/`stderr`, capped independently before parsing), the serialized `rootCauses` list, and the raw output carried on a parse failure. `truncated` is `true` when either the stream capture or the root-cause serialization dropped bytes — an envelope truncation is never read as a parse failure; the two are reported independently.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated `run_diagnostic_check` schema: a required `command` (`typecheck` or `test`) and an optional `targetPath` string. Plugin config (working directory, `tsc`/`vitest` argv, output envelope, timeout, tool name) is validated at load and fails loud on invalid values (e.g. an empty `tscArgs`); it changes no schema field, only which check runs and how.

#### Token effect

Fixed schema cost on every request where the tool is visible; the call result scales with the bounded diagnostic list (or bounded raw output on a parse failure), each capped at `maxOutputBytes`.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the spawned check itself happens inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **`tsc -b` requires a composite/solution project** — build mode (`-b`) needs `"composite": true` (or project references) in the target `tsconfig.json`; a plain non-composite config fails with tsc's own build-mode error, reported as a `parseFailure` since it carries no per-file diagnostic to parse.
- **The vitest parser assumes the default reporter** — a project configuring a non-default vitest reporter (`--reporter=json`, `dot`, a custom reporter) produces output the parser does not recognize, surfacing as a loud `parseFailure` rather than a silently empty clean run — but the tool does not itself pin or override the target project's reporter choice.
- **Cascade matching is basename-only, not real module resolution** — `TS2307`/`TS2724` suppression compares the cited module specifier's basename against retained diagnostics' file basenames; two files sharing a basename in different directories (rare but possible) can cause an unrelated cascade to be suppressed, or a genuine cascade to survive unsuppressed.
- **`targetPath` is contained to the working directory** — it rejects a leading `-` (option injection) and any path that escapes the configured `cwd` (`../..` or an absolute path elsewhere), so a check cannot load and execute a foreign `vitest`/`tsc` config; the contained path is passed as one argv element to a spawned process, never shell-interpreted.
- **No color/reporter configurability** — the spawn always sets `NO_COLOR=1` so the sifter's regexes see plain ASCII; this is fixed input-format hygiene, not an exposed config knob.
