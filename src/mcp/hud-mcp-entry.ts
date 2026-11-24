#!/usr/bin/env node
import { SessionResolutionError } from '../collectors/session-index.ts';
import { isPlainObject } from '../core/guards.ts';
import { isMainEntry } from '../core/paths.ts';
import { fmtTokens } from '../render/ansi.ts';
import type { SessionSourceFilter } from '../snapshot-types.ts';
import { buildInspectorHtml, INSPECTOR_MIME_TYPE, INSPECTOR_RESOURCE_URI } from './hud-inspector-ui.ts';
import {
  pollHudSnapshot,
  type HudPollArgs,
  type HudPollOptions,
  type HudPollSnapshotData,
} from './hud-mcp-snapshot.ts';

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'agy-hud-inspector';
const SERVER_VERSION = '0.1.0';
const VALID_SOURCES: ReadonlySet<string> = new Set(['auto', 'cli', 'app', 'all']);

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

export interface McpServerContext extends HudPollOptions {}

const MCP_TOOLS = [
  {
    name: 'hud_inspector',
    title: 'HUD Inspector',
    description: 'Open interactive HUD Inspector displaying live session telemetry and Activity Snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session ID or prefix.' },
        source: {
          type: 'string',
          enum: ['auto', 'cli', 'app', 'all'],
          description: 'Optional session surface filter.',
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: {
        resourceUri: INSPECTOR_RESOURCE_URI,
        visibility: ['app'],
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'HUD Inspector' },
          { type: 'global', title: 'HUD Inspector' },
        ],
      },
    },
  },
  {
    name: 'hud_poll_snapshot',
    title: 'Poll HUD Snapshot',
    description: 'Poll read-only cross-surface Activity Snapshot and telemetry with ETag short-circuiting.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session ID or prefix.' },
        source: {
          type: 'string',
          enum: ['auto', 'cli', 'app', 'all'],
          description: 'Optional session surface filter.',
        },
        etag: { type: 'string', description: 'Previous snapshot ETag for unchanged short-circuit.' },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
] as const;

const MCP_RESOURCES = [
  {
    uri: INSPECTOR_RESOURCE_URI,
    name: 'HUD Inspector',
    description: 'Self-contained HUD Inspector MCP App UI (Variant A - Swarm-Native Tabs).',
    mimeType: INSPECTOR_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
] as const;

function makeRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

function makeRpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function parsePollToolArgs(
  raw: unknown,
  allowEtag: boolean,
): { ok: true; args: HudPollArgs } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, args: {} };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Tool arguments must be an object.' };
  }
  const args: HudPollArgs = {};
  if (raw.sessionId !== undefined) {
    if (typeof raw.sessionId !== 'string') {
      return { ok: false, error: 'sessionId must be a string.' };
    }
    args.sessionId = raw.sessionId;
  }
  if (raw.source !== undefined) {
    if (typeof raw.source !== 'string' || !VALID_SOURCES.has(raw.source)) {
      return { ok: false, error: 'source must be one of: auto, cli, app, all.' };
    }
    args.source = raw.source as SessionSourceFilter;
  }
  if (allowEtag && raw.etag !== undefined) {
    if (typeof raw.etag !== 'string') {
      return { ok: false, error: 'etag must be a string.' };
    }
    args.etag = raw.etag;
  }
  return { ok: true, args };
}

function formatInspectorFallbackText(payload: HudPollSnapshotData): string {
  const snap = payload.snapshot;
  if (snap === null) {
    return 'HUD Inspector: no local Antigravity sessions found.';
  }
  const badge = snap.surface.toUpperCase();
  const tel = snap.telemetry;
  const parts: string[] = [`[${badge}] ${snap.title} (${snap.shortId})`];
  if (tel.ctxPct !== null) {
    const used = fmtTokens(tel.ctxUsed) || '0';
    const max = fmtTokens(tel.ctxMax) || '?';
    parts.push(`Ctx ${tel.ctxPct.toFixed(0)}% (${used}/${max})`);
  }
  if (tel.tps !== null) {
    parts.push(`TPS ${tel.tps.toFixed(0)}`);
  }
  if (tel.cachePct !== null) {
    parts.push(`Cache ${tel.cachePct.toFixed(0)}%`);
  }
  parts.push(`${snap.completedTools.length} tools (${snap.totalToolCalls} calls)`);
  if (snap.skills.length > 0) parts.push(`${snap.skills.length} skills`);
  if (snap.mcps.length > 0) parts.push(`${snap.mcps.length} MCPs`);
  if (snap.agents.length > 0) parts.push(`${snap.agents.length} ${snap.agentsKind}`);
  return parts.join(' | ');
}

