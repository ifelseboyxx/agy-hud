import { isFiniteNum } from '../core/guards.ts';
import type { SessionTelemetry } from '../types.ts';

export const RESET: string = '\x1b[0m';
export const BOLD: string = '\x1b[1m';
export const GREEN: string = '\x1b[32m';
export const YELLOW: string = '\x1b[33m';
export const MAGENTA: string = '\x1b[35m';
export const CYAN: string = '\x1b[36m';
export const GRAY: string = '\x1b[90m';
export const BRIGHT_RED: string = '\x1b[91m';
export const BRIGHT_GREEN: string = '\x1b[92m';
export const BRIGHT_YELLOW: string = '\x1b[93m';
export const BRIGHT_BLUE: string = '\x1b[94m';
export const BRIGHT_MAGENTA: string = '\x1b[95m';
export const BRIGHT_CYAN: string = '\x1b[96m';
export const BRIGHT_WHITE: string = '\x1b[97m';

export const BAR_WIDTH: number = 10;
export const DEFAULT_TERM_WIDTH: number = 120;

const BINARY_1M_TOKENS = 1_048_576;
const BINARY_2M_TOKENS = 2_097_152;
const FAST_TPS_THRESHOLD = 80.0;
const SLOW_TPS_THRESHOLD = 30.0;
const GOOD_TTFT_SEC = 3.0;
const WARN_TTFT_SEC = 8.0;
const BAD_TTFT_SEC = 15.0;
const GOOD_CACHE_PCT = 80.0;
const WARN_CACHE_PCT = 50.0;

// Construct ESC and BEL dynamically so oxlint no-control-regex stays clean.
const ESC_CHAR = String.fromCharCode(0x1b);
const BEL_CHAR = String.fromCharCode(0x07);
const ANSI_ESCAPE_RE = new RegExp(`${ESC_CHAR}(?:\\[[0-9;]*m|\\][\\s\\S]*?(?:${BEL_CHAR}|${ESC_CHAR}\\\\))`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

export function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
      (cp >= 0x3250 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4c6) ||
      (cp >= 0xa960 && cp <= 0xa97c) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6b) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f200 && cp <= 0x3fffd))
  );
}

export function visibleLen(text: string): number {
  const plain = stripAnsi(text);
  let cols = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    cols += isWideCodePoint(cp) ? 2 : 1;
  }
  return cols;
}

export function truncateToWidth(text: string, maxCols: number): string {
  const limit = Math.floor(maxCols);
  if (!Number.isFinite(limit) || limit <= 0) {
    return '';
  }
  const plain = stripAnsi(text);
  if (visibleLen(plain) <= limit) {
    return text;
  }
  if (limit === 1) {
    return '…';
  }
  let out = '';
  let cols = 0;
  for (const ch of plain) {
    const w = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (cols + w > limit - 1) {
      break;
    }
    out += ch;
    cols += w;
  }
  return `${out}…`;
}

export function padEndVisible(text: string, targetCols: number): string {
  const pad = Math.max(0, Math.floor(targetCols) - visibleLen(text));
  return pad > 0 ? `${text}${' '.repeat(pad)}` : text;
}

export function colorForUsedPct(pct: number): string {
  if (pct >= 80) {
    return BRIGHT_RED;
  }
  if (pct >= 50) {
    return BRIGHT_YELLOW;
  }
  return BRIGHT_CYAN;
}

export function colorForRemainingPct(pct: number): string {
  if (pct < 20) {
    return BRIGHT_RED;
  }
  if (pct < 50) {
    return BRIGHT_YELLOW;
  }
  return BRIGHT_GREEN;
}

export function renderBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.round((clamped / 100) * BAR_WIDTH);
  if (clamped > 0 && filled === 0) {
    filled = 1;
  }
  const empty = BAR_WIDTH - filled;
  const color = colorForUsedPct(clamped);
  return `${color}${'█'.repeat(filled)}${GRAY}${'░'.repeat(empty)}${RESET}`;
}

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

function fmtTtft(sec: number): string {
  if (sec < 10) {
    return `${sec.toFixed(2)}s`;
  }
  if (sec < 60) {
    return `${sec.toFixed(1)}s`;
  }
  const total = Math.trunc(sec);
  return `${Math.floor(total / 60)}m${total % 60}s`;
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

function colorCache(pct: number, genCount: number): string {
  if (genCount <= 1 && pct === 0) {
    return GRAY;
  }
  if (pct >= GOOD_CACHE_PCT) {
    return BRIGHT_GREEN;
  }
  if (pct >= WARN_CACHE_PCT) {
    return BRIGHT_YELLOW;
  }
  return BRIGHT_RED;
}

export function buildPerfSegments(telemetry: SessionTelemetry | null | undefined): string[] {
  if (!telemetry) {
    return [];
  }
  const segs: string[] = [];
  const { tps, ttft, cachePct, genCount } = telemetry;

  if (isFiniteNum(tps) && tps > 0) {
    const tpsStr = tps >= 100 ? `${tps.toFixed(0)} t/s` : `${tps.toFixed(1)} t/s`;
    const tpsCol = tps >= FAST_TPS_THRESHOLD ? BRIGHT_GREEN : tps < SLOW_TPS_THRESHOLD ? BRIGHT_YELLOW : BRIGHT_CYAN;
    segs.push(`${tpsCol}${tpsStr}${RESET}`);
  }

  if (isFiniteNum(ttft) && ttft > 0) {
    segs.push(`${GRAY}TTFT ${colorTtft(ttft)}${fmtTtft(ttft)}${RESET}`);
  }

  if (isFiniteNum(cachePct) && (genCount > 0 || cachePct > 0)) {
    const clamped = Math.max(0, Math.min(100, cachePct));
    const pctStr = clamped >= 99.95 ? '100%' : `${clamped.toFixed(0)}%`;
    segs.push(`${GRAY}Cache ${colorCache(clamped, genCount)}${pctStr}${RESET}`);
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
