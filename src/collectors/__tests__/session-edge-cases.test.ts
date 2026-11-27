import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { discoverSessions } from '../session-discovery.ts';
import { resolveSession } from '../session-index.ts';
import { readActivePidMarker, writeSnapshotEnvelope } from '../snapshot-envelope.ts';

function writeSummaryRow(
  rootDir: string,
  row: {
    id: string;
    title: string;
    lastModifiedIso: string;
    workspaces: string[];
    notFullyIdle?: number;
    status?: string;
  },
): void {
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
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(
    row.id,
    row.title,
    row.lastModifiedIso,
    JSON.stringify(row.workspaces.map((w) => pathToFileURL(w).href)),
    'CORTEX_TRAJECTORY_SOURCE_CLI',
    row.notFullyIdle ?? 0,
    row.status ?? 'CASCADE_RUN_STATUS_IDLE',
  );
  db.close();
}

void describe('session discovery sorting, global fallback, and DB-only lookup', () => {
  let tmpRoot = '';
  let cliHome = '';
  let wsDir = '';
  let otherDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-sess-edge-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    wsDir = path.join(tmpRoot, 'ws');
    otherDir = path.join(tmpRoot, 'other');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('sorts newer unbound CLI session ahead of exited CLI session marked RUNNING', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const deadCliId = 'cli-exited-running-1111';
    const freshCliId = 'cli-newer-idle-2222';

    const cliLogs = path.join(cliHome, 'brain', deadCliId, '.system_generated', 'logs');
    mkdirSync(cliLogs, { recursive: true });
    const cliTranscript = path.join(cliLogs, 'transcript.jsonl');
    writeFileSync(
      cliTranscript,
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [] })}\n`,
    );
    utimesSync(cliTranscript, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
    writeSnapshotEnvelope(cliHome, { conversation_id: deadCliId, cwd: wsDir, conversation_title: 'Exited CLI' }, 9999, {
      nowMs: nowMs - 60_000,
    });
    writeSummaryRow(cliHome, {
      id: deadCliId,
      title: 'Exited CLI',
      lastModifiedIso: '2026-06-01T11:59:00Z',
      workspaces: [wsDir],
      notFullyIdle: 1,
      status: 'CASCADE_RUN_STATUS_RUNNING',
    });

    const freshLogs = path.join(cliHome, 'brain', freshCliId, '.system_generated', 'logs');
    mkdirSync(freshLogs, { recursive: true });
    const freshTranscript = path.join(freshLogs, 'transcript.jsonl');
    writeFileSync(freshTranscript, `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`);
    utimesSync(freshTranscript, new Date(nowMs - 5_000), new Date(nowMs - 5_000));
    writeSummaryRow(cliHome, {
      id: freshCliId,
      title: 'Newer CLI Session',
      lastModifiedIso: '2026-06-01T11:59:55Z',
      workspaces: [wsDir],
    });

    const listed = discoverSessions({ cliHome, nowMs, isAlive: () => false });
    assert.equal(listed[0]?.convId, freshCliId);
    assert.equal(listed[1]?.convId, deadCliId);
    assert.equal(listed[1]?.running, false);
  });

  void it('selects newer unbound CLI session over exited RUNNING CLI session in Tier 3 global fallback', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const deadCliId = 'cli-dead-run-3333';
    const freshCliId = 'cli-fresh-4444';

    const cliLogs = path.join(cliHome, 'brain', deadCliId, '.system_generated', 'logs');
    mkdirSync(cliLogs, { recursive: true });
    writeFileSync(
      path.join(cliLogs, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [] })}\n`,
    );
    writeSnapshotEnvelope(cliHome, { conversation_id: deadCliId, cwd: wsDir, conversation_title: 'Dead CLI' }, 8888, {
      nowMs: nowMs - 30_000,
    });

    const freshLogs = path.join(cliHome, 'brain', freshCliId, '.system_generated', 'logs');
    mkdirSync(freshLogs, { recursive: true });
    writeFileSync(
      path.join(freshLogs, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
    );
    writeSummaryRow(cliHome, {
      id: freshCliId,
      title: 'Fresh CLI Session',
      lastModifiedIso: '2026-06-01T11:59:55Z',
      workspaces: [wsDir],
    });

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: null,
      nowMs,
      isAlive: () => false,
    });
    assert.equal(resolved.tier, 'fallback');
    assert.equal(resolved.session.convId, freshCliId);
  });

  void it('resolves DB-only CLI session without brain or summary records by explicit full ID', () => {
    const dbOnlyId = 'dbonly-7777-8888-9999';
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(path.join(convDir, `${dbOnlyId}.db`));
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.close();

    const resolved = resolveSession({
      cliHome,
      session: dbOnlyId,
      nowMs: Date.parse('2026-06-01T12:00:00Z'),
    });
    assert.equal(resolved.tier, 'explicit');
    assert.equal(resolved.session.convId, dbOnlyId);
    assert.equal(resolved.session.dataRoot, cliHome);
  });

  void it('rebinds Tier 1 active session when switching A to B and back to A within 30s', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 4242;
    const convA = 'cli-switch-a-1111';
    const convB = 'cli-switch-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'Session A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'Session B', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 + 5_000 });
    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 + 10_000 });

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 + 11_000,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convA);
    assert.equal(resolved.session.livePid, sharedPid);
  });

  void it('preserves Tier 1 active session when same-ms switch-back is followed by semantic update', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 5353;
    const convA = 'cli-samems-a-1111';
    const convB = 'cli-samems-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'Session A', cwd: wsDir, task_count: 1 };
    const dataB = { conversation_id: convB, conversation_title: 'Session B', cwd: wsDir, task_count: 1 };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, { ...dataA, task_count: 2 }, sharedPid, { nowMs: t0 });

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convA);
    assert.equal(resolved.session.livePid, sharedPid);
  });

  void it('breaks equal-heartbeat Tier 1 ties using the active PID marker', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 6464;
    const convA = 'cli-tie-a-1111';
    const convB = 'cli-tie-b-2222';
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    writeFileSync(
      path.join(cliHome, 'cache', `agy_hud_snapshot_${convA}.json`),
      JSON.stringify({
        v: 2,
        convId: convA,
        conversationTitle: 'Session A',
        agyPid: sharedPid,
        cwd: wsDir,
        workspaceCurrentDir: wsDir,
        workspaceProjectDir: wsDir,
        subagents: [],
        taskCount: null,
        mdDigest: null,
        updatedAtMs: t0 - 5_000,
        heartbeatAtMs: t0,
      }),
      'utf8',
    );
    writeFileSync(
      path.join(cliHome, 'cache', `agy_hud_snapshot_${convB}.json`),
      JSON.stringify({
        v: 2,
        convId: convB,
        conversationTitle: 'Session B',
        agyPid: sharedPid,
        cwd: wsDir,
        workspaceCurrentDir: wsDir,
        workspaceProjectDir: wsDir,
        subagents: [],
        taskCount: null,
        mdDigest: null,
        updatedAtMs: t0,
        heartbeatAtMs: t0,
      }),
      'utf8',
    );
    writeFileSync(
      path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`),
      JSON.stringify({ convId: convA, heartbeatAtMs: t0 }),
      'utf8',
    );

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 + 1_000,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convA);
  });

  void it('rejects negative, far-future, MAX_SAFE_INTEGER, and invalid-seq PID markers', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 7171;
    const markerPath = path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`);
    mkdirSync(path.dirname(markerPath), { recursive: true });

    const invalidPayloads = [
      { convId: 'conv-bad-1111', heartbeatAtMs: -1, switchSeq: 1 },
      { convId: 'conv-bad-1111', heartbeatAtMs: 0, switchSeq: 1 },
      { convId: 'conv-bad-1111', heartbeatAtMs: Number.MAX_SAFE_INTEGER, switchSeq: 1 },
      { convId: 'conv-bad-1111', heartbeatAtMs: t0 + 3_600_000, switchSeq: 1 },
      { convId: 'conv-bad-1111', heartbeatAtMs: t0, switchSeq: -1 },
      { convId: 'conv-bad-1111', heartbeatAtMs: t0, switchSeq: Number.MAX_SAFE_INTEGER },
    ];
    for (const payload of invalidPayloads) {
      writeFileSync(markerPath, JSON.stringify(payload), 'utf8');
      assert.equal(readActivePidMarker(cliHome, sharedPid, t0), null);
    }
  });

  void it('rebinds Tier 1 to switched-back session across a backward clock jump', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 7272;
    const convA = 'cli-skew-a-1111';
    const convB = 'cli-skew-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'Session A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'Session B', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 });
    const switchedBack = writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 - 10_000 });
    assert.equal(switchedBack?.heartbeatAtMs, t0 - 10_000);

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 - 9_500,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convA);
  });

  void it('preserves 30s envelope throttle immediately after a backward clock jump', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 7273;
    const convA = 'cli-skew-throttle-1111';
    const dataA = { conversation_id: convA, conversation_title: 'Session A', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 - 10_000 });

    const envPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convA}.json`);
    const sentinel = new Date(1_690_000_000_000);
    utimesSync(envPath, sentinel, sentinel);

    const throttled = writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 - 9_700 });
    assert.equal(throttled?.heartbeatAtMs, t0 - 10_000);
    assert.equal(Math.trunc(statSync(envPath).mtimeMs), 1_690_000_000_000);
  });

  void it('does not let a stale lower-switchSeq marker override a higher-pidSwitchSeq envelope', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 7274;
    const convA = 'cli-stale-mk-a-1111';
    const convB = 'cli-stale-mk-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'Session A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'Session B', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 - 5_000 });
    // Simulate a stale pre-jump marker for convA lagging behind convB's switchSeq (1 < 2).
    writeFileSync(
      path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`),
      JSON.stringify({ convId: convA, heartbeatAtMs: t0, switchSeq: 1 }),
      'utf8',
    );

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 - 4_000,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convB);
  });

  void it('ignores MAX_SAFE_INTEGER marker timestamps instead of saturating A->B->A rebind', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 7373;
    const convA = 'cli-sat-a-1111';
    const convB = 'cli-sat-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'Session A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'Session B', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 });
    writeFileSync(
      path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`),
      JSON.stringify({ convId: convB, heartbeatAtMs: Number.MAX_SAFE_INTEGER }),
      'utf8',
    );
    const rebound = writeSnapshotEnvelope(cliHome, { ...dataA, task_count: 1 }, sharedPid, { nowMs: t0 + 1_000 });
    assert.equal(rebound?.heartbeatAtMs, t0 + 1_000);

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 + 2_000,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convA);
  });

  void it('preserves 30s envelope throttle when active PID marker is missing', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 7474;
    const convA = 'cli-nomarker-1111';
    const dataA = { conversation_id: convA, conversation_title: 'Steady', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    rmSync(path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`), { force: true });
    const envPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convA}.json`);
    const sentinel = new Date(1_690_000_000_000);
    utimesSync(envPath, sentinel, sentinel);

    const skipped = writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 + 500 });
    assert.equal(skipped?.heartbeatAtMs, t0);
    assert.equal(Math.trunc(statSync(envPath).mtimeMs), 1_690_000_000_000);
  });

  void it('writes snapshot envelope and active PID marker with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 7575;
    const convA = 'cli-mode-1111';
    writeSnapshotEnvelope(cliHome, { conversation_id: convA, conversation_title: 'Mode Test', cwd: wsDir }, sharedPid, {
      nowMs: t0,
    });

    const envPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convA}.json`);
    const markerPath = path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.equal(statSync(markerPath).mode & 0o777, 0o600);
  });
});
