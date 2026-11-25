import { isPlainObject } from '../core/guards.ts';
import type { SiblingSessionHint, SnapshotAgent, SnapshotMcpServer } from '../snapshot-types.ts';
import type {
  HudInspectorRunningTool,
  HudInspectorSessionItem,
  HudInspectorSnapshotPayload,
  HudInspectorToolItem,
  HudPollSnapshotData,
} from './hud-mcp-snapshot.ts';

export const HARD_MAX_MCP_RESPONSE_BYTES = 1_048_576;
export const MAX_MCP_PAYLOAD_BYTES = 900_000;

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

interface PayloadTrimLimits {
  maxSessions: number;
  maxTools: number;
  maxRunningTools: number;
  maxRecentTargets: number;
  maxTargetBytes: number;
  maxTitleBytes: number;
  maxWorkspaceBytes: number;
  maxFieldBytes: number;
  maxSiblings: number;
  maxSkills: number;
  maxAgents: number;
  maxMcps: number;
  maxSubtools: number;
  keepTargetUris: boolean;
  maxUriBytes: number;
}

const TRIM_TIERS: readonly PayloadTrimLimits[] = [
  {
    maxSessions: 30,
    maxTools: 150,
    maxRunningTools: 12,
    maxRecentTargets: 3,
    maxTargetBytes: 240,
    maxTitleBytes: 240,
    maxWorkspaceBytes: 240,
    maxFieldBytes: 96,
    maxSiblings: 5,
    maxSkills: 150,
    maxAgents: 150,
    maxMcps: 40,
    maxSubtools: 25,
    keepTargetUris: true,
    maxUriBytes: 1024,
  },
  {
    maxSessions: 20,
    maxTools: 80,
    maxRunningTools: 8,
    maxRecentTargets: 1,
    maxTargetBytes: 120,
    maxTitleBytes: 160,
    maxWorkspaceBytes: 160,
    maxFieldBytes: 64,
    maxSiblings: 3,
    maxSkills: 80,
    maxAgents: 80,
    maxMcps: 25,
    maxSubtools: 12,
    keepTargetUris: true,
    maxUriBytes: 1024,
  },
  {
    maxSessions: 10,
    maxTools: 40,
    maxRunningTools: 4,
    maxRecentTargets: 0,
    maxTargetBytes: 80,
    maxTitleBytes: 120,
    maxWorkspaceBytes: 120,
    maxFieldBytes: 48,
    maxSiblings: 0,
    maxSkills: 40,
    maxAgents: 40,
    maxMcps: 15,
    maxSubtools: 8,
    keepTargetUris: false,
    maxUriBytes: 0,
  },
  {
    maxSessions: 5,
    maxTools: 15,
    maxRunningTools: 2,
    maxRecentTargets: 0,
    maxTargetBytes: 60,
    maxTitleBytes: 80,
    maxWorkspaceBytes: 80,
    maxFieldBytes: 40,
    maxSiblings: 0,
    maxSkills: 15,
    maxAgents: 15,
    maxMcps: 8,
    maxSubtools: 5,
    keepTargetUris: false,
    maxUriBytes: 0,
  },
];

const ELLIPSIS = '…';
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8');

export function clipUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const budget = maxBytes > ELLIPSIS_BYTES ? maxBytes - ELLIPSIS_BYTES : maxBytes;
  let out = '';
  let used = 0;
  for (const ch of value) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (used + chBytes > budget) break;
    out += ch;
    used += chBytes;
  }
  return maxBytes > ELLIPSIS_BYTES ? `${out}${ELLIPSIS}` : out;
}

function keepIntactUri(uri: string | null | undefined, tier: PayloadTrimLimits): string | null {
  if (!tier.keepTargetUris || typeof uri !== 'string' || uri.length === 0) return null;
  return Buffer.byteLength(uri, 'utf8') <= tier.maxUriBytes ? uri : null;
}

function trimSessionItems(
  sessions: readonly HudInspectorSessionItem[],
  tier: PayloadTrimLimits,
): HudInspectorSessionItem[] {
  return sessions.slice(0, tier.maxSessions).map((s) => ({
    ...s,
    convId: s.convId,
    shortId: s.shortId,
    title: clipUtf8Bytes(s.title, tier.maxTitleBytes),
    workspace: clipUtf8Bytes(s.workspace, tier.maxWorkspaceBytes),
    ageLabel: clipUtf8Bytes(s.ageLabel, 32),
  }));
}

