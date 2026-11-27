import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { readRegularJsonObjectSync, writeBoundedPrivateJsonCache } from '../fs-utils.ts';
import type { CliSettings, SessionTelemetry, StatusLineData, TailStepPhase } from '../types.ts';
import { MAX_ACTIVITY_CACHE_BYTES } from './activity-cache.ts';
import { fetchLatestCheckpoint, isCompactionCheckpoint, type CompactionCheckpoint } from './compaction.ts';
import { parseStepTimestampsProto } from './proto-steps.ts';
import {
  type ContextBreakdownCounts,
  type GenMetadataRow,
  MAX_PROTO_BLOB_BYTES,
  parseGenMetadataBlob,
  parseGenMetadataBlobWithTail,
  type TailGenExtras,
} from './proto.ts';
import { resolveCliSubdirFile, resolveConversationId, sanitizeSessionId } from './safe-path.ts';
import { readSqliteVersionTag, withReadonlyDb } from './sqlite-readonly.ts';
import {
  createEmptyStepTiming,
  isStepTimingCache,
  type StepTimingCache,
  updateStepTimingIncremental,
} from './step-timing.ts';
import { evaluateSessionTelemetry } from './telemetry-analysis.ts';

const TELEMETRY_CACHE_VERSION = 3;
const STEP_IN_BATCH_SIZE = 200;
const STEP_STATUS_CANCELED = 6;
const MAX_STEP_METADATA_TOTAL_BYTES = 16 * 1024 * 1024;

export interface LoadSessionTelemetryOptions {
  readonly settledHint?: boolean;
  readonly cacheOnly?: boolean;
  readonly tryConsumeDbOpen?: () => boolean;
}

interface DbLoadResult {
  rows: Record<string, GenMetadataRow>;
  tail: TailGenExtras | null;
  ckpt: CompactionCheckpoint | null;
  stepTiming: StepTimingCache;
  tailStepPhase: TailStepPhase | null;
}

function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  return 0;
}

