import { opendirSync } from 'node:fs';
import path from 'node:path';

import { withReadonlyDb } from '../../collectors/sqlite-readonly.ts';
import { HUD_CACHE_LOCK_RE, TRANSIENT_HUD_CACHE_RE, TRANSIENT_HUD_TMP_RE } from '../../core/cache-registry.ts';
import { lstatIfPresentSync } from '../../core/fs-utils.ts';
import { isPlainObject } from '../../core/guards.ts';
import { sanitizeSessionId } from '../../core/safe-path.ts';

const MAX_DOCTOR_STORAGE_DIR_ENTRIES = 5_000;
const MAX_DOCTOR_STORAGE_SCAN_MS = 250;
const BUDGET_CHECK_STRIDE = 128;
const SUMMARY_IN_BATCH_SIZE = 200;
const BYTES_PER_MIB = 1024 * 1024;
const MAX_SUMMARY_WAL_COPY_BYTES = 32 * BYTES_PER_MIB;
const OVERSIZED_WAL_BYTES = 32 * BYTES_PER_MIB;

const DEFAULT_THRESHOLDS: Required<CliStorageThresholds> = {
  dbPlusWalBytes: 1024 * BYTES_PER_MIB,
  dbCount: 1_000,
  maxWalBytes: 64 * BYTES_PER_MIB,
  walTotalBytes: 256 * BYTES_PER_MIB,
  hudCacheBytes: 64 * BYTES_PER_MIB,
};

export interface CliStorageThresholds {
  readonly dbPlusWalBytes?: number;
  readonly dbCount?: number;
  readonly maxWalBytes?: number;
  readonly walTotalBytes?: number;
  readonly hudCacheBytes?: number;
}

export interface CliStorageInspectOptions {
  readonly sqliteOk?: boolean;
  readonly maxEntriesPerDir?: number;
  readonly maxWallMs?: number;
  readonly nowMs?: () => number;
  readonly thresholds?: CliStorageThresholds;
}

export interface ConversationsStorageStats {
  readonly dbCount: number;
  readonly dbBytes: number;
  readonly walCount: number;
  readonly walBytes: number;
  readonly maxWalBytes: number;
  readonly oversizedWalCount: number;
  readonly mainDbCount: number | null;
  readonly subagentDbCount: number | null;
}

export interface HudCacheStorageStats {
  readonly hudCacheCount: number;
  readonly hudCacheBytes: number;
  readonly staleOrphanCount: number;
}

export interface CliStorageHealthReport {
  readonly conversations: ConversationsStorageStats;
  readonly cache: HudCacheStorageStats;
  readonly truncated: boolean;
  readonly notes: readonly string[];
}

function scanDirectoryBounded(
  dirPath: string,
  maxEntries: number,
  startedAt: number,
  maxWallMs: number,
  nowMs: () => number,
  onEntry: (name: string) => void,
): boolean {
  const dirStat = lstatIfPresentSync(dirPath);
  if (dirStat === null || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    return false;
  }
  let dirHandle: ReturnType<typeof opendirSync>;
  try {
    dirHandle = opendirSync(dirPath);
  } catch {
    return false;
  }

  let processed = 0;
  let dirTruncated = false;
  try {
    while (true) {
      if (processed >= maxEntries) {
        if (dirHandle.readSync() !== null) {
          dirTruncated = true;
        }
        break;
      }
      if (processed > 0 && processed % BUDGET_CHECK_STRIDE === 0 && nowMs() - startedAt >= maxWallMs) {
        dirTruncated = true;
        break;
      }
      const dirent = dirHandle.readSync();
      if (dirent === null) break;
      processed += 1;
      onEntry(dirent.name);
    }
  } catch {
    // Ignore transient read errors on host-owned directories.
  } finally {
    try {
      dirHandle.closeSync();
    } catch {
      // Ignore close failure.
    }
  }
  return dirTruncated;
}

