import type {
  HostAgentState,
  QuotaPaceForecast,
  ResolvedSnapshotQuotaBucket,
  SnapshotQuotaBucket,
} from '../snapshot-types.ts';
import type { QuotaBucketGroup, QuotaBucketItem } from '../types.ts';
import { isFiniteNum, isPlainObject, nonEmptyStr, parseIsoTimestampSec, UNSAFE_OBJECT_KEYS } from './guards.ts';
import { sanitizeTerminalLabel } from './terminal-text.ts';

const WINDOW_5H_SEC = 18_000;
const SMOOTHING_FLOOR_5H_SEC = 1_800;
const SETTLING_ELAPSED_5H_SEC = 900;

const WINDOW_7D_SEC = 604_800;
const SMOOTHING_FLOOR_7D_SEC = 43_200;
const SETTLING_ELAPSED_7D_SEC = 21_600;

const SETTLING_MIN_USED_FRACTION = 0.1;
const IMMEDIATE_WARN_USED_FRACTION = 0.5;
const DEPLETING_PROJECTION_THRESHOLD = 1.05;
const MAX_ENVELOPE_QUOTA_BUCKETS = 16;

const VALID_HOST_AGENT_STATES: ReadonlySet<HostAgentState> = new Set([
  'idle',
  'initializing',
  'working',
  'tool_use',
  'reviewing',
  'authenticating',
  'error',
]);

const KNOWN_QUOTA_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['gemini-5h', 'Gemini 5h'],
  ['gemini-weekly', 'Gemini 7d'],
  ['gemini-argon-wtu-weekly', 'Argon 7d'],
  ['3p-5h', 'Claude/GPT 5h'],
  ['3p-weekly', 'Claude/GPT 7d'],
];

const KNOWN_QUOTA_LABEL_MAP: ReadonlyMap<string, string> = new Map(KNOWN_QUOTA_LABELS);

interface QuotaWindowSpec {
  readonly windowSec: number;
  readonly floorSec: number;
  readonly settlingSec: number;
}

export interface QuotaResetInfo {
  readonly remainingSeconds: number | null;
  readonly windowExpired: boolean;
}

export type QuotaEntryLike = QuotaBucketItem | SnapshotQuotaBucket;

function resolveQuotaWindowSpec(bucketKey: string): QuotaWindowSpec | null {
  if (bucketKey.endsWith('-5h')) {
    return { windowSec: WINDOW_5H_SEC, floorSec: SMOOTHING_FLOOR_5H_SEC, settlingSec: SETTLING_ELAPSED_5H_SEC };
  }
  if (bucketKey.endsWith('-weekly') || bucketKey.endsWith('-7d')) {
    return { windowSec: WINDOW_7D_SEC, floorSec: SMOOTHING_FLOOR_7D_SEC, settlingSec: SETTLING_ELAPSED_7D_SEC };
  }
  return null;
}

function isSnapshotQuotaBucket(entry: QuotaEntryLike): entry is SnapshotQuotaBucket {
  return 'remainingFraction' in entry || 'resetTimeSec' in entry || 'resetTimeIso' in entry;
}

export function normalizeHostAgentState(raw: unknown): HostAgentState | null {
  let candidate: string | undefined;
  if (typeof raw === 'string') {
    candidate = raw;
  } else if (isPlainObject(raw)) {
    candidate = nonEmptyStr(raw.state) ?? nonEmptyStr(raw.phase) ?? nonEmptyStr(raw.status);
  }
  const normalized = candidate?.trim().toLowerCase();
  if (normalized === undefined || !VALID_HOST_AGENT_STATES.has(normalized as HostAgentState)) {
    return null;
  }
  return normalized as HostAgentState;
}

export function resolveQuotaReset(entry: QuotaEntryLike, nowSec: number = Date.now() / 1000): QuotaResetInfo {
  if (isSnapshotQuotaBucket(entry)) {
    const resetTs = isFiniteNum(entry.resetTimeSec) ? entry.resetTimeSec : parseIsoTimestampSec(entry.resetTimeIso);
    if (isFiniteNum(resetTs)) {
      const remSec = resetTs - nowSec;
      return { remainingSeconds: remSec, windowExpired: remSec <= 0 };
    }
    return { remainingSeconds: null, windowExpired: false };
  }
  const resetTs = parseIsoTimestampSec(entry.reset_time);
  if (isFiniteNum(resetTs)) {
    const remSec = resetTs - nowSec;
    return { remainingSeconds: remSec, windowExpired: remSec <= 0 };
  }
  const rawSec = entry.reset_in_seconds;
  if (isFiniteNum(rawSec)) {
    return {
      remainingSeconds: rawSec,
      windowExpired: rawSec <= 0,
    };
  }
  return {
    remainingSeconds: null,
    windowExpired: false,
  };
}

