---
name: hud
description: Activate, preview, customize, diagnose, or cleanly uninstall the agy-hud terminal status line and CLI toolkit in Antigravity CLI.
---

# `/hud` — Agy HUD Setup, Customization, Diagnostics & Uninstall

Use this skill to manage `agy-hud` in **Antigravity CLI** (live terminal status line, activity snapshots, offline previews, and profile migration).

## Resolve `<PLUGIN_ROOT>` & Install Scope First

Resolve `<PLUGIN_ROOT>` strictly relative to this `SKILL.md` file (`../..`, i.e., two directories above `skills/hud/SKILL.md`). Never assume `~/.gemini/config/plugins/agy-hud`, so global installs, Marketplace installs (whose folder name may differ), and workspace `<project>/.agents/plugins/agy-hud` installs all work without mutating another installation.

- CLI entrypoint: `node "<PLUGIN_ROOT>/dist/cli.mjs"` (or `agy-hud` when the optional `CLI Shim` is installed on `PATH`)
- Installer entrypoint: `node "<PLUGIN_ROOT>/scripts/install.mjs"`
- HUD statusline entrypoint: `<PLUGIN_ROOT>/dist/hud.mjs` (display with `~/` when inside `$HOME`, e.g. `~/.gemini/config/plugins/<dir>/dist/hud.mjs`)
- **Installer target flags (`<TARGET_ARGS>`)**:
  - Default global install (`~/.gemini/config/plugins/agy-hud`): no target flag needed.
  - Workspace install (`<project>/.agents/plugins/agy-hud`): ALWAYS pass `--project "<project>"` (targets the workspace copy and avoids touching global `CLI Shim` or global host registration).
  - Marketplace or custom directory (any other path): ALWAYS pass `--target "<PLUGIN_ROOT>"` (add `--bin-dir ~/.local/bin` only if the user explicitly opts into installing/removing the global `CLI Shim`).

## 1. Default `/hud` & `/hud check` (Read-Only First)

Always inspect read-only health for this exact `<PLUGIN_ROOT>` first before suggesting changes:

```bash
node "<PLUGIN_ROOT>/scripts/install.mjs" doctor <TARGET_ARGS>
node "<PLUGIN_ROOT>/dist/cli.mjs" configure --show
```

Summarize Node.js compatibility, `node:sqlite`, `dist/hud.mjs` smoke status, `statusLine` state, `CLI Shim` state, active preset/currency/narrow settings, and (if a `Link Install` symlink is detected) the two-command migration to zero-build `Plugin Install`:

```bash
agy plugin uninstall agy-hud
agy plugin install https://github.com/ifelseboyxx/agy-hud
```

## 2. `/hud setup` (CLI Activation)

1. **Primary — instant hot-reload (no CLI restart required)**: Give the user the exact `/statusline` command using the resolved `<PLUGIN_ROOT>/dist/hud.mjs` path (shortened to `~/` when inside `$HOME`) and explicit `node` invocation (works across macOS, Linux, Windows, workspace installs, and Marketplace bundles):
   ```text
   /statusline node ~/.gemini/config/plugins/<dir>/dist/hud.mjs
   ```
2. **Confirmed automatic `settings.json` wiring (fallback)**: Only after explicit user confirmation, run:
   ```bash
   node "<PLUGIN_ROOT>/scripts/install.mjs" wire <TARGET_ARGS> --no-shim
   ```
   (Creates a `StatusLine Backup`, writes `settings.json` atomically, and rolls back on failure.)
3. **Optional `CLI Shim` (power users)**: Offer to install the standalone `agy-hud` command (`~/.local/bin/agy-hud` or `%LOCALAPPDATA%\agy\bin\agy-hud.cmd`) for `!agy-hud`, `agy-hud -p` popups, and shell previews (for non-default `<PLUGIN_ROOT>`, include `--bin-dir ~/.local/bin`):
   ```bash
   node "<PLUGIN_ROOT>/scripts/install.mjs" wire <TARGET_ARGS>
   ```
4. **Pause / resume vs. plugin `[disabled]` state**: Disabling `agy-hud` in Antigravity's plugin UI or via `agy plugin disable agy-hud` only updates `~/.gemini/config/config.json` and unloads the `/hud` skill — it does **not** disable `statusLine` in `~/.gemini/antigravity-cli/settings.json`. Use `/statusline off` / `/statusline on` to toggle only the status line, or run:
   ```bash
   node "<PLUGIN_ROOT>/scripts/install.mjs" off <TARGET_ARGS>
   node "<PLUGIN_ROOT>/scripts/install.mjs" on <TARGET_ARGS>
   ```
   (`off` is gated by `StatusLine Ownership` and leaves foreign `statusLine` entries untouched; `on` rewires `<PLUGIN_ROOT>/dist/hud.mjs` into `<cliHome>/settings.json`, recording a `StatusLine Backup` if taking over a foreign command — note `--project` / `--target` select `<PLUGIN_ROOT>` while sharing the same `<cliHome>/settings.json`. Only on default global installs without `--no-enable` and when `agy` is on `PATH`, `off` / `on` also attempt `agy plugin disable|enable agy-hud` best-effort and print a `Note:` without failing if the host command fails.)