function handleToolsCall(id: JsonRpcId, params: unknown, ctx: McpServerContext): JsonRpcResponse {
  if (!isPlainObject(params) || typeof params.name !== 'string') {
    return makeRpcError(id, -32602, 'Invalid params: tool name is required.');
  }
  const toolName = params.name;
  if (toolName !== 'hud_inspector' && toolName !== 'hud_poll_snapshot') {
    return makeRpcError(id, -32602, `Unknown tool: ${toolName}`);
  }

  const parsedArgs = parsePollToolArgs(params.arguments, toolName === 'hud_poll_snapshot');
  if (!parsedArgs.ok) {
    return makeRpcResult(id, {
      isError: true,
      content: [{ type: 'text', text: parsedArgs.error }],
      structuredContent: { error: parsedArgs.error },
    });
  }

  try {
    const pollResult = pollHudSnapshot(parsedArgs.args, ctx);
    if (pollResult.unchanged) {
      return makeRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(pollResult) }],
        structuredContent: pollResult,
      });
    }
    return makeRpcResult(id, {
      content: [{ type: 'text', text: formatInspectorFallbackText(pollResult) }],
      structuredContent: pollResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof SessionResolutionError ? err.code : 'internal-error';
    return makeRpcResult(id, {
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: { error: message, code },
    });
  }
}

function handleResourcesRead(id: JsonRpcId, params: unknown): JsonRpcResponse {
  if (!isPlainObject(params) || typeof params.uri !== 'string') {
    return makeRpcError(id, -32602, 'Invalid params: resource uri is required.');
  }
  if (params.uri !== INSPECTOR_RESOURCE_URI) {
    return makeRpcError(id, -32002, `Resource not found: ${params.uri}`);
  }
  return makeRpcResult(id, {
    contents: [
      {
        uri: INSPECTOR_RESOURCE_URI,
        mimeType: INSPECTOR_MIME_TYPE,
        text: buildInspectorHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  });
}

function parseJsonRpcId(raw: unknown): JsonRpcId | undefined {
  if (raw === null || typeof raw === 'string' || typeof raw === 'number') {
    return raw;
  }
  return undefined;
}

export function handleMcpMessage(raw: unknown, ctx: McpServerContext = {}): JsonRpcResponse | null {
  if (!isPlainObject(raw) || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string') {
    return makeRpcError(null, -32600, 'Invalid JSON-RPC 2.0 request.');
  }
  const hasId = 'id' in raw && raw.id !== undefined;
  const id = hasId ? parseJsonRpcId(raw.id) : undefined;
  if (hasId && id === undefined) {
    return makeRpcError(null, -32600, 'Invalid JSON-RPC id.');
  }

  if (!hasId) {
    return null;
  }

  const reqId: JsonRpcId = id ?? null;
  switch (raw.method) {
    case 'initialize': {
      const clientVer =
        isPlainObject(raw.params) &&
        typeof raw.params.protocolVersion === 'string' &&
        raw.params.protocolVersion.trim().length > 0
          ? raw.params.protocolVersion.trim()
          : DEFAULT_PROTOCOL_VERSION;
      return makeRpcResult(reqId, {
        protocolVersion: clientVer,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
    }
    case 'ping':
      return makeRpcResult(reqId, {});
    case 'tools/list':
      return makeRpcResult(reqId, { tools: MCP_TOOLS });
    case 'tools/call':
      return handleToolsCall(reqId, raw.params, ctx);
    case 'resources/list':
      return makeRpcResult(reqId, { resources: MCP_RESOURCES });
    case 'resources/read':
      return handleResourcesRead(reqId, raw.params);
    default:
      return makeRpcError(reqId, -32601, `Method not found: ${raw.method}`);
  }
}

export function createMcpLineHandler(ctx: McpServerContext = {}): (line: string) => string | null {
  return (line: string): string | null => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return JSON.stringify(makeRpcError(null, -32700, 'Parse error'));
    }
    const response = handleMcpMessage(parsed, ctx);
    return response !== null ? JSON.stringify(response) : null;
  };
}

export function runMcpStdioServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  ctx: McpServerContext = {},
): Promise<void> {
  const handleLine = createMcpLineHandler(ctx);
  return new Promise((resolve) => {
    let buffer = '';
    const flushLine = (line: string): void => {
      try {
        const reply = handleLine(line);
        if (reply !== null) {
          output.write(`${reply}\n`);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agy-hud-mcp] unhandled request error: ${detail}\n`);
      }
    };

    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let nlIdx = buffer.indexOf('\n');
      while (nlIdx !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        flushLine(line);
        nlIdx = buffer.indexOf('\n');
      }
    });
    input.on('end', () => {
      if (buffer.trim().length > 0) {
        flushLine(buffer);
      }
      resolve();
    });
    input.on('error', (err) => {
      process.stderr.write(`[agy-hud-mcp] stdin error: ${err.message}\n`);
      resolve();
    });
  });
}

if (isMainEntry(import.meta.url)) {
  runMcpStdioServer().catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agy-hud-mcp] fatal error: ${detail}\n`);
    process.exitCode = 1;
  });
}