export function computeQuotaPace(
  bucketKey: string,
  entry: QuotaEntryLike | undefined,
  nowSec: number = Date.now() / 1000,
): QuotaPaceForecast | null {
  if (!entry || entry.disabled === true) {
    return null;
  }
  const spec = resolveQuotaWindowSpec(bucketKey);
  if (spec === null) {
    return null;
  }
  const rawFrac = isSnapshotQuotaBucket(entry) ? entry.remainingFraction : entry.remaining_fraction;
  if (!isFiniteNum(rawFrac)) {
    return null;
  }
  const { remainingSeconds, windowExpired } = resolveQuotaReset(entry, nowSec);
  if (windowExpired || !isFiniteNum(remainingSeconds) || remainingSeconds <= 0 || remainingSeconds >= spec.windowSec) {
    return null;
  }
  const remainingFraction = Math.max(0, Math.min(1, rawFrac));
  const usedFraction = 1 - remainingFraction;
  if (usedFraction <= 0) {
    return null;
  }
  const elapsedSec = Math.max(0, spec.windowSec - remainingSeconds);
  if (remainingFraction <= 0) {
    return {
      status: 'depleted',
      windowSec: spec.windowSec,
      elapsedSec,
      remainingSec: remainingSeconds,
      usedFraction: 1,
      projectedEndUsed: 1,
      projectedRemainingPct: 0,
      paceRatio: 1,
      etaToZeroSec: 0,
    };
  }

  const effectiveElapsedSec = Math.max(elapsedSec, spec.floorSec);
  const burnRatePerSec = usedFraction / effectiveElapsedSec;
  const projectedEndUsed = usedFraction + burnRatePerSec * remainingSeconds;
  const projectedRemainingPct = Math.round((1 - projectedEndUsed) * 100);
  const etaToZeroSec =
    projectedEndUsed > 1.0 && burnRatePerSec > 0 ? Math.max(0, remainingFraction / burnRatePerSec) : null;

  const isSettling =
    usedFraction < IMMEDIATE_WARN_USED_FRACTION &&
    (elapsedSec < spec.settlingSec || usedFraction < SETTLING_MIN_USED_FRACTION);
  const status = isSettling
    ? 'settling'
    : projectedEndUsed >= DEPLETING_PROJECTION_THRESHOLD
      ? 'depleting'
      : 'on_track';

  return {
    status,
    windowSec: spec.windowSec,
    elapsedSec,
    remainingSec: remainingSeconds,
    usedFraction,
    projectedEndUsed,
    projectedRemainingPct,
    paceRatio: projectedEndUsed,
    etaToZeroSec,
  };
}

export function sanitizeQuotaGroup(
  raw: QuotaBucketGroup | undefined,
  nowSec: number = Date.now() / 1000,
): Record<string, SnapshotQuotaBucket> | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const out: Record<string, SnapshotQuotaBucket> = {};
  let count = 0;
  for (const [rawKey, item] of Object.entries(raw)) {
    if (count >= MAX_ENVELOPE_QUOTA_BUCKETS) break;
    if (UNSAFE_OBJECT_KEYS.has(rawKey) || !isPlainObject(item)) continue;
    const key = sanitizeTerminalLabel(rawKey);
    if (key.length === 0 || UNSAFE_OBJECT_KEYS.has(key)) continue;
    const remainingFraction = isFiniteNum(item.remaining_fraction)
      ? Math.max(0, Math.min(1, item.remaining_fraction))
      : null;
    const rawAmount = item.remaining_amount;
    const remainingAmount =
      typeof rawAmount === 'string' || isFiniteNum(rawAmount) ? sanitizeTerminalLabel(String(rawAmount)) : null;
    const resetTimeIso = nonEmptyStr(item.reset_time) ?? null;
    const isoTs = parseIsoTimestampSec(resetTimeIso);
    const resetTimeSec = isFiniteNum(isoTs)
      ? Math.round(isoTs * 1000) / 1000
      : isFiniteNum(item.reset_in_seconds)
        ? Math.round((nowSec + item.reset_in_seconds) * 1000) / 1000
        : null;
    const disabled = item.disabled === true;
    if (!disabled && remainingFraction === null && (remainingAmount === null || remainingAmount.length === 0)) {
      continue;
    }
    out[key] = {
      remainingFraction,
      remainingAmount: remainingAmount !== null && remainingAmount.length > 0 ? remainingAmount : null,
      resetTimeIso,
      resetTimeSec,
      disabled,
    };
    count += 1;
  }
  return count > 0 ? out : null;
}

