import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPidAlive } from '../core/file-lock.ts';
import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { realpathExistingPrefixSync, resolveProfileRoots, toComparePath } from '../core/paths.ts';
import { lstatIfPresentSync, readJsonObjectSync, statIfPresentSync } from '../fs-utils.ts';
import type { SessionRecord, SessionSurface, SnapshotEnvelope } from '../snapshot-types.ts';
import { readTailLines } from './agents.ts';
import { resolveCliSubdirFile, resolveTrustedCliDir, sanitizeSessionId } from './safe-path.ts';
import { formatRelativeAge, formatSurfaceBadge, parseEnvelopeRecord } from './snapshot-envelope.ts';
import { openReadonlyDb } from './telemetry.ts';

const SUMMARY_QUERY_LIMIT = 100;
const ENVELOPE_FILE_RE = /^agy_hud_snapshot_(.+)\.json$/;
const RUNNING_STEP_STATUSES: ReadonlySet<string> = new Set([
  'RUNNING',
  'PENDING',
  'IN_PROGRESS',
  'GENERATING',
  'WAITING',
]);
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
  geminiRoot?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  isAlive?: (pid: number) => boolean;
}

interface DataRootEntry {
  dir: string;
  surface: SessionSurface;
}

interface CandidateAccumulator {
  convId: string;
  surface: SessionSurface;
  dataRoot: string;
  title: string;
  workspaces: string[];
  workspacesSeen: Set<string>;
  running: boolean;
  summaryModifiedMs: number;
  envelope: SnapshotEnvelope | null;
}

function buildDataRoots(cliHome: string, geminiRoot: string): DataRootEntry[] {
  const roots: DataRootEntry[] = [{ dir: cliHome, surface: 'cli' }];
  const appDir = path.join(geminiRoot, 'antigravity');
  if (existsSync(appDir)) {
    roots.push({ dir: appDir, surface: 'app' });
  }
  const ideDir = path.join(geminiRoot, 'antigravity-ide');
  if (existsSync(path.join(ideDir, 'brain'))) {
    roots.push({ dir: ideDir, surface: 'ide' });
  }
  return roots;
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

function parseWorkspaceUris(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const results: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string' || item.trim().length === 0) continue;
      if (item.startsWith('file://')) {
        try {
          results.push(fileURLToPath(item));
        } catch {
          // Ignore malformed file:// URI.
        }
      } else {
        results.push(item);
      }
    }
    return results;
  } catch {
    return [];
  }
}

