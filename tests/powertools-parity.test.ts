import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';

import { createPopupState, renderPopupFrame } from '../src/cli/snapshot-popup.ts';
import { runSnapshotCommand } from '../src/cli/snapshot.ts';
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

function encodeTs(sec: number): number[] {
  return encodeFieldVarint(1, sec);
}

function encodeStepMeta(fields: { t1?: number; t7?: number; t8?: number; t32?: number }): Uint8Array {
  const out: number[] = [];
  if (fields.t1 !== undefined) out.push(...encodeFieldBytes(1, encodeTs(fields.t1)));
  if (fields.t7 !== undefined) out.push(...encodeFieldBytes(7, encodeTs(fields.t7)));
  if (fields.t8 !== undefined) out.push(...encodeFieldBytes(8, encodeTs(fields.t8)));
  if (fields.t32 !== undefined) out.push(...encodeFieldBytes(32, encodeTs(fields.t32)));
  return new Uint8Array(out);
}

function buildGenBlob(opts: {
  inTok: number;
  outTok: number;
  crTok: number;
  thinkTok: number;
  ctxUsed: number;
  ctxMax: number;
  modelDisplay: string;
  ttftSec?: number;
  streamSec?: number;
  retries?: number;
  retryErr?: string;
  stepIdx?: number;
  breakdown?: { sys: number; rules: number; skills: number; tools: number; mcp: number; msgs: number };
}): Uint8Array {
  const enc = new TextEncoder();
  const usage = [
    ...encodeFieldVarint(2, opts.inTok),
    ...encodeFieldVarint(3, opts.outTok),
    ...encodeFieldVarint(5, opts.crTok),
    ...encodeFieldVarint(9, opts.thinkTok),
    ...encodeFieldVarint(10, Math.max(0, opts.outTok - opts.thinkTok)),
  ];
  const bd = opts.breakdown;
  const encodeTokenGroup = (name: string, tokens: number): number[] =>
    encodeFieldBytes(1, [...encodeFieldBytes(1, [...enc.encode(name)]), ...encodeFieldVarint(4, tokens)]);
  const ctxMsg = [
    ...encodeFieldVarint(1, opts.ctxUsed),
    ...encodeFieldVarint(4, opts.ctxMax),
    ...(bd
      ? encodeFieldBytes(3, [
          ...encodeTokenGroup('System Prompt', bd.sys),
          ...encodeTokenGroup('Rules', bd.rules),
          ...encodeTokenGroup('Skills', bd.skills),
          ...encodeTokenGroup('Tools', bd.tools),
          ...encodeTokenGroup('Mcp Tools', bd.mcp),
          ...encodeTokenGroup('Chat Messages', bd.msgs),
        ])
      : []),
  ];
  const chatStart = encodeFieldBytes(10, ctxMsg);
  const chatModel = [
    ...encodeFieldBytes(4, usage),
    ...encodeFieldBytes(9, chatStart),
    ...encodeFieldBytes(11, encodeFieldVarint(1, opts.ttftSec ?? 1)),
    ...encodeFieldBytes(12, encodeFieldVarint(1, opts.streamSec ?? 4)),
    ...(opts.retries !== undefined && opts.retries > 0 ? encodeFieldVarint(14, opts.retries) : []),
    ...(opts.retryErr
      ? encodeFieldBytes(17, [
          ...encodeFieldBytes(3, [...enc.encode(opts.retryErr)]),
          ...encodeFieldBytes(7, encodeFieldVarint(1, 2)),
        ])
      : []),
    ...(opts.stepIdx !== undefined
      ? encodeFieldBytes(20, [
          ...encodeFieldBytes(1, [...enc.encode('last_step_index')]),
          ...encodeFieldBytes(2, [...enc.encode(String(opts.stepIdx))]),
        ])
      : []),
    ...encodeFieldBytes(21, [...enc.encode(opts.modelDisplay)]),
  ];
  return new Uint8Array(encodeFieldBytes(1, chatModel));
}