export function parseSnapshotQuotaRecord(raw: unknown): Record<string, SnapshotQuotaBucket> | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const out: Record<string, SnapshotQuotaBucket> = {};
  let count = 0;
  for (const [rawKey, entry] of Object.entries(raw)) {
    if (count >= MAX_ENVELOPE_QUOTA_BUCKETS) break;
    if (UNSAFE_OBJECT_KEYS.has(rawKey) || !isPlainObject(entry)) continue;
    const key = sanitizeTerminalLabel(rawKey);
    if (key.length === 0 || UNSAFE_OBJECT_KEYS.has(key)) continue;
    const remainingFraction = isFiniteNum(entry.remainingFraction)
      ? Math.max(0, Math.min(1, entry.remainingFraction))
      : null;
    const remainingAmount =
      typeof entry.remainingAmount === 'string' && entry.remainingAmount.length > 0
        ? sanitizeTerminalLabel(entry.remainingAmount)
        : null;
    const resetTimeIso = nonEmptyStr(entry.resetTimeIso) ?? null;
    const resetTimeSec = isFiniteNum(entry.resetTimeSec) ? Math.round(entry.resetTimeSec * 1000) / 1000 : null;
    const disabled = entry.disabled === true;
    if (!disabled && remainingFraction === null && remainingAmount === null) {
      continue;
    }
    out[key] = {
      remainingFraction,
      remainingAmount,
      resetTimeIso,
      resetTimeSec,
      disabled,
    };
    count += 1;
  }
  return count > 0 ? out : null;
}

function buildResolvedQuotaBucket(
  key: string,
  entry: QuotaEntryLike,
  nowSec: number,
): ResolvedSnapshotQuotaBucket | null {
  if (entry.disabled === true) {
    return null;
  }
  const label = KNOWN_QUOTA_LABEL_MAP.get(key) ?? sanitizeTerminalLabel(key);
  const { remainingSeconds, windowExpired } = resolveQuotaReset(entry, nowSec);
  const rawFrac = isSnapshotQuotaBucket(entry) ? entry.remainingFraction : entry.remaining_fraction;
  const rawAmt = isSnapshotQuotaBucket(entry) ? entry.remainingAmount : entry.remaining_amount;

  if (isFiniteNum(rawFrac)) {
    const remainingPct = windowExpired ? 100 : Math.max(0, Math.min(100, rawFrac * 100));
    const pace = windowExpired ? null : computeQuotaPace(key, entry, nowSec);
    return {
      key,
      label,
      remainingPct,
      remainingAmount: null,
      remainingSeconds: windowExpired ? null : remainingSeconds,
      windowExpired,
      pace,
    };
  }
  if (rawAmt !== undefined && rawAmt !== null) {
    const amtText = sanitizeTerminalLabel(String(rawAmt));
    if (amtText.length === 0) return null;
    return {
      key,
      label,
      remainingPct: null,
      remainingAmount: amtText,
      remainingSeconds: windowExpired ? null : remainingSeconds,
      windowExpired,
      pace: null,
    };
  }
  return null;
}

export function resolveSnapshotQuotaBuckets(
  quota: Record<string, SnapshotQuotaBucket> | QuotaBucketGroup | null | undefined,
  nowSec: number = Date.now() / 1000,
): ResolvedSnapshotQuotaBucket[] {
  if (!isPlainObject(quota)) {
    return [];
  }
  const orderedKeys: string[] = [];
  for (const [knownKey] of KNOWN_QUOTA_LABELS) {
    if (knownKey in quota) orderedKeys.push(knownKey);
  }
  for (const key of Object.keys(quota)) {
    if (!KNOWN_QUOTA_LABEL_MAP.has(key) && !UNSAFE_OBJECT_KEYS.has(key)) {
      orderedKeys.push(key);
    }
  }
  const buckets: ResolvedSnapshotQuotaBucket[] = [];
  for (const key of orderedKeys) {
    const entry = quota[key];
    if (!isPlainObject(entry)) continue;
    const resolved = buildResolvedQuotaBucket(key, entry as QuotaEntryLike, nowSec);
    if (resolved !== null) buckets.push(resolved);
  }
  return buckets;
}
