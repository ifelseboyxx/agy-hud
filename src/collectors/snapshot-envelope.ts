/* @host-contract
 * CLI session envelope persistence and live-PID ownership markers (docs/host-contracts.md §4):
 * - Envelopes (`agy_hud_snapshot_<id>.json`, <= 512 KiB, 0o600) bridge CLI metadata (PID, title, cost) to snapshot commands.
 * - Monotonic `pidSwitchSeq` + `ActivePidMarker` disambiguate `/resume` switches within one `agy` PID and clock rollbacks.
 */
import { resolveSessionCost } from '../core/cost-utils.ts';
import { withFileLocksSync } from '../core/file-lock.ts';
import { formatRelativeAge, isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { normalizeHostAgentState, sanitizeQuotaGroup } from '../core/quota-pace.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import {
  PRIVATE_FILE_MODE,
  readRegularJsonObjectSync,
  writeBufferAtomicSync,
  writeJsonAtomicSync,
} from '../fs-utils.ts';
import type { SessionRecord, SnapshotEnvelope } from '../snapshot-types.ts';
import type { StatusLineData } from '../types.ts';
import { resolveCliSubdirFile, resolveConversationId, sanitizeSessionId } from './safe-path.ts';
import { SNAPSHOT_TTL_MS, sweepStaleSnapshotFiles } from './snapshot-cache-sweep.ts';
import {
  ENVELOPE_VERSION,
  fitEnvelopeToByteBudget,
  isEnvelopeSemanticEqual,
  parseEnvelopeRecord,
  parseEnvelopeSubagents,
} from './snapshot-envelope-codec.ts';
import {
  isSameActivePidMarker,
  MAX_MARKER_FUTURE_SKEW_MS,
  MAX_PID_SWITCH_SEQ,
  normalizeNowMs,
  readActivePidMarker,
  resolvePidLockPath,
  resolvePidMarkerPath,
  resolvePidSwitchContext,
  type ActivePidMarker,
} from './snapshot-pid-marker.ts';

export {
  readActivePidMarker,
  resolveLivePidOwners,
  type ActivePidMarker,
  type LivePidCandidate,
} from './snapshot-pid-marker.ts';

export { parseEnvelopeRecord, SNAPSHOT_TTL_MS, sweepStaleSnapshotFiles };

const ENVELOPE_HEARTBEAT_INTERVAL_MS: number = 30_000;
export const SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS: number = 30;

function resolveSnapshotLockPath(cliHome: string, convId: string): string | null {
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

export { formatRelativeAge };

export function isExitedCliProcess(envPid: number | null, livePid: number | null): boolean {
  return envPid !== null && livePid === null;
}

export function isExitedCliSession(session: Pick<SessionRecord, 'envelope' | 'livePid'>): boolean {
  return isExitedCliProcess(session.envelope?.agyPid ?? null, session.livePid);
}

export function readSnapshotEnvelope(cliHome: string, convId: string): SnapshotEnvelope | null {
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) return null;
  const filePath = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_snapshot_${safeId}.json`);
  if (filePath === null) return null;
  const raw = readRegularJsonObjectSync(filePath);
  return raw !== null ? parseEnvelopeRecord(raw) : null;
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

function isSupersededEnvelopeWrite(
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

function isVerifiedClockRollbackWrite(
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

export function isEnvelopeWriteSuperseded(
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

  const agentState = normalizeHostAgentState(data.agent_state);
  const toolConfirmationPending = data.tool_confirmation_pending === true;
  const rawModelDisplay = nonEmptyStr(data.model?.display_name) ?? nonEmptyStr(data.model?.id);
  const modelDisplayName =
    rawModelDisplay !== undefined ? (nonEmptyStr(sanitizeTerminalLabel(rawModelDisplay)) ?? null) : null;
  const rawWinSize = data.context_window?.context_window_size;
  const nominalContextWindowSize = isFiniteNum(rawWinSize) && rawWinSize > 0 ? Math.trunc(rawWinSize) : null;
  const rawUsedPct = data.context_window?.used_percentage;
  const stdinContextUsedPct = isFiniteNum(rawUsedPct) ? Math.max(0, Math.min(100, rawUsedPct)) : null;
  const cost = resolveSessionCost(data.cost);
  const quota = sanitizeQuotaGroup(data.quota, nowMs / 1000);
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
    agentState,
    toolConfirmationPending,
    ...(modelDisplayName !== null ? { modelDisplayName } : {}),
    nominalContextWindowSize,
    ...(stdinContextUsedPct !== null ? { stdinContextUsedPct } : {}),
    ...(cost !== null ? { cost } : {}),
    ...(quota !== null ? { quota } : {}),
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
          try {
            writeJsonAtomicSync(
              markerPath,
              { convId, heartbeatAtMs: latestExisting.heartbeatAtMs, switchSeq: Math.max(1, existingSeq) },
              PRIVATE_FILE_MODE,
            );
          } catch {
            // Best-effort PID marker update must not negate a valid envelope.
          }
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
        try {
          writeJsonAtomicSync(
            markerPath,
            { convId, heartbeatAtMs: fitted.envelope.heartbeatAtMs, switchSeq: nextSwitchSeq },
            PRIVATE_FILE_MODE,
          );
        } catch {
          // Envelope is already durably committed; keep mdDigest synchronized by returning it.
        }
      }
    }
    if (latestExisting === null || nowMs - latestExisting.heartbeatAtMs >= ENVELOPE_HEARTBEAT_INTERVAL_MS) {
      try {
        sweepStaleSnapshotFiles(cliHome, nowMs, convId);
      } catch {
        // Best-effort stale sweep must not report envelope persistence as failed.
      }
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
