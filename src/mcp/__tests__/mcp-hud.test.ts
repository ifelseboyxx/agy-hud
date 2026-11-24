import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { INSPECTOR_MIME_TYPE, INSPECTOR_RESOURCE_URI } from '../hud-inspector-ui.ts';
import { handleMcpMessage, runMcpStdioServer } from '../hud-mcp-entry.ts';
import { capInspectorPayload, pollHudSnapshot, type HudPollSnapshotData } from '../hud-mcp-snapshot.ts';

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

function encodeFieldBytes(fieldNum: number, payload: number[]): number[] {
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(payload.length), ...payload];
}

function encodeFieldVarint(fieldNum: number, value: number): number[] {
  return [...encodeVarint((fieldNum << 3) | 0), ...encodeVarint(value)];
}

function buildGenBlob(opts: {
  inTok: number;
  outTok: number;
  crTok: number;
  ctxUsed: number;
  ctxMax: number;
}): Uint8Array {
  const usage = [
    ...encodeFieldVarint(2, opts.inTok),
    ...encodeFieldVarint(3, opts.outTok),
    ...encodeFieldVarint(5, opts.crTok),
  ];
  const ctxWin = [...encodeFieldVarint(1, opts.ctxUsed), ...encodeFieldVarint(4, opts.ctxMax)];
  const chatStart = encodeFieldBytes(10, ctxWin);
  const ttft = [...encodeFieldVarint(1, 1), ...encodeFieldVarint(2, 200_000_000)];
  const stream = [...encodeFieldVarint(1, 2), ...encodeFieldVarint(2, 0)];
  const chatModel = [
    ...encodeFieldBytes(4, usage),
    ...encodeFieldBytes(9, chatStart),
    ...encodeFieldBytes(11, ttft),
    ...encodeFieldBytes(12, stream),
  ];
  return new Uint8Array(encodeFieldBytes(1, chatModel));
}