function hydrateRowStepTimestamps(
  db: DatabaseSync,
  rows: Record<string, GenMetadataRow>,
  dirtyKeys: readonly string[],
): void {
  const stepToRowKeys = new Map<number, string[]>();
  for (const key of dirtyKeys) {
    const row = rows[key];
    if (!row || row.atSec !== undefined) continue;
    const stepTarget = row.minStepIdx ?? (row.stepIdx !== undefined && row.stepIdx >= 0 ? row.stepIdx + 1 : -1);
    if (stepTarget < 0) continue;
    const list = stepToRowKeys.get(stepTarget);
    if (list) list.push(key);
    else stepToRowKeys.set(stepTarget, [key]);
  }
  if (stepToRowKeys.size === 0) return;

  const stepIndices = [...stepToRowKeys.keys()];
  let totalMetaBytes = 0;
  try {
    for (let offset = 0; offset < stepIndices.length; offset += STEP_IN_BATCH_SIZE) {
      const batch = stepIndices.slice(offset, offset + STEP_IN_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const stmt = db.prepare(
        `SELECT idx, status, CASE WHEN typeof(metadata) = 'blob' AND length(metadata) <= ? THEN metadata ELSE NULL END AS metadata FROM steps WHERE idx IN (${placeholders})`,
      );
      const iter = stmt.iterate(MAX_PROTO_BLOB_BYTES, ...batch);
      for (const item of iter) {
        if (!isPlainObject(item)) continue;
        const idx = toNumber(item.idx);
        const status = toNumber(item.status);
        const targets = stepToRowKeys.get(idx) ?? [];
        if (status === STEP_STATUS_CANCELED) {
          for (const rowKey of targets) {
            const target = rows[rowKey];
            if (target) {
              target.canceled = true;
              delete target.errorCode;
            }
          }
        }
        const meta = item.metadata instanceof Uint8Array ? item.metadata : null;
        if (meta === null) continue;
        if (totalMetaBytes + meta.byteLength > MAX_STEP_METADATA_TOTAL_BYTES) continue;
        totalMetaBytes += meta.byteLength;
        const created = parseStepTimestampsProto(meta).createdAtSec;
        if (created === null) continue;
        const atSec = Math.round(created);
        for (const rowKey of targets) {
          const target = rows[rowKey];
          if (target) target.atSec = atSec;
        }
      }
    }
  } catch {
    // Steps table may be absent in minimal unit fixtures; leave atSec undefined cleanly.
  }
}

function fetchUpdatedRows(
  dbPath: string,
  cachedRows: Record<string, GenMetadataRow>,
  cachedTail: TailGenExtras | null,
  cachedStepTiming: StepTimingCache | null,
): DbLoadResult | null {
  return withReadonlyDb<DbLoadResult>(dbPath, (db) => {
    const ckpt = fetchLatestCheckpoint(db);
    const { stepTiming, tailStepPhase } = updateStepTimingIncremental(db, cachedStepTiming);
    const statsRow = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS max_idx FROM gen_metadata').get();
    const count = isPlainObject(statsRow) ? toNumber(statsRow.cnt) : 0;
    const maxIdx = isPlainObject(statsRow) ? toNumber(statsRow.max_idx) : -1;
    if (count === 0) {
      return { rows: {}, tail: null, ckpt, stepTiming, tailStepPhase };
    }

    let seed = cachedRows;
    if (count < Object.keys(cachedRows).length) {
      seed = {};
    }
    const keys = Object.keys(seed)
      .map((k) => Number.parseInt(k, 10))
      .filter((n) => Number.isFinite(n));
    const startIdx = keys.length > 0 ? Math.max(...keys) : 0;

    const updated: Record<string, GenMetadataRow> = { ...seed };
    let tail: TailGenExtras | null = cachedTail;
    const dirtyKeys: string[] = [];

    const rows = db
      .prepare(
        "SELECT idx, CASE WHEN typeof(data) = 'blob' AND length(data) <= ? THEN data ELSE NULL END AS data FROM gen_metadata WHERE idx >= ? ORDER BY idx",
      )
      .iterate(MAX_PROTO_BLOB_BYTES, startIdx);

    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      const idx = toNumber(row.idx);
      const key = String(idx);
      const blob = row.data instanceof Uint8Array ? row.data : null;
      if (idx === maxIdx) {
        const parsed = parseGenMetadataBlobWithTail(blob, true);
        if (parsed !== null) {
          updated[key] = parsed.row;
          tail = parsed.tail;
          dirtyKeys.push(key);
        } else {
          delete updated[key];
          tail = null;
        }
      } else {
        const parsed = parseGenMetadataBlob(blob);
        if (parsed !== null) {
          updated[key] = parsed;
          dirtyKeys.push(key);
        } else {
          delete updated[key];
        }
      }
    }

    hydrateRowStepTimestamps(db, updated, dirtyKeys);
    return { rows: updated, tail, ckpt, stepTiming, tailStepPhase };
  });
}

interface CachedTelemetryLookup {
  hit: boolean;
  settled: boolean;
  rows: Record<string, GenMetadataRow>;
  tail: TailGenExtras | null;
  ckpt: CompactionCheckpoint | null;
  stepTiming: StepTimingCache | null;
  tailStepPhase: TailStepPhase | null;
}

function isBreakdownCounts(val: unknown): val is ContextBreakdownCounts {
  return (
    isPlainObject(val) &&
    isFiniteNum(val.system) &&
    isFiniteNum(val.rules) &&
    isFiniteNum(val.skills) &&
    isFiniteNum(val.tools) &&
    isFiniteNum(val.mcp) &&
    isFiniteNum(val.messages)
  );
}

function isTailGenExtras(val: unknown): val is TailGenExtras {
  return (
    isPlainObject(val) &&
    (val.breakdown === null || isBreakdownCounts(val.breakdown)) &&
    isFiniteNum(val.truncationReason) &&
    isFiniteNum(val.planModelEnum) &&
    isFiniteNum(val.execModelEnum)
  );
}

