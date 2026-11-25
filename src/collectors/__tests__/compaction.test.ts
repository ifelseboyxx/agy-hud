import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { formatContextCapacity } from '../../render/ansi.ts';
import type { StatusLineData } from '../../types.ts';
import { computeCompactedUsed, isCompactionActive, parseKvStepIdx } from '../compaction.ts';
import { loadSessionTelemetry, parseGenMetadataBlob } from '../telemetry.ts';

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

function encodeKv(key: string, val: string): number[] {
  const enc = new TextEncoder();
  return [...encodeFieldBytes(1, [...enc.encode(key)]), ...encodeFieldBytes(2, [...enc.encode(val)])];
}

function buildBlobWithStepIdx(opts: {
  inTok: number;
  outTok: number;
  crTok: number;
  ctxUsed: number;
  ctxMax: number;
  stepIdx?: number;
}): Uint8Array {
  const usage = [
    ...encodeFieldVarint(2, opts.inTok),
    ...encodeFieldVarint(3, opts.outTok),
    ...encodeFieldVarint(5, opts.crTok),
  ];
  const chatStart = encodeFieldBytes(10, [...encodeFieldVarint(1, opts.ctxUsed), ...encodeFieldVarint(4, opts.ctxMax)]);
  const chatModel: number[] = [
    ...encodeFieldBytes(4, usage),
    ...encodeFieldBytes(9, chatStart),
    ...encodeFieldBytes(20, encodeKv('other_key', 'ignored')),
  ];
  if (opts.stepIdx !== undefined) {
    chatModel.push(...encodeFieldBytes(20, encodeKv('last_step_index', String(opts.stepIdx))));
  }
  return new Uint8Array(encodeFieldBytes(1, chatModel));
}

void describe('post-compact telemetry detection', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-compact-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(path.join(cliHome, 'conversations'), { recursive: true });
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('decodes f20 last_step_index KV and activates post-compact override until next stepIdx advances', () => {
    assert.equal(parseKvStepIdx(new Uint8Array(encodeKv('last_step_index', '153'))), 153);
    assert.equal(parseKvStepIdx(new Uint8Array(encodeKv('unrelated', '999'))), null);

    const convId = 'compact-conv-1';
    const dbPath = path.join(cliHome, 'conversations', `${convId}.db`);
    const blob54 = buildBlobWithStepIdx({
      inTok: 12_000,
      outTok: 500,
      crTok: 260_000,
      ctxUsed: 251_000,
      ctxMax: 512_000,
      stepIdx: 153,
    });
    const decoded54 = parseGenMetadataBlob(blob54);
    assert.equal(decoded54?.stepIdx, 153);

    // Seed a stale v1 cache (missing v: 2) to verify automatic invalidation.
    const cacheFile = path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`);
    writeFileSync(cacheFile, JSON.stringify({ sig: [1, 1], rows: {} }), 'utf8');

    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(54, blob54);
      const summaryPayload = Buffer.alloc(16_000, 0x61);
      db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)').run(
        156,
        23,
        3,
        summaryPayload,
      );
    } finally {
      db.close();
    }

    const staleStdin: StatusLineData = {
      conversation_id: convId,
      context_window: { used_percentage: 52.5, context_window_size: 512_000 },
    };
    const compactedTel = loadSessionTelemetry(cliHome, staleStdin);
    assert.equal(compactedTel.compacted, true);
    // overhead = (12_000 + 260_000) - 251_000 = 21_000; 16_000 / 4 = 4_000 -> 25_000
    assert.equal(compactedTel.ctxUsed, 25_000);
    assert.ok(formatContextCapacity(staleStdin.context_window, compactedTel).includes('(~25k/512k)'));

    const cachedJson = JSON.parse(readFileSync(cacheFile, 'utf8')) as { v?: number; ckpt?: { idx?: number } };
    assert.equal(cachedJson.v, 2);
    assert.equal(cachedJson.ckpt?.idx, 156);

    // Next user turn adds gen_metadata row with stepIdx=157 > ckpt.idx=156.
    const blob55 = buildBlobWithStepIdx({
      inTok: 20_000,
      outTok: 350,
      crTok: 17_000,
      ctxUsed: 37_000,
      ctxMax: 512_000,
      stepIdx: 157,
    });
    const db2 = new DatabaseSync(dbPath);
    try {
      db2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(55, blob55);
    } finally {
      db2.close();
    }

    const resumedStdin: StatusLineData = {
      conversation_id: convId,
      context_window: { used_percentage: 7.2, context_window_size: 512_000 },
    };
    const resumedTel = loadSessionTelemetry(cliHome, resumedStdin);
    assert.equal(resumedTel.compacted, false);
    assert.equal(resumedTel.ctxUsed, 37_000);
    assert.equal(formatContextCapacity(resumedStdin.context_window, resumedTel).includes('~'), false);
  });

  void it('falls back to hasPostPlanner when stepIdx is unavailable and handles missing steps table', () => {
    assert.equal(
      isCompactionActive(
        [{ in: 100, out: 10, cw: 0, cr: 0, ttft: 1, stream: 1, ctxUsed: 80, ctxMax: 512_000, stepIdx: -1 }],
        { idx: 12, payloadLen: 800, hasPostPlanner: false },
      ),
      true,
    );
    assert.equal(
      isCompactionActive(
        [{ in: 100, out: 10, cw: 0, cr: 0, ttft: 1, stream: 1, ctxUsed: 80, ctxMax: 512_000, stepIdx: -1 }],
        { idx: 12, payloadLen: 800, hasPostPlanner: true },
      ),
      false,
    );
    assert.equal(computeCompactedUsed([], { idx: 1, payloadLen: 0, hasPostPlanner: false }), 1);

    const convId = 'no-steps-conv';
    const dbPath = path.join(cliHome, 'conversations', `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        0,
        buildBlobWithStepIdx({ inTok: 500, outTok: 50, crTok: 1500, ctxUsed: 2000, ctxMax: 512_000 }),
      );
    } finally {
      db.close();
    }
    const tel = loadSessionTelemetry(cliHome, { conversation_id: convId });
    assert.equal(tel.compacted, false);
    assert.equal(tel.ctxUsed, 2000);
  });
});
