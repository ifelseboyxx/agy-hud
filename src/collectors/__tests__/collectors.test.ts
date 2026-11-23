import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { StatusLineData } from '../../types.ts';
import { DEFAULT_HUD_CONFIG } from '../../types.ts';
import { BUILTIN_SLASH_CMDS, loadTodos, loadTranscriptActivity } from '../activity.ts';
import {
  cleanAgentLabel,
  collectAgentsSummary,
  formatAgentsBadge,
  formatRuntimeBadges,
  syncSwarmFromStdin,
  transcriptTurnEnded,
} from '../agents.ts';
import { cliHomeDir, detectGitBranch, getSessionElapsedSeconds, readCliSettings, readHudConfig } from '../settings.ts';
import {
  formatContextCapacity,
  loadSessionTelemetry,
  parseGenMetadataBlob,
  parseModelAndEffort,
  resolveOrchestratorDisplay,
  resolveQuotaReset,
} from '../telemetry.ts';

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

function encodeFieldBytes(fieldNum: number, payload: number[]): number[] {
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(payload.length), ...payload];
}

function encodeFieldVarint(fieldNum: number, value: number): number[] {
  return [...encodeVarint((fieldNum << 3) | 0), ...encodeVarint(value)];
}

function buildGenMetadataBlob(opts: {
  inTok: number;
  outTok: number;
  cwTok: number;
  crTok: number;
  ttftSec: number;
  ttftNanos: number;
  streamSec: number;
  streamNanos: number;
  ctxUsed: number;
  ctxMax: number;
}): Uint8Array {
  const usage = [
    ...encodeFieldVarint(2, opts.inTok),
    ...encodeFieldVarint(3, opts.outTok),
    ...encodeFieldVarint(4, opts.cwTok),
    ...encodeFieldVarint(5, opts.crTok),
  ];
  const ctxWin = [...encodeFieldVarint(1, opts.ctxUsed), ...encodeFieldVarint(4, opts.ctxMax)];
  const chatStart = encodeFieldBytes(10, ctxWin);
  const ttft = [...encodeFieldVarint(1, opts.ttftSec), ...encodeFieldVarint(2, opts.ttftNanos)];
  const stream = [...encodeFieldVarint(1, opts.streamSec), ...encodeFieldVarint(2, opts.streamNanos)];
  const chatModel = [
    ...encodeFieldBytes(4, usage),
    ...encodeFieldBytes(9, chatStart),
    ...encodeFieldBytes(11, ttft),
    ...encodeFieldBytes(12, stream),
  ];
  return new Uint8Array(encodeFieldBytes(1, chatModel));
}

