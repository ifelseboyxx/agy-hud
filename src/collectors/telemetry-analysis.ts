import { isFiniteNum } from '../core/guards.ts';
import type {
  CacheAnomalyEvent,
  CliSettings,
  ModelErrorReason,
  SessionTelemetry,
  StatusLineContextWindow,
  StatusLineData,
  TailStepPhase,
} from '../types.ts';
import { computeCompactedUsed, isCompactionActive, type CompactionCheckpoint } from './compaction.ts';
import type { GenMetadataRow, TailGenExtras } from './proto.ts';
import { evaluateContextAndRoles } from './telemetry-context.ts';

const MIN_STREAM_WINDOW_SEC = 0.5;
const MAX_BURST_STREAM_TPS = 400.0;
const TAIL_FLUSH_MAX_STREAM_SEC = 1.5;
const TAIL_FLUSH_MAX_RATIO = 0.06;
const TAIL_FLUSH_MIN_OUT_TOKENS = 500;
const SUSTAINED_MIN_STREAM_SEC = 3.0;
const SUSTAINED_MIN_OUT_TOKENS = 100;

const CACHE_ANOMALY_MAX_GAP_SEC = 180;
const CACHE_ANOMALY_MIN_IN_TOKENS = 4_000;
const CACHE_ANOMALY_MIN_KEEP_RATIO = 0.6;
const CACHE_CLEARED_MIN_PREV_PCT = 50;
const CACHE_DROPPED_MIN_DELTA_PCT = 40;
const CACHE_DROPPED_MAX_CUR_PCT = 20;
const CACHE_MISSED_MIN_PREV_IN = 16_000;

export interface TelemetryEvaluationInput {
  readonly rows: readonly GenMetadataRow[];
  readonly tail: TailGenExtras | null;
  readonly ckpt: CompactionCheckpoint | null;
  readonly data: StatusLineData;
  readonly cliSettings?: CliSettings;
  readonly stepTiming?: { readonly modelSec: number; readonly toolSec: number } | null;
  readonly tailStepPhase?: TailStepPhase | null;
}

function hasStepMetrics(row: GenMetadataRow): boolean {
  return row.out > 0 || row.ttft > 0 || row.in + row.cr + row.cw > 0;
}

function isBufferedRate(outTok: number, ttftSec: number, streamSec: number): boolean {
  const totalSec = ttftSec + streamSec;
  if (streamSec <= 0 || totalSec <= 0) return true;
  const rawTps = outTok / streamSec;
  const isBurst = ttftSec > streamSec && (streamSec < MIN_STREAM_WINDOW_SEC || rawTps > MAX_BURST_STREAM_TPS);
  const isTailFlush =
    streamSec < TAIL_FLUSH_MAX_STREAM_SEC &&
    streamSec / totalSec < TAIL_FLUSH_MAX_RATIO &&
    outTok >= TAIL_FLUSH_MIN_OUT_TOKENS;
  return isBurst || isTailFlush;
}

export function computeEffectiveTps(
  outTok: number,
  ttftSec: number,
  streamSec: number,
  quarantinedRate: boolean = false,
): number | null {
  if (outTok <= 0) return null;
  const totalSec = ttftSec + streamSec;
  if (quarantinedRate || streamSec <= 0) return totalSec > 0 ? outTok / totalSec : null;
  if (isBufferedRate(outTok, ttftSec, streamSec)) return totalSec > 0 ? outTok / totalSec : null;
  return outTok / streamSec;
}

