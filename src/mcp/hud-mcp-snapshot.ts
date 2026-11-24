import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveCliSubdirFile, sanitizeSessionId } from '../collectors/safe-path.ts';
import {
  loadActivitySnapshot,
  resolveSession,
  SessionResolutionError,
  type ResolveSessionOptions,
} from '../collectors/session-index.ts';
import { statSignature } from '../collectors/telemetry.ts';
import { resolveProfileRoots } from '../core/paths.ts';
import type {
  ActivitySnapshot,
  SessionRecord,
  SessionSourceFilter,
  SessionSurface,
  SiblingSessionHint,
  SnapshotAgent,
  SnapshotCompletedTool,
  SnapshotMcpServer,
  SnapshotResolutionTier,
  SnapshotRunningTool,
} from '../snapshot-types.ts';
import type { AgentsKind, SessionTelemetry, TodoSummary } from '../types.ts';

export const MAX_MCP_PAYLOAD_BYTES = 900_000;
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

function resolveLocalTargetFileUri(rawTarget: string, workspace: string): string | null {
  const trimmed = rawTarget.trim();
  if (trimmed.length === 0 || trimmed.includes('\0') || SHELL_OPERATOR_RE.test(trimmed)) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return null;
  if (trimmed.startsWith('file:///')) {
    const cut = trimmed.split(/[?#]/, 1)[0] ?? '';
    return cut.length > 'file:///'.length ? cut : null;
  }
  if (path.isAbsolute(trimmed) || WINDOWS_ABS_RE.test(trimmed)) {
    if (trimmed.includes(' --') || trimmed.includes(' -')) return null;
    try {
      return pathToFileURL(trimmed).href;
    } catch {
      return null;
    }
  }
  if (workspace.length > 0 && !trimmed.startsWith('-')) {
    const resolved = path.resolve(workspace, trimmed);
    if (existsSync(resolved)) {
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

function computeSessionStatEtag(
  session: SessionRecord,
  sessions: readonly SessionRecord[],
  source: SessionSourceFilter,
  cliHome: string,
): string {
  const safeId = sanitizeSessionId(session.convId);
  const tPath =
    safeId !== null
      ? resolveCliSubdirFile(session.dataRoot, 'brain', safeId, '.system_generated', 'logs', 'transcript.jsonl')
      : null;
  const dbPath = safeId !== null ? resolveCliSubdirFile(session.dataRoot, 'conversations', `${safeId}.db`) : null;
  const walPath = dbPath !== null ? `${dbPath}-wal` : null;
  const envPath =
    safeId !== null && session.surface === 'cli'
      ? resolveCliSubdirFile(cliHome, 'cache', `agy_hud_snapshot_${safeId}.json`)
      : null;

  const tSig = tPath !== null ? statSignature(tPath) : [0, 0];
  const dbSig = dbPath !== null ? statSignature(dbPath) : [0, 0];
  const walSig = walPath !== null ? statSignature(walPath) : [0, 0];
  const envSig = envPath !== null ? statSignature(envPath) : [0, 0];
  const listKey = sessions
    .slice(0, MAX_SESSIONS_LIST)
    .map((s) => `${s.convId}:${s.surface}:${s.updatedAtMs}:${s.running ? 1 : 0}`)
    .join('|');

  const raw = [
    'v1',
    source,
    session.convId,
    session.surface,
    session.running ? '1' : '0',
    session.updatedAtMs,
    tSig.join(','),
    dbSig.join(','),
    walSig.join(','),
    envSig.join(','),
    listKey,
  ].join('#');
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

interface PayloadTrimLimits {
  maxSessions: number;
  maxTools: number;
  maxRecentTargets: number;
  maxTargetChars: number;
  maxSkills: number;
  maxAgents: number;
  maxMcps: number;
  maxSubtools: number;
  keepTargetUris: boolean;
}

const TRIM_TIERS: readonly PayloadTrimLimits[] = [
  {
    maxSessions: 30,
    maxTools: 150,
    maxRecentTargets: 3,
    maxTargetChars: 240,
    maxSkills: 150,
    maxAgents: 150,
    maxMcps: 40,
    maxSubtools: 25,
    keepTargetUris: true,
  },
  {
    maxSessions: 20,
    maxTools: 80,
    maxRecentTargets: 1,
    maxTargetChars: 120,
    maxSkills: 80,
    maxAgents: 80,
    maxMcps: 25,
    maxSubtools: 12,
    keepTargetUris: true,
  },
  {
    maxSessions: 10,
    maxTools: 40,
    maxRecentTargets: 0,
    maxTargetChars: 80,
    maxSkills: 40,
    maxAgents: 40,
    maxMcps: 15,
    maxSubtools: 8,
    keepTargetUris: false,
  },
  {
    maxSessions: 5,
    maxTools: 15,
    maxRecentTargets: 0,
    maxTargetChars: 60,
    maxSkills: 15,
    maxAgents: 15,
    maxMcps: 8,
    maxSubtools: 5,
    keepTargetUris: false,
  },
];

function clipStr(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}

function applyTrimTier(payload: HudPollSnapshotData, tier: PayloadTrimLimits): HudPollSnapshotData {
  const sessions = payload.sessions.slice(0, tier.maxSessions);
  if (payload.snapshot === null) {
    return { ...payload, sessions, truncated: true };
  }
  const snap = payload.snapshot;
  const completedTools: HudInspectorToolItem[] = snap.completedTools.slice(0, tier.maxTools).map((tool) => {
    const recentTargets = tool.recentTargets
      .slice(0, tier.maxRecentTargets)
      .map((t) => clipStr(t, tier.maxTargetChars));
    const targetUris: Record<string, string> = {};
    if (tier.keepTargetUris) {
      for (const t of recentTargets) {
        const uri = tool.targetUris[t];
        if (uri !== undefined) targetUris[t] = uri;
      }
    }
    return {
      disp: clipStr(tool.disp, 80),
      count: tool.count,
      latestTarget: clipStr(tool.latestTarget, tier.maxTargetChars),
      fullTarget: clipStr(tool.fullTarget, tier.maxTargetChars),
      recentTargets,
      targetUris,
      isMcp: tool.isMcp,
    };
  });
  const mcps: SnapshotMcpServer[] = snap.mcps.slice(0, tier.maxMcps).map((m) => ({
    server: clipStr(m.server, 80),
    totalCalls: m.totalCalls,
    subtools: m.subtools.slice(0, tier.maxSubtools),
  }));

  return {
    ...payload,
    sessions,
    truncated: true,
    snapshot: {
      ...snap,
      runningTools: snap.runningTools.slice(0, 12).map((rt) => ({
        ...rt,
        target: clipStr(rt.target, tier.maxTargetChars),
        fullTarget: clipStr(rt.fullTarget, tier.maxTargetChars),
      })),
      completedTools,
      skills: snap.skills.slice(0, tier.maxSkills).map((s) => clipStr(s, 80)),
      mcps,
      agents: snap.agents.slice(0, tier.maxAgents),
    },
  };
}

export function capInspectorPayload(
  payload: HudPollSnapshotData,
  maxBytes: number = MAX_MCP_PAYLOAD_BYTES,
): HudPollSnapshotData {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= maxBytes) {
    return payload;
  }
  let candidate = payload;
  for (const tier of TRIM_TIERS) {
    candidate = applyTrimTier(payload, tier);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) {
      return candidate;
    }
  }
  return candidate;
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

  const etag = computeSessionStatEtag(resolved.session, resolved.sessions, source, cliHome);
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
