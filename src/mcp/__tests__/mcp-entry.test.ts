import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { INSPECTOR_MIME_TYPE, INSPECTOR_RESOURCE_URI } from '../hud-inspector-ui.ts';
import { HARD_MAX_MCP_RESPONSE_BYTES } from '../hud-mcp-cap.ts';
import { handleMcpMessage, runMcpStdioServer } from '../hud-mcp-entry.ts';
import type { HudPollSnapshotData } from '../hud-mcp-snapshot.ts';

function seedMinimalAppSession(appRoot: string, wsDir: string, convId: string, title: string): void {
  const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    `${JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      created_at: '2026-06-01T11:58:00Z',
      tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'main.ts') } }],
    })}\n`,
    'utf8',
  );

  const summaryDb = new DatabaseSync(path.join(appRoot, 'conversation_summaries.db'));
  summaryDb.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      last_modified_time TEXT,
      workspace_uris TEXT,
      source TEXT,
      not_fully_idle INTEGER DEFAULT 0,
      status TEXT,
      nesting_depth INTEGER DEFAULT 0,
      killed INTEGER DEFAULT 0
    )
  `);
  summaryDb
    .prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      convId,
      title,
      '2026-06-01T11:59:50Z',
      JSON.stringify([pathToFileURL(wsDir).href]),
      'CORTEX_TRAJECTORY_SOURCE_CLIENT',
      1,
      'CASCADE_RUN_STATUS_RUNNING',
      0,
      0,
    );
  summaryDb.close();
}

void describe('hud-mcp-entry JSON-RPC 2.0 MCP server', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-mcp-srv-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    wsDir = path.join(tmpRoot, 'project');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('negotiates MCP initialize capabilities', () => {
    const initRes = handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1.0' } },
    });
    assert.ok(initRes !== null && 'result' in initRes);
    const result = initRes.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, '2025-06-18');
    const caps = result.capabilities as Record<string, unknown>;
    assert.ok(caps.tools !== undefined);
    assert.ok(caps.resources !== undefined);
  });

  void it('ignores JSON-RPC notifications without an id', () => {
    assert.equal(handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  void it('responds to ping requests with an empty result object', () => {
    assert.deepEqual(handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }), {
      jsonrpc: '2.0',
      id: 2,
      result: {},
    });
  });

  void it('lists only app-only hud_inspector and hud_poll_snapshot tools', () => {
    const res = handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.ok(res !== null && 'result' in res);
    const tools = (res.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['hud_inspector', 'hud_poll_snapshot'],
    );
    assert.deepEqual(tools[0]?._meta, {
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
    });
    assert.deepEqual(tools[1]?._meta, { ui: { visibility: ['app'] } });
  });

  void it('lists ui://agy-hud/inspector.html as text/html;profile=mcp-app', () => {
    const listRes = handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    assert.ok(listRes !== null && 'result' in listRes);
    const resources = (listRes.result as { resources: Array<Record<string, unknown>> }).resources;
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.uri, INSPECTOR_RESOURCE_URI);
    assert.equal(resources[0]?.mimeType, INSPECTOR_MIME_TYPE);
  });

  void it('reads ui://agy-hud/inspector.html document text', () => {
    const readRes = handleMcpMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: INSPECTOR_RESOURCE_URI },
    });
    assert.ok(readRes !== null && 'result' in readRes);
    const contents = (readRes.result as { contents: Array<Record<string, unknown>> }).contents;
    assert.equal(contents.length, 1);
    assert.equal(contents[0]?.uri, INSPECTOR_RESOURCE_URI);
    assert.equal(contents[0]?.mimeType, INSPECTOR_MIME_TYPE);
    assert.ok(typeof contents[0]?.text === 'string' && contents[0].text.startsWith('<!DOCTYPE html>'));
  });

  void it('rejects unknown resource URIs with -32002', () => {
    const missingRes = handleMcpMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri: 'ui://agy-hud/missing.html' },
    });
    assert.ok(missingRes !== null && 'error' in missingRes);
    assert.equal(missingRes.error.code, -32002);
  });

  void it('serves tools/call for hud_inspector with structured snapshot content', () => {
    const convId = 'app-rpc-87654321';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    seedMinimalAppSession(appRoot, wsDir, convId, 'RPC Session');
    const ctx = { cliHome, geminiRoot, cwd: wsDir, nowMs };

    const openRes = handleMcpMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hud_inspector', arguments: {} } },
      ctx,
    );
    assert.ok(openRes !== null && 'result' in openRes);
    const openResult = openRes.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: HudPollSnapshotData;
    };
    assert.equal(openResult.content[0]?.type, 'text');
    assert.ok(openResult.content[0]?.text.includes('RPC Session'));
    assert.equal(openResult.structuredContent.snapshot?.convId, convId);
  });

  void it('short-circuits tools/call for hud_poll_snapshot when ETag matches', () => {
    const convId = 'app-rpc-87654321';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    seedMinimalAppSession(appRoot, wsDir, convId, 'RPC Session');
    const ctx = { cliHome, geminiRoot, cwd: wsDir, nowMs };

    const openRes = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'hud_inspector', arguments: { sessionId: convId } },
      },
      ctx,
    );
    assert.ok(openRes !== null && 'result' in openRes);
    const etag = (openRes.result as { structuredContent: HudPollSnapshotData }).structuredContent.etag;

    const pollRes = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'hud_poll_snapshot', arguments: { sessionId: convId, etag } },
      },
      ctx,
    );
    assert.ok(pollRes !== null && 'result' in pollRes);
    const pollResult = pollRes.result as { structuredContent: { unchanged: boolean; etag: string } };
    assert.deepEqual(pollResult.structuredContent, { unchanged: true, etag });
  });

  void it('rejects unknown tool arguments on hud_poll_snapshot', () => {
    const ctx = { cliHome, geminiRoot, cwd: wsDir };
    const unknownKey = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'hud_poll_snapshot', arguments: { session_id: 'abc' } },
      },
      ctx,
    );
    assert.ok(unknownKey !== null && 'result' in unknownKey);
    assert.equal((unknownKey.result as { isError?: boolean }).isError, true);
  });

  void it('rejects etag argument on hud_inspector', () => {
    const ctx = { cliHome, geminiRoot, cwd: wsDir };
    const etagOnInspector = handleMcpMessage(
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'hud_inspector', arguments: { etag: 'x' } } },
      ctx,
    );
    assert.ok(etagOnInspector !== null && 'result' in etagOnInspector);
    assert.equal((etagOnInspector.result as { isError?: boolean }).isError, true);
  });

  void it('rejects blank sessionId values on hud_poll_snapshot', () => {
    const ctx = { cliHome, geminiRoot, cwd: wsDir };
    const blankSession = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'hud_poll_snapshot', arguments: { sessionId: '   ' } },
      },
      ctx,
    );
    assert.ok(blankSession !== null && 'result' in blankSession);
    assert.equal((blankSession.result as { isError?: boolean }).isError, true);
  });

  void it('includes requested sessionId and source in structured tool error payloads', () => {
    const ctx = { cliHome, geminiRoot, cwd: wsDir };
    const missing = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: { name: 'hud_inspector', arguments: { sessionId: 'missing-session-9999', source: 'cli' } },
      },
      ctx,
    );
    assert.ok(missing !== null && 'result' in missing);
    const result = missing.result as {
      isError?: boolean;
      structuredContent: { error: string; code: string; sessionId?: string | null; source?: string };
    };
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'not-found');
    assert.equal(result.structuredContent.sessionId, 'missing-session-9999');
    assert.equal(result.structuredContent.source, 'cli');
  });

  void it('disables fileUri when a tool target has a trailing newline colliding with an existing file', () => {
    const convId = 'app-newline-uri-9999';
    const decoyPath = path.join(wsDir, 'ab.ts');
    writeFileSync(decoyPath, 'export const decoy = true;\n', 'utf8');
    seedMinimalAppSession(appRoot, wsDir, convId, 'Trailing Newline Target');
    const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: `${decoyPath}\n` } }],
      })}\n`,
      'utf8',
    );
    const ctx = { cliHome, geminiRoot, cwd: wsDir, nowMs: Date.parse('2026-06-01T12:00:00Z') };
    const rpcRes = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: { name: 'hud_poll_snapshot', arguments: { sessionId: convId, source: 'all' } },
      },
      ctx,
    );
    assert.ok(rpcRes !== null && 'result' in rpcRes);
    const payload = (rpcRes.result as { structuredContent: HudPollSnapshotData }).structuredContent;
    const readTool = payload.snapshot?.completedTools.find((t) => t.disp === 'read_file');
    assert.ok(readTool !== undefined);
    assert.deepEqual(readTool.targetUris, {});
  });

  void it('rejects sessionId arguments exceeding 128 characters', () => {
    const ctx = { cliHome, geminiRoot, cwd: wsDir };
    const overlong = 'a'.repeat(129);
    const res = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: { name: 'hud_poll_snapshot', arguments: { sessionId: overlong } },
      },
      ctx,
    );
    assert.ok(res !== null && 'result' in res);
    const result = res.result as { isError?: boolean; structuredContent: { error: string } };
    assert.equal(result.isError, true);
    assert.ok(result.structuredContent.error.includes('128'));
  });

  void it('redacts internal error messages without leaking local filesystem paths', () => {
    const secretPath = path.join(tmpRoot, 'secret-internal-dir');
    const throwingCtx = {
      cliHome,
      geminiRoot,
      get cwd(): string {
        throw new Error(`EACCES: permission denied, open '${secretPath}/private.db'`);
      },
    };
    const res = handleMcpMessage(
      { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'hud_poll_snapshot', arguments: {} } },
      throwingCtx,
    );
    assert.ok(res !== null && 'result' in res);
    const result = res.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: { error: string; code: string };
    };
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'internal-error');
    assert.equal(result.structuredContent.error.includes(secretPath), false);
    assert.equal(result.content[0]?.text.includes(secretPath), false);
  });

  void it('rejects unknown tool calls with -32602', () => {
    const unknownTool = handleMcpMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
      { cliHome, geminiRoot, cwd: wsDir },
    );
    assert.ok(unknownTool !== null && 'error' in unknownTool);
    assert.equal(unknownTool.error.code, -32602);
  });

  void it('streams chunked newline-delimited JSON-RPC messages over stdio', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (buf: Buffer) => {
      chunks.push(buf.toString('utf8'));
    });

    const done = runMcpStdioServer(input, output, { cliHome, geminiRoot, cwd: wsDir });
    const req1 = JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' });
    input.write(req1.slice(0, 12));
    input.write(`${req1.slice(12)}\n`);
    input.write('{bad-json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.end();
    await done;

    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { jsonrpc: '2.0', id: 10, result: {} });
    assert.equal((lines[1]?.error as Record<string, unknown> | undefined)?.code, -32700);
  });

  void it('detaches stdin listeners when stdio server finishes on end', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runMcpStdioServer(input, output, { cliHome, geminiRoot, cwd: wsDir });
    input.end();
    await done;

    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.listenerCount('end'), 0);
    assert.equal(input.listenerCount('error'), 0);
  });

  void it('detaches stdin listeners when stdio server settles on error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runMcpStdioServer(input, output, { cliHome, geminiRoot, cwd: wsDir });
    input.emit('error', new Error('simulated stdin failure'));
    await done;

    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.listenerCount('end'), 0);
    assert.equal(input.listenerCount('error'), 0);
  });

  void it('rejects oversized stdio frames exceeding 1 MiB and recovers cleanly on the next newline', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (buf: Buffer) => {
      chunks.push(buf.toString('utf8'));
    });

    const done = runMcpStdioServer(input, output, { cliHome, geminiRoot, cwd: wsDir });
    const oversizedValidJson = JSON.stringify({
      jsonrpc: '2.0',
      id: 98,
      method: 'ping',
      params: { pad: 'a'.repeat(HARD_MAX_MCP_RESPONSE_BYTES + 256) },
    });
    const chunkSize = 300_000;
    for (let pos = 0; pos < oversizedValidJson.length; pos += chunkSize) {
      input.write(oversizedValidJson.slice(pos, pos + chunkSize));
    }
    input.write('\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' })}\n`);
    input.end();
    await done;

    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.equal((lines[0]?.error as Record<string, unknown> | undefined)?.code, -32600);
    assert.deepEqual(lines[1], { jsonrpc: '2.0', id: 99, result: {} });
  });

  void it('emits a bounded -32600 error when an unterminated oversized stdio frame hits EOF', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (buf: Buffer) => {
      chunks.push(buf.toString('utf8'));
    });

    const done = runMcpStdioServer(input, output, { cliHome, geminiRoot, cwd: wsDir });
    input.write('x'.repeat(HARD_MAX_MCP_RESPONSE_BYTES + 128));
    input.end();
    await done;

    const lines = chunks
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 1);
    assert.equal((lines[0]?.error as Record<string, unknown> | undefined)?.code, -32600);
  });
});