function fallbackStdinCachePct(ctxObj: StatusLineContextWindow | undefined): number | null {
  const cur = ctxObj?.current_usage;
  if (!cur) return null;
  const inTok = isFiniteNum(cur.input_tokens) ? cur.input_tokens : 0;
  const cwTok = isFiniteNum(cur.cache_creation_input_tokens) ? cur.cache_creation_input_tokens : 0;
  const crTok = isFiniteNum(cur.cache_read_input_tokens) ? cur.cache_read_input_tokens : 0;
  const total = inTok + cwTok + crTok;
  return total > 0 ? (crTok / total) * 100 : null;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

function computeSustainedThroughput(valid: readonly GenMetadataRow[]): {
  avgTps: number | null;
  peakTps: number | null;
} {
  let eligibleCount = 0;
  let totalOut = 0;
  let totalDur = 0;
  const sustained: Array<{ rawTps: number; wholeTurnTps: number }> = [];

  for (const row of valid) {
    if (row.canceled === true || row.quarantinedRate === true || row.out <= 0) continue;
    const totalSec = row.ttft + row.stream;
    const buffered = isBufferedRate(row.out, row.ttft, row.stream);
    const effDur = buffered ? totalSec : row.stream;
    if (effDur <= 0) continue;
    eligibleCount += 1;
    totalOut += row.out;
    totalDur += effDur;

    if (!buffered && row.stream >= SUSTAINED_MIN_STREAM_SEC && row.out >= SUSTAINED_MIN_OUT_TOKENS) {
      sustained.push({
        rawTps: row.out / row.stream,
        wholeTurnTps: totalSec > 0 ? row.out / totalSec : 0,
      });
    }
  }

  if (eligibleCount < 2 || totalDur <= 0) return { avgTps: null, peakTps: null };
  const avgTps = totalOut / totalDur;
  let filtered = sustained;
  if (sustained.length >= 4) {
    const sortedRates = sustained.map((s) => s.rawTps).sort((a, b) => a - b);
    const q1 = quantile(sortedRates, 0.25);
    const q3 = quantile(sortedRates, 0.75);
    const fence = Math.max(q3 + 1.5 * (q3 - q1), q3 * 1.25);
    filtered = sustained.filter((s) => !(s.rawTps > fence && s.wholeTurnTps < 0.5 * s.rawTps));
  }
  const peakTps = filtered.length > 0 ? Math.max(...filtered.map((s) => s.rawTps)) : null;
  return { avgTps, peakTps };
}

interface ModelCacheState {
  prevTotalIn: number;
  prevCr: number;
  prevHitPct: number;
  prevStep: number | null;
  prevAtSec: number | null;
  everCached: boolean;
}

function detectCacheAnomalies(
  valid: readonly GenMetadataRow[],
  completedCheckpoints: readonly number[],
): { latestCacheAnomaly: CacheAnomalyEvent | null; cacheAnomalyCount: number } {
  const byModel = new Map<string, ModelCacheState>();
  let latestCacheAnomaly: CacheAnomalyEvent | null = null;
  let cacheAnomalyCount = 0;

  for (let i = 0; i < valid.length; i += 1) {
    const row = valid[i];
    if (!row) continue;
    const isLatest = i === valid.length - 1;
    const totalIn = row.in + row.cw + row.cr;
    if (row.canceled === true || row.errorCode !== undefined || totalIn <= 0) {
      if (isLatest) latestCacheAnomaly = null;
      continue;
    }
    const modelKey = row.modelKey ?? (row.modelEnum !== undefined ? String(row.modelEnum) : 'default');
    const curHitPct = (row.cr / totalIn) * 100;
    const curStep = row.minStepIdx ?? (row.stepIdx !== undefined && row.stepIdx >= 0 ? row.stepIdx + 1 : null);
    const curAtSec = isFiniteNum(row.atSec) ? row.atSec : null;
    const prev = byModel.get(modelKey);

    let anomaly: CacheAnomalyEvent | null = null;
    if (prev !== undefined && curAtSec !== null && prev.prevAtSec !== null) {
      const gapSec = Math.round(curAtSec - prev.prevAtSec);
      const compactedBetween =
        completedCheckpoints.length > 0 &&
        prev.prevStep !== null &&
        curStep !== null &&
        completedCheckpoints.some((idx) => idx > prev.prevStep! && idx <= curStep);
      if (
        gapSec >= 0 &&
        gapSec <= CACHE_ANOMALY_MAX_GAP_SEC &&
        totalIn >= CACHE_ANOMALY_MIN_IN_TOKENS &&
        totalIn >= prev.prevTotalIn * CACHE_ANOMALY_MIN_KEEP_RATIO &&
        !compactedBetween
      ) {
        if (
          prev.prevHitPct >= CACHE_CLEARED_MIN_PREV_PCT &&
          prev.prevCr >= CACHE_ANOMALY_MIN_IN_TOKENS &&
          row.cr === 0
        ) {
          anomaly = { kind: 'cleared', prevPct: Math.round(prev.prevHitPct), curPct: 0, gapSec };
        } else if (
          prev.prevHitPct - curHitPct >= CACHE_DROPPED_MIN_DELTA_PCT &&
          curHitPct < CACHE_DROPPED_MAX_CUR_PCT &&
          row.cr < 0.5 * prev.prevCr
        ) {
          anomaly = { kind: 'dropped', prevPct: Math.round(prev.prevHitPct), curPct: Math.round(curHitPct), gapSec };
        } else if (row.cr === 0 && prev.prevTotalIn >= CACHE_MISSED_MIN_PREV_IN && prev.everCached) {
          anomaly = { kind: 'missed', prevPct: Math.round(prev.prevHitPct), curPct: 0, gapSec };
        }
      }
    }

    if (anomaly !== null) cacheAnomalyCount += 1;
    if (isLatest) latestCacheAnomaly = anomaly;

    byModel.set(modelKey, {
      prevTotalIn: totalIn,
      prevCr: row.cr,
      prevHitPct: curHitPct,
      prevStep: curStep,
      prevAtSec: curAtSec,
      everCached: (prev?.everCached ?? false) || row.cr > 0,
    });
  }

  return { latestCacheAnomaly, cacheAnomalyCount };
}

function summarizeRetryDiagnostics(rows: readonly GenMetadataRow[]): {
  retryCount: number;
  retryWaitSec: number;
  retryReasons: Partial<Record<ModelErrorReason, number>>;
  errorCount: number;
  errorReasons: Partial<Record<ModelErrorReason, number>>;
  lastRetries: number;
  lastRetryReason: ModelErrorReason | null;
  lastErrorCode: ModelErrorReason | null;
} {
  let retryCount = 0;
  let retryWaitSec = 0;
  const retryReasons: Partial<Record<ModelErrorReason, number>> = {};
  let errorCount = 0;
  const errorReasons: Partial<Record<ModelErrorReason, number>> = {};

  for (const row of rows) {
    if (row.canceled === true) continue;
    if (isFiniteNum(row.retries) && row.retries > 0) retryCount += row.retries;
    if (isFiniteNum(row.retryWaitSec) && row.retryWaitSec > 0) retryWaitSec += row.retryWaitSec;
    if (row.retryReasons) {
      for (const [reason, count] of Object.entries(row.retryReasons)) {
        if (isFiniteNum(count) && count > 0) {
          const r = reason as ModelErrorReason;
          retryReasons[r] = (retryReasons[r] ?? 0) + count;
        }
      }
    }
    if (row.errorCode !== undefined) {
      errorCount += 1;
      errorReasons[row.errorCode] = (errorReasons[row.errorCode] ?? 0) + 1;
    }
  }

  const lastAny = rows[rows.length - 1];
  const lastCanceled = lastAny?.canceled === true;
  const lastErrorCode = !lastCanceled ? (lastAny?.errorCode ?? null) : null;
  const lastRetries = lastAny && !lastCanceled && lastAny.errorCode === undefined ? (lastAny.retries ?? 0) : 0;
  let lastRetryReason: ModelErrorReason | null = null;
  if (lastRetries > 0 && lastAny?.retryReasons) {
    let topCount = 0;
    for (const [reason, count] of Object.entries(lastAny.retryReasons)) {
      if (isFiniteNum(count) && count > topCount) {
        topCount = count;
        lastRetryReason = reason as ModelErrorReason;
      }
    }
  }

  return {
    retryCount,
    retryWaitSec: Math.round(retryWaitSec * 1000) / 1000,
    retryReasons,
    errorCount,
    errorReasons,
    lastRetries,
    lastRetryReason,
    lastErrorCode,
  };
}

export function evaluateSessionTelemetry(input: TelemetryEvaluationInput): SessionTelemetry {
  const { rows, tail, ckpt, data, cliSettings, stepTiming, tailStepPhase } = input;
  const ctxObj = data.context_window;
  const valid = rows.filter(hasStepMetrics);
  const compacted = isCompactionActive(valid, ckpt);
  const diagnostics = summarizeRetryDiagnostics(rows);

  const last = valid[valid.length - 1];
  if (!last) {
    const winSize = ctxObj?.context_window_size;
    const fallbackCtxMax = isFiniteNum(winSize) && winSize > 0 ? Math.trunc(winSize) : null;
    const usedPct = ctxObj?.used_percentage;
    const fallbackCtxUsed =
      compacted && ckpt !== null
        ? computeCompactedUsed(valid, ckpt, tail?.breakdown ?? null)
        : fallbackCtxMax !== null && isFiniteNum(usedPct)
          ? Math.round((Math.max(0, Math.min(100, usedPct)) / 100) * fallbackCtxMax)
          : null;
    return {
      genCount: 0,
      tps: null,
      ttft: null,
      cachePct: fallbackStdinCachePct(ctxObj),
      ctxUsed: fallbackCtxUsed,
      ctxMax: fallbackCtxMax,
      compacted,
      ...diagnostics,
      modelTimeSec: stepTiming && stepTiming.modelSec > 0 ? Math.round(stepTiming.modelSec * 10) / 10 : 0,
      toolTimeSec: stepTiming && stepTiming.toolSec > 0 ? Math.round(stepTiming.toolSec * 10) / 10 : 0,
      tailStepPhase: tailStepPhase ?? null,
    };
  }

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let fallbackModelSec = 0;
  for (const row of valid) {
    totalInputTokens += row.in + row.cw + row.cr;
    totalCacheReadTokens += row.cr;
    totalOutputTokens += row.out;
    totalThinkingTokens += row.think ?? 0;
    totalResponseTokens += row.resp ?? Math.max(0, row.out - (row.think ?? 0));
    fallbackModelSec += Math.max(0, row.ttft + row.stream);
  }

  const ctxEval = evaluateContextAndRoles(valid, tail, ckpt, compacted, cliSettings, data);
  const tps = computeEffectiveTps(last.out, last.ttft, last.stream, last.quarantinedRate === true);
  const { avgTps, peakTps } = computeSustainedThroughput(valid);
  const stepIn = last.in + last.cw + last.cr;
  const cachePct = stepIn > 0 ? (last.cr / stepIn) * 100 : fallbackStdinCachePct(ctxObj);
  const { latestCacheAnomaly, cacheAnomalyCount } = detectCacheAnomalies(valid, ckpt?.completedIndices ?? []);

  return {
    genCount: valid.length,
    tps,
    ttft: last.ttft > 0 ? last.ttft : null,
    cachePct,
    ctxUsed: ctxEval.ctxUsed,
    ctxMax: ctxEval.ctxMax,
    compacted,
    avgTps,
    peakTps,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    totalThinkingTokens,
    totalResponseTokens,
    lastThinkingTokens: last.think ?? 0,
    lastResponseTokens: last.resp ?? Math.max(0, last.out - (last.think ?? 0)),
    latestCacheAnomaly,
    cacheAnomalyCount,
    contextBreakdown: ctxEval.contextBreakdown,
    compaction: ctxEval.compaction,
    modelRoles: ctxEval.modelRoles,
    providerInputTokens: stepIn > 0 ? stepIn : null,
    truncationReason: ctxEval.truncationReason,
    ...diagnostics,
    modelTimeSec:
      stepTiming && stepTiming.modelSec > 0
        ? Math.round(stepTiming.modelSec * 10) / 10
        : Math.round(fallbackModelSec * 10) / 10,
    toolTimeSec: stepTiming && stepTiming.toolSec > 0 ? Math.round(stepTiming.toolSec * 10) / 10 : 0,
    tailStepPhase: tailStepPhase ?? null,
    lastModelName: last.modelKey ?? null,
  };
}
