import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { SnapshotAgent } from '../../snapshot-types.ts';
import { attachSubagentTelemetryRollups, MAX_COLD_CHILD_DB_READS_PER_SNAPSHOT } from '../subagent-rollup.ts';

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

function buildChildGenBlob(opts: {
  inTok: number;
  outTok: number;
  crTok: number;
  thinkTok: number;
  ctxUsed: number;
  ctxMax: number;
  modelDisplay: string;
}): Uint8Array {
  const enc = new TextEncoder();
  const usage = [
    ...encodeFieldVarint(2, opts.inTok),
    ...encodeFieldVarint(3, opts.outTok),
    ...encodeFieldVarint(5, opts.crTok),
    ...encodeFieldVarint(9, opts.thinkTok),
    ...encodeFieldVarint(10, Math.max(0, opts.outTok - opts.thinkTok)),
  ];
  const chatStart = encodeFieldBytes(10, [...encodeFieldVarint(1, opts.ctxUsed), ...encodeFieldVarint(4, opts.ctxMax)]);
  const dur1 = encodeFieldVarint(1, 1);
  const dur2 = encodeFieldVarint(1, 2);
  const chatModel = [
    ...encodeFieldBytes(4, usage),
    ...encodeFieldBytes(9, chatStart),
    ...encodeFieldBytes(11, dur1),
    ...encodeFieldBytes(12, dur2),
    ...encodeFieldBytes(21, [...enc.encode(opts.modelDisplay)]),
  ];
  return new Uint8Array(encodeFieldBytes(1, chatModel));
}

function writeChildDb(cliHome: string, childId: string, modelDisplay: string): void {
  const convDir = path.join(cliHome, 'conversations');
  mkdirSync(convDir, { recursive: true });
  const db = new DatabaseSync(path.join(convDir, `${childId}.db`));
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      buildChildGenBlob({
        inTok: 1_000,
        outTok: 300,
        crTok: 9_000,
        thinkTok: 180,
        ctxUsed: 24_000,
        ctxMax: 512_000,
        modelDisplay,
      }),
    );
  } finally {
    db.close();
  }
}

