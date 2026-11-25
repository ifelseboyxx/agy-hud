import { isDeepStrictEqual } from 'node:util';

import { withFileLocksSync } from '../core/file-lock.ts';
import { isFiniteNum, isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import {
  DEFAULT_MAX_REGULAR_JSON_BYTES,
  PRIVATE_FILE_MODE,
  readRegularJsonObjectSync,
  serializeJsonBuffer,
  writeBufferAtomicSync,
  writeJsonAtomicSync,
} from '../fs-utils.ts';
import type { SessionRecord, SessionSurface, SnapshotEnvelope } from '../snapshot-types.ts';
import type { StatusLineData, SubagentStdinItem } from '../types.ts';
import { resolveCliSubdirFile, resolveConversationId, sanitizeSessionId } from './safe-path.ts';
import { SNAPSHOT_TEMP_GRACE_MS, SNAPSHOT_TTL_MS, sweepStaleSnapshotFiles } from './snapshot-cache-sweep.ts';
import {
  isSameActivePidMarker,
  MAX_MARKER_FUTURE_SKEW_MS,
  MAX_PID_SWITCH_SEQ,
  normalizeNowMs,
  parsePidSwitchSeq,
  readActivePidMarker,
  resolvePidLockPath,
  resolvePidMarkerPath,
  resolvePidSwitchContext,
  type ActivePidMarker,
} from './snapshot-pid-marker.ts';

export {
  MAX_MARKER_FUTURE_SKEW_MS,
  readActivePidMarker,
  resolveLivePidOwners,
  resolvePidLockPath,
  type ActivePidMarker,
  type LivePidCandidate,
} from './snapshot-pid-marker.ts';

export { SNAPSHOT_TEMP_GRACE_MS, SNAPSHOT_TTL_MS, sweepStaleSnapshotFiles };

const ENVELOPE_VERSION = 1;
export const ENVELOPE_HEARTBEAT_INTERVAL_MS: number = 30_000;
export const SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS: number = 30;
const MAX_ENVELOPE_SUBAGENTS = 128;

export function resolveSnapshotLockPath(cliHome: string, convId: string): string | null {
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) return null;
  return resolveCliSubdirFile(cliHome, 'cache', `.agy_hud_snapshot_${safeId}.lock`);
}

export interface SnapshotLockPlan {
  readonly normalizedPid: number | null;
  readonly lockPaths: readonly string[];
  readonly holdsPidLock: boolean;
}

export function resolveSnapshotLockPlan(
  cliHome: string,
  convId: string,
  agyPid: number | null,
  options?: { readonly skipSnapshotLock?: boolean; readonly skipPidLock?: boolean },
): SnapshotLockPlan | null {
  const normalizedPid = agyPid !== null && Number.isInteger(agyPid) && agyPid > 1 ? agyPid : null;
  const needSnapshotLock = options?.skipSnapshotLock !== true;
  const snapshotLockPath = needSnapshotLock ? resolveSnapshotLockPath(cliHome, convId) : null;
  if (needSnapshotLock && snapshotLockPath === null) return null;

  const needPidLock = options?.skipPidLock !== true && normalizedPid !== null;
  const pidLockPath = needPidLock ? resolvePidLockPath(cliHome, normalizedPid) : null;
  if (needPidLock && pidLockPath === null) return null;

  const lockPaths = [snapshotLockPath, pidLockPath].filter((p): p is string => p !== null);
  return { normalizedPid, lockPaths, holdsPidLock: pidLockPath !== null };
}

export interface WriteSnapshotEnvelopeOptions {
  mdDigest?: string | null;
  nowMs?: number;
  skipPidLock?: boolean;
  skipSnapshotLock?: boolean;
  baselineEnvelope?: SnapshotEnvelope | null;
  baselinePidMarker?: ActivePidMarker | null;
  rejectSuperseded?: boolean;
}

