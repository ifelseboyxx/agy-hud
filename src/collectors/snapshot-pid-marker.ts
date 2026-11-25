import { readdirSync } from 'node:fs';
import path from 'node:path';

import { isFiniteNum } from '../core/guards.ts';
import { readRegularJsonObjectSync } from '../fs-utils.ts';
import type { SessionSurface, SnapshotEnvelope } from '../snapshot-types.ts';
import { resolveCliSubdirFile, resolveTrustedCliDir, sanitizeSessionId } from './safe-path.ts';

export const MAX_MARKER_FUTURE_SKEW_MS: number = 5 * 60 * 1000;
export const MAX_PID_SWITCH_SEQ: number = 1_000_000_000;
const SNAPSHOT_ENVELOPE_FILE_RE = /^agy_hud_snapshot_.+\.json$/;

export interface ActivePidMarker {
  convId: string;
  heartbeatAtMs: number;
  switchSeq: number;
}

export interface LivePidCandidate {
  convId: string;
  surface: SessionSurface;
  envelope: SnapshotEnvelope | null;
}

export interface PidSwitchContext {
  readonly marker: ActivePidMarker | null;
  readonly other: { maxOtherSeq: number; hasOther: boolean } | null;
  readonly pidSwitched: boolean;
}

export function resolvePidMarkerPath(cliHome: string, agyPid: number): string | null {
  return resolveCliSubdirFile(cliHome, 'cache', `agy_hud_pid_${agyPid}.json`);
}

export function resolvePidLockPath(cliHome: string, agyPid: number): string | null {
  if (!Number.isInteger(agyPid) || agyPid <= 1) return null;
  return resolveCliSubdirFile(cliHome, 'cache', `.agy_hud_pid_${agyPid}.lock`);
}

export function parsePidSwitchSeq(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw >= MAX_PID_SWITCH_SEQ) {
    return null;
  }
  return raw;
}

export function normalizeNowMs(nowMs: number | undefined): number {
  return isFiniteNum(nowMs) && nowMs > 0 ? Math.trunc(nowMs) : Date.now();
}

export function isSameActivePidMarker(a: ActivePidMarker | null, b: ActivePidMarker | null): boolean {
  if (a === null || b === null) return a === b;
  return a.convId === b.convId && a.switchSeq === b.switchSeq && a.heartbeatAtMs === b.heartbeatAtMs;
}

export function readActivePidMarker(
  cliHome: string,
  agyPid: number,
  nowMs: number = Date.now(),
): ActivePidMarker | null {
  const markerPath = resolvePidMarkerPath(cliHome, agyPid);
  if (markerPath === null) return null;
  const raw = readRegularJsonObjectSync(markerPath);
  if (raw === null || typeof raw.convId !== 'string' || typeof raw.heartbeatAtMs !== 'number') {
    return null;
  }
  const safeNowMs = normalizeNowMs(nowMs);
  if (
    !Number.isSafeInteger(raw.heartbeatAtMs) ||
    raw.heartbeatAtMs <= 0 ||
    raw.heartbeatAtMs > safeNowMs + MAX_MARKER_FUTURE_SKEW_MS
  ) {
    return null;
  }
  const switchSeq = parsePidSwitchSeq(raw.switchSeq);
  if (switchSeq === null) return null;
  const safeId = sanitizeSessionId(raw.convId);
  return safeId !== null ? { convId: safeId, heartbeatAtMs: raw.heartbeatAtMs, switchSeq } : null;
}

function scanOtherPidEnvelopes(
  cliHome: string,
  agyPid: number,
  excludeConvId: string,
  nowMs: number,
  parseEnvelope: (raw: Record<string, unknown>) => SnapshotEnvelope | null,
): { maxOtherSeq: number; hasOther: boolean } {
  const cacheDir = resolveTrustedCliDir(cliHome, 'cache');
  if (cacheDir === null) return { maxOtherSeq: 0, hasOther: false };
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return { maxOtherSeq: 0, hasOther: false };
  }
  const excludeName = `agy_hud_snapshot_${excludeConvId}.json`;
  const maxAllowedHeartbeatMs = nowMs + MAX_MARKER_FUTURE_SKEW_MS;
  let maxOtherSeq = 0;
  let hasOther = false;
  for (const name of entries) {
    if (name === excludeName || !SNAPSHOT_ENVELOPE_FILE_RE.test(name)) continue;
    const raw = readRegularJsonObjectSync(path.join(cacheDir, name));
    const parsed = raw !== null ? parseEnvelope(raw) : null;
    if (parsed === null || parsed.agyPid !== agyPid || parsed.heartbeatAtMs > maxAllowedHeartbeatMs) continue;
    hasOther = true;
    const seq = parsed.pidSwitchSeq ?? 0;
    if (seq > maxOtherSeq) maxOtherSeq = seq;
  }
  return { maxOtherSeq, hasOther };
}

