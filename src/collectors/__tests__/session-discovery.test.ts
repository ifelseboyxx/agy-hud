import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { discoverSessions } from '../session-index.ts';

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

void describe('multi-root session discovery', () => {
  let tmpRoot = '';
  let geminiRoot = '';
  let cliHome = '';
  let appRoot = '';
  let ideRoot = '';
  let wsRoot = '';
  const chmodRestore: string[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-discover-'));
    geminiRoot = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiRoot, 'antigravity-cli');
    appRoot = path.join(geminiRoot, 'antigravity');
    ideRoot = path.join(geminiRoot, 'antigravity-ide');
    wsRoot = path.join(tmpRoot, 'repo');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
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

  void it('skips antigravity-ide when its brain directory is absent', () => {
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    writeTranscript(
      cliHome,
      'cli-1111-aaaa',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 60_000,
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
    writeSummaryDb(ideRoot, [
      {
        id: 'ide-5555-eeee',
        title: 'IDE Without Brain',
        lastModifiedIso: '2026-06-01T11:59:40Z',
        workspaces: [wsRoot],
      },
    ]);

    const discovered = discoverSessions({ env: { GEMINI_CLI_HOME: tmpRoot }, nowMs });
    assert.deepEqual(
      discovered.map((s) => `${s.surface}:${s.convId}`),
      ['cli:cli-1111-aaaa'],
    );
  });

  void it('discovers top-level multi-root sessions while excluding nested or killed rows', () => {
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
    writeTranscript(
      ideRoot,
      'ide-5555-eeee',
      [{ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }],
      nowMs - 20_000,
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
    writeSummaryDb(ideRoot, [
      { id: 'ide-5555-eeee', title: 'IDE Work', lastModifiedIso: '2026-06-01T11:59:40Z', workspaces: [wsRoot] },
    ]);

    const discovered = discoverSessions({ env: { GEMINI_CLI_HOME: tmpRoot }, nowMs });
    assert.deepEqual(discovered.map((s) => `${s.surface}:${s.convId}`).sort(), [
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

  void it('keeps client roots read-only under chmod 0o555 during discovery', () => {
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
});
