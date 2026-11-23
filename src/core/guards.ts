export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function nonEmptyStr(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseIsoTimestampSec(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export function getErrCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}
