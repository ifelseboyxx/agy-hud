# Changelog

All notable changes to `agy-hud` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ifelseboyxx/agy-hud/compare/v0.1.0...HEAD
[v0.1.0]: https://github.com/ifelseboyxx/agy-hud/releases/tag/v0.1.0
