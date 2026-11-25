import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { discoverSessions } from '../session-discovery.ts';
import { resolveSession } from '../session-index.ts';
import { writeSnapshotEnvelope } from '../snapshot-envelope.ts';

function writeSummaryRow(
  rootDir: string,
  row: {
    id: string;
    title: string;
    lastModifiedIso: string;
    workspaces: string[];
    source: string;
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
    row.source,
    row.notFullyIdle ?? 0,
    row.status ?? 'CASCADE_RUN_STATUS_IDLE',
  );
  db.close();
}

void describe('session discovery sorting, global fallback, and DB-only lookup', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let wsDir = '';
  let otherDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-sess-edge-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    wsDir = path.join(tmpRoot, 'ws');
    otherDir = path.join(tmpRoot, 'other');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('sorts newer App session ahead of exited CLI session marked RUNNING', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const deadCliId = 'cli-exited-running-1111';
    const appId = 'app-newer-idle-2222';

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
      source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
      notFullyIdle: 1,
      status: 'CASCADE_RUN_STATUS_RUNNING',
    });

    const appLogs = path.join(appRoot, 'brain', appId, '.system_generated', 'logs');
    mkdirSync(appLogs, { recursive: true });
    const appTranscript = path.join(appLogs, 'transcript.jsonl');
    writeFileSync(appTranscript, `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`);
    utimesSync(appTranscript, new Date(nowMs - 5_000), new Date(nowMs - 5_000));
    writeSummaryRow(appRoot, {
      id: appId,
      title: 'Newer App Session',
      lastModifiedIso: '2026-06-01T11:59:55Z',
      workspaces: [wsDir],
      source: 'CORTEX_TRAJECTORY_SOURCE_CLIENT',
    });

    const listed = discoverSessions({ cliHome, geminiRoot, nowMs, isAlive: () => false });
    assert.equal(listed[0]?.convId, appId);
    assert.equal(listed[1]?.convId, deadCliId);
    assert.equal(listed[1]?.running, false);
  });

  void it('selects newer App session over exited RUNNING CLI session in Tier 3 global fallback', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const deadCliId = 'cli-dead-run-3333';
    const appId = 'app-fresh-4444';

    const cliLogs = path.join(cliHome, 'brain', deadCliId, '.system_generated', 'logs');
    mkdirSync(cliLogs, { recursive: true });
    writeFileSync(
      path.join(cliLogs, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [] })}\n`,
    );
    writeSnapshotEnvelope(cliHome, { conversation_id: deadCliId, cwd: wsDir, conversation_title: 'Dead CLI' }, 8888, {
      nowMs: nowMs - 30_000,
    });

    const appLogs = path.join(appRoot, 'brain', appId, '.system_generated', 'logs');
    mkdirSync(appLogs, { recursive: true });
    writeFileSync(
      path.join(appLogs, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
    );
    writeSummaryRow(appRoot, {
      id: appId,
      title: 'Fresh App Session',
      lastModifiedIso: '2026-06-01T11:59:55Z',
      workspaces: [wsDir],
      source: 'CORTEX_TRAJECTORY_SOURCE_CLIENT',
    });

    const resolved = resolveSession({
      cliHome,
      geminiRoot,
      cwd: otherDir,
      callerAgyPid: null,
      nowMs,
      isAlive: () => false,
    });
    assert.equal(resolved.tier, 'fallback');
    assert.equal(resolved.session.convId, appId);
  });

  void it('resolves DB-only session without brain or summary records by explicit full ID', () => {
    const dbOnlyId = 'dbonly-7777-8888-9999';
    const convDir = path.join(appRoot, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(path.join(convDir, `${dbOnlyId}.db`));
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.close();

    const resolved = resolveSession({
      cliHome,
      geminiRoot,
      session: dbOnlyId,
      nowMs: Date.parse('2026-06-01T12:00:00Z'),
    });
    assert.equal(resolved.tier, 'explicit');
    assert.equal(resolved.session.convId, dbOnlyId);
    assert.equal(resolved.session.surface, 'app');
  });
});
