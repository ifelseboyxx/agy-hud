import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { ActivitySnapshot } from '../src/snapshot-types.ts';
import { createTempDirTracker, DIST_CLI, DIST_HUD, makeIsolatedEnv, runNodeScript } from './helpers.ts';

void describe('CLI HUD -> snapshot CLI e2e', () => {
  const tracker = createTempDirTracker();

  afterEach(() => {
    tracker.cleanup();
  });

  void it('persists HUD metadata envelope and inspects CLI sessions via dist/cli.mjs', () => {
    const root = tracker.makeTempDir('agy-hud-snap-e2e-');
    const env = makeIsolatedEnv(root);
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const wsDir = path.join(root, 'workspace');
    mkdirSync(cliHome, { recursive: true });
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

    const secondConvId = 'e2e12222-cli-summary';
    const secondLogs = path.join(cliHome, 'brain', secondConvId, '.system_generated', 'logs');
    mkdirSync(secondLogs, { recursive: true });
    writeFileSync(
      path.join(secondLogs, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        tool_calls: [{ name: 'mcp_docs_search', args: { query: 'hud' } }],
      })}\n`,
      'utf8',
    );
    const db = new DatabaseSync(path.join(cliHome, 'conversation_summaries.db'));
    db.exec(
      `CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, last_modified_time TEXT, workspace_uris TEXT, source TEXT, not_fully_idle INTEGER, status TEXT, nesting_depth INTEGER, killed INTEGER)`,
    );
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      secondConvId,
      'E2E Summary CLI Session',
      '2026-06-01T12:00:00Z',
      JSON.stringify([pathToFileURL(wsDir).href]),
      'CORTEX_TRAJECTORY_SOURCE_CLI',
      0,
      'CASCADE_RUN_STATUS_IDLE',
      0,
      0,
    );
    db.close();

    const listRes = runNodeScript(DIST_CLI, ['snapshot', '--sessions'], env);
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.equal(listRes.stdout.includes('[CLI]'), false);
    assert.ok(listRes.stdout.includes('e2e11111'));
    assert.ok(listRes.stdout.includes('e2e12222'));

    const jsonRes = runNodeScript(DIST_CLI, ['snap', '-s', secondConvId, '--json'], env);
    assert.equal(jsonRes.status, 0, jsonRes.stderr);
    const snap = JSON.parse(jsonRes.stdout) as ActivitySnapshot;
    assert.equal(snap.convId, secondConvId);
    assert.equal(snap.mcps[0]?.server, 'docs');

    const bareRes = runNodeScript(DIST_CLI, [], env);
    assert.equal(bareRes.status, 0, bareRes.stderr);
    assert.ok(bareRes.stdout.includes('Activity Snapshot'));

    const ambigRes = runNodeScript(DIST_CLI, ['snapshot', '-s', 'e2e1'], env);
    assert.equal(ambigRes.status, 1);
    assert.ok(ambigRes.stderr.includes(cliConvId));
    assert.ok(ambigRes.stderr.includes(secondConvId));
  });
});