function trimSnapshotBody(snap: HudInspectorSnapshotPayload, tier: PayloadTrimLimits): HudInspectorSnapshotPayload {
  const runningTools: HudInspectorRunningTool[] = snap.runningTools.slice(0, tier.maxRunningTools).map((rt) => ({
    name: clipUtf8Bytes(rt.name, tier.maxFieldBytes),
    disp: clipUtf8Bytes(rt.disp, tier.maxFieldBytes),
    target: clipUtf8Bytes(rt.target, tier.maxTargetBytes),
    fullTarget: clipUtf8Bytes(rt.fullTarget, tier.maxTargetBytes),
    isMcp: rt.isMcp,
    fileUri: keepIntactUri(rt.fileUri, tier),
  }));

  const completedTools: HudInspectorToolItem[] = snap.completedTools.slice(0, tier.maxTools).map((tool) => {
    const rawRecent = tool.recentTargets.slice(0, tier.maxRecentTargets);
    const recentTargets: string[] = [];
    const targetUris: Record<string, string> = {};
    const collidedKeys = new Set<string>();
    for (const origTarget of rawRecent) {
      const clippedTarget = clipUtf8Bytes(origTarget, tier.maxTargetBytes);
      recentTargets.push(clippedTarget);
      const uri = keepIntactUri(tool.targetUris[origTarget], tier);
      if (collidedKeys.has(clippedTarget)) continue;
      if (Object.hasOwn(targetUris, clippedTarget)) {
        if (targetUris[clippedTarget] !== uri) {
          delete targetUris[clippedTarget];
          collidedKeys.add(clippedTarget);
        }
      } else if (uri !== null) {
        targetUris[clippedTarget] = uri;
      }
    }
    const clippedFull = clipUtf8Bytes(tool.fullTarget, tier.maxTargetBytes);
    if (clippedFull.length > 0 && !collidedKeys.has(clippedFull) && !Object.hasOwn(targetUris, clippedFull)) {
      const fullUri = keepIntactUri(tool.targetUris[tool.fullTarget], tier);
      if (fullUri !== null) targetUris[clippedFull] = fullUri;
    }
    return {
      disp: clipUtf8Bytes(tool.disp, tier.maxFieldBytes),
      count: tool.count,
      latestTarget: clipUtf8Bytes(tool.latestTarget, tier.maxTargetBytes),
      fullTarget: clippedFull,
      recentTargets,
      targetUris,
      isMcp: tool.isMcp,
    };
  });

  const mcps: SnapshotMcpServer[] = snap.mcps.slice(0, tier.maxMcps).map((m) => ({
    server: clipUtf8Bytes(m.server, tier.maxFieldBytes),
    totalCalls: m.totalCalls,
    subtools: m.subtools.slice(0, tier.maxSubtools).map((st) => ({
      name: clipUtf8Bytes(st.name, tier.maxFieldBytes),
      count: st.count,
    })),
  }));

  const agents: SnapshotAgent[] = snap.agents.slice(0, tier.maxAgents).map((a) => ({
    ...a,
    name: clipUtf8Bytes(a.name, tier.maxFieldBytes),
    type: clipUtf8Bytes(a.type, tier.maxFieldBytes),
    model: clipUtf8Bytes(a.model, tier.maxFieldBytes),
    ageLabel: clipUtf8Bytes(a.ageLabel, 32),
  }));

  const siblingCandidates: SiblingSessionHint[] = snap.siblingCandidates.slice(0, tier.maxSiblings).map((sib) => ({
    ...sib,
    convId: sib.convId,
    shortId: sib.shortId,
    title: clipUtf8Bytes(sib.title, tier.maxFieldBytes),
    ageLabel: clipUtf8Bytes(sib.ageLabel, 32),
  }));

  const todos =
    snap.todos === null
      ? null
      : {
          ...snap.todos,
          ...(snap.todos.current !== undefined
            ? { current: clipUtf8Bytes(snap.todos.current, tier.maxTitleBytes) }
            : {}),
        };

  return {
    ...snap,
    convId: snap.convId,
    shortId: snap.shortId,
    title: clipUtf8Bytes(snap.title, tier.maxTitleBytes),
    model: clipUtf8Bytes(snap.model, tier.maxFieldBytes),
    workspace: clipUtf8Bytes(snap.workspace, tier.maxWorkspaceBytes),
    ageLabel: clipUtf8Bytes(snap.ageLabel, 32),
    siblingCandidates,
    siblingHint: tier.maxSiblings > 0 ? clipUtf8Bytes(snap.siblingHint, tier.maxTitleBytes) : '',
    runningTools,
    completedTools,
    skills: snap.skills.slice(0, tier.maxSkills).map((s) => clipUtf8Bytes(s, tier.maxFieldBytes)),
    mcps,
    agents,
    todos,
  };
}

function applyTrimTier(payload: HudPollSnapshotData, tier: PayloadTrimLimits): HudPollSnapshotData {
  const sessions = trimSessionItems(payload.sessions, tier);
  if (payload.snapshot === null) {
    return { ...payload, sessions, truncated: true };
  }
  return {
    ...payload,
    sessions,
    truncated: true,
    snapshot: trimSnapshotBody(payload.snapshot, tier),
  };
}

