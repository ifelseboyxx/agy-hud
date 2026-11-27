import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { readRegularJsonObjectSync } from '../fs-utils.ts';
import type { ModelErrorReason, TailStepPhase } from '../types.ts';
import { MAX_ACTIVITY_CACHE_BYTES } from './activity-cache.ts';
import { parseStepTimestampsProto } from './proto-steps.ts';
import { MAX_PROTO_BLOB_BYTES } from './proto-wire.ts';
import { parseGenMetadataBlob } from './proto.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';
import { readSqliteVersionTag, withReadonlyDb } from './sqlite-readonly.ts';

const STEP_TYPE_PLANNER = 15;
const STEP_TYPE_CHECKPOINT = 23;
const STEP_TYPE_GENERIC = 132;
const STEP_STATUS_RUNNING = 2;
const STEP_STATUS_CANCELED = 6;
const STEP_STATUS_GENERATING = 8;
const TERMINAL_STEP_STATUSES: ReadonlySet<number> = new Set([3, 4, 6, 7]);
const MAX_SINGLE_INTERVAL_SEC = 86_400;
const PHASE_PROBE_DEADLINE_MS = 50;
const TELEMETRY_CACHE_VERSION = 3;

export type TimeInterval = readonly [number, number];

export interface StepTimingCache {
  readonly cursorIdx: number;
  readonly modelSec: number;
  readonly toolSec: number;
  readonly trailingModelInterval: TimeInterval | null;
  readonly trailingToolInterval: TimeInterval | null;
}

export interface StepTimingUpdateResult {
  readonly stepTiming: StepTimingCache;
  readonly tailStepPhase: TailStepPhase | null;
}

function toIntVal(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  if (typeof val === 'bigint') return Number(val);
  return 0;
}

function isValidInterval(val: unknown): val is TimeInterval {
  return Array.isArray(val) && val.length === 2 && isFiniteNum(val[0]) && isFiniteNum(val[1]) && val[1] >= val[0];
}

export function createEmptyStepTiming(): StepTimingCache {
  return {
    cursorIdx: -1,
    modelSec: 0,
    toolSec: 0,
    trailingModelInterval: null,
    trailingToolInterval: null,
  };
}

export function isStepTimingCache(val: unknown): val is StepTimingCache {
  if (!isPlainObject(val)) return false;
  if (!isFiniteNum(val.cursorIdx) || !isFiniteNum(val.modelSec) || !isFiniteNum(val.toolSec)) return false;
  if (val.trailingModelInterval !== null && !isValidInterval(val.trailingModelInterval)) return false;
  if (val.trailingToolInterval !== null && !isValidInterval(val.trailingToolInterval)) return false;
  return true;
}

function mergeIntervalBucket(
  baseSec: number,
  trailing: TimeInterval | null,
  intervals: readonly TimeInterval[],
): { totalSec: number; trailing: TimeInterval | null } {
  if (intervals.length === 0) return { totalSec: baseSec, trailing };
  const sorted = [...intervals].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  let totalSec = baseSec;
  let cur = trailing;

  for (const [start, end] of sorted) {
    if (end <= start || end - start > MAX_SINGLE_INTERVAL_SEC) continue;
    if (cur === null) {
      totalSec += end - start;
      cur = [start, end];
      continue;
    }
    if (start > cur[1]) {
      totalSec += end - start;
      cur = [start, end];
      continue;
    }
    if (start < cur[0]) {
      totalSec += Math.min(end, cur[0]) - start;
    }
    if (end > cur[1]) {
      totalSec += end - cur[1];
    }
    cur = [Math.min(cur[0], start), Math.max(cur[1], end)];
  }
  return { totalSec, trailing: cur };
}

