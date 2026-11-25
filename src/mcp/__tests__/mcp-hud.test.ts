import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { writeSnapshotEnvelope } from '../../collectors/snapshot-envelope.ts';
import { handleMcpMessage } from '../hud-mcp-entry.ts';
import {
  capInspectorPayload,
  HARD_MAX_MCP_RESPONSE_BYTES,
  pollHudSnapshot,
  type HudPollSnapshotData,
} from '../hud-mcp-snapshot.ts';

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

  void it('loads read-only client sessions while writing caches only to cliHome', () => {
    const convId = 'app-mcp-12345678';
    const fileA = path.join(wsDir, 'src', 'index.ts');
    mkdirSync(path.dirname(fileA), { recursive: true });
    writeFileSync(fileA, 'export const ok = true;\n', 'utf8');
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

  void it('short-circuits with unchanged when the snapshot ETag matches', () => {
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
    seedAppSession(appRoot, wsDir, convId, 'ETag Test', initialLines);

    const first = pollHudSnapshot({ sessionId: convId }, { cliHome, geminiRoot, cwd: wsDir, nowMs });
    assert.equal(first.unchanged, false);
    assert.ok(first.snapshot !== null);
    assert.equal(first.snapshot.totalToolCalls, 1);

    const second = pollHudSnapshot(
      { sessionId: convId, etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 4000 },
    );
    assert.deepEqual(second, { unchanged: true, etag: first.etag });
  });

  void it('reloads snapshot data with a fresh ETag after transcript updates', () => {
    const convId = 'app-etag-reload-1234';
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

    const appended = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      created_at: '2026-06-01T11:59:55Z',
      tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'b.ts') } }],
    });
    writeFileSync(transcriptPath, `${initialLines.map((l) => JSON.stringify(l)).join('\n')}\n${appended}\n`, 'utf8');

    const updated = pollHudSnapshot(
      { sessionId: convId, etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 6000 },
    );
    assert.equal(updated.unchanged, false);
    assert.notEqual(updated.etag, first.etag);
    assert.ok(updated.snapshot !== null);
    assert.equal(updated.snapshot.totalToolCalls, 2);
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

  void it('caps oversized CJK title payloads strictly below 1 MiB with truncation marker', () => {
    const hugeCjkTitle = '中文超长会话标题测试'.repeat(45_000);
    assert.ok(Buffer.byteLength(hugeCjkTitle, 'utf8') > HARD_MAX_MCP_RESPONSE_BYTES);
    const convId = 'app-cjk-huge-1234';
    seedAppSession(appRoot, wsDir, convId, hugeCjkTitle, [
      {
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        created_at: '2026-06-01T11:58:00Z',
        tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'a.ts') } }],
      },
    ]);

    const rpcResponse = handleMcpMessage(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'hud_poll_snapshot', arguments: { source: 'all' } },
      },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: Date.parse('2026-06-01T12:00:00Z') },
    );
    assert.ok(rpcResponse !== null && 'result' in rpcResponse);
    const wireBytes = Buffer.byteLength(JSON.stringify(rpcResponse), 'utf8');
    assert.ok(wireBytes <= HARD_MAX_MCP_RESPONSE_BYTES, `expected <= 1 MiB, got ${wireBytes}`);
    const resultObj = rpcResponse.result as { structuredContent: HudPollSnapshotData };
    assert.equal(resultObj.structuredContent.truncated, true);
    assert.ok(resultObj.structuredContent.snapshot !== null);
  });

  void it('keeps MCP ETag unchanged across CLI snapshot envelope heartbeats', () => {
    const convId = 'cli-heartbeat-etag';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
      'utf8',
    );
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const data = { conversation_id: convId, conversation_title: 'Heartbeat CLI', cwd: wsDir };
    writeSnapshotEnvelope(cliHome, data, 4242, { nowMs: t0 });

    const first = pollHudSnapshot(
      { sessionId: convId, source: 'cli' },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: t0, isAlive: (p) => p === 4242 },
    );
    assert.equal(first.unchanged, false);

    // Heartbeat rewrites envelope after 40s with identical semantic fields.
    writeSnapshotEnvelope(cliHome, data, 4242, { nowMs: t0 + 40_000 });
    const second = pollHudSnapshot(
      { sessionId: convId, source: 'cli', etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: t0 + 41_000, isAlive: (p) => p === 4242 },
    );
    assert.deepEqual(second, { unchanged: true, etag: first.etag });
  });

  void it('omits fileView URIs for directories and nonexistent absolute paths', () => {
    const convId = 'app-uri-file-only-1234';
    const realFile = path.join(wsDir, 'src', 'real.ts');
    const dirTarget = path.join(wsDir, 'src');
    const missingFile = path.join(wsDir, 'src', 'does-not-exist.ts');
    mkdirSync(dirTarget, { recursive: true });
    writeFileSync(realFile, 'export const x = 1;\n', 'utf8');

    seedAppSession(appRoot, wsDir, convId, 'URI File Check', [
      {
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { name: 'read_file', args: { Path: realFile } },
          { name: 'read_file', args: { Path: dirTarget } },
          { name: 'read_file', args: { Path: missingFile } },
        ],
      },
      {
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        tool_calls: [{ name: 'read_file', args: { Path: dirTarget } }],
      },
    ]);

    const res = pollHudSnapshot(
      { sessionId: convId, source: 'all' },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: Date.parse('2026-06-01T12:00:00Z') },
    );
    assert.equal(res.unchanged, false);
    const readTool = res.snapshot?.completedTools.find((t) => t.disp === 'read_file');
    assert.equal(readTool?.targetUris[realFile], pathToFileURL(realFile).href);
    assert.equal(readTool?.targetUris[dirTarget], undefined);
    assert.equal(readTool?.targetUris[missingFile], undefined);
    assert.equal(res.snapshot?.runningTools[0]?.fileUri, null);
  });
});
