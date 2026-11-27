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

**Context Budget**:
The active runtime token ceiling for a session turn at which the host triggers automatic context compaction, distinct from the model's nominal maximum window capacity.
_Avoid_: Nominal context window, max model limit, raw window size

**Context Breakdown**:
The categorical attribution of a session's **Context Budget** across system instructions, rules, skills, built-in tools, MCP definitions, conversation messages, and remaining free capacity in an **Activity Snapshot**.
_Avoid_: Prompt dump, token pie, context buckets

**Cache Anomaly**:
An unexpected short-interval drop or total loss of prompt-cache hits between consecutive turns on the same model (excluding cold starts, idle TTL expiry, and context compaction), flagged inline on the perf **Inline Segment** and detailed in **Activity Snapshot**.
_Avoid_: Cache miss, TTL expiry, cold cache

**Line Module**:
An independently pluggable and reorderable status line row, such as mode, identity, usage, Activity Summary, or an individual Activity Line.
_Avoid_: Row widget, bar block, footer slot

**Inline Segment**:
An individually toggleable field within a composite status line row, such as model, git branch, duration, runtime badges, cost, perf capsule, context bar, or quota.
_Avoid_: Sub-chip, inline pill, header token

**Quota Pace**:
A window-relative consumption forecast for a `5h` or `7d` quota pool comparing elapsed reset-window fraction against used quota to project end-of-window surplus or early depletion across the quota **Inline Segment** and **Activity Snapshot**.
_Avoid_: Burn rate, quota velocity, usage speed

**Turn Phase**:
The top-level host execution state of a conversation turn (`idle`, `initializing`, `working`, `tool_use`, `approval`, `reviewing`, `authenticating`, or `error`), surfaced selectively in runtime badges and reported out-of-band in **Activity Snapshot**—distinct from child subagent or swarm lifecycle states.
_Avoid_: Agent state, run status, spinner mode

**Activity Summary**:
A single-line collapsed row summarizing active tools, skills, MCP servers, and agents in place of separate Activity Lines.
_Avoid_: Compact bar, rollup line, mini activity

**CLI Shim**:
A user-level command launcher owned by a specific plugin installation that exposes the CLI to prompt-box shell commands, terminal popup shortcuts, and external shells.
_Avoid_: Plugin shim, global binary, PATH symlink

**CLI Home**:
The Antigravity CLI state directory (`<GEMINI_CLI_HOME|HOME>/.gemini/antigravity-cli`) storing `settings.json`, `hud-config.json`, session `brain/` transcripts, and `cache/`.
_Avoid_: Config root, agy dir, user folder

**Gemini Root**:
The parent `.gemini` directory (`<GEMINI_HOME|HOME/.gemini>`) hosting shared Antigravity CLI assets such as `config/plugins/` and `config/mcp_config.json`.
_Avoid_: Global root, plugin home

**Link Install**:
A development installation (`--link`) that symlinks the plugin target directory to a local repository checkout rather than copying built runtime files.
_Avoid_: Dev copy, soft mount

**Plugin Install**:
A user-facing zero-build installation managed by `agy plugin install <source>`, copying the prebuilt plugin into `Gemini Root`'s `config/plugins/<name>/` and tracking it in `import_manifest.json` (in contrast to a contributor `Link Install`).
_Avoid_: User install, normal install, copy install

**StatusLine Ownership**:
Exact canonical path matching (`<targetDir>/dist/hud.mjs`) between `settings.json`'s `statusLine.command` and a specific plugin installation, gating whether `off` or `uninstall --restore-statusline` may modify `statusLine`.
_Avoid_: Fuzzy match, plugin claim

**StatusLine Backup**:
The JSON record at `<cliHome>/cache/agy-hud-statusline-backup.json` storing `wiredCommand` and the user's prior `statusLine` object before `agy-hud` took over, restored on `uninstall --restore-statusline`.
_Avoid_: Settings snapshot, legacy backup

**Wire / Unwire**:
Host-level integration (`wire` / `unwire`, or `install --wire-statusline` / `uninstall --restore-statusline`) that connects or cleanly detaches `<cliHome>/settings.json` `statusLine` while preserving foreign configurations.
_Avoid_: Patch settings, hook inject
