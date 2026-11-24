import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { runCliEntry } from '../../cli-entry.ts';
import { writeSnapshotEnvelope } from '../../collectors/session-index.ts';
import type { ActivitySnapshot } from '../../snapshot-types.ts';
import { formatSessionsTable, formatSnapshotText, parseSnapshotArgs, runSnapshotCommand } from '../snapshot.ts';

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
  const ttft = [...encodeFieldVarint(1, 1), ...encodeFieldVarint(2, 0)];
  const stream = [...encodeFieldVarint(1, 2), ...encodeFieldVarint(2, 0)];
  const chatModel = [
    ...encodeFieldBytes(4, usage),
    ...encodeFieldBytes(9, chatStart),
    ...encodeFieldBytes(11, ttft),
    ...encodeFieldBytes(12, stream),
  ];
  return new Uint8Array(encodeFieldBytes(1, chatModel));
}

function captureStdout(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

void describe('agy-hud snapshot CLI', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let ideRoot = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-snap-cli-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    ideRoot = path.join(geminiRoot, 'antigravity-ide');
    wsDir = path.join(tmpRoot, 'my-repo');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('parses repeatable case-insensitive singular/plural/swarm filters and flags', () => {
    const parsed = parseSnapshotArgs([
      'Tool',
      'SKILLS',
      'mcp',
      'swarm',
      '-s',
      'abcd1234',
      '--source',
      'app',
      '--json',
      '--no-color',
    ]);
    assert.deepEqual(parsed.sections, ['tools', 'skills', 'mcps', 'agents']);
    assert.equal(parsed.session, 'abcd1234');
    assert.equal(parsed.source, 'app');
    assert.equal(parsed.json, true);
    assert.equal(parsed.noColor, true);

    const allParsed = parseSnapshotArgs(['tools', 'all', '--sessions', '--source=all']);
    assert.deepEqual(allParsed.sections, []);
    assert.equal(allParsed.listSessions, true);
    assert.equal(allParsed.source, 'all');

    assert.throws(() => parseSnapshotArgs(['--source', 'invalid']), /Invalid --source/);
    assert.throws(() => parseSnapshotArgs(['bogus-filter']), /Unknown snapshot filter/);
    assert.throws(() => parseSnapshotArgs(['-s']), /Missing value after -s/);
  });

  void it('prints --sessions table with [CLI], [APP], and [IDE] badges', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-1111aaaa', conversation_title: 'CLI Task', cwd: wsDir },
      process.pid,
      { nowMs },
    );

    const appLogs = path.join(appRoot, 'brain', 'app-2222bbbb', '.system_generated', 'logs');
    mkdirSync(appLogs, { recursive: true });
    writeFileSync(
      path.join(appLogs, 'transcript.jsonl'),
      '{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[]}\n',
      'utf8',
    );
    const appDb = new DatabaseSync(path.join(appRoot, 'conversation_summaries.db'));
    appDb.exec(
      `CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, last_modified_time TEXT, workspace_uris TEXT, source TEXT, not_fully_idle INTEGER, status TEXT, nesting_depth INTEGER, killed INTEGER)`,
    );
    appDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'app-2222bbbb',
        'App Task',
        '2026-06-01T11:59:00Z',
        JSON.stringify([pathToFileURL(wsDir).href]),
        'CORTEX_TRAJECTORY_SOURCE_CLIENT',
        0,
        'CASCADE_RUN_STATUS_IDLE',
        0,
        0,
      );
    appDb.close();

    const ideLogs = path.join(ideRoot, 'brain', 'ide-3333cccc', '.system_generated', 'logs');
    mkdirSync(ideLogs, { recursive: true });
    writeFileSync(
      path.join(ideLogs, 'transcript.jsonl'),
      '{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[]}\n',
      'utf8',
    );
    const ideDb = new DatabaseSync(path.join(ideRoot, 'conversation_summaries.db'));
    ideDb.exec(
      `CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, last_modified_time TEXT, workspace_uris TEXT, source TEXT, not_fully_idle INTEGER, status TEXT, nesting_depth INTEGER, killed INTEGER)`,
    );
    ideDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'ide-3333cccc',
        'IDE Task',
        '2026-06-01T11:58:00Z',
        JSON.stringify([pathToFileURL(wsDir).href]),
        'CORTEX_TRAJECTORY_SOURCE_CLIENT',
        0,
        'CASCADE_RUN_STATUS_IDLE',
        0,
        0,
      );
    ideDb.close();

    const res = runSnapshotCommand(['--sessions', '--source', 'all'], {
      cliHome,
      geminiRoot,
      nowMs,
      isAlive: (p) => p === process.pid,
    });
    assert.ok(res.output.includes('[CLI]'));
    assert.ok(res.output.includes('[APP]'));
    assert.ok(res.output.includes('[IDE]'));
    assert.ok(res.output.includes(`live:${process.pid}`));
    assert.ok(res.output.includes('cli-1111'));
    assert.ok(res.output.includes('app-2222'));
    assert.ok(res.output.includes('ide-3333'));

    assert.equal(formatSessionsTable([], 'cli').includes('No Antigravity sessions found'), true);
  });

  void it('emits structured --json ActivitySnapshot including telemetry, latestTarget, MCP subtools, and agents', () => {
    const convId = 'app-json-99998888';
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const logsDir = path.join(appRoot, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', content: '/tdd' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          model: 'Gemini 4 Carbon',
          created_at: '2026-06-01T11:58:00Z',
          tool_calls: [
            { name: 'read_file', args: { Path: '/repo/src/cli/snapshot.ts' } },
            { name: 'mcp_fast_batch_search', args: { query: 'test' } },
            { name: 'invoke_subagent', args: { Role: 'Auditor', TypeName: 'review', Model: 'Gemini 4 Flash' } },
          ],
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const convDir = path.join(appRoot, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const cdb = new DatabaseSync(path.join(convDir, `${convId}.db`));
    cdb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    cdb
      .prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
      .run(0, buildGenBlob({ inTok: 500, outTok: 100, crTok: 1500, ctxUsed: 25_000, ctxMax: 512_000 }));
    cdb.close();

    const res = runSnapshotCommand(['--source', 'app', '--json'], { cliHome, geminiRoot, cwd: wsDir, nowMs });
    const parsed = JSON.parse(res.output) as ActivitySnapshot;
    assert.equal(parsed.convId, convId);
    assert.equal(parsed.surface, 'app');
    assert.equal(parsed.telemetry.genCount, 1);
    assert.equal(parsed.telemetry.ctxUsed, 25_000);
    assert.equal(parsed.completedTools.find((t) => t.disp === 'read_file')?.latestTarget, 'snapshot.ts');
    assert.equal(parsed.mcps[0]?.server, 'fast');
    assert.deepEqual(parsed.mcps[0]?.subtools, [{ name: 'batch_search', count: 1 }]);
    assert.equal(parsed.agents[0]?.name, 'Auditor');
    assert.equal(parsed.agents[0]?.state, 'done');

    const textToolsOnly = formatSnapshotText(parsed, ['tools']);
    assert.ok(textToolsOnly.includes('[APP] Activity Snapshot'));
    assert.ok(textToolsOnly.includes('read_file'));
    assert.equal(textToolsOnly.includes('Skills ('), false);
  });

  void it('routes bare invocation, snapshot, and snap through runCliEntry synchronously', () => {
    const prevHome = process.env.GEMINI_CLI_HOME;
    const prevGeminiHome = process.env.GEMINI_HOME;
    process.env.GEMINI_CLI_HOME = tmpRoot;
    delete process.env.GEMINI_HOME;
    try {
      writeSnapshotEnvelope(
        cliHome,
        { conversation_id: 'bare-cli-1234', conversation_title: 'Bare Entry', cwd: wsDir },
        process.pid,
      );
      const helpRun = captureStdout(() => runCliEntry(['snapshot', '--help']));
      assert.equal(helpRun.code, 0);
      assert.ok(helpRun.stdout.includes('agy-hud snapshot'));

      const bareRun = captureStdout(() => runCliEntry([]));
      assert.equal(bareRun.code, 0);
      assert.ok(bareRun.stdout.includes('bare-cli'));

      const snapJsonRun = captureStdout(() => runCliEntry(['snap', '--json']));
      assert.equal(snapJsonRun.code, 0);
      const snap = JSON.parse(snapJsonRun.stdout) as ActivitySnapshot;
      assert.equal(snap.convId, 'bare-cli-1234');
    } finally {
      if (prevHome === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prevHome;
      if (prevGeminiHome !== undefined) process.env.GEMINI_HOME = prevGeminiHome;
    }
  });
});
