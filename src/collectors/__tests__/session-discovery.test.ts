import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { discoverSessions } from '../session-discovery.ts';
import { loadSummaryDbSnapshot } from '../session-summary-db.ts';

interface SummaryRowSeed {
  id: string;
  title: string;
  lastModifiedIso: string;
  workspaces: string[];
  notFullyIdle?: number;
  status?: string;
  nestingDepth?: number;
  killed?: number;
}

function writeSummaryDb(rootDir: string, rows: readonly SummaryRowSeed[]): void {
  mkdirSync(rootDir, { recursive: true });
  const dbPath = path.join(rootDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
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
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO conversation_summaries
      (conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status, nesting_depth, killed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    const uris = JSON.stringify(r.workspaces.map((ws) => pathToFileURL(ws).href));
    stmt.run(
      r.id,
      r.title,
      r.lastModifiedIso,
      uris,
      'CORTEX_TRAJECTORY_SOURCE_CLI',
      r.notFullyIdle ?? 0,
      r.status ?? 'CASCADE_RUN_STATUS_IDLE',
      r.nestingDepth ?? 0,
      r.killed ?? 0,
    );
  }
  db.close();
}

function writeTranscript(rootDir: string, convId: string, lines: readonly unknown[], mtimeMs?: number): string {
  const logsDir = path.join(rootDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'transcript.jsonl');
  writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  if (mtimeMs !== undefined) {
    const sec = mtimeMs / 1000;
    utimesSync(filePath, sec, sec);
  }
  return filePath;
}

void describe('CLI session discovery', () => {
  let tmpRoot = '';
  let cliHome = '';
  let wsRoot = '';
  const chmodRestore: string[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-discover-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    wsRoot = path.join(tmpRoot, 'repo');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(wsRoot, { recursive: true });
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

  void it('discovers top-level CLI sessions while excluding nested subagents and killed rows', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeTranscript(
      cliHome,
      'cli-1111-aaaa',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 60_000,
    );
    writeTranscript(
      cliHome,
      'sub-3333-cccc',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 10_000,
    );
    writeTranscript(
      cliHome,
      'kil-4444-dddd',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 10_000,
    );

    writeSummaryDb(cliHome, [
      { id: 'cli-1111-aaaa', title: 'CLI Work', lastModifiedIso: '2026-06-01T11:59:00Z', workspaces: [wsRoot] },
      {
        id: 'sub-3333-cccc',
        title: 'Nested Subagent',
        lastModifiedIso: '2026-06-01T11:59:50Z',
        workspaces: [wsRoot],
        nestingDepth: 1,
      },
      {
        id: 'kil-4444-dddd',
        title: 'Killed Session',
        lastModifiedIso: '2026-06-01T11:59:50Z',
        workspaces: [wsRoot],
        killed: 1,
      },
    ]);

    const discovered = discoverSessions({ env: { GEMINI_CLI_HOME: tmpRoot }, nowMs });
    assert.deepEqual(
      discovered.map((s) => s.convId),
      ['cli-1111-aaaa'],
    );
    assert.equal(discovered[0]?.dataRoot, cliHome);
    assert.equal(discovered[0]?.title, 'CLI Work');
  });

  void it('ignores phantom summary rows missing on disk and sibling data roots outside cliHome', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const siblingRoot = path.join(tmpRoot, '.gemini', 'antigravity');
    writeTranscript(
      cliHome,
      'cli-1111-aaaa',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 60_000,
    );
    writeTranscript(
      siblingRoot,
      'other-2222-bbbb',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 30_000,
    );

    writeSummaryDb(cliHome, [
      { id: 'cli-1111-aaaa', title: 'CLI Work', lastModifiedIso: '2026-06-01T11:59:00Z', workspaces: [wsRoot] },
      {
        id: 'phantom-9999-zzzz',
        title: 'Missing On Disk',
        lastModifiedIso: '2026-06-01T11:59:55Z',
        workspaces: [wsRoot],
      },
    ]);
    writeSummaryDb(siblingRoot, [
      { id: 'other-2222-bbbb', title: 'Sibling Root', lastModifiedIso: '2026-06-01T11:59:30Z', workspaces: [wsRoot] },
    ]);

    const discovered = discoverSessions({ env: { GEMINI_CLI_HOME: tmpRoot }, nowMs });
    assert.deepEqual(
      discovered.map((s) => s.convId),
      ['cli-1111-aaaa'],
    );
  });

  void it('keeps cliHome strictly read-only under chmod 0o555 during discovery', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeTranscript(cliHome, 'cli-ro-1111', [{ type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [] }], nowMs);
    writeSummaryDb(cliHome, [
      {
        id: 'cli-ro-1111',
        title: 'Read Only CLI',
        lastModifiedIso: '2026-06-01T12:00:00Z',
        workspaces: [wsRoot],
        notFullyIdle: 1,
      },
    ]);

    const before = readdirSync(cliHome).sort();
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(cliHome, 0o555);
      chmodRestore.push(cliHome);
    }

    const sessions = discoverSessions({ cliHome, nowMs });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.running, true);
    assert.deepEqual(readdirSync(cliHome).sort(), before);
    assert.equal(existsSync(path.join(cliHome, 'cache')), false);
  });

  void it('discovers cold brain transcripts without summary rows or envelopes', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const coldBrainId = 'cli-cold-brain-1234';
    writeTranscript(
      cliHome,
      coldBrainId,
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 5_000,
    );

    const sessions = discoverSessions({ cliHome, nowMs });
    assert.deepEqual(
      sessions.map((s) => s.convId),
      [coldBrainId],
    );
    assert.equal(sessions[0]?.dataRoot, cliHome);
  });

  void it('discovers cold conversation DBs without summary rows or envelopes', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const coldDbId = 'cli-cold-db-5678';
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(path.join(convDir, `${coldDbId}.db`));
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.close();

    const sessions = discoverSessions({ cliHome, nowMs });
    assert.deepEqual(
      sessions.map((s) => s.convId),
      [coldDbId],
    );
    assert.equal(sessions[0]?.dataRoot, cliHome);
  });

  void it('merges snapshot envelope metadata with on-disk CLI transcript entries', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const convId = 'cli-merged-9999';
    writeTranscript(cliHome, convId, [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }], nowMs - 5_000);
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    writeFileSync(
      path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`),
      JSON.stringify({
        v: 2,
        convId,
        conversationTitle: 'Envelope Title',
        agyPid: 4242,
        cwd: wsRoot,
        workspaceCurrentDir: wsRoot,
        workspaceProjectDir: wsRoot,
        subagents: [],
        taskCount: null,
        mdDigest: null,
        updatedAtMs: nowMs,
        heartbeatAtMs: nowMs,
      }),
      'utf8',
    );

    const sessions = discoverSessions({ cliHome, nowMs, isAlive: (p) => p === 4242 });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.title, 'Envelope Title');
    assert.equal(sessions[0]?.livePid, 4242);
    assert.equal(sessions[0]?.dataRoot, cliHome);
  });

  void it('reuses cached summary DB snapshot across unchanged reads and invalidates on DB mutation', () => {
    const ws = path.join(tmpRoot, 'proj-cache');
    mkdirSync(ws, { recursive: true });
    writeSummaryDb(cliHome, [
      { id: 'conv-cache-1', title: 'Initial Title', lastModifiedIso: '2026-11-27T10:00:00Z', workspaces: [ws] },
    ]);

    const first = loadSummaryDbSnapshot(cliHome);
    const second = loadSummaryDbSnapshot(cliHome);
    assert.notEqual(first, null);
    assert.equal(first, second, 'unchanged summary DB must reuse cached snapshot instance');

    writeSummaryDb(cliHome, [
      { id: 'conv-cache-1', title: 'Updated Title', lastModifiedIso: '2026-11-27T10:05:00Z', workspaces: [ws] },
    ]);
    const third = loadSummaryDbSnapshot(cliHome);
    assert.notEqual(third, first);
    assert.equal(third?.rows[0]?.title, 'Updated Title');
  });
});
