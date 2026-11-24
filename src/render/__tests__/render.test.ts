import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPresetConfig } from '../../core/hud-config.ts';
import { renderHudFromData } from '../../hud-entry.ts';
import type { AgentsSummary, HudConfig, SessionTelemetry, StatusLineData, TranscriptActivity } from '../../types.ts';
import { DEFAULT_HUD_CONFIG } from '../../types.ts';
import { buildPerfSegments, fitPerfCapsule, renderBar, stripAnsi, visibleLen } from '../ansi.ts';
import { buildLine2, buildModeLine, formatToolsLine, resolveEffectiveExceeds200k } from '../lines.ts';

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

void describe('render and hud-entry', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-render-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('computes visibleLen, progress bar thresholds, and width-aware perf capsule fitting', () => {
    assert.equal(visibleLen('\x1b[96mHello\x1b[0m'), 5);
    assert.equal(stripAnsi(renderBar(0)), '░░░░░░░░░░');
    assert.equal(stripAnsi(renderBar(0.5)), '█░░░░░░░░░');
    assert.ok(renderBar(85).includes('\x1b[91m'));

    const tel: SessionTelemetry = {
      genCount: 3,
      tps: 92.4,
      ttft: 1.85,
      cachePct: 91.2,
      ctxUsed: 50_000,
      ctxMax: 1_000_000,
    };
    const segs = buildPerfSegments(tel);
    assert.equal(segs.length, 3);
    assert.ok(stripAnsi(segs.join(' ')).includes('92.4 t/s'));

    const base = ' [Carbon]';
    const full = fitPerfCapsule(base, tel, 120);
    assert.ok(stripAnsi(full).includes('Cache 91%'));

    const narrow = fitPerfCapsule(base, tel, 26);
    assert.ok(stripAnsi(narrow).includes('92.4 t/s'));
    assert.equal(stripAnsi(narrow).includes('Cache'), false);

    const tiny = fitPerfCapsule(base, tel, 12);
    assert.equal(tiny, base);
  });

  void it('renders mode line without pictographic emojis and handles quota priorities', () => {
    const planLine = stripAnsi(
      buildModeLine(cliHome, { cycle_mode: 'plan', vim: { mode: 'normal' } }, undefined, {
        bypass: false,
        cliMode: '',
      }),
    );
    assert.ok(planLine.includes('‖ plan mode on [NORMAL]'));
    assert.equal(EMOJI_PATTERN.test(planLine), false);

    const bypassLine = stripAnsi(
      buildModeLine(cliHome, { dangerously_skip_permissions: true, cycle_mode: 'plan' }, undefined, {
        bypass: false,
        cliMode: '',
      }),
    );
    assert.ok(bypassLine.includes('bypass permissions on [plan]'));

    const line2 = stripAnsi(
      buildLine2(
        {
          model: { id: 'claude-opus-4-1' },
          context_window: { used_percentage: 42, context_window_size: 1_000_000 },
          quota: {
            '3p-5h': { remaining_fraction: 0.75, reset_in_seconds: 3600 },
            'gemini-5h': { remaining_fraction: 0.9, reset_in_seconds: 1800 },
          },
          terminal_width: 130,
        },
        DEFAULT_HUD_CONFIG,
        null,
      ),
    );
    assert.ok(line2.includes('Context ████░░░░░░ 42% (420k/1M)'));
    assert.ok(line2.includes('3P 5h: 75.00% (1h 0m)'));
    assert.ok(line2.includes('G 5h: 90.00% (30m)'));

    const narrowLine2 = stripAnsi(
      buildLine2(
        {
          model: { id: 'claude-opus-4-1' },
          context_window: { used_percentage: 42, context_window_size: 1_000_000 },
          quota: {
            '3p-5h': { remaining_fraction: 0.75, reset_in_seconds: 3600 },
            'gemini-5h': { remaining_fraction: 0.9, reset_in_seconds: 1800 },
          },
          terminal_width: 90,
        },
        DEFAULT_HUD_CONFIG,
        null,
      ),
    );
    assert.equal(narrowLine2.includes('G 5h:'), false);
    assert.equal(narrowLine2.includes('(420k/1M)'), false);

    const staleCompactData: StatusLineData = {
      context_window: { used_percentage: 52.5, context_window_size: 512_000 },
      exceeds_200k_tokens: true,
      terminal_width: 120,
    };
    const compactedTel: SessionTelemetry = {
      genCount: 10,
      tps: 90,
      ttft: 1.2,
      cachePct: 88,
      ctxUsed: 25_000,
      ctxMax: 512_000,
      compacted: true,
    };
    const compactedLine2 = stripAnsi(buildLine2(staleCompactData, DEFAULT_HUD_CONFIG, compactedTel));
    assert.ok(compactedLine2.includes('Context █░░░░░░░░░ 5% (~25k/512k)'));
    assert.equal(resolveEffectiveExceeds200k(staleCompactData, compactedTel), false);

    const normalTel: SessionTelemetry = { ...compactedTel, ctxUsed: 268_800, compacted: false };
    const normalLine2 = stripAnsi(buildLine2(staleCompactData, DEFAULT_HUD_CONFIG, normalTel));
    assert.ok(normalLine2.includes('Context █████░░░░░ 53% (269k/512k)'));
    assert.equal(resolveEffectiveExceeds200k(staleCompactData, normalTel), true);
  });

  void it('respects HudConfig presets (full, compact, minimal) and individual boolean toggles', () => {
    const baseData: StatusLineData = {
      cwd: path.join(tmpRoot, 'agy-hud'),
      session_id: 's1',
      model: { display_name: 'Orchestrator (Neon)' },
      vcs: { branch: 'master', dirty: true },
      duration_ms: 125_000,
      task_count: 2,
      cost: { total_usd: 0.425 },
      context_window: { used_percentage: 30, context_window_size: 1_000_000 },
      quota: { 'gemini-5h': { remaining_fraction: 0.88, reset_in_seconds: 900 } },
      terminal_width: 130,
    };

    const telemetry: SessionTelemetry = {
      genCount: 2,
      tps: 112,
      ttft: 1.5,
      cachePct: 95,
      ctxUsed: 300_000,
      ctxMax: 1_000_000,
    };
    const activity: TranscriptActivity = {
      tools: [
        { name: 'Read', disp: 'Read', target: 'a.ts', running: false, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'b.ts', running: false, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'c.ts', running: false, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'd.ts', running: false, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'e.ts', running: false, isSkillRead: false },
      ],
      skills: ['tdd'],
      mcps: ['github'],
      agents: [],
    };
    const agentsSummary: AgentsSummary = {
      kind: 'swarm',
      working: 2,
      waiting: 1,
      alive: 3,
      total: 3,
      entries: [
        { name: 'hud-core', type: 'worker', model: '', state: 'working', ts: null },
        { name: 'hud-cli', type: 'worker', model: '', state: 'working', ts: null },
        { name: 'verifier', type: 'worker', model: '', state: 'waiting', ts: null },
      ],
    };

    const opts = {
      cliHome,
      cliSettings: { orchestrator: { planner: 'Gemini 4 Carbon (High)' } },
      telemetry,
      activity,
      agentsSummary,
      todos: { total: 4, completed: 2, current: 'Build tests', taskCount: 2 },
      bypass: false,
      cliMode: 'accept-edits',
    };

    const fullOut = stripAnsi(renderHudFromData(baseData, { ...opts, hudConfig: buildPresetConfig('full') }));
    assert.equal(EMOJI_PATTERN.test(fullOut), false);
    assert.ok(fullOut.includes('accept edits on'));
    assert.ok(fullOut.includes('[Orchestrator (Carbon) ◑ high]'));
    assert.ok(fullOut.includes('Cost $0.425'));
    assert.ok(fullOut.includes('112 t/s'));
    assert.ok(fullOut.includes('Read ×5'));
    assert.ok(fullOut.includes('Skills (1): tdd'));
    assert.ok(fullOut.includes('MCPs (1): github'));
    assert.ok(fullOut.includes('Swarm (2/3):'));
    assert.ok(fullOut.includes('Build tests (2/4) │ BG 2'));
    // BG 2 is already shown on todos line, so Line 1 must not duplicate it.
    const fullLine1 = fullOut.split('\n')[1] ?? '';
    assert.equal(fullLine1.includes('BG 2'), false);

    const compactOut = stripAnsi(renderHudFromData(baseData, { ...opts, hudConfig: buildPresetConfig('compact') }));
    assert.ok(compactOut.includes('accept edits on'));
    assert.ok(compactOut.includes('Read ×5'));
    assert.ok(compactOut.includes('Skills: tdd'));
    assert.ok(compactOut.includes('MCPs: github'));
    assert.ok(compactOut.includes('Swarm: ◐ hud-core'));
    assert.equal(compactOut.includes('Tools 5'), false);
    assert.equal(compactOut.includes('Skills (1):'), false);
    assert.equal(compactOut.includes('MCPs (1):'), false);
    assert.equal(compactOut.includes('Swarm (2/3):'), false);
    assert.equal(compactOut.includes('Build tests'), false);
    // Todos line is hidden in compact mode, so BG 2 returns on Line 1.
    assert.ok(compactOut.includes('BG 2'));

    const swarmOut = stripAnsi(
      renderHudFromData(baseData, { ...opts, hudConfig: { preset: 'swarm', maxAgentChips: 2 } }),
    );
    assert.ok(swarmOut.includes('Swarm (2/3):'));
    assert.ok(swarmOut.includes('+1 more'));
    assert.ok(swarmOut.includes('Build tests'));

    const minimalOut = stripAnsi(renderHudFromData(baseData, { ...opts, hudConfig: { preset: 'minimal' } }));
    const minimalLines = minimalOut.split('\n');
    assert.equal(minimalLines.length, 2);
    assert.ok(minimalLines[0]?.includes('[Orchestrator (Carbon) ◑ high]'));
    assert.ok(minimalLines[1]?.includes('Context'));
    assert.equal(minimalOut.includes('accept edits on'), false);
    assert.equal(minimalOut.includes('Swarm (2/3):'), false);

    const customDisabled: Partial<HudConfig> = {
      preset: 'full',
      lines: ['mode', 'identity', 'usage'],
      segments: {
        ...DEFAULT_HUD_CONFIG.segments,
        perf: false,
        quota: false,
        cost: false,
      },
    };
    const strippedOut = stripAnsi(renderHudFromData(baseData, { ...opts, hudConfig: customDisabled }));
    assert.equal(strippedOut.includes('112 t/s'), false);
    assert.equal(strippedOut.includes('G 5h:'), false);
    assert.equal(strippedOut.includes('Cost'), false);
    assert.equal(strippedOut.includes('Swarm (2/3):'), false);
    assert.equal(strippedOut.includes('Read ×5'), false);

    assert.equal(
      stripAnsi(
        formatToolsLine([{ name: 'Read', disp: 'Read', target: 'SKILL.md', running: false, isSkillRead: true }], true),
      ),
      '',
    );
  });

  void it('degrades gracefully on empty or malformed stdin when executed as CLI entrypoint', () => {
    const entryFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hud-entry.ts');
    const env = { ...process.env, GEMINI_CLI_HOME: tmpRoot };

    for (const badInput of ['', '   \n', '{malformed-json', '["not-an-object"]']) {
      const res = spawnSync(process.execPath, [entryFile], {
        input: badInput,
        encoding: 'utf8',
        env,
      });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, '');
    }

    writeFileSync(
      path.join(cliHome, 'settings.json'),
      JSON.stringify({ orchestrator: { planner: 'Gemini 4 Carbon (High)' } }),
      'utf8',
    );
    const validRes = spawnSync(process.execPath, [entryFile], {
      input: JSON.stringify({
        cwd: tmpRoot,
        model: { display_name: 'Orchestrator (Neon)' },
        context_window: { used_percentage: 20, context_window_size: 1_000_000 },
      }),
      encoding: 'utf8',
      env,
    });
    assert.equal(validRes.status, 0);
    const clean = stripAnsi(validRes.stdout);
    assert.ok(clean.includes('[Orchestrator (Carbon) ◑ high]'));
    assert.ok(clean.includes('Context ██░░░░░░░░ 20%'));
  });
});
