import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { formatCliStorageLine, formatCliStorageNote, inspectCliStorageHealth } from '../storage-check.ts';

const requireModule = createRequire(import.meta.url);

void describe('read-only doctor CLI Home storage health check', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-storage-check-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('reports zero storage cleanly for a fresh empty CLI Home', () => {
    const report = inspectCliStorageHealth(cliHome, { sqliteOk: true });
    assert.equal(report.conversations.dbCount, 0);
    assert.equal(report.cache.hudCacheCount, 0);
    assert.equal(report.truncated, false);
    assert.deepEqual(report.notes, []);
    assert.ok(formatCliStorageLine(report).includes('0 DBs'));
    assert.equal(formatCliStorageNote(report), null);
  });

  void it('counts conversations and HUD cache files without following symlinks or mutating WAL directories', () => {
    const convDir = path.join(cliHome, 'conversations');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    // Create two regular .db files and one -wal sidecar (never opened!) plus an outside symlink that must be ignored
    const outsideFile = path.join(tmpRoot, 'outside.db');
    writeFileSync(outsideFile, Buffer.alloc(1024 * 1024));
    writeFileSync(path.join(convDir, 'main-1.db'), Buffer.alloc(2 * 1024 * 1024));
    writeFileSync(path.join(convDir, 'sub-1.db'), Buffer.alloc(1024 * 1024));
    writeFileSync(path.join(convDir, 'main-1.db-wal'), Buffer.alloc(512 * 1024));
    if (process.platform !== 'win32') {
      symlinkSync(outsideFile, path.join(convDir, 'symlink-trap.db'));
    }

    writeFileSync(path.join(cacheDir, 'agy_hud_snapshot_main-1.json'), '{"v":2}\n', 'utf8');
    writeFileSync(path.join(cacheDir, 'agy_hud_proc.json.tmp.123.456.0123456789abcdef'), '{}\n', 'utf8');
    writeFileSync(path.join(cacheDir, 'unrelated.txt'), 'keep\n', 'utf8');

    // Populate a genuine closed-writer non-empty WAL conversation_summaries.db fixture via a staging handle pair
    const sqlite = requireModule('node:sqlite') as typeof import('node:sqlite');
    const stagingDir = path.join(tmpRoot, 'wal-staging');
    mkdirSync(stagingDir, { recursive: true });
    const stageDbPath = path.join(stagingDir, 'conversation_summaries.db');
    const summaryDbPath = path.join(cliHome, 'conversation_summaries.db');
    const summaryWalPath = `${summaryDbPath}-wal`;
    const writer = new sqlite.DatabaseSync(stageDbPath);
    let reader: InstanceType<typeof sqlite.DatabaseSync> | null = null;
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      writer.exec(
        'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, nesting_depth INTEGER, killed INTEGER);',
      );
      reader = new sqlite.DatabaseSync(stageDbPath);
      reader.exec('BEGIN; SELECT count(*) FROM conversation_summaries;');
      writer.exec("INSERT INTO conversation_summaries VALUES ('main-1', 0, 0), ('sub-1', 1, 0);");
      // Copy main DB + non-empty uncheckpointed -wal while staging reader prevents auto-checkpoint, then close both handles
      copyFileSync(stageDbPath, summaryDbPath);
      copyFileSync(`${stageDbPath}-wal`, summaryWalPath);
    } finally {
      reader?.close();
      writer.close();
    }

    const beforeConvEntries = readdirSync(convDir).sort();
    const beforeCliEntries = readdirSync(cliHome).sort();
    const beforeSummaryBytes = readFileSync(summaryDbPath);
    const beforeSummaryWalBytes = readFileSync(summaryWalPath);
    assert.ok(beforeSummaryWalBytes.length > 0, 'closed-writer WAL fixture must be non-empty');
    const report = inspectCliStorageHealth(cliHome, { sqliteOk: true });
    assert.deepEqual(readdirSync(convDir).sort(), beforeConvEntries);
    assert.deepEqual(readdirSync(cliHome).sort(), beforeCliEntries);
    assert.equal(readFileSync(summaryDbPath).equals(beforeSummaryBytes), true);
    assert.equal(readFileSync(summaryWalPath).equals(beforeSummaryWalBytes), true);

    assert.equal(report.conversations.dbCount, 2);
    assert.equal(report.conversations.walCount, 1);
    assert.equal(report.conversations.mainDbCount, 1);
    assert.equal(report.conversations.subagentDbCount, 1);
    assert.equal(report.cache.hudCacheCount, 2);
    assert.equal(report.cache.staleOrphanCount, 1);
    const line = formatCliStorageLine(report);
    assert.ok(line.includes('2 DBs: 1 main, 1 subagents'));
    assert.ok(line.includes('1 WAL'));

    // Cache-only truncation must NOT disable conversations attribution (add extra cache entries so ONLY cache exceeds maxEntriesPerDir)
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(path.join(cacheDir, `agy_hud_telemetry_extra_${i}.json`), '{}', 'utf8');
    }
    const cacheTruncReport = inspectCliStorageHealth(cliHome, { sqliteOk: true, maxEntriesPerDir: 5 });
    assert.equal(cacheTruncReport.truncated, true);
    assert.equal(cacheTruncReport.conversations.dbCount, 2);
    assert.equal(cacheTruncReport.conversations.mainDbCount, 1);
    assert.equal(cacheTruncReport.conversations.subagentDbCount, 1);

    // Exhausting wall budget inside summary WAL copy/open must mark truncated without mutating host WAL files
    let walTicks = 0;
    const walTimeoutReport = inspectCliStorageHealth(cliHome, {
      sqliteOk: true,
      maxWallMs: 10,
      nowMs: () => {
        walTicks += 1;
        // Allow conv + cache scan + entry check, expire during readonly WAL copy/open
        return walTicks <= 4 ? 0 : 50;
      },
    });
    assert.equal(walTimeoutReport.truncated, true);
    assert.equal(walTimeoutReport.conversations.mainDbCount, null);
    assert.deepEqual(readdirSync(cliHome).sort(), beforeCliEntries);
    assert.equal(readFileSync(summaryDbPath).equals(beforeSummaryBytes), true);
    assert.equal(readFileSync(summaryWalPath).equals(beforeSummaryWalBytes), true);
  });

  void it('enforces directory entry budget and marks partial scan cleanly', () => {
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(path.join(convDir, `conv-${i}.db`), 'x', 'utf8');
    }
    const report = inspectCliStorageHealth(cliHome, { sqliteOk: false, maxEntriesPerDir: 3 });
    assert.equal(report.truncated, true);
    assert.equal(report.conversations.dbCount, 3);
    assert.ok(formatCliStorageLine(report).includes('partial scan'));

    // When wall budget expires right before summary attribution on an existing summary DB, truncated must be true
    writeFileSync(path.join(cliHome, 'conversation_summaries.db'), 'x', 'utf8');
    let ticks = 0;
    const wallReport = inspectCliStorageHealth(cliHome, {
      sqliteOk: true,
      maxWallMs: 10,
      nowMs: () => {
        ticks += 1;
        return ticks <= 2 ? 0 : 100;
      },
    });
    assert.equal(wallReport.truncated, true);
    assert.equal(wallReport.conversations.mainDbCount, null);
  });

  void it('emits safe host vs HUD cache advisory notes when bloat thresholds trigger', () => {
    const convDir = path.join(cliHome, 'conversations');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    // Trigger single-WAL >= 64 MiB and HUD cache >= 64 MiB via sparse threshold-override options
    writeFileSync(path.join(convDir, 'big.db'), Buffer.alloc(1024));
    writeFileSync(path.join(convDir, 'big.db-wal'), Buffer.alloc(2048));
    writeFileSync(path.join(cacheDir, 'agy_hud_telemetry_big.json'), Buffer.alloc(2048));

    const healthy = inspectCliStorageHealth(cliHome, { sqliteOk: false });
    assert.equal(healthy.notes.length, 0);

    const bloated = inspectCliStorageHealth(cliHome, {
      sqliteOk: false,
      thresholds: {
        maxWalBytes: 1024,
        hudCacheBytes: 1024,
      },
    });
    const note = formatCliStorageNote(bloated);
    assert.ok(note !== null);
    assert.ok(note.includes('/conversations'));
    assert.ok(note.includes('agy-hud unwire && agy-hud wire'));
  });
});
