# Architecture Overview

This document maps the runtime entrypoints, module layering, shared data pipelines, and persistence invariants of `agy-hud`.

## Runtime Entrypoints

`agy-hud` compiles to four standalone, unhashed Node ESM bundles (plus two `.d.mts` declarations, zero `dist/chunks/`, tracked on `main` per [ADR-0001](adr/0001-track-standalone-dist-on-main.md)):

| Entrypoint | Bundle | Role |
| :--- | :--- | :--- |
| `src/hud-entry.ts` | `dist/hud.mjs` | Reads Antigravity CLI `statusLine` JSON from `stdin`, invokes `runHudRender`, prints ANSI lines to `stdout` on every ~300 ms host tick. |
| `src/cli-entry.ts` | `dist/cli.mjs` | Unified CLI for `snapshot` (`snap`, `-p`/`--popup`, `--keybindings`), `preview [width]`, `configure` (flags, narrow overrides, cost currency, `-i` TUI), `export-profile` / `import-profile`, and installer commands (`install`, `uninstall`, `wire`, `unwire`, `on`, `off`, `doctor`, `--purge`). |
| `src/mcp/hud-mcp-entry.ts` | `dist/mcp-hud.mjs` | Read-only stdio JSON-RPC 2.0 MCP server (with tool/resource schemas and argument validation in `src/mcp/hud-mcp-schema.ts`) exposing `hud_inspector`, `hud_poll_snapshot`, and the `ui://agy-hud/inspector.html` App UI resource. |

## Layering and Dependencies

Dependencies flow strictly downward with zero `collectors <-> render` cycles (enforced by `scripts/validate-architecture.ts`):

```text
src/hud-entry.ts ──> src/hud-runner.ts ──> src/render/format-hud.ts ──> src/render/modules.ts
                        │                                                 ├── src/render/agents-render.ts
                        │                                                 ├── src/render/activity-lines.ts
                        │                                                 ├── src/render/activity-summary.ts
                        │                                                 └── src/render/ansi.ts + pack-line.ts + osc8.ts
                        ├──> src/hud-snapshot-publish.ts ──> src/render/osc8-markdown.ts
                        └──> src/collectors/* ──> src/core/* + src/fs-utils.ts

src/cli/configure-tui-render.ts ──> src/render/format-hud.ts (pure preview, zero disk or process I/O)
```

Key boundaries:

- **`src/hud-runner.ts` + `src/hud-snapshot-publish.ts`**: Own all HUD I/O orchestration — loading `hud-config.json`, resolving narrow-pane (`< 100` cols) effective config before running lazy collectors, detecting ancestor `agy` process flags/PID, resolving cached non-locking Git status and elapsed duration, and publishing two-gate OSC 8 Markdown files and session envelopes.
- **`src/render/format-hud.ts` + `src/render/modules.ts` + `src/render/osc8.ts` + `src/render/preview-fixture.ts`**: Strictly pure layout and link-formatting modules (`buildIdentityLine`, `buildUsageLine`, `buildModeLine`, `LINE_MODULE_REGISTRY`, plus pure `quota.ts`, `cost.ts`, `git-render.ts`, and `osc8.ts`) shared by the live HUD (`hud-runner.ts`), `agy-hud preview`, and the `configure -i` live preview (enforced free of locks and disk writes by `scripts/validate-architecture.ts`).
- **`src/collectors/`**: Strictly data acquisition and aggregation (including cached `--no-optional-locks` Git collection in `src/collectors/git.ts`); forbidden from importing `src/render/` or network APIs.

## Shared Activity and Snapshot Pipeline

All four user-facing surfaces (terminal HUD, OSC 8 Markdown, CLI `snapshot`, and MCP `HUD Inspector`) share two canonical primitives so counts, ordering, and in-place rewrites stay identical:

