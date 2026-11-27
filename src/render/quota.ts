import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { NARROW_PANE_WIDTH_THRESHOLD } from '../core/hud-config.ts';
import { computeQuotaPace, resolveQuotaReset } from '../core/quota-pace.ts';
import { sanitizeTerminalText } from '../core/terminal-text.ts';
import type { ResolvedSnapshotQuotaBucket } from '../snapshot-types.ts';
import type { QuotaBucketItem, StatusLineData } from '../types.ts';
import {
  BRIGHT_CYAN,
  BRIGHT_MAGENTA,
  BRIGHT_RED,
  BRIGHT_WHITE,
  BRIGHT_YELLOW,
  colorForRemainingPct,
  GRAY,
  RESET,
  visibleLen,
} from './ansi.ts';
import { fmtQuotaReset } from './telemetry-format.ts';

const SECONDARY_QUOTA_MIN_WIDTH = 120;
const FULL_QUOTA_PCT_THRESHOLD = 99.995;
const URGENT_ETA_SEC = 1_800;

const KNOWN_QUOTA_KEYS: ReadonlySet<string> = new Set([
  'gemini-5h',
  'gemini-weekly',
  'gemini-argon-wtu-weekly',
  '3p-5h',
  '3p-weekly',
]);

export interface FormatQuotaItemOptions {
  readonly compact?: boolean;
  readonly bucketKey?: string;
  readonly allowEtaText?: boolean;
}

