import type { DatabaseSync } from 'node:sqlite';

import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { parseCheckpointPayloadProto } from './proto-steps.ts';
import { type ContextBreakdownCounts, type GenMetadataRow, MAX_PROTO_BLOB_BYTES } from './proto-wire.ts';

const STEP_TYPE_CHECKPOINT = 23;
const STEP_TYPE_PLANNER = 15;
const STEP_STATUS_DONE = 3;
const CJK_CHAR_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

export interface CompactionCheckpoint {
  idx: number;
  compactionCount: number;
  msgTokensEstimate: number;
  hasPostPlanner: boolean;
  completedIndices?: number[];
}

function toInt(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  if (typeof val === 'bigint') return Number(val);
  return 0;
}

export function estimateCjkAwareTokens(texts: readonly string[]): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const text of texts) {
    for (const ch of text) {
      if (CJK_CHAR_RE.test(ch)) cjkChars += 1;
      else otherChars += 1;
    }
  }
  if (cjkChars === 0 && otherChars === 0) return 0;
  return Math.max(1, Math.ceil(cjkChars * 1.15 + otherChars / 3.8));
}

export function isCompactionCheckpoint(val: unknown): val is CompactionCheckpoint {
  if (!isPlainObject(val)) return false;
  if (!isFiniteNum(val.idx) || !isFiniteNum(val.compactionCount) || !isFiniteNum(val.msgTokensEstimate)) return false;
  if (typeof val.hasPostPlanner !== 'boolean') return false;
  if (val.completedIndices !== undefined) {
    if (!Array.isArray(val.completedIndices) || !val.completedIndices.every((n) => isFiniteNum(n))) return false;
  }
  return true;
}

export function fetchLatestCheckpoint(db: DatabaseSync): CompactionCheckpoint | null {
  try {
    const allRows = db
      .prepare(
        `SELECT idx FROM steps WHERE step_type = ${STEP_TYPE_CHECKPOINT} AND status = ${STEP_STATUS_DONE} ORDER BY idx ASC`,
      )
      .all();
    const completedIndices: number[] = [];
    for (const r of allRows) {
      if (isPlainObject(r)) completedIndices.push(toInt(r.idx));
    }
    if (completedIndices.length === 0) {
      return null;
    }

    const latestIdx = completedIndices[completedIndices.length - 1] ?? 0;
    const payloadRow = db
      .prepare(
        `SELECT LENGTH(step_payload) AS plen, CASE WHEN typeof(step_payload) = 'blob' AND LENGTH(step_payload) <= ? THEN step_payload ELSE NULL END AS payload FROM steps WHERE idx = ? LIMIT 1`,
      )
      .get(MAX_PROTO_BLOB_BYTES, latestIdx);

    const payloadLen = isPlainObject(payloadRow) ? Math.max(0, toInt(payloadRow.plen)) : 0;
    const blob = isPlainObject(payloadRow) && payloadRow.payload instanceof Uint8Array ? payloadRow.payload : null;
    const decodedTexts = parseCheckpointPayloadProto(blob);
    const msgTokensEstimate =
      decodedTexts.length > 0 ? estimateCjkAwareTokens(decodedTexts) : Math.max(1, Math.floor(payloadLen / 4));

    const postRow = db
      .prepare(
        `SELECT 1 AS ok FROM steps WHERE idx > ? AND step_type = ${STEP_TYPE_PLANNER} AND status = ${STEP_STATUS_DONE} LIMIT 1`,
      )
      .get(latestIdx);

    return {
      idx: latestIdx,
      compactionCount: completedIndices.length,
      msgTokensEstimate,
      hasPostPlanner: postRow !== undefined && postRow !== null,
      completedIndices,
    };
  } catch {
    return null;
  }
}

export function isCompactionActive(validRows: readonly GenMetadataRow[], ckpt: CompactionCheckpoint | null): boolean {
  if (ckpt === null) return false;
  const lastRow = validRows[validRows.length - 1];
  const lastStepIdx = lastRow?.stepIdx ?? -1;
  if (lastRow && lastStepIdx >= 0) {
    return ckpt.idx > lastStepIdx;
  }
  return !ckpt.hasPostPlanner;
}

export function computeCompactedUsed(
  validRows: readonly GenMetadataRow[],
  ckpt: CompactionCheckpoint,
  tailBreakdown: ContextBreakdownCounts | null = null,
): number {
  let fixedOverhead = 0;
  if (tailBreakdown !== null) {
    fixedOverhead =
      tailBreakdown.system + tailBreakdown.rules + tailBreakdown.skills + tailBreakdown.tools + tailBreakdown.mcp;
  } else {
    const lastRow = validRows[validRows.length - 1];
    const preIn = lastRow ? lastRow.in + lastRow.cw + lastRow.cr : 0;
    const preHist = lastRow ? lastRow.ctxUsed : 0;
    fixedOverhead = preIn > preHist && preHist > 0 ? preIn - preHist : 0;
  }
  return fixedOverhead + Math.max(1, ckpt.msgTokensEstimate);
}
