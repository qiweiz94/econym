# @econym/dsh-plugin-impacted-tests

English | [中文](README.zh.md)

The model-facing `run_impacted_tests` tool: build the workspace's import DAG with the TypeScript compiler API, walk it in reverse from the changed files to find every test suite that transitively imports one, and run strictly those suites.

## What it does

Registers one tool on `ctx.tools`:

- `run_impacted_tests(files?)` resolves the change set (the given paths, or the uncommitted modified files from `git status --porcelain` when `files` is omitted), selects the impacted suites, and runs them through `runnerCommand` with the selected suite paths appended. The result carries `selectedSuites`, `skippedCount`, and a `results` summary with the runner's exit status and its bounded `stdout`/`stderr`.

Nothing runs unless a suite is selected. An empty change set selects nothing and never reaches the graph walk; a changed file that no suite imports — a Markdown document, a config file — selects nothing too. A changed file that is itself a suite selects itself.

## Selection model

- **Discovery.** `testPatterns` (default `packages/*/*/tests/**/*.spec.ts` and `.spec.tsx`) name the suites the selection chooses among. `skippedCount` is the discovered suites the change set does not reach.
- **Forward walk.** The DAG is seeded from the discovered suites and walked forward through each file's import specifiers, extracted with `ts.preProcessFile`. Seeding from the suites is exhaustive for this question — a file no suite can reach cannot be imported by a suite — and keeps the walk off the whole workspace, which a `ts.createProgram` would load.
- **Reverse walk.** The forward edges are inverted once, then walked in reverse from the change set. Every file that transitively imports a changed file, intersected with the discovered suites, is the selection.
- **One path form.** git reports repo-relative paths, the compiler reports absolute ones, and a macOS temp directory is reached through a `/var` → `/private/var` symlink. Every path passes through one absolute, symlink-free normalizer, so "selects nothing" is an answer rather than a path-shape mismatch.
- **Bounds.** A selection larger than `maxSuites` (default 200) fails loud instead of running; the runner is killed after `timeoutMs` (default 10 minutes).

## Module resolution

Import specifiers resolve through `ts.resolveModuleName` against the compiler options in `tsconfigPath` (default `tsconfig.base.json`), so relative specifiers, tsconfig `paths`, and `node_modules` package `exports` all resolve the way the repository's own static gates resolve them. Workspace package names take two further steps, because the graph must stay on the source plane:

- **Artifact to source.** A name whose `exports` map points at emitted output resolves to `<pkg>/lib/index.js` or `<pkg>/lib/types/x.d.ts`; both are mapped back onto `<pkg>/src/…` before entering the graph. Without this, a suite importing a built package would never link to changes in that package's sources.
- **Workspace manifest index.** A package with neither a `paths` entry nor a built `lib` cannot be resolved by the compiler at all. Every workspace manifest is indexed by name, and the bare name, an `exports` alias, and a `./src/*` subpath each resolve under `<pkg>/src`.

## Output retention envelope

The runner's `stdout` and `stderr` each pass through the `@deepseek-ai/dsh-output-retention` `TextRetainer` with the `tail` strategy at `maxOutputBytes` (default 15 KB). A test runner's verdict and its failure summary are at the END of the stream, so a run over the envelope keeps the part that answers the call; the `truncated` flag and a rendered note report the loss.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`run_impacted_tests` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-impacted-tests): one optional `files` array of repo-relative paths. Plugin config (repository root, tsconfig, suite patterns, runner command, suite and byte bounds, timeout) is validated at load and fails loud on invalid values (e.g. a non-positive `maxOutputBytes`); it changes no schema field, only which suites exist and how they run.

#### Token effect

Fixed schema cost on every request where the tool is visible. The result scales with the selected suite list plus the runner's bounded output (each stream capped at `maxOutputBytes`), which is what makes the tool cheaper than a full-suite run: an unimpacted change returns a single line.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the graph walk and the run happen inside the call and never enter the request prefix.

## Known Limitations and Deferred Work

- **Static imports only** — the DAG is built from import specifiers `ts.preProcessFile` can see. A suite that reaches code through a computed dynamic import, a fixture path read at runtime, a generated file, or a snapshot is not linked to it, so such a suite can be skipped while genuinely impacted.
- **Non-import impact is invisible** — a changed `cordis.yml`, JSON fixture, or generated catalog is not a graph node, so it selects nothing. That is the documented answer, not a detected failure.
- **Requires git for the default change set** — omitting `files` shells out to `git` (configurable via `gitBinary`); a non-git `cwd` fails loud rather than falling back to a full run.
- **Suite granularity** — selection is per file, never per test case; a one-line change selects the whole suite that imports it.
- **The runner is spawned, not embedded** — `runnerCommand` is an argv prefix the suite paths are appended to, so the tool reports the runner's exit status and bounded streams, not a structured per-test report.
- **Boundary cases of the envelope** — both runner streams are tail-retained, so a run whose failure detail is followed by a long trailing summary can lose the detail.
