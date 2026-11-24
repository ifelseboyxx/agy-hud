import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { discoverSessions, resolveSession, SessionResolutionError, writeSnapshotEnvelope } from '../session-index.ts';

interface SummaryRowSeed {
  id: string;
  title: string;
  lastModifiedIso: string;
  workspaces: string[];
  source?: string;
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
      r.source ?? 'CORTEX_TRAJECTORY_SOURCE_CLIENT',
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

void describe('multi-root discovery and 4-tier session resolution', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let ideRoot = '';
  let wsRoot = '';
  let wsNested = '';
  let wsOther = '';
  const chmodRestore: string[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-discover-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    ideRoot = path.join(geminiRoot, 'antigravity-ide');
    wsRoot = path.join(tmpRoot, 'repo');
    wsNested = path.join(wsRoot, 'packages', 'sub');
    wsOther = path.join(tmpRoot, 'other-proj');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsNested, { recursive: true });
    mkdirSync(wsOther, { recursive: true });
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

  void it('discovers cli, app, and ide roots while skipping ide without brain/ and filtering subagent or killed rows', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeTranscript(
      cliHome,
      'cli-1111-aaaa',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 60_000,
    );
    writeTranscript(
      appRoot,
      'app-2222-bbbb',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 30_000,
    );
    writeTranscript(
      appRoot,
      'sub-3333-cccc',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 10_000,
    );
    writeTranscript(
      appRoot,
      'kil-4444-dddd',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 10_000,
    );

    writeSummaryDb(cliHome, [
      {
        id: 'cli-1111-aaaa',
        title: 'CLI Work',
        lastModifiedIso: '2026-06-01T11:59:00Z',
        workspaces: [wsRoot],
        source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
      },
    ]);
    writeSummaryDb(appRoot, [
      { id: 'app-2222-bbbb', title: 'App Work', lastModifiedIso: '2026-06-01T11:59:30Z', workspaces: [wsRoot] },
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
    // antigravity-ide without brain/ directory must be skipped
    writeSummaryDb(ideRoot, [
      {
        id: 'ide-5555-eeee',
        title: 'IDE Without Brain',
        lastModifiedIso: '2026-06-01T11:59:40Z',
        workspaces: [wsRoot],
      },
    ]);

    const withoutIdeBrain = discoverSessions({ env: { GEMINI_CLI_HOME: tmpRoot }, nowMs });
    assert.deepEqual(withoutIdeBrain.map((s) => `${s.surface}:${s.convId}`).sort(), [
      'app:app-2222-bbbb',
      'cli:cli-1111-aaaa',
    ]);

    // Once antigravity-ide/brain/<id> exists, IDE root is scanned
    writeTranscript(
      ideRoot,
      'ide-5555-eeee',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 20_000,
    );
    const withIdeBrain = discoverSessions({ env: { GEMINI_CLI_HOME: tmpRoot }, nowMs });
    assert.deepEqual(withIdeBrain.map((s) => `${s.surface}:${s.convId}`).sort(), [
      'app:app-2222-bbbb',
      'cli:cli-1111-aaaa',
      'ide:ide-5555-eeee',
    ]);
  });

  void it('deduplicates cross-indexed CORTEX_TRAJECTORY_SOURCE_CLI rows by physical on-disk ownership', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const sharedCliId = 'cli-owned-9999';
    writeTranscript(
      cliHome,
      sharedCliId,
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 5_000,
    );
    // Row appears in antigravity/conversation_summaries.db with CORTEX_TRAJECTORY_SOURCE_CLI,
    // while physical brain/<id> exists ONLY under antigravity-cli.
    writeSummaryDb(appRoot, [
      {
        id: sharedCliId,
        title: 'Cross Indexed CLI Session',
        lastModifiedIso: '2026-06-01T11:59:55Z',
        workspaces: [wsRoot],
        source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
      },
    ]);
    writeSummaryDb(cliHome, [
      {
        id: sharedCliId,
        title: 'Cross Indexed CLI Session',
        lastModifiedIso: '2026-06-01T11:59:55Z',
        workspaces: [wsRoot],
        source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
      },
    ]);

    const sessions = discoverSessions({ cliHome, geminiRoot, nowMs });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.convId, sharedCliId);
    assert.equal(sessions[0]?.surface, 'cli');
    assert.equal(sessions[0]?.dataRoot, cliHome);
  });

