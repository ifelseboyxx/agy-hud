import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { ActivitySnapshot } from '../src/snapshot-types.ts';
import { createTempDirTracker, DIST_CLI, DIST_HUD, makeIsolatedEnv, runNodeScript } from './helpers.ts';

void describe('cross-surface HUD -> snapshot CLI e2e', () => {
  const tracker = createTempDirTracker();

  afterEach(() => {
    tracker.cleanup();
  });

  void it('persists HUD metadata envelope and inspects CLI and read-only App sessions via dist/cli.mjs', () => {
    const root = tracker.makeTempDir('agy-hud-snap-e2e-');
    const env = makeIsolatedEnv(root);
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const appRoot = path.join(root, '.gemini', 'antigravity');
    const wsDir = path.join(root, 'workspace');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    const cliConvId = 'e2e11111-cli-session';
    const cliLogs = path.join(cliHome, 'brain', cliConvId, '.system_generated', 'logs');
    mkdirSync(cliLogs, { recursive: true });
    writeFileSync(
      path.join(cliLogs, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'README.md') } }],
      })}\n`,
      'utf8',
    );

    const hudRes = runNodeScript(
      DIST_HUD,
      [],
      env,
      JSON.stringify({
        conversation_id: cliConvId,
        conversation_title: 'E2E CLI Session',
        cwd: wsDir,
        workspace: { current_dir: wsDir, project_dir: wsDir },
        model: { display_name: 'Gemini 4 Carbon' },
      }),
    );
    assert.equal(hudRes.status, 0, hudRes.stderr);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${cliConvId}.json`)), true);

    const appConvId = 'e2e12222-app-session';
    const appLogs = path.join(appRoot, 'brain', appConvId, '.system_generated', 'logs');
    mkdirSync(appLogs, { recursive: true });
    writeFileSync(
      path.join(appLogs, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        tool_calls: [{ name: 'mcp_docs_search', args: { query: 'hud' } }],
      })}\n`,
      'utf8',
    );
    const db = new DatabaseSync(path.join(appRoot, 'conversation_summaries.db'));
    db.exec(
      `CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, last_modified_time TEXT, workspace_uris TEXT, source TEXT, not_fully_idle INTEGER, status TEXT, nesting_depth INTEGER, killed INTEGER)`,
    );
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      appConvId,
      'E2E App Session',
      '2026-06-01T12:00:00Z',
      JSON.stringify([pathToFileURL(wsDir).href]),
      'CORTEX_TRAJECTORY_SOURCE_CLIENT',
      0,
      'CASCADE_RUN_STATUS_IDLE',
      0,
      0,
    );
    db.close();

    const beforeApp = readdirSync(appRoot).sort();
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(appLogs, 0o555);
      chmodSync(appRoot, 0o555);
    }

    const listRes = runNodeScript(DIST_CLI, ['snapshot', '--sessions'], env);
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.ok(listRes.stdout.includes('[CLI]'));
    assert.ok(listRes.stdout.includes('[App]'));
    assert.ok(listRes.stdout.includes('e2e11111'));
    assert.ok(listRes.stdout.includes('e2e12222'));

    const appJsonRes = runNodeScript(DIST_CLI, ['snap', '--source', 'app', '--json'], env);
    assert.equal(appJsonRes.status, 0, appJsonRes.stderr);
    const snap = JSON.parse(appJsonRes.stdout) as ActivitySnapshot;
    assert.equal(snap.convId, appConvId);
    assert.equal(snap.surface, 'app');
    assert.equal(snap.mcps[0]?.server, 'docs');
    assert.equal(existsSync(path.join(appRoot, 'cache')), false);
    assert.deepEqual(readdirSync(appRoot).sort(), beforeApp);

    const bareRes = runNodeScript(DIST_CLI, [], env);
    assert.equal(bareRes.status, 0, bareRes.stderr);
    assert.ok(bareRes.stdout.includes('Activity Snapshot'));

    const ambigRes = runNodeScript(DIST_CLI, ['snapshot', '-s', 'e2e1'], env);
    assert.equal(ambigRes.status, 1);
    assert.ok(ambigRes.stderr.includes(cliConvId));
    assert.ok(ambigRes.stderr.includes(appConvId));
  });
});
