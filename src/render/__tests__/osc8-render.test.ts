import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readSnapshotEnvelope } from '../../collectors/snapshot-envelope.ts';
import { buildPresetConfig } from '../../core/hud-config.ts';
import { runHudRender as renderHudLines } from '../../hud-runner.ts';
import type { AgentsSummary, HudConfig, StatusLineData, TranscriptActivity } from '../../types.ts';
import { GRAY, RESET, stripAnsi, visibleLen } from '../ansi.ts';
import { resolveSnapshotMarkdownUri } from '../osc8.ts';

const ESC = String.fromCharCode(0x1b);
const LOCAL_ENV: NodeJS.ProcessEnv = { TERM: 'xterm-256color' };

function makeBaseData(tmpRoot: string, overrides?: Partial<StatusLineData>): StatusLineData {
  return {
    cwd: path.join(tmpRoot, 'repo'),
    conversation_id: 'conv-render-1',
    conversation_title: 'OSC 8 Render Integration',
    model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
    context_window: { used_percentage: 25, context_window_size: 1_000_000 },
    terminal_width: 140,
    ...overrides,
  };
}

function makeOverflowActivity(): TranscriptActivity {
  const tools = Array.from({ length: 10 }, (_, idx) => ({
    name: `tool_${idx + 1}`,
    disp: `tool_${idx + 1}`,
    target: `file_${idx + 1}.ts`,
    fullTarget: `/repo/src/file_${idx + 1}.ts`,
    running: false,
    isSkillRead: false,
  }));
  const names = Array.from({ length: 10 }, (_, idx) => `item-${idx + 1}`);
  return { tools, skills: names, mcps: names, agents: [] };
}

function makeOverflowAgents(): AgentsSummary {
  return {
    kind: 'swarm',
    working: 5,
    waiting: 5,
    alive: 10,
    total: 10,
    entries: Array.from({ length: 10 }, (_, idx) => ({
      name: `worker-${idx + 1}`,
      type: 'worker',
      model: '',
      state: idx < 5 ? ('working' as const) : ('waiting' as const),
      ts: 1000 + idx,
    })),
  };
}

