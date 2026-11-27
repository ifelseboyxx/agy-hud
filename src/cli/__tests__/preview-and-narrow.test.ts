import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCliEntry } from '../../cli-entry.ts';
import { buildPresetConfig, resolveEffectiveHudConfig } from '../../core/hud-config.ts';
import { runHudRender } from '../../hud-runner.ts';
import { stripAnsi } from '../../render/ansi.ts';
import type { StatusLineData } from '../../types.ts';
import { configureHud, parseConfigureArgs } from '../configure.ts';
import { parsePreviewArgs, runPreviewCommand } from '../preview.ts';
import { sanitizeHudConfigTemplate } from '../sanitize.ts';

const tempDirs: string[] = [];

function makeTempCliHome(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const cliHome = path.join(root, '.gemini', 'antigravity-cli');
  mkdirSync(cliHome, { recursive: true });
  return cliHome;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

void describe('narrow split-pane overrides and cost config', () => {
  void it('resolves narrow overrides below 100 cols while inheriting omitted keys', () => {
    const base = buildPresetConfig('full', {
      narrow: {
        lines: ['identity', 'usage'],
        segments: { cost: false, perf: false },
      },
    });
    const wide = resolveEffectiveHudConfig(base, 100);
    assert.equal(wide.lines.length, 8);
    assert.equal(wide.segments.cost, true);
    assert.equal(wide.segments.perf, true);

    const narrow = resolveEffectiveHudConfig(base, 99);
    assert.deepEqual(narrow.lines, ['identity', 'usage']);
    assert.equal(narrow.segments.cost, false);
    assert.equal(narrow.segments.perf, false);
    assert.equal(narrow.segments.model, true);
    assert.equal(narrow.segments.quota, true);
  });

  void it('skips collectors for narrow-hidden lines and segments in runHudRender', () => {
    const cliHome = makeTempCliHome('agy-hud-narrow-lazy-');
    let todosCalls = 0;
    let activityCalls = 0;
    const cfg = buildPresetConfig('full', {
      narrow: {
        lines: ['identity', 'usage'],
        segments: { badges: false },
      },
    });
    const data: StatusLineData = {
      cwd: cliHome,
      model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
      context_window: { used_percentage: 30, context_window_size: 200_000 },
      terminal_width: 80,
    };

    const narrowLines = runHudRender(cliHome, data, {
      cliSettings: {},
      hudConfig: cfg,
      telemetry: { genCount: 1, tps: 90, ttft: 1.1, cachePct: 80, ctxUsed: 60_000, ctxMax: 200_000 },
      collectors: {
        detectGitStatus: () => ({ branch: 'main', dirty: false }),
        loadTodos: () => {
          todosCalls += 1;
          return { total: 2, completed: 1, current: 'Hidden task' };
        },
        loadTranscriptActivity: () => {
          activityCalls += 1;
          return { tools: [], skills: [], mcps: [], agents: [] };
        },
      },
    });
    assert.equal(narrowLines.length, 2);
    assert.equal(todosCalls, 0);
    assert.equal(activityCalls, 0);
  });

  void it('persists narrow overrides and costCurrency/usdToCnyRate through configure and sanitize', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-narrow-');
    const parsed = parseConfigureArgs([
      '--narrow-disable',
      'cost,perf,todos',
      '--set',
      'costCurrency=both',
      '--set',
      'usdToCnyRate=7.3',
    ]);
    const updated = configureHud({ ...parsed.options, cliHome });
    assert.equal(updated.config.costCurrency, 'both');
    assert.equal(updated.config.usdToCnyRate, 7.3);
    assert.equal(updated.config.narrow?.segments?.cost, false);
    assert.equal(updated.config.narrow?.segments?.perf, false);
    assert.equal(updated.config.narrow?.lines?.includes('todos'), false);

    const sanitized = sanitizeHudConfigTemplate(updated.config as unknown as Record<string, unknown>);
    assert.equal(sanitized.costCurrency, 'both');
    assert.equal(sanitized.usdToCnyRate, 7.3);
    assert.deepEqual(sanitized.narrow, updated.config.narrow);

    const inherited = configureHud({
      cliHome,
      sets: ['narrow.segments.cost=inherit', 'narrow.lines=inherit'],
    });
    assert.equal(inherited.config.narrow?.segments?.cost, undefined);
    assert.equal(inherited.config.narrow?.segments?.perf, false);
    assert.equal(inherited.config.narrow?.lines, undefined);

    const cleared = configureHud({ cliHome, narrowReset: true });
    assert.equal(cleared.config.narrow, undefined);
  });

  void it('rejects invalid costCurrency, usdToCnyRate, and narrow values in configure and sanitize', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-invalid-');
    assert.throws(() => configureHud({ cliHome, sets: ['costCurrency=eur'] }), /Invalid costCurrency/);
    assert.throws(() => configureHud({ cliHome, sets: ['usdToCnyRate=0'] }), /Out-of-range value/);
    assert.throws(() => configureHud({ cliHome, sets: ['usdToCnyRate=abc'] }), /Invalid number/);
    assert.throws(() => sanitizeHudConfigTemplate({ costCurrency: 'eur' }), /Invalid 'costCurrency'/);
    assert.throws(() => sanitizeHudConfigTemplate({ usdToCnyRate: -5 }), /Invalid 'usdToCnyRate'/);
    assert.throws(() => sanitizeHudConfigTemplate({ narrow: 'bad' }), /Invalid 'narrow'/);
    assert.throws(() => sanitizeHudConfigTemplate({ narrow: { lines: ['identty'] } }), /Invalid line ID/);
    assert.throws(() => sanitizeHudConfigTemplate({ narrow: { segments: { bogus: false } } }), /Invalid segment ID/);
  });

  void it('skips telemetry, activity, and agent collectors when narrow.lines hides their host rows', () => {
    const cliHome = makeTempCliHome('agy-hud-narrow-skip-');
    const data: StatusLineData = {
      cwd: '/tmp/ws',
      model: { display_name: 'Gemini 4 Carbon' },
      workspace: { current_dir: '/tmp/ws' },
    };
    const hudConfig = {
      preset: 'full' as const,
      narrow: { lines: ['mode' as const] },
    };
    let telemetryCalls = 0;
    let activityCalls = 0;
    let agentsCalls = 0;
    const spies = {
      detectGitStatus: () => ({ branch: 'main', dirty: false }),
      loadSessionTelemetry: () => {
        telemetryCalls += 1;
        return {
          tps: null,
          ttft: null,
          cachePct: null,
          totalInput: 0,
          totalOutput: 0,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          ctxUsed: null,
          ctxMax: null,
          genCount: 0,
          isPostCompact: false,
        };
      },
      loadTranscriptActivity: () => {
        activityCalls += 1;
        return null;
      },
      collectAgentsSummary: () => {
        agentsCalls += 1;
        return { kind: 'agents' as const, working: 0, waiting: 0, alive: 0, total: 0, entries: [] };
      },
    };

    runHudRender(cliHome, { ...data, terminal_width: 99 }, { hudConfig, collectors: spies, cliSettings: {} });
    assert.equal(telemetryCalls, 0);
    assert.equal(activityCalls, 0);
    assert.equal(agentsCalls, 0);

    runHudRender(cliHome, { ...data, terminal_width: 100 }, { hudConfig, collectors: spies, cliSettings: {} });
    assert.equal(telemetryCalls, 1);
    assert.equal(activityCalls, 1);
    assert.equal(agentsCalls, 1);

    // Narrow layout hiding identity/usage but emitting an OSC 8 overflow link on tools lazily backfills snapshot telemetry/agents.
    let overflowTelemetryCalls = 0;
    let overflowAgentsCalls = 0;
    const convId = 'narrow-osc8-backfill';
    const toolsData: StatusLineData = {
      ...data,
      conversation_id: convId,
      terminal_width: 72,
    };
    const renderedOverflow = runHudRender(cliHome, toolsData, {
      hudConfig: { preset: 'full', osc8Links: true, narrow: { lines: ['tools'] } },
      env: { TERM_PROGRAM: 'iTerm.app' },
      activity: {
        tools: Array.from({ length: 8 }, (_, idx) => ({
          name: 'read_file',
          disp: `ReadFileLongName${idx}`,
          target: `file_${idx}.ts`,
          fullTarget: `/tmp/ws/file_${idx}.ts`,
          running: false,
          isSkillRead: false,
        })),
        skills: [],
        mcps: [],
        agents: [],
      },
      collectors: {
        loadSessionTelemetry: () => {
          overflowTelemetryCalls += 1;
          return {
            tps: 50,
            ttft: 1.2,
            cachePct: 90,
            totalInput: 100,
            totalOutput: 50,
            totalCacheRead: 900,
            totalCacheWrite: 0,
            ctxUsed: 1000,
            ctxMax: 100_000,
            genCount: 1,
            isPostCompact: false,
          };
        },
        collectAgentsSummary: () => {
          overflowAgentsCalls += 1;
          return { kind: 'agents' as const, working: 0, waiting: 0, alive: 0, total: 0, entries: [] };
        },
      },
    });
    assert.ok(
      renderedOverflow.some((line) => line.includes('\x1b]8;;file://')),
      'narrow tools row must emit OSC 8 link',
    );
    assert.equal(overflowTelemetryCalls, 1);
    assert.equal(overflowAgentsCalls, 1);
  });
});