void describe('3-surface powertools parity and read-only WAL contract', () => {
  void it('keeps Context Budget, Quota Pace, Phase, Diagnostics, Subagent Rollup, and safe file links consistent across HUD, Markdown, CLI snapshot, and popup', () => {
    const root = tracker.makeTempDir('agy-hud-pt-parity-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const wsDir = path.join(root, 'workspace');
    const convId = 'pt-parent-1001';
    const childId = 'pt-child-2002';
    const convDir = path.join(cliHome, 'conversations');
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    const swarmDir = path.join(cliHome, 'brain', convId, '.system_generated', 'swarm');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(swarmDir, { recursive: true });
    mkdirSync(path.join(wsDir, 'routes', '#id'), { recursive: true });

    const targetFile = path.join(wsDir, 'routes', '#id', 'page.tsx');
    writeFileSync(targetFile, 'export const page = 1;\n', 'utf8');

    // Seed parent SQLite DB in WAL mode
    const parentDb = new DatabaseSync(path.join(convDir, `${convId}.db`));
    try {
      parentDb.exec('PRAGMA journal_mode = WAL;');
      parentDb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      parentDb.exec(
        'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)',
      );
      const insGen = parentDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
      insGen.run(
        0,
        buildGenBlob({
          inTok: 4_000,
          outTok: 800,
          crTok: 36_000,
          thinkTok: 500,
          ctxUsed: 256_000,
          ctxMax: 512_000,
          modelDisplay: 'Gemini 4 Carbon (High)',
          ttftSec: 1,
          streamSec: 4,
          retries: 1,
          retryErr: 'HTTP 429 rate limit exceeded',
          stepIdx: 1,
          breakdown: { sys: 10_000, rules: 5_000, skills: 3_000, tools: 8_000, mcp: 4_000, msgs: 226_000 },
        }),
      );
      const insStep = parentDb.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)',
      );
      insStep.run(1, 15, 3, encodeStepMeta({ t1: 1000, t7: 1005, t8: 1005, t32: 1005 }), new Uint8Array());
      insStep.run(2, 132, 3, encodeStepMeta({ t1: 1005, t7: 1005, t32: 1006, t8: 1018 }), new Uint8Array());
    } finally {
      parentDb.close();
    }

    // Seed child SQLite DB in WAL mode
    const childDb = new DatabaseSync(path.join(convDir, `${childId}.db`));
    try {
      childDb.exec('PRAGMA journal_mode = WAL;');
      childDb.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      childDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        0,
        buildGenBlob({
          inTok: 1_500,
          outTok: 320,
          crTok: 8_500,
          thinkTok: 200,
          ctxUsed: 30_000,
          ctxMax: 512_000,
          modelDisplay: 'Gemini 4 Flash (Medium)',
          ttftSec: 1,
          streamSec: 2,
        }),
      );
    } finally {
      childDb.close();
    }

    writeFileSync(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        members: {
          coordinator: { role: 'coordinator', conversation_id: convId },
          researcher: { role: 'worker', conversation_id: childId, model: 'inherit', killed: false },
        },
      }),
      'utf8',
    );
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon (High)',
        created_at: '2026-06-01T11:59:00Z',
        tool_calls: [{ name: 'read_file', args: { Path: `${targetFile}:12` } }],
      })}\n`,
      'utf8',
    );

    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    const data: StatusLineData = {
      conversation_id: convId,
      conversation_title: 'Powertools Parity Session',
      cwd: wsDir,
      workspace: { current_dir: wsDir, project_dir: wsDir },
      model: { display_name: 'Gemini 4 Carbon (High)' },
      context_window: { context_window_size: 1_000_000 },
      agent_state: 'idle',
      quota: {
        'gemini-5h': { remaining_fraction: 0.4, reset_in_seconds: 12_600 },
      },
      terminal_width: 140,
    };

    const convFilesBefore = readdirSync(convDir).sort();

    // 1. Live HUD + OSC 8 Markdown materialization
    const hudRaw = runHudRender(cliHome, data, {
      nowSec: nowMs / 1000,
      agyPid: 5150,
      bypass: false,
      cliMode: '',
      branch: 'main',
      todos: null,
      hudConfig: {
        preset: 'compact',
        osc8Links: true,
        lines: ['identity', 'usage', 'activity'],
      },
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const hudText = hudRaw.map(stripAnsi).join('\n');
    assert.ok(hudText.includes('256k/512k'), `HUD must show Context Budget 512k: ${hudText}`);
    assert.ok(hudText.includes('~0%'), `HUD must show Quota Pace depletion: ${hudText}`);
    assert.ok(hudText.includes('Retry ×1 429'), `HUD must show transient Retry badge: ${hudText}`);
    // Strictly zero cold child DB reads on statusLine hot path -> child telemetry cache must NOT exist yet!
    assert.equal(
      existsSync(path.join(cliHome, 'cache', `agy_hud_telemetry_${childId}.json`)),
      false,
      'statusLine hot path must not open child SQLite DBs',
    );

    const mdPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`);
    assert.equal(existsSync(mdPath), true, 'expected materialized snapshot Markdown');
    const markdown = readFileSync(mdPath, 'utf8');
    assert.ok(markdown.includes('- **Phase**: `idle`'));
    assert.ok(markdown.includes('- **Diagnostics**: Retries ×1'));
    assert.ok(markdown.includes('## Context'));
    assert.ok(markdown.includes('Nominal 1M'));
    assert.ok(markdown.includes('Time 5s model / 12s tool'));
    assert.ok(markdown.includes('~0%'));
    assert.ok(markdown.includes('%23id/page.tsx#L12'), `expected safe percent-encoded link in Markdown:\n${markdown}`);

    // Persist live envelope with active approval state to verify --sessions phase display
    writeSnapshotEnvelope(cliHome, { ...data, tool_confirmation_pending: true }, 5150, { nowMs });

    // 2. CLI snapshot (text, --json, context filter, --sessions) + Popup frame ('c' / '5')
    const sessionsOut = runSnapshotCommand(['--sessions'], {
      cliHome,
      cwd: wsDir,
      nowMs,
      isAlive: (p) => p === 5150,
    }).output;
    assert.ok(sessionsOut.includes('live:5150 (approval)'), sessionsOut);

    const cliJson = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        cwd: wsDir,
        nowMs,
        isAlive: (p) => p === 5150,
      }).output,
    ) as ActivitySnapshot;
    assert.equal(cliJson.turnPhase, 'approval');
    assert.equal(cliJson.telemetry.ctxMax, 512_000);
    assert.equal(cliJson.telemetry.modelTimeSec, 5);
    assert.equal(cliJson.telemetry.toolTimeSec, 12);
    assert.equal(cliJson.subagentRollup?.measuredCount, 1);
    assert.equal(cliJson.agents.find((a) => a.name === 'researcher')?.model, 'Gemini 4 Flash (Medium)');

    const cliText = stripAnsi(
      runSnapshotCommand(['--session', convId, '--no-color'], {
        cliHome,
        cwd: wsDir,
        nowMs,
        isAlive: (p) => p === 5150,
      }).output,
    );
    assert.ok(cliText.includes('Phase: approval'));
    assert.ok(cliText.includes('Diagnostics: Retries ×1'));
    assert.ok(cliText.includes('Context · 256k/512k'));
    assert.ok(cliText.includes('Subagent Rollup: 1/1 measured'));

    const popupContextFrame = stripAnsi(
      renderPopupFrame(cliJson, createPopupState(['context']), { rows: 30, cols: 100, color: false }).output,
    );
    assert.ok(popupContextFrame.includes('Context · 256k/512k'));
    assert.ok(popupContextFrame.includes('[1-5/c/a]'));

    // Zero WAL / SHM sidecar mutation across all DB reads
    assert.deepEqual(readdirSync(convDir).sort(), convFilesBefore);
  });

  void it('keeps stdin Context Budget fallback, step-6 cancellation, narrow Orchestrator settings, and --sessions SQLite phase consistent across 3 surfaces', () => {
    const root = tracker.makeTempDir('agy-hud-pt-edge-parity-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const wsDir = path.join(root, 'workspace');
    const convId = 'pt-edge-3003';
    const convDir = path.join(cliHome, 'conversations');
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    // 1. genCount === 0: HUD, OSC 8 Markdown, and CLI snapshot must all fall back to stdin context_window
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: 'a.ts' } }],
      })}\n`,
      'utf8',
    );
    const nowMs = Date.parse('2026-06-02T12:00:00Z');
    const stdinOnlyData: StatusLineData = {
      conversation_id: convId,
      conversation_title: 'Stdin Fallback Session',
      cwd: wsDir,
      workspace: { current_dir: wsDir, project_dir: wsDir },
      model: { display_name: 'Orchestrator (Carbon)' },
      context_window: { context_window_size: 1_048_576, used_percentage: 38 },
      terminal_width: 140,
    };
    const hudEmpty = runHudRender(cliHome, stdinOnlyData, {
      nowSec: nowMs / 1000,
      agyPid: 6260,
      branch: 'main',
      todos: null,
      hudConfig: { preset: 'compact', osc8Links: true, lines: ['identity', 'usage', 'activity'] },
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
      .map(stripAnsi)
      .join('\n');
    assert.ok(hudEmpty.includes('398k/1M'), hudEmpty);

    const mdEmpty = readFileSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`), 'utf8');
    assert.ok(mdEmpty.includes('Ctx 398k/1M (38%)'), mdEmpty);

    const cliEmpty = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        cwd: wsDir,
        nowMs,
        isAlive: (p) => p === 6260,
      }).output,
    ) as ActivitySnapshot;
    assert.equal(cliEmpty.telemetry.ctxMax, 1_048_576);
    assert.equal(cliEmpty.telemetry.ctxUsed, Math.round(0.38 * 1_048_576));

    // 2. Seed settings-based Orchestrator (no protobuf exec enum) + active running GENERIC step + step-6 canceled retry
    writeFileSync(
      path.join(cliHome, 'settings.json'),
      JSON.stringify({
        orchestrator: { planner: 'Gemini 4 Carbon (High)', executor: 'Gemini 4 Hydrogen (XHigh)' },
      }),
      'utf8',
    );
    const dbPath = path.join(convDir, `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.exec(
        'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)',
      );
      const insGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
      insGen.run(
        0,
        buildGenBlob({
          inTok: 2_000,
          outTok: 300,
          crTok: 8_000,
          thinkTok: 100,
          ctxUsed: 120_000,
          ctxMax: 256_000,
          modelDisplay: 'Gemini 4 Hydrogen (XHigh)',
          stepIdx: 0,
        }),
      );
      insGen.run(
        1,
        buildGenBlob({
          inTok: 3_000,
          outTok: 400,
          crTok: 12_000,
          thinkTok: 150,
          ctxUsed: 140_000,
          ctxMax: 512_000,
          modelDisplay: 'Gemini 4 Carbon (High)',
          retries: 1,
          retryErr: 'HTTP 429 rate limit exceeded',
          stepIdx: 1,
        }),
      );
      const insStep = db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)',
      );
      // Step 2 (corresponding to gen idx 1 via stepIdx+1=2) is CANCELED (status = 6) -> must suppress Retry badge
      insStep.run(2, 15, 6, encodeStepMeta({ t1: 2000, t7: 2005 }), new Uint8Array());
      // Step 3 is an active GENERIC tool step (status = 2) -> --sessions must fall back to tool_use when envelope has no agentState
      insStep.run(3, 132, 2, encodeStepMeta({ t32: 2006 }), new Uint8Array());
    } finally {
      db.close();
    }

    // Narrow layout hiding identity/usage triggers lazy telemetry backfill in hud-runner -> must still pass cliSettings and lock to 256k
    const hudNarrow = runHudRender(
      cliHome,
      { ...stdinOnlyData, terminal_width: 80 },
      {
        nowSec: (nowMs + 5_000) / 1000,
        agyPid: 6260,
        branch: 'main',
        todos: null,
        hudConfig: {
          preset: 'compact',
          osc8Links: true,
          lines: ['identity', 'usage', 'activity'],
          narrow: { lines: ['activity'] },
        },
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      },
    )
      .map(stripAnsi)
      .join('\n');
    assert.equal(hudNarrow.includes('Retry'), false);
    const mdNarrow = readFileSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`), 'utf8');
    assert.ok(mdNarrow.includes('Ctx 140k/256k'), mdNarrow);
    assert.equal(mdNarrow.includes('Diagnostics'), false, 'canceled step status=6 must not report Retry diagnostics');

    const cliJson = JSON.parse(
      runSnapshotCommand(['--session', convId, '--json'], {
        cliHome,
        cwd: wsDir,
        nowMs: nowMs + 5_000,
        isAlive: (p) => p === 6260,
      }).output,
    ) as ActivitySnapshot;
    assert.equal(cliJson.telemetry.ctxMax, 256_000);
    assert.equal(cliJson.telemetry.lastRetries, 0);
    assert.equal(cliJson.turnPhase, 'tool_use');

    const sessionsOut = runSnapshotCommand(['--sessions'], {
      cliHome,
      cwd: wsDir,
      nowMs: nowMs + 5_000,
      isAlive: (p) => p === 6260,
    }).output;
    assert.ok(sessionsOut.includes('live:6260 (tool_use)'), sessionsOut);
  });
});