void describe('renderHudLines OSC 8 hyperlinks integration', async () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-osc8-render-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await it('wraps Activity Line +N more badges with OSC 8 while keeping separators unlinked', () => {
    const data = makeBaseData(tmpRoot, { terminal_width: 160 });
    const target = resolveSnapshotMarkdownUri(cliHome, 'conv-render-1');
    assert.ok(target !== null);

    const lines = renderHudLines(cliHome, data, {
      cliSettings: {},
      hudConfig: buildPresetConfig('full'),
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      activity: makeOverflowActivity(),
      agentsSummary: makeOverflowAgents(),
      todos: null,
      agyPid: process.pid,
      nowSec: 1200,
      env: LOCAL_ENV,
    });

    const toolsLine = lines.find((line) => stripAnsi(line).includes('tool_1')) ?? '';
    const skillsLine = lines.find((line) => stripAnsi(line).includes('Skills (10):')) ?? '';
    const mcpsLine = lines.find((line) => stripAnsi(line).includes('MCPs (10):')) ?? '';
    const agentsLine = lines.find((line) => stripAnsi(line).includes('Swarm (5/10):')) ?? '';
    const expectedLink = `${GRAY}${ESC}]8;;${target.uri}${ESC}\\+2 more${ESC}]8;;${ESC}\\${RESET}`;

    assert.equal(toolsLine.includes(` ${GRAY}|${RESET} ${expectedLink}`), true);
    assert.equal(skillsLine.includes(`, ${expectedLink}`), true);
    assert.equal(mcpsLine.includes(`, ${expectedLink}`), true);
    assert.equal(agentsLine.includes(`, ${expectedLink}`), true);
    for (const line of [toolsLine, skillsLine, mcpsLine, agentsLine]) {
      assert.ok(visibleLen(line) <= 159);
      assert.equal(line.includes(`${ESC}[4m`), false);
    }
    assert.equal(existsSync(target.absPath), true);
  });

  await it('appends OSC 8 snapshot tail on Activity Summary when at least 11 columns remain', () => {
    const data = makeBaseData(tmpRoot, { terminal_width: 120 });
    const target = resolveSnapshotMarkdownUri(cliHome, 'conv-render-1');
    assert.ok(target !== null);

    const lines = renderHudLines(cliHome, data, {
      cliSettings: {},
      hudConfig: buildPresetConfig('compact'),
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      activity: {
        tools: [{ name: 'read_file', disp: 'Read', target: 'a.ts', running: false, isSkillRead: false }],
        skills: ['tdd'],
        mcps: [],
        agents: [],
      },
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      todos: null,
      agyPid: process.pid,
      nowSec: 1200,
      env: LOCAL_ENV,
    });

    const summaryLine = lines.find((line) => stripAnsi(line).includes('Read ×1')) ?? '';
    assert.ok(stripAnsi(summaryLine).includes('Skills: tdd'));
    assert.equal(
      summaryLine.endsWith(` ${GRAY}· ${ESC}]8;;${target.uri}${ESC}\\snapshot${ESC}]8;;${ESC}\\${RESET}`),
      true,
    );
    assert.ok(visibleLen(summaryLine) <= 119);
    assert.equal(existsSync(target.absPath), true);
  });

  await it('omits Activity Summary snapshot tail when remaining width is below 11 columns', () => {
    const activity: TranscriptActivity = {
      tools: [{ name: 'read_file', disp: 'Read', target: 'a.ts', running: false, isSkillRead: false }],
      skills: ['tdd'],
      mcps: [],
      agents: [],
    };
    const narrowData = makeBaseData(tmpRoot, { conversation_id: 'conv-tight', terminal_width: 33 });
    const target = resolveSnapshotMarkdownUri(cliHome, 'conv-tight');
    assert.ok(target !== null);

    const lines = renderHudLines(cliHome, narrowData, {
      cliSettings: {},
      hudConfig: buildPresetConfig('compact'),
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      activity,
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      todos: null,
      agyPid: process.pid,
      nowSec: 1200,
      env: LOCAL_ENV,
    });

    const summaryLine = lines.find((line) => stripAnsi(line).includes('Read ×1')) ?? '';
    assert.equal(stripAnsi(summaryLine).includes('snapshot'), false);
    assert.equal(summaryLine.includes(`${ESC}]8;;`), false);
    assert.equal(existsSync(target.absPath), false);
    assert.equal(existsSync(path.join(cliHome, 'cache', 'agy_hud_snapshot_conv-tight.json')), true);
  });

  await it('skips markdown materialization for non-overflowing full Activity Lines', () => {
    const convId = 'conv-no-overflow';
    const lines = renderHudLines(cliHome, makeBaseData(tmpRoot, { conversation_id: convId, terminal_width: 140 }), {
      cliSettings: {},
      hudConfig: buildPresetConfig('full'),
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      activity: {
        tools: [{ name: 'read_file', disp: 'Read', target: 'a.ts', running: false, isSkillRead: false }],
        skills: ['tdd'],
        mcps: ['agy-fast'],
        agents: [],
      },
      agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
      todos: null,
      agyPid: process.pid,
      nowSec: 1200,
      env: LOCAL_ENV,
    });
    assert.equal(lines.join('\n').includes(`${ESC}]8;;`), false);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`)), false);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`)), true);
  });

  await it('suppresses OSC 8 links under config off or NO_COLOR or dumb TERM or SSH env', () => {
    const cases: { convId: string; osc8Links: boolean; env: NodeJS.ProcessEnv }[] = [
      { convId: 'conv-off', osc8Links: false, env: LOCAL_ENV },
      { convId: 'conv-nocolor', osc8Links: true, env: { NO_COLOR: '1' } },
      { convId: 'conv-dumb', osc8Links: true, env: { TERM: 'dumb' } },
      { convId: 'conv-ssh', osc8Links: true, env: { SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 50000' } },
    ];
    for (const tc of cases) {
      const lines = renderHudLines(cliHome, makeBaseData(tmpRoot, { conversation_id: tc.convId }), {
        cliSettings: {},
        hudConfig: { ...buildPresetConfig('compact'), osc8Links: tc.osc8Links },
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
        activity: makeOverflowActivity(),
        agentsSummary: makeOverflowAgents(),
        todos: null,
        agyPid: process.pid,
        nowSec: 1200,
        env: tc.env,
      });
      assert.equal(lines.join('\n').includes(`${ESC}]8;;`), false, `expected no OSC 8 for ${tc.convId}`);
      assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${tc.convId}.md`)), false);
      assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${tc.convId}.json`)), true);
    }
  });

  await it('writes lightweight json envelope without markdown when all activity modules are disabled', () => {
    const convId = 'conv-zen-no-md';
    const zenCfg: HudConfig = buildPresetConfig('zen');
    renderHudLines(cliHome, makeBaseData(tmpRoot, { conversation_id: convId }), {
      cliSettings: {},
      hudConfig: zenCfg,
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      agyPid: process.pid,
      nowSec: 1200,
      env: LOCAL_ENV,
    });
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`)), true);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`)), false);
  });

  await it('rewrites materialized markdown only when transcript grows across ticks', () => {
    const convId = 'conv-digest-loop';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    const step1 = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', args: { Path: '/repo/src/first.ts' } }],
    });
    appendFileSync(transcriptPath, `${step1}\n`, 'utf8');

    const data = makeBaseData(tmpRoot, { conversation_id: convId });
    const mdPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`);
    const renderOpts = {
      cliSettings: {},
      hudConfig: buildPresetConfig('compact'),
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      todos: null,
      agyPid: process.pid,
      nowSec: 1500,
      env: LOCAL_ENV,
    };

    renderHudLines(cliHome, data, renderOpts);
    assert.ok(readFileSync(mdPath, 'utf8').includes('/repo/src/first.ts'));
    const digest1 = readSnapshotEnvelope(cliHome, convId)?.mdDigest;
    const frozenTime = new Date(1_700_000_000_000);
    utimesSync(mdPath, frozenTime, frozenTime);

    renderHudLines(cliHome, data, { ...renderOpts, nowSec: 1501 });
    assert.equal(Math.trunc(statSync(mdPath).mtimeMs), 1_700_000_000_000);

    const step2 = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'edit_file', args: { Path: '/repo/src/second.ts' } }],
    });
    appendFileSync(transcriptPath, `${step2}\n`, 'utf8');

    renderHudLines(cliHome, data, { ...renderOpts, nowSec: 1502 });
    assert.notEqual(Math.trunc(statSync(mdPath).mtimeMs), 1_700_000_000_000);
    assert.ok(readFileSync(mdPath, 'utf8').includes('/repo/src/second.ts'));
    assert.notEqual(readSnapshotEnvelope(cliHome, convId)?.mdDigest, digest1);
  });

  await it('emits OSC 8 hyperlinks over piped non-TTY stdout in hud-entry subprocess', () => {
    const convId = 'conv-piped-tty';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: '/repo/src/piped.ts' } }],
      })}\n`,
      'utf8',
    );
    writeFileSync(path.join(cliHome, 'hud-config.json'), JSON.stringify({ preset: 'compact' }), 'utf8');
    const entryFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hud-entry.ts');
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: tmpRoot,
      GEMINI_CLI_HOME: tmpRoot,
      TERM: 'xterm-256color',
    };
    const res = spawnSync(process.execPath, [entryFile], {
      input: JSON.stringify(makeBaseData(tmpRoot, { conversation_id: convId, terminal_width: 120 })),
      encoding: 'utf8',
      env: cleanEnv,
    });
    assert.equal(res.status, 0, res.stderr);
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    assert.equal(res.stdout.includes(`${ESC}]8;;${target.uri}${ESC}\\snapshot${ESC}]8;;${ESC}\\`), true);
    assert.equal(existsSync(target.absPath), true);
  });
});
