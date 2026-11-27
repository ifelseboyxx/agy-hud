import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { formatRuntimeBadges } from '../../render/agents-render.ts';
import { formatTelemetryDiagnostics, stripAnsi, visibleLen } from '../../render/ansi.ts';
import { createEmptyStepTiming, updateStepTimingIncremental } from '../step-timing.ts';

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

function encodeTs(sec: number, nanos = 0): number[] {
  return [...encodeFieldVarint(1, sec), ...(nanos > 0 ? encodeFieldVarint(2, nanos) : [])];
}

function encodeStepMeta(fields: { t1?: number; t7?: number; t8?: number; t32?: number }): Uint8Array {
  const out: number[] = [];
  if (fields.t1 !== undefined) out.push(...encodeFieldBytes(1, encodeTs(fields.t1)));
  if (fields.t7 !== undefined) out.push(...encodeFieldBytes(7, encodeTs(fields.t7)));
  if (fields.t8 !== undefined) out.push(...encodeFieldBytes(8, encodeTs(fields.t8)));
  if (fields.t32 !== undefined) out.push(...encodeFieldBytes(32, encodeTs(fields.t32)));
  return new Uint8Array(out);
}

void describe('incremental step timing, Turn Phase badges, and Diagnostics formatting', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-timing-'));
  });

  afterEach(() => {
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('merges planner [t1,t7], checkpoint [t32,t8], and overlapping parallel tool [t32,t8] intervals while stopping before in-flight steps', () => {
    const dbPath = path.join(tmpRoot, 'timing.db');
    mkdirSync(tmpRoot, { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)');
      const insert = db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)');
      // Planner step 1: [1000, 1012] -> 12s Model Time (even though t32=1012, t8=1012)
      insert.run(1, 15, 3, encodeStepMeta({ t1: 1000, t7: 1012, t8: 1012, t32: 1012 }));
      // Two overlapping parallel tool steps (approval wait t7=1012..t32=1020 excluded!):
      // Tool 2: [1020, 1030], Tool 3: [1025, 1038] -> merged [1020, 1038] = 18s Tool Time
      insert.run(2, 132, 3, encodeStepMeta({ t1: 1012, t7: 1012, t32: 1020, t8: 1030 }));
      insert.run(3, 132, 3, encodeStepMeta({ t1: 1012, t7: 1012, t32: 1025, t8: 1038 }));
      // Checkpoint step 4: [1040, 1045] -> +5s Model Time (total 17s)
      insert.run(4, 23, 3, encodeStepMeta({ t1: 1039, t32: 1040, t8: 1045 }));
      // In-flight tool step 5 (RUNNING = 2) -> cursor must stop at 4 and report tailStepPhase = 'tool_use'
      insert.run(5, 132, 2, encodeStepMeta({ t1: 1045, t32: 1046 }));

      const pass1 = updateStepTimingIncremental(db, createEmptyStepTiming());
      assert.equal(pass1.stepTiming.cursorIdx, 4);
      assert.equal(pass1.stepTiming.modelSec, 17);
      assert.equal(pass1.stepTiming.toolSec, 18);
      assert.equal(pass1.tailStepPhase, 'tool_use');

      // Complete step 5 at [1046, 1052] (+6s tool time -> 24s) and add GENERATING planner step 6
      db.prepare('UPDATE steps SET status = 3, metadata = ? WHERE idx = 5').run(
        encodeStepMeta({ t1: 1045, t32: 1046, t8: 1052 }),
      );
      insert.run(6, 15, 8, encodeStepMeta({ t1: 1053 }));

      const pass2 = updateStepTimingIncremental(db, pass1.stepTiming);
      assert.equal(pass2.stepTiming.cursorIdx, 5);
      assert.equal(pass2.stepTiming.modelSec, 17);
      assert.equal(pass2.stepTiming.toolSec, 24);
      assert.equal(pass2.tailStepPhase, 'working');

      // Out-of-order timestamps spanning two earlier buckets must recompute cleanly to exact union (no double-count)
      const oooDb = new DatabaseSync(path.join(tmpRoot, 'ooo.db'));
      try {
        oooDb.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)');
        const insOoo = oooDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)');
        insOoo.run(1, 15, 3, encodeStepMeta({ t1: 10, t7: 20 }));
        insOoo.run(2, 15, 3, encodeStepMeta({ t1: 30, t7: 40 }));
        const firstPass = updateStepTimingIncremental(oooDb, createEmptyStepTiming());
        assert.equal(firstPass.stepTiming.modelSec, 20);

        insOoo.run(3, 15, 3, encodeStepMeta({ t1: 15, t7: 35 }));
        const incremental = updateStepTimingIncremental(oooDb, firstPass.stepTiming);
        const full = updateStepTimingIncremental(oooDb, createEmptyStepTiming());
        assert.equal(incremental.stepTiming.modelSec, 30);
        assert.equal(incremental.stepTiming.modelSec, full.stepTiming.modelSec);
      } finally {
        oooDb.close();
      }
    } finally {
      db.close();
    }
  });

  void it('emits de-duplicated Turn Phase, transient Retry, and Error badges on statusLine without noisy working badges', () => {
    // Active working/tool_use/idle emit zero Turn Phase text badges
    assert.deepEqual(formatRuntimeBadges({ agent_state: 'working' }), []);
    assert.deepEqual(formatRuntimeBadges({ agent_state: 'tool_use' }), []);
    assert.deepEqual(formatRuntimeBadges({ agent_state: 'idle' }), []);

    // Blocker cues: ! Auth, Review (suppressed when ! Approval is active)
    assert.deepEqual(formatRuntimeBadges({ agent_state: 'authenticating' }).map(stripAnsi), ['! Auth']);
    assert.deepEqual(formatRuntimeBadges({ agent_state: 'reviewing' }).map(stripAnsi), ['Review']);
    assert.deepEqual(
      formatRuntimeBadges({ agent_state: 'reviewing', tool_confirmation_pending: true }).map(stripAnsi),
      ['! Approval'],
    );

    // Transient Retry badge <= 15 cols when latest completed turn succeeded with retries > 0
    const retryBadges = formatRuntimeBadges(
      { agent_state: 'idle' },
      {
        telemetry: {
          genCount: 2,
          tps: 80,
          ttft: 1.5,
          cachePct: 90,
          ctxUsed: 20_000,
          ctxMax: 512_000,
          lastRetries: 2,
          lastRetryReason: 'rate-limit',
          lastErrorCode: null,
        },
      },
    );
    assert.deepEqual(retryBadges.map(stripAnsi), ['Retry ×2 429']);
    assert.ok(visibleLen(retryBadges[0] ?? '') <= 15);

    // Error badge appears on idle/error and clears immediately once agent_state enters working
    const errBadges = formatRuntimeBadges(
      { agent_state: 'idle' },
      {
        telemetry: {
          genCount: 2,
          tps: 80,
          ttft: 1.5,
          cachePct: 90,
          ctxUsed: 20_000,
          ctxMax: 512_000,
          lastErrorCode: 'unavailable',
          lastRetries: 0,
        },
      },
    );
    assert.deepEqual(errBadges.map(stripAnsi), ['! Error 503']);

    const clearedOnWorking = formatRuntimeBadges(
      { agent_state: 'working' },
      {
        telemetry: {
          genCount: 2,
          tps: 80,
          ttft: 1.5,
          cachePct: 90,
          ctxUsed: 20_000,
          ctxMax: 512_000,
          lastErrorCode: 'unavailable',
          lastRetries: 0,
        },
      },
    );
    assert.deepEqual(clearedOnWorking, []);
  });

  void it('formats conditional Diagnostics summary only when retryCount > 0 or errorCount > 0', () => {
    assert.equal(
      formatTelemetryDiagnostics({
        genCount: 3,
        tps: 90,
        ttft: 1.2,
        cachePct: 90,
        ctxUsed: 30_000,
        ctxMax: 512_000,
        retryCount: 0,
        errorCount: 0,
      }),
      '',
    );

    const diag = formatTelemetryDiagnostics({
      genCount: 3,
      tps: 90,
      ttft: 1.2,
      cachePct: 90,
      ctxUsed: 30_000,
      ctxMax: 512_000,
      retryCount: 3,
      retryWaitSec: 6.2,
      retryReasons: { eof: 2, 'rate-limit': 1 },
      errorCount: 1,
      errorReasons: { unavailable: 1 },
    });
    assert.equal(diag, 'Retries ×3 (wait 6.2s: eof ×2, rate-limit ×1) · Errors ×1 (unavailable ×1)');
  });
});