void describe('CLI subagent telemetry rollup with cycle guard, settled cache fast-path, and cold DB cap', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-subagent-rollup-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('recovers inherit models, aggregates rollup, guards self-poison cycles, and mutates zero WAL files', () => {
    const parentId = 'parent-1111';
    const childId = 'child-2222';
    writeChildDb(cliHome, childId, 'Gemini 4 Flash (Medium)');

    // Seed conversation_summaries.db with legitimate child + self-poisoned parent loop
    const sumDb = new DatabaseSync(path.join(cliHome, 'conversation_summaries.db'));
    try {
      sumDb.exec(
        'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT, killed INTEGER)',
      );
      const ins = sumDb.prepare(
        'INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name, killed) VALUES (?, ?, ?, ?, ?)',
      );
      ins.run(parentId, parentId, 1, 'self-poison', 0);
      ins.run(childId, parentId, 1, 'Researcher', 0);
    } finally {
      sumDb.close();
    }

    const agents: SnapshotAgent[] = [
      { name: 'Researcher', type: 'research', model: 'inherit', state: 'done', ts: 1000, ageLabel: '1m ago' },
    ];
    const convDir = path.join(cliHome, 'conversations');
    const beforeFiles = readdirSync(convDir).sort();

    const result = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents,
    });

    assert.deepEqual(readdirSync(convDir).sort(), beforeFiles);
    assert.equal(result.agents[0]?.model, 'Gemini 4 Flash (Medium)');
    assert.equal(result.agents[0]?.telemetry?.genCount, 1);
    assert.equal(result.agents[0]?.telemetry?.ctxUsed, 24_000);
    assert.equal(result.rollup?.measuredCount, 1);
    assert.equal(result.rollup?.totalOutputTokens, 300);
    assert.equal(result.rollup?.totalThinkingTokens, 180);

    // Second pass hits settled cache even if child .db is removed (proving 0 SQLite / versionTag opens)
    rmSync(path.join(convDir, `${childId}.db`), { force: true });
    const cachedPass = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents: [{ name: 'Researcher', type: 'research', model: 'inherit', state: 'done', ts: 1000, ageLabel: '1m ago' }],
    });
    assert.equal(cachedPass.agents[0]?.telemetry?.ctxUsed, 24_000);
    assert.equal(cachedPass.agents[0]?.model, 'Gemini 4 Flash (Medium)');
  });

  void it('caps cold uncached child DB opens at MAX_COLD_CHILD_DB_READS_PER_SNAPSHOT (8) prioritizing working -> waiting -> done', () => {
    const parentId = 'swarm-parent-9999';
    const swarmDir = path.join(cliHome, 'brain', parentId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    const members: Record<string, unknown> = { coordinator: { role: 'coordinator', conversation_id: parentId } };
    const agents: SnapshotAgent[] = [];

    for (let i = 0; i < 10; i += 1) {
      const cid = `worker-conv-${i}`;
      const name = `worker-${i}`;
      writeChildDb(cliHome, cid, 'Gemini 4 Flash');
      members[name] = { role: 'worker', conversation_id: cid, killed: i >= 2 };
      agents.push({
        name,
        type: 'worker',
        model: 'inherit',
        state: i === 0 ? 'working' : i === 1 ? 'waiting' : 'done',
        ts: 1_000 + i,
        ageLabel: '1m ago',
      });
    }
    writeFileSync(path.join(swarmDir, 'members.json'), JSON.stringify({ members }), 'utf8');

    const res = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents,
    });
    assert.equal(MAX_COLD_CHILD_DB_READS_PER_SNAPSHOT, 8);
    assert.equal(res.rollup?.measuredCount, 8);
    // Working and waiting workers must always be included in the 8-open budget
    assert.ok(res.agents.find((a) => a.name === 'worker-0')?.telemetry != null);
    assert.ok(res.agents.find((a) => a.name === 'worker-1')?.telemetry != null);
  });

  void it('blocks child SQLite opens strictly when maxColdDbReads is 0 even with corrupted cache JSON, and prevents anonymous transcript echoes from hijacking named subagents', () => {
    const parentId = 'strict-parent-3003';
    const childAlpha = 'child-alpha-1';
    const childBeta = 'child-beta-2';
    const decoyConv = 'unrelated-decoy-9';
    writeChildDb(cliHome, childAlpha, 'Gemini 4 Flash');
    writeChildDb(cliHome, childBeta, 'Gemini 4 Carbon');
    writeChildDb(cliHome, decoyConv, 'Claude Opus 4.6');

    const logsDir = path.join(cliHome, 'brain', parentId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    // Transcript echoes an unrelated conversation_id inside tool output plus reverse-order subagent call
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'TOOL_RESULT', output: { conversation_id: decoyConv } }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Beta' }, result: { conversation_id: childBeta } }],
        }),
      ].join('\n'),
      'utf8',
    );

    const sumDb = new DatabaseSync(path.join(cliHome, 'conversation_summaries.db'));
    try {
      sumDb.exec(
        'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT, killed INTEGER)',
      );
      const ins = sumDb.prepare(
        'INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name, killed) VALUES (?, ?, ?, ?, ?)',
      );
      ins.run(childAlpha, parentId, 1, 'Alpha', 0);
      ins.run(childBeta, parentId, 1, 'Beta', 0);
    } finally {
      sumDb.close();
    }

    // Seed a malformed v3 cache for childBeta that looks structurally broken -> maxColdDbReads: 0 must NOT open SQLite
    const badCachePath = path.join(cliHome, 'cache', `agy_hud_telemetry_${childBeta}.json`);
    writeFileSync(badCachePath, JSON.stringify({ v: 3, versionTag: 'stale', rows: 'not-an-object' }), { mode: 0o600 });

    const agents: SnapshotAgent[] = [
      { name: 'Alpha', type: 'research', model: 'inherit', state: 'working', ts: 2000, ageLabel: '1s ago' },
      { name: 'Beta', type: 'research', model: 'inherit', state: 'working', ts: 1000, ageLabel: '2s ago' },
    ];
    const zeroBudget = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents,
      maxColdDbReads: 0,
    });
    assert.equal(zeroBudget.rollup, null, 'maxColdDbReads=0 must never open child SQLite on bad/stale cache');

    // Full snapshot attaches exact named models and ignores unrelated decoy conversation_id
    const full = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents,
    });
    assert.equal(full.agents.find((a) => a.name === 'Alpha')?.convId, childAlpha);
    assert.equal(full.agents.find((a) => a.name === 'Alpha')?.model, 'Gemini 4 Flash');
    assert.equal(full.agents.find((a) => a.name === 'Beta')?.convId, childBeta);
    assert.equal(full.agents.find((a) => a.name === 'Beta')?.model, 'Gemini 4 Carbon');
    assert.equal(
      full.agents.some((a) => a.convId === decoyConv),
      false,
    );
  });

  void it('disambiguates duplicate agent names by liveness, refuses indistinguishable swaps, and ignores non-authoritative transcript killed flags', () => {
    const parentId = 'dup-parent-4004';
    const oldConv = 'reviewer-old-1';
    const liveConv = 'reviewer-live-2';
    writeChildDb(cliHome, oldConv, 'Gemini 4 Flash');
    writeChildDb(cliHome, liveConv, 'Gemini 4 Carbon');

    const swarmDir = path.join(cliHome, 'brain', parentId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        members: {
          coordinator: { role: 'coordinator', conversation_id: parentId },
          Reviewer: { role: 'worker', conversation_id: liveConv, killed: false },
        },
      }),
      'utf8',
    );
    const sumDb = new DatabaseSync(path.join(cliHome, 'conversation_summaries.db'));
    try {
      sumDb.exec(
        'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT, killed INTEGER)',
      );
      const ins = sumDb.prepare(
        'INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name, killed) VALUES (?, ?, ?, ?, ?)',
      );
      ins.run(oldConv, parentId, 1, 'Reviewer', 1);
      ins.run(liveConv, parentId, 1, 'Reviewer', 0);
    } finally {
      sumDb.close();
    }
    const logsDir = path.join(cliHome, 'brain', parentId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    // Transcript falsely reports killed: true for the live worker -> must NOT poison settled cache
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'Reviewer' }, result: { conversation_id: liveConv }, killed: true },
        ],
      }),
      'utf8',
    );

    const mixedAgents: SnapshotAgent[] = [
      { name: 'Reviewer', type: 'worker', model: 'inherit', state: 'done', ts: 900, ageLabel: '2m ago' },
      { name: 'Reviewer', type: 'worker', model: 'inherit', state: 'working', ts: 1000, ageLabel: '1s ago' },
    ];
    const res = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents: mixedAgents,
    });
    assert.equal(res.agents[0]?.convId, oldConv);
    assert.equal(res.agents[0]?.model, 'Gemini 4 Flash');
    assert.equal(res.agents[1]?.convId, liveConv);
    assert.equal(res.agents[1]?.model, 'Gemini 4 Carbon');

    // Live worker's telemetry cache must NOT be marked settled: true because authoritative roster & summary DB say alive
    const liveCache = JSON.parse(
      readFileSync(path.join(cliHome, 'cache', `agy_hud_telemetry_${liveConv}.json`), 'utf8'),
    ) as { settled?: boolean };
    assert.notEqual(liveCache.settled, true);

    // Two indistinguishable working Reviewers must refuse blind mis-binding
    const ambiguous = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents: [
        { name: 'Reviewer', type: 'worker', model: 'inherit', state: 'working', ts: 1000, ageLabel: '1s ago' },
        { name: 'Reviewer', type: 'worker', model: 'inherit', state: 'working', ts: 1001, ageLabel: '1s ago' },
      ],
    });
    assert.equal(ambiguous.agents[0]?.convId, undefined);
    assert.equal(ambiguous.agents[1]?.convId, undefined);
  });

  void it('serves summary-DB-only subagents on maxColdDbReads=0 via cached links and zero child DB/WAL reads', () => {
    const parentId = 'cache-only-parent-5005';
    const childId = 'cache-only-child-6006';
    writeChildDb(cliHome, childId, 'Gemini 4 Carbon (High)');

    const sumDb = new DatabaseSync(path.join(cliHome, 'conversation_summaries.db'));
    try {
      sumDb.exec(
        'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT, killed INTEGER)',
      );
      sumDb
        .prepare(
          'INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name, killed) VALUES (?, ?, ?, ?, ?)',
        )
        .run(childId, parentId, 1, 'Auditor', 0);
    } finally {
      sumDb.close();
    }

    const agents: SnapshotAgent[] = [
      { name: 'Auditor', type: 'research', model: 'inherit', state: 'working', ts: 2000, ageLabel: '1s ago' },
    ];
    // Positive control: full snapshot reads summary DB + child DB and populates private caches
    const full = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents,
    });
    assert.equal(full.rollup?.measuredCount, 1);
    assert.equal(full.agents[0]?.model, 'Gemini 4 Carbon (High)');

    // Remove BOTH conversation_summaries.db and child .db -> HUD maxColdDbReads=0 must still serve cached rollup with zero DB access
    rmSync(path.join(cliHome, 'conversation_summaries.db'), { force: true });
    rmSync(path.join(cliHome, 'conversations', `${childId}.db`), { force: true });
    const hudHot = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents: [{ name: 'Auditor', type: 'research', model: 'inherit', state: 'working', ts: 2000, ageLabel: '1s ago' }],
      maxColdDbReads: 0,
    });
    assert.equal(hudHot.rollup?.measuredCount, 1);
    assert.equal(hudHot.agents[0]?.telemetry?.ctxUsed, 24_000);
    assert.equal(hudHot.agents[0]?.model, 'Gemini 4 Carbon (High)');
  });

  void it('bounds wide summary-DB subagent trees to prevent unbounded memory materialization', () => {
    const parentId = 'wide-parent-7007';
    const sumDb = new DatabaseSync(path.join(cliHome, 'conversation_summaries.db'));
    try {
      sumDb.exec(
        'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT, killed INTEGER)',
      );
      const ins = sumDb.prepare(
        'INSERT INTO conversation_summaries (conversation_id, parent_conversation_id, nesting_depth, agent_name, killed) VALUES (?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < 160; i += 1) {
        ins.run(`wide-child-${i}`, parentId, 1, `worker-${i}`, 0);
      }
    } finally {
      sumDb.close();
    }
    const res = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents: [{ name: 'worker-0', type: 'worker', model: 'inherit', state: 'working', ts: 1000, ageLabel: '1s ago' }],
      maxColdDbReads: 1,
    });
    const linkCache = JSON.parse(
      readFileSync(path.join(cliHome, 'cache', `agy_hud_subagents_${parentId}.json`), 'utf8'),
    ) as { links: unknown[] };
    assert.equal(linkCache.links.length, 128);
    assert.equal(res.agents.length, 1);
  });

  void it('prevents stale link cache from rebinding settled children on maxColdDbReads=0 and deletes stale cache on empty discovery', () => {
    const parentId = 'stale-link-parent-8008';
    const oldChild = 'settled-worker-1';
    const cacheDir = path.join(cliHome, 'cache');
    const linkCachePath = path.join(cacheDir, `agy_hud_subagents_${parentId}.json`);
    const telCachePath = path.join(cacheDir, `agy_hud_telemetry_${oldChild}.json`);
    writeFileSync(
      linkCachePath,
      JSON.stringify({ v: 1, links: [{ convId: oldChild, nameKey: 'worker', killed: false, authoritative: true }] }),
      { mode: 0o600 },
    );
    writeFileSync(
      telCachePath,
      JSON.stringify({
        v: 3,
        settled: true,
        rows: {
          '0': { in: 100, out: 50, cw: 0, cr: 900, ttft: 1, stream: 1, ctxUsed: 12_000, ctxMax: 512_000 },
        },
      }),
      { mode: 0o600 },
    );

    const activeAgent: SnapshotAgent[] = [
      { name: 'worker', type: 'worker', model: 'inherit', state: 'working', ts: 2000, ageLabel: '1s ago' },
    ];
    const hot = attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents: activeAgent,
      maxColdDbReads: 0,
    });
    assert.equal(hot.agents[0]?.convId, undefined);
    assert.equal(hot.rollup, null);

    // Full snapshot with zero summary/transcript children must delete the stale subagent link cache file
    attachSubagentTelemetryRollups({
      parentConvId: parentId,
      dataRoot: cliHome,
      cacheCliHome: cliHome,
      agents: activeAgent,
      maxColdDbReads: 1,
    });
    assert.equal(existsSync(linkCachePath), false);
  });
});
