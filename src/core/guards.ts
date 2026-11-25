export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export const NODE_RANGE_LABEL: string = '^22.20.0 || >=24.0.0';

const NODE_LTS_MAJOR = 22;
const NODE_LTS_MIN_MINOR = 20;
const NODE_CURRENT_MIN_MAJOR = 24;

export function isSupportedNodeVersion(version: string): boolean {
  const [rawMajor = 0, rawMinor = 0] = String(version)
    .split('.')
    .map((p) => Number.parseInt(p, 10));
  const major = Number.isFinite(rawMajor) ? rawMajor : 0;
  const minor = Number.isFinite(rawMinor) ? rawMinor : 0;
  return (major === NODE_LTS_MAJOR && minor >= NODE_LTS_MIN_MINOR) || major >= NODE_CURRENT_MIN_MAJOR;
}

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
