import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveCliSubdirFile, sanitizeSessionId } from '../collectors/safe-path.ts';
import { resolveSession, SessionResolutionError, type ResolveSessionOptions } from '../collectors/session-index.ts';
import { loadActivitySnapshot } from '../collectors/snapshot-loader.ts';
import { readSqliteVersionTag } from '../collectors/sqlite-readonly.ts';
import { computeFileContentHash } from '../collectors/transcript-scanner.ts';
import { isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { resolveProfileRoots } from '../core/paths.ts';
import { readJsonObjectSync, statIfPresentSync } from '../fs-utils.ts';
import type {
  ActivitySnapshot,
  SessionRecord,
  SessionSourceFilter,
  SessionSurface,
  SiblingSessionHint,
  SnapshotAgent,
  SnapshotCompletedTool,
  SnapshotEnvelope,
  SnapshotMcpServer,
  SnapshotResolutionTier,
  SnapshotRunningTool,
} from '../snapshot-types.ts';
import type { AgentsKind, SessionTelemetry, TodoSummary } from '../types.ts';
import { capInspectorPayload, HARD_MAX_MCP_RESPONSE_BYTES, MAX_MCP_PAYLOAD_BYTES } from './hud-mcp-cap.ts';

export { capInspectorPayload, HARD_MAX_MCP_RESPONSE_BYTES, MAX_MCP_PAYLOAD_BYTES };
const MAX_SESSIONS_LIST = 40;
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const SHELL_OPERATOR_RE = /[|&;<>`$\r\n]/;

export interface HudInspectorTelemetry extends SessionTelemetry {
  ctxPct: number | null;
}

export interface HudInspectorToolItem extends SnapshotCompletedTool {
  targetUris: Record<string, string>;
}

export interface HudInspectorRunningTool extends SnapshotRunningTool {
  fileUri: string | null;
}

export interface HudInspectorSessionItem {
  convId: string;
  shortId: string;
  surface: SessionSurface;
  title: string;
  workspace: string;
  running: boolean;
  livePid: number | null;
  updatedAtMs: number;
  ageLabel: string;
}

export interface HudInspectorSnapshotPayload {
  convId: string;
  shortId: string;
  surface: SessionSurface;
  title: string;
  model: string;
  workspace: string;
  resolutionTier: SnapshotResolutionTier;
  running: boolean;
  updatedAtMs: number;
  ageLabel: string;
  livePid: number | null;
  siblingCandidates: SiblingSessionHint[];
  siblingHint: string;
  telemetry: HudInspectorTelemetry;
  runningTools: HudInspectorRunningTool[];
  completedTools: HudInspectorToolItem[];
  totalToolCalls: number;
  skills: string[];
  mcps: SnapshotMcpServer[];
  agentsKind: AgentsKind;
  agents: SnapshotAgent[];
  todos: TodoSummary | null;
}

export interface HudPollUnchangedResult {
  unchanged: true;
  etag: string;
}

export interface HudPollSnapshotData {
  unchanged: false;
  etag: string;
  source: SessionSourceFilter;
  sessions: HudInspectorSessionItem[];
  snapshot: HudInspectorSnapshotPayload | null;
  truncated?: boolean;
}

export type HudPollResult = HudPollUnchangedResult | HudPollSnapshotData;

export interface HudPollArgs {
  sessionId?: string;
  source?: SessionSourceFilter;
  etag?: string;
}

export interface HudPollOptions {
  cliHome?: string;
  geminiRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nowMs?: number;
  isAlive?: (pid: number) => boolean;
}

function hashShortSha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 24);
}

function isExistingRegularFile(filePath: string): boolean {
  try {
    return statIfPresentSync(filePath)?.isFile() === true;
  } catch {
    return false;
  }
}

function resolveLocalTargetFileUri(rawTarget: string, workspace: string): string | null {
  const trimmed = rawTarget.trim();
  if (trimmed.length === 0 || trimmed.includes('\0') || SHELL_OPERATOR_RE.test(trimmed)) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return null;
  if (trimmed.startsWith('file:///')) {
    const cut = trimmed.split(/[?#]/, 1)[0] ?? '';
    if (cut.length <= 'file:///'.length) return null;
    try {
      return isExistingRegularFile(fileURLToPath(cut)) ? cut : null;
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(trimmed) || WINDOWS_ABS_RE.test(trimmed)) {
    if (!isExistingRegularFile(trimmed)) return null;
    try {
      return pathToFileURL(trimmed).href;
    } catch {
      return null;
    }
  }
  if (workspace.length > 0 && !trimmed.startsWith('-')) {
    const resolved = path.resolve(workspace, trimmed);
    if (isExistingRegularFile(resolved)) {
      try {
        return pathToFileURL(resolved).href;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toInspectorSessionItem(session: SessionRecord): HudInspectorSessionItem {
  return {
    convId: session.convId,
    shortId: session.shortId,
    surface: session.surface,
    title: session.title,
    workspace: session.workspace,
    running: session.running,
    livePid: session.livePid,
    updatedAtMs: session.updatedAtMs,
    ageLabel: session.ageLabel,
  };
}

function computeEnvelopeSemanticKey(env: SnapshotEnvelope | null): string {
  if (env === null) return '';
  return hashShortSha256(
    JSON.stringify([
      env.conversationTitle,
      env.agyPid,
      env.cwd,
      env.workspaceCurrentDir,
      env.workspaceProjectDir,
      env.taskCount,
      env.mdDigest,
      env.subagents,
    ]),
  );
}

function computeSessionListKeyEntry(s: SessionRecord): string {
  return [
    s.convId,
    s.surface,
    s.title,
    s.workspace,
    s.running ? '1' : '0',
    String(s.livePid ?? 0),
    String(s.updatedAtMs),
    computeEnvelopeSemanticKey(s.envelope),
  ].join('\0');
}

function computeSwarmStateDigest(dataRoot: string, safeId: string): string {
  const rosterPath = resolveCliSubdirFile(dataRoot, 'brain', safeId, '.system_generated', 'swarm', 'members.json');
  if (rosterPath === null) return '';
  const rosterHash = computeFileContentHash(rosterPath);
  if (rosterHash.length === 0) return '';

  const parts: string[] = [rosterHash];
  const roster = readJsonObjectSync(rosterPath, false);
  if (roster !== null && isPlainObject(roster.members)) {
    const memberNames = Object.keys(roster.members).sort();
    for (const name of memberNames) {
      const member = roster.members[name];
      if (!isPlainObject(member)) continue;
      const role = typeof member.role === 'string' ? member.role.trim().toLowerCase() : '';
      if (name === 'coordinator' || role === 'coordinator' || member.killed === true) continue;
      const memberConvId = sanitizeSessionId(nonEmptyStr(member.conversation_id));
      if (memberConvId === null) continue;
      const workerTranscript = resolveCliSubdirFile(
        dataRoot,
        'brain',
        memberConvId,
        '.system_generated',
        'logs',
        'transcript.jsonl',
      );
      const workerHash = workerTranscript !== null ? computeFileContentHash(workerTranscript) : '';
      parts.push(`${name}:${memberConvId}:${workerHash}`);
    }
  }
  return hashShortSha256(parts.join('\0'));
}

function computeSessionStatEtag(
  session: SessionRecord,
  sessions: readonly SessionRecord[],
  source: SessionSourceFilter,
): string {
  const safeId = sanitizeSessionId(session.convId);
  const tPath =
    safeId !== null
      ? resolveCliSubdirFile(session.dataRoot, 'brain', safeId, '.system_generated', 'logs', 'transcript.jsonl')
      : null;
  const taskPath = safeId !== null ? resolveCliSubdirFile(session.dataRoot, 'brain', safeId, 'task.md') : null;
  const dbPath = safeId !== null ? resolveCliSubdirFile(session.dataRoot, 'conversations', `${safeId}.db`) : null;

  const tHash = tPath !== null ? computeFileContentHash(tPath) : '';
  const taskHash = taskPath !== null ? computeFileContentHash(taskPath) : '';
  const dbTag = dbPath !== null ? readSqliteVersionTag(dbPath) : '';
  const swarmDigest = safeId !== null ? computeSwarmStateDigest(session.dataRoot, safeId) : '';
  const envSemantic = computeEnvelopeSemanticKey(session.envelope);
  const listKey = sessions.slice(0, MAX_SESSIONS_LIST).map(computeSessionListKeyEntry).join('\x1e');

  const raw = [
    'v4',
    source,
    session.convId,
    session.surface,
    session.title,
    session.workspace,
    session.running ? '1' : '0',
    String(session.livePid ?? 0),
    String(session.updatedAtMs),
    tHash,
    taskHash,
    dbTag,
    swarmDigest,
    envSemantic,
    listKey,
  ].join('\x1f');
  return hashShortSha256(raw);
}

function enrichActivitySnapshot(snapshot: ActivitySnapshot): HudInspectorSnapshotPayload {
  const { ctxUsed, ctxMax } = snapshot.telemetry;
  const ctxPct =
    ctxUsed !== null && ctxMax !== null && ctxMax > 0
      ? Math.min(100, Math.round((ctxUsed / ctxMax) * 1000) / 10)
      : null;

  const runningTools: HudInspectorRunningTool[] = snapshot.runningTools.map((rt) => ({
    ...rt,
    fileUri: resolveLocalTargetFileUri(rt.fullTarget, snapshot.workspace),
  }));

  const completedTools: HudInspectorToolItem[] = snapshot.completedTools.map((tool) => {
    const targetUris: Record<string, string> = {};
    for (const target of tool.recentTargets) {
      const uri = resolveLocalTargetFileUri(target, snapshot.workspace);
      if (uri !== null) targetUris[target] = uri;
    }
    if (tool.fullTarget.length > 0 && targetUris[tool.fullTarget] === undefined) {
      const uri = resolveLocalTargetFileUri(tool.fullTarget, snapshot.workspace);
      if (uri !== null) targetUris[tool.fullTarget] = uri;
    }
    return { ...tool, targetUris };
  });

  return {
    convId: snapshot.convId,
    shortId: snapshot.shortId,
    surface: snapshot.surface,
    title: snapshot.title,
    model: snapshot.model,
    workspace: snapshot.workspace,
    resolutionTier: snapshot.resolutionTier,
    running: snapshot.running,
    updatedAtMs: snapshot.updatedAtMs,
    ageLabel: snapshot.ageLabel,
    livePid: snapshot.livePid,
    siblingCandidates: snapshot.siblingCandidates,
    siblingHint: snapshot.siblingHint,
    telemetry: { ...snapshot.telemetry, ctxPct },
    runningTools,
    completedTools,
    totalToolCalls: snapshot.totalToolCalls,
    skills: snapshot.skills,
    mcps: snapshot.mcps,
    agentsKind: snapshot.agentsKind,
    agents: snapshot.agents,
    todos: snapshot.todos,
  };
}

export function pollHudSnapshot(args: HudPollArgs = {}, options: HudPollOptions = {}): HudPollResult {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const source: SessionSourceFilter = args.source ?? 'auto';
  const { cliHome, geminiRoot } = resolveProfileRoots(options.cliHome, options.geminiRoot, env);

  const resolveOpts: ResolveSessionOptions = {
    cliHome,
    geminiRoot,
    env,
    nowMs,
    source,
    cwd: options.cwd,
    isAlive: options.isAlive,
    session: args.sessionId !== undefined && args.sessionId.trim().length > 0 ? args.sessionId.trim() : undefined,
  };

  let resolved;
  try {
    resolved = resolveSession(resolveOpts);
  } catch (err) {
    if (err instanceof SessionResolutionError && err.code === 'no-sessions') {
      const emptyEtag = hashShortSha256(`empty#${source}`);
      if (args.etag !== undefined && args.etag === emptyEtag) {
        return { unchanged: true, etag: emptyEtag };
      }
      return {
        unchanged: false,
        etag: emptyEtag,
        source,
        sessions: [],
        snapshot: null,
      };
    }
    throw err;
  }

  const etag = computeSessionStatEtag(resolved.session, resolved.sessions, source);
  if (args.etag !== undefined && args.etag === etag) {
    return { unchanged: true, etag };
  }

  const rawSnapshot = loadActivitySnapshot(resolved.session, {
    cacheCliHome: cliHome,
    resolutionTier: resolved.tier,
    siblings: resolved.siblings,
    nowMs,
  });

  const payload: HudPollSnapshotData = {
    unchanged: false,
    etag,
    source,
    sessions: resolved.sessions.slice(0, MAX_SESSIONS_LIST).map(toInspectorSessionItem),
    snapshot: enrichActivitySnapshot(rawSnapshot),
  };
  return capInspectorPayload(payload);
}
