/* @host-contract
 * Read-only `conversation_summaries.db` scanner with WAL version-tag in-memory caching (docs/host-contracts.md §2):
 * - Caches parsed summary rows per `(dbPath, readSqliteVersionTag)` so 2s idle MCP polls avoid `/tmp` WAL file copies.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import { sanitizeSessionId } from './safe-path.ts';
import { readSqliteVersionTag, withReadonlyDb } from './sqlite-readonly.ts';

const SUMMARY_QUERY_LIMIT = 100;
const MAX_SUMMARY_DB_CACHE_ENTRIES = 8;

export interface CachedSummaryRow {
  readonly safeId: string;
  readonly source: string;
  readonly title: string;
  readonly summaryMs: number;
  readonly isRunning: boolean;
  readonly workspaces: readonly string[];
}

export interface SummaryDbSnapshot {
  readonly versionTag: string;
  readonly excludedIds: readonly string[];
  readonly rows: readonly CachedSummaryRow[];
}

const summaryDbCache = new Map<string, SummaryDbSnapshot>();

function parseWorkspaceUris(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const results: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string' || item.trim().length === 0) continue;
      if (item.startsWith('file://')) {
        try {
          results.push(fileURLToPath(item));
        } catch {
          // Ignore malformed file:// URI.
        }
      } else {
        results.push(item);
      }
    }
    return results;
  } catch {
    return [];
  }
}

function parseSummaryTimestampMs(raw: unknown): number {
  if (isFiniteNum(raw) && raw > 0) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

export function loadSummaryDbSnapshot(rootDir: string): SummaryDbSnapshot | null {
  const dbPath = path.join(rootDir, 'conversation_summaries.db');
  if (!existsSync(dbPath)) return null;

  const versionTag = readSqliteVersionTag(dbPath);
  if (versionTag.length > 0) {
    const hit = summaryDbCache.get(dbPath);
    if (hit?.versionTag === versionTag) return hit;
  }

  const loaded = withReadonlyDb(dbPath, (db): SummaryDbSnapshot => {
    const excluded: string[] = [];
    const excludedRows = db
      .prepare('SELECT conversation_id FROM conversation_summaries WHERE nesting_depth != 0 OR killed != 0')
      .all();
    for (const row of excludedRows) {
      if (!isPlainObject(row) || typeof row.conversation_id !== 'string') continue;
      const safe = sanitizeSessionId(row.conversation_id);
      if (safe !== null) excluded.push(safe);
    }

    const parsedRows: CachedSummaryRow[] = [];
    const rows = db
      .prepare(
        `SELECT conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status
         FROM conversation_summaries
         WHERE nesting_depth = 0 AND killed = 0
         ORDER BY last_modified_time DESC
         LIMIT ${SUMMARY_QUERY_LIMIT}`,
      )
      .all();
    for (const row of rows) {
      if (!isPlainObject(row) || typeof row.conversation_id !== 'string') continue;
      const safeId = sanitizeSessionId(row.conversation_id);
      if (safeId === null) continue;
      parsedRows.push({
        safeId,
        source: typeof row.source === 'string' ? row.source : '',
        title: typeof row.title === 'string' ? sanitizeTerminalLabel(row.title) : '',
        summaryMs: parseSummaryTimestampMs(row.last_modified_time),
        isRunning: row.not_fully_idle === 1 || row.status === 'CASCADE_RUN_STATUS_RUNNING',
        workspaces: parseWorkspaceUris(row.workspace_uris),
      });
    }
    return { versionTag, excludedIds: excluded, rows: parsedRows };
  });

  if (loaded !== null && versionTag.length > 0) {
    if (!summaryDbCache.has(dbPath) && summaryDbCache.size >= MAX_SUMMARY_DB_CACHE_ENTRIES) {
      const oldestKey = summaryDbCache.keys().next().value;
      if (oldestKey !== undefined) summaryDbCache.delete(oldestKey);
    }
    summaryDbCache.set(dbPath, loaded);
  }
  return loaded;
}
