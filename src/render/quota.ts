import { resolveQuotaReset } from '../collectors/telemetry.ts';
import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { NARROW_PANE_WIDTH_THRESHOLD } from '../core/hud-config.ts';
import { sanitizeTerminalText } from '../core/terminal-text.ts';
import type { QuotaBucketItem, StatusLineData } from '../types.ts';
import {
  BRIGHT_CYAN,
  BRIGHT_MAGENTA,
  BRIGHT_WHITE,
  colorForRemainingPct,
  fmtQuotaReset,
  GRAY,
  RESET,
  visibleLen,
} from './ansi.ts';

const SECONDARY_QUOTA_MIN_WIDTH = 120;
const FULL_QUOTA_PCT_THRESHOLD = 99.995;

const KNOWN_QUOTA_KEYS: ReadonlySet<string> = new Set([
  'gemini-5h',
  'gemini-weekly',
  'gemini-argon-wtu-weekly',
  '3p-5h',
  '3p-weekly',
]);

export interface FormatQuotaItemOptions {
  readonly compact?: boolean;
}

export function isThirdPartyModel(data: StatusLineData): boolean {
  const modelId = (nonEmptyStr(data.model?.id) ?? nonEmptyStr(data.model?.display_name) ?? '').toLowerCase();
  return ['claude', 'opus', 'sonnet', 'haiku', 'gpt'].some((k) => modelId.includes(k));
}

export function formatRemainingQuotaPct(pct: number): { readonly text: string; readonly isFull: boolean } {
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped >= FULL_QUOTA_PCT_THRESHOLD) {
    return { text: '100%', isFull: true };
  }
  if (clamped >= 99) {
    return { text: '99%', isFull: false };
  }
  if (clamped > 0 && clamped < 1) {
    return { text: '<1%', isFull: false };
  }
  return { text: `${Math.round(clamped)}%`, isFull: false };
}

export function formatCompactPrimaryQuotaTail(data: StatusLineData, nowSec: number): string {
  const quota = data.quota;
  if (!quota) {
    return '';
  }
  const entry = isThirdPartyModel(data) ? quota['3p-5h'] : quota['gemini-5h'];
  if (!entry || entry.disabled === true) {
    return '';
  }
  const { windowExpired } = resolveQuotaReset(entry, nowSec);
  if (isFiniteNum(entry.remaining_fraction)) {
    const pct = windowExpired ? 100 : Math.max(0, Math.min(100, entry.remaining_fraction * 100));
    const { text } = formatRemainingQuotaPct(pct);
    return `${GRAY}5h ${colorForRemainingPct(pct)}${text}${RESET}`;
  }
  if (entry.remaining_amount !== undefined && entry.remaining_amount !== null) {
    return `${GRAY}5h ${BRIGHT_WHITE}${sanitizeTerminalText(String(entry.remaining_amount))}${RESET}`;
  }
  return '';
}

export function formatQuotaItem(
  label: string,
  entry: QuotaBucketItem | undefined,
  muted: boolean = false,
  nowSec: number = Date.now() / 1000,
  options?: FormatQuotaItemOptions,
): string | null {
  if (!entry || entry.disabled === true) {
    return null;
  }
  const { remainingSeconds, windowExpired } = resolveQuotaReset(entry, nowSec);
  const frac = entry.remaining_fraction;
  const amt = entry.remaining_amount;
  const compact = options?.compact === true;

  let pctText: string;
  let valColor: string;
  let showReset: boolean;
  let showDirection = false;

  if (isFiniteNum(frac)) {
    const pct = windowExpired ? 100 : Math.max(0, Math.min(100, frac * 100));
    const formatted = formatRemainingQuotaPct(pct);
    pctText = formatted.text;
    valColor = muted ? GRAY : colorForRemainingPct(pct);
    showReset = !formatted.isFull && isFiniteNum(remainingSeconds) && remainingSeconds > 0;
    showDirection = !compact;
  } else if (amt !== undefined && amt !== null) {
    pctText = sanitizeTerminalText(String(amt));
    valColor = muted ? GRAY : BRIGHT_WHITE;
    showReset = isFiniteNum(remainingSeconds) && remainingSeconds > 0;
    showDirection = !compact;
  } else {
    return null;
  }

  const rst = showReset ? fmtQuotaReset(remainingSeconds) : '';
  const labelColor = muted ? GRAY : BRIGHT_WHITE;
  const dirPart = showDirection ? ` ${GRAY}left${RESET}` : '';
  const rstPart = rst.length > 0 ? ` ${GRAY}(${rst})${RESET}` : '';
  return `${labelColor}${sanitizeTerminalText(label)}: ${valColor}${pctText}${RESET}${dirPart}${rstPart}`;
}

export function appendQuotaUsageItems(
  items: string[],
  data: StatusLineData,
  nowSec: number,
  termWidth: number,
  sep: string,
  subSep: string,
): void {
  const quota = data.quota;
  if (!quota) {
    return;
  }
  const compact = termWidth < NARROW_PANE_WIDTH_THRESHOLD;
  const modelId = (nonEmptyStr(data.model?.id) ?? nonEmptyStr(data.model?.display_name) ?? '').toLowerCase();
  const is3p = isThirdPartyModel(data);
  const isArgon = modelId.includes('argon');
  const itemOpts: FormatQuotaItemOptions = { compact };

  const gItems = [
    formatQuotaItem('5h', quota['gemini-5h'], is3p, nowSec, itemOpts),
    formatQuotaItem(isArgon ? 'G 7d' : '7d', quota['gemini-weekly'], is3p, nowSec, itemOpts),
    formatQuotaItem(isArgon ? '7d' : 'Argon 7d', quota['gemini-argon-wtu-weekly'], is3p, nowSec, itemOpts),
  ].filter((x): x is string => x !== null);

  const p3Items = [
    formatQuotaItem('5h', quota['3p-5h'], !is3p, nowSec, itemOpts),
    formatQuotaItem('7d', quota['3p-weekly'], !is3p, nowSec, itemOpts),
  ].filter((x): x is string => x !== null);

  const gLabel = compact ? 'Gem' : 'Gemini';
  const p3Label = compact ? '3P' : '3rd-Party';

  const primary =
    is3p && p3Items.length > 0
      ? `${BRIGHT_MAGENTA}${p3Label}${RESET} ${p3Items.join(subSep)}`
      : !is3p && gItems.length > 0
        ? `${BRIGHT_CYAN}${gLabel}${RESET} ${gItems.join(subSep)}`
        : '';

  const secondary =
    is3p && gItems.length > 0
      ? `${GRAY}${gLabel}${RESET} ${gItems.join(subSep)}`
      : !is3p && p3Items.length > 0
        ? `${GRAY}${p3Label}${RESET} ${p3Items.join(subSep)}`
        : '';

  if (primary.length > 0) {
    items.push(primary);
  }
  if (secondary.length > 0 && termWidth >= SECONDARY_QUOTA_MIN_WIDTH) {
    const candidate = `  ${[...items, secondary].join(sep)}`;
    if (visibleLen(candidate) <= termWidth - 1) {
      items.push(secondary);
    }
  }

  const extra = Object.entries(quota)
    .filter(([k]) => !KNOWN_QUOTA_KEYS.has(k))
    .map(([k, v]) => formatQuotaItem(k, v, false, nowSec, itemOpts))
    .filter((x): x is string => x !== null);
  if (extra.length > 0) {
    items.push(extra.join(subSep));
  }
}