  void it('keeps client roots 100% read-only under chmod 0o555 during discovery', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeTranscript(appRoot, 'app-ro-1111', [{ type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [] }], nowMs);
    writeSummaryDb(appRoot, [
      {
        id: 'app-ro-1111',
        title: 'Read Only App',
        lastModifiedIso: '2026-06-01T12:00:00Z',
        workspaces: [wsRoot],
        notFullyIdle: 1,
      },
    ]);

    const before = readdirSync(appRoot).sort();
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(appRoot, 0o555);
      chmodRestore.push(appRoot);
    }

    const sessions = discoverSessions({ cliHome, geminiRoot, nowMs });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.surface, 'app');
    assert.equal(sessions[0]?.running, true);
    assert.deepEqual(readdirSync(appRoot).sort(), before);
    assert.equal(existsSync(path.join(appRoot, 'cache')), false);
  });

  void it('resolves Tier 0 exact ID and unique >=4-char prefix and throws with candidate list on ambiguity', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeTranscript(cliHome, 'abcd1111-cli', [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }], nowMs);
    writeTranscript(appRoot, 'abcd2222-app', [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }], nowMs);
    writeSummaryDb(cliHome, [
      {
        id: 'abcd1111-cli',
        title: 'First',
        lastModifiedIso: '2026-06-01T12:00:00Z',
        workspaces: [wsRoot],
        source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
      },
    ]);
    writeSummaryDb(appRoot, [
      { id: 'abcd2222-app', title: 'Second', lastModifiedIso: '2026-06-01T12:00:00Z', workspaces: [wsRoot] },
    ]);

    const exact = resolveSession({ cliHome, geminiRoot, session: 'abcd2222-app', nowMs });
    assert.equal(exact.tier, 'explicit');
    assert.equal(exact.session.convId, 'abcd2222-app');

    const uniquePrefix = resolveSession({ cliHome, geminiRoot, session: 'abcd1', nowMs });
    assert.equal(uniquePrefix.tier, 'explicit');
    assert.equal(uniquePrefix.session.convId, 'abcd1111-cli');

    const scopedPrefix = resolveSession({ cliHome, geminiRoot, session: 'abcd', source: 'app', nowMs });
    assert.equal(scopedPrefix.session.convId, 'abcd2222-app');

    assert.throws(
      () => resolveSession({ cliHome, geminiRoot, session: 'abcd', source: 'auto', nowMs }),
      (err: unknown) =>
        err instanceof SessionResolutionError &&
        err.message.includes('abcd1111-cli') &&
        err.message.includes('abcd2222-app'),
    );

    assert.throws(() => resolveSession({ cliHome, geminiRoot, session: 'abc', nowMs }), SessionResolutionError);
  });

  void it('resolves Tier 1 by live ancestor agyPid for auto/cli and skips Tier 1 for --source app', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-old-same-pid', cwd: wsRoot, conversation_title: 'Before /clear' },
      2000,
      { nowMs: nowMs - 20_000 },
    );
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-new-same-pid', cwd: wsRoot, conversation_title: 'After /clear' },
      2000,
      { nowMs: nowMs - 5_000 },
    );
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-other-tui', cwd: wsRoot, conversation_title: 'Other TUI' },
      3000,
      { nowMs: nowMs - 1_000 },
    );
    writeTranscript(appRoot, 'app-sibling-1111', [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }], nowMs);
    writeSummaryDb(appRoot, [
      { id: 'app-sibling-1111', title: 'App Sibling', lastModifiedIso: '2026-06-01T12:00:00Z', workspaces: [wsRoot] },
    ]);

    const alive = new Set([2000, 3000]);
    const hitAuto = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsRoot,
      source: 'auto',
      callerAgyPid: 2000,
      nowMs,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(hitAuto.tier, 'pid');
    assert.equal(hitAuto.session.convId, 'cli-new-same-pid');

    const skipForApp = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsRoot,
      source: 'app',
      callerAgyPid: 2000,
      nowMs,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(skipForApp.tier, 'workspace');
    assert.equal(skipForApp.session.convId, 'app-sibling-1111');
  });

  void it('ranks Tier 2 deepest workspace by active execution then recency, excludes dead CLI PIDs, and reports siblings', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    // Dead-PID CLI session with very recent timestamp must be excluded from Tier 2
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-dead-pid', cwd: wsRoot, conversation_title: 'Dead CLI' },
      9999,
      { nowMs },
    );
    // Live but idle CLI session (older)
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-live-idle', cwd: wsRoot, conversation_title: 'Idle CLI' },
      4001,
      { nowMs: nowMs - 60_000 },
    );
    // Newer idle App session in same wsRoot -> must beat older idle live CLI!
    writeTranscript(
      appRoot,
      'app-newer-idle',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 10_000,
    );
    writeSummaryDb(appRoot, [
      {
        id: 'app-newer-idle',
        title: 'Newer App',
        lastModifiedIso: '2026-06-01T11:59:50Z',
        workspaces: [wsRoot],
        notFullyIdle: 0,
      },
      {
        id: 'app-nested-ws',
        title: 'Nested WS App',
        lastModifiedIso: '2026-06-01T11:50:00Z',
        workspaces: [wsNested],
        notFullyIdle: 0,
      },
    ]);
    writeTranscript(
      appRoot,
      'app-nested-ws',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 600_000,
    );

    const alive = new Set([4001]);
    const atRoot = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsRoot,
      callerAgyPid: null,
      nowMs,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(atRoot.tier, 'workspace');
    assert.equal(atRoot.session.convId, 'app-newer-idle');
    assert.ok(atRoot.siblings.some((s) => s.convId === 'cli-live-idle'));
    assert.equal(
      atRoot.siblings.some((s) => s.convId === 'cli-dead-pid'),
      false,
    );

    // Inside nested dir, deepest matching root (wsNested) wins over parent wsRoot
    const atNested = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsNested,
      callerAgyPid: null,
      nowMs,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(atNested.tier, 'workspace');
    assert.equal(atNested.session.convId, 'app-nested-ws');

    // If CLI session becomes actively running, active execution beats newer idle App session
    writeTranscript(
      cliHome,
      'cli-live-idle',
      [{ type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [] }],
      nowMs - 30_000,
    );
    const activeWins = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsRoot,
      callerAgyPid: null,
      nowMs,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(activeWins.tier, 'workspace');
    assert.equal(activeWins.session.convId, 'cli-live-idle');
  });

  void it('falls back to Tier 3 newest live/recent session within --source when cwd matches no workspace', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-dead-1111', cwd: wsRoot, conversation_title: 'Dead CLI' },
      9991,
      { nowMs },
    );
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-live-2222', cwd: wsRoot, conversation_title: 'Live CLI' },
      5001,
      { nowMs: nowMs - 30_000 },
    );
    writeTranscript(
      appRoot,
      'app-recent-3333',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 5_000,
    );
    writeSummaryDb(appRoot, [
      { id: 'app-recent-3333', title: 'Recent App', lastModifiedIso: '2026-06-01T11:59:55Z', workspaces: [wsRoot] },
    ]);

    const alive = new Set([5001]);
    const fallbackAuto = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsOther,
      source: 'auto',
      callerAgyPid: null,
      nowMs,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(fallbackAuto.tier, 'fallback');
    assert.equal(fallbackAuto.session.convId, 'app-recent-3333');

    const fallbackCli = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsOther,
      source: 'cli',
      callerAgyPid: null,
      nowMs,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(fallbackCli.tier, 'fallback');
    assert.equal(fallbackCli.session.convId, 'cli-live-2222');
  });
});
