import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeSwarmStateDigest } from '../collectors/agents.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from '../collectors/safe-path.ts';
import { resolveSession, SessionResolutionError, type ResolveSessionOptions } from '../collectors/session-index.ts';
import { readCliFallbackModel, readHudConfig } from '../collectors/settings.ts';
import { loadActivitySnapshot } from '../collectors/snapshot-loader.ts';
import { readSqliteVersionTag } from '../collectors/sqlite-readonly.ts';
import { computeFileContentHash } from '../collectors/transcript-fingerprint.ts';
import { selectNewestFirst } from '../core/guards.ts';
import { DEFAULT_USD_TO_CNY_RATE } from '../core/hud-config.ts';
import { resolveProfileRoots } from '../core/paths.ts';
import { statIfPresentSync } from '../fs-utils.ts';
import { formatCnyAmount, formatSessionCostText, formatUsdAmount } from '../render/cost.ts';
import type {
  ActivitySnapshot,
  SessionRecord,
  SessionSourceFilter,
  SessionSurface,
  SiblingSessionHint,
  SnapshotAgent,
  SnapshotCompletedTool,
  SnapshotCost,
  SnapshotEnvelope,
  SnapshotMcpServer,
  SnapshotResolutionTier,
  SnapshotRunningTool,
} from '../snapshot-types.ts';
import type { AgentsKind, HudCostCurrency, SessionTelemetry, TodoSummary } from '../types.ts';
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
  cost: SnapshotCost | null;
  costFormatted?: { readonly text: string; readonly title: string } | null;
  costCurrency: HudCostCurrency;
  usdToCnyRate: number;
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
      env.cost ?? null,
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

function formatInspectorCostFields(
  cost: SnapshotCost | null | undefined,
  currency: HudCostCurrency,
  usdToCnyRate: number,
): { readonly text: string; readonly title: string } | null {
  if (!cost) return null;
  const rate = Number.isFinite(usdToCnyRate) && usdToCnyRate > 0 ? usdToCnyRate : DEFAULT_USD_TO_CNY_RATE;
  const text = formatSessionCostText(cost, { currency, usdToCnyRate: rate });
  const prefix = cost.estimated ? '~' : '';
  const titleParts = [
    `Session cost: ${prefix}${formatUsdAmount(cost.totalUsd, false)} / ${formatCnyAmount(cost.totalUsd, rate)}`,
  ];
  if (cost.subagentUsd !== null && cost.subagentUsd > 0) {
    titleParts.push(
      `Subagents: ${formatUsdAmount(cost.subagentUsd, false)} / ${formatCnyAmount(cost.subagentUsd, rate)}`,
    );
  }
  if (cost.estimated) titleParts.push('Estimated pricing');
  return { text, title: titleParts.join(' · ') };
}

function computeSiblingsSemanticKey(siblings: readonly SiblingSessionHint[]): string {
  return siblings
    .map((s) => [s.convId, s.surface, s.title, String(s.livePid ?? 0), s.running ? '1' : '0'].join('\0'))
    .join('\x1e');
}

function computeSessionStatEtag(
  session: SessionRecord,
  sessions: readonly SessionRecord[],
  source: SessionSourceFilter,
  resolutionTier: SnapshotResolutionTier,
  siblings: readonly SiblingSessionHint[],
  costCurrency: HudCostCurrency,
  usdToCnyRate: number,
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
  const fallbackModel = session.surface === 'cli' ? readCliFallbackModel(session.dataRoot) : '';
  const siblingsKey = computeSiblingsSemanticKey(siblings);
  const listKey = sessions.slice(0, MAX_SESSIONS_LIST).map(computeSessionListKeyEntry).join('\x1e');

  const raw = [
    'v6',
    source,
    resolutionTier,
    costCurrency,
    String(usdToCnyRate),
    session.convId,
    session.surface,
    session.title,
    session.workspace,
    fallbackModel,
    session.running ? '1' : '0',
    String(session.livePid ?? 0),
    String(session.updatedAtMs),
    tHash,
    taskHash,
    dbTag,
    swarmDigest,
    envSemantic,
    siblingsKey,
    listKey,
  ].join('\x1f');
  return hashShortSha256(raw);
}

function enrichActivitySnapshot(
  snapshot: ActivitySnapshot,
  costCurrency: HudCostCurrency,
  usdToCnyRate: number,
): HudInspectorSnapshotPayload {
  const { ctxUsed, ctxMax } = snapshot.telemetry;
  const ctxPct =
    ctxUsed !== null && ctxMax !== null && ctxMax > 0
      ? Math.min(100, Math.round((ctxUsed / ctxMax) * 1000) / 10)
      : null;

  const runningTools: HudInspectorRunningTool[] = selectNewestFirst(snapshot.runningTools).map((rt) => {
    const { targetLinkable, ...rest } = rt;
    return {
      ...rest,
      fileUri: targetLinkable === false ? null : resolveLocalTargetFileUri(rt.fullTarget, snapshot.workspace),
    };
  });

  const completedTools: HudInspectorToolItem[] = snapshot.completedTools.map((tool) => {
    const { unlinkedTargets, ...rest } = tool;
    const unlinkedSet = unlinkedTargets !== undefined ? new Set<string>(unlinkedTargets) : null;
    const targetUris: Record<string, string> = {};
    for (const target of tool.recentTargets) {
      if (unlinkedSet?.has(target) === true) continue;
      const uri = resolveLocalTargetFileUri(target, snapshot.workspace);
      if (uri !== null) targetUris[target] = uri;
    }
    if (
      tool.fullTarget.length > 0 &&
      targetUris[tool.fullTarget] === undefined &&
      unlinkedSet?.has(tool.fullTarget) !== true
    ) {
      const uri = resolveLocalTargetFileUri(tool.fullTarget, snapshot.workspace);
      if (uri !== null) targetUris[tool.fullTarget] = uri;
    }
    return { ...rest, targetUris };
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
    cost: snapshot.cost ?? null,
    costFormatted: formatInspectorCostFields(snapshot.cost, costCurrency, usdToCnyRate),
    costCurrency,
    usdToCnyRate,
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

  const hudCfg = readHudConfig(cliHome);
  const etag = computeSessionStatEtag(
    resolved.session,
    resolved.sessions,
    source,
    resolved.tier,
    resolved.siblings,
    hudCfg.costCurrency,
    hudCfg.usdToCnyRate,
  );
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
    snapshot: enrichActivitySnapshot(rawSnapshot, hudCfg.costCurrency, hudCfg.usdToCnyRate),
  };
  return capInspectorPayload(payload);
}
