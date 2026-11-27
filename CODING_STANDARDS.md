# Coding Standards

Review-stage judgement standards for `agy-hud` (enforced during `/code-review`, complementing `pnpm verify` tooling).

## Security & Filesystem Boundaries

- **Positive controls on blocking tests**: Every test verifying that an attack vector or invalid state is blocked (`null`, `0`, or throw) must first assert that the baseline valid payload succeeds before introducing the attack vector.
- **`statIfPresentSync` vs `lstatIfPresentSync`**: Use symlink-following `statIfPresentSync()?.isFile()` / `isDirectory()` for artifacts that must work through Link Install (`--link`) symlinks (`wire`, `install`, `doctor`). Reserve `lstatIfPresentSync` for symlink-refusing security boundaries (SQLite DB/sidecars, cache writes, CLI Shim inspection/unlinking).

## Concurrency & Cross-Surface Verification

- **Interactive config & MCP polling**: Changes to interactive config save require a lock-interleaved test verifying stale-draft rejection while preserving concurrent writes. Changes to HUD Inspector polling or host pushes require an interleaved test verifying bidirectional stale response dropping by `session + source + request sequence` with retry after timeout.
- **Cross-host read-only & 4-surface parity**: Changes to cross-host session reading must verify zero directory/content mutations in a temporary App root (including closed-writer WAL scenarios) and use an isolated CLI Home for diagnostics. Changes to transcript continuation or Activity Snapshot aggregation must verify parity across HUD, OSC 8 Markdown, CLI `snapshot`, and MCP `HUD Inspector` on one shared fixture (including same-inode same-length rewrites).

## Test Granularity & Lifecycle Hygiene

- **One behavior per `it`**: Keep unit tests (`__tests__/`) to one behavior and one failure path per `it` (target `<= 500ms`), without chaining unrelated scenarios in one title. Keep integration tests (`tests/`) to one end-to-end invariant per `it` (target `~2s`), and always release child-process lock or flag barriers inside `try/finally`.
- **Unreleased persistence formats**: Before the first public release, evolve owned persistence formats (backups, caches, `hud-config.json`) directly without legacy branches or migration shims; post-release compatibility branches must record their introducing version and removal condition.

## Architecture & Distribution Hygiene

- **Pure `src/render/` & server-side formatting parity**: Keep `src/render/` strictly pure (zero file locks, disk writes, or `hud-runner` cycles; AST-enforced by `scripts/validate-architecture.ts`). Pre-compute shared currency/telemetry strings in Node rather than re-implementing float math inside client script templates.
- **Test hermeticity (`PATH` isolation)**: Isolated test environments (`makeIsolatedEnv`) must strip host `agy` directories from `PATH` by default; tests exercising host CLI interactions must inject an explicit `createFakeAgyBin` fixture.
- **Standalone `dist/` & `.d.mts` verification**: `dist/` emits strictly 6 standalone files with self-contained `.d.mts` declarations verified via `ts.createProgram` and `--git-clean` index checks (`pnpm dist:check --git-clean`).
- **Describe boundaries, not caller lists**: Keep `docs/architecture.md` focused on layer boundaries and shared contracts rather than enumerating individual consumer filenames that drift during refactors.
