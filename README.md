# agy-hud

An Antigravity CLI plugin that shows live session telemetry below your prompt: model and thinking effort, context usage, rate-limit quotas, throughput/TTFT/cache metrics, active tools, native `/swarm` status, and todos — plus sanitized cross-machine profile migration.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ifelseboyxx/agy-hud)](https://github.com/ifelseboyxx/agy-hud/stargazers)
![Node.js](https://img.shields.io/badge/Node.js-%5E22.20.0%20%7C%7C%20%3E%3D24.0.0-339933)
![Zero Runtime Dependencies](https://img.shields.io/badge/runtime%20deps-0-22D3EE)

![agy-hud in action](assets/preview.png)

> **English** | [简体中文](README.zh-CN.md)

## What You See

The default (`full`) layout renders the active mode, identity and performance metrics, context and quota bars, plus live activity rows whenever tools, skills, MCP servers, swarms, or todos are active:

```text
 ⏵⏵ accept edits on (shift+tab to cycle)
 [G4 Carbon ◑ high] │ agy-hud git:(main*) │ ◷ 12m │ Swarm 1/2 │ Cost $0.185 │ 86.4 t/s · TTFT 1.62s · Cache 94%
  Context █████░░░░░ 48% (480k/1M) │ G 5h: 92.50% (3h 14m) | 7d: 88.20% (102h 6m)
  ◐ Edit: lines.ts | ✓ Read ×4 | ✓ Grep ×2
  ✓ Skills (2): agy-hud-setup, agy-hud-configure
  ✓ MCPs (1): filesystem
  ◐ Swarm (1/2): ◐ coder, ◌ reviewer
  ▸ Verify statusLine rollback guards (2/4) │ BG 1
```

- **Mode line**: current permission or agent mode (`bypass permissions`, `accept edits`, `plan`, `auto`, or `default`), optional Vim mode tag (`[NORMAL]` / `[INSERT]`), and cycle hint.
- **Line 1 (Identity & Perf)**: model and thinking effort (including `Orchestrator (Planner/Executor)` resolution), workspace folder and git branch (`*` when dirty), session duration, active `Swarm` / `Agents` counter, runtime badges (`@agent`, `Battle`, `BG`, `! Approval`, `Q:N`), session cost, and an adaptive **Perf Capsule** (`t/s`, `TTFT`, `Cache%`) that trims segments automatically on narrow terminals.
- **Line 2 (Context & Quota)**: color-coded context bar (cyan below 50%, yellow at 50%+, red at 80%+) with token capacity on terminals `>= 95` columns and compaction-aware estimates (`~used/max`), alongside model-prioritized quota buckets (`G` vs `3P`, with secondary buckets shown when terminal width `>= 120` columns).
- **Activity lines**: live and completed tools, loaded skills and MCP servers, native `/swarm` worker chips (`◐` working, `◌` waiting) merged with stdin subagents without double-counting, and todo progress. Each row collapses cleanly with `+N more` when items exceed one line.

### Display Presets

| Preset | Mode Line | Line 1 & Line 2 | Swarm / Agents Chips | Tools, Skills/MCPs & Todos |
| :--- | :---: | :---: | :---: | :---: |
| `full` *(default)* | On | On | On | On |
| `compact` | On | On | On | Off |
| `minimal` | Off | On | Off | Off |

<!-- Optional preset comparison image: save to assets/presets.png and uncomment below:
![agy-hud presets](assets/presets.png)
-->

## Install

Requires **Antigravity CLI (`agy`)** and **Node.js `^22.20.0 || >=24.0.0`** (`pnpm@11.1.1` if building from source).

### Plugin-First Setup (Recommended)

```bash
agy plugin install https://github.com/ifelseboyxx/agy-hud
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs wire
```

`wire` connects the installed plugin in-place without re-copying files: it backs up any existing `statusLine` in `~/.gemini/antigravity-cli/settings.json`, wires `dist/hud.mjs`, installs an ownership-verified `CLI Shim` (`agy-hud` in `~/.local/bin` on macOS/Linux or `%LOCALAPPDATA%\agy\bin` on Windows — never modifying shell rc files or the Windows Registry), runs `doctor` (including a `5 s` `<shim> --help` smoke check), and prints a single-line `PATH` hint if needed. Pass `--no-shim` to skip the `CLI Shim` or `--bin-dir <dir>` (`AGY_HUD_BIN_DIR`) to choose a custom bin directory. If any step fails, `settings.json` and any prior `agy-hud` shim are rolled back automatically.

To detach host wiring cleanly before uninstalling the plugin:

```bash
agy-hud unwire
agy plugin uninstall agy-hud
```

If you run `agy plugin uninstall agy-hud` without running `unwire` first, the stale `CLI Shim` exits `1` with an actionable `rm`/`del` message on `stderr` without self-deleting.

<details>
<summary><strong>Build from source, development link install, custom targets, diagnostics, and uninstall</strong></summary>

```bash
# Build and install directly from a local clone (global installs manage the CLI Shim unless --no-shim)
git clone https://github.com/ifelseboyxx/agy-hud.git agy-hud
cd agy-hud
pnpm install && pnpm build
node scripts/install.mjs install --wire-statusline

# Symlink this repo into ~/.gemini/config/plugins/agy-hud and wire statusLine + CLI Shim (dev mode)
pnpm hud:wire

# Symlink plugin only, without modifying existing statusLine
pnpm hud:install

# Install into a project's .agents/plugins/agy-hud or a custom directory
# (--project and --target skip CLI Shim unless --bin-dir or AGY_HUD_BIN_DIR is provided)
node scripts/install.mjs install --project [dir]
node scripts/install.mjs install --target <dir> --no-enable

# Run health checks (Node, node:sqlite, stdin render smoke, settings, CLI Shim smoke, agy plugin validate)
agy-hud doctor
# Fallback without CLI Shim:
node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs doctor

# Uninstall plugin, remove owned CLI Shim, and restore backed-up statusLine
node scripts/install.mjs uninstall --restore-statusline
```

</details>

### Enable / Disable

- **Inside Antigravity CLI**: `/statusline` (toggle), `/statusline off` / `/statusline on`, or `/statusline delete` (revert to the built-in default status line).
- **From the terminal**: `agy-hud off` / `agy-hud on` (fallback: `node ~/.gemini/config/plugins/agy-hud/scripts/install.mjs off|on` or `pnpm hud:off` / `pnpm hud:on`), which toggles `statusLine.enabled` and calls `agy plugin disable|enable agy-hud` while preserving any existing `CLI Shim`.
- **Plugin package only**: `agy plugin disable agy-hud` / `agy plugin enable agy-hud`.

## Configure

You can ask Antigravity directly in natural language — the plugin bundles `agy-hud-setup` and `agy-hud-configure` skills — for example: *"Switch agy-hud to compact preset"*, *"Hide cost and show up to 6 swarm chips"*, or *"Run agy-hud diagnostics"*.

Or update settings directly from the terminal (if `--no-shim` was used, replace `agy-hud` with `node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs`):

```bash
# Inspect effective configuration
agy-hud configure --show

# Switch preset (full | compact | minimal)
agy-hud configure --preset compact

# Toggle individual fields
agy-hud configure --set showPerfCapsule=true --set showCost=false --set maxAgentChips=6

# Reset to defaults
agy-hud configure --reset
```

Settings are stored in `~/.gemini/antigravity-cli/hud-config.json` (respects `GEMINI_CLI_HOME`). Inside a source checkout, you can also run `pnpm hud:configure -- <flags>`.

<details>
<summary><strong>All configuration options</strong></summary>

| Key | Type / Values | Default | Description |
| :--- | :--- | :---: | :--- |
| `preset` | `full` \| `compact` \| `minimal` | `full` | Base layout density (presets override lower-priority line flags at render time). |
| `showModeLine` | `boolean` | `true` | Show permission/agent mode line above Line 1. |
| `showPerfCapsule` | `boolean` | `true` | Show `t/s`, `TTFT`, and `Cache%` capsule on Line 1 when terminal width allows. |
| `showQuota` | `boolean` | `true` | Show `5h` / `7d` quota remaining on Line 2. |
| `showCost` | `boolean` | `true` | Show session USD cost on Line 1 when provided by CLI stdin. |
| `showSwarmChips` | `boolean` | `true` | Show Swarm / Subagents activity line. |
| `showToolsLine` | `boolean` | `true` | Show active and completed tools line. |
| `showSkillsMcpLine` | `boolean` | `true` | Show loaded Skills and MCP servers lines. |
| `showTodosLine` | `boolean` | `true` | Show todo progress and background task count line. |
| `maxAgentChips` | integer `0..20` | `4` | Maximum Swarm/Agent chips shown before `+N more` (`0` hides the row). |

</details>

## Profile Migration

Move your Antigravity CLI preferences, HUD settings, MCP server templates, and plugin inventory across machines without leaking credentials:

```bash
# Export sanitized templates and plugins-manifest.json
agy-hud export-profile --out ./agy-profile

# Import on another machine (add --merge-mcp to merge missing MCP servers)
agy-hud import-profile --in ./agy-profile --merge-mcp
```

In `--no-shim` mode, invoke `node ~/.gemini/config/plugins/agy-hud/dist/cli.mjs export-profile|import-profile ...`.

- **Exported bundle**: `settings.template.json`, `config.template.json`, `mcp_config.template.json`, `hud-config.json`, and `plugins-manifest.json`.
- **Automatic sanitization**: applies key whitelists, drops machine-local bindings (`trustedWorkspaces`, `remoteControlHostname`, `sidecars.*.projectId`), and replaces tokens, secrets, sensitive CLI flags/headers, and URL credentials with `<SET_IN_ENV>`. Always review exported files manually before sharing them publicly.
- **Safe import**: validates all input JSON files before writing anything, deep-merges `settings.json` while preserving the target machine's `trustedWorkspaces`, never modifies `~/.gemini/config/config.json` automatically (prints manual reference instructions instead), and skips existing `mcp_config.json` unless `--merge-mcp` is specified.

## Security & Reliability

- **Zero runtime dependencies**: bundled into self-contained ESM (`dist/hud.mjs`, `dist/cli.mjs`) using only Node.js built-ins (`node:sqlite`, `node:fs`, `node:child_process`) and a pure-TypeScript Protobuf decoder.
- **Read-only telemetry & path containment**: session SQLite databases are opened read-only (`?mode=ro` / `?immutable=1`, 50ms timeout) with local `mtime`/size caching. `conversation_id`, `transcript_path`, and skill paths are verified against trusted roots to block path traversal and symlink escapes.
- **Ownership-gated writes & atomic rollback**: `settings.json` is written through a single locked writer (`src/cli/installer/settings.ts`), and `CLI Shim` launchers carry explicit `agy-hud-shim:v1` ownership headers. Preflight refuses foreign files or symlinks before staging files or touching `settings.json`, `off` and `unwire`/`uninstall` verify canonical path ownership before modifying `statusLine` or shims, corrupt user JSON fails closed instead of being overwritten, and failed `install`/`wire` transactions roll back byte-verified changes cleanly.
- **Local-only scope**: reads statusLine stdin JSON, `~/.gemini/antigravity-cli` session state, local `.git/HEAD`, and (during profile commands) `~/.gemini/config`. Makes no network requests.

## Requirements

- Antigravity CLI (`agy`)
- Node.js `^22.20.0 || >=24.0.0` (built-in `node:sqlite`)
- `pnpm@11.1.1` (for building from source and development)

## Development

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs `oxlint --type-aware --deny-warnings`, `oxfmt --check`, `tsc --noEmit`, `vite build` (Vite 8 + Rolldown), isolated `node --test` suites, and repository architecture guardrails.

To test against an isolated home directory without touching your live Antigravity setup, set `GEMINI_CLI_HOME=<tmp>` and `GEMINI_HOME=<tmp>/.gemini` together with `--target <tmp-plugin-dir>`.

## License

MIT. See [LICENSE](LICENSE).

## Star History

<a href="https://star-history.com/#ifelseboyxx/agy-hud&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ifelseboyxx/agy-hud&type=Date" />
  </picture>
</a>
