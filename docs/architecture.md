# Architecture Overview

This document maps the runtime entrypoints, module layering, shared data pipelines, and persistence invariants of `agy-hud`.

## Runtime Entrypoints

`agy-hud` compiles to three standalone Node ESM bundles (plus the library entrypoint `src/index.ts`):

| Entrypoint | Bundle | Role |
| :--- | :--- | :--- |
| `src/hud-entry.ts` | `dist/hud.mjs` | Reads Antigravity CLI `statusLine` JSON from `stdin`, invokes `runHudRender`, prints ANSI lines to `stdout` on every ~300 ms host tick. |
| `src/cli-entry.ts` | `dist/cli.mjs` | Unified CLI for `snapshot` (`snap`, `-p`/`--popup`, `--keybindings`), `configure` (flags and `-i` TUI), `export-profile` / `import-profile`, and installer commands (`install`, `uninstall`, `wire`, `unwire`, `on`, `off`, `doctor`). |
| `src/mcp/hud-mcp-entry.ts` | `dist/mcp-hud.mjs` | Read-only stdio JSON-RPC 2.0 MCP server exposing `hud_inspector`, `hud_poll_snapshot`, and the `ui://agy-hud/inspector.html` App UI resource. |

## Layering and Dependencies

Dependencies flow strictly downward with zero `collectors <-> render` cycles (enforced by `scripts/validate-architecture.ts`):

```text
src/hud-entry.ts ──> src/hud-runner.ts ──> src/render/format-hud.ts ──> src/render/modules.ts
                        │                                                 ├── src/render/agents-render.ts
                        │                                                 ├── src/render/activity-lines.ts
                        │                                                 ├── src/render/activity-summary.ts
                        │                                                 └── src/render/ansi.ts + pack-line.ts
                        ├──> src/render/osc8.ts ──> src/render/osc8-markdown.ts
                        └──> src/collectors/* ──> src/core/* + src/fs-utils.ts

src/cli/configure-tui-render.ts ──> src/render/format-hud.ts (pure preview, zero disk or process I/O)
```

Key boundaries:

- **`src/hud-runner.ts`**: Owns all HUD I/O orchestration — loading `hud-config.json`, running lazy collectors only for enabled lines/segments, detecting ancestor `agy` process flags/PID, resolving Git branch and elapsed duration, and publishing snapshot envelopes and OSC 8 Markdown files.
- **`src/render/format-hud.ts` + `src/render/modules.ts`**: Pure layout modules (`buildIdentityLine`, `buildUsageLine`, `buildModeLine`, `LINE_MODULE_REGISTRY`) shared by the live HUD (`hud-runner.ts`) and the `configure -i` live preview (`configure-tui-render.ts`).
- **`src/collectors/`**: Strictly data acquisition and aggregation; forbidden from importing `src/render/` or network APIs.

## Shared Activity and Snapshot Pipeline

All four user-facing surfaces (terminal HUD, OSC 8 Markdown, CLI `snapshot`, and MCP `HUD Inspector`) share two canonical primitives so counts, ordering, and in-place rewrites stay identical:

1. **Incremental transcript scanning** (`src/collectors/transcript-scanner.ts`): Computes stable-prefix hashes (`ino`, `size`, `mtimeNs`, `contentHash`, `stablePrefixHash`) and detects in-place same-inode/same-length transcript rewrites. Consumed by both `src/collectors/activity.ts` (HUD hot path) and `src/collectors/snapshot-transcript.ts` (full snapshot loader).
2. **Activity aggregation** (`src/collectors/activity-aggregate.ts`): Canonical completed-tool grouping, MCP server/subtool grouping, and count-preserving agent merging (retaining multiple completed runs with identical names). Consumed by both `src/collectors/snapshot-loader.ts` and `src/render/osc8-markdown.ts`.

Cross-surface parity is guarded by `tests/surface-parity.test.ts`.

## Session Discovery, Resolution, and Caching

Session handling is split into four single-purpose modules:

- `src/collectors/session-discovery.ts`: Read-only discovery across CLI envelopes, CLI/App `conversation_summaries.db`, brain directories, and cold conversation DBs (filtering exited CLI PIDs and `nesting_depth > 0`).
- `src/collectors/session-index.ts`: Tiered session resolution (`explicit` ID/prefix -> live ancestor `pid` -> deepest `workspace` -> live `fallback`).
- `src/collectors/snapshot-loader.ts`: Loads full `ActivitySnapshot` (telemetry, transcript tools/skills/MCPs, agents, todos) without mutating App/IDE storage.
- `src/collectors/snapshot-envelope.ts`: Persists lightweight CLI session envelopes (`agy_hud_snapshot_<id>.json`) with 30-second heartbeat throttling (skipping disk writes when semantic fields are unchanged) and sweeps stale per-session cache files (`agy_hud_(snapshot|activity|activity_snapshot|telemetry)_*.{json,md}`) after 7 days.

## Ownership and Concurrency Invariants

- **`statusLine` single writer**: Only `src/cli/installer/settings.ts` may write `statusLine` into `<cliHome>/settings.json` or write `agy-hud-statusline-backup.json` (enforced via AST fence in `scripts/validate-architecture.ts`).
- **Interactive config conflict protection**: `configure -i` captures a SHA-256 revision hash when opening the draft and verifies it inside `withCliHomeLockSync` before saving, rejecting stale writes instead of silently overwriting concurrent changes.
- **No silent corruption recovery**: Missing config files initialize cleanly; malformed JSON throws and leaves user files untouched.