function readSummaryDbRoleSplit(
  cliHome: string,
  discoveredDbIds: ReadonlySet<string>,
  startedAt: number,
  maxWallMs: number,
  nowMs: () => number,
): { mainDbCount: number; subagentDbCount: number; truncated: boolean } | null {
  if (discoveredDbIds.size === 0) return null;
  const summaryPath = path.join(cliHome, 'conversation_summaries.db');
  const st = lstatIfPresentSync(summaryPath);
  if (st === null || st.isSymbolicLink() || !st.isFile()) {
    return null;
  }
  const deadlineMs = startedAt + maxWallMs;
  if (nowMs() >= deadlineMs) {
    return { mainDbCount: 0, subagentDbCount: 0, truncated: true };
  }
  const walSt = lstatIfPresentSync(`${summaryPath}-wal`);
  if (
    walSt !== null &&
    !walSt.isSymbolicLink() &&
    walSt.isFile() &&
    walSt.size > 0 &&
    st.size + walSt.size > MAX_SUMMARY_WAL_COPY_BYTES
  ) {
    return { mainDbCount: 0, subagentDbCount: 0, truncated: true };
  }
  const ids = [...discoveredDbIds];
  const result = withReadonlyDb(
    summaryPath,
    (db) => {
      let mainDbCount = 0;
      let subagentDbCount = 0;
      for (let offset = 0; offset < ids.length; offset += SUMMARY_IN_BATCH_SIZE) {
        if (nowMs() >= deadlineMs) {
          return { mainDbCount: 0, subagentDbCount: 0, truncated: true };
        }
        const batch = ids.slice(offset, offset + SUMMARY_IN_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id IN (${placeholders})`,
          )
          .all(...batch);
        for (const row of rows) {
          if (!isPlainObject(row) || typeof row.conversation_id !== 'string') continue;
          const safeId = sanitizeSessionId(row.conversation_id);
          if (safeId === null || !discoveredDbIds.has(safeId)) continue;
          const depth = typeof row.nesting_depth === 'number' ? row.nesting_depth : 0;
          if (depth > 0) subagentDbCount += 1;
          else mainDbCount += 1;
        }
        if (nowMs() >= deadlineMs) {
          return { mainDbCount: 0, subagentDbCount: 0, truncated: true };
        }
      }
      return { mainDbCount, subagentDbCount, truncated: false };
    },
    { deadlineMs, nowMs, maxCopyBytes: MAX_SUMMARY_WAL_COPY_BYTES },
  );
  if (result === null && nowMs() >= deadlineMs) {
    return { mainDbCount: 0, subagentDbCount: 0, truncated: true };
  }
  return result;
}

function formatMiB(bytes: number): string {
  const mib = bytes / BYTES_PER_MIB;
  if (mib === 0) return '0';
  if (mib < 0.1) return '<0.1';
  if (mib < 10) return mib.toFixed(1).replace(/\.0$/, '');
  return String(Math.round(mib));
}

export function inspectCliStorageHealth(
  cliHome: string,
  options: CliStorageInspectOptions = {},
): CliStorageHealthReport {
  const maxEntries = options.maxEntriesPerDir ?? MAX_DOCTOR_STORAGE_DIR_ENTRIES;
  const maxWallMs = options.maxWallMs ?? MAX_DOCTOR_STORAGE_SCAN_MS;
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();

  let dbCount = 0;
  let dbBytes = 0;
  let walCount = 0;
  let walBytes = 0;
  let maxWalBytes = 0;
  let oversizedWalCount = 0;
  const discoveredDbIds = new Set<string>();

  const convDir = path.join(cliHome, 'conversations');
  const convTruncated = scanDirectoryBounded(convDir, maxEntries, startedAt, maxWallMs, nowMs, (name) => {
    const isDb = name.endsWith('.db');
    const isWal = name.endsWith('.db-wal');
    if (!isDb && !isWal) return;
    const st = lstatIfPresentSync(path.join(convDir, name));
    if (st === null || st.isSymbolicLink() || !st.isFile()) return;
    if (isDb) {
      dbCount += 1;
      dbBytes += st.size;
      const safeId = sanitizeSessionId(name.slice(0, -3));
      if (safeId !== null) discoveredDbIds.add(safeId);
    } else {
      walCount += 1;
      walBytes += st.size;
      if (st.size > maxWalBytes) maxWalBytes = st.size;
      if (st.size >= OVERSIZED_WAL_BYTES) oversizedWalCount += 1;
    }
  });

  let hudCacheCount = 0;
  let hudCacheBytes = 0;
  let staleOrphanCount = 0;
  const cacheDir = path.join(cliHome, 'cache');
  let cacheTruncated = false;
  if (nowMs() - startedAt < maxWallMs) {
    cacheTruncated = scanDirectoryBounded(cacheDir, maxEntries, startedAt, maxWallMs, nowMs, (name) => {
      const isTmp = TRANSIENT_HUD_TMP_RE.test(name);
      const isOwned = isTmp || TRANSIENT_HUD_CACHE_RE.test(name) || HUD_CACHE_LOCK_RE.test(name);
      if (!isOwned) return;
      const st = lstatIfPresentSync(path.join(cacheDir, name));
      if (st === null || st.isSymbolicLink() || !st.isFile()) return;
      hudCacheCount += 1;
      hudCacheBytes += st.size;
      if (isTmp) staleOrphanCount += 1;
    });
  } else {
    cacheTruncated = true;
  }

  let mainDbCount: number | null = null;
  let subagentDbCount: number | null = null;
  let summaryTruncated = false;
  if (!convTruncated && options.sqliteOk !== false && dbCount > 0) {
    if (nowMs() - startedAt < maxWallMs) {
      try {
        const split = readSummaryDbRoleSplit(cliHome, discoveredDbIds, startedAt, maxWallMs, nowMs);
        if (split !== null) {
          if (split.truncated) {
            summaryTruncated = true;
          } else if (split.mainDbCount + split.subagentDbCount > 0) {
            mainDbCount = split.mainDbCount;
            subagentDbCount = split.subagentDbCount;
          }
        }
      } catch {
        // Optional summary DB attribution must never fail doctor.
      }
    } else {
      const summarySt = lstatIfPresentSync(path.join(cliHome, 'conversation_summaries.db'));
      if (summarySt !== null && !summarySt.isSymbolicLink() && summarySt.isFile()) {
        summaryTruncated = true;
      }
    }
  }

  const truncated = convTruncated || cacheTruncated || summaryTruncated;

  const limits: Required<CliStorageThresholds> = {
    dbPlusWalBytes: options.thresholds?.dbPlusWalBytes ?? DEFAULT_THRESHOLDS.dbPlusWalBytes,
    dbCount: options.thresholds?.dbCount ?? DEFAULT_THRESHOLDS.dbCount,
    maxWalBytes: options.thresholds?.maxWalBytes ?? DEFAULT_THRESHOLDS.maxWalBytes,
    walTotalBytes: options.thresholds?.walTotalBytes ?? DEFAULT_THRESHOLDS.walTotalBytes,
    hudCacheBytes: options.thresholds?.hudCacheBytes ?? DEFAULT_THRESHOLDS.hudCacheBytes,
  };

  const notes: string[] = [];
  const hostDbBloated = dbBytes + walBytes >= limits.dbPlusWalBytes || dbCount >= limits.dbCount;
  const hostWalBloated = maxWalBytes >= limits.maxWalBytes || walBytes >= limits.walTotalBytes;
  if (hostDbBloated || hostWalBloated) {
    notes.push(
      'conversations/ is host-owned: prune old sessions via Antigravity CLI `/conversations` and close idle `agy` processes so SQLite checkpoints large `-wal` files cleanly.',
    );
  }
  if (hudCacheBytes >= limits.hudCacheBytes) {
    notes.push(
      'HUD transient cache is large: expired files auto-sweep after 7d (1h for .tmp), or run `agy-hud unwire && agy-hud wire` to clear transient caches while keeping `hud-config.json`.',
    );
  }

  return {
    conversations: {
      dbCount,
      dbBytes,
      walCount,
      walBytes,
      maxWalBytes,
      oversizedWalCount,
      mainDbCount,
      subagentDbCount,
    },
    cache: {
      hudCacheCount,
      hudCacheBytes,
      staleOrphanCount,
    },
    truncated,
    notes,
  };
}

export function formatCliStorageLine(report: CliStorageHealthReport): string {
  const conv = report.conversations;
  const totalConvBytes = conv.dbBytes + conv.walBytes;
  const splitPart =
    conv.mainDbCount !== null && conv.subagentDbCount !== null
      ? `: ${conv.mainDbCount} main, ${conv.subagentDbCount} subagents`
      : '';
  const walWord = conv.walCount === 1 ? 'WAL' : 'WALs';
  const walPart = conv.walCount > 0 ? `; ${conv.walCount} ${walWord} ${formatMiB(conv.walBytes)} MiB` : '';
  const dbWord = conv.dbCount === 1 ? 'DB' : 'DBs';
  const fileWord = report.cache.hudCacheCount === 1 ? 'file' : 'files';
  const partialPart = report.truncated ? ' (partial scan)' : '';
  return `conversations ${formatMiB(totalConvBytes)} MiB (${conv.dbCount} ${dbWord}${splitPart}${walPart}) · hud cache ${formatMiB(report.cache.hudCacheBytes)} MiB (${report.cache.hudCacheCount} ${fileWord})${partialPart}`;
}

export function formatCliStorageNote(report: CliStorageHealthReport): string | null {
  return report.notes.length > 0 ? report.notes.join(' ') : null;
}