function buildMinimalTruncatedSnapshot(payload: HudPollSnapshotData): HudPollSnapshotData {
  const snap = payload.snapshot;
  if (snap === null) {
    return {
      unchanged: false,
      etag: clipUtf8Bytes(payload.etag, 64),
      source: payload.source,
      sessions: [],
      snapshot: null,
      truncated: true,
    };
  }
  return {
    unchanged: false,
    etag: clipUtf8Bytes(payload.etag, 64),
    source: payload.source,
    sessions: [],
    truncated: true,
    snapshot: {
      ...snap,
      convId: snap.convId,
      shortId: snap.shortId,
      title: clipUtf8Bytes(snap.title, 96),
      model: clipUtf8Bytes(snap.model, 64),
      workspace: clipUtf8Bytes(snap.workspace, 96),
      ageLabel: clipUtf8Bytes(snap.ageLabel, 24),
      siblingCandidates: [],
      siblingHint: '',
      runningTools: [],
      completedTools: [],
      skills: [],
      mcps: [],
      agents: [],
      todos: null,
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
  for (const tier of TRIM_TIERS) {
    const candidate = applyTrimTier(payload, tier);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) {
      return candidate;
    }
  }
  const compact = buildMinimalTruncatedSnapshot(payload);
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= maxBytes) {
    return compact;
  }
  return {
    unchanged: false,
    etag: clipUtf8Bytes(payload.etag, 64),
    source: payload.source,
    sessions: [],
    snapshot: null,
    truncated: true,
  };
}

function clipTextForJsonBudget(value: string, maxJsonBytes: number): string {
  if (maxJsonBytes <= 2) return '';
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxJsonBytes) return value;
  let lo = 0;
  let hi = Math.min(Buffer.byteLength(value, 'utf8'), maxJsonBytes);
  let best = '';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = clipUtf8Bytes(value, mid);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxJsonBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function safeResponseId(id: JsonRpcId, maxBytes: number): JsonRpcId {
  const probe = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: '' } });
  return Buffer.byteLength(probe, 'utf8') + 128 <= maxBytes ? id : null;
}

function capRpcErrorResponse(response: JsonRpcErrorResponse, maxBytes: number): JsonRpcErrorResponse {
  const id = safeResponseId(response.id, maxBytes);
  const code = response.error.code;
  const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: '' } }), 'utf8');
  const budget = Math.max(2, maxBytes - overhead + 2);
  const message = clipTextForJsonBudget(response.error.message, budget);
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function extractToolErrorText(result: Record<string, unknown>): {
  message: string;
  code?: string;
  source?: string;
  sessionId?: string | null;
} {
  const structured = isPlainObject(result.structuredContent) ? result.structuredContent : null;
  const code = structured !== null && typeof structured.code === 'string' ? structured.code : undefined;
  const source = structured !== null && typeof structured.source === 'string' ? structured.source : undefined;
  const sessionId =
    structured !== null && (typeof structured.sessionId === 'string' || structured.sessionId === null)
      ? structured.sessionId
      : undefined;
  if (structured !== null && typeof structured.error === 'string' && structured.error.length > 0) {
    return { message: structured.error, code, source, sessionId };
  }
  if (Array.isArray(result.content) && isPlainObject(result.content[0]) && typeof result.content[0].text === 'string') {
    return { message: result.content[0].text, code, source, sessionId };
  }
  return { message: 'MCP tool error exceeded response size limit.', code, source, sessionId };
}

function capToolErrorResult(id: JsonRpcId, result: Record<string, unknown>, maxBytes: number): JsonRpcResponse {
  const safeId = safeResponseId(id, maxBytes);
  const { message, code, source, sessionId } = extractToolErrorText(result);
  const safeCode = code !== undefined ? clipUtf8Bytes(code, 64) : undefined;
  const safeSource = source !== undefined ? clipUtf8Bytes(source, 16) : undefined;
  const safeSessionId = typeof sessionId === 'string' ? clipUtf8Bytes(sessionId, 256) : sessionId;
  const build = (text: string): JsonRpcSuccessResponse => ({
    jsonrpc: '2.0',
    id: safeId,
    result: {
      isError: true,
      content: [{ type: 'text', text }],
      structuredContent: {
        error: text,
        ...(safeCode !== undefined ? { code: safeCode } : {}),
        ...(safeSource !== undefined ? { source: safeSource } : {}),
        ...(safeSessionId !== undefined ? { sessionId: safeSessionId } : {}),
        truncated: true,
      },
    },
  });
  const overhead = Buffer.byteLength(JSON.stringify(build('')), 'utf8');
  const perFieldBudget = Math.max(2, Math.floor((maxBytes - overhead + 4) / 2));
  const clipped = clipTextForJsonBudget(message, perFieldBudget);
  const candidate = build(clipped);
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) {
    return candidate;
  }
  return capRpcErrorResponse(
    { jsonrpc: '2.0', id: safeId, error: { code: -32603, message: 'MCP error response exceeded size limit.' } },
    maxBytes,
  );
}

export function capJsonRpcResponse(
  response: JsonRpcResponse,
  maxBytes: number = HARD_MAX_MCP_RESPONSE_BYTES,
): JsonRpcResponse {
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') <= maxBytes) {
    return response;
  }
  if ('error' in response) {
    return capRpcErrorResponse(response, maxBytes);
  }
  if (isPlainObject(response.result) && response.result.isError === true) {
    return capToolErrorResult(response.id, response.result, maxBytes);
  }
  return capRpcErrorResponse(
    { jsonrpc: '2.0', id: response.id, error: { code: -32603, message: 'MCP response exceeded 1 MiB size limit.' } },
    maxBytes,
  );
}
