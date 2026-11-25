# Glossary

## Language

**Activity Line**:
A status line row dedicated to live or recently completed session activity for tools, skills, MCP servers, or agents and swarms.
_Avoid_: Detail row, footer line, sub-bar

**Overflow Indicator**:
The trailing `+N more` marker on an Activity Line showing how many items exceed its single-line display capacity.
_Avoid_: Truncation tag, ellipsis badge, more button

**Activity Snapshot**:
The complete, untruncated canonical record of a session's tool counts/targets, skills, MCP servers/subtools, agents, and telemetry available for out-of-band inspection (transport layers may explicitly cap presentation payloads).
_Avoid_: Session dump, overflow log, full history

**Line Module**:
An independently pluggable and reorderable status line row, such as mode, identity, usage, Activity Summary, or an individual Activity Line.
_Avoid_: Row widget, bar block, footer slot

**Inline Segment**:
An individually toggleable field within a composite status line row, such as model, git branch, duration, runtime badges, cost, perf capsule, context bar, or quota.
_Avoid_: Sub-chip, inline pill, header token

**Activity Summary**:
A single-line collapsed row summarizing active tools, skills, MCP servers, and agents in place of separate Activity Lines.
_Avoid_: Compact bar, rollup line, mini activity

**CLI Shim**:
A user-level command launcher owned by a specific plugin installation that exposes the CLI to prompt-box shell commands, terminal popup shortcuts, and external shells.
_Avoid_: Plugin shim, global binary, PATH symlink

**HUD Inspector**:
The interactive GUI view in Antigravity App (side panel and full-page plugin view) presenting live session telemetry and the Activity Snapshot.
_Avoid_: Web dashboard, status sidebar, MCP widget

**CLI Home**:
The Antigravity CLI state directory (`<GEMINI_CLI_HOME|HOME>/.gemini/antigravity-cli`) storing `settings.json`, `hud-config.json`, session `brain/` transcripts, and `cache/`.
_Avoid_: Config root, agy dir, user folder

**Gemini Root**:
The parent `.gemini` directory (`<GEMINI_HOME|HOME/.gemini>`) hosting shared Antigravity assets such as `config/plugins/` and `antigravity/mcp_config.json`.
_Avoid_: Global root, plugin home

**Link Install**:
A development installation (`--link`) that symlinks the plugin target directory to a local repository checkout rather than copying built runtime files.
_Avoid_: Dev copy, soft mount

**StatusLine Ownership**:
Exact canonical path matching (`<targetDir>/dist/hud.mjs`) between `settings.json`'s `statusLine.command` and a specific plugin installation, gating whether `off` or `uninstall --restore-statusline` may modify `statusLine`.
_Avoid_: Fuzzy match, plugin claim

**StatusLine Backup**:
The JSON record at `<cliHome>/cache/agy-hud-statusline-backup.json` storing `wiredCommand` and the user's prior `statusLine` object before `agy-hud` took over, restored on `uninstall --restore-statusline`.
_Avoid_: Settings snapshot, legacy backup

**Wire / Unwire**:
Host-level integration (`wire` / `unwire`, or `install --wire-statusline` / `uninstall --restore-statusline`) that connects or cleanly detaches `<cliHome>/settings.json` `statusLine` while preserving foreign configurations.
_Avoid_: Patch settings, hook inject
