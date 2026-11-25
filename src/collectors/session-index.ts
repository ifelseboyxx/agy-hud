import path from 'node:path';

import { isPidAlive } from '../core/file-lock.ts';
import { toComparePath } from '../core/paths.ts';
import type {
  SessionRecord,
  SessionSourceFilter,
  SessionSurface,
  SiblingSessionHint,
  SnapshotResolutionTier,
} from '../snapshot-types.ts';
import { findAncestorAgyPid } from './proc.ts';
import { canonicalizeWorkspacePath, discoverSessions, type DiscoverSessionsOptions } from './session-discovery.ts';
import { formatSurfaceBadge, isExitedCliSession } from './snapshot-envelope.ts';

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
  source?: SessionSourceFilter;
  cwd?: string;
  callerAgyPid?: number | null;
}

export interface ResolvedSessionResult {
  session: SessionRecord;
  tier: SnapshotResolutionTier;
  siblings: SiblingSessionHint[];
  sessions: SessionRecord[];
}

export function matchesSourceFilter(surface: SessionSurface, source: SessionSourceFilter): boolean {
  if (source === 'cli') return surface === 'cli';
  if (source === 'app') return surface === 'app' || surface === 'ide';
  return true;
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
    surface: session.surface,
    title: session.title,
    livePid: session.livePid,
    running: session.running,
    ageLabel: session.ageLabel,
  };
}

function resolveTier0Explicit(
  query: string,
  filtered: readonly SessionRecord[],
  source: SessionSourceFilter,
): SessionRecord {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const exact = filtered.find((s) => s.convId === trimmed || s.convId.toLowerCase() === lower);
  if (exact) return exact;

  if (trimmed.length < MIN_PREFIX_LEN) {
    throw new SessionResolutionError(
      'invalid-prefix',
      `Session prefix "${trimmed}" must be at least ${MIN_PREFIX_LEN} characters (or pass a full conversation ID).`,
    );
  }
  const matches = filtered.filter((s) => s.convId.toLowerCase().startsWith(lower));
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    const listed = matches
      .map((s) => `  - [${formatSurfaceBadge(s.surface)}] ${s.convId} (${s.ageLabel}) "${s.title}"`)
      .join('\n');
    throw new SessionResolutionError(
      'ambiguous',
      `Ambiguous session prefix "${trimmed}" matched ${matches.length} sessions:\n${listed}`,
      matches,
    );
  }
  throw new SessionResolutionError(
    'not-found',
    `No session matching "${trimmed}" found (source: ${source}). Run "agy-hud snapshot --sessions" to list sessions.`,
  );
}

function resolveTier2Workspace(
  filtered: readonly SessionRecord[],
  callerCwd: string,
  nowMs: number,
): { session: SessionRecord; siblings: SiblingSessionHint[] } | null {
  const callerCompare = toComparePath(canonicalizeWorkspacePath(callerCwd));
  if (callerCompare.length === 0) return null;

  let deepestLen = 0;
  const matched: Array<{ session: SessionRecord; depth: number }> = [];

  for (const session of filtered) {
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

export function resolveSession(options: ResolveSessionOptions = {}): ResolvedSessionResult {
  const source = options.source ?? 'auto';
  const nowMs = options.nowMs ?? Date.now();
  const checkAlive = options.isAlive ?? isPidAlive;
  const allSessions = discoverSessions(options);
  const filtered = allSessions.filter((s) => matchesSourceFilter(s.surface, source));

  if (options.session !== undefined) {
    const matched = resolveTier0Explicit(options.session, filtered, source);
    return { session: matched, tier: 'explicit', siblings: [], sessions: filtered };
  }

  if (filtered.length === 0) {
    throw new SessionResolutionError('no-sessions', `No Antigravity sessions found (source: ${source}).`);
  }

  if (source === 'auto' || source === 'cli') {
    const callerPid =
      options.callerAgyPid !== undefined ? options.callerAgyPid : findAncestorAgyPid({ isAlive: checkAlive });
    if (callerPid !== null && checkAlive(callerPid)) {
      const byLivePid = filtered.find((s) => s.surface === 'cli' && s.livePid === callerPid);
      if (byLivePid) {
        return { session: byLivePid, tier: 'pid', siblings: [], sessions: filtered };
      }
    }
  }

  const cwd = options.cwd ?? process.cwd();
  const tier2 = resolveTier2Workspace(filtered, cwd, nowMs);
  if (tier2 !== null) {
    return { session: tier2.session, tier: 'workspace', siblings: tier2.siblings, sessions: filtered };
  }

  const fallback = filtered.find((s) => !isExitedCliSession(s)) ?? filtered[0];
  if (!fallback) {
    throw new SessionResolutionError('no-sessions', `No Antigravity sessions found (source: ${source}).`);
  }
  return { session: fallback, tier: 'fallback', siblings: [], sessions: filtered };
}
