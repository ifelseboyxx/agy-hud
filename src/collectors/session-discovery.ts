/* @host-contract
 * CLI session discovery under `cliHome` (docs/host-contracts.md §2):
 * - Scans `conversation_summaries.db` (strictly read-only), `brain/<id>`, `conversations/<id>.db`, and snapshot envelopes.
 * - Excludes subagents (`nesting_depth > 0`), `killed != 0`, and exited CLI PIDs.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { SNAPSHOT_ENVELOPE_FILE_RE } from '../core/cache-registry.ts';
import { isPidAlive } from '../core/file-lock.ts';
import {
  lstatIfPresentSync,
  readRegularJsonObjectSync,
  realpathExistingPrefixSync,
  statIfPresentSync,
} from '../core/fs-utils.ts';
import { formatRelativeAge, isPlainObject } from '../core/guards.ts';
import { resolveCliHome, toComparePath } from '../core/paths.ts';
import { resolveCliSubdirFile, resolveTrustedCliDir, sanitizeSessionId } from '../core/safe-path.ts';
import { normalizeHostAgentState, resolveTurnPhase } from '../core/telemetry-error.ts';
import type { SessionRecord, SnapshotEnvelope } from '../snapshot-types.ts';
import { RUNNING_STEP_STATUSES } from './activity-parse.ts';
import { readTailLines } from './agents.ts';
import { loadSummaryDbSnapshot } from './session-summary-db.ts';
import { parseEnvelopeRecord } from './snapshot-envelope-codec.ts';
import { isExitedCliProcess, isExitedCliSession } from './snapshot-envelope.ts';
import { resolveLivePidOwners } from './snapshot-pid-marker.ts';
import { readSessionTailPhaseFallback } from './step-timing.ts';

const MAX_LIST_SQLITE_PHASE_PROBES = 8;
const ACTIVE_SUBAGENT_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'working',
  'in_progress',
  'active',
  'waiting',
  'pending',
  'idle',
]);

export interface DiscoverSessionsOptions {
  cliHome?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  isAlive?: (pid: number) => boolean;
}

interface CandidateAccumulator {
  convId: string;
  dataRoot: string;
  title: string;
  workspaces: string[];
  workspacesSeen: Set<string>;
  running: boolean;
  summaryModifiedMs: number;
  envelope: SnapshotEnvelope | null;
}

function createEmptyCandidate(convId: string, cliHome: string): CandidateAccumulator {
  return {
    convId,
    dataRoot: cliHome,
    title: '',
    workspaces: [],
    workspacesSeen: new Set<string>(),
    running: false,
    summaryModifiedMs: 0,
    envelope: null,
  };
}

function hasPhysicalSessionFiles(rootDir: string, convId: string): boolean {
  const brainDir = path.join(rootDir, 'brain', convId);
  const dbFile = path.join(rootDir, 'conversations', `${convId}.db`);
  return existsSync(brainDir) || existsSync(dbFile);
}

export function canonicalizeWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return '';
  return realpathExistingPrefixSync(trimmed);
}

function addWorkspacePath(acc: CandidateAccumulator, rawPath: string): void {
  const canon = canonicalizeWorkspacePath(rawPath);
  if (canon.length === 0) return;
  const key = toComparePath(canon);
  if (!acc.workspacesSeen.has(key)) {
    acc.workspacesSeen.add(key);
    acc.workspaces.push(canon);
  }
}

function probeTranscriptState(rootDir: string, convId: string): { mtimeMs: number; running: boolean } {
  const tPath = resolveCliSubdirFile(rootDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (tPath !== null && existsSync(tPath)) {
    const st = statIfPresentSync(tPath);
    const mtimeMs = st?.isFile() ? st.mtimeMs : 0;
    let running = false;
    const tail = readTailLines(tPath, 8192);
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      const line = tail[i];
      if (!line) continue;
      let step: unknown;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainObject(step) || step.type !== 'PLANNER_RESPONSE') continue;
      const status = typeof step.status === 'string' ? step.status.toUpperCase() : '';
      running = RUNNING_STEP_STATUSES.has(status);
      break;
    }
    return { mtimeMs, running };
  }
  const dbPath = resolveCliSubdirFile(rootDir, 'conversations', `${convId}.db`);
  if (dbPath !== null && existsSync(dbPath)) {
    const st = statIfPresentSync(dbPath);
    return { mtimeMs: st?.isFile() ? st.mtimeMs : 0, running: false };
  }
  return { mtimeMs: 0, running: false };
}

function envelopeHasActiveSubagent(envelope: SnapshotEnvelope | null): boolean {
  if (envelope === null) return false;
  return envelope.subagents.some((sa) => {
    const raw = (sa.status ?? sa.state ?? '').trim().toLowerCase();
    return ACTIVE_SUBAGENT_STATUSES.has(raw);
  });
}

function scanSummaryDatabase(
  cliHome: string,
  candidates: Map<string, CandidateAccumulator>,
  excludedIds: Set<string>,
): void {
  const snap = loadSummaryDbSnapshot(cliHome);
  if (snap === null) return;
  for (const safe of snap.excludedIds) {
    excludedIds.add(safe);
    candidates.delete(safe);
  }
  for (const row of snap.rows) {
    if (excludedIds.has(row.safeId) || !hasPhysicalSessionFiles(cliHome, row.safeId)) continue;
    if (candidates.has(row.safeId)) continue;
    const acc = createEmptyCandidate(row.safeId, cliHome);
    acc.title = row.title;
    acc.running = row.isRunning;
    acc.summaryModifiedMs = row.summaryMs;
    candidates.set(row.safeId, acc);
    for (const ws of row.workspaces) addWorkspacePath(acc, ws);
  }
}

function scanSnapshotEnvelopes(
  cliHome: string,
  candidates: Map<string, CandidateAccumulator>,
  excludedIds: ReadonlySet<string>,
): void {
  const cacheDir = resolveTrustedCliDir(cliHome, 'cache');
  if (cacheDir === null) return;
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!SNAPSHOT_ENVELOPE_FILE_RE.test(name)) continue;
    const fullPath = path.join(cacheDir, name);
    const raw = readRegularJsonObjectSync(fullPath);
    if (raw === null) continue;
    const env = parseEnvelopeRecord(raw);
    if (env === null || excludedIds.has(env.convId)) continue;

    let acc = candidates.get(env.convId);
    if (!acc) {
      acc = createEmptyCandidate(env.convId, cliHome);
      acc.title = env.conversationTitle;
      acc.envelope = env;
      candidates.set(env.convId, acc);
    } else {
      if (!acc.envelope || env.heartbeatAtMs >= acc.envelope.heartbeatAtMs) {
        acc.envelope = env;
      }
      if (env.conversationTitle.length > 0 && acc.title.length === 0) {
        acc.title = env.conversationTitle;
      }
    }

    addWorkspacePath(acc, env.workspaceCurrentDir);
    addWorkspacePath(acc, env.workspaceProjectDir);
    addWorkspacePath(acc, env.cwd);
  }
}

function scanColdBrainDirectories(
  cliHome: string,
  candidates: Map<string, CandidateAccumulator>,
  excludedIds: ReadonlySet<string>,
): void {
  const brainDir = resolveTrustedCliDir(cliHome, 'brain');
  if (brainDir === null) return;
  let entries: string[];
  try {
    entries = readdirSync(brainDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const safeId = sanitizeSessionId(name);
    if (safeId === null || candidates.has(safeId) || excludedIds.has(safeId)) continue;
    const hasTranscript = existsSync(path.join(brainDir, safeId, '.system_generated', 'logs', 'transcript.jsonl'));
    const hasDb = existsSync(path.join(cliHome, 'conversations', `${safeId}.db`));
    if (!hasTranscript && !hasDb) continue;
    candidates.set(safeId, createEmptyCandidate(safeId, cliHome));
  }
}

function scanColdConversationDbs(
  cliHome: string,
  candidates: Map<string, CandidateAccumulator>,
  excludedIds: ReadonlySet<string>,
): void {
  const convDir = resolveTrustedCliDir(cliHome, 'conversations');
  if (convDir === null) return;
  let entries: string[];
  try {
    entries = readdirSync(convDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const safeId = sanitizeSessionId(name.slice(0, -3));
    if (safeId === null || candidates.has(safeId) || excludedIds.has(safeId)) continue;
    const fullPath = path.join(convDir, name);
    const st = lstatIfPresentSync(fullPath);
    if (st === null || st.isSymbolicLink() || !st.isFile()) continue;
    candidates.set(safeId, createEmptyCandidate(safeId, cliHome));
  }
}

function compareSessionsDefault(a: SessionRecord, b: SessionRecord): number {
  const liveDiff = (!isExitedCliSession(b) ? 1 : 0) - (!isExitedCliSession(a) ? 1 : 0);
  if (liveDiff !== 0) return liveDiff;
  const runDiff = (b.running ? 1 : 0) - (a.running ? 1 : 0);
  if (runDiff !== 0) return runDiff;
  const timeDiff = b.updatedAtMs - a.updatedAtMs;
  if (timeDiff !== 0) return timeDiff;
  return a.convId.localeCompare(b.convId);
}

export function discoverSessions(options: DiscoverSessionsOptions = {}): SessionRecord[] {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const checkAlive = options.isAlive ?? isPidAlive;
  const cliHome = resolveCliHome(options.cliHome, env);

  const candidates = new Map<string, CandidateAccumulator>();
  const excludedIds = new Set<string>();
  scanSummaryDatabase(cliHome, candidates, excludedIds);
  scanColdBrainDirectories(cliHome, candidates, excludedIds);
  scanColdConversationDbs(cliHome, candidates, excludedIds);
  scanSnapshotEnvelopes(cliHome, candidates, excludedIds);

  const livePidOwners = resolveLivePidOwners(cliHome, candidates.values(), nowMs, checkAlive);

  const sessions: SessionRecord[] = [];
  for (const acc of candidates.values()) {
    const probe = probeTranscriptState(acc.dataRoot, acc.convId);
    const envPid = acc.envelope?.agyPid ?? null;
    const livePid = envPid !== null && livePidOwners.get(envPid) === acc.convId ? envPid : null;
    const isExitedCli = isExitedCliProcess(envPid, livePid);
    const updatedAtMs = Math.max(acc.envelope?.updatedAtMs ?? 0, probe.mtimeMs, acc.summaryModifiedMs);
    const running = isExitedCli
      ? false
      : acc.running || probe.running || (livePid !== null && envelopeHasActiveSubagent(acc.envelope));
    const title = acc.title.length > 0 ? acc.title : `Session ${acc.convId.slice(0, 8)}`;
    const turnPhase = resolveTurnPhase({
      isExitedCli,
      hasLiveHostState: livePid !== null && acc.envelope !== null,
      toolConfirmationPending: acc.envelope?.toolConfirmationPending,
      agentState: acc.envelope?.agentState,
    });

    sessions.push({
      convId: acc.convId,
      shortId: acc.convId.slice(0, 8),
      title,
      workspace: acc.workspaces[0] ?? '',
      workspaces: acc.workspaces,
      dataRoot: acc.dataRoot,
      running,
      livePid,
      hasEnvelope: acc.envelope !== null,
      envelope: acc.envelope,
      updatedAtMs,
      ageLabel: updatedAtMs > 0 ? formatRelativeAge(nowMs - updatedAtMs) : 'unknown',
      turnPhase,
    });
  }

  sessions.sort(compareSessionsDefault);
  let sqlitePhaseProbes = 0;
  for (const session of sessions) {
    if (sqlitePhaseProbes >= MAX_LIST_SQLITE_PHASE_PROBES) break;
    if (isExitedCliSession(session)) continue;
    const hasExplicitHostPhase =
      session.livePid !== null &&
      session.envelope !== null &&
      (session.envelope.toolConfirmationPending === true ||
        normalizeHostAgentState(session.envelope.agentState) !== null);
    if (hasExplicitHostPhase) continue;
    sqlitePhaseProbes += 1;
    const fallback = readSessionTailPhaseFallback(session.dataRoot, cliHome, session.convId);
    session.turnPhase = resolveTurnPhase({
      isExitedCli: false,
      hasLiveHostState: session.livePid !== null && session.envelope !== null,
      toolConfirmationPending: session.envelope?.toolConfirmationPending,
      agentState: session.envelope?.agentState,
      tailStepPhase: fallback.tailStepPhase,
      lastErrorCode: fallback.lastErrorCode,
    });
  }
  return sessions;
}
