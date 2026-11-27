import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runSnapshotCommand } from '../src/cli/snapshot.ts';
import { loadTranscriptActivity } from '../src/collectors/activity.ts';
import { writeSnapshotEnvelope } from '../src/collectors/snapshot-envelope.ts';
import { runHudRender } from '../src/hud-runner.ts';
import { stripAnsi } from '../src/render/ansi.ts';
import type { ActivitySnapshot } from '../src/snapshot-types.ts';
import type { StatusLineData } from '../src/types.ts';
import { createTempDirTracker } from './helpers.ts';

const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

void describe('three-surface CLI parity for > 512 KiB transcript with running suffix in-place rewrite', () => {
  void it('reflects out-of-window same-length rewrite across HUD, Markdown, and CLI snapshot', () => {
    const root = tracker.makeTempDir('agy-hud-parity-large-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const wsDir = path.join(root, 'workspace');
    const convId = 'parity-large-run-7777';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    const mdPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`);
    const makePadLine = (idx: number): string =>
      JSON.stringify({ type: 'USER_INPUT', content: `pad-${String(idx).padStart(4, '0')}-${'x'.repeat(980)}` });
    const prefixLines = Array.from({ length: 100 }, (_, i) => makePadLine(i));
    const targetBefore = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'alpha_large.ts') } }],
    });
    const targetAfter = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      tool_calls: [{ name: 'edit_file', args: { Path: path.join(wsDir, 'bravo_large.ts') } }],
    });
    assert.equal(Buffer.byteLength(targetBefore, 'utf8'), Buffer.byteLength(targetAfter, 'utf8'));
    const suffixPadLines = Array.from({ length: 500 }, (_, i) => makePadLine(i + 100));
    const runningTail = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'RUNNING',
      model: 'Gemini 4 Carbon',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test' } }],
    });

    const contentBefore = `${[...prefixLines, targetBefore, ...suffixPadLines, runningTail].join('\n')}\n`;
    const contentAfter = `${[...prefixLines, targetAfter, ...suffixPadLines, runningTail].join('\n')}\n`;
    assert.ok(Buffer.byteLength(contentBefore, 'utf8') > 550 * 1024);
    assert.equal(Buffer.byteLength(contentBefore, 'utf8'), Buffer.byteLength(contentAfter, 'utf8'));

    const fixedTime = new Date('2026-06-01T11:59:00Z');
    writeFileSync(transcriptPath, contentBefore, 'utf8');
    utimesSync(transcriptPath, fixedTime, fixedTime);
    const stBefore = statSync(transcriptPath);

    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const data: StatusLineData = {
      conversation_id: convId,
      conversation_title: 'Large Running Parity',
      cwd: wsDir,
      workspace: { current_dir: wsDir, project_dir: wsDir },
      model: { display_name: 'Gemini 4 Carbon' },
      terminal_width: 140,
    };
    writeSnapshotEnvelope(cliHome, data, 4242, { nowMs });

    const renderHud = (tsMs: number): { hudLines: string[]; markdown: string } => {
      const baseOpts = {
        agyPid: 4242,
        nowSec: tsMs / 1000,
        env: { TERM: 'xterm-256color' },
        cliSettings: {},
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      };
      const rawHudLines = runHudRender(cliHome, data, {
        ...baseOpts,
        hudConfig: { preset: 'full', lines: ['identity', 'tools'], osc8Links: true },
      });
      runHudRender(cliHome, data, {
        ...baseOpts,
        hudConfig: { preset: 'compact', lines: ['identity', 'activity'], osc8Links: true },
      });
      assert.equal(existsSync(mdPath), true);
      return { hudLines: rawHudLines.map(stripAnsi), markdown: readFileSync(mdPath, 'utf8') };
    };

    const before = renderHud(nowMs);
    assert.ok(before.hudLines.some((l) => l.includes('read_file')));
    assert.ok(before.markdown.includes('`read_file`'));
    assert.ok(before.markdown.includes('alpha_large.ts'));

    writeFileSync(transcriptPath, contentAfter, 'utf8');
    utimesSync(transcriptPath, fixedTime, fixedTime);
    assert.equal(statSync(transcriptPath).ino, stBefore.ino);
    assert.equal(statSync(transcriptPath).size, stBefore.size);

    const after = renderHud(nowMs + 1000);
    const hudAfter = loadTranscriptActivity(cliHome, data);
    const cliAfter = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        cwd: wsDir,
        nowMs: nowMs + 1000,
        isAlive: (p) => p === 4242,
      }).output,
    ) as ActivitySnapshot;

    assert.equal(hudAfter?.completedTools?.[0]?.disp, 'edit_file');
    assert.equal(cliAfter.completedTools[0]?.disp, 'edit_file');
    assert.ok(after.hudLines.some((l) => l.includes('edit_file')));
    assert.equal(
      after.hudLines.some((l) => l.includes('read_file')),
      false,
    );
    assert.ok(after.markdown.includes('`edit_file`') && after.markdown.includes('bravo_large.ts'));
    assert.equal(after.markdown.includes('`read_file`'), false);
    assert.equal(after.markdown.includes('alpha_large.ts'), false);
  });

  void it('reflects out-of-window same-length rewrite combined with an appended line across all three CLI surfaces', () => {
    const root = tracker.makeTempDir('agy-hud-parity-large-append-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const wsDir = path.join(root, 'workspace');
    const convId = 'parity-large-append-8888';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    const mdPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`);
    const makePadLine = (idx: number): string =>
      JSON.stringify({ type: 'USER_INPUT', content: `pad-${String(idx).padStart(4, '0')}-${'x'.repeat(980)}` });
    const prefixLines = Array.from({ length: 100 }, (_, i) => makePadLine(i));
    const targetBefore = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      tool_calls: [{ name: 'read_file', args: { Path: path.join(wsDir, 'alpha_append.ts') } }],
    });
    const targetAfter = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      tool_calls: [{ name: 'edit_file', args: { Path: path.join(wsDir, 'bravo_append.ts') } }],
    });
    assert.equal(Buffer.byteLength(targetBefore, 'utf8'), Buffer.byteLength(targetAfter, 'utf8'));
    const suffixPadLines = Array.from({ length: 500 }, (_, i) => makePadLine(i + 100));
    const appendedLine = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Gemini 4 Carbon',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm typecheck' } }],
    });

    const contentBefore = `${[...prefixLines, targetBefore, ...suffixPadLines].join('\n')}\n`;
    const contentAfter = `${[...prefixLines, targetAfter, ...suffixPadLines, appendedLine].join('\n')}\n`;
    assert.ok(Buffer.byteLength(contentBefore, 'utf8') > 550 * 1024);
    assert.ok(Buffer.byteLength(contentAfter, 'utf8') > Buffer.byteLength(contentBefore, 'utf8'));

    writeFileSync(transcriptPath, contentBefore, 'utf8');
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const data: StatusLineData = {
      conversation_id: convId,
      conversation_title: 'Large Rewrite Plus Append',
      cwd: wsDir,
      workspace: { current_dir: wsDir, project_dir: wsDir },
      model: { display_name: 'Gemini 4 Carbon' },
      terminal_width: 140,
    };
    writeSnapshotEnvelope(cliHome, data, 4243, { nowMs });

    const renderHud = (tsMs: number): { hudLines: string[]; markdown: string } => {
      const baseOpts = {
        agyPid: 4243,
        nowSec: tsMs / 1000,
        env: { TERM: 'xterm-256color' },
        cliSettings: {},
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      };
      const rawHudLines = runHudRender(cliHome, data, {
        ...baseOpts,
        hudConfig: { preset: 'full', lines: ['identity', 'tools'], osc8Links: true },
      });
      runHudRender(cliHome, data, {
        ...baseOpts,
        hudConfig: { preset: 'compact', lines: ['identity', 'activity'], osc8Links: true },
      });
      assert.equal(existsSync(mdPath), true);
      return { hudLines: rawHudLines.map(stripAnsi), markdown: readFileSync(mdPath, 'utf8') };
    };

    const before = renderHud(nowMs);
    assert.ok(before.hudLines.some((l) => l.includes('read_file')));

    // Same-round out-of-window same-length rewrite + appended line.
    writeFileSync(transcriptPath, contentAfter, 'utf8');

    const after = renderHud(nowMs + 1000);
    // Warm follow-up read must also stay consistent (stale prefix must never be persisted).
    const hudHot = loadTranscriptActivity(cliHome, data);
    const cliAfter = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        cwd: wsDir,
        nowMs: nowMs + 1000,
        isAlive: (p) => p === 4243,
      }).output,
    ) as ActivitySnapshot;

    const hudDisps = (hudHot?.completedTools ?? []).map((t) => t.disp).sort();
    const cliDisps = cliAfter.completedTools.map((t) => t.disp).sort();
    assert.deepEqual(hudDisps, ['edit_file', 'run_command']);
    assert.deepEqual(cliDisps, ['edit_file', 'run_command']);
    assert.ok(after.markdown.includes('`edit_file`') && after.markdown.includes('bravo_append.ts'));
    assert.equal(after.markdown.includes('`read_file`'), false);
    assert.equal(after.markdown.includes('alpha_append.ts'), false);
  });
});
