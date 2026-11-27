import { isDeepStrictEqual } from 'node:util';

import { parseSnapshotCostRecord } from '../core/cost-utils.ts';
import { isFiniteNum, isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { normalizeHostAgentState, parseSnapshotQuotaRecord } from '../core/quota-pace.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import { DEFAULT_MAX_REGULAR_JSON_BYTES, serializeJsonBuffer } from '../fs-utils.ts';
import type { SnapshotEnvelope } from '../snapshot-types.ts';
import type { SubagentStdinItem } from '../types.ts';
import { sanitizeSessionId } from './safe-path.ts';
import { parsePidSwitchSeq } from './snapshot-pid-marker.ts';

export const ENVELOPE_VERSION = 2;
const MAX_ENVELOPE_SUBAGENTS = 128;

export function parseEnvelopeSubagents(raw: unknown): SubagentStdinItem[] {
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

export function fitEnvelopeToByteBudget(
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
  const agentState = normalizeHostAgentState(raw.agentState);
  const toolConfirmationPending = raw.toolConfirmationPending === true;
  const modelDisplayName =
    typeof raw.modelDisplayName === 'string'
      ? (nonEmptyStr(sanitizeTerminalLabel(raw.modelDisplayName)) ?? null)
      : null;
  const nominalContextWindowSize =
    isFiniteNum(raw.nominalContextWindowSize) && raw.nominalContextWindowSize > 0
      ? Math.trunc(raw.nominalContextWindowSize)
      : null;
  const stdinContextUsedPct = isFiniteNum(raw.stdinContextUsedPct)
    ? Math.max(0, Math.min(100, raw.stdinContextUsedPct))
    : null;
  const cost = parseSnapshotCostRecord(raw.cost);
  const quota = parseSnapshotQuotaRecord(raw.quota);
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
    agentState,
    toolConfirmationPending,
    ...(modelDisplayName !== null ? { modelDisplayName } : {}),
    nominalContextWindowSize,
    ...(stdinContextUsedPct !== null ? { stdinContextUsedPct } : {}),
    ...(cost !== null ? { cost } : {}),
    ...(quota !== null ? { quota } : {}),
    mdDigest,
    updatedAtMs,
    heartbeatAtMs,
    ...(pidSwitchSeq > 0 ? { pidSwitchSeq } : {}),
  };
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
    (a.agentState ?? null) === (b.agentState ?? null) &&
    Boolean(a.toolConfirmationPending) === Boolean(b.toolConfirmationPending) &&
    (a.modelDisplayName ?? null) === (b.modelDisplayName ?? null) &&
    (a.nominalContextWindowSize ?? null) === (b.nominalContextWindowSize ?? null) &&
    (a.stdinContextUsedPct ?? null) === (b.stdinContextUsedPct ?? null) &&
    isDeepStrictEqual(a.cost ?? null, b.cost ?? null) &&
    isDeepStrictEqual(a.quota ?? null, b.quota ?? null) &&
    a.mdDigest === b.mdDigest &&
    isDeepStrictEqual(a.subagents, b.subagents)
  );
}