1. **Incremental transcript scanning** (`src/collectors/transcript-scanner.ts`): Computes stable-prefix hashes (`ino`, `size`, `mtimeNs`, `contentHash`, `stablePrefixHash`) and detects in-place same-inode/same-length transcript rewrites. Consumed by both `src/collectors/activity.ts` (HUD hot path) and `src/collectors/snapshot-transcript.ts` (full snapshot loader).
2. **Activity aggregation** (`src/collectors/activity-aggregate.ts`): Canonical completed-tool grouping, MCP server/subtool grouping, and count-preserving agent merging (retaining multiple completed runs with identical names), shared across the HUD, OSC 8 Markdown, CLI `snapshot`, and MCP `HUD Inspector` pipelines.

Cross-surface parity is guarded by `tests/surface-parity.test.ts`.

## Session Discovery, Resolution, and Caching

Session handling is split into single-purpose modules:

- `src/collectors/session-discovery.ts`: Read-only discovery across CLI/App `conversation_summaries.db`, cold `brain/` directories and conversation DBs (resolved by physical on-disk ownership before attaching CLI envelopes), filtering exited CLI PIDs and `nesting_depth > 0`, and delegating live-PID ownership to `src/collectors/snapshot-pid-marker.ts` (re-exported via `src/collectors/snapshot-envelope.ts`).
- `src/collectors/session-index.ts`: Tiered session resolution (`explicit` ID/prefix -> live ancestor `pid` -> deepest `workspace` active-first -> `fallback` newest non-exited, tie-break running).
- `src/collectors/snapshot-loader.ts`: Loads full `ActivitySnapshot` (telemetry, transcript tools/skills/MCPs, agents, todos) without mutating App/IDE storage.
- `src/collectors/snapshot-envelope.ts`: Persists bounded `0o600` CLI session envelopes (`agy_hud_snapshot_<id>.json`, <= 512 KiB) with 30-second heartbeat throttling, bounded-skew timestamp validation, monotonic `switchSeq`, frame-start PID marker and heartbeat-aware supersede guards (with verified clock-rollback exemptions), and short non-stalling hot-path PID locking.
- `src/collectors/snapshot-pid-marker.ts`: Reads and validates bounded `0o600` active PID markers (`agy_hud_pid_<pid>.json`), scans fallback peer envelopes on missing markers, and resolves authoritative live-PID session ownership.
- `src/collectors/snapshot-cache-sweep.ts`: Reclaims 7-day expired cache files (`agy_hud_(snapshot|activity|activity_snapshot|telemetry|pid|git)_*.{json,md}`) and 1-hour crashed atomic-write `.tmp.<pid>.<ts>.<16hex>` orphans under `<cliHome>/cache/` (excluding symlinks; `.lock` files are exclusively reclaimed by `src/core/file-lock.ts` or dead-PID cleanup during `unwire`/`uninstall`).

## Ownership and Concurrency Enforcement Map

Normative requirements live in `AGENTS.md`; the concrete enforcement sites are:

- **`statusLine` single writer & quoting**: `src/cli/installer/settings.ts` (AST-enforced by `scripts/validate-architecture.ts`) and `src/core/statusline-ownership.ts` (`formatStatusLineCommand` + `isSameCommandPath`).
- **Interactive draft conflict protection**: `src/cli/configure.ts` captures a SHA-256 revision hash via `readJsonObjectWithHashSync` and re-verifies it inside `withCliHomeLockSync` (`src/core/file-lock.ts`).
- **Strict write-path JSON vs read-only HUD fallback**: `src/fs-utils.ts` (`readJsonObjectSync(..., true)` with fatal UTF-8 decoding) protects all write/CLI/doctor paths; `src/collectors/settings.ts` uses read-only graceful fallback without writing back.
- **Terminal boundary sanitization**: `src/core/terminal-text.ts` (`sanitizeTerminalText`, `sanitizeTerminalLabel`) strips 7-bit/8-bit CSI/OSC/DCS/SOS/PM/APC (including unterminated payloads), C0/C1 controls, and Unicode bidi format controls at collector/session boundaries and output renderers across HUD, OSC 8 Markdown, CLI, and MCP.
- **Snapshot Markdown publication guard**: `src/hud-snapshot-publish.ts` flattens per-session `.md` + per-PID envelope locking into one sorted, short-timeout `withFileLocksSync` call so contended hot-path renders skip cache persistence silently instead of stalling HUD stdout, and skips stale publishes superseded by newer envelopes.
