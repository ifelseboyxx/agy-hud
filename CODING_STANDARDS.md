# Coding Standards

Review-stage judgement standards for `agy-hud` (enforced during `/code-review`, complementing `pnpm verify` tooling).

## Security & Filesystem Boundaries

- **Positive controls on blocking tests**: Every test verifying that an attack vector or invalid state is blocked (`null`, `0`, or throw) must first assert that the baseline valid payload succeeds before introducing the attack vector.
- **`statIfPresentSync` vs `lstatIfPresentSync`**: Use symlink-following `statIfPresentSync()?.isFile()` / `isDirectory()` for artifacts that must work through Link Install (`--link`) symlinks (`wire`, `install`, `doctor`). Reserve `lstatIfPresentSync` for symlink-refusing security boundaries (SQLite DB/sidecars, cache writes, CLI Shim inspection/unlinking).

## Concurrency & Cross-Surface Verification

- **Interactive config concurrency**: Changes to interactive config save require a lock-interleaved test verifying stale-draft rejection while preserving concurrent writes.
- **CLI SQLite/WAL read-only & 3-surface parity**: Changes to CLI SQLite/WAL reading must verify zero directory/content mutations in temporary database directories (including closed-writer WAL scenarios) and use an isolated CLI Home for diagnostics. Changes to transcript continuation or Activity Snapshot aggregation must verify 3-surface CLI parity across HUD, OSC 8 Markdown, and CLI `snapshot` on one shared fixture (including same-inode same-length rewrites).

## Test Granularity & Lifecycle Hygiene

- **One behavior per `it`**: Keep unit tests (`__tests__/`) to one behavior and one failure path per `it` (target `<= 500ms`), without chaining unrelated scenarios in one title. Keep integration tests (`tests/`) to one end-to-end invariant per `it` (target `~2s`), and always release child-process lock or flag barriers inside `try/finally`.
- **Unreleased persistence formats**: Before the first public release, evolve owned persistence formats (backups, caches, `hud-config.json`) directly without legacy branches or migration shims; post-release compatibility branches must record their introducing version and removal condition.

## Architecture & Distribution Hygiene

- **Test hermeticity (`PATH` isolation)**: Isolated test environments (`makeIsolatedEnv`) must strip host `agy` directories from `PATH` by default; tests exercising host CLI interactions must inject an explicit `createFakeAgyBin` fixture.
- **Describe boundaries, not caller lists**: Keep `docs/architecture.md` focused on layer boundaries and shared contracts rather than enumerating individual consumer filenames that drift during refactors.
