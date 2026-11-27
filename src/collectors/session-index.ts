import path from 'node:path';

import { isPidAlive } from '../core/file-lock.ts';
import { toComparePath } from '../core/paths.ts';
import { sanitizeTerminalText } from '../core/terminal-text.ts';
import type { SessionRecord, SiblingSessionHint, SnapshotResolutionTier } from '../snapshot-types.ts';
import { findAncestorAgyPid } from './proc.ts';
import { canonicalizeWorkspacePath, discoverSessions, type DiscoverSessionsOptions } from './session-discovery.ts';
import { isExitedCliSession } from './snapshot-envelope.ts';

const MIN_PREFIX_LEN = 4;
const SIBLING_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SIBLING_HINTS = 5;

export type SessionResolutionErrorCode = 'invalid-prefix' | 'ambiguous' | 'not-found' | 'no-sessions';

export class SessionResolutionError extends Error {
  readonly code: SessionResolutionErrorCode;
  readonly candidates: readonly SessionRecord[];

  constructor(code: SessionResolutionErrorCode, message: string, candidates: readonly SessionRecord[] = []) {
    super(message);
    this.name = 'SessionResolutionError';
    this.code = code;
    this.candidates = candidates;
  }
}

export interface ResolveSessionOptions extends DiscoverSessionsOptions {
  session?: string;
  cwd?: string;
  callerAgyPid?: number | null;
}

export interface ResolvedSessionResult {
  session: SessionRecord;
  tier: SnapshotResolutionTier;
  siblings: SiblingSessionHint[];
  sessions: SessionRecord[];
}

function isPathWithin(rootCompare: string, targetCompare: string): boolean {
  if (rootCompare.length === 0) return false;
  if (targetCompare === rootCompare) return true;
  const prefix = rootCompare.endsWith(path.sep) ? rootCompare : `${rootCompare}${path.sep}`;
  return targetCompare.startsWith(prefix);
}

function toSiblingHint(session: SessionRecord): SiblingSessionHint {
  return {
    convId: session.convId,
    shortId: session.shortId,
    title: session.title,
    livePid: session.livePid,
    running: session.running,
    ageLabel: session.ageLabel,
  };
}

function resolveTier0Explicit(query: string, sessions: readonly SessionRecord[]): SessionRecord {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const exact = sessions.find((s) => s.convId === trimmed || s.convId.toLowerCase() === lower);
  if (exact) return exact;

  const safeQuery = sanitizeTerminalText(trimmed);
  if (trimmed.length < MIN_PREFIX_LEN) {
    throw new SessionResolutionError(
      'invalid-prefix',
      `Session prefix "${safeQuery}" must be at least ${MIN_PREFIX_LEN} characters (or pass a full conversation ID).`,
    );
  }
  const matches = sessions.filter((s) => s.convId.toLowerCase().startsWith(lower));
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    const listed = matches.map((s) => `  - ${s.convId} (${s.ageLabel}) "${sanitizeTerminalText(s.title)}"`).join('\n');
    throw new SessionResolutionError(
      'ambiguous',
      `Ambiguous session prefix "${safeQuery}" matched ${matches.length} sessions:\n${listed}`,
      matches,
    );
  }
  throw new SessionResolutionError(
    'not-found',
    `No session matching "${safeQuery}" found. Run "agy-hud snapshot --sessions" to list sessions.`,
  );
}

function resolveTier2Workspace(
  sessions: readonly SessionRecord[],
  callerCwd: string,
  nowMs: number,
): { session: SessionRecord; siblings: SiblingSessionHint[] } | null {
  const callerCompare = toComparePath(canonicalizeWorkspacePath(callerCwd));
  if (callerCompare.length === 0) return null;

  let deepestLen = 0;
  const matched: Array<{ session: SessionRecord; depth: number }> = [];

  for (const session of sessions) {
    if (isExitedCliSession(session)) continue;
    let best = 0;
    for (const ws of session.workspaces) {
      const wsCompare = toComparePath(canonicalizeWorkspacePath(ws));
      if (isPathWithin(wsCompare, callerCompare) && wsCompare.length > best) {
        best = wsCompare.length;
      }
    }
    if (best > 0) {
      matched.push({ session, depth: best });
      if (best > deepestLen) deepestLen = best;
    }
  }

  if (deepestLen === 0) return null;
  const deepest = matched
    .filter((m) => m.depth === deepestLen)
    .map((m) => m.session)
    .sort((a, b) => {
      const runDiff = (b.running ? 1 : 0) - (a.running ? 1 : 0);
      if (runDiff !== 0) return runDiff;
      const timeDiff = b.updatedAtMs - a.updatedAtMs;
      if (timeDiff !== 0) return timeDiff;
      return a.convId.localeCompare(b.convId);
    });

  const winner = deepest[0];
  if (!winner) return null;

  const siblings = deepest
    .slice(1)
    .filter((s) => s.livePid !== null || s.running || nowMs - s.updatedAtMs <= SIBLING_RECENT_WINDOW_MS)
    .slice(0, MAX_SIBLING_HINTS)
    .map(toSiblingHint);

  return { session: winner, siblings };
}

function pickNewestFallbackSession(sessions: readonly SessionRecord[]): SessionRecord | undefined {
  const eligible = sessions.filter((s) => !isExitedCliSession(s));
  const pool = eligible.length > 0 ? eligible : sessions;
  let best: SessionRecord | undefined;
  for (const candidate of pool) {
    if (
      !best ||
      candidate.updatedAtMs > best.updatedAtMs ||
      (candidate.updatedAtMs === best.updatedAtMs &&
        (candidate.running !== best.running ? candidate.running : candidate.convId.localeCompare(best.convId) < 0))
    ) {
      best = candidate;
    }
  }
  return best;
}

export function resolveSession(options: ResolveSessionOptions = {}): ResolvedSessionResult {
  const nowMs = options.nowMs ?? Date.now();
  const checkAlive = options.isAlive ?? isPidAlive;
  const sessions = discoverSessions(options);

  if (options.session !== undefined) {
    const matched = resolveTier0Explicit(options.session, sessions);
    return { session: matched, tier: 'explicit', siblings: [], sessions };
  }

  if (sessions.length === 0) {
    throw new SessionResolutionError('no-sessions', 'No Antigravity sessions found.');
  }

  const callerPid =
    options.callerAgyPid !== undefined ? options.callerAgyPid : findAncestorAgyPid({ isAlive: checkAlive });
  if (callerPid !== null && checkAlive(callerPid)) {
    const byLivePid = sessions.find((s) => s.livePid === callerPid);
    if (byLivePid) {
      return { session: byLivePid, tier: 'pid', siblings: [], sessions };
    }
  }

  const cwd = options.cwd ?? process.cwd();
  const tier2 = resolveTier2Workspace(sessions, cwd, nowMs);
  if (tier2 !== null) {
    return { session: tier2.session, tier: 'workspace', siblings: tier2.siblings, sessions };
  }

  const fallback = pickNewestFallbackSession(sessions);
  if (!fallback) {
    throw new SessionResolutionError('no-sessions', 'No Antigravity sessions found.');
  }
  return { session: fallback, tier: 'fallback', siblings: [], sessions };
}
