import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runHudRender as renderHudLines } from '../../hud-runner.ts';
import type { StatusLineData } from '../../types.ts';
import { sweepStaleSnapshotFiles } from '../snapshot-cache-sweep.ts';
import { readSnapshotEnvelope, writeSnapshotEnvelope } from '../snapshot-envelope.ts';
import { loadSessionTelemetryFromRoot } from '../telemetry.ts';

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

function buildGenBlob(opts: {
  inTok: number;
  outTok: number;
  crTok: number;
  ctxUsed: number;
  ctxMax: number;
}): Uint8Array {
  const usage = [
    ...encodeFieldVarint(2, opts.inTok),
    ...encodeFieldVarint(3, opts.outTok),
    ...encodeFieldVarint(5, opts.crTok),
  ];
  const ctxWin = [...encodeFieldVarint(1, opts.ctxUsed), ...encodeFieldVarint(4, opts.ctxMax)];
  const chatStart = encodeFieldBytes(10, ctxWin);
  const ttft = [...encodeFieldVarint(1, 1), ...encodeFieldVarint(2, 500_000_000)];
  const stream = [...encodeFieldVarint(1, 2), ...encodeFieldVarint(2, 0)];
  const chatModel = [
    ...encodeFieldBytes(4, usage),
    ...encodeFieldBytes(9, chatStart),
    ...encodeFieldBytes(11, ttft),
    ...encodeFieldBytes(12, stream),
  ];
  return new Uint8Array(encodeFieldBytes(1, chatModel));
}