function isGenMetadataRow(value: unknown): value is GenMetadataRow {
  return (
    isPlainObject(value) &&
    isFiniteNum(value.in) &&
    isFiniteNum(value.out) &&
    isFiniteNum(value.cw) &&
    isFiniteNum(value.cr) &&
    isFiniteNum(value.ttft) &&
    isFiniteNum(value.stream) &&
    isFiniteNum(value.ctxUsed) &&
    isFiniteNum(value.ctxMax) &&
    (value.stepIdx === undefined || isFiniteNum(value.stepIdx)) &&
    (value.canceled === undefined || typeof value.canceled === 'boolean')
  );
}

function parseCachedRows(value: unknown): Record<string, GenMetadataRow> | null {
  if (!isPlainObject(value)) return null;
  const rows: Record<string, GenMetadataRow> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isGenMetadataRow(entry)) return null;
    rows[key] = entry;
  }
  return rows;
}

function parseTailStepPhase(val: unknown): TailStepPhase | null {
  return val === 'working' || val === 'tool_use' || val === 'error' ? val : null;
}

function readTelemetryCache(
  cacheFile: string,
  expectedVersionTag: string | null,
  acceptAnyValid: boolean = false,
): CachedTelemetryLookup {
  const empty: CachedTelemetryLookup = {
    hit: false,
    settled: false,
    rows: {},
    tail: null,
    ckpt: null,
    stepTiming: null,
    tailStepPhase: null,
  };
  const parsed = readRegularJsonObjectSync(cacheFile, MAX_ACTIVITY_CACHE_BYTES, { requirePrivateMode: true });
  if (parsed === null || parsed.v !== TELEMETRY_CACHE_VERSION) return empty;
  const versionTag = typeof parsed.versionTag === 'string' && parsed.versionTag.length > 0 ? parsed.versionTag : null;
  const rows = parseCachedRows(parsed.rows);
  if (versionTag === null || rows === null) return empty;
  const tail = isTailGenExtras(parsed.tail) ? parsed.tail : null;
  const ckpt = isCompactionCheckpoint(parsed.ckpt) ? parsed.ckpt : null;
  const stepTiming = isStepTimingCache(parsed.stepTiming) ? parsed.stepTiming : null;
  const tailStepPhase = parseTailStepPhase(parsed.tailStepPhase);
  const settled = parsed.settled === true;
  const hit = acceptAnyValid ? true : expectedVersionTag !== null ? versionTag === expectedVersionTag : settled;
  return { hit, settled, rows, tail, ckpt, stepTiming, tailStepPhase };
}