function isThirdPartyModel(data: StatusLineData): boolean {
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
  const bucketKey = isThirdPartyModel(data) ? '3p-5h' : 'gemini-5h';
  const entry = quota[bucketKey];
  if (!entry || entry.disabled === true) {
    return '';
  }
  const { windowExpired } = resolveQuotaReset(entry, nowSec);
  if (isFiniteNum(entry.remaining_fraction)) {
    const pct = windowExpired ? 100 : Math.max(0, Math.min(100, entry.remaining_fraction * 100));
    const { text } = formatRemainingQuotaPct(pct);
    const pace = computeQuotaPace(bucketKey, entry, nowSec);
    const bang = pace?.status === 'depleting' ? '!' : '';
    return `${GRAY}5h ${colorForRemainingPct(pct)}${text}${bang}${RESET}`;
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
  const allowEtaText = options?.allowEtaText !== false;

  let pctText: string;
  let valColor: string;
  let showReset: boolean;
  let showDirection = false;
  let etaInlinePart = '';

  if (isFiniteNum(frac)) {
    const pct = windowExpired ? 100 : Math.max(0, Math.min(100, frac * 100));
    const formatted = formatRemainingQuotaPct(pct);
    pctText = formatted.text;
    valColor = muted ? GRAY : colorForRemainingPct(pct);
    showReset = !formatted.isFull && isFiniteNum(remainingSeconds) && remainingSeconds > 0;
    showDirection = !compact;

    const pace = !muted && options?.bucketKey !== undefined ? computeQuotaPace(options.bucketKey, entry, nowSec) : null;
    if (pace?.status === 'depleting') {
      const etaText = pace.etaToZeroSec !== null ? fmtQuotaReset(pace.etaToZeroSec) : '';
      if (!compact && allowEtaText && showReset && etaText.length > 0 && isFiniteNum(remainingSeconds)) {
        const urgent =
          pace.etaToZeroSec !== null &&
          (pace.etaToZeroSec < 0.5 * remainingSeconds || pace.etaToZeroSec < URGENT_ETA_SEC);
        const etaColor = urgent ? BRIGHT_RED : BRIGHT_YELLOW;
        etaInlinePart = ` · ${etaColor}~0% ${etaText}${GRAY}`;
      } else {
        pctText = `${pctText}!`;
      }
    }
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
  const rstPart = rst.length > 0 ? ` ${GRAY}(${rst}${etaInlinePart})${RESET}` : '';
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

  const formatGeminiGroup = (allowEtaText: boolean): string[] =>
    [
      formatQuotaItem('5h', quota['gemini-5h'], is3p, nowSec, { compact, bucketKey: 'gemini-5h', allowEtaText }),
      formatQuotaItem(isArgon ? 'Base 7d' : '7d', quota['gemini-weekly'], is3p, nowSec, {
        compact,
        bucketKey: 'gemini-weekly',
        allowEtaText,
      }),
      formatQuotaItem(isArgon ? '7d' : 'Argon 7d', quota['gemini-argon-wtu-weekly'], is3p, nowSec, {
        compact,
        bucketKey: 'gemini-argon-wtu-weekly',
        allowEtaText,
      }),
    ].filter((x): x is string => x !== null);

  const formatThirdPartyGroup = (allowEtaText: boolean): string[] =>
    [
      formatQuotaItem('5h', quota['3p-5h'], !is3p, nowSec, { compact, bucketKey: '3p-5h', allowEtaText }),
      formatQuotaItem('7d', quota['3p-weekly'], !is3p, nowSec, { compact, bucketKey: '3p-weekly', allowEtaText }),
    ].filter((x): x is string => x !== null);

  const gLabel = 'Gemini';
  const p3Label = 'Claude/GPT';

  const buildPrimary = (allowEtaText: boolean): string => {
    const gItems = formatGeminiGroup(allowEtaText);
    const p3Items = formatThirdPartyGroup(allowEtaText);
    if (is3p && p3Items.length > 0) return `${BRIGHT_MAGENTA}${p3Label}${RESET} ${p3Items.join(subSep)}`;
    if (!is3p && gItems.length > 0) return `${BRIGHT_CYAN}${gLabel}${RESET} ${gItems.join(subSep)}`;
    return '';
  };

  let primary = buildPrimary(true);
  if (!compact && primary.length > 0 && visibleLen(`  ${[...items, primary].join(sep)}`) > termWidth - 1) {
    primary = buildPrimary(false);
  }

  const gItemsMuted = formatGeminiGroup(false);
  const p3ItemsMuted = formatThirdPartyGroup(false);
  const secondary =
    is3p && gItemsMuted.length > 0
      ? `${GRAY}${gLabel}${RESET} ${gItemsMuted.join(subSep)}`
      : !is3p && p3ItemsMuted.length > 0
        ? `${GRAY}${p3Label}${RESET} ${p3ItemsMuted.join(subSep)}`
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
    .map(([k, v]) => formatQuotaItem(k, v, false, nowSec, { compact, bucketKey: k, allowEtaText: !compact }))
    .filter((x): x is string => x !== null);
  if (extra.length > 0) {
    items.push(extra.join(subSep));
  }
}

export function formatSnapshotQuotaLine(
  buckets: readonly ResolvedSnapshotQuotaBucket[],
  options?: { readonly color?: boolean; readonly escapeText?: (text: string) => string },
): string {
  if (buckets.length === 0) return '';
  const useColor = options?.color === true;
  const escapeText = options?.escapeText ?? ((s: string) => s);
  const parts: string[] = [];

  for (const bucket of buckets) {
    const label = escapeText(sanitizeTerminalText(bucket.label));
    if (bucket.remainingPct !== null) {
      const formatted = formatRemainingQuotaPct(bucket.remainingPct);
      const isDepleting = bucket.pace?.status === 'depleting';
      const pctCol = useColor ? colorForRemainingPct(bucket.remainingPct) : '';
      const resetCol = useColor ? RESET : '';
      const dimCol = useColor ? GRAY : '';
      const valueText = `${pctCol}${formatted.text}${resetCol} left${isDepleting ? '!' : ''}`;

      const details: string[] = [];
      if (!formatted.isFull && isFiniteNum(bucket.remainingSeconds) && bucket.remainingSeconds > 0) {
        const rst = fmtQuotaReset(bucket.remainingSeconds);
        if (rst.length > 0) details.push(`reset ${rst}`);
      }
      if (bucket.pace?.status === 'on_track') {
        details.push(`pace ${bucket.pace.paceRatio.toFixed(1).replace(/\.0$/, '')}x`);
        details.push(`~${Math.max(0, bucket.pace.projectedRemainingPct)}% at reset`);
      } else if (bucket.pace?.status === 'depleting' && bucket.pace.etaToZeroSec !== null) {
        details.push(`pace ${bucket.pace.paceRatio.toFixed(1).replace(/\.0$/, '')}x`);
        const eta = fmtQuotaReset(bucket.pace.etaToZeroSec);
        if (eta.length > 0) {
          const etaCol = useColor
            ? bucket.pace.etaToZeroSec < 0.5 * bucket.pace.remainingSec || bucket.pace.etaToZeroSec < URGENT_ETA_SEC
              ? BRIGHT_RED
              : BRIGHT_YELLOW
            : '';
          details.push(`${etaCol}~0% in ${eta}${dimCol}`);
        }
      }
      const detailSuffix = details.length > 0 ? ` ${dimCol}(${details.join(' · ')})${resetCol}` : '';
      parts.push(`${label} ${valueText}${detailSuffix}`);
    } else if (bucket.remainingAmount !== null) {
      const rst =
        isFiniteNum(bucket.remainingSeconds) && bucket.remainingSeconds > 0
          ? fmtQuotaReset(bucket.remainingSeconds)
          : '';
      const suffix = rst.length > 0 ? ` (reset ${rst})` : '';
      parts.push(`${label} ${escapeText(sanitizeTerminalText(bucket.remainingAmount))}${suffix}`);
    }
  }
  return parts.join(' · ');
}