export function formatRelativeAge(deltaMs: number): string {
  const sec = Math.max(0, Math.floor(deltaMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatSurfaceBadge(surface: SessionSurface): string {
  if (surface === 'cli') return 'CLI';
  if (surface === 'ide') return 'IDE';
  return 'APP';
}

export function isExitedCliProcess(surface: SessionSurface, envPid: number | null, livePid: number | null): boolean {
  return surface === 'cli' && envPid !== null && livePid === null;
}

export function isExitedCliSession(session: Pick<SessionRecord, 'surface' | 'envelope' | 'livePid'>): boolean {
  return isExitedCliProcess(session.surface, session.envelope?.agyPid ?? null, session.livePid);
}

function parseEnvelopeSubagents(raw: unknown): SubagentStdinItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SubagentStdinItem[] = [];
  for (const item of raw) {
    if (items.length >= MAX_ENVELOPE_SUBAGENTS) break;
    if (isPlainObject(item)) {
      items.push(item as SubagentStdinItem);
    }
  }
  return items;
}

function fitEnvelopeToByteBudget(
  envelope: SnapshotEnvelope,
  maxBytes: number = DEFAULT_MAX_REGULAR_JSON_BYTES,
): { envelope: SnapshotEnvelope; buffer: Buffer } | null {
  const initial = serializeJsonBuffer(envelope);
  if (initial.byteLength <= maxBytes) return { envelope, buffer: initial };
  if (envelope.subagents.length === 0) return null;
  let lo = 0;
  let hi = envelope.subagents.length - 1;
  let bestCount = -1;
  let bestBuf: Buffer | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const buf = serializeJsonBuffer({ ...envelope, subagents: envelope.subagents.slice(0, mid) });
    if (buf.byteLength <= maxBytes) {
      bestCount = mid;
      bestBuf = buf;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return bestBuf !== null
    ? { envelope: { ...envelope, subagents: envelope.subagents.slice(0, bestCount) }, buffer: bestBuf }
    : null;
}

export function parseEnvelopeRecord(raw: Record<string, unknown>): SnapshotEnvelope | null {
  if (raw.v !== ENVELOPE_VERSION) return null;
  const convId = typeof raw.convId === 'string' ? sanitizeSessionId(raw.convId) : null;
  if (convId === null) return null;
  const agyPid =
    raw.agyPid === null
      ? null
      : typeof raw.agyPid === 'number' && Number.isSafeInteger(raw.agyPid) && raw.agyPid > 1
        ? raw.agyPid
        : null;
  const taskCount =
    raw.taskCount === null
      ? null
      : isFiniteNum(raw.taskCount) && Number.isInteger(raw.taskCount) && raw.taskCount >= 0
        ? raw.taskCount
        : null;
  const mdDigest = typeof raw.mdDigest === 'string' ? raw.mdDigest : null;
  const updatedAtMs =
    typeof raw.updatedAtMs === 'number' && Number.isSafeInteger(raw.updatedAtMs) && raw.updatedAtMs >= 0
      ? raw.updatedAtMs
      : 0;
  const heartbeatAtMs =
    typeof raw.heartbeatAtMs === 'number' && Number.isSafeInteger(raw.heartbeatAtMs) && raw.heartbeatAtMs >= 0
      ? raw.heartbeatAtMs
      : updatedAtMs;
  const pidSwitchSeq = parsePidSwitchSeq(raw.pidSwitchSeq) ?? 0;

  return {
    v: ENVELOPE_VERSION,
    convId,
    conversationTitle: typeof raw.conversationTitle === 'string' ? sanitizeTerminalLabel(raw.conversationTitle) : '',
    agyPid,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    workspaceCurrentDir: typeof raw.workspaceCurrentDir === 'string' ? raw.workspaceCurrentDir : '',
    workspaceProjectDir: typeof raw.workspaceProjectDir === 'string' ? raw.workspaceProjectDir : '',
    subagents: parseEnvelopeSubagents(raw.subagents),
    taskCount,
    mdDigest,
    updatedAtMs,
    heartbeatAtMs,
    ...(pidSwitchSeq > 0 ? { pidSwitchSeq } : {}),
  };
}

export function readSnapshotEnvelope(cliHome: string, convId: string): SnapshotEnvelope | null {
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) return null;
  const filePath = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_snapshot_${safeId}.json`);
  if (filePath === null) return null;
  const raw = readRegularJsonObjectSync(filePath);
  return raw !== null ? parseEnvelopeRecord(raw) : null;
}

export function isEnvelopeSemanticEqual(a: SnapshotEnvelope, b: SnapshotEnvelope): boolean {
  return (
    a.convId === b.convId &&
    a.conversationTitle === b.conversationTitle &&
    a.agyPid === b.agyPid &&
    a.cwd === b.cwd &&
    a.workspaceCurrentDir === b.workspaceCurrentDir &&
    a.workspaceProjectDir === b.workspaceProjectDir &&
    a.taskCount === b.taskCount &&
    a.mdDigest === b.mdDigest &&
    isDeepStrictEqual(a.subagents, b.subagents)
  );
}

function shouldThrottleEnvelopeWrite(
  existing: SnapshotEnvelope | null,
  candidate: SnapshotEnvelope,
  pidSwitched: boolean,
  nowMs: number,
): boolean {
  if (existing === null || pidSwitched || !isEnvelopeSemanticEqual(existing, candidate)) {
    return false;
  }
  const elapsedMs = nowMs - existing.heartbeatAtMs;
  return elapsedMs >= 0 && elapsedMs < ENVELOPE_HEARTBEAT_INTERVAL_MS;
}

function envelopeWriteTimestampMs(env: SnapshotEnvelope): number {
  return Math.max(env.updatedAtMs, env.heartbeatAtMs);
}

export function isSupersededEnvelopeWrite(
  latestExisting: SnapshotEnvelope,
  nowMs: number,
  baselineEnvelope: SnapshotEnvelope | null | undefined,
): boolean {
  const latestWriteMs = envelopeWriteTimestampMs(latestExisting);
  const maxRecentFutureMs = nowMs + MAX_MARKER_FUTURE_SKEW_MS;
  if (latestWriteMs > nowMs && latestWriteMs <= maxRecentFutureMs) {
    return true;
  }
  if (latestWriteMs === nowMs && baselineEnvelope !== undefined) {
    return !isUnchangedSinceBaseline(latestExisting, baselineEnvelope);
  }
  return false;
}

function isUnchangedSinceBaseline(current: SnapshotEnvelope, baseline: SnapshotEnvelope | null | undefined): boolean {
  return (
    baseline !== undefined &&
    baseline !== null &&
    isEnvelopeSemanticEqual(current, baseline) &&
    envelopeWriteTimestampMs(current) === envelopeWriteTimestampMs(baseline) &&
    (current.pidSwitchSeq ?? 0) === (baseline.pidSwitchSeq ?? 0)
  );
}

export function isVerifiedClockRollbackWrite(
  current: SnapshotEnvelope,
  currentMarker: ActivePidMarker | null,
  convId: string,
  nowMs: number,
  baselineEnvelope: SnapshotEnvelope | null | undefined,
  baselinePidMarker: ActivePidMarker | null | undefined,
): boolean {
  return (
    baselinePidMarker !== undefined &&
    currentMarker !== null &&
    isSameActivePidMarker(currentMarker, baselinePidMarker) &&
    isUnchangedSinceBaseline(current, baselineEnvelope) &&
    (currentMarker.convId === convId || currentMarker.heartbeatAtMs <= nowMs)
  );
}

function isEnvelopeWriteSuperseded(
  current: SnapshotEnvelope | null,
  currentMarker: ActivePidMarker | null,
  convId: string,
  nowMs: number,
  options: WriteSnapshotEnvelopeOptions,
): boolean {
  return (
    options.rejectSuperseded === true &&
    current !== null &&
    isSupersededEnvelopeWrite(current, nowMs, options.baselineEnvelope) &&
    !isVerifiedClockRollbackWrite(
      current,
      currentMarker,
      convId,
      nowMs,
      options.baselineEnvelope,
      options.baselinePidMarker,
    )
  );
}

export function writeSnapshotEnvelope(
  cliHome: string,
  data: StatusLineData,
  agyPid: number | null,
  options: WriteSnapshotEnvelopeOptions = {},
): SnapshotEnvelope | null {
  const convId = resolveConversationId(data);
  if (convId === null) return null;
  const filePath = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`);
  if (filePath === null) return null;

  const lockPlan = resolveSnapshotLockPlan(cliHome, convId, agyPid, options);
  if (lockPlan === null) return null;
  const { normalizedPid, lockPaths } = lockPlan;

  const existing = readSnapshotEnvelope(cliHome, convId);
  const nowMs = normalizeNowMs(options.nowMs);
  const preLockMarker = normalizedPid !== null ? readActivePidMarker(cliHome, normalizedPid, nowMs) : null;
  const taskCount =
    typeof data.task_count === 'number' && Number.isInteger(data.task_count) && data.task_count >= 0
      ? data.task_count
      : null;

  const preLockSeq = existing?.pidSwitchSeq ?? (normalizedPid !== null ? 1 : 0);
  const rawCandidate: SnapshotEnvelope = {
    v: ENVELOPE_VERSION,
    convId,
    conversationTitle: sanitizeTerminalLabel(nonEmptyStr(data.conversation_title) ?? ''),
    agyPid: normalizedPid,
    cwd: nonEmptyStr(data.cwd) ?? '',
    workspaceCurrentDir: nonEmptyStr(data.workspace?.current_dir) ?? '',
    workspaceProjectDir: nonEmptyStr(data.workspace?.project_dir) ?? '',
    subagents: parseEnvelopeSubagents(data.subagents),
    taskCount,
    mdDigest: options.mdDigest !== undefined ? options.mdDigest : (existing?.mdDigest ?? null),
    updatedAtMs: nowMs,
    heartbeatAtMs: nowMs,
    ...(preLockSeq > 0 ? { pidSwitchSeq: preLockSeq } : {}),
  };
  const fittedCandidate = fitEnvelopeToByteBudget(rawCandidate);
  if (fittedCandidate === null) return null;
  const candidate = fittedCandidate.envelope;

  if (isEnvelopeWriteSuperseded(existing, preLockMarker, convId, nowMs, options)) {
    return existing;
  }

  const withinThrottleWindow =
    existing !== null &&
    isEnvelopeSemanticEqual(existing, candidate) &&
    nowMs - existing.heartbeatAtMs >= 0 &&
    nowMs - existing.heartbeatAtMs < ENVELOPE_HEARTBEAT_INTERVAL_MS;
  if (withinThrottleWindow && (normalizedPid === null || (preLockMarker !== null && preLockMarker.convId === convId))) {
    return existing;
  }

  const commitWrite = (): SnapshotEnvelope | null => {
    const latestExisting = readSnapshotEnvelope(cliHome, convId);
    const existingSeq = latestExisting?.pidSwitchSeq ?? 0;
    const lockedSwitch = resolvePidSwitchContext(
      cliHome,
      normalizedPid,
      convId,
      existingSeq,
      nowMs,
      true,
      parseEnvelopeRecord,
    );
    if (isEnvelopeWriteSuperseded(latestExisting, lockedSwitch.marker, convId, nowMs, options)) {
      return latestExisting;
    }

    const latestCandidate: SnapshotEnvelope = {
      ...candidate,
      mdDigest: options.mdDigest !== undefined ? options.mdDigest : (latestExisting?.mdDigest ?? null),
    };
    const effectiveBaselineMarker = options.baselinePidMarker !== undefined ? options.baselinePidMarker : preLockMarker;
    const pidSuperseded =
      options.rejectSuperseded === true &&
      normalizedPid !== null &&
      ((lockedSwitch.marker !== null &&
        lockedSwitch.marker.convId !== convId &&
        (!isSameActivePidMarker(lockedSwitch.marker, effectiveBaselineMarker) ||
          (options.baselinePidMarker === undefined &&
            lockedSwitch.marker.heartbeatAtMs > nowMs &&
            lockedSwitch.marker.heartbeatAtMs <= nowMs + MAX_MARKER_FUTURE_SKEW_MS))) ||
        (lockedSwitch.marker === null &&
          lockedSwitch.other !== null &&
          lockedSwitch.other.hasOther &&
          options.baselinePidMarker !== undefined &&
          lockedSwitch.other.maxOtherSeq > (options.baselinePidMarker?.switchSeq ?? existingSeq)));

    if (
      latestExisting !== null &&
      shouldThrottleEnvelopeWrite(latestExisting, latestCandidate, !pidSuperseded && lockedSwitch.pidSwitched, nowMs)
    ) {
      if (normalizedPid !== null && lockedSwitch.marker === null && !pidSuperseded) {
        const markerPath = resolvePidMarkerPath(cliHome, normalizedPid);
        if (markerPath !== null) {
          writeJsonAtomicSync(
            markerPath,
            { convId, heartbeatAtMs: latestExisting.heartbeatAtMs, switchSeq: Math.max(1, existingSeq) },
            PRIVATE_FILE_MODE,
          );
        }
      }
      return latestExisting;
    }

    const latestUnchanged = latestExisting !== null && isEnvelopeSemanticEqual(latestExisting, latestCandidate);
    let nextSwitchSeq = 0;
    if (normalizedPid !== null) {
      if (pidSuperseded) {
        nextSwitchSeq = existingSeq;
      } else if (lockedSwitch.marker !== null) {
        nextSwitchSeq = lockedSwitch.pidSwitched
          ? Math.min(MAX_PID_SWITCH_SEQ - 1, Math.max(lockedSwitch.marker.switchSeq, existingSeq) + 1)
          : Math.max(lockedSwitch.marker.switchSeq, existingSeq);
      } else if (
        lockedSwitch.other !== null &&
        lockedSwitch.other.hasOther &&
        lockedSwitch.other.maxOtherSeq >= existingSeq
      ) {
        nextSwitchSeq = Math.min(MAX_PID_SWITCH_SEQ - 1, lockedSwitch.other.maxOtherSeq + 1);
      } else {
        nextSwitchSeq = Math.max(1, existingSeq);
      }
    }

    const envelope: SnapshotEnvelope = {
      ...latestCandidate,
      updatedAtMs: latestUnchanged ? latestExisting.updatedAtMs : nowMs,
      heartbeatAtMs: nowMs,
      ...(nextSwitchSeq > 0 ? { pidSwitchSeq: nextSwitchSeq } : {}),
    };

    const fitted = fitEnvelopeToByteBudget(envelope);
    if (fitted === null) return null;
    writeBufferAtomicSync(filePath, fitted.buffer, PRIVATE_FILE_MODE);
    if (normalizedPid !== null && !pidSuperseded) {
      const markerPath = resolvePidMarkerPath(cliHome, normalizedPid);
      if (markerPath !== null) {
        writeJsonAtomicSync(
          markerPath,
          { convId, heartbeatAtMs: fitted.envelope.heartbeatAtMs, switchSeq: nextSwitchSeq },
          PRIVATE_FILE_MODE,
        );
      }
    }
    if (latestExisting === null || nowMs - latestExisting.heartbeatAtMs >= ENVELOPE_HEARTBEAT_INTERVAL_MS) {
      sweepStaleSnapshotFiles(cliHome, nowMs, convId);
    }
    return fitted.envelope;
  };

  try {
    if (lockPaths.length > 0) {
      return withFileLocksSync(lockPaths, commitWrite, SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS);
    }
    return commitWrite();
  } catch {
    return null;
  }
}