function loadDbRows(
  dataRoot: string,
  cacheCliHome: string,
  convId: string,
  settledHint: boolean = false,
  cacheOnly: boolean = false,
  tryConsumeDbOpen?: () => boolean,
): DbLoadResult {
  const empty: DbLoadResult = {
    rows: {},
    tail: null,
    ckpt: null,
    stepTiming: createEmptyStepTiming(),
    tailStepPhase: null,
  };
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) return empty;
  const cacheFile = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_telemetry_${safeId}.json`);
  if (cacheFile === null) return empty;

  if (cacheOnly) {
    const cachedOnly = readTelemetryCache(cacheFile, null, true);
    if (!cachedOnly.hit) return empty;
    return {
      rows: cachedOnly.rows,
      tail: cachedOnly.tail,
      ckpt: cachedOnly.ckpt,
      stepTiming: cachedOnly.stepTiming ?? createEmptyStepTiming(),
      tailStepPhase: cachedOnly.tailStepPhase,
    };
  }

  if (settledHint) {
    const settledCached = readTelemetryCache(cacheFile, null);
    if (settledCached.settled) {
      return {
        rows: settledCached.rows,
        tail: settledCached.tail,
        ckpt: settledCached.ckpt,
        stepTiming: settledCached.stepTiming ?? createEmptyStepTiming(),
        tailStepPhase: settledCached.tailStepPhase,
      };
    }
  }

  const dbPath = resolveCliSubdirFile(dataRoot, 'conversations', `${safeId}.db`);
  if (dbPath === null || !existsSync(dbPath)) return empty;
  const versionTag = readSqliteVersionTag(dbPath);
  if (versionTag.length === 0) return empty;

  const cached = readTelemetryCache(cacheFile, versionTag);
  if (cached.hit) {
    if (settledHint && !cached.settled) {
      writeBoundedPrivateJsonCache(
        cacheFile,
        {
          v: TELEMETRY_CACHE_VERSION,
          versionTag,
          rows: cached.rows,
          tail: cached.tail,
          ckpt: cached.ckpt,
          stepTiming: cached.stepTiming ?? createEmptyStepTiming(),
          tailStepPhase: cached.tailStepPhase,
          settled: true,
        },
        MAX_ACTIVITY_CACHE_BYTES,
      );
    }
    return {
      rows: cached.rows,
      tail: cached.tail,
      ckpt: cached.ckpt,
      stepTiming: cached.stepTiming ?? createEmptyStepTiming(),
      tailStepPhase: cached.tailStepPhase,
    };
  }

  if (tryConsumeDbOpen !== undefined && !tryConsumeDbOpen()) {
    return {
      rows: cached.rows,
      tail: cached.tail,
      ckpt: cached.ckpt,
      stepTiming: cached.stepTiming ?? createEmptyStepTiming(),
      tailStepPhase: cached.tailStepPhase,
    };
  }

  let loaded: DbLoadResult | null;
  try {
    loaded = fetchUpdatedRows(dbPath, cached.rows, cached.tail, cached.stepTiming);
  } catch {
    return {
      rows: cached.rows,
      tail: cached.tail,
      ckpt: cached.ckpt,
      stepTiming: cached.stepTiming ?? createEmptyStepTiming(),
      tailStepPhase: cached.tailStepPhase,
    };
  }
  if (loaded === null) {
    return {
      rows: cached.rows,
      tail: cached.tail,
      ckpt: cached.ckpt,
      stepTiming: cached.stepTiming ?? createEmptyStepTiming(),
      tailStepPhase: cached.tailStepPhase,
    };
  }

  if (readSqliteVersionTag(dbPath) === versionTag) {
    writeBoundedPrivateJsonCache(
      cacheFile,
      {
        v: TELEMETRY_CACHE_VERSION,
        versionTag,
        rows: loaded.rows,
        tail: loaded.tail,
        ckpt: loaded.ckpt,
        stepTiming: loaded.stepTiming,
        tailStepPhase: loaded.tailStepPhase,
        ...(settledHint ? { settled: true } : {}),
      },
      MAX_ACTIVITY_CACHE_BYTES,
    );
  }
  return loaded;
}

export function loadSessionTelemetryFromRoot(
  dataRoot: string,
  cacheCliHome: string,
  convId: string | null,
  data: StatusLineData = {},
  cliSettings?: CliSettings,
  options?: LoadSessionTelemetryOptions,
): SessionTelemetry {
  const loaded =
    convId !== null
      ? loadDbRows(
          dataRoot,
          cacheCliHome,
          convId,
          options?.settledHint === true,
          options?.cacheOnly === true,
          options?.tryConsumeDbOpen,
        )
      : { rows: {}, tail: null, ckpt: null, stepTiming: createEmptyStepTiming(), tailStepPhase: null };

  const ordered = Object.keys(loaded.rows)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((k) => loaded.rows[k])
    .filter((r): r is GenMetadataRow => r !== undefined);

  return evaluateSessionTelemetry({
    rows: ordered,
    tail: loaded.tail,
    ckpt: loaded.ckpt,
    data,
    cliSettings,
    stepTiming: loaded.stepTiming,
    tailStepPhase: loaded.tailStepPhase,
  });
}

export function loadSessionTelemetry(
  cliHome: string,
  data: StatusLineData,
  cliSettings?: CliSettings,
): SessionTelemetry {
  return loadSessionTelemetryFromRoot(cliHome, cliHome, resolveConversationId(data), data, cliSettings);
}
