import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { discoverSessions } from '../session-discovery.ts';
import { loadActivitySnapshot } from '../snapshot-loader.ts';
import { withReadonlyDb } from '../sqlite-readonly.ts';
import { loadSessionTelemetryFromRoot } from '../telemetry.ts';

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

function buildGenBlob(ctxUsed: number, ctxMax: number): Uint8Array {
  const usage = [...encodeFieldVarint(2, 500), ...encodeFieldVarint(3, 150), ...encodeFieldVarint(5, 1000)];
  const ctxWin = [...encodeFieldVarint(1, ctxUsed), ...encodeFieldVarint(4, ctxMax)];
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

function snapshotTree(rootDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result[rel] = 'dir';
        walk(full, rel);
      } else {
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        result[rel] = `file:${digest}`;
      }
    }
  };
  walk(rootDir, '');
  return result;
}

function createSummarySchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
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
    );
  `);
}

void describe('strict read-only SQLite WAL isolation on CLI roots', () => {
  let tmpRoot = '';
  let cacheCliHome = '';
  let roCliHome = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-wal-ro-'));
    cacheCliHome = path.join(tmpRoot, 'cache-cli-home');
    roCliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    wsDir = path.join(tmpRoot, 'ws');
    mkdirSync(cacheCliHome, { recursive: true });
    mkdirSync(roCliHome, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('leaves CLI database directory entries and file contents unchanged for closed-writer WAL databases', () => {
    const convId = 'wal-closed-1234';
    const logsDir = path.join(roCliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
      'utf8',
    );

    const convDir = path.join(roCliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const convDb = new DatabaseSync(path.join(convDir, `${convId}.db`));
    convDb.exec('PRAGMA journal_mode = WAL; CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, buildGenBlob(42_000, 1_000_000));
    convDb.close();

    const summaryDb = new DatabaseSync(path.join(roCliHome, 'conversation_summaries.db'));
    createSummarySchema(summaryDb);
    summaryDb
      .prepare(
        `INSERT INTO conversation_summaries
         (conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status, nesting_depth, killed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        convId,
        'Closed Writer WAL Session',
        '2026-06-01T12:00:00Z',
        JSON.stringify([pathToFileURL(wsDir).href]),
        'CORTEX_TRAJECTORY_SOURCE_CLI',
        0,
        'CASCADE_RUN_STATUS_IDLE',
        0,
        0,
      );
    summaryDb.close();

    const before = snapshotTree(roCliHome);
    assert.equal('conversation_summaries.db-wal' in before, false);
    assert.equal('conversation_summaries.db-shm' in before, false);

    const sessions = discoverSessions({ cliHome: roCliHome, nowMs: Date.parse('2026-06-01T12:01:00Z') });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.title, 'Closed Writer WAL Session');

    const snapshot = loadActivitySnapshot(sessions[0]!, { cacheCliHome });
    assert.equal(snapshot.telemetry.ctxUsed, 42_000);

    assert.deepEqual(snapshotTree(roCliHome), before);
  });

  void it('reads live uncheckpointed WAL rows without modifying CLI directory entries or files', () => {
    const convId = 'wal-active-5678';
    const logsDir = path.join(roCliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
      'utf8',
    );

    const convDir = path.join(roCliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const convDb = new DatabaseSync(path.join(convDir, `${convId}.db`));
    const summaryDb = new DatabaseSync(path.join(roCliHome, 'conversation_summaries.db'));

    try {
      convDb.exec('PRAGMA journal_mode = WAL; CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
      convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, buildGenBlob(10_000, 1_000_000));
      convDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      // Uncheckpointed WAL frame.
      convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, buildGenBlob(88_000, 1_000_000));

      createSummarySchema(summaryDb);
      summaryDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      // Uncheckpointed summary row residing solely in -wal.
      summaryDb
        .prepare(
          `INSERT INTO conversation_summaries
           (conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status, nesting_depth, killed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          convId,
          'Live Uncheckpointed WAL Title',
          '2026-06-01T12:00:00Z',
          JSON.stringify([pathToFileURL(wsDir).href]),
          'CORTEX_TRAJECTORY_SOURCE_CLI',
          1,
          'CASCADE_RUN_STATUS_RUNNING',
          0,
          0,
        );

      const before = snapshotTree(roCliHome);
      assert.equal('conversation_summaries.db-wal' in before, true);

      const sessions = discoverSessions({ cliHome: roCliHome, nowMs: Date.parse('2026-06-01T12:01:00Z') });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.title, 'Live Uncheckpointed WAL Title');

      const snapshot = loadActivitySnapshot(sessions[0]!, { cacheCliHome });
      assert.equal(snapshot.telemetry.ctxUsed, 88_000);

      assert.deepEqual(snapshotTree(roCliHome), before);
    } finally {
      summaryDb.close();
      convDb.close();
    }
  });

  void it('retries WAL snapshot when live writer completes TRUNCATE checkpoint mid-copy', () => {
    const dbPath = path.join(roCliHome, 'race-truncate.db');
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);');
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      // Committed row resides solely in -wal before checkpoint.
      writer.prepare('INSERT INTO items (id, label) VALUES (?, ?)').run(1, 'committed-in-wal');

      let checkpointed = false;
      const rows = withReadonlyDb(
        dbPath,
        (db) => db.prepare('SELECT id, label FROM items ORDER BY id').all() as Array<{ id: number; label: string }>,
        {
          onAfterMainCopy: () => {
            if (!checkpointed) {
              checkpointed = true;
              writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            }
          },
        },
      );
      assert.equal(checkpointed, true);
      assert.deepEqual(
        rows?.map((r) => ({ id: r.id, label: r.label })),
        [{ id: 1, label: 'committed-in-wal' }],
      );
    } finally {
      writer.close();
    }
  });

  void it('retries WAL snapshot when live writer rotates WAL via RESTART checkpoint mid-copy', () => {
    const dbPath = path.join(roCliHome, 'race-restart.db');
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);');
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      writer.prepare('INSERT INTO items (id, label) VALUES (?, ?)').run(1, 'row-one');

      let rotated = false;
      const rows = withReadonlyDb(
        dbPath,
        (db) => db.prepare('SELECT id, label FROM items ORDER BY id').all() as Array<{ id: number; label: string }>,
        {
          onAfterMainCopy: () => {
            if (!rotated) {
              rotated = true;
              writer.exec('PRAGMA wal_checkpoint(RESTART);');
              writer.prepare('INSERT INTO items (id, label) VALUES (?, ?)').run(2, 'row-two');
            }
          },
        },
      );
      assert.equal(rotated, true);
      assert.deepEqual(
        rows?.map((r) => ({ id: r.id, label: r.label })),
        [
          { id: 1, label: 'row-one' },
          { id: 2, label: 'row-two' },
        ],
      );
    } finally {
      writer.close();
    }
  });

  void it('recovers telemetry after a transient WAL temp-dir read failure without caching empty rows', () => {
    if (process.platform === 'win32') return;
    const convId = 'wal-transient-fail-9999';
    const convDir = path.join(roCliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${convId}.db`);
    const writer = new DatabaseSync(dbPath);
    const prevTmpDir = process.env.TMPDIR;
    try {
      writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      writer.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, buildGenBlob(73_000, 1_000_000));

      // Force temp-dir creation failure while WAL is active.
      process.env.TMPDIR = path.join(tmpRoot, 'missing-parent', 'uncreatable');
      const failedTel = loadSessionTelemetryFromRoot(roCliHome, cacheCliHome, convId, {});
      assert.equal(failedTel.genCount, 0);

      // Restore TMPDIR; next load must NOT hit a poisoned empty cache and must read the committed WAL row.
      if (prevTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpDir;

      const recoveredTel = loadSessionTelemetryFromRoot(roCliHome, cacheCliHome, convId, {});
      assert.equal(recoveredTel.genCount, 1);
      assert.equal(recoveredTel.ctxUsed, 73_000);
    } finally {
      if (prevTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpDir;
      writer.close();
    }
  });
});