5. **Sandbox fallback**: If sandbox policies block writes outside the workspace, print the exact OS-appropriate copy-pasteable command (using `~/` on POSIX or `%USERPROFILE%` on Windows) instead of retrying blocked writes.

## 3. `/hud preview`, Presets, Cost Currency & Narrow Overrides

- **Offline preview** (zero session needed):
  ```bash
  node "<PLUGIN_ROOT>/dist/cli.mjs" preview 120
  node "<PLUGIN_ROOT>/dist/cli.mjs" preview --narrow
  node "<PLUGIN_ROOT>/dist/cli.mjs" preview --all-presets
  ```
- **Switch preset** (`full | compact | swarm | minimal | zen`):
  ```bash
  node "<PLUGIN_ROOT>/dist/cli.mjs" configure compact
  ```
- **Toggle modules, segments, cost currency (`usd | cny | both`), FX rate, and narrow (`< 100` cols) overrides**:
  ```bash
  node "<PLUGIN_ROOT>/dist/cli.mjs" configure --set costCurrency=both --set usdToCnyRate=7.25
  node "<PLUGIN_ROOT>/dist/cli.mjs" configure --narrow-disable cost,perf,todos
  node "<PLUGIN_ROOT>/dist/cli.mjs" configure --enable tools,agents --disable activity --order identity,usage,tools,agents
  node "<PLUGIN_ROOT>/dist/cli.mjs" configure --set osc8Links=false --set maxAgentChips=6
  node "<PLUGIN_ROOT>/dist/cli.mjs" configure --reset
  ```
- **When `Cost` is hidden**: Live `Cost` renders whenever Antigravity CLI reports a finite non-negative `cost` total in `statusLine` stdin (converted offline via `costCurrency` / `usdToCnyRate`; offline `preview` uses built-in sample cost when `segments.cost` is enabled). When stdin omits `cost` or has no valid total (e.g., quota-based subscriptions or models without reported pricing), HUD, newly rendered Markdown snapshots, and CLI `snapshot` text omit it (previously materialized `.md` files refresh on the next frame emitting an OSC 8 link, and `snapshot --json` emits `cost: null` / `costDisplay: null`) instead of estimating from a local pricing table.
- **Interactive TTY editor**: `agy-hud configure -i` (requires an interactive terminal).
- **Sanitized profile export/import**:
  ```bash
  node "<PLUGIN_ROOT>/dist/cli.mjs" export-profile --out ./agy-profile
  node "<PLUGIN_ROOT>/dist/cli.mjs" import-profile --in ./agy-profile --merge-mcp
  ```

## 4. `/hud uninstall` (Strict 4-Step Safe Cleanup)

1. **Inspect read-only**: Check `statusLine` ownership, `CLI Shim`, `hud-config.json`, and install scope (`Plugin Install`, `Link Install`, Marketplace directory, or workspace `<project>/.agents/plugins/agy-hud`).
2. **Confirm cleanup tier** (skip asking only if the user already specified `--purge`):
   - **Default**: restores owned `statusLine`, removes owned `CLI Shim`, sweeps transient `agy_hud_*` caches, and **preserves `hud-config.json`** for painless reinstall.
   - **`--purge` (zero-residue)**: additionally deletes `hud-config.json` and any orphaned `agy-hud-statusline-backup.json` after restore/shim succeed.
3. **Execute in strict detach-first order** (prevents `agy`'s 30-failure `statusLine` circuit breaker):
   - **Default global `Plugin Install` (`~/.gemini/config/plugins/agy-hud`)**:
     ```bash
     # Step 1: Detach statusLine, remove owned CLI Shim, and sweep caches (add --purge for zero-residue)
     node "<PLUGIN_ROOT>/scripts/install.mjs" unwire
     # Step 2: Remove the plugin cleanly from Antigravity host
     agy plugin uninstall agy-hud
     ```
   - **Non-default Marketplace or custom `--target` install**:
     ```bash
     # Step 1: Detach statusLine and sweep caches for this exact <PLUGIN_ROOT> (add --purge for zero-residue)
     node "<PLUGIN_ROOT>/scripts/install.mjs" unwire --target "<PLUGIN_ROOT>"
     # Step 2: Inspect `agy plugin list --json` for the exact plugin name/id pointing to <PLUGIN_ROOT>.
     # If host-managed, run `agy plugin uninstall <exact-plugin-name>`; otherwise remove only <PLUGIN_ROOT>:
     node "<PLUGIN_ROOT>/scripts/install.mjs" uninstall --target "<PLUGIN_ROOT>" --restore-statusline
     ```
   - **Workspace `.agents/plugins/agy-hud` install**:
     ```bash
     # Step 1: Detach workspace statusLine and sweep caches (add --purge for zero-residue)
     node "<PLUGIN_ROOT>/scripts/install.mjs" unwire --project "<project>"
     # Step 2: Remove only the workspace plugin directory (do NOT uninstall any separate global plugin)
     node "<PLUGIN_ROOT>/scripts/install.mjs" uninstall --project "<project>" --restore-statusline
     ```
   Print the cleaned-files receipt and remind the user they can also run `/statusline delete` inside the live CLI session to clear the active bar immediately without restarting.
4. **Sandbox fallback**: If writes outside the workspace are blocked, output the exact two OS-appropriate commands (`~/` on POSIX, `%USERPROFILE%` on Windows) with an explicit note to run Step 1 before Step 2.
