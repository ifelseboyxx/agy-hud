# Antigravity Host Contracts

This document records the reverse-engineered and protocol-level host contracts that `agy-hud` depends on. When host formats evolve, update the corresponding module and tests alongside this file.

## 1. Protobuf `gen_metadata` Telemetry Schema (`src/collectors/proto.ts`)

Per-conversation SQLite databases store serialized protobuf blobs in `gen_metadata.data`. `parseGenMetadataBlob` decodes raw wire bytes without generated stubs:

- Outer message: field `1` (length-delimited) -> `ChatModel`
  - Field `4` (length-delimited) -> `Usage`:
    - `2` (varint): input tokens (`in`)
    - `3` (varint): output tokens (`out`)
    - `4` (varint): cache write tokens (`cw`)
    - `5` (varint): cache read tokens (`cr`)
  - Field `9` (length-delimited) -> `ChatStart`:
    - Field `10` (length-delimited) -> `CtxWindow`:
      - `1` (varint): context used tokens (`ctxUsed`)
      - `4` (varint): context window limit (`ctxMax`)
  - Field `11` (length-delimited) -> `Duration` (`1=seconds`, `2=nanos`): time to first token (`ttft`)
  - Field `12` (length-delimited) -> `Duration` (`1=seconds`, `2=nanos`): stream duration (`stream`)
  - Field `20` (length-delimited, repeated) -> `KeyValue` (`1=key`, `2=value`): when `key === 'last_step_index'`, integer value populates `stepIdx`.

## 2. SQLite Read-Only WAL and Compaction Contract

### Zero-Mutation Read Policy (`src/collectors/sqlite-readonly.ts`)

Opening a WAL-mode SQLite file with `?mode=ro` in Node can still create or mutate `-wal` and `-shm` sidecar files in the host directory. To uphold zero mutation of Antigravity App/IDE roots:

1. `node:sqlite` is lazy-loaded via `createRequire` only on first DB read (preventing `ExperimentalWarning: SQLite` when DB telemetry is skipped).
2. When no non-empty `-wal` sidecar exists, `withReadonlyDb` opens the DB with `file:<path>?immutable=1` (`readOnly: true`).
3. When a non-empty `-wal` sidecar exists (active writer), `withReadonlyDb` captures pre-copy and post-copy version signatures (stat + SQLite header / WAL header and tail bytes) across `<db>` and `<db>-wal`, copies both into an isolated `mkdtempSync` directory under `os.tmpdir()` (POSIX `0700`) with copied `<db>` / `<db>-wal` files normalized to `0o600`, retries if a checkpoint or WAL rotation occurred mid-copy, reads the consistent snapshot, and removes the temp directory in `finally`.

### Compaction Checkpoints (`src/collectors/compaction.ts`)

- Table `steps`: columns `idx`, `step_type`, `status`, `step_payload`.
- Constants: `STEP_TYPE_CHECKPOINT = 23`, `STEP_TYPE_PLANNER = 15`, `STEP_STATUS_DONE = 3`.
- Compaction is considered active when the latest completed checkpoint `idx` exceeds the last `gen_metadata` row's `stepIdx` (or, when `stepIdx < 0`, no completed planner step follows the checkpoint).

### Conversation Summaries (`src/collectors/session-discovery.ts`)

- Database: `<root>/conversation_summaries.db`, table `conversation_summaries`.
- Columns read: `conversation_id`, `title`, `last_modified_time`, `workspace_uris`, `source`, `not_fully_idle`, `status`, `nesting_depth`, `killed`.
- Subagents (`nesting_depth > 0`) are excluded from top-level session lists. Exited CLI sessions whose recorded `agyPid` is dead are marked non-running even if `status = 'CASCADE_RUN_STATUS_RUNNING'` remains stale in the DB.

## 3. Transcript JSONL In-Place Rewrite Invariant (`src/collectors/transcript-scanner.ts`)

The host may append lines to a transcript JSONL file or rewrite it in place (including same-inode, same-byte-length rewrites or combined out-of-window rewrites plus appends). Incremental caches store `{ ino, size, mtimeNs, ctimeNs, contentHash, stableOffset, stablePrefixHash, stableToolsCount, stableSkillsCount, stableMcpsCount, stableAgentsCount, stableLastModel }`. `contentHash` uses full streaming SHA-256 up to `512 KiB` and a 24 KiB head/mid/tail sampled SHA-256 above `512 KiB` so hot cache hits stay sub-frame (`< 15 ms` median on 64 MiB synthetic logs in `activity-cache.test.ts`), while incremental prefix reuse always verifies `stablePrefixHash` with full streaming SHA-256 so modified prefixes are never persisted across appends. Post-parse hashes are computed directly from the verified prefix and parsed buffer bytes (never re-reading parsed regions from disk), cache persistence is skipped if `fstat` metadata changes mid-scan or if compact serialized JSON exceeds the `16 MiB` cache budget.

