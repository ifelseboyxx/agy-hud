import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildPresetConfig } from '../../core/hud-config.ts';
import { runHudRender as renderHudLines } from '../../hud-runner.ts';
import type {
  AgentsSummary,
  HudConfig,
  SessionTelemetry,
  StatusLineData,
  TodoSummary,
  TranscriptActivity,
} from '../../types.ts';
import { GRAY, RESET, stripAnsi, visibleLen } from '../ansi.ts';
import { formatActivitySummaryLine, LINE_MODULE_REGISTRY } from '../modules.ts';

function makeRichData(tmpRoot: string, overrides?: Partial<StatusLineData>): StatusLineData {
  return {
    cwd: path.join(tmpRoot, 'agy-hud'),
    session_id: 'sess-mod-1',
    model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', effort: 'high' },
    vcs: { branch: 'feat/bar', dirty: true },
    duration_ms: 125_000,
    task_count: 2,
    cost: { total_usd: 0.425 },
    context_window: { used_percentage: 42, context_window_size: 1_000_000 },
    quota: {
      'gemini-5h': { remaining_fraction: 0.88, reset_in_seconds: 900 },
      'gemini-weekly': { remaining_fraction: 0.92, reset_in_seconds: 86_400 },
    },
    terminal_width: 140,
    ...overrides,
  };
}

function makeRichTelemetry(): SessionTelemetry {
  return {
    genCount: 3,
    tps: 112,
    ttft: 1.5,
    cachePct: 95,
    ctxUsed: 420_000,
    ctxMax: 1_000_000,
  };
}

function makeRichActivity(): TranscriptActivity {
  return {
    tools: [
      { name: 'read_file', disp: 'Read', target: 'a.ts', running: false, isSkillRead: false },
      { name: 'read_file', disp: 'Read', target: 'b.ts', running: false, isSkillRead: false },
      { name: 'edit_file', disp: 'Edit', target: 'modules.ts', running: true, isSkillRead: false },
    ],
    skills: ['tdd', 'codebase-design'],
    mcps: ['agy-fast'],
    agents: [],
  };
}

