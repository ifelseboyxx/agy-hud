import type { DatabaseSync } from 'node:sqlite';

import { isPlainObject } from '../core/guards.ts';
import type { GenMetadataRow } from '../types.ts';

export { parseKvStepIdx } from './proto.ts';

const STEP_TYPE_CHECKPOINT = 23;
const STEP_TYPE_PLANNER = 15;
const STEP_STATUS_DONE = 3;

export interface CompactionCheckpoint {
  idx: number;
  payloadLen: number;
  hasPostPlanner: boolean;
}

function toInt(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return Math.trunc(val);
  }
  if (typeof val === 'bigint') {
    return Number(val);
  }
  return 0;
}

export function isCompactionCheckpoint(val: unknown): val is CompactionCheckpoint {
  return (
    isPlainObject(val) &&
    typeof val.idx === 'number' &&
    typeof val.payloadLen === 'number' &&
    typeof val.hasPostPlanner === 'boolean'
  );
}

export function fetchLatestCheckpoint(db: DatabaseSync): CompactionCheckpoint | null {
  try {
    const ckptRow = db
      .prepare(
        `SELECT idx, LENGTH(step_payload) AS plen FROM steps WHERE step_type = ${STEP_TYPE_CHECKPOINT} AND status = ${STEP_STATUS_DONE} ORDER BY idx DESC LIMIT 1`,
      )
      .get();
    if (!isPlainObject(ckptRow)) {
      return null;
    }
    const ckptIdx = toInt(ckptRow.idx);
    const payloadLen = Math.max(0, toInt(ckptRow.plen));
    const postRow = db
      .prepare(
        `SELECT 1 AS ok FROM steps WHERE idx > ? AND step_type = ${STEP_TYPE_PLANNER} AND status = ${STEP_STATUS_DONE} LIMIT 1`,
      )
      .get(ckptIdx);
    return {
      idx: ckptIdx,
      payloadLen,
      hasPostPlanner: postRow !== undefined && postRow !== null,
    };
  } catch {
    return null;
  }
}

export function isCompactionActive(validRows: readonly GenMetadataRow[], ckpt: CompactionCheckpoint | null): boolean {
  if (ckpt === null) {
    return false;
  }
  const lastRow = validRows[validRows.length - 1];
  const lastStepIdx = lastRow?.stepIdx ?? -1;
  if (lastRow && lastStepIdx >= 0) {
    return ckpt.idx > lastStepIdx;
  }
  return !ckpt.hasPostPlanner;
}

export function computeCompactedUsed(validRows: readonly GenMetadataRow[], ckpt: CompactionCheckpoint): number {
  const lastRow = validRows[validRows.length - 1];
  const preIn = lastRow ? lastRow.in + lastRow.cw + lastRow.cr : 0;
  const preHist = lastRow ? lastRow.ctxUsed : 0;
  const overhead = preIn > preHist && preHist > 0 ? preIn - preHist : 0;
  return overhead + Math.max(1, Math.floor(ckpt.payloadLen / 4));
}