void describe('session-index envelopes and read-only telemetry', () => {
  let tmpRoot = '';
  let cliHome = '';
  let roCliRoot = '';
  const chmodRestore: string[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-session-index-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    roCliRoot = path.join(tmpRoot, 'ro-cli-root');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(roCliRoot, { recursive: true });
  });

  afterEach(() => {
    for (const dir of chmodRestore.reverse()) {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // Ignore cleanup errors.
      }
    }
    chmodRestore.length = 0;
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('writes and reads v2 metadata envelope atomically while preserving prior mdDigest', () => {
    const data: StatusLineData = {
      conversation_id: 'aaaa1111-bbbb-2222-cccc-333344445555',
      conversation_title: 'Test Session Title',
      cwd: '/tmp/ws',
      workspace: { current_dir: '/tmp/ws/sub', project_dir: '/tmp/ws' },
      subagents: [{ name: 'worker-1', status: 'running' }],
      task_count: 3,
    };

    const written1 = writeSnapshotEnvelope(cliHome, data, 4242, {
      mdDigest: 'ino:100:200:agents',
      nowMs: 1_700_000_000_000,
    });
    assert.ok(written1 !== null);
    assert.equal(written1.v, 2);
    assert.equal(written1.convId, 'aaaa1111-bbbb-2222-cccc-333344445555');
    assert.equal(written1.conversationTitle, 'Test Session Title');
    assert.equal(written1.agyPid, 4242);
    assert.equal(written1.cwd, '/tmp/ws');
    assert.equal(written1.workspaceCurrentDir, '/tmp/ws/sub');
    assert.equal(written1.workspaceProjectDir, '/tmp/ws');
    assert.equal(written1.subagents.length, 1);
    assert.equal(written1.taskCount, 3);
    assert.equal(written1.mdDigest, 'ino:100:200:agents');
    assert.equal(written1.updatedAtMs, 1_700_000_000_000);

    const written2 = writeSnapshotEnvelope(cliHome, { ...data, task_count: 4 }, 4242, { nowMs: 1_700_000_005_000 });
    assert.ok(written2 !== null);
    assert.equal(written2.taskCount, 4);
    assert.equal(written2.mdDigest, 'ino:100:200:agents');

    const loaded = readSnapshotEnvelope(cliHome, 'aaaa1111-bbbb-2222-cccc-333344445555');
    assert.deepEqual(loaded, written2);
  });

  void it('blocks unsafe conversation IDs and symlinked snapshot cache files', () => {
    assert.equal(writeSnapshotEnvelope(cliHome, { conversation_id: '../escape' }, 1234), null);
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    const escapedTarget = path.join(tmpRoot, 'escaped-envelope.json');
    symlinkSync(escapedTarget, path.join(cliHome, 'cache', 'agy_hud_snapshot_safe-id.json'));
    assert.equal(writeSnapshotEnvelope(cliHome, { conversation_id: 'safe-id' }, 1234), null);
    assert.equal(existsSync(escapedTarget), false);
  });

  void it('sweeps expired snapshot json and md files older than 7 days while keeping fresh ones', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const nowMs = 1_700_000_000_000;
    const oldSec = (nowMs - 8 * 86_400_000) / 1000;
    const freshSec = (nowMs - 2 * 86_400_000) / 1000;

    const oldJson = path.join(cacheDir, 'agy_hud_snapshot_old-1.json');
    const oldMd = path.join(cacheDir, 'agy_hud_snapshot_old-1.md');
    const oldActivity = path.join(cacheDir, 'agy_hud_activity_old-1.json');
    const oldActivitySnap = path.join(cacheDir, 'agy_hud_activity_snapshot_old-1.json');
    const oldTelemetry = path.join(cacheDir, 'agy_hud_telemetry_old-1.json');
    const oldPid = path.join(cacheDir, 'agy_hud_pid_99999.json');
    const freshJson = path.join(cacheDir, 'agy_hud_snapshot_fresh-1.json');
    const otherFile = path.join(cacheDir, 'agy_hud_proc.json');

    for (const f of [oldJson, oldMd, oldActivity, oldActivitySnap, oldTelemetry, oldPid, freshJson, otherFile]) {
      writeFileSync(f, '{}', 'utf8');
    }
    for (const f of [oldJson, oldMd, oldActivity, oldActivitySnap, oldTelemetry, oldPid, otherFile]) {
      utimesSync(f, oldSec, oldSec);
    }
    utimesSync(freshJson, freshSec, freshSec);

    const removed = sweepStaleSnapshotFiles(cliHome, nowMs);
    assert.equal(removed, 6);
    assert.equal(existsSync(oldJson), false);
    assert.equal(existsSync(oldMd), false);
    assert.equal(existsSync(oldActivity), false);
    assert.equal(existsSync(oldActivitySnap), false);
    assert.equal(existsSync(oldTelemetry), false);
    assert.equal(existsSync(oldPid), false);
    assert.equal(existsSync(freshJson), true);
    assert.equal(existsSync(otherFile), true);
  });

  void it('skips rewriting snapshot envelope when semantic payload is unchanged within heartbeat window', () => {
    const convId = 'throttle-env-1234';
    const data: StatusLineData = {
      conversation_id: convId,
      conversation_title: 'Steady Session',
      cwd: '/tmp/ws',
      task_count: 1,
    };
    const t0 = 1_700_000_000_000;
    writeSnapshotEnvelope(cliHome, data, 4242, { nowMs: t0 });
    const envPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`);
    const sentinel = new Date(1_690_000_000_000);
    utimesSync(envPath, sentinel, sentinel);

    const skipped = writeSnapshotEnvelope(cliHome, data, 4242, { nowMs: t0 + 300 });
    assert.equal(skipped?.updatedAtMs, t0);
    assert.equal(skipped?.heartbeatAtMs, t0);
    assert.equal(Math.trunc(statSync(envPath).mtimeMs), 1_690_000_000_000);

    const refreshed = writeSnapshotEnvelope(cliHome, data, 4242, { nowMs: t0 + 35_000 });
    assert.equal(refreshed?.updatedAtMs, t0);
    assert.equal(refreshed?.heartbeatAtMs, t0 + 35_000);
    assert.notEqual(Math.trunc(statSync(envPath).mtimeMs), 1_690_000_000_000);

    const semanticChanged = writeSnapshotEnvelope(cliHome, { ...data, task_count: 2 }, 4242, { nowMs: t0 + 36_000 });
    assert.equal(semanticChanged?.updatedAtMs, t0 + 36_000);
    assert.equal(semanticChanged?.heartbeatAtMs, t0 + 36_000);
  });

  void it('writes snapshot metadata envelope automatically during renderHudLines', () => {
    const convId = 'render-env-1234';
    renderHudLines(
      cliHome,
      {
        conversation_id: convId,
        conversation_title: 'HUD Rendered Session',
        cwd: tmpRoot,
        workspace: { current_dir: tmpRoot, project_dir: tmpRoot },
        model: { display_name: 'Gemini 4 Carbon' },
        task_count: 2,
      },
      {
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
        activity: null,
        todos: null,
        bypass: false,
        cliMode: '',
        branch: 'main',
      },
    );

    const env = readSnapshotEnvelope(cliHome, convId);
    assert.ok(env !== null);
    assert.equal(env.convId, convId);
    assert.equal(env.conversationTitle, 'HUD Rendered Session');
    assert.equal(env.taskCount, 2);
  });

  void it('loads telemetry strictly read-only from 0o555 root and caches only in cacheCliHome', () => {
    const convId = 'cli-tel-1111';
    const convDir = path.join(roCliRoot, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      buildGenBlob({ inTok: 1000, outTok: 200, crTok: 3000, ctxUsed: 40_000, ctxMax: 1_000_000 }),
    );
    db.close();

    const beforeRoEntries = readdirSync(roCliRoot).sort();
    const beforeConvEntries = readdirSync(convDir).sort();
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(convDir, 0o555);
      chmodSync(roCliRoot, 0o555);
      chmodRestore.push(roCliRoot, convDir);
    }

    const tel = loadSessionTelemetryFromRoot(roCliRoot, cliHome, convId);
    assert.equal(tel.genCount, 1);
    assert.equal(tel.ctxUsed, 40_000);
    assert.equal(tel.ctxMax, 1_000_000);
    assert.equal(tel.tps, 100);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`)), true);
    assert.equal(existsSync(path.join(roCliRoot, 'cache')), false);
    assert.deepEqual(readdirSync(roCliRoot).sort(), beforeRoEntries);
    assert.deepEqual(readdirSync(convDir).sort(), beforeConvEntries);
  });
});