function scanStepTimingPass(
  db: DatabaseSync,
  seed: StepTimingCache,
  allowFullRecompute: boolean,
): StepTimingUpdateResult {
  const rows = db
    .prepare(
      "SELECT idx, step_type, status, CASE WHEN typeof(metadata) = 'blob' AND length(metadata) <= ? THEN metadata ELSE NULL END AS metadata FROM steps WHERE idx > ? ORDER BY idx ASC",
    )
    .iterate(MAX_PROTO_BLOB_BYTES, seed.cursorIdx);

  let cursorIdx = seed.cursorIdx;
  let contiguousTerminal = true;
  let tailStepPhase: TailStepPhase | null = null;
  const newModelIntervals: TimeInterval[] = [];
  const newToolIntervals: TimeInterval[] = [];

  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const idx = toIntVal(row.idx);
    const stepType = toIntVal(row.step_type);
    const status = toIntVal(row.status);

    if (contiguousTerminal && TERMINAL_STEP_STATUSES.has(status)) {
      cursorIdx = idx;
      const meta = row.metadata instanceof Uint8Array ? row.metadata : null;
      if (
        meta !== null &&
        (stepType === STEP_TYPE_PLANNER || stepType === STEP_TYPE_CHECKPOINT || stepType === STEP_TYPE_GENERIC)
      ) {
        const ts = parseStepTimestampsProto(meta);
        if (stepType === STEP_TYPE_PLANNER && ts.createdAtSec !== null && ts.finishedAtSec !== null) {
          newModelIntervals.push([ts.createdAtSec, ts.finishedAtSec]);
        } else if (stepType === STEP_TYPE_CHECKPOINT && ts.startedAtSec !== null && ts.completedAtSec !== null) {
          newModelIntervals.push([ts.startedAtSec, ts.completedAtSec]);
        } else if (stepType === STEP_TYPE_GENERIC && ts.startedAtSec !== null && ts.completedAtSec !== null) {
          newToolIntervals.push([ts.startedAtSec, ts.completedAtSec]);
        }
      }
      continue;
    }

    contiguousTerminal = false;
    if (status === STEP_STATUS_GENERATING) {
      tailStepPhase = 'working';
    } else if (stepType === STEP_TYPE_GENERIC && status === STEP_STATUS_RUNNING) {
      tailStepPhase = 'tool_use';
    }
  }

  // If any newly arrived step starts before the trailing merged interval, recompute from scratch so
  // out-of-order timestamps never double-count across earlier merged buckets.
  if (allowFullRecompute && seed.cursorIdx >= 0) {
    const modelOutOfOrder =
      seed.trailingModelInterval !== null &&
      newModelIntervals.some(([start, end]) => end > start && start < seed.trailingModelInterval![0]);
    const toolOutOfOrder =
      seed.trailingToolInterval !== null &&
      newToolIntervals.some(([start, end]) => end > start && start < seed.trailingToolInterval![0]);
    if (modelOutOfOrder || toolOutOfOrder) {
      return scanStepTimingPass(db, createEmptyStepTiming(), false);
    }
  }

  const mergedModel = mergeIntervalBucket(seed.modelSec, seed.trailingModelInterval, newModelIntervals);
  const mergedTool = mergeIntervalBucket(seed.toolSec, seed.trailingToolInterval, newToolIntervals);

  return {
    stepTiming: {
      cursorIdx,
      modelSec: mergedModel.totalSec,
      toolSec: mergedTool.totalSec,
      trailingModelInterval: mergedModel.trailing,
      trailingToolInterval: mergedTool.trailing,
    },
    tailStepPhase,
  };
}

export function updateStepTimingIncremental(db: DatabaseSync, prev: StepTimingCache | null): StepTimingUpdateResult {
  const seed = prev ?? createEmptyStepTiming();
  try {
    return scanStepTimingPass(db, seed, true);
  } catch {
    return { stepTiming: seed, tailStepPhase: null };
  }
}

