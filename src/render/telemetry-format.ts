import { isFiniteNum } from '../core/guards.ts';
import type { SessionTelemetry, StatusLineContextWindow } from '../types.ts';
import {
  BRIGHT_CYAN,
  BRIGHT_GREEN,
  BRIGHT_RED,
  BRIGHT_WHITE,
  BRIGHT_YELLOW,
  GRAY,
  RESET,
  visibleLen,
  YELLOW,
} from './ansi.ts';

const BINARY_1M_TOKENS = 1_048_576;
const BINARY_2M_TOKENS = 2_097_152;
const FAST_TPS_THRESHOLD = 80.0;
const SLOW_TPS_THRESHOLD = 30.0;
const GOOD_TTFT_SEC = 3.0;
const WARN_TTFT_SEC = 8.0;
const BAD_TTFT_SEC = 15.0;
const GOOD_CACHE_PCT = 80.0;
const WARN_CACHE_PCT = 50.0;

export function fmtDuration(sec: number | null | undefined, spaced = true, useDays = true): string {
  if (!isFiniteNum(sec) || sec < 0) {
    return '';
  }
  const total = Math.trunc(sec);
  if (total < 60) {
    return '<1m';
  }
  const sep = spaced ? ' ' : '';
  if (useDays) {
    const d = Math.floor(total / 86400);
    const rem = total % 86400;
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    if (d > 0) {
      return `${d}d${sep}${h}h`;
    }
    if (h > 0) {
      return `${h}h${sep}${m}m`;
    }
    return `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) {
    return `${h}h${sep}${m}m`;
  }
  return `${m}m`;
}

export function fmtQuotaReset(sec: number | null | undefined): string {
  if (!isFiniteNum(sec) || sec < 0) {
    return '';
  }
  const total = Math.trunc(sec);
  if (total < 60) {
    return '<1m';
  }
  const d = Math.floor(total / 86400);
  const rem = total % 86400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  if (d > 0) {
    return h > 0 ? `${d}d${h}h` : `${d}d`;
  }
  if (h > 0) {
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${m}m`;
}

export function fmtTokens(count: number | null | undefined): string {
  if (!isFiniteNum(count) || count < 0) {
    return '';
  }
  const val = Math.round(count);
  if (val === 1_000_000 || val === BINARY_1M_TOKENS) {
    return '1M';
  }
  if (val === 2_000_000 || val === BINARY_2M_TOKENS) {
    return '2M';
  }
  if (val >= 1_000_000) {
    return `${(val / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (val >= 10_000) {
    return `${Math.round(val / 1000)}k`;
  }
  if (val >= 1000) {
    return `${(val / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(val);
}

function fmtCompactSeconds(sec: number | null | undefined): string {
  if (!isFiniteNum(sec) || sec <= 0) return '';
  if (sec < 1) return '<1s';
  if (sec < 10) return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function fmtTtft(sec: number): string {
  if (sec < 0.9995) {
    return `${Math.max(1, Math.round(sec * 1000))}ms`;
  }
  if (sec < 59.95) {
    return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
  }
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function colorTtft(sec: number): string {
  if (sec <= GOOD_TTFT_SEC) {
    return BRIGHT_GREEN;
  }
  if (sec <= WARN_TTFT_SEC) {
    return BRIGHT_WHITE;
  }
  if (sec <= BAD_TTFT_SEC) {
    return BRIGHT_YELLOW;
  }
  return BRIGHT_RED;
}

function colorCache(pct: number, hasActiveAnomaly: boolean): string {
  if (hasActiveAnomaly) {
    return BRIGHT_RED;
  }
  if (pct <= 0) {
    return GRAY;
  }
  if (pct >= GOOD_CACHE_PCT) {
    return BRIGHT_GREEN;
  }
  if (pct >= WARN_CACHE_PCT) {
    return BRIGHT_YELLOW;
  }
  return YELLOW;
}

function formatTpsNum(tps: number): string {
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1).replace(/\.0$/, '');
}

function formatTpsText(tps: number): string {
  return `${formatTpsNum(tps)} token/s`;
}

export function buildPerfSegments(telemetry: SessionTelemetry | null | undefined): string[] {
  if (!telemetry) {
    return [];
  }
  const segs: string[] = [];
  const { tps, ttft, cachePct, genCount } = telemetry;

  if (isFiniteNum(tps) && tps > 0) {
    const tpsStr = formatTpsText(tps);
    const tpsCol = tps >= FAST_TPS_THRESHOLD ? BRIGHT_GREEN : tps < SLOW_TPS_THRESHOLD ? BRIGHT_YELLOW : BRIGHT_CYAN;
    segs.push(`${tpsCol}${tpsStr}${RESET}`);
  }

  if (isFiniteNum(ttft) && ttft > 0) {
    segs.push(`${GRAY}TTFT ${colorTtft(ttft)}${fmtTtft(ttft)}${RESET}`);
  }

  if (isFiniteNum(cachePct) && (genCount > 0 || cachePct > 0)) {
    const clamped = Math.max(0, Math.min(100, cachePct));
    const pctStr = clamped >= 99.95 ? '100%' : `${clamped.toFixed(0)}%`;
    const isAnomaly = telemetry.latestCacheAnomaly !== undefined && telemetry.latestCacheAnomaly !== null;
    const bang = isAnomaly ? '!' : '';
    segs.push(`${GRAY}Cache ${colorCache(clamped, isAnomaly)}${pctStr}${bang}${RESET}`);
  }

  return segs;
}

export function fitPerfCapsule(
  baseLine: string,
  telemetry: SessionTelemetry | null | undefined,
  termWidth: number,
): string {
  const perfSegs = buildPerfSegments(telemetry);
  if (perfSegs.length === 0) {
    return baseLine;
  }
  const sep = ` ${GRAY}│${RESET} `;
  const dot = ` ${GRAY}·${RESET} `;
  for (let count = perfSegs.length; count >= 1; count -= 1) {
    const candidate = `${baseLine}${sep}${perfSegs.slice(0, count).join(dot)}`;
    if (visibleLen(candidate) <= termWidth - 1) {
      return candidate;
    }
  }
  return baseLine;
}

export function formatContextCapacity(
  ctxObj: StatusLineContextWindow | undefined,
  telemetry: SessionTelemetry | null | undefined,
): string {
  const hasSqliteBudget =
    telemetry !== null &&
    telemetry !== undefined &&
    telemetry.genCount > 0 &&
    isFiniteNum(telemetry.ctxMax) &&
    telemetry.ctxMax > 0;

  if (hasSqliteBudget) {
    const maxTok = Math.trunc(telemetry.ctxMax!);
    if (isFiniteNum(telemetry.ctxUsed)) {
      const prefix = telemetry.compacted === true ? '~' : '';
      return `${GRAY}(${prefix}${fmtTokens(Math.trunc(telemetry.ctxUsed))}/${fmtTokens(maxTok)})${RESET}`;
    }
  }

  const winSize = ctxObj?.context_window_size;
  const maxTok = hasSqliteBudget
    ? Math.trunc(telemetry.ctxMax!)
    : isFiniteNum(winSize) && winSize > 0
      ? Math.trunc(winSize)
      : (telemetry?.ctxMax ?? null);
  if (!isFiniteNum(maxTok) || maxTok <= 0) {
    return '';
  }

  if (telemetry?.compacted === true && isFiniteNum(telemetry.ctxUsed)) {
    return `${GRAY}(~${fmtTokens(Math.trunc(telemetry.ctxUsed))}/${fmtTokens(maxTok)})${RESET}`;
  }

  let usedTok: number;
  const ctxPct = ctxObj?.used_percentage;
  if (isFiniteNum(ctxPct)) {
    usedTok = Math.round((Math.max(0, ctxPct) / 100) * maxTok);
  } else if (isFiniteNum(telemetry?.ctxUsed)) {
    usedTok = Math.trunc(telemetry.ctxUsed);
  } else {
    return '';
  }

  return `${GRAY}(${fmtTokens(usedTok)}/${fmtTokens(maxTok)})${RESET}`;
}

export interface FormattedTelemetryFields {
  readonly ctx: { readonly text: string; readonly pct: number } | null;
  readonly tpsText: string | null;
  readonly ttftText: string | null;
  readonly cacheText: string | null;
  readonly outputText: string | null;
  readonly timeText: string | null;
}

export function formatTelemetryFields(telemetry: SessionTelemetry | null | undefined): FormattedTelemetryFields {
  if (!telemetry) {
    return { ctx: null, tpsText: null, ttftText: null, cacheText: null, outputText: null, timeText: null };
  }
  let ctx: { readonly text: string; readonly pct: number } | null = null;
  if (isFiniteNum(telemetry.ctxUsed) && isFiniteNum(telemetry.ctxMax) && telemetry.ctxMax > 0) {
    const pct = Math.min(100, Math.round((telemetry.ctxUsed / telemetry.ctxMax) * 100));
    const tilde = telemetry.compacted === true ? '~' : '';
    ctx = { text: `${tilde}${fmtTokens(telemetry.ctxUsed)}/${fmtTokens(telemetry.ctxMax)} (${pct}%)`, pct };
  }

  let tpsText: string | null = isFiniteNum(telemetry.tps) && telemetry.tps > 0 ? formatTpsText(telemetry.tps) : null;
  if (tpsText !== null && isFiniteNum(telemetry.avgTps) && telemetry.avgTps > 0) {
    const stats = [`avg ${formatTpsNum(telemetry.avgTps)}`];
    if (isFiniteNum(telemetry.peakTps) && telemetry.peakTps > 0) {
      stats.push(`peak ${formatTpsNum(telemetry.peakTps)}`);
    }
    tpsText = `${tpsText} (${stats.join(' · ')})`;
  }

  const ttftText = isFiniteNum(telemetry.ttft) && telemetry.ttft > 0 ? fmtTtft(telemetry.ttft) : null;

  let cacheText: string | null = null;
  if (isFiniteNum(telemetry.cachePct) && (telemetry.genCount > 0 || telemetry.cachePct > 0)) {
    const pctRounded = Math.round(Math.max(0, Math.min(100, telemetry.cachePct)));
    const anomaly = telemetry.latestCacheAnomaly ?? null;
    const dropCount = telemetry.cacheAnomalyCount ?? 0;
    if (anomaly !== null) {
      const extraDrops = dropCount > 1 ? ` · cache drops ×${dropCount}` : '';
      cacheText = `${pctRounded}%! (${anomaly.kind} ${anomaly.prevPct}% -> ${anomaly.curPct}%, ${anomaly.gapSec}s gap)${extraDrops}`;
    } else if (dropCount > 0) {
      cacheText = `${pctRounded}% (cache drops ×${dropCount})`;
    } else {
      cacheText = `${pctRounded}%`;
    }
  }

  let outputText: string | null = null;
  const totalOut = telemetry.totalOutputTokens ?? 0;
  if (totalOut > 0) {
    const think = telemetry.totalThinkingTokens ?? 0;
    const resp = telemetry.totalResponseTokens ?? Math.max(0, totalOut - think);
    if (think > 0) {
      const thinkPct = Math.round((think / totalOut) * 100);
      outputText = `Out ${fmtTokens(totalOut)} (think ${fmtTokens(think)} · ${thinkPct}% / reply ${fmtTokens(resp)})`;
    } else {
      outputText = `Out ${fmtTokens(totalOut)}`;
    }
  }

  let timeText: string | null = null;
  const modelSec = telemetry.modelTimeSec ?? 0;
  const toolSec = telemetry.toolTimeSec ?? 0;
  if (modelSec > 0 || toolSec > 0) {
    const mStr = modelSec > 0 ? fmtCompactSeconds(modelSec) : '0s';
    const tStr = toolSec > 0 ? fmtCompactSeconds(toolSec) : '0s';
    timeText = `Time ${mStr} model / ${tStr} tool`;
  }

  return { ctx, tpsText, ttftText, cacheText, outputText, timeText };
}

function formatReasonBreakdown(counts: Partial<Record<string, number>> | undefined): string {
  if (!counts) return '';
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => isFiniteNum(entry[1]) && entry[1] > 0)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([reason, count]) => `${reason} ×${count}`)
    .join(', ');
}

export function formatTelemetryDiagnostics(telemetry: SessionTelemetry | null | undefined): string {
  if (!telemetry) return '';
  const retries = telemetry.retryCount ?? 0;
  const errors = telemetry.errorCount ?? 0;
  if (retries <= 0 && errors <= 0) return '';

  const parts: string[] = [];
  if (retries > 0) {
    const waitStr =
      isFiniteNum(telemetry.retryWaitSec) && telemetry.retryWaitSec > 0
        ? `wait ${fmtCompactSeconds(telemetry.retryWaitSec)}`
        : '';
    const reasonStr = formatReasonBreakdown(telemetry.retryReasons);
    const detail = [waitStr, reasonStr].filter((s) => s.length > 0).join(': ');
    parts.push(detail.length > 0 ? `Retries ×${retries} (${detail})` : `Retries ×${retries}`);
  }
  if (errors > 0) {
    const reasonStr = formatReasonBreakdown(telemetry.errorReasons);
    parts.push(reasonStr.length > 0 ? `Errors ×${errors} (${reasonStr})` : `Errors ×${errors}`);
  }
  return parts.join(' · ');
}
