# ADR-0001: Track Standalone Unhashed `dist/` Bundles on `main`

- **Status**: Accepted
- **Date**: 2026-11-27

## Context

`agy-hud` aims to support one-command, zero-build installation via Antigravity CLI's native plugin manager:

```bash
agy plugin install https://github.com/ifelseboyxx/agy-hud
```

Empirical verification against Antigravity CLI (`v1.5.15`) and Node.js `22.20+ / 24+` established three constraints:

1. `agy plugin install` copies files directly from a repository root, tag (`/tree/vX.Y.Z`), or subpath without running `npm install` or a build script, rejects `.zip` archive URLs, and rejects slash-containing branch/tag refs.
2. Running TypeScript sources directly via Node 22+ native type stripping is 2.1x–2.3x slower on warm renders (with 265 ms load spikes), fails under `node_modules/` paths (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), breaks under CJS ancestor `package.json` directories, and emits stderr warnings on Node `24.0–24.2`.
3. Content-hashed code-split chunks (`dist/chunks/*-[hash].mjs`) churn filenames on every commit, risk stale chunk commits under `atomic-publish.ts`'s retention window, and break single-file atomic reload symmetry across entrypoints.

## Decision

1. Build all four entrypoints (`hud`, `cli`, `mcp-hud`, `index`) with `codeSplitting: false`, emitting strictly **6 deterministic unhashed files** in `dist/` (`dist/hud.mjs`, `dist/cli.mjs`, `dist/mcp-hud.mjs`, `dist/index.mjs`, `dist/index.d.mts`, `dist/types.d.mts`) with zero `dist/chunks/`.
2. Track `dist/` directly on `main` (removing `/dist/` from `.gitignore`) and commit `100755` executable mode bits on the four shebang entrypoints (`dist/hud.mjs`, `dist/cli.mjs`, `dist/mcp-hud.mjs`, `scripts/install.mjs`).
3. Add `.gitattributes` rules (`dist/** linguist-generated=true -diff text eol=lf` and `scripts/install.mjs text eol=lf`) to collapse generated diffs in PRs, keep language statistics accurate, and enforce LF line endings across OSes.
4. Enforce build freshness and executable mode parity via a read-only `pnpm dist:check` script wired into CI (before `pnpm verify`), `.husky/pre-push`, and the `vX.Y.Z` tag release workflow.

## Consequences

- End users can install or upgrade `agy-hud` with a single bare GitHub URL or single-segment semver tag without installing `pnpm`, cloning the repo, or running a local build.
- Contributors modifying `src/` or build settings must run `pnpm build` (or `pnpm verify`) and include updated `dist/` in the same commit; stale `dist/` or wrong file modes are caught automatically before push and in CI.
- Total tracked bundle size increases slightly (~210 KiB over split chunks) in exchange for zero filename churn and single-file atomic reload safety across all bundles.
