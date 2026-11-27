# Architecture Overview

This document maps the runtime entrypoints, module layering, shared data pipelines, and persistence invariants of `agy-hud`.

## Runtime Entrypoints

`agy-hud` compiles to three standalone, unhashed Node ESM bundles (plus two `.d.mts` declarations — strictly 5 files in `dist/`, zero `dist/chunks/`, tracked on `main` per [ADR-0001](adr/0001-track-standalone-dist-on-main.md)):

| Entrypoint | Bundle | Role |
| :--- | :--- | :--- |
| `src/hud-entry.ts` | `dist/hud.mjs` | Reads Antigravity CLI `statusLine` JSON from `stdin`, invokes `runHudRender`, prints ANSI lines to `stdout` on every ~300 ms host tick. |
| `src/cli-entry.ts` | `dist/cli.mjs` | Unified CLI for `snapshot` (`snap`, `-p`/`--popup`, `--keybindings`), `preview [width]`, `configure` (flags, narrow overrides, cost currency, `-i` TUI), `export-profile` / `import-profile`, and installer commands (`install`, `uninstall`, `wire`, `unwire`, `on`, `off`, `doctor`, `--purge`). |
| `src/index.ts` | `dist/index.mjs` | Public programmatic API and TypeScript declarations (`dist/index.d.mts`, `dist/types.d.mts`). |

## Layering and Dependencies

Dependencies flow strictly downward across a directed layer matrix with zero circular dependencies (Tarjan SCC) and transitive runtime purity for `src/render/*` and `src/cli/configure-tui-render.ts` (enforced by `scripts/validate-architecture.ts` and `scripts/lib/architecture-graph.ts`):

```text
src/hud-entry.ts ──> src/hud-runner.ts ──> src/render/format-hud.ts ──> src/render/modules.ts
                        │                                                 ├── src/render/agents-render.ts
                        │                                                 ├── src/render/activity-lines.ts
                        │                                                 ├── src/render/activity-summary.ts
                        │                                                 └── src/render/ansi.ts + telemetry-format.ts + pack-line.ts + osc8.ts
                        ├──> src/hud-snapshot-publish.ts ──> src/render/osc8-markdown.ts
                        └──> src/collectors/* ──> src/core/* (pure + FS infra)

src/cli/configure-tui-render.ts ──> src/render/format-hud.ts (transitively pure preview, zero node:fs or process I/O)
```

Key boundaries:

- **`src/core/`**: Split into strictly pure primitives (`guards.ts`, `paths.ts`, `terminal-text.ts`, `hud-config.ts`, `model-names.ts`, `quota-pace.ts`, `telemetry-error.ts`, `cost-utils.ts`, `activity-aggregate.ts`, `cache-registry.ts`) and filesystem-bound infrastructure (`fs-utils.ts`, `file-lock.ts`, `safe-path.ts`, `statusline-ownership.ts`). Pure `src/core/` modules never import `node:fs` or FS-bound core modules.
- **`src/hud-runner.ts` + `src/hud-snapshot-publish.ts`**: Own all HUD I/O orchestration — loading `hud-config.json`, resolving narrow-pane (`< 100` cols) effective config before running lazy collectors, detecting ancestor `agy` process flags/PID, resolving cached non-locking Git status, elapsed duration, and OSC 8 snapshot file URIs, and publishing two-gate OSC 8 Markdown files and session envelopes.
- **`src/render/`**: Strictly pure layout, telemetry-formatting, and link-formatting modules (`format-hud.ts`, `modules.ts`, `ansi.ts`, `telemetry-format.ts`, `effort-style.ts`, `quota.ts`, `cost.ts`, `git-render.ts`, `file-link.ts`, `snapshot-presentation.ts`, `osc8.ts`, `preview-fixture.ts`) shared by the live HUD (`hud-runner.ts`), `agy-hud preview`, and the `configure -i` live preview; transitively forbidden from reaching `node:fs`, locks, collectors, or runtime writes.
- **`src/collectors/`**: Strictly data acquisition and aggregation — including wire-level protobuf telemetry (`proto.ts`, `proto-steps.ts`, `proto-wire.ts`), throughput/context/compaction analysis (`telemetry.ts`, `telemetry-analysis.ts`, `telemetry-context.ts`, `compaction.ts`, `step-timing.ts`), bounded subagent rollups (`subagent-rollup.ts`), and cached `--no-optional-locks` Git collection (`git.ts`); forbidden from importing `src/render/` or network APIs.

## Shared Activity and Snapshot Pipeline

All three CLI user-facing surfaces (terminal HUD, OSC 8 Markdown, and CLI `snapshot`) share two canonical primitives so counts, ordering, and in-place rewrites stay identical:

1. **Incremental transcript scanning & unified cache** (`src/collectors/transcript-scanner.ts` + `src/collectors/activity-cache.ts`): Computes stable-prefix hashes (`ino`, `size`, `mtimeNs`, `contentHash`, `stablePrefixHash`), detects in-place same-inode/same-length transcript rewrites, and persists a single canonical `v: 6` cache (`agy_hud_activity_<id>.json`, <= 16 MiB) shared by both `src/collectors/activity.ts` (HUD hot path) and `src/collectors/snapshot-transcript.ts` (full snapshot loader).
2. **Activity aggregation** (`src/core/activity-aggregate.ts`): Pure canonical completed-tool grouping, target shortening, agent label cleanup, MCP server/subtool grouping, and count-preserving agent merging (retaining multiple completed runs with identical names), shared across the HUD, OSC 8 Markdown, and CLI `snapshot` pipelines.

3-surface CLI parity is guarded by `tests/surface-parity.test.ts`.

## Session Discovery, Resolution, and Caching

Session handling is split into single-purpose modules:

- `src/collectors/session-discovery.ts`: Strictly read-only discovery under `cliHome` across `conversation_summaries.db`, cold `brain/` directories, `conversations/<id>.db` files, and snapshot envelopes, filtering exited CLI PIDs and `nesting_depth > 0`, and delegating live-PID ownership to `src/collectors/snapshot-pid-marker.ts`.
- `src/collectors/session-index.ts`: Tiered session resolution (`explicit` ID/prefix -> live ancestor `pid` -> deepest `workspace` active-first -> `fallback` newest non-exited, tie-break running).
- `src/collectors/snapshot-loader.ts`: Loads full `ActivitySnapshot` (telemetry, context breakdown, `turnPhase`, quota pace, transcript tools/skills/MCPs, agents with bounded subagent telemetry rollups, todos) strictly read-only on CLI session databases.
- `src/collectors/snapshot-envelope.ts`: Persists bounded `0o600` CLI `v: 2` session envelopes (`agy_hud_snapshot_<id>.json`, <= 512 KiB) with 30-second heartbeat throttling, bounded-skew timestamp validation, monotonic `switchSeq`, frame-start PID marker and heartbeat-aware supersede guards (with verified clock-rollback exemptions), and short non-stalling hot-path PID locking.
- `src/collectors/snapshot-pid-marker.ts`: Reads and validates bounded `0o600` active PID markers (`agy_hud_pid_<pid>.json`), scans fallback peer envelopes on missing markers, and resolves authoritative live-PID session ownership.
- `src/core/cache-registry.ts` + `src/collectors/snapshot-cache-sweep.ts`: Single source of truth for HUD cache/lock filenames and cleanup regexes; reclaims 7-day expired cache files (`agy_hud_(snapshot|activity|activity_snapshot|telemetry|subagents|pid|git)_*.{json,md}`, including legacy `activity_snapshot` files) and 1-hour crashed atomic-write `.tmp.<pid>.<ts>.<16hex>` orphans under `<cliHome>/cache/` (excluding symlinks; `.lock` files are exclusively reclaimed by `src/core/file-lock.ts` or dead-PID cleanup during `unwire`/`uninstall`).

## Ownership and Concurrency Enforcement Map

Normative requirements live in `AGENTS.md`; the concrete enforcement sites are:

- **`statusLine` single writer & quoting**: `src/cli/installer/settings.ts` (AST-enforced by `scripts/validate-architecture.ts`) and `src/core/statusline-ownership.ts` (`formatStatusLineCommand` + `isSameCommandPath`).
- **Interactive draft conflict protection**: `src/cli/configure.ts` captures a SHA-256 revision hash via `readJsonObjectWithHashSync` and re-verifies it inside `withCliHomeLockSync` (`src/core/file-lock.ts`).
- **Strict write-path JSON vs read-only HUD fallback**: `src/core/fs-utils.ts` (`readJsonObjectSync(..., true)` with fatal UTF-8 decoding) protects all write/CLI/doctor paths; `src/collectors/settings.ts` uses read-only graceful fallback without writing back.
- **Terminal boundary sanitization**: `src/core/terminal-text.ts` (`sanitizeTerminalText`, `sanitizeTerminalLabel`) strips 7-bit/8-bit CSI/OSC/DCS/SOS/PM/APC (including unterminated payloads), C0/C1 controls, and Unicode bidi format controls at collector/session boundaries and output renderers across HUD, OSC 8 Markdown, and CLI `snapshot`.
- **Snapshot Markdown publication guard**: `src/hud-snapshot-publish.ts` flattens per-session `.md` + per-PID envelope locking into one sorted, short-timeout `withFileLocksSync` call so contended hot-path renders skip cache persistence silently instead of stalling HUD stdout, and skips stale publishes superseded by newer envelopes.
