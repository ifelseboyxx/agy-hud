export const RESET: string = '\x1b[0m';
export const BOLD: string = '\x1b[1m';
export const GREEN: string = '\x1b[32m';
export const YELLOW: string = '\x1b[33m';
export const MAGENTA: string = '\x1b[35m';
export const CYAN: string = '\x1b[36m';
export const WHITE: string = '\x1b[37m';
export const NO_BOLD: string = '\x1b[22m';
export const GRAY: string = '\x1b[90m';
export const BRIGHT_RED: string = '\x1b[91m';
export const BRIGHT_GREEN: string = '\x1b[92m';
export const BRIGHT_YELLOW: string = '\x1b[93m';
export const BRIGHT_BLUE: string = '\x1b[94m';
export const BRIGHT_MAGENTA: string = '\x1b[95m';
export const BRIGHT_CYAN: string = '\x1b[96m';
export const BRIGHT_WHITE: string = '\x1b[97m';

const BAR_WIDTH: number = 10;
export const DEFAULT_TERM_WIDTH: number = 120;

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
      (cp >= 0x1b000 && cp <= 0x1b2ff) ||
      (cp >= 0x1f000 && cp <= 0x3fffd))
  );
}

const ZERO_WIDTH_CHAR_RE = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

function charDisplayWidth(ch: string): number {
  if (ZERO_WIDTH_CHAR_RE.test(ch)) {
    return 0;
  }
  return isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
}

export function visibleLen(text: string): number {
  const plain = stripAnsi(text);
  let cols = 0;
  for (const ch of plain) {
    cols += charDisplayWidth(ch);
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
    const w = charDisplayWidth(ch);
    if (w === 0) {
      if (out.length > 0) {
        out += ch;
      }
      continue;
    }
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