function readCachedTailPhase(
  cacheFile: string,
  versionTag: string,
): { readonly tailStepPhase: TailStepPhase | null; readonly lastErrorCode: ModelErrorReason | null } | null {
  const parsed = readRegularJsonObjectSync(cacheFile, MAX_ACTIVITY_CACHE_BYTES, { requirePrivateMode: true });
  if (parsed === null || parsed.v !== TELEMETRY_CACHE_VERSION || parsed.versionTag !== versionTag) return null;
  const rawPhase = parsed.tailStepPhase;
  const tailStepPhase: TailStepPhase | null =
    rawPhase === 'working' || rawPhase === 'tool_use' || rawPhase === 'error' ? rawPhase : null;
  let lastErrorCode: ModelErrorReason | null = null;
  if (isPlainObject(parsed.rows)) {
    const keys = Object.keys(parsed.rows).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    const last = keys.length > 0 ? parsed.rows[keys[keys.length - 1]!] : null;
    if (isPlainObject(last) && last.canceled !== true && typeof last.errorCode === 'string') {
      lastErrorCode = last.errorCode as ModelErrorReason;
    }
  }
  return { tailStepPhase, lastErrorCode };
}

export function readSessionTailPhaseFallback(
  dataRoot: string,
  cacheCliHome: string,
  convId: string,
): { readonly tailStepPhase: TailStepPhase | null; readonly lastErrorCode: ModelErrorReason | null } {
  const none = { tailStepPhase: null, lastErrorCode: null } as const;
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) return none;
  const dbPath = resolveCliSubdirFile(dataRoot, 'conversations', `${safeId}.db`);
  if (dbPath === null || !existsSync(dbPath)) return none;

  const versionTag = readSqliteVersionTag(dbPath);
  if (versionTag.length === 0) return none;
  const cacheFile = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_telemetry_${safeId}.json`);
  if (cacheFile !== null) {
    const cached = readCachedTailPhase(cacheFile, versionTag);
    if (cached !== null) return cached;
  }

  const probed = withReadonlyDb<{ tailStepPhase: TailStepPhase | null; lastErrorCode: ModelErrorReason | null }>(
    dbPath,
    (db) => {
      let tailStepPhase: TailStepPhase | null = null;
      try {
        const activeStep = db
          .prepare(
            `SELECT step_type, status FROM steps WHERE status = ${STEP_STATUS_GENERATING} OR (step_type = ${STEP_TYPE_GENERIC} AND status = ${STEP_STATUS_RUNNING}) ORDER BY idx DESC LIMIT 1`,
          )
          .get();
        if (isPlainObject(activeStep)) {
          const status = toIntVal(activeStep.status);
          const stepType = toIntVal(activeStep.step_type);
          if (status === STEP_STATUS_GENERATING) tailStepPhase = 'working';
          else if (stepType === STEP_TYPE_GENERIC && status === STEP_STATUS_RUNNING) tailStepPhase = 'tool_use';
        }
      } catch {
        // Steps table may be absent in minimal fixtures.
      }
      if (tailStepPhase !== null) return { tailStepPhase, lastErrorCode: null };

      let lastErrorCode: ModelErrorReason | null = null;
      try {
        const latestGen = db
          .prepare(
            "SELECT CASE WHEN typeof(data) = 'blob' AND length(data) <= ? THEN data ELSE NULL END AS data FROM gen_metadata ORDER BY idx DESC LIMIT 1",
          )
          .get(MAX_PROTO_BLOB_BYTES);
        if (isPlainObject(latestGen) && latestGen.data instanceof Uint8Array) {
          const parsed = parseGenMetadataBlob(latestGen.data);
          if (parsed !== null && parsed.canceled !== true && parsed.errorCode !== undefined) {
            const stepTarget =
              parsed.minStepIdx ?? (parsed.stepIdx !== undefined && parsed.stepIdx >= 0 ? parsed.stepIdx + 1 : -1);
            let stepCanceled = false;
            if (stepTarget >= 0) {
              try {
                const stRow = db.prepare('SELECT status FROM steps WHERE idx = ?').get(stepTarget);
                if (isPlainObject(stRow) && toIntVal(stRow.status) === STEP_STATUS_CANCELED) stepCanceled = true;
              } catch {
                // Ignore absent steps table.
              }
            }
            if (!stepCanceled) lastErrorCode = parsed.errorCode;
          }
        }
      } catch {
        // Ignore absent gen_metadata table.
      }
      return { tailStepPhase, lastErrorCode };
    },
    { deadlineMs: Date.now() + PHASE_PROBE_DEADLINE_MS },
  );
  return probed ?? none;
}