void describe('collectors', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-collectors-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('resolves cliHomeDir, settings, hud-config defaults, git branch, and elapsed seconds', () => {
    assert.equal(
      cliHomeDir({ GEMINI_CLI_HOME: tmpRoot } as NodeJS.ProcessEnv),
      path.join(tmpRoot, '.gemini', 'antigravity-cli'),
    );
    assert.equal(
      cliHomeDir({ GEMINI_CLI_HOME: '   ', HOME: tmpRoot } as NodeJS.ProcessEnv),
      path.join(tmpRoot, '.gemini', 'antigravity-cli'),
    );

    writeFileSync(
      path.join(cliHome, 'settings.json'),
      JSON.stringify({ agentMode: 'accept-edits', orchestrator: { planner: 'Gemini 4 Carbon (High)' } }),
      'utf8',
    );
    const settings = readCliSettings(cliHome);
    assert.equal(settings.agentMode, 'accept-edits');

    writeFileSync(
      path.join(cliHome, 'hud-config.json'),
      JSON.stringify({ preset: 'compact', showCost: false, maxAgentChips: 2, showTodosLine: 'invalid' }),
      'utf8',
    );
    const hudCfg = readHudConfig(cliHome);
    assert.equal(hudCfg.preset, 'compact');
    assert.equal(hudCfg.showCost, false);
    assert.equal(hudCfg.maxAgentChips, 2);
    assert.equal(hudCfg.showTodosLine, DEFAULT_HUD_CONFIG.showTodosLine);

    const repoDir = path.join(tmpRoot, 'repo');
    const nestedDir = path.join(repoDir, 'src', 'nested');
    mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/feat/agy-hud\n', 'utf8');
    assert.deepEqual(detectGitBranch(nestedDir), { branch: 'feat/agy-hud', dirty: false });
    assert.deepEqual(detectGitBranch(nestedDir, { branch: 'main', dirty: true }), {
      branch: 'main',
      dirty: true,
    });

    assert.equal(getSessionElapsedSeconds(cliHome, 'conv-0', { duration_ms: 0 }), 0);
    const cachedElapsed = getSessionElapsedSeconds(cliHome, 'conv-persisted');
    assert.ok(cachedElapsed !== null && cachedElapsed >= 0);
    assert.ok(readFileSync(path.join(cliHome, 'cache', 'agy_hud_sessions.json'), 'utf8').includes('conv-persisted'));
  });

  void it('resolves Orchestrator Carbon and Carbon/Hydrogen model and effort strings', () => {
    const single = resolveOrchestratorDisplay('Orchestrator (Neon)', '', {
      orchestrator: { planner: 'Gemini 4 Carbon (High)' },
    });
    assert.deepEqual(single, { name: 'Orchestrator (Carbon)', effort: 'high' });

    const dual = resolveOrchestratorDisplay('Orchestrator (Neon)', '', {
      orchestrator: {
        planner: 'Gemini 4 Carbon (High)',
        executor: 'Gemini 4 Hydrogen (XHigh)',
      },
    });
    assert.deepEqual(dual, { name: 'Orchestrator (Carbon/Hydrogen)', effort: 'high/xhigh' });

    const parsed = parseModelAndEffort(
      { model: { display_name: 'Claude Opus 4.1 (Max)' } },
      { orchestrator: { planner: 'Gemini 4 Carbon (High)' } },
    );
    assert.deepEqual(parsed, { name: 'Opus 4.1', effort: 'max' });
  });

  void it('decodes protobuf generator_metadata_blob and reads SQLite incrementally with cache', () => {
    const convId = 'conv-telemetry-1';
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${convId}.db`);

    const blob0 = buildGenMetadataBlob({
      inTok: 1200,
      outTok: 300,
      cwTok: 0,
      crTok: 4800,
      ttftSec: 2,
      ttftNanos: 500_000_000,
      streamSec: 3,
      streamNanos: 0,
      ctxUsed: 32_000,
      ctxMax: 1_048_576,
    });
    const decoded0 = parseGenMetadataBlob(blob0);
    assert.deepEqual(decoded0, {
      in: 1200,
      out: 300,
      cw: 0,
      cr: 4800,
      ttft: 2.5,
      stream: 3,
      ctxUsed: 32_000,
      ctxMax: 1_048_576,
      stepIdx: -1,
    });

    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, blob0);
    } finally {
      db.close();
    }

    const data: StatusLineData = {
      conversation_id: convId,
      context_window: { used_percentage: 25 },
    };
    const tel1 = loadSessionTelemetry(cliHome, data);
    assert.equal(tel1.genCount, 1);
    assert.equal(tel1.tps, 100);
    assert.equal(tel1.ttft, 2.5);
    assert.equal(tel1.cachePct, 80);
    assert.equal(tel1.ctxMax, 1_048_576);
    assert.ok(formatContextCapacity(data.context_window, tel1).includes('262k/1M'));

    const cacheFile = path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`);
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).rows['0'].out, 300);

    const blob1 = buildGenMetadataBlob({
      inTok: 1000,
      outTok: 200,
      cwTok: 1000,
      crTok: 8000,
      ttftSec: 1,
      ttftNanos: 500_000_000,
      streamSec: 0,
      streamNanos: 200_000_000,
      ctxUsed: 64_000,
      ctxMax: 1_048_576,
    });
    const db2 = new DatabaseSync(dbPath);
    try {
      db2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, blob1);
    } finally {
      db2.close();
    }

    const tel2 = loadSessionTelemetry(cliHome, data);
    assert.equal(tel2.genCount, 2);
    assert.ok(tel2.tps !== null && Math.abs(tel2.tps - 200 / 1.7) < 0.01);
    assert.equal(tel2.cachePct, 80);

    const activeReset = resolveQuotaReset(
      { reset_time: '2026-11-22T12:05:00Z' },
      Date.parse('2026-11-22T12:00:00Z') / 1000,
    );
    assert.deepEqual(activeReset, { remainingSeconds: 300, windowExpired: false });
    const expiredReset = resolveQuotaReset(
      { reset_time: '2026-11-22T11:59:00Z' },
      Date.parse('2026-11-22T12:00:00Z') / 1000,
    );
    assert.deepEqual(expiredReset, { remainingSeconds: -60, windowExpired: true });
  });

  void it('reads native /swarm 3/5 roster without brief leaks and parses worker transcript tails', () => {
    const convId = 'swarm-conv-1';
    const swarmDir = path.join(cliHome, 'brain', convId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });

    const waitingWorkerConv = 'worker-wait-conv';
    const workingWorkerConv = 'worker-work-conv';
    mkdirSync(path.join(cliHome, 'brain', waitingWorkerConv, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(path.join(cliHome, 'brain', workingWorkerConv, '.system_generated', 'logs'), { recursive: true });

    writeFileSync(
      path.join(cliHome, 'brain', waitingWorkerConv, '.system_generated', 'logs', 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'swarm_wait', args: { since: 1 } }],
      })}\n${JSON.stringify({ type: 'GENERIC', status: 'DONE' })}\n`,
      'utf8',
    );
    writeFileSync(
      path.join(cliHome, 'brain', workingWorkerConv, '.system_generated', 'logs', 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test' } }],
      })}\n`,
      'utf8',
    );

    writeFileSync(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        members: {
          coordinator: { role: 'coordinator', killed: false },
          'hud-core': { role: 'worker', conversation_id: workingWorkerConv },
          'hud-cli': { role: 'worker', wake_mode: 'mentions' },
          'oxc-scaffold': { role: 'worker', conversation_id: waitingWorkerConv },
          'oxc-skill': { role: 'worker' },
          verifier: { role: 'worker' },
          'old-worker': { role: 'worker', killed: true },
        },
      }),
      'utf8',
    );

    const data: StatusLineData = {
      conversation_id: convId,
      agent: { name: 'hud-core' },
      battle: { status: 'active', focused_arm: 'left' },
      task_count: 2,
      tool_confirmation_pending: true,
      pending_input_count: 4,
      subagents: [
        { name: 'hud-core', status: 'WORKING', model: 'gemini-4-hydrogen' },
        {
          name: 'unmatched-brief-leak',
          role: 'You own ONLY src/collectors/* inside /repo and must never leak this long brief sentence',
          status: 'WORKING',
        },
      ],
    };

    const summary = collectAgentsSummary(cliHome, data);
    assert.equal(summary.kind, 'swarm');
    assert.equal(summary.working, 3);
    assert.equal(summary.waiting, 2);
    assert.equal(summary.alive, 5);
    assert.equal(summary.total, 5);
    assert.equal(
      summary.entries.some((e) => e.name.includes('leak') || e.name.includes('You own')),
      false,
    );
    assert.equal(summary.entries.find((e) => e.name === 'hud-core')?.model, 'gemini-4-hydrogen');

    assert.equal(cleanAgentLabel('  `worker-alpha`\nignored line ', ''), 'worker-alpha');
    assert.equal(cleanAgentLabel('a'.repeat(40), '').length, 28);
    assert.equal(transcriptTurnEnded([JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [] })]), true);

    const merged = syncSwarmFromStdin(
      [{ name: 'alpha', type: '', model: '', state: 'waiting', ts: null }],
      [{ name: 'beta', key: 'beta', altKey: 'beta', type: '', model: '', state: 'working', ts: null }],
    );
    assert.equal(merged.length, 1);

    const badge = formatAgentsBadge(summary);
    assert.ok(badge.includes('Swarm') && badge.includes('3') && badge.includes('5'));

    const escRe = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
    const strip = (s: string): string => s.replace(escRe, '');
    const badgesWithTodos = formatRuntimeBadges(data, { hasTodosLine: true }).map(strip);
    assert.equal(
      badgesWithTodos.some((b) => b.includes('BG 2')),
      false,
    );
    assert.ok(badgesWithTodos.some((b) => b.includes('@hud-core')));
    assert.ok(badgesWithTodos.some((b) => b.includes('Battle left')));
    assert.ok(badgesWithTodos.some((b) => b.includes('! Approval')));
    assert.ok(badgesWithTodos.some((b) => b.includes('Q:4')));

    const badgesNoTodos = formatRuntimeBadges(data, { hasTodosLine: false }).map(strip);
    assert.ok(badgesNoTodos.some((b) => b.includes('BG 2')));
  });

  void it('scans transcript.jsonl incrementally for tools, non-builtin skills, MCPs, and task.md todos', () => {
    const convId = 'activity-conv-1';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const skillDir = path.join(tmpRoot, 'skills', 'tdd');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: tdd\n---\n', 'utf8');

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    const initialLines = [
      JSON.stringify({ type: 'USER_INPUT', content: '/swarm start' }),
      JSON.stringify({
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>/custom-flow run</USER_REQUEST><SKILL>The user has explicitly invoked the (code-review) skill',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { name: 'read_file', args: { Path: path.join(skillDir, 'SKILL.md') } },
          { name: 'mcp__github__search_issues', args: { query: 'bug' } },
          { name: 'read_file', args: { Path: '/tmp/a.ts' } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test' } }],
      }),
    ];
    writeFileSync(transcriptPath, `${initialLines.join('\n')}\n`, 'utf8');

    const data: StatusLineData = { conversation_id: convId, task_count: 3 };
    const first = loadTranscriptActivity(cliHome, data);
    assert.ok(first !== null);
    assert.deepEqual(first.skills, ['code-review', 'custom-flow', 'tdd']);
    assert.equal(BUILTIN_SLASH_CMDS.has('swarm'), true);
    assert.deepEqual(first.mcps, ['github']);
    assert.equal(first.tools.filter((t) => t.running).length, 1);

    // Replace trailing running line with DONE and append another read_file call.
    const nextLines = [
      ...initialLines.slice(0, 3),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test' } }],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: '/tmp/b.ts' } }],
      }),
    ];
    writeFileSync(transcriptPath, `${nextLines.join('\n')}\n`, 'utf8');

    const second = loadTranscriptActivity(cliHome, data);
    assert.ok(second !== null);
    assert.equal(second.tools.filter((t) => t.running).length, 0);
    assert.equal(second.tools.filter((t) => t.name === 'read_file' && !t.isSkillRead).length, 2);

    writeFileSync(
      path.join(cliHome, 'brain', convId, 'task.md'),
      '- [x] Setup\n- [/] Implement HUD collectors\n- [ ] Verify build\n',
      'utf8',
    );
    assert.deepEqual(loadTodos(cliHome, data), {
      total: 3,
      completed: 1,
      current: 'Implement HUD collectors',
      taskCount: 3,
    });
  });

  void it('ignores corrupted telemetry and activity disk caches without throwing TypeError', () => {
    const convId = 'corrupt-cache-conv';
    const convDir = path.join(cliHome, 'conversations');
    const cacheDir = path.join(cliHome, 'cache');
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    // 1. Telemetry cache with valid signature but null row value must miss cache and reload from SQLite.
    const dbPath = path.join(convDir, `${convId}.db`);
    const blob = buildGenMetadataBlob({
      inTok: 1000,
      outTok: 150,
      cwTok: 0,
      crTok: 0,
      ttftSec: 1,
      ttftNanos: 0,
      streamSec: 1,
      streamNanos: 0,
      ctxUsed: 5000,
      ctxMax: 100_000,
    });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, blob);
    } finally {
      db.close();
    }
    const telFirst = loadSessionTelemetry(cliHome, { conversation_id: convId });
    assert.equal(telFirst.genCount, 1);
    const telCachePath = path.join(cacheDir, `agy_hud_telemetry_${convId}.json`);
    const savedTelCache = JSON.parse(readFileSync(telCachePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(telCachePath, JSON.stringify({ ...savedTelCache, rows: { '0': null, '1': 'bad-row' } }), 'utf8');
    const telRecovered = loadSessionTelemetry(cliHome, { conversation_id: convId });
    assert.equal(telRecovered.genCount, 1);

    // 2. Activity cache with matching stat metadata but invalid data arrays must miss cache and re-scan transcript.
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: {} }] })}\n`,
      'utf8',
    );
    const actFirst = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(actFirst !== null && actFirst.tools.length === 1);
    const actCachePath = path.join(cacheDir, `agy_hud_activity_${convId}.json`);
    const savedActCache = JSON.parse(readFileSync(actCachePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      actCachePath,
      JSON.stringify({ ...savedActCache, data: { tools: [null], skills: 'not-array', mcps: [], agents: [] } }),
      'utf8',
    );
    const actRecovered = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(actRecovered !== null && actRecovered.tools.length === 1);
  });
});
