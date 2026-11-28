# Changelog

All notable changes to `agy-hud` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.1.1] - 2026-11-28

### Highlights

- Symmetric fallback feedback when `agy plugin disable agy-hud` fails during `install.mjs off`, paired with aligned CLI help strings and isolated installer unit tests.
- Clearer host contract and user documentation covering Antigravity plugin `[disabled]` vs `settings.json` `statusLine` boundaries, `install.mjs off` / `on` ownership and rewiring behavior, and `statusLine` stdin `cost` visibility.

### Changed

- **docs**: Clarify Antigravity plugin `[disabled]` vs `statusLine` boundaries, `install.mjs off` / `on` ownership and rewiring semantics, and the `statusLine` stdin `cost` contract across `README.md`, `README.zh-CN.md`, `docs/host-contracts.md`, and `skills/hud/SKILL.md` ([53ee56f](https://github.com/ifelseboyxx/agy-hud/commit/53ee56f221c61bbd677d4faeefd952e319d33694)).
- **ci**: Focus `pnpm verify` test failure logs, upgrade GitHub Actions to Node 24 runtimes, and harden cross-platform CI guardrails ([7fcabd8](https://github.com/ifelseboyxx/agy-hud/commit/7fcabd896d3e3a102ff31116ca41f0159a53d32a)).

### Fixed

- **cli**: Emit a symmetric fallback `Note:` when `agy plugin disable agy-hud` fails during `install.mjs off` (without blocking exit code `0`), align `on` / `off` CLI help strings, and add isolated unit tests ([5301e7a](https://github.com/ifelseboyxx/agy-hud/commit/5301e7af227510328a6e2cc7e2940f6c819303a5)).

## [v0.1.0] - 2026-11-28

### Highlights

- First official public release of `agy-hud`: a zero-build, zero-runtime-dependency ANSI terminal HUD status line, clickable OSC 8 snapshot viewer, interactive popup inspector, and profile portability toolkit for Antigravity CLI.
- Runs strictly locally with zero network calls and strictly read-only access to Antigravity CLI SQLite/WAL databases.

### Added

- **Live Terminal HUD (`dist/hud.mjs`)**: 5 presets (`full`, `compact`, `swarm`, `minimal`, `zen`), declarative Line Modules and Inline Segments, narrow-pane (`< 100` cols) overrides, 5-tier thinking effort styling (`◔ low` through `✦ max`) with active-turn shimmer and `Orchestrator (Planner/Executor)` parsing, cached non-locking enhanced Git diff stats, offline USD/CNY session cost, clear runtime badges (`@agent`, `Battle`, `Bg Tasks`, `! Approval`, `! Auth`, `Review`, `Retry`, `! Error`, `Queued`), and width-adaptive Perf Capsule (`token/s`, `TTFT`, `Cache%`).
- **Context Budget, Quota Pace & Telemetry Diagnostics**: Effective Context Budget tracking with CJK-aware post-compaction estimates, `Gemini` and `Claude/GPT` quota bars with conditional Quota Pace depletion forecasts, burst/retry-quarantined throughput (`avg` / sustained `peak`), thinking vs reply token breakdown, 180-second per-model `Cache Anomaly` detection, and incremental `Model Time` / `Tool Time` accounting.
- **3-Surface Activity Snapshot (`agy-hud`, `-p`, OSC 8)**: Shared incremental transcript scanner and activity aggregator across the HUD, lazily materialized `0o600` OSC 8 Markdown snapshots (with hardened `file:///` workspace links), `agy-hud` CLI inspector (`--sessions`, `--json`, `--keybindings`), and single-key interactive popup (`1-5/c/a`) with Context Breakdown, Turn Phase, Diagnostics, and bounded subagent telemetry rollups.
- **Configuration, Profiles & Safe Installer (`dist/cli.mjs`, `scripts/install.mjs`)**: Interactive two-tier `configure -i` TUI, deterministic offline `preview`, sanitized `export-profile` / `import-profile`, unified `/hud` skill, read-only `doctor` CLI storage health diagnostics, ownership-gated `wire` / `unwire` / `--purge`, and atomic rollback on failure.
- **Zero-Build Distribution & Release Pipeline**: Standalone 5-file `dist/` build with `100755` executable modes, `pnpm dist:check`, `pnpm validate:plugin`, and zero-dependency `pnpm release` workflow (`prepare` / `tag` / `notes`).

[Unreleased]: https://github.com/ifelseboyxx/agy-hud/compare/v0.1.1...HEAD
[v0.1.1]: https://github.com/ifelseboyxx/agy-hud/compare/v0.1.0...v0.1.1
[v0.1.0]: https://github.com/ifelseboyxx/agy-hud/releases/tag/v0.1.0
