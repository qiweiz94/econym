# @econym/dsh-plugin-arch-guard

English | [中文](README.zh.md)

The model-facing `check_module_boundary` tool: check whether importing `targetImport` from `sourcePath` is legal under the monorepo's package-layering rules, before the import is written.

## What it does

Registers one tool on `ctx.tools`:

- `check_module_boundary(sourcePath, targetImport)` evaluates one proposed import and returns `{ allowed, rule, suggestion? }`. `rule` is a stable name identifying which check decided the verdict; `suggestion` is present whenever `allowed` is `false` and a corrective rewrite is known.

The workspace package graph is scanned once from `config.root` (default the process cwd) when the plugin mounts, not re-read per call.

## The layering rules

The rules are read off the repository's own constraint tooling and stated conventions, not invented:

- **Tier direction.** Every package group sits in one of three tiers, ordered `foundation < capability < surface`. A package may depend on its own tier or a lower one, never a higher one.
  - `foundation`: `vendor` (`scripts/check-workspace-constraints.ts`'s `vendoredPackages` return early from every dsh-scoped check — the vendored framework carries no in-repo dependency) and `util` (`packages/README.md` calls it "harness-dep-free").
  - `surface`: `plugins` (`packages/plugins/README.md`: "self-contained model-facing tool plugins... without a replaceable provider contract"), `host`, and `client` (the web GUI halves built atop the product spine).
  - `capability`: every other group — the product spine `packages/core/README.md` calls "the stable surface plugins and consumers build against."
- **Plugins do not import each other undeclared.** `packages/README.md` states "Extension plugins depend on Service Definitions, never concrete providers," and empirically no shipped `packages/plugins/*` package lists another `plugins/*` package as a dependency. A `plugins`-group package may import a sibling only when it declares that package in `dependencies`/`peerDependencies`/`devDependencies`.
- **Acyclicity.** `scripts/package-graph.ts`'s `topoSort` — the function `scripts/gen-module-graph.ts` (the module-graph gate) builds `docs/module-graph.md` from — throws when the peer-dependency graph is not a DAG. This tool applies the same rule to a proposed edge: if the target already (transitively) depends on the source, the import would create a cycle.
- **Exports map validity.** A subpath the target package's `package.json` `exports` does not declare is not importable, mirroring Node's own package-exports enforcement (one `*` wildcard per key is supported).
- **Relative imports stay in-package.** The root conventions call for package-name imports across packages; a relative specifier that resolves outside the source package's own directory is rejected.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated `check_module_boundary` schema: two required strings (`sourcePath`, `targetImport`) in, and the structured `{ allowed, rule, suggestion? }` verdict out. Plugin config (`root`, default the process cwd) is validated at load and changes no schema field — only which workspace graph a call is checked against.

#### Token effect

Fixed schema cost on every request where the tool is visible; the call result is a small fixed-shape object regardless of the workspace's size.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. The scanned workspace graph is built once at mount and never enters the request prefix.

## Known Limitations and Deferred Work

- **Declared-dependency graph, not a live import scan** — `dependsOn` comes from `package.json` `dependencies`/`peerDependencies`/`devDependencies` with the `workspace:` protocol, not from parsing actual source imports; a package that imports something it never declared would not be caught by the cycle check.
- **One `*` wildcard per exports key** — matches Node's own subpath-pattern support; conditional exports (`import`/`require`/`types` branches) are flattened to their key, not evaluated per condition.
- **No cross-repo awareness** — the workspace index only covers `packages/*/*` and `vendor/*` under the configured root; a target outside those globs (an app, an example leaf) is reported `unknown-workspace-package`.
- **Static per mount** — the workspace graph is scanned once when the plugin mounts; a package added or re-scoped afterward is invisible until the next mount.
