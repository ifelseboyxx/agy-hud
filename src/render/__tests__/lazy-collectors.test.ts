import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildPresetConfig } from '../../core/hud-config.ts';
import { runHudRender as renderHudLines } from '../../hud-runner.ts';
import type { HudConfig, SessionTelemetry, StatusLineData } from '../../types.ts';
import { stripAnsi } from '../ansi.ts';

function makeBaseData(tmpRoot: string, overrides?: Partial<StatusLineData>): StatusLineData {
  return {
    cwd: path.join(tmpRoot, 'agy-hud'),
    session_id: 'sess-lazy-1',
    model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
    vcs: { branch: 'feat/lazy', dirty: false },
    context_window: { used_percentage: 25, context_window_size: 1_000_000 },
    terminal_width: 120,
    ...overrides,
  };
}

const SAMPLE_TELEMETRY: SessionTelemetry = {
  genCount: 1,
  tps: 100,
  ttft: 1.2,
  cachePct: 90,
  ctxUsed: 250_000,
  ctxMax: 1_000_000,
};

void describe('lazy collector skipping in renderHudLines', async () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-lazy-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await it('skips detectGitStatus when segments.git is false', () => {
    let gitCalls = 0;
    const cfg: HudConfig = {
      ...buildPresetConfig('zen'),
      segments: { ...buildPresetConfig('zen').segments, git: false },
    };
    const lines = renderHudLines(cliHome, makeBaseData(tmpRoot), {
      cliSettings: {},
      hudConfig: cfg,
      telemetry: SAMPLE_TELEMETRY,
      activity: null,
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      todos: null,
      collectors: {
        detectGitStatus: () => {
          gitCalls += 1;
          return { branch: 'should-not-run', dirty: false };
        },
      },
    });
    assert.equal(gitCalls, 0);
    assert.equal(stripAnsi(lines[0] ?? '').includes('git:('), false);
  });

  await it('skips loadTodos when todos line and badges are disabled', () => {
    let todoCalls = 0;
    const cfg: HudConfig = {
      ...buildPresetConfig('zen'),
      segments: { ...buildPresetConfig('zen').segments, badges: false },
    };
    renderHudLines(cliHome, makeBaseData(tmpRoot), {
      cliSettings: {},
      hudConfig: cfg,
      telemetry: SAMPLE_TELEMETRY,
      activity: null,
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      collectors: {
        loadTodos: () => {
          todoCalls += 1;
          return { total: 2, completed: 1, current: 'Task' };
        },
      },
    });
    assert.equal(todoCalls, 0);
  });

  await it('skips loadSessionTelemetry when perf, context, and exceeds_200k_tokens are off without writing cache', () => {
    const convId = 'conv-lazy-tel';
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(path.join(convDir, `${convId}.db`));
    db.exec('CREATE TABLE IF NOT EXISTS gen_metadata (step_idx INTEGER, data BLOB)');
    db.close();

    let telCalls = 0;
    const cfg: HudConfig = {
      ...buildPresetConfig('zen'),
      segments: { ...buildPresetConfig('zen').segments, perf: false, context: false },
    };
    renderHudLines(cliHome, makeBaseData(tmpRoot, { conversation_id: convId, exceeds_200k_tokens: false }), {
      cliSettings: {},
      hudConfig: cfg,
      activity: null,
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      todos: null,
      collectors: {
        loadSessionTelemetry: () => {
          telCalls += 1;
          return SAMPLE_TELEMETRY;
        },
      },
    });
    assert.equal(telCalls, 0);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`)), false);
  });

  await it('runs loadSessionTelemetry when exceeds_200k_tokens is true even with perf and context off', () => {
    let telCalls = 0;
    const cfg: HudConfig = {
      ...buildPresetConfig('zen'),
      segments: { ...buildPresetConfig('zen').segments, perf: false, context: false },
    };
    renderHudLines(cliHome, makeBaseData(tmpRoot, { exceeds_200k_tokens: true }), {
      cliSettings: {},
      hudConfig: cfg,
      activity: null,
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      todos: null,
      collectors: {
        loadSessionTelemetry: () => {
          telCalls += 1;
          return SAMPLE_TELEMETRY;
        },
      },
    });
    assert.equal(telCalls, 1);
  });

  await it('skips loadTranscriptActivity when badges and all activity lines are off without writing cache', () => {
    const convId = 'conv-lazy-act';
    const brainDir = path.join(cliHome, 'brain', convId);
    mkdirSync(brainDir, { recursive: true });
    const transcriptPath = path.join(brainDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, '{"role":"assistant"}\n', 'utf8');

    let actCalls = 0;
    const cfg: HudConfig = {
      ...buildPresetConfig('minimal'),
      segments: { ...buildPresetConfig('minimal').segments, badges: false },
    };
    renderHudLines(cliHome, makeBaseData(tmpRoot, { conversation_id: convId, transcript_path: transcriptPath }), {
      cliSettings: {},
      hudConfig: cfg,
      telemetry: SAMPLE_TELEMETRY,
      todos: null,
      collectors: {
        loadTranscriptActivity: () => {
          actCalls += 1;
          return { tools: [], skills: [], mcps: [], agents: [] };
        },
      },
    });
    assert.equal(actCalls, 0);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`)), false);
  });

  await it('still writes the lightweight snapshot metadata envelope when activity and telemetry collectors are skipped', () => {
    const convId = 'conv-lazy-envelope';
    const cfg: HudConfig = {
      ...buildPresetConfig('zen'),
      segments: {
        model: true,
        git: false,
        duration: false,
        badges: false,
        cost: false,
        perf: false,
        context: false,
        quota: false,
      },
    };
    renderHudLines(cliHome, makeBaseData(tmpRoot, { conversation_id: convId, exceeds_200k_tokens: false }), {
      cliSettings: {},
      hudConfig: cfg,
      agyPid: process.pid,
      nowSec: 2000,
    });
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`)), true);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`)), false);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`)), false);
  });
});
