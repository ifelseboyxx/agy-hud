import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { configureHud } from '../src/cli/configure.ts';
import { runSnapshotCommand } from '../src/cli/snapshot.ts';
import { runHudRender } from '../src/hud-runner.ts';
import { stripAnsi } from '../src/render/ansi.ts';
import type { ActivitySnapshot } from '../src/snapshot-types.ts';
import type { StatusLineData } from '../src/types.ts';
import { createTempDirTracker } from './helpers.ts';

const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

void describe('3-surface CLI multi-currency cost parity', () => {
  void it('propagates USD + CNY cost and subagent breakdown identically across HUD, Markdown, and CLI snapshot', () => {
    const root = tracker.makeTempDir('agy-hud-cost-parity-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const wsDir = path.join(root, 'workspace');
    const convId = 'cost-parity-1234';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'a.ts') } }],
      })}\n`,
      'utf8',
    );

    configureHud({ cliHome, preset: 'compact', sets: ['costCurrency=both', 'usdToCnyRate=7.25'] });

    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const data: StatusLineData = {
      conversation_id: convId,
      conversation_title: 'Cost Parity Session',
      cwd: wsDir,
      workspace: { current_dir: wsDir, project_dir: wsDir },
      model: { display_name: 'Gemini 4 Carbon' },
      cost: { total_usd: 0.818, subagent_usd: 0.21, estimated: true },
      terminal_width: 140,
    };

    const hudLines = runHudRender(cliHome, data, {
      nowSec: nowMs / 1000,
      agyPid: 4242,
      bypass: false,
      cliMode: '',
      branch: 'main',
      telemetry: { genCount: 1, tps: 90, ttft: 1.2, cachePct: 85, ctxUsed: 30_000, ctxMax: 200_000 },
      todos: null,
      env: { TERM: 'xterm-256color' },
    }).map(stripAnsi);

    assert.ok(hudLines.some((l) => l.includes('Cost ~$0.818 / ¥5.93')));

    const mdPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`);
    assert.equal(existsSync(mdPath), true);
    const md = readFileSync(mdPath, 'utf8');
    assert.ok(md.includes('- **Cost**: ~$0.818 / ¥5.93 (subagents: $0.210 / ¥1.52)'));

    const cliText = stripAnsi(
      runSnapshotCommand(['--session', convId, '--no-color'], {
        cliHome,
        cwd: wsDir,
        width: 140,
        nowMs,
        isAlive: (p) => p === 4242,
      }).output,
    );
    assert.ok(cliText.includes('Cost ~$0.818 / ¥5.93 (subagents $0.210 / ¥1.52)'));

    const cliJson = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        cwd: wsDir,
        nowMs,
        isAlive: (p) => p === 4242,
      }).output,
    ) as ActivitySnapshot & { costCurrency: string; usdToCnyRate: number; costDisplay: string | null };
    assert.deepEqual(cliJson.cost, { totalUsd: 0.818, subagentUsd: 0.21, estimated: true });
    assert.equal(cliJson.costCurrency, 'both');
    assert.equal(cliJson.usdToCnyRate, 7.25);
    assert.equal(cliJson.costDisplay, '~$0.818 / ¥5.93 (subagents $0.210 / ¥1.52)');

    // Updating costCurrency in hud-config.json updates Markdown and CLI snapshot output.
    configureHud({ cliHome, sets: ['costCurrency=cny'] });
    runHudRender(cliHome, data, {
      nowSec: (nowMs + 1000) / 1000,
      agyPid: 4242,
      bypass: false,
      cliMode: '',
      branch: 'main',
      telemetry: { genCount: 1, tps: 90, ttft: 1.2, cachePct: 85, ctxUsed: 30_000, ctxMax: 200_000 },
      todos: null,
      env: { TERM: 'xterm-256color' },
    });
    assert.ok(readFileSync(mdPath, 'utf8').includes('- **Cost**: ~¥5.93 (subagents: ¥1.52)'));
    const cnyJson = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        cwd: wsDir,
        nowMs: nowMs + 1000,
        isAlive: (p) => p === 4242,
      }).output,
    ) as ActivitySnapshot & { costCurrency: string; costDisplay: string | null };
    assert.equal(cnyJson.costCurrency, 'cny');
    assert.equal(cnyJson.costDisplay, '~¥5.93 (subagents ¥1.52)');
  });

  void it('omits Cost cleanly across CLI snapshot text and JSON when session has no stdin cost', () => {
    const root = tracker.makeTempDir('agy-hud-cli-nocost-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const convId = 'cli-nocost-1234';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', model: 'Gemini 4 Carbon', tool_calls: [] })}\n`,
      'utf8',
    );

    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const cliText = stripAnsi(
      runSnapshotCommand(['--session', convId, '--no-color'], {
        cliHome,
        nowMs,
      }).output,
    );
    assert.equal(cliText.includes('Cost '), false);

    const cliJson = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        nowMs,
      }).output,
    ) as ActivitySnapshot & { costDisplay: string | null };
    assert.equal(cliJson.cost, null);
    assert.equal(cliJson.costDisplay, null);
  });
});
