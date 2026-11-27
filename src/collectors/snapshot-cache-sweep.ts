import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { getExcludedConvCacheNames, SNAPSHOT_CACHE_FILE_RE, SNAPSHOT_TEMP_FILE_RE } from '../core/cache-registry.ts';
import { lstatIfPresentSync } from '../core/fs-utils.ts';
import { resolveTrustedCliDir, sanitizeSessionId } from '../core/safe-path.ts';

export const SNAPSHOT_TTL_MS: number = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_TEMP_GRACE_MS: number = 60 * 60 * 1000;

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
  const safeId = excludeConvId !== undefined ? sanitizeSessionId(excludeConvId) : null;
  const excluded = safeId !== null ? getExcludedConvCacheNames(safeId) : null;
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
