#!/usr/bin/env node
import { SessionResolutionError } from '../collectors/session-index.ts';
import { isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { isMainEntry } from '../core/paths.ts';
import { fmtTokens } from '../render/ansi.ts';
import { buildInspectorHtml, INSPECTOR_MIME_TYPE, INSPECTOR_RESOURCE_URI } from './hud-inspector-ui.ts';
import {
  capJsonRpcResponse,
  clipUtf8Bytes,
  HARD_MAX_MCP_RESPONSE_BYTES,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
} from './hud-mcp-cap.ts';
import {
  extractErrorCorrelation,
  MCP_INSPECTOR_VERSION,
  MCP_RESOURCES,
  MCP_TOOLS,
  parsePollToolArgs,
} from './hud-mcp-schema.ts';
import {
  capInspectorPayload,
  pollHudSnapshot,
  type HudPollOptions,
  type HudPollSnapshotData,
} from './hud-mcp-snapshot.ts';

export type { JsonRpcErrorObject, JsonRpcErrorResponse, JsonRpcId, JsonRpcResponse, JsonRpcSuccessResponse };

const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'agy-hud-inspector';
const SERVER_VERSION = MCP_INSPECTOR_VERSION;
const MAX_MCP_REQUEST_BYTES = HARD_MAX_MCP_RESPONSE_BYTES;
const OVERSIZED_REQUEST_REPLY = JSON.stringify(
  makeRpcError(null, -32600, 'Invalid Request: message exceeds 1 MiB limit'),
);

export interface McpServerContext extends HudPollOptions {}

function makeRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

function makeRpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function formatInspectorFallbackText(payload: HudPollSnapshotData): string {
  const snap = payload.snapshot;
  if (snap === null) {
    return payload.truncated === true
      ? 'HUD Inspector: snapshot truncated to fit 1 MiB response limit.'
      : 'HUD Inspector: no local Antigravity sessions found.';
  }
  const badge = snap.surface.toUpperCase();
  const tel = snap.telemetry;
  const parts: string[] = [`[${badge}] ${clipUtf8Bytes(snap.title, 160)} (${clipUtf8Bytes(snap.shortId, 24)})`];
  if (tel.ctxPct !== null) {
    const used = nonEmptyStr(fmtTokens(tel.ctxUsed)) ?? '0';
    const max = nonEmptyStr(fmtTokens(tel.ctxMax)) ?? '?';
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
  if (payload.truncated === true) parts.push('[truncated]');
  return parts.join(' | ');
}

function buildCappedPollRpcResponse(id: JsonRpcId, payload: HudPollSnapshotData): JsonRpcSuccessResponse {
  const build = (data: HudPollSnapshotData): JsonRpcSuccessResponse =>
    makeRpcResult(id, {
      content: [{ type: 'text', text: formatInspectorFallbackText(data) }],
      structuredContent: data,
    });
  const initial = build(payload);
  if (Buffer.byteLength(JSON.stringify(initial), 'utf8') <= HARD_MAX_MCP_RESPONSE_BYTES) {
    return initial;
  }
  const wrapperBytes = Buffer.byteLength(
    JSON.stringify(
      makeRpcResult(id, {
        content: [{ type: 'text', text: formatInspectorFallbackText(payload) }],
        structuredContent: null,
      }),
    ),
    'utf8',
  );
  const remaining = Math.max(256, HARD_MAX_MCP_RESPONSE_BYTES - wrapperBytes - 64);
  return build(capInspectorPayload(payload, remaining));
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
      structuredContent: { error: parsedArgs.error, ...extractErrorCorrelation(params.arguments) },
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
    return buildCappedPollRpcResponse(id, pollResult);
  } catch (err) {
    const isKnownResolutionErr = err instanceof SessionResolutionError;
    const message = isKnownResolutionErr ? err.message : 'Failed to load HUD snapshot.';
    const code = isKnownResolutionErr ? err.code : 'internal-error';
    return makeRpcResult(id, {
      isError: true,
      content: [{ type: 'text', text: message }],
      structuredContent: {
        error: message,
        code,
        source: parsedArgs.args.source ?? 'auto',
        sessionId: parsedArgs.args.sessionId ?? null,
      },
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

function dispatchMcpMessage(raw: unknown, ctx: McpServerContext): JsonRpcResponse | null {
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

export function handleMcpMessage(raw: unknown, ctx: McpServerContext = {}): JsonRpcResponse | null {
  const response = dispatchMcpMessage(raw, ctx);
  return response !== null ? capJsonRpcResponse(response, HARD_MAX_MCP_RESPONSE_BYTES) : null;
}

function handleDecodedMcpLine(line: string, ctx: McpServerContext): string | null {
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
}

export function createMcpLineHandler(ctx: McpServerContext = {}): (line: string) => string | null {
  return (line: string): string | null => {
    if (Buffer.byteLength(line, 'utf8') > MAX_MCP_REQUEST_BYTES) return OVERSIZED_REQUEST_REPLY;
    return handleDecodedMcpLine(line, ctx);
  };
}

export function runMcpStdioServer(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  ctx: McpServerContext = {},
): Promise<void> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let droppingOversized = false;
    let settled = false;
    const writeReplySafe = (reply: string): void => {
      try {
        output.write(`${reply}\n`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agy-hud-mcp] output write error: ${detail}\n`);
      }
    };
    const flushLine = (line: string): void => {
      try {
        const reply = handleDecodedMcpLine(line, ctx);
        if (reply !== null) writeReplySafe(reply);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agy-hud-mcp] unhandled request error: ${detail}\n`);
      }
    };
    const emitOversized = (): void => {
      writeReplySafe(OVERSIZED_REQUEST_REPLY);
    };
    const onData = (rawChunk: Buffer | string): void => {
      const buf = typeof rawChunk === 'string' ? Buffer.from(rawChunk, 'utf8') : rawChunk;
      let offset = 0;
      while (offset < buf.length) {
        const nlIdx = buf.indexOf(0x0a, offset);
        if (droppingOversized) {
          if (nlIdx === -1) return;
          droppingOversized = false;
          emitOversized();
          offset = nlIdx + 1;
          continue;
        }
        const end = nlIdx === -1 ? buf.length : nlIdx;
        const segLen = end - offset;
        if (bufferedBytes + segLen > MAX_MCP_REQUEST_BYTES) {
          chunks = [];
          bufferedBytes = 0;
          if (nlIdx === -1) {
            droppingOversized = true;
            return;
          }
          emitOversized();
          offset = nlIdx + 1;
          continue;
        }
        const seg = buf.subarray(offset, end);
        if (nlIdx === -1) {
          if (seg.length > 0) {
            chunks.push(seg);
            bufferedBytes += seg.length;
          }
          return;
        }
        const lineBuf = chunks.length === 0 ? seg : Buffer.concat([...chunks, seg], bufferedBytes + seg.length);
        chunks = [];
        bufferedBytes = 0;
        flushLine(lineBuf.toString('utf8'));
        offset = nlIdx + 1;
      }
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      resolve();
    };
    const onEnd = (): void => {
      if (droppingOversized) emitOversized();
      else if (bufferedBytes > 0) {
        const tail = Buffer.concat(chunks, bufferedBytes).toString('utf8');
        if (tail.trim().length > 0) flushLine(tail);
      }
      finish();
    };
    const onError = (err: Error): void => {
      process.stderr.write(`[agy-hud-mcp] stdin error: ${err.message}\n`);
      finish();
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}

if (isMainEntry(import.meta.url)) {
  runMcpStdioServer().catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agy-hud-mcp] fatal error: ${detail}\n`);
    process.exitCode = 1;
  });
}
