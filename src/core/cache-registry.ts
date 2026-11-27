export const STATUSLINE_BACKUP_FILE: string = 'agy-hud-statusline-backup.json';
export const PROC_CACHE_FILE: string = 'agy_hud_proc.json';
export const SESSIONS_CACHE_FILE: string = 'agy_hud_sessions.json';

export const PROC_LOCK_FILE: string = '.agy_hud_proc.lock';
export const CLI_SETTINGS_LOCK_FILE: string = '.agy-hud-settings.lock';
export const MCP_CONFIG_LOCK_FILE: string = '.agy-hud-mcp.lock';
export const SHIM_BIN_LOCK_FILE: string = '.agy-hud-shim.lock';
const TARGET_FALLBACK_LOCK_FILE = '.agy-hud-target.lock';

// Includes legacy `activity_snapshot` so pre-v6 dual-cache files remain eligible for TTL sweep and unwire cleanup.
const SCOPED_CACHE_KINDS = [
  'snapshot',
  'activity',
  'activity_snapshot',
  'telemetry',
  'subagents',
  'pid',
  'git',
] as const;

const SCOPED_CACHE_BODY = `agy_hud_(?:${SCOPED_CACHE_KINDS.join('|')})_.+\\.(?:json|md)`;
const SINGLETON_CACHE_BODY = 'agy_hud_(?:proc|sessions)\\.json';
const TMP_SUFFIX_BODY = '\\.tmp\\.\\d+\\.\\d+\\.[0-9a-f]{16}';
const BACKUP_FILE_ESCAPED = STATUSLINE_BACKUP_FILE.replaceAll('.', '\\.');

export const SNAPSHOT_CACHE_FILE_RE: RegExp = new RegExp(`^${SCOPED_CACHE_BODY}$`);
export const TRANSIENT_HUD_CACHE_RE: RegExp = new RegExp(`^(?:${SINGLETON_CACHE_BODY}|${SCOPED_CACHE_BODY})$`);
export const TRANSIENT_HUD_TMP_RE: RegExp = new RegExp(
  `^(?:${SCOPED_CACHE_BODY}|${SINGLETON_CACHE_BODY})${TMP_SUFFIX_BODY}$`,
);
export const SNAPSHOT_TEMP_FILE_RE: RegExp = new RegExp(
  `^(?:${SCOPED_CACHE_BODY}|${SINGLETON_CACHE_BODY}|${BACKUP_FILE_ESCAPED})${TMP_SUFFIX_BODY}$`,
);
export const BACKUP_TMP_RE: RegExp = new RegExp(`^${BACKUP_FILE_ESCAPED}${TMP_SUFFIX_BODY}$`);
export const HUD_CACHE_LOCK_RE: RegExp = /^\.agy_hud_.+\.lock$/;
export const SNAPSHOT_ENVELOPE_FILE_RE: RegExp = /^agy_hud_snapshot_(.+)\.json$/;

export function snapshotEnvelopeFileName(safeConvId: string): string {
  return `agy_hud_snapshot_${safeConvId}.json`;
}

export function snapshotMarkdownFileName(safeConvId: string): string {
  return `agy_hud_snapshot_${safeConvId}.md`;
}

export function snapshotLockFileName(safeConvId: string): string {
  return `.agy_hud_snapshot_${safeConvId}.lock`;
}

export function activityCacheFileName(safeConvId: string): string {
  return `agy_hud_activity_${safeConvId}.json`;
}

export function telemetryCacheFileName(safeConvId: string): string {
  return `agy_hud_telemetry_${safeConvId}.json`;
}

export function subagentsCacheFileName(safeConvId: string): string {
  return `agy_hud_subagents_${safeConvId}.json`;
}

export function pidMarkerFileName(agyPid: number): string {
  return `agy_hud_pid_${agyPid}.json`;
}

export function pidLockFileName(agyPid: number): string {
  return `.agy_hud_pid_${agyPid}.lock`;
}

export function gitCacheFileName(hash: string): string {
  return `agy_hud_git_${hash}.json`;
}

export function targetLockFileName(baseName: string): string {
  return baseName.length > 0 ? `.${baseName}.agy-hud.lock` : TARGET_FALLBACK_LOCK_FILE;
}

export function getExcludedConvCacheNames(safeConvId: string): ReadonlySet<string> {
  return new Set([
    snapshotMarkdownFileName(safeConvId),
    snapshotEnvelopeFileName(safeConvId),
    activityCacheFileName(safeConvId),
    `agy_hud_activity_snapshot_${safeConvId}.json`,
    telemetryCacheFileName(safeConvId),
    subagentsCacheFileName(safeConvId),
  ]);
}