void describe('agy-hud preview command', () => {
  void it('renders deterministic offline preview respecting width, --narrow, --preset, and --no-color', () => {
    const cliHome = makeTempCliHome('agy-hud-preview-');
    configureHud({
      cliHome,
      preset: 'compact',
      sets: ['costCurrency=both', 'usdToCnyRate=7.25', 'narrow.segments.cost=false'],
    });

    const wide = runPreviewCommand(['120', '--no-color'], { cliHome });
    assert.equal(wide.includes('\x1b'), false);
    assert.ok(wide.includes('Gemini 5h: 82% left (2h15m) | 7d: 91% left (4d6h)'));
    assert.ok(wide.includes('Cost ~$0.420 / ¥3.05'));
    assert.ok(wide.includes('git:(main +!? ↑1) +48 -12'));

    const narrow = runPreviewCommand(['--narrow', '--no-color'], { cliHome });
    assert.equal(narrow.includes('Cost'), false);
    assert.ok(narrow.includes('git:(main*)'));
    assert.ok(narrow.includes('Gem 5h: 82% (2h15m)'));

    const allPresets = runPreviewCommand(['--all-presets', '--no-color'], { cliHome });
    for (const preset of ['zen', 'minimal', 'compact', 'swarm', 'full']) {
      assert.ok(allPresets.includes(`── ${preset} (120 cols) ──`));
    }
  });

  void it('routes preview via runCliEntry without creating hud-config.json and rejects flag conflicts', () => {
    const cliHome = makeTempCliHome('agy-hud-preview-cli-');
    let out = '';
    const code = runCliEntry(['preview', '--preset', 'zen', '--no-color'], {
      cliHome,
      stdout: {
        write(chunk: string): boolean {
          out += chunk;
          return true;
        },
      },
    });
    assert.equal(code, 0);
    assert.equal(stripAnsi(out).trim().split('\n').length, 1);
    assert.equal(existsSync(path.join(cliHome, 'hud-config.json')), false);

    assert.throws(() => parsePreviewArgs(['--narrow', '120']), /Conflicting width options/);
    assert.throws(() => parsePreviewArgs(['--all-presets', '--preset', 'zen']), /Conflicting preset options/);
    assert.throws(() => parsePreviewArgs(['20']), /Out-of-range preview width/);

    // Invalid hud-config.json on disk must fail strictly in preview rather than silently falling back.
    writeFileSync(path.join(cliHome, 'hud-config.json'), JSON.stringify({ costCurrency: 'eur' }), 'utf8');
    assert.throws(() => runPreviewCommand(['120', '--no-color'], { cliHome }), /Invalid.*costCurrency/i);
  });
});
