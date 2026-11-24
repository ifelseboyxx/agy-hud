import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveSession, SessionResolutionError, writeSnapshotEnvelope } from '../session-index.ts';

interface SummaryRowSeed {
  id: string;
  title: string;
  lastModifiedIso: string;
  workspaces: string[];
  source?: string;
  notFullyIdle?: number;
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
  const stmt = db.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)');
  for (const r of rows) {
    stmt.run(
      r.id,
      r.title,
      r.lastModifiedIso,
      JSON.stringify(r.workspaces.map((ws) => pathToFileURL(ws).href)),
      r.source ?? 'CORTEX_TRAJECTORY_SOURCE_CLIENT',
      r.notFullyIdle ?? 0,
      'CASCADE_RUN_STATUS_IDLE',
    );
  }
  db.close();
}

function writeTranscript(rootDir: string, convId: string, lines: readonly unknown[], mtimeMs?: number): void {
  const logsDir = path.join(rootDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'transcript.jsonl');
  writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  if (mtimeMs !== undefined) {
    const sec = mtimeMs / 1000;
    utimesSync(filePath, sec, sec);
  }
}

void describe('4-tier session resolution', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let wsRoot = '';
  let wsNested = '';
  let wsOther = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-resolve-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    wsRoot = path.join(tmpRoot, 'repo');
    wsNested = path.join(wsRoot, 'packages', 'sub');
    wsOther = path.join(tmpRoot, 'other-proj');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsNested, { recursive: true });
    mkdirSync(wsOther, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('resolves Tier 0 exact ID or unique prefix', () => {
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
  });

  void it('throws SessionResolutionError listing candidates on ambiguous or short prefixes', () => {
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

    assert.throws(
      () => resolveSession({ cliHome, geminiRoot, session: 'abcd', source: 'auto', nowMs }),
      (err: unknown) =>
        err instanceof SessionResolutionError &&
        err.message.includes('abcd1111-cli') &&
        err.message.includes('abcd2222-app'),
    );
    assert.throws(() => resolveSession({ cliHome, geminiRoot, session: 'abc', nowMs }), SessionResolutionError);
  });

  void it('resolves Tier 1 by live ancestor agyPid for auto source', () => {
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
  });

  void it('skips Tier 1 PID matching when --source app is requested', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(cliHome, { conversation_id: 'cli-same-pid', cwd: wsRoot, conversation_title: 'CLI' }, 2000, {
      nowMs: nowMs - 5_000,
    });
    writeTranscript(appRoot, 'app-sibling-1111', [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }], nowMs);
    writeSummaryDb(appRoot, [
      { id: 'app-sibling-1111', title: 'App Sibling', lastModifiedIso: '2026-06-01T12:00:00Z', workspaces: [wsRoot] },
    ]);

    const res = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsRoot,
      source: 'app',
      callerAgyPid: 2000,
      nowMs,
      isAlive: (p) => p === 2000,
    });
    assert.equal(res.tier, 'workspace');
    assert.equal(res.session.convId, 'app-sibling-1111');
  });

  void it('excludes dead CLI PIDs while reporting live workspace siblings in Tier 2', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(cliHome, { conversation_id: 'cli-dead-pid', cwd: wsRoot, conversation_title: 'Dead' }, 9999, {
      nowMs,
    });
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-live-idle', cwd: wsRoot, conversation_title: 'Idle CLI' },
      4001,
      { nowMs: nowMs - 60_000 },
    );
    writeTranscript(
      appRoot,
      'app-newer-idle',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 10_000,
    );
    writeSummaryDb(appRoot, [
      { id: 'app-newer-idle', title: 'Newer App', lastModifiedIso: '2026-06-01T11:59:50Z', workspaces: [wsRoot] },
    ]);

    const atRoot = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsRoot,
      callerAgyPid: null,
      nowMs,
      isAlive: (p) => p === 4001,
    });
    assert.equal(atRoot.tier, 'workspace');
    assert.equal(atRoot.session.convId, 'app-newer-idle');
    assert.ok(atRoot.siblings.some((s) => s.convId === 'cli-live-idle'));
    assert.equal(
      atRoot.siblings.some((s) => s.convId === 'cli-dead-pid'),
      false,
    );
  });

  void it('prefers deepest matching workspace root in Tier 2', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeTranscript(
      appRoot,
      'app-parent-ws',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 10_000,
    );
    writeTranscript(
      appRoot,
      'app-nested-ws',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 600_000,
    );
    writeSummaryDb(appRoot, [
      { id: 'app-parent-ws', title: 'Parent', lastModifiedIso: '2026-06-01T11:59:50Z', workspaces: [wsRoot] },
      { id: 'app-nested-ws', title: 'Nested', lastModifiedIso: '2026-06-01T11:50:00Z', workspaces: [wsNested] },
    ]);

    const atNested = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsNested,
      callerAgyPid: null,
      nowMs,
      isAlive: () => false,
    });
    assert.equal(atNested.tier, 'workspace');
    assert.equal(atNested.session.convId, 'app-nested-ws');
  });

  void it('prefers actively running execution over newer idle sessions in Tier 2', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-active', cwd: wsRoot, conversation_title: 'Active CLI' },
      4001,
      { nowMs: nowMs - 30_000 },
    );
    writeTranscript(
      cliHome,
      'cli-active',
      [{ type: 'PLANNER_RESPONSE', status: 'RUNNING', tool_calls: [] }],
      nowMs - 30_000,
    );
    writeTranscript(
      appRoot,
      'app-newer-idle',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 5_000,
    );
    writeSummaryDb(appRoot, [
      { id: 'app-newer-idle', title: 'Newer App', lastModifiedIso: '2026-06-01T11:59:55Z', workspaces: [wsRoot] },
    ]);

    const activeWins = resolveSession({
      cliHome,
      geminiRoot,
      cwd: wsRoot,
      callerAgyPid: null,
      nowMs,
      isAlive: (p) => p === 4001,
    });
    assert.equal(activeWins.tier, 'workspace');
    assert.equal(activeWins.session.convId, 'cli-active');
  });

  void it('falls back to Tier 3 newest live or recent session when cwd matches no workspace', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-dead-1111', cwd: wsRoot, conversation_title: 'Dead' },
      9991,
      {
        nowMs,
      },
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