function seedAppSession(
  appRoot: string,
  wsDir: string,
  convId: string,
  title: string,
  transcriptLines: readonly Record<string, unknown>[],
): string {
  const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  writeFileSync(transcriptPath, `${transcriptLines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

  const convDir = path.join(appRoot, 'conversations');
  mkdirSync(convDir, { recursive: true });
  const convDb = new DatabaseSync(path.join(convDir, `${convId}.db`));
  convDb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  convDb
    .prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
    .run(0, buildGenBlob({ inTok: 800, outTok: 200, crTok: 3200, ctxUsed: 120_000, ctxMax: 1_000_000 }));
  convDb.close();

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
    .prepare(
      `INSERT OR REPLACE INTO conversation_summaries
       (conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status, nesting_depth, killed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
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
  return transcriptPath;
}

void describe('hud-mcp-snapshot polling and ETag', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let wsDir = '';
  const chmodRestore: string[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-mcp-snap-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    wsDir = path.join(tmpRoot, 'project');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    for (const dir of chmodRestore.reverse()) {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // Ignore cleanup errors.
      }
    }
    chmodRestore.length = 0;
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('returns an empty payload when no local sessions exist', () => {
    const result = pollHudSnapshot({}, { cliHome, geminiRoot, cwd: wsDir, nowMs: Date.parse('2026-06-01T12:00:00Z') });
    assert.equal(result.unchanged, false);
    assert.equal(result.snapshot, null);
    assert.deepEqual(result.sessions, []);
    assert.ok(result.etag.length > 0);
  });

  void it('loads read-only 0o555 client session with caches only in cliHome and file:/// target URIs', () => {
    const convId = 'app-mcp-12345678';
    const fileA = path.join(wsDir, 'src', 'index.ts');
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    seedAppSession(appRoot, wsDir, convId, 'App Inspector Session', [
      { type: 'USER_INPUT', content: '/tdd' },
      {
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        created_at: '2026-06-01T11:58:00Z',
        tool_calls: [
          { name: 'read_file', args: { Path: fileA } },
          { name: 'run_command', args: { CommandLine: 'pnpm verify' } },
        ],
      },
    ]);

    const beforeAppRoot = readdirSync(appRoot).sort();
    const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
    const convDir = path.join(appRoot, 'conversations');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(logsDir, 0o555);
      chmodSync(convDir, 0o555);
      chmodSync(appRoot, 0o555);
      chmodRestore.push(appRoot, convDir, logsDir);
    }

    const result = pollHudSnapshot({ source: 'all' }, { cliHome, geminiRoot, cwd: wsDir, nowMs });
    assert.equal(result.unchanged, false);
    assert.ok(result.snapshot !== null);
    assert.equal(result.snapshot.convId, convId);
    assert.equal(result.snapshot.surface, 'app');
    assert.equal(result.snapshot.telemetry.ctxPct, 12);

    const readTool = result.snapshot.completedTools.find((t) => t.disp === 'read_file');
    assert.ok(readTool !== undefined);
    assert.equal(readTool.targetUris[fileA], pathToFileURL(fileA).href);
    const runTool = result.snapshot.completedTools.find((t) => t.disp === 'run_command');
    assert.ok(runTool !== undefined);
    assert.deepEqual(runTool.targetUris, {});

    assert.equal(existsSync(path.join(appRoot, 'cache')), false);
    assert.deepEqual(readdirSync(appRoot).sort(), beforeAppRoot);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`)), true);
  });

  void it('short-circuits with unchanged when ETag matches and reloads after transcript update', () => {
    const convId = 'app-etag-12345678';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const initialLines = [
      {
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        created_at: '2026-06-01T11:58:00Z',
        tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'a.ts') } }],
      },
    ];
    const transcriptPath = seedAppSession(appRoot, wsDir, convId, 'ETag Test', initialLines);

    const first = pollHudSnapshot({ sessionId: convId }, { cliHome, geminiRoot, cwd: wsDir, nowMs });
    assert.equal(first.unchanged, false);
    assert.ok(first.snapshot !== null);
    assert.equal(first.snapshot.totalToolCalls, 1);

    const second = pollHudSnapshot(
      { sessionId: convId, etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 4000 },
    );
    assert.deepEqual(second, { unchanged: true, etag: first.etag });

    const appended = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      created_at: '2026-06-01T11:59:55Z',
      tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'b.ts') } }],
    });
    writeFileSync(transcriptPath, `${initialLines.map((l) => JSON.stringify(l)).join('\n')}\n${appended}\n`, 'utf8');

    const third = pollHudSnapshot(
      { sessionId: convId, etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 6000 },
    );
    assert.equal(third.unchanged, false);
    assert.notEqual(third.etag, first.etag);
    assert.ok(third.snapshot !== null);
    assert.equal(third.snapshot.totalToolCalls, 2);
  });

  void it('caps oversized snapshot payloads deterministically below 1 MiB', () => {
    const hugeTarget = `/workspace/${'a'.repeat(400)}/file.ts`;
    const bigTools = Array.from({ length: 600 }, (_, i) => ({
      disp: `tool_${String(i).padStart(4, '0')}`,
      count: 600 - i,
      latestTarget: `file_${i}.ts`,
      fullTarget: `${hugeTarget}?${i}`,
      recentTargets: Array.from({ length: 6 }, (__, j) => `${hugeTarget}_${i}_${j}`),
      targetUris: { [hugeTarget]: `file://${hugeTarget}` },
      isMcp: false,
    }));
    const rawPayload: HudPollSnapshotData = {
      unchanged: false,
      etag: 'test-etag',
      source: 'auto',
      sessions: [],
      snapshot: {
        convId: 'huge-session-1234',
        shortId: 'huge-ses',
        surface: 'app',
        title: 'Oversized Snapshot',
        model: 'Gemini 4 Carbon',
        workspace: '/workspace',
        resolutionTier: 'explicit',
        running: false,
        updatedAtMs: 1_700_000_000_000,
        ageLabel: '1s ago',
        livePid: null,
        siblingCandidates: [],
        siblingHint: '',
        telemetry: {
          genCount: 1,
          tps: 80,
          ttft: 1.2,
          cachePct: 90,
          ctxUsed: 100_000,
          ctxMax: 1_000_000,
          ctxPct: 10,
        },
        runningTools: [],
        completedTools: bigTools,
        totalToolCalls: 180_000,
        skills: Array.from({ length: 400 }, (_, i) => `skill-${i}-${'s'.repeat(60)}`),
        mcps: [],
        agentsKind: 'agents',
        agents: [],
        todos: null,
      },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(rawPayload), 'utf8') > 1_048_576);

    const capped = capInspectorPayload(rawPayload);
    const finalBytes = Buffer.byteLength(JSON.stringify(capped), 'utf8');
    assert.ok(finalBytes < 1_048_576, `expected < 1 MiB, got ${finalBytes}`);
    assert.equal(capped.truncated, true);
  });
});

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

  void it('negotiates initialize capabilities, ignores notifications, and responds to ping', () => {
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

    const notifRes = handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notifRes, null);

    const pingRes = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual(pingRes, { jsonrpc: '2.0', id: 2, result: {} });
  });

  void it('exposes only app-only hud_inspector and hud_poll_snapshot tools with aux_pane and global entrypoints', () => {
    const res = handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.ok(res !== null && 'result' in res);
    const tools = (res.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['hud_inspector', 'hud_poll_snapshot'],
    );

    const inspector = tools[0];
    assert.ok(inspector !== undefined);
    assert.deepEqual(inspector._meta, {
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

    const poller = tools[1];
    assert.ok(poller !== undefined);
    assert.deepEqual(poller._meta, {
      ui: { visibility: ['app'] },
    });
  });

  void it('lists and reads ui://agy-hud/inspector.html as text/html;profile=mcp-app and rejects unknown URIs', () => {
    const listRes = handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    assert.ok(listRes !== null && 'result' in listRes);
    const resources = (listRes.result as { resources: Array<Record<string, unknown>> }).resources;
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.uri, INSPECTOR_RESOURCE_URI);
    assert.equal(resources[0]?.mimeType, INSPECTOR_MIME_TYPE);

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

    const missingRes = handleMcpMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri: 'ui://agy-hud/missing.html' },
    });
    assert.ok(missingRes !== null && 'error' in missingRes);
    assert.equal(missingRes.error.code, -32002);
  });

  void it('serves tools/call for hud_inspector and ETag short-circuit for hud_poll_snapshot', () => {
    const convId = 'app-rpc-87654321';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    seedAppSession(appRoot, wsDir, convId, 'RPC Session', [
      {
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        created_at: '2026-06-01T11:58:00Z',
        tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'main.ts') } }],
      },
    ]);
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

    const etag = openResult.structuredContent.etag;
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

    const unknownTool = handleMcpMessage(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
      ctx,
    );
    assert.ok(unknownTool !== null && 'error' in unknownTool);
    assert.equal(unknownTool.error.code, -32602);
  });

  void it('streams chunked newline-delimited JSON-RPC messages over stdio and reports parse errors cleanly', async () => {
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
});
