import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveSession } from '../session-index.ts';
import { writeSnapshotEnvelope } from '../snapshot-envelope.ts';
import { loadActivitySnapshot } from '../snapshot-loader.ts';

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

void describe('loadActivitySnapshot CLI loader', () => {
  let tmpRoot = '';
  let cliHome = '';
  let roCliHome = '';
  let wsDir = '';
  const chmodRestore: string[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-snap-loader-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    roCliHome = path.join(tmpRoot, 'ro-cli-home');
    wsDir = path.join(tmpRoot, 'project');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(roCliHome, { recursive: true });
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

  void it('builds complete ActivitySnapshot from read-only 0o555 CLI root with caches only in cacheCliHome', () => {
    const convId = 'cli-full-12345678';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const longFileA = path.join(wsDir, 'src', 'very-long-directory-name', 'alpha-component-implementation.ts');
    const longFileB = path.join(wsDir, 'src', 'very-long-directory-name', 'beta-service-controller.ts');

    const logsDir = path.join(roCliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptLines = [
      { type: 'USER_INPUT', content: '/tdd workflow' },
      {
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        created_at: '2026-06-01T11:55:00Z',
        tool_calls: [
          { name: 'read_file', args: { Path: longFileA } },
          { name: 'read_file', args: { Path: longFileB } },
          { name: 'mcp_github_get_issue', args: { path: 'issue-1' } },
          { name: 'mcp_github_get_issue', args: { path: 'issue-2' } },
          { name: 'mcp_github_list_prs', args: {} },
          { name: 'invoke_subagent', args: { Role: 'Researcher', TypeName: 'general', Model: 'Gemini 4 Flash' } },
        ],
      },
      {
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        model: 'Gemini 4 Carbon',
        created_at: '2026-06-01T11:59:50Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm verify' } }],
      },
    ];
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${transcriptLines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );

    const convDir = path.join(roCliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const convDb = new DatabaseSync(path.join(convDir, `${convId}.db`));
    convDb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    convDb
      .prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
      .run(0, buildGenBlob({ inTok: 800, outTok: 200, crTok: 3200, ctxUsed: 64_000, ctxMax: 1_000_000 }));
    convDb.close();

    const summaryDb = new DatabaseSync(path.join(roCliHome, 'conversation_summaries.db'));
    summaryDb.exec(`
      CREATE TABLE conversation_summaries (
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
        `INSERT INTO conversation_summaries
         (conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status, nesting_depth, killed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        convId,
        'CLI Snapshot',
        '2026-06-01T11:59:50Z',
        JSON.stringify([pathToFileURL(wsDir).href]),
        'CORTEX_TRAJECTORY_SOURCE_CLI',
        1,
        'CASCADE_RUN_STATUS_RUNNING',
        0,
        0,
      );
    summaryDb.close();

    const beforeRoRoot = readdirSync(roCliHome).sort();
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(logsDir, 0o555);
      chmodSync(convDir, 0o555);
      chmodSync(roCliHome, 0o555);
      chmodRestore.push(roCliHome, convDir, logsDir);
    }

    const resolved = resolveSession({ cliHome: roCliHome, cwd: wsDir, nowMs });
    const snapshot = loadActivitySnapshot(resolved.session, {
      cacheCliHome: cliHome,
      resolutionTier: resolved.tier,
      siblings: resolved.siblings,
      nowMs,
    });

    assert.equal(snapshot.convId, convId);
    assert.equal(snapshot.dataRoot, roCliHome);
    assert.equal(snapshot.model, 'Gemini 4 Carbon');
    assert.equal(snapshot.telemetry.genCount, 1);
    assert.equal(snapshot.telemetry.ctxUsed, 64_000);
    assert.equal(snapshot.runningTools.length, 1);
    assert.equal(snapshot.runningTools[0]?.disp, 'run_command');
    assert.equal(snapshot.runningTools[0]?.fullTarget, 'pnpm verify');

    const readTool = snapshot.completedTools.find((t) => t.disp === 'read_file');
    assert.ok(readTool !== undefined);
    assert.equal(readTool.count, 2);
    assert.equal(readTool.fullTarget, longFileB);
    assert.deepEqual(readTool.recentTargets, [longFileB, longFileA]);

    assert.deepEqual(snapshot.skills, ['tdd']);
    assert.deepEqual(snapshot.mcps, [
      {
        server: 'github',
        totalCalls: 3,
        subtools: [
          { name: 'get_issue', count: 2 },
          { name: 'list_prs', count: 1 },
        ],
      },
    ]);
    assert.equal(snapshot.agents.length, 1);
    assert.equal(snapshot.agents[0]?.name, 'Researcher');
    assert.equal(snapshot.agents[0]?.state, 'done');

    assert.equal(existsSync(path.join(roCliHome, 'cache')), false);
    assert.deepEqual(readdirSync(roCliHome).sort(), beforeRoRoot);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`)), true);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`)), true);
  });

  void it('merges live envelope subagents with historical done transcript agents and resumes cache on append', () => {
    const convId = 'cli-agents-merge-1';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const tPath = path.join(logsDir, 'transcript.jsonl');
    const initialLines = [
      {
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-06-01T11:50:00Z',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'HistoricalReviewer', TypeName: 'review', Model: 'Claude Sonnet' } },
          { name: 'read_file', args: { Path: '/repo/src/a.ts' } },
        ],
      },
    ];
    writeFileSync(tPath, `${initialLines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

    writeSnapshotEnvelope(
      cliHome,
      {
        conversation_id: convId,
        conversation_title: 'CLI Merge Test',
        cwd: wsDir,
        subagents: [{ name: 'LiveCoder', role: 'LiveCoder', type_name: 'coder', model: 'Gemini 4', status: 'running' }],
      },
      7777,
      { nowMs },
    );

    const resolved = resolveSession({ cliHome, session: convId, nowMs, isAlive: (p) => p === 7777 });
    const snap1 = loadActivitySnapshot(resolved.session, { cacheCliHome: cliHome, resolutionTier: 'explicit', nowMs });
    assert.equal(snap1.agents.length, 2);
    assert.equal(
      snap1.agents.some((a) => a.name === 'LiveCoder' && a.state === 'working'),
      true,
    );
    assert.equal(
      snap1.agents.some((a) => a.name === 'HistoricalReviewer' && a.state === 'done'),
      true,
    );

    // Append another completed call to verify incremental byte-offset cache resume
    const appendedLine = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-01T11:59:00Z',
      tool_calls: [{ name: 'read_file', args: { Path: '/repo/src/b.ts' } }],
    });
    writeFileSync(tPath, `${initialLines.map((l) => JSON.stringify(l)).join('\n')}\n${appendedLine}\n`, 'utf8');

    const snap2 = loadActivitySnapshot(resolved.session, { cacheCliHome: cliHome, resolutionTier: 'explicit', nowMs });
    const readTool = snap2.completedTools.find((t) => t.disp === 'read_file');
    assert.equal(readTool?.count, 2);
    assert.equal(readTool?.fullTarget, '/repo/src/b.ts');
    assert.deepEqual(readTool?.recentTargets, ['/repo/src/b.ts', '/repo/src/a.ts']);
  });
});