export function resolvePidSwitchContext(
  cliHome: string,
  normalizedPid: number | null,
  convId: string,
  existingSeq: number,
  nowMs: number,
  scanWhenMissing: boolean,
  parseEnvelope: (raw: Record<string, unknown>) => SnapshotEnvelope | null,
): PidSwitchContext {
  if (normalizedPid === null) {
    return { marker: null, other: null, pidSwitched: false };
  }
  const marker = readActivePidMarker(cliHome, normalizedPid, nowMs);
  if (marker !== null) {
    return { marker, other: null, pidSwitched: marker.convId !== convId };
  }
  if (!scanWhenMissing) {
    return { marker: null, other: null, pidSwitched: false };
  }
  const other = scanOtherPidEnvelopes(cliHome, normalizedPid, convId, nowMs, parseEnvelope);
  return { marker: null, other, pidSwitched: other.hasOther && other.maxOtherSeq >= existingSeq };
}

export function resolveLivePidOwners(
  cliHome: string,
  candidates: Iterable<LivePidCandidate>,
  nowMs: number,
  checkAlive: (pid: number) => boolean,
): Map<number, string> {
  const safeNowMs = normalizeNowMs(nowMs);
  const maxAllowedHeartbeatMs = safeNowMs + MAX_MARKER_FUTURE_SKEW_MS;
  const byConvId = new Map<string, LivePidCandidate>();
  const newestByLivePid = new Map<
    number,
    { convId: string; heartbeatAtMs: number; updatedAtMs: number; pidSwitchSeq: number }
  >();
  for (const acc of candidates) {
    byConvId.set(acc.convId, acc);
    if (acc.surface !== 'cli' || acc.envelope === null || acc.envelope.agyPid === null) continue;
    if (acc.envelope.heartbeatAtMs > maxAllowedHeartbeatMs) continue;
    const pid = acc.envelope.agyPid;
    if (!checkAlive(pid)) continue;
    const cur = newestByLivePid.get(pid);
    const seq = acc.envelope.pidSwitchSeq ?? 0;
    const isNewer =
      !cur ||
      seq > cur.pidSwitchSeq ||
      (seq === cur.pidSwitchSeq &&
        (acc.envelope.heartbeatAtMs !== cur.heartbeatAtMs
          ? acc.envelope.heartbeatAtMs > cur.heartbeatAtMs
          : acc.envelope.updatedAtMs > cur.updatedAtMs));
    if (isNewer) {
      newestByLivePid.set(pid, {
        convId: acc.convId,
        heartbeatAtMs: acc.envelope.heartbeatAtMs,
        updatedAtMs: acc.envelope.updatedAtMs,
        pidSwitchSeq: seq,
      });
    }
  }
  for (const [pid, cur] of newestByLivePid) {
    const marker = readActivePidMarker(cliHome, pid, safeNowMs);
    if (marker === null || marker.convId === cur.convId) continue;
    const marked = byConvId.get(marker.convId);
    const markerWins =
      marker.switchSeq > cur.pidSwitchSeq ||
      (marker.switchSeq === cur.pidSwitchSeq && marker.heartbeatAtMs >= cur.heartbeatAtMs);
    if (
      marked &&
      marked.surface === 'cli' &&
      marked.envelope?.agyPid === pid &&
      marked.envelope.heartbeatAtMs <= maxAllowedHeartbeatMs &&
      markerWins
    ) {
      newestByLivePid.set(pid, {
        convId: marked.convId,
        heartbeatAtMs: Math.max(marked.envelope.heartbeatAtMs, marker.heartbeatAtMs),
        updatedAtMs: marked.envelope.updatedAtMs,
        pidSwitchSeq: Math.max(marked.envelope.pidSwitchSeq ?? 0, marker.switchSeq),
      });
    }
  }
  const owners = new Map<number, string>();
  for (const [pid, info] of newestByLivePid) {
    owners.set(pid, info.convId);
  }
  return owners;
}