function makeRichAgents(): AgentsSummary {
  return {
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
}

const RICH_TODOS: TodoSummary = { total: 4, completed: 2, current: 'Build module registry', taskCount: 2 };

void describe('declarative Line Module registry, presets, zen folding, Activity Summary, and lazy skipping', async () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-mod-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function baseRenderOpts(hudConfig: HudConfig) {
    return {
      cliSettings: {},
      hudConfig,
      telemetry: makeRichTelemetry(),
      activity: makeRichActivity(),
      agentsSummary: makeRichAgents(),
      todos: RICH_TODOS,
      bypass: false,
      cliMode: 'accept-edits',
      nowSec: 1000,
    };
  }

  await it('registers all nine built-in Line Modules in LINE_MODULE_REGISTRY', () => {
    const keys = Object.keys(LINE_MODULE_REGISTRY).sort();
    assert.deepEqual(keys, ['activity', 'agents', 'identity', 'mcps', 'mode', 'skills', 'todos', 'tools', 'usage']);
  });

  await it('renders zen preset as a strict single row with folded Ctx and 5h quota tail', () => {
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot), baseRenderOpts(buildPresetConfig('zen')));
    assert.equal(lines.length, 1);
    const plain = stripAnsi(lines[0] ?? '');
    assert.ok(plain.includes('[G4 Carbon ● high]'));
    assert.ok(plain.includes('git:(feat/bar*)'));
    assert.ok(plain.includes('Swarm 2/3'));
    assert.ok(plain.includes('Ctx 42%'));
    assert.ok(plain.includes('5h 88%'));
    assert.equal(plain.includes('Cost'), false);
    assert.equal(plain.includes('112 token/s'), false);
    assert.equal(plain.includes('2m 5s'), false);
    assert.ok(visibleLen(lines[0] ?? '') <= 139);
  });

  await it('omits zen 5h tail then Ctx tail when terminal_width is too narrow', () => {
    const zen = buildPresetConfig('zen');
    const medium = renderHudLines(cliHome, makeRichData(tmpRoot, { terminal_width: 82 }), baseRenderOpts(zen));
    const mediumPlain = stripAnsi(medium[0] ?? '');
    assert.ok(mediumPlain.includes('Ctx 42%'));
    assert.equal(mediumPlain.includes('5h 88%'), false);
    assert.ok(visibleLen(medium[0] ?? '') <= 81);

    const tight = renderHudLines(cliHome, makeRichData(tmpRoot, { terminal_width: 72 }), baseRenderOpts(zen));
    const tightPlain = stripAnsi(tight[0] ?? '');
    assert.equal(tightPlain.includes('Ctx 42%'), false);
    assert.equal(tightPlain.includes('5h 88%'), false);
  });

  await it('uses compacted telemetry percentage in zen Ctx tail fold', () => {
    const zen = buildPresetConfig('zen');
    const compacted: SessionTelemetry = { ...makeRichTelemetry(), ctxUsed: 50_000, ctxMax: 1_000_000, compacted: true };
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot, { context_window: { used_percentage: 78 } }), {
      ...baseRenderOpts(zen),
      telemetry: compacted,
    });
    const plain = stripAnsi(lines[0] ?? '');
    assert.ok(plain.includes('Ctx 5%'));
  });

  await it('renders minimal preset as two rows without mode, duration, cost, or perf', () => {
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot), baseRenderOpts(buildPresetConfig('minimal')));
    assert.equal(lines.length, 2);
    const l0 = stripAnsi(lines[0] ?? '');
    const l1 = stripAnsi(lines[1] ?? '');
    assert.ok(l0.includes('[G4 Carbon ● high]'));
    assert.equal(l0.includes('Cost'), false);
    assert.equal(l0.includes('112 token/s'), false);
    assert.equal(l0.includes('Ctx 42%'), false);
    assert.ok(l1.includes('Context'));
    assert.ok(l1.includes('Gemini 5h: 88% left (15m)'));
  });

  await it('renders compact preset with concrete high-frequency Activity Summary and without dedicated Activity Lines', () => {
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot), baseRenderOpts(buildPresetConfig('compact')));
    assert.equal(lines.length, 4);
    const joined = stripAnsi(lines.join('\n'));
    assert.ok(joined.includes('accept edits on'));
    assert.ok(joined.includes('Cost $0.425'));
    assert.ok(joined.includes('112 token/s'));
    assert.ok(joined.includes('Context'));
    const summaryLine = stripAnsi(lines[3] ?? '');
    assert.ok(summaryLine.includes('Edit: modules.ts'));
    assert.ok(summaryLine.includes('Read ×2'));
    assert.ok(summaryLine.includes('Skills: tdd, codebase-design'));
    assert.ok(summaryLine.includes('MCPs: agy-fast'));
    assert.ok(summaryLine.includes('Swarm: ◐ hud-core'));
    assert.equal(summaryLine.includes('Tools 3'), false);
    assert.equal(summaryLine.includes('Skills 2'), false);
    assert.equal(summaryLine.includes('MCPs 1'), false);
    assert.equal(summaryLine.includes('Swarm 2/3'), false);
    assert.equal(joined.includes('Skills (2):'), false);
    assert.equal(joined.includes('Build module registry'), false);
  });

  await it('renders swarm preset with agents and todos rows without tools, skills, or mcps', () => {
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot), baseRenderOpts(buildPresetConfig('swarm')));
    assert.equal(lines.length, 5);
    const joined = stripAnsi(lines.join('\n'));
    assert.ok(joined.includes('Swarm (2/3):'));
    assert.ok(joined.includes('Build module registry (2/4) │ Bg Tasks 2'));
    assert.equal(joined.includes('Skills (2):'), false);
    assert.equal(joined.includes('MCPs (1):'), false);
    assert.equal(joined.includes('Read ×2'), false);
  });

  await it('renders full preset with all dedicated Activity Lines and without Activity Summary', () => {
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot), baseRenderOpts(buildPresetConfig('full')));
    assert.equal(lines.length, 8);
    const joined = stripAnsi(lines.join('\n'));
    assert.ok(joined.includes('Read ×2'));
    assert.ok(joined.includes('Skills (2): tdd, codebase-design'));
    assert.ok(joined.includes('MCPs (1): agy-fast'));
    assert.ok(joined.includes('Swarm (2/3):'));
    assert.ok(joined.includes('Build module registry'));
  });

  await it('iterates config.lines verbatim in custom order without preset clobbering explicit modules', () => {
    const custom: HudConfig = {
      ...buildPresetConfig('zen'),
      lines: ['usage', 'tools', 'identity'],
      segments: { ...buildPresetConfig('zen').segments, cost: true },
    };
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot), baseRenderOpts(custom));
    assert.equal(lines.length, 3);
    assert.ok(stripAnsi(lines[0] ?? '').includes('Context'));
    assert.ok(stripAnsi(lines[1] ?? '').includes('Edit: modules.ts'));
    assert.ok(stripAnsi(lines[2] ?? '').includes('Cost $0.425'));
  });

  await it('auto-collapses empty rows when usage segments are disabled', () => {
    const cfg: HudConfig = {
      ...buildPresetConfig('minimal'),
      segments: { ...buildPresetConfig('minimal').segments, context: false, quota: false },
    };
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot), baseRenderOpts(cfg));
    assert.equal(lines.length, 1);
    assert.ok(stripAnsi(lines[0] ?? '').includes('[G4 Carbon ● high]'));
  });

  await it('omits categories from Activity Summary whose dedicated Activity Lines are also enabled', () => {
    const line = formatActivitySummaryLine({
      enabledLines: new Set(['identity', 'activity', 'tools', 'agents']),
      activity: makeRichActivity(),
      agentsSummary: makeRichAgents(),
      termWidth: 140,
      nowSec: 1000,
    });
    const plain = stripAnsi(line);
    assert.equal(plain.includes('Edit:'), false);
    assert.equal(plain.includes('Read ×2'), false);
    assert.equal(plain.includes('Swarm:'), false);
    assert.ok(plain.includes('Skills: tdd, codebase-design'));
    assert.ok(plain.includes('MCPs: agy-fast'));
  });

  await it('orders Activity Summary completed tools by frequency and renders concrete agent names instead of raw ratios', () => {
    const repeated = (disp: string, count: number) =>
      Array.from({ length: count }, (_, idx) => ({
        name: disp,
        disp,
        target: `f${idx}.ts`,
        running: false,
        isSkillRead: false,
      }));
    const activity: TranscriptActivity = {
      tools: [
        ...repeated('Edit', 19),
        ...repeated('Read', 42),
        ...repeated('Bash', 28),
        ...repeated('Grep', 5),
        ...repeated('Glob', 5),
        ...repeated('Write', 2),
      ],
      skills: ['tdd', 'grilling', 'code-review', 'research', 'wizard'],
      mcps: ['agy-fast', 'github', 'chrome'],
      agents: [],
    };
    const agentsSummary: AgentsSummary = {
      kind: 'agents',
      working: 1,
      waiting: 0,
      alive: 1,
      total: 19,
      entries: [
        { name: 't06', type: 'coder', model: '', state: 'working', ts: null },
        ...Array.from({ length: 18 }, (_, i) => ({
          name: `old-${i}`,
          type: 'coder',
          model: '',
          state: 'done' as const,
          ts: 900,
        })),
      ],
    };

    const line = formatActivitySummaryLine({
      enabledLines: new Set(['activity']),
      activity,
      agentsSummary,
      termWidth: 140,
      nowSec: 1000,
    });
    const plain = stripAnsi(line);
    assert.ok(visibleLen(line) <= 139);
    assert.ok(plain.includes('✓ Read ×42, Bash ×28'));
    assert.ok(plain.includes('Skills: tdd'));
    assert.ok(plain.includes('MCPs: agy-fast'));
    assert.ok(plain.includes('Agents: ◐ t06 (+18)'));
    assert.equal(plain.includes('Agents 1/19'), false);
    assert.equal(plain.includes('Tools '), false);

    const recentDoneOnly = formatActivitySummaryLine({
      enabledLines: new Set(['activity']),
      activity: { tools: [], skills: [], mcps: [], agents: [] },
      agentsSummary: {
        kind: 'agents',
        working: 0,
        waiting: 0,
        alive: 0,
        total: 2,
        entries: [
          { name: 'scout', type: 'explore', model: '', state: 'done', ts: 980 },
          { name: 'reviewer', type: 'review', model: '', state: 'done', ts: 995 },
        ],
      },
      termWidth: 120,
      nowSec: 1000,
    });
    const donePlain = stripAnsi(recentDoneOnly);
    assert.ok(donePlain.includes('Agents: ✓ reviewer, ✓ scout'));
    assert.equal(donePlain.includes('(+'), false);
  });

  await it('emits empty string from Activity Summary when all four dedicated lines are enabled or all counts are zero', () => {
    const allDedicated = formatActivitySummaryLine({
      enabledLines: new Set(['activity', 'tools', 'skills', 'mcps', 'agents']),
      activity: makeRichActivity(),
      agentsSummary: makeRichAgents(),
      termWidth: 140,
      nowSec: 1000,
    });
    assert.equal(allDedicated, '');

    const allZero = formatActivitySummaryLine({
      enabledLines: new Set(['activity']),
      activity: { tools: [], skills: [], mcps: [], agents: [] },
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      termWidth: 140,
      nowSec: 1000,
    });
    assert.equal(allZero, '');
  });

  await it('caps Activity Summary to at most two running tools and fits within termWidth - 1 with CJK targets', () => {
    const activity: TranscriptActivity = {
      tools: [
        { name: 'read_file', disp: 'Read', target: '旧文件一.ts', running: true, isSkillRead: false },
        { name: 'edit_file', disp: 'Edit', target: '模块注册中心.ts', running: true, isSkillRead: false },
        { name: 'run_command', disp: 'Bash', target: '验证构建脚本.sh', running: true, isSkillRead: false },
      ],
      skills: ['tdd'],
      mcps: ['agy-fast'],
      agents: [],
    };
    const wide = formatActivitySummaryLine({
      enabledLines: new Set(['activity']),
      activity,
      agentsSummary: null,
      termWidth: 120,
      nowSec: 1000,
    });
    const widePlain = stripAnsi(wide);
    assert.ok(widePlain.includes('Bash: 验证构建脚本.sh'));
    assert.ok(widePlain.includes('Edit: 模块注册中心.ts'));
    assert.equal(widePlain.includes('旧文件一.ts'), false);
    assert.ok(visibleLen(wide) <= 119);

    for (const width of [40, 60, 80]) {
      const fitted = formatActivitySummaryLine({
        enabledLines: new Set(['activity']),
        activity,
        agentsSummary: makeRichAgents(),
        termWidth: width,
        nowSec: 1000,
      });
      assert.ok(visibleLen(fitted) <= width - 1, `width ${width} overflowed: ${visibleLen(fitted)}`);
    }
  });

  await it('invokes formatActivitySummaryTail seam with remaining columns and omits it when width is tight or empty', () => {
    const seenRemaining: number[] = [];
    const withTail = renderHudLines(cliHome, makeRichData(tmpRoot, { terminal_width: 140 }), {
      ...baseRenderOpts(buildPresetConfig('compact')),
      formatActivitySummaryTail: (remainingCols) => {
        seenRemaining.push(remainingCols);
        return remainingCols >= 11 ? ` ${GRAY}· snapshot${RESET}` : '';
      },
    });
    assert.equal(seenRemaining.length, 1);
    assert.ok((seenRemaining[0] ?? 0) >= 11);
    assert.ok(stripAnsi(withTail[3] ?? '').endsWith(' · snapshot'));
    assert.ok(visibleLen(withTail[3] ?? '') <= 139);

    const tightCalls: number[] = [];
    const tight = renderHudLines(cliHome, makeRichData(tmpRoot, { terminal_width: 50 }), {
      ...baseRenderOpts(buildPresetConfig('compact')),
      formatActivitySummaryTail: (remainingCols) => {
        tightCalls.push(remainingCols);
        return remainingCols >= 11 ? ` ${GRAY}· snapshot${RESET}` : '';
      },
    });
    assert.ok(visibleLen(tight[3] ?? '') <= 49);
    assert.equal(stripAnsi(tight[3] ?? '').includes('snapshot'), (tightCalls[0] ?? 0) >= 11);

    let emptyTailCalled = false;
    renderHudLines(cliHome, makeRichData(tmpRoot), {
      ...baseRenderOpts(buildPresetConfig('compact')),
      activity: { tools: [], skills: [], mcps: [], agents: [] },
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      formatActivitySummaryTail: () => {
        emptyTailCalled = true;
        return ` ${GRAY}· snapshot${RESET}`;
      },
    });
    assert.equal(emptyTailCalled, false);
  });

  await it('forwards activityLineOptions.formatOverflow into dedicated tools, skills, mcps, and agents rows', () => {
    const manyTools = Array.from({ length: 10 }, (_, i) => ({
      name: `tool_${i}`,
      disp: `Tool${i}`,
      target: `f${i}.ts`,
      running: false,
      isSkillRead: false,
    }));
    const manyNames = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const manyAgents: AgentsSummary = {
      kind: 'swarm',
      working: 10,
      waiting: 0,
      alive: 10,
      total: 10,
      entries: Array.from({ length: 10 }, (_, i) => ({
        name: `worker-${i}`,
        type: 'worker',
        model: '',
        state: 'working' as const,
        ts: null,
      })),
    };
    const lines = renderHudLines(cliHome, makeRichData(tmpRoot, { terminal_width: 160 }), {
      ...baseRenderOpts(buildPresetConfig('full')),
      activity: { tools: manyTools, skills: manyNames, mcps: manyNames, agents: [] },
      agentsSummary: manyAgents,
      activityLineOptions: { formatOverflow: (n) => `[+${n}]` },
    });
    const dedicated = lines.slice(3, 7).map(stripAnsi);
    for (const row of dedicated) {
      assert.ok(row.includes('[+2]'), `expected decorated overflow in row: ${row}`);
    }
  });
});
