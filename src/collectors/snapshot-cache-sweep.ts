import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { lstatIfPresentSync } from '../fs-utils.ts';
import { resolveTrustedCliDir, sanitizeSessionId } from './safe-path.ts';

export const SNAPSHOT_TTL_MS: number = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_TEMP_GRACE_MS: number = 60 * 60 * 1000;

const SNAPSHOT_CACHE_FILE_RE =
  /^agy_hud_(?:snapshot|activity|activity_snapshot|telemetry|subagents|pid|git)_.+\.(?:json|md)$/;
export const TRANSIENT_HUD_CACHE_RE: RegExp =
  /^(?:agy_hud_(?:proc|sessions)\.json|agy_hud_(?:snapshot|activity|activity_snapshot|telemetry|subagents|pid|git)_.+\.(?:json|md))$/;
export const TRANSIENT_HUD_TMP_RE: RegExp =
  /^agy_hud_(?:(?:snapshot|activity|activity_snapshot|telemetry|subagents|pid|git)_.+\.(?:json|md)|(?:proc|sessions)\.json)\.tmp\.\d+\.\d+\.[0-9a-f]{16}$/;
const SNAPSHOT_TEMP_FILE_RE =
  /^(?:agy_hud_(?:(?:snapshot|activity|activity_snapshot|telemetry|subagents|pid|git)_.+\.(?:json|md)|(?:proc|sessions)\.json)|agy-hud-statusline-backup\.json)\.tmp\.\d+\.\d+\.[0-9a-f]{16}$/;

function buildExcludedConvCacheNames(excludeConvId: string | undefined): ReadonlySet<string> | null {
  const safeId = excludeConvId !== undefined ? sanitizeSessionId(excludeConvId) : null;
  if (safeId === null) return null;
  return new Set([
    `agy_hud_snapshot_${safeId}.md`,
    `agy_hud_snapshot_${safeId}.json`,
    `agy_hud_activity_${safeId}.json`,
    `agy_hud_activity_snapshot_${safeId}.json`,
    `agy_hud_telemetry_${safeId}.json`,
    `agy_hud_subagents_${safeId}.json`,
  ]);
}

export function sweepStaleSnapshotFiles(cliHome: string, nowMs: number = Date.now(), excludeConvId?: string): number {
  const cacheDir = resolveTrustedCliDir(cliHome, 'cache');
  if (cacheDir === null) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return 0;
  }
  const excluded = buildExcludedConvCacheNames(excludeConvId);
  const cutoff = nowMs - SNAPSHOT_TTL_MS;
  const tempCutoff = nowMs - SNAPSHOT_TEMP_GRACE_MS;
  for (const name of entries) {
    const isTemp = SNAPSHOT_TEMP_FILE_RE.test(name);
    if (!isTemp && (!SNAPSHOT_CACHE_FILE_RE.test(name) || excluded?.has(name) === true)) continue;
    const fullPath = path.join(cacheDir, name);
    let st: ReturnType<typeof lstatIfPresentSync>;
    try {
      st = lstatIfPresentSync(fullPath);
    } catch {
      continue;
    }
    if (st === null || st.isSymbolicLink() || !st.isFile()) continue;
    if (st.mtimeMs < (isTemp ? tempCutoff : cutoff)) {
      try {
        rmSync(fullPath, { force: true });
        removed += 1;
      } catch {
        // Ignore best-effort TTL sweep errors.
      }
    }
  }
  return removed;
}
