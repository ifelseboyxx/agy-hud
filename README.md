# agy-hud

An Antigravity CLI and App plugin that shows live session telemetry below your prompt — model and thinking effort, context usage, rate-limit quotas, throughput/TTFT/cache metrics, active tools, skills, MCP servers, native `/swarm` status, and todos — with one-click overflow inspection, interactive terminal configuration, and sanitized profile migration.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ifelseboyxx/agy-hud)](https://github.com/ifelseboyxx/agy-hud/stargazers)
![Node.js](https://img.shields.io/badge/Node.js-%5E22.20.0%20%7C%7C%20%3E%3D24.0.0-339933)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime%20deps-0-22D3EE)

![agy-hud in action](assets/preview.png)

> **English** | [简体中文](README.zh-CN.md)

## What You See

The default (`full`) layout renders active mode, identity and performance metrics, context and quota bars, plus live activity rows whenever tools, skills, MCP servers, swarms, or todos are active:

```text
 ⏵⏵ accept edits on (shift+tab to cycle)
 [G4 Carbon ◑ high] │ agy-hud git:(main*) │ ◷ 12m │ Swarm 1/2 │ Cost $0.185 │ 86.4 t/s · TTFT 1.62s · Cache 94%
  Context █████░░░░░ 48% (480k/1M) │ G 5h: 92.50% (3h 14m) | 7d: 88.20% (102h 6m)
  ◐ Edit: lines.ts | ✓ Read ×4 | ✓ Grep ×2 | +3 more
  ✓ Skills (2): agy-hud-setup, agy-hud-configure
  ✓ MCPs (1): filesystem
  ◐ Swarm (1/2): ◐ coder, ◌ reviewer
  ▸ Verify statusLine rollback guards (2/4) │ BG 1
```

- **Mode line (`mode`)**: active permission or agent mode (`bypass permissions`, `accept edits`, `plan`, `auto`, or `default`), optional Vim mode tag (`[NORMAL]` / `[INSERT]`), and cycle hint.
- **Identity & Perf (`identity`)**: model and thinking effort (including `Orchestrator (Planner/Executor)`), workspace folder and git branch (`*` when dirty), duration, active `Swarm` / `Agents` counter, runtime badges (`@agent`, `Battle`, `BG`, `! Approval`, `Q:N`), session cost, and an adaptive **Perf Capsule** (`t/s`, `TTFT`, `Cache%`).
- **Context & Quota (`usage`)**: color-coded context bar with token capacity and compaction-aware estimates (`~used/max`), alongside model-prioritized quota buckets (`G` vs `3P`).
- **Activity lines (`tools`, `skills`, `mcps`, `agents`, `todos`) & collapsed summary (`activity`)**: live and completed tools, loaded skills and MCP servers, native `/swarm` and subagent chips (`◐` working, `◌` waiting), and todo progress. Each row packs greedily within terminal width and turns `+N more` (or `· snapshot` on `compact`) into a clickable OSC 8 link when supported.

### Display Presets

| Preset | Default Lines | Inline Segments | Best For |
| :--- | :--- | :--- | :--- |
| `full` *(default)* | `mode`, `identity`, `usage`, `tools`, `skills`, `mcps`, `agents`, `todos` | All enabled | Complete live diagnostics |
| `compact` | `mode`, `identity`, `usage`, `activity` | All enabled | Daily coding with single-line concrete Activity Summary |
| `swarm` | `mode`, `identity`, `usage`, `agents`, `todos` | All enabled | Multi-agent orchestration focus |
| `minimal` | `identity`, `usage` | `model`, `git`, `badges`, `context`, `quota` | Clean two-row bars without activity noise |
| `zen` | `identity` (folds `Ctx%` & `5h%` inline) | `model`, `git`, `badges`, `context`, `quota` | Strict single-row narrow terminals & split panes |

## Install

Requires **Antigravity CLI (`agy`)** and **Node.js `^22.20.0 || >=24.0.0`**.

```bash
# 1. Install the plugin package
agy plugin install https://github.com/ifelseboyxx/agy-hud

# 2. Connect the HUD status line and install the `agy-hud` command
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire
```

`wire` backs up any existing status line in `~/.gemini/antigravity-cli/settings.json`, enables `agy-hud`, installs the `agy-hud` terminal command (`~/.local/bin/agy-hud` on macOS/Linux or `%LOCALAPPDATA%\agy\bin\agy-hud.cmd` on Windows), and verifies everything works — rolling back automatically if any step fails.

To pause or resume the HUD at any time:
- **Inside Antigravity CLI**: `/statusline` (toggle), `/statusline off`, or `/statusline on`.
- **From the terminal**: `agy-hud off` / `agy-hud on` (or `agy plugin disable|enable agy-hud`).

<details>
<summary><strong>Advanced install options, build from source, and diagnostics</strong></summary>

```bash
# Skip installing the `agy-hud` terminal command (invoke via node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs)
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire --no-shim

# Install the terminal command into a custom directory (or set AGY_HUD_BIN_DIR)
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire --bin-dir ~/.bin

# Run full health checks (Node, node:sqlite, HUD render smoke, settings, command smoke, plugin validation)
agy-hud doctor
# Fallback without `agy-hud` on PATH:
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs doctor

# Build and install directly from a local git clone (requires pnpm@11.1.1)
git clone https://github.com/ifelseboyxx/agy-hud.git agy-hud
cd agy-hud
pnpm install && pnpm build
node scripts/install.mjs install --wire-statusline

# Link-install from a local source checkout for development
pnpm hud:wire     # symlink plugin + wire statusLine + install command
pnpm hud:install  # symlink plugin only without modifying statusLine

# Project-local or custom target installs (skip global command unless --bin-dir / AGY_HUD_BIN_DIR is passed)
node scripts/install.mjs install --project [dir]
node scripts/install.mjs install --target <dir> --no-enable
```

</details>

## Uninstall

### Recommended Uninstall

```bash
# 1. Restore your previous status line and remove the `agy-hud` command
agy-hud unwire

# 2. Remove the plugin package
agy plugin uninstall agy-hud
```

If you skipped the `agy-hud` command (`--no-shim`), run the unwire step directly:

```bash
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs unwire
agy plugin uninstall agy-hud
```

- **Quick in-session revert**: run `/statusline delete` inside Antigravity CLI to switch back to the built-in default status line immediately.
- **Uninstalled plugin before running `unwire`?** Running the leftover `agy-hud` command prints the exact `rm` / `del` path on `stderr` and exits `1` without deleting files on its own; delete that shim file manually and run `/statusline delete` inside Antigravity CLI (or remove `statusLine` from `~/.gemini/antigravity-cli/settings.json`) to revert the status line.
- **Source / link-install uninstall**: inside a local checkout, run `node scripts/install.mjs uninstall --restore-statusline`.
- **File footprint**: `unwire` + `agy plugin uninstall` removes `~/.gemini/config/plugins/agy-hud`, the owned `agy-hud` command, and `~/.gemini/antigravity-cli/cache/agy-hud-statusline-backup.json` (after restoring your previous `statusLine`). Optional preferences (`~/.gemini/antigravity-cli/hud-config.json`) and local snapshot caches (`~/.gemini/antigravity-cli/cache/agy_hud_*`) can be deleted manually if you want a full clean slate.

## Overflow Inspection & HUD Inspector

When session activity exceeds a single status line, you can inspect the full untruncated Activity Snapshot across three channels:

- **Clickable OSC 8 links**: `Cmd+Click` (or terminal hyperlink open) any `+N more` badge or `· snapshot` tail to open the session's local GFM Markdown snapshot (`0o600`, written lazily only when a link is actually emitted and content changes).
- **Terminal Inspector & Popup (`agy-hud` / `agy-hud snapshot`)**:
  ```bash
  # Inspect the active session right from the Antigravity prompt box (!agy-hud) or any shell
  agy-hud
  agy-hud snapshot tools agents

  # Open the single-key-dismiss interactive overlay (q/Esc/Enter close, 1-4/a filter, j/k scroll, r reload)
  agy-hud -p

  # List active and recent CLI / APP / IDE sessions or emit structured JSON
  agy-hud --sessions
  agy-hud -s <id-or-prefix> --source all --json

  # Print ready-to-paste popup shortcut snippets (tmux, kitty, wezterm, ghostty, iterm2, or all)
  agy-hud --keybindings
  agy-hud --keybindings all
  ```
- **Antigravity App `HUD Inspector` (MCP App)**: bundled automatically via `mcp_config.json` (`dist/mcp-hud.mjs`). Open **HUD Inspector** from the Antigravity App side panel (`aux_pane`) or full-page plugin view (`global`) for live 2-second visibility-gated telemetry, searchable running and completed tools, skills, MCP breakdowns, swarm rosters, and clickable local file links that open directly in the side pane.

## Configure

You can ask Antigravity in natural language — the plugin bundles `agy-hud-setup` and `agy-hud-configure` skills — or configure directly from the terminal (without `agy-hud` on `PATH`, replace `agy-hud` with `node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs`):

```bash
# Launch the interactive two-tier TUI editor (presets + live preview, then module toggle & reorder)
agy-hud configure -i

# Inspect effective configuration
agy-hud configure --show

# Switch preset (full | compact | swarm | minimal | zen)
agy-hud configure compact

# Enable, disable, or reorder Line Modules and Inline Segments in one command
agy-hud configure compact --enable tools,agents --disable activity,cost --order identity,usage,tools,agents

# Update top-level options or inline segments
agy-hud configure --set osc8Links=false --set maxAgentChips=6 --set segments.perf=true

# Reset to full defaults
agy-hud configure --reset
```

Settings live in `~/.gemini/antigravity-cli/hud-config.json` (respects `GEMINI_CLI_HOME`). Inside a source checkout, you can also run `pnpm hud:configure -- <flags>`.

<details>
<summary><strong>All configuration options</strong></summary>

| Key | Type / Values | Default | Description |
| :--- | :--- | :---: | :--- |
| `preset` | `full` \| `compact` \| `swarm` \| `minimal` \| `zen` | `full` | Base persona preset used to seed `lines` and `segments`. |
| `lines` | Ordered array of `mode`, `identity`, `usage`, `activity`, `tools`, `skills`, `mcps`, `agents`, `todos` | `full` lines | Explicit pluggable rows rendered in order; empty rows auto-collapse. |
| `segments` | Booleans for `model`, `git`, `duration`, `badges`, `cost`, `perf`, `context`, `quota` | All `true` | Toggleable inline segments within `identity` and `usage` (and `zen` folded tail). |
| `osc8Links` | `boolean` | `true` | Emit OSC 8 hyperlinks on `+N more` / `snapshot` (suppressed under `NO_COLOR`, `TERM=dumb`, or SSH). |
| `maxAgentChips` | integer `0..20` | `8` | Maximum Swarm/Agent chips shown before `+N more` (`0` hides the row). |

</details>

## Profile Migration

Move your Antigravity CLI preferences, HUD settings, MCP server templates, and plugin inventory across machines without leaking credentials:

```bash
# Export sanitized templates and plugins-manifest.json
agy-hud export-profile --out ./agy-profile

# Import on another machine (add --merge-mcp to merge missing MCP servers)
agy-hud import-profile --in ./agy-profile --merge-mcp
```

- **Exported bundle**: `settings.template.json`, `config.template.json`, `mcp_config.template.json`, `hud-config.json`, and `plugins-manifest.json`.
- **Automatic sanitization**: applies key whitelists, drops machine-local bindings (`trustedWorkspaces`, `remoteControlHostname`, `sidecars.*.projectId`), and replaces tokens, secrets, sensitive CLI flags/headers, and URL credentials with `<SET_IN_ENV>`. Always review exported files manually before sharing them publicly.
- **Safe import**: validates all input JSON files before writing anything, deep-merges `settings.json` while preserving the target machine's `trustedWorkspaces`, never modifies `~/.gemini/config/config.json` automatically (prints manual reference instructions instead), and skips existing `mcp_config.json` unless `--merge-mcp` is specified.

## Security & Reliability

- **Zero runtime dependencies**: bundled into self-contained ESM (`dist/hud.mjs`, `dist/cli.mjs`, `dist/mcp-hud.mjs`) using only Node.js built-ins (`node:sqlite`, `node:fs`, `node:child_process`) and a pure-TypeScript Protobuf decoder.
- **Read-only telemetry & path containment**: session SQLite databases and Antigravity App/IDE roots are accessed strictly read-only (`?immutable=1` or an isolated temporary WAL snapshot copy under `os.tmpdir()`, 50ms timeout, zero writes to host roots) with all caches confined to `<cliHome>/cache`. `conversation_id`, `transcript_path`, and skill paths are verified against trusted roots to block traversal and symlink escapes.
- **Ownership-gated writes & atomic rollback**: `settings.json` is written through a single locked writer (`src/cli/installer/settings.ts`). Command launchers carry explicit `agy-hud-shim:v1` ownership headers (including a Windows `.cmd` + companion POSIX script pair) and pass a `5 s` `--help` smoke check during `wire`/`install` without touching shell rc files or the Windows Registry. Preflight refuses foreign files or symlinks before staging anything, `off`/`unwire`/`uninstall` verify canonical ownership, corrupt user JSON fails closed without being overwritten, and failed `install`/`wire` transactions roll back atomically.
- **Local-only scope**: reads statusLine stdin JSON, local Antigravity session roots, local `.git/HEAD`, and (during profile commands) `~/.gemini/config`. Makes no network requests; the MCP App HTML is 100% self-contained (`default-src 'none'` CSP compliant).

## Development

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs `oxlint --type-aware --deny-warnings`, `oxfmt --check`, `tsc --noEmit`, `pnpm build` (Vite 8 + Rolldown), isolated `node --test` suites, and repository architecture guardrails.

To test against an isolated home directory without touching your live Antigravity setup, set `GEMINI_CLI_HOME=<tmp>` and `GEMINI_HOME=<tmp>/.gemini` together with `--target <tmp-plugin-dir>`.

## License

MIT. See [LICENSE](LICENSE).

## Star History

<a href="https://star-history.com/#ifelseboyxx/agy-hud&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date&theme=light" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date" />
  </picture>
</a>