function parseSummaryTimestampMs(raw: unknown): number {
  if (isFiniteNum(raw) && raw > 0) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function resolvePhysicalOwner(
  convId: string,
  source: string,
  originRoot: DataRootEntry,
  roots: readonly DataRootEntry[],
): DataRootEntry | null {
  const cliRoot = roots.find((r) => r.surface === 'cli');
  const appRoot = roots.find((r) => r.surface === 'app');
  const ideRoot = roots.find((r) => r.surface === 'ide');
  const ordered: DataRootEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: DataRootEntry | undefined): void => {
    if (entry && !seen.has(entry.dir)) {
      seen.add(entry.dir);
      ordered.push(entry);
    }
  };

  if (source === 'CORTEX_TRAJECTORY_SOURCE_CLI') {
    push(cliRoot);
    push(originRoot);
    push(appRoot);
    push(ideRoot);
  } else {
    push(originRoot);
    push(appRoot);
    push(cliRoot);
    push(ideRoot);
  }

  for (const candidate of ordered) {
    if (hasPhysicalSessionFiles(candidate.dir, convId)) {
      return candidate;
    }
  }
  return null;
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

function scanSummaryDatabases(
  roots: readonly DataRootEntry[],
  candidates: Map<string, CandidateAccumulator>,
  excludedIds: Set<string>,
): void {
  for (const root of roots) {
    const dbPath = path.join(root.dir, 'conversation_summaries.db');
    if (!existsSync(dbPath)) continue;
    const db = openReadonlyDb(dbPath);
    if (db === null) continue;
    try {
      const excludedRows = db
        .prepare('SELECT conversation_id FROM conversation_summaries WHERE nesting_depth != 0 OR killed != 0')
        .all();
      for (const row of excludedRows) {
        if (!isPlainObject(row) || typeof row.conversation_id !== 'string') continue;
        const safe = sanitizeSessionId(row.conversation_id);
        if (safe !== null) {
          excludedIds.add(safe);
          candidates.delete(safe);
        }
      }

      const rows = db
        .prepare(
          `SELECT conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status
           FROM conversation_summaries
           WHERE nesting_depth = 0 AND killed = 0
           ORDER BY last_modified_time DESC
           LIMIT ${SUMMARY_QUERY_LIMIT}`,
        )
        .all();
      for (const row of rows) {
        if (!isPlainObject(row) || typeof row.conversation_id !== 'string') continue;
        const safeId = sanitizeSessionId(row.conversation_id);
        if (safeId === null || excludedIds.has(safeId)) continue;
        const source = typeof row.source === 'string' ? row.source : '';
        const owner = resolvePhysicalOwner(safeId, source, root, roots);
        if (owner === null) continue;

        const title = typeof row.title === 'string' ? row.title.trim() : '';
        const summaryMs = parseSummaryTimestampMs(row.last_modified_time);
        const isRunning = row.not_fully_idle === 1 || row.status === 'CASCADE_RUN_STATUS_RUNNING';

        let acc = candidates.get(safeId);
        if (!acc) {
          acc = {
            convId: safeId,
            surface: owner.surface,
            dataRoot: owner.dir,
            title,
            workspaces: [],
            workspacesSeen: new Set<string>(),
            running: isRunning,
            summaryModifiedMs: summaryMs,
            envelope: null,
          };
          candidates.set(safeId, acc);
        } else {
          if (title.length > 0 && acc.title.length === 0) acc.title = title;
          if (summaryMs > acc.summaryModifiedMs) acc.summaryModifiedMs = summaryMs;
          if (isRunning) acc.running = true;
        }
        for (const ws of parseWorkspaceUris(row.workspace_uris)) {
          addWorkspacePath(acc, ws);
        }
      }
    } catch {
      // Ignore schema or read errors on individual summary DBs.
    } finally {
      db.close();
    }
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
    if (!ENVELOPE_FILE_RE.test(name)) continue;
    const fullPath = path.join(cacheDir, name);
    const st = lstatIfPresentSync(fullPath);
    if (st === null || st.isSymbolicLink() || !st.isFile()) continue;
    const raw = readJsonObjectSync(fullPath, false);
    if (raw === null) continue;
    const env = parseEnvelopeRecord(raw);
    if (env === null || excludedIds.has(env.convId)) continue;

    let acc = candidates.get(env.convId);
    if (!acc) {
      acc = {
        convId: env.convId,
        surface: 'cli',
        dataRoot: cliHome,
        title: env.conversationTitle,
        workspaces: [],
        workspacesSeen: new Set<string>(),
        running: false,
        summaryModifiedMs: 0,
        envelope: env,
      };
      candidates.set(env.convId, acc);
    } else if (acc.surface === 'cli') {
      if (!acc.envelope || env.updatedAtMs >= acc.envelope.updatedAtMs) {
        acc.envelope = env;
      }
      if (env.conversationTitle.length > 0 && acc.title.length === 0) {
        acc.title = env.conversationTitle;
      }
    }

    if (acc.surface === 'cli') {
      addWorkspacePath(acc, env.workspaceCurrentDir);
      addWorkspacePath(acc, env.workspaceProjectDir);
      addWorkspacePath(acc, env.cwd);
    }
  }
}

function scanColdBrainDirectories(
  roots: readonly DataRootEntry[],
  candidates: Map<string, CandidateAccumulator>,
  excludedIds: ReadonlySet<string>,
): void {
  for (const root of roots) {
    const brainDir = resolveTrustedCliDir(root.dir, 'brain');
    if (brainDir === null) continue;
    let entries: string[];
    try {
      entries = readdirSync(brainDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const safeId = sanitizeSessionId(name);
      if (safeId === null || candidates.has(safeId) || excludedIds.has(safeId)) continue;
      const hasTranscript = existsSync(path.join(brainDir, safeId, '.system_generated', 'logs', 'transcript.jsonl'));
      const hasDb = existsSync(path.join(root.dir, 'conversations', `${safeId}.db`));
      if (!hasTranscript && !hasDb) continue;
      candidates.set(safeId, {
        convId: safeId,
        surface: root.surface,
        dataRoot: root.dir,
        title: '',
        workspaces: [],
        workspacesSeen: new Set<string>(),
        running: false,
        summaryModifiedMs: 0,
        envelope: null,
      });
    }
  }
}

function isLiveOrClientSession(s: SessionRecord): boolean {
  if (s.surface !== 'cli') return true;
  return s.livePid !== null || s.envelope === null || s.envelope.agyPid === null;
}

function compareSessionsDefault(a: SessionRecord, b: SessionRecord): number {
  const runDiff = (b.running ? 1 : 0) - (a.running ? 1 : 0);
  if (runDiff !== 0) return runDiff;
  const liveDiff = (isLiveOrClientSession(b) ? 1 : 0) - (isLiveOrClientSession(a) ? 1 : 0);
  if (liveDiff !== 0) return liveDiff;
  const timeDiff = b.updatedAtMs - a.updatedAtMs;
  if (timeDiff !== 0) return timeDiff;
  return a.convId.localeCompare(b.convId);
}

export function discoverSessions(options: DiscoverSessionsOptions = {}): SessionRecord[] {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const checkAlive = options.isAlive ?? isPidAlive;
  const { cliHome, geminiRoot } = resolveProfileRoots(options.cliHome, options.geminiRoot, env);
  const roots = buildDataRoots(cliHome, geminiRoot);

  const candidates = new Map<string, CandidateAccumulator>();
  const excludedIds = new Set<string>();
  scanSummaryDatabases(roots, candidates, excludedIds);
  scanSnapshotEnvelopes(cliHome, candidates, excludedIds);
  scanColdBrainDirectories(roots, candidates, excludedIds);

  const newestByLivePid = new Map<number, { convId: string; updatedAtMs: number }>();
  for (const acc of candidates.values()) {
    if (acc.surface !== 'cli' || acc.envelope === null || acc.envelope.agyPid === null) continue;
    const pid = acc.envelope.agyPid;
    if (!checkAlive(pid)) continue;
    const cur = newestByLivePid.get(pid);
    if (!cur || acc.envelope.updatedAtMs > cur.updatedAtMs) {
      newestByLivePid.set(pid, { convId: acc.convId, updatedAtMs: acc.envelope.updatedAtMs });
    }
  }

  const sessions: SessionRecord[] = [];
  for (const acc of candidates.values()) {
    const probe = probeTranscriptState(acc.dataRoot, acc.convId);
    const envPid = acc.envelope?.agyPid ?? null;
    const livePid = envPid !== null && newestByLivePid.get(envPid)?.convId === acc.convId ? envPid : null;
    const updatedAtMs = Math.max(acc.envelope?.updatedAtMs ?? 0, probe.mtimeMs, acc.summaryModifiedMs);
    const running = acc.running || probe.running || (livePid !== null && envelopeHasActiveSubagent(acc.envelope));
    const badge = formatSurfaceBadge(acc.surface);
    const title = acc.title.length > 0 ? acc.title : `${badge} session ${acc.convId.slice(0, 8)}`;

    sessions.push({
      convId: acc.convId,
      shortId: acc.convId.slice(0, 8),
      surface: acc.surface,
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
    });
  }

  return sessions.sort(compareSessionsDefault);
}
