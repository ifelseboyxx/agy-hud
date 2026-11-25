import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { writeSnapshotEnvelope } from '../../collectors/snapshot-envelope.ts';
import { createMcpLineHandler, handleMcpMessage } from '../hud-mcp-entry.ts';
import {
  capInspectorPayload,
  HARD_MAX_MCP_RESPONSE_BYTES,
  pollHudSnapshot,
  type HudPollSnapshotData,
} from '../hud-mcp-snapshot.ts';

function writeSummaryRow(rootDir: string, convId: string, title: string, wsDir: string, lastModifiedIso: string): void {
  mkdirSync(rootDir, { recursive: true });
  const db = new DatabaseSync(path.join(rootDir, 'conversation_summaries.db'));
  db.exec(`
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
  db.prepare(
    `INSERT OR REPLACE INTO conversation_summaries
     (conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status, nesting_depth, killed)
     VALUES (?, ?, ?, ?, 'CORTEX_TRAJECTORY_SOURCE_CLIENT', 0, 'CASCADE_RUN_STATUS_IDLE', 0, 0)`,
  ).run(convId, title, lastModifiedIso, JSON.stringify([pathToFileURL(wsDir).href]));
  db.close();
}

void describe('MCP ETag stability, invalidation, and JSON-RPC error byte cap', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-mcp-etag-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    wsDir = path.join(tmpRoot, 'ws');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('keeps ETag stable across pure CLI heartbeats without reordering sessions', () => {
    const tOlder = Date.parse('2026-06-01T12:00:00Z');
    const tNewer = Date.parse('2026-06-01T12:01:00Z');
    const olderId = 'cli-idle-older-1111';
    const newerId = 'cli-idle-newer-2222';
    const olderData = { conversation_id: olderId, conversation_title: 'Older CLI', cwd: wsDir };
    const newerData = { conversation_id: newerId, conversation_title: 'Newer CLI', cwd: wsDir };

    for (const [id, ts] of [
      [olderId, tOlder],
      [newerId, tNewer],
    ] as const) {
      const logs = path.join(cliHome, 'brain', id, '.system_generated', 'logs');
      mkdirSync(logs, { recursive: true });
      const tPath = path.join(logs, 'transcript.jsonl');
      writeFileSync(tPath, `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`, 'utf8');
      utimesSync(tPath, new Date(ts), new Date(ts));
    }
    writeSnapshotEnvelope(cliHome, olderData, 4101, { nowMs: tOlder });
    writeSnapshotEnvelope(cliHome, newerData, 4102, { nowMs: tNewer });

    const isAlive = (pid: number): boolean => pid === 4101 || pid === 4102;
    const first = pollHudSnapshot(
      { source: 'cli' },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: tNewer + 1000, isAlive },
    );
    assert.equal(first.unchanged, false);
    assert.equal(first.snapshot?.convId, newerId);
    assert.deepEqual(
      first.sessions.map((s) => s.convId),
      [newerId, olderId],
    );

    // Pure heartbeat on older idle session 40s later must NOT reorder list, flip default, or change ETag.
    writeSnapshotEnvelope(cliHome, olderData, 4101, { nowMs: tNewer + 40_000 });
    const second = pollHudSnapshot(
      { source: 'cli', etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: tNewer + 41_000, isAlive },
    );
    assert.deepEqual(second, { unchanged: true, etag: first.etag });

    const forced = pollHudSnapshot(
      { source: 'cli' },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: tNewer + 41_000, isAlive },
    );
    assert.equal(forced.unchanged, false);
    assert.equal(forced.snapshot?.convId, newerId);
    assert.deepEqual(
      forced.sessions.map((s) => s.convId),
      [newerId, olderId],
    );
  });

  void it('invalidates Inspector ETag after same-inode same-length same-mtime transcript rewrite', () => {
    const convId = 'app-same-stat-1234';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const tPath = path.join(logsDir, 'transcript.jsonl');

    const lineBefore = `${JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'alpha.ts') } }],
    })}\n`;
    const lineAfter = `${JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'edit_file', args: { Path: path.join(wsDir, 'bravo.ts') } }],
    })}\n`;
    assert.equal(Buffer.byteLength(lineBefore, 'utf8'), Buffer.byteLength(lineAfter, 'utf8'));

    writeFileSync(tPath, lineBefore, 'utf8');
    const fixedTime = new Date(nowMs - 10_000);
    utimesSync(tPath, fixedTime, fixedTime);
    writeSummaryRow(appRoot, convId, 'Fixed Stat Rewrite', wsDir, '2026-06-01T11:59:50Z');

    const first = pollHudSnapshot({ sessionId: convId, source: 'all' }, { cliHome, geminiRoot, cwd: wsDir, nowMs });
    assert.equal(first.unchanged, false);
    assert.equal(first.snapshot?.completedTools[0]?.disp, 'read_file');

    const stBefore = statSync(tPath);
    writeFileSync(tPath, lineAfter, 'utf8');
    utimesSync(tPath, fixedTime, fixedTime);
    assert.equal(statSync(tPath).ino, stBefore.ino);
    assert.equal(statSync(tPath).size, stBefore.size);

    const second = pollHudSnapshot(
      { sessionId: convId, source: 'all', etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 2000 },
    );
    assert.equal(second.unchanged, false);
    assert.notEqual(second.etag, first.etag);
    assert.equal(second.snapshot?.completedTools[0]?.disp, 'edit_file');
  });

  void it('invalidates Inspector ETag when conversation_summaries title changes with fixed timestamp', () => {
    const convId = 'app-title-update-1234';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
      'utf8',
    );
    writeSummaryRow(appRoot, convId, 'Original Title', wsDir, '2026-06-01T11:59:00Z');

    const first = pollHudSnapshot({ sessionId: convId, source: 'all' }, { cliHome, geminiRoot, cwd: wsDir, nowMs });
    assert.equal(first.unchanged, false);
    assert.equal(first.snapshot?.title, 'Original Title');

    writeSummaryRow(appRoot, convId, 'Renamed Title', wsDir, '2026-06-01T11:59:00Z');
    const second = pollHudSnapshot(
      { sessionId: convId, source: 'all', etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 2000 },
    );
    assert.equal(second.unchanged, false);
    assert.notEqual(second.etag, first.etag);
    assert.equal(second.snapshot?.title, 'Renamed Title');
    assert.equal(second.sessions[0]?.title, 'Renamed Title');
  });

  void it('caps oversized ambiguous-prefix MCP tool error responses below 1 MiB at JSON-RPC boundary', () => {
    const hugeTitleA = '中文超长会话标题甲'.repeat(25_000);
    const hugeTitleB = '中文超长会话标题乙'.repeat(25_000);
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    for (const [convId, title] of [
      ['ambig-aaaa-1111', hugeTitleA],
      ['ambig-bbbb-2222', hugeTitleB],
    ] as const) {
      const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(
        path.join(logsDir, 'transcript.jsonl'),
        `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
        'utf8',
      );
      writeSummaryRow(appRoot, convId, title, wsDir, '2026-06-01T11:59:00Z');
    }

    const req = {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'hud_poll_snapshot', arguments: { sessionId: 'ambi', source: 'all' } },
    };
    const ctx = { cliHome, geminiRoot, cwd: wsDir, nowMs };
    const rpcRes = handleMcpMessage(req, ctx);
    assert.ok(rpcRes !== null && 'result' in rpcRes);
    const wireBytes = Buffer.byteLength(JSON.stringify(rpcRes), 'utf8');
    assert.ok(wireBytes <= HARD_MAX_MCP_RESPONSE_BYTES, `expected <= 1 MiB, got ${wireBytes}`);
    const resultObj = rpcRes.result as {
      isError: boolean;
      structuredContent: { code: string; truncated: boolean; sessionId?: string | null; source?: string };
    };
    assert.equal(resultObj.isError, true);
    assert.equal(resultObj.structuredContent.code, 'ambiguous');
    assert.equal(resultObj.structuredContent.truncated, true);
    assert.equal(resultObj.structuredContent.sessionId, 'ambi');
    assert.equal(resultObj.structuredContent.source, 'all');

    const lineHandler = createMcpLineHandler(ctx);
    const rawLine = lineHandler(JSON.stringify(req));
    assert.ok(rawLine !== null);
    assert.ok(Buffer.byteLength(rawLine, 'utf8') <= HARD_MAX_MCP_RESPONSE_BYTES);
  });

  void it('caps oversized JSON-RPC protocol error responses below 1 MiB', () => {
    const hugeMethod = 'x'.repeat(1_200_000);
    const rpcRes = handleMcpMessage({ jsonrpc: '2.0', id: 7, method: hugeMethod });
    assert.ok(rpcRes !== null && 'error' in rpcRes);
    const wireBytes = Buffer.byteLength(JSON.stringify(rpcRes), 'utf8');
    assert.ok(wireBytes <= HARD_MAX_MCP_RESPONSE_BYTES, `expected <= 1 MiB, got ${wireBytes}`);
    assert.equal(rpcRes.error.code, -32601);
  });

  void it('invalidates Inspector ETag when /swarm members.json or worker transcript changes', () => {
    const convId = 'cli-swarm-etag-1234';
    const workerConvId = 'swarm-worker-conv-1';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    const swarmDir = path.join(cliHome, 'brain', convId, '.system_generated', 'swarm');
    const workerLogsDir = path.join(cliHome, 'brain', workerConvId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(swarmDir, { recursive: true });
    mkdirSync(workerLogsDir, { recursive: true });

    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
      'utf8',
    );
    const workerTranscript = path.join(workerLogsDir, 'transcript.jsonl');
    writeFileSync(
      workerTranscript,
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test' } }] })}\n`,
      'utf8',
    );
    const rosterPath = path.join(swarmDir, 'members.json');
    writeFileSync(
      rosterPath,
      JSON.stringify({
        members: {
          coordinator: { role: 'coordinator', killed: false },
          builder: { role: 'worker', conversation_id: workerConvId },
        },
      }),
      'utf8',
    );
    writeSnapshotEnvelope(cliHome, { conversation_id: convId, conversation_title: 'Swarm Session', cwd: wsDir }, 4242, {
      nowMs,
    });

    const isAlive = (p: number): boolean => p === 4242;
    const first = pollHudSnapshot(
      { sessionId: convId, source: 'cli' },
      { cliHome, geminiRoot, cwd: wsDir, nowMs, isAlive },
    );
    assert.equal(first.unchanged, false);
    assert.equal(first.snapshot?.agents.find((a) => a.name === 'builder')?.state, 'working');

    // Worker transitions working -> waiting by writing swarm_wait completion to its transcript.
    writeFileSync(
      workerTranscript,
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }] })}\n${JSON.stringify({ type: 'GENERIC', status: 'DONE' })}\n`,
      'utf8',
    );
    const second = pollHudSnapshot(
      { sessionId: convId, source: 'cli', etag: first.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 2000, isAlive },
    );
    assert.equal(second.unchanged, false);
    assert.notEqual(second.etag, first.etag);
    assert.equal(second.snapshot?.agents.find((a) => a.name === 'builder')?.state, 'waiting');

    // Member roster kills worker -> ETag invalidates again and stopped worker appears as done.
    writeFileSync(
      rosterPath,
      JSON.stringify({
        members: {
          coordinator: { role: 'coordinator', killed: false },
          builder: { role: 'worker', conversation_id: workerConvId, killed: true },
        },
      }),
      'utf8',
    );
    const third = pollHudSnapshot(
      { sessionId: convId, source: 'cli', etag: second.etag },
      { cliHome, geminiRoot, cwd: wsDir, nowMs: nowMs + 4000, isAlive },
    );
    assert.equal(third.unchanged, false);
    assert.notEqual(third.etag, second.etag);
    assert.equal(third.snapshot?.agents.find((a) => a.name === 'builder')?.state, 'done');
  });

  void it('preserves valid 100-char session IDs intact under heavy payload capping', () => {
    const longConvId = `sess-${'a'.repeat(95)}`;
    assert.equal(longConvId.length, 100);
    const rawPayload: HudPollSnapshotData = {
      unchanged: false,
      etag: 'etag-cap-100',
      source: 'all',
      sessions: [
        {
          convId: longConvId,
          shortId: longConvId.slice(0, 8),
          surface: 'app',
          title: '中文超长会话标题测试'.repeat(40_000),
          workspace: '/workspace',
          running: true,
          livePid: null,
          updatedAtMs: 1_700_000_000_000,
          ageLabel: '1s ago',
        },
      ],
      snapshot: {
        convId: longConvId,
        shortId: longConvId.slice(0, 8),
        surface: 'app',
        title: '中文超长会话标题测试'.repeat(40_000),
        model: 'Gemini 4 Carbon',
        workspace: '/workspace',
        resolutionTier: 'explicit',
        running: true,
        updatedAtMs: 1_700_000_000_000,
        ageLabel: '1s ago',
        livePid: null,
        siblingCandidates: [],
        siblingHint: '',
        telemetry: { genCount: 1, tps: 90, ttft: 1, cachePct: 90, ctxUsed: 1000, ctxMax: 100_000, ctxPct: 1 },
        runningTools: [],
        completedTools: [],
        totalToolCalls: 0,
        skills: [],
        mcps: [],
        agentsKind: 'agents',
        agents: [],
        todos: null,
      },
    };

    const capped = capInspectorPayload(rawPayload);
    assert.equal(capped.truncated, true);
    assert.equal(capped.sessions[0]?.convId, longConvId);
    assert.equal(capped.snapshot?.convId, longConvId);
  });

  void it('keeps targetUris intact without cross-binding colliding clipped targets under payload capping', () => {
    const sharedPrefix = `/workspace/${'deepdir/'.repeat(35)}`;
    const targetA = `${sharedPrefix}file-a.ts`;
    const targetB = `${sharedPrefix}file-b.ts`;
    const uniqueTarget = `/workspace/${'other/'.repeat(42)}unique.ts`;
    const uriA = `file://${targetA}`;
    const uriB = `file://${targetB}`;
    const uriUnique = `file://${uniqueTarget}`;
    const rawPayload: HudPollSnapshotData = {
      unchanged: false,
      etag: 'etag-cap-uri',
      source: 'all',
      sessions: [],
      snapshot: {
        convId: 'sess-uri-cap',
        shortId: 'sess-uri',
        surface: 'app',
        title: '中文超长会话标题测试'.repeat(40_000),
        model: 'Gemini 4 Carbon',
        workspace: '/workspace',
        resolutionTier: 'explicit',
        running: true,
        updatedAtMs: 1_700_000_000_000,
        ageLabel: '1s ago',
        livePid: null,
        siblingCandidates: [],
        siblingHint: '',
        telemetry: { genCount: 1, tps: 90, ttft: 1, cachePct: 90, ctxUsed: 1000, ctxMax: 100_000, ctxPct: 1 },
        runningTools: [
          {
            name: 'edit_file',
            disp: 'edit_file',
            target: 'unique.ts',
            fullTarget: uniqueTarget,
            isMcp: false,
            fileUri: uriUnique,
          },
        ],
        completedTools: [
          {
            disp: 'read_file',
            count: 3,
            latestTarget: 'unique.ts',
            fullTarget: uniqueTarget,
            recentTargets: [uniqueTarget, targetA, targetB],
            targetUris: { [uniqueTarget]: uriUnique, [targetA]: uriA, [targetB]: uriB },
            isMcp: false,
          },
        ],
        totalToolCalls: 4,
        skills: [],
        mcps: [],
        agentsKind: 'agents',
        agents: [],
        todos: null,
      },
    };

    const capped = capInspectorPayload(rawPayload);
    assert.equal(capped.snapshot?.runningTools[0]?.fileUri, uriUnique);
    const tool = capped.snapshot?.completedTools[0];
    const uniqueKey = tool?.recentTargets[0] ?? '';
    const collidingKey = tool?.recentTargets[1] ?? '';
    assert.ok(uniqueKey.endsWith('…'));
    assert.equal(tool?.targetUris[uniqueKey], uriUnique);
    assert.equal(tool?.targetUris[collidingKey], undefined);
  });

  void it('invalidates ETag when CLI settings fallback model changes', () => {
    const convId = 'cli-model-etag-1234';
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    writeFileSync(path.join(cliHome, 'settings.json'), JSON.stringify({ model: 'Model A' }), 'utf8');
    writeSnapshotEnvelope(cliHome, { conversation_id: convId, conversation_title: 'CLI Model', cwd: wsDir }, 4242, {
      nowMs: t0,
    });
    const opts = { cliHome, geminiRoot, cwd: wsDir, nowMs: t0 + 1000, isAlive: (p: number) => p === 4242 };

    const first = pollHudSnapshot({ sessionId: convId, source: 'cli' }, opts);
    assert.equal(first.unchanged, false);
    assert.equal(first.snapshot?.model, 'Model A');

    writeFileSync(path.join(cliHome, 'settings.json'), JSON.stringify({ model: 'Model B' }), 'utf8');
    const afterModel = pollHudSnapshot({ sessionId: convId, source: 'cli', etag: first.etag }, opts);
    assert.equal(afterModel.unchanged, false);
    assert.equal(afterModel.snapshot?.model, 'Model B');
  });

  void it('invalidates ETag when session resolution tier changes', () => {
    const convId = 'cli-tier-etag-5678';
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(cliHome, { conversation_id: convId, conversation_title: 'CLI Tier', cwd: wsDir }, 4242, {
      nowMs: t0,
    });
    const opts = { cliHome, geminiRoot, cwd: wsDir, nowMs: t0 + 1000, isAlive: (p: number) => p === 4242 };

    const explicitRes = pollHudSnapshot({ sessionId: convId, source: 'cli' }, opts);
    assert.equal(explicitRes.unchanged, false);
    assert.equal(explicitRes.snapshot?.resolutionTier, 'explicit');

    const workspaceRes = pollHudSnapshot({ source: 'cli', etag: explicitRes.etag }, opts);
    assert.equal(workspaceRes.unchanged, false);
    assert.equal(workspaceRes.snapshot?.resolutionTier, 'workspace');
  });
});