## 4. OSC 8 Hyperlinks, `statusLine` Execution, and Terminal Shortcuts (`src/render/osc8.ts`, `src/core/statusline-ownership.ts`, `src/cli/keybindings.ts`)

- Materialized per-session Markdown snapshots (`agy_hud_snapshot_<id>.md`), session envelopes (`agy_hud_snapshot_<id>.json`, <= 512 KiB), active PID markers (`agy_hud_pid_<pid>.json`), `statusLine` backups (`agy-hud-statusline-backup.json`), and sibling JSON caches (`agy_hud_{activity,activity_snapshot,telemetry}_<id>.json`, `agy_hud_proc.json`, `agy_hud_sessions.json`) live under `<cliHome>/cache/` with POSIX mode `0o600`; crashed `.tmp.<pid>.<ts>.<16hex>` cache orphans older than 1 hour are swept alongside 7-day expired caches; Markdown files are linked via `ESC ] 8 ; ; file://... ESC \`.
- Markdown regeneration is gated on a digest covering model, title, workspace, telemetry, and activity so metadata-only changes invalidate stale files.
- Host `statusLine.command` contract: Antigravity CLI executes `settings.json`'s `statusLine.command` via the platform shell (`sh -c` on POSIX, `cmd` on Windows), so `formatStatusLineCommand` keeps safe paths unquoted and quotes special-character paths using POSIX single-quoting (`'\''`) or Windows double-quoting (rejecting control characters, plus `"`, `%`, and `!` on Windows).
- Terminal keybinding templates for Ghostty use `text:!agy-hud\n`, which types into the focused pane; users should only invoke it at the Antigravity CLI prompt (or prefer OSC 8 `Cmd+Click` / `tmux` popup).

## 5. MCP App UI / SEP-1865 Protocol (`src/mcp/`)

- Transport: newline-delimited JSON-RPC 2.0 over `stdio`, defaulting to protocol version `2025-03-26`, with inbound frame size capped at `1_048_576` UTF-8 bytes (symmetric with `HARD_MAX_MCP_RESPONSE_BYTES`; oversized lines are discarded to the next newline boundary and return JSON-RPC `-32600`).
- Tools (`src/mcp/hud-mcp-entry.ts`, `src/mcp/hud-mcp-schema.ts`):
  - `hud_inspector`: declares `_meta.ui = { resourceUri: 'ui://agy-hud/inspector.html', visibility: ['app'] }` and `_meta['com.google.antigravity/ui'].entrypoints` (`aux_pane`, `global`); rejects unknown arguments (`additionalProperties: false`) and blank `sessionId`.
  - `hud_poll_snapshot`: declares `_meta.ui = { visibility: ['app'] }`, accepts `{ sessionId?, source?, etag? }` (`etag` <= 64 UTF-8 bytes), enforces `additionalProperties: false` and non-empty `sessionId`, and orders `runningTools` newest-first.
- Response contracts:
  - Semantic ETag (`src/mcp/hud-mcp-snapshot.ts`): hashes semantic envelope fields + resolution tier + semantic workspace siblings + CLI fallback model + transcript/task content fingerprints + SQLite DB/WAL version signatures + `/swarm` roster (`members.json`) and worker transcript fingerprints + session list metadata (including title and activity timestamp); ignores volatile 30 s envelope heartbeats (`heartbeatAtMs`) and relative `ageLabel` strings so idle polling returns `{ unchanged: true }`.
  - Byte cap (`src/mcp/hud-mcp-cap.ts`, `src/mcp/hud-mcp-entry.ts`): every final JSON-RPC response payload (success and error alike) is hard-capped at `1_048_576` UTF-8 bytes (`HARD_MAX_MCP_RESPONSE_BYTES`); snapshot and tool-result truncations carry `truncated: true`, while oversized protocol errors are converted or clipped to bounded JSON-RPC error objects.
- Client script (`src/mcp/hud-inspector-script.ts`, `src/mcp/hud-inspector-state-script.ts`, `src/mcp/hud-inspector-render-script.ts`): enforces a `10_000` ms request timeout, drops stale out-of-order poll responses via monotonic `selectionSeq` / `latestRequestSeq`, tracks unsettled host push requests structurally with narrowest-prefix settlement so stale overlapping pushes defer to JSON-RPC `pollSnapshot`, validates inbound poll/push payload structure before updating `etag` or rendering, normalizes numeric slots before HTML interpolation, and coalesces queued refreshes after an in-flight poll finishes.
