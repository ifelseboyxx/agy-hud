import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FileLockTimeoutError, withFileLocksSync } from '../../core/file-lock.ts';
import { buildPresetConfig } from '../../core/hud-config.ts';
import { runHudRender } from '../../hud-runner.ts';
import { resolveSession } from '../session-index.ts';
import { sweepStaleSnapshotFiles } from '../snapshot-cache-sweep.ts';
import { parseEnvelopeRecord } from '../snapshot-envelope-codec.ts';
import { readSnapshotEnvelope, writeSnapshotEnvelope } from '../snapshot-envelope.ts';
import { readActivePidMarker, resolveLivePidOwners } from '../snapshot-pid-marker.ts';

void describe('snapshot envelope ownership and bounds', () => {
  let tmpRoot = '';
  let cliHome = '';
  let wsDir = '';
  let otherDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-env-edge-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    wsDir = path.join(tmpRoot, 'ws');
    otherDir = path.join(tmpRoot, 'other');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('transfers Tier-1 ownership to a new conversation after missing-marker heartbeats', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8101;
    const convA = 'cli-nomk-a-1111';
    const convB = 'cli-nomk-b-2222';
    const markerPath = path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`);

    writeSnapshotEnvelope(cliHome, { conversation_id: convA, conversation_title: 'A', cwd: wsDir }, sharedPid, {
      nowMs: t0,
    });
    rmSync(markerPath, { force: true });
    writeSnapshotEnvelope(cliHome, { conversation_id: convA, conversation_title: 'A', cwd: wsDir }, sharedPid, {
      nowMs: t0 + 31_000,
    });
    rmSync(markerPath, { force: true });
    writeSnapshotEnvelope(cliHome, { conversation_id: convB, conversation_title: 'B', cwd: wsDir }, sharedPid, {
      nowMs: t0 + 32_000,
    });

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 + 33_000,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convB);
  });

  void it('transfers Tier-1 ownership to a new conversation when marker is deleted after multi-switch sequence', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8102;
    const convA = 'cli-seq-a-1111';
    const convB = 'cli-seq-b-2222';
    const convC = 'cli-seq-c-3333';
    const markerPath = path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`);

    writeSnapshotEnvelope(cliHome, { conversation_id: convA, conversation_title: 'A', cwd: wsDir }, sharedPid, {
      nowMs: t0,
    });
    writeSnapshotEnvelope(cliHome, { conversation_id: convB, conversation_title: 'B', cwd: wsDir }, sharedPid, {
      nowMs: t0 + 1_000,
    });
    writeSnapshotEnvelope(cliHome, { conversation_id: convA, conversation_title: 'A', cwd: wsDir }, sharedPid, {
      nowMs: t0 + 2_000,
    });
    rmSync(markerPath, { force: true });
    writeSnapshotEnvelope(cliHome, { conversation_id: convC, conversation_title: 'C', cwd: wsDir }, sharedPid, {
      nowMs: t0 + 3_000,
    });

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 + 4_000,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convC);
  });

  void it('bypasses 30s throttle once when an outranked conversation resumes after marker loss', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8103;
    const convA = 'cli-resume-a-1111';
    const convB = 'cli-resume-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'B', cwd: wsDir };
    const markerPath = path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`);
    const envAPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convA}.json`);

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 + 1_000 });
    rmSync(markerPath, { force: true });

    const resumed = writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 + 2_000 });
    assert.equal(resumed?.heartbeatAtMs, t0 + 2_000);

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 + 2_500,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convA);

    const sentinel = new Date(1_690_000_000_000);
    utimesSync(envAPath, sentinel, sentinel);
    rmSync(markerPath, { force: true });
    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 + 2_600 });
    assert.equal(Math.trunc(statSync(envAPath).mtimeMs), 1_690_000_000_000);
  });

  void it('restores a missing PID marker during a throttled write without rewriting the envelope', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8106;
    const convA = 'cli-restore-mk-a';
    const dataA = { conversation_id: convA, conversation_title: 'A', cwd: wsDir };
    const markerPath = path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`);
    const envAPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convA}.json`);

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    const sentinel = new Date(1_690_000_000_000);
    utimesSync(envAPath, sentinel, sentinel);
    rmSync(markerPath, { force: true });

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 + 1_000 });
    assert.equal(Math.trunc(statSync(envAPath).mtimeMs), 1_690_000_000_000);
    assert.equal(readActivePidMarker(cliHome, sharedPid, t0 + 1_000)?.convId, convA);
  });

  void it('rejects non-integer agyPid in parseEnvelopeRecord instead of truncating to PID 1', () => {
    assert.equal(
      parseEnvelopeRecord({
        v: 1,
        convId: 'conv-legacy-v1',
        agyPid: null,
        updatedAtMs: 1_000,
        heartbeatAtMs: 1_000,
      }),
      null,
    );
    const parsed = parseEnvelopeRecord({
      v: 2,
      convId: 'conv-float-pid',
      agyPid: 1.9,
      updatedAtMs: 1_000,
      heartbeatAtMs: 1_000,
    });
    assert.ok(parsed !== null);
    assert.equal(parsed.agyPid, null);
  });

  void it('ignores far-future heartbeat envelopes during live PID owner resolution', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8104;
    const legit = writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'conv-legit-1111', conversation_title: 'Legit', cwd: wsDir },
      sharedPid,
      { nowMs: t0 },
    );
    assert.ok(legit !== null);
    rmSync(path.join(cliHome, 'cache', `agy_hud_pid_${sharedPid}.json`), { force: true });

    const spoofed = parseEnvelopeRecord({
      v: 2,
      convId: 'conv-spoof-2222',
      agyPid: sharedPid,
      updatedAtMs: Number.MAX_SAFE_INTEGER,
      heartbeatAtMs: Number.MAX_SAFE_INTEGER,
      pidSwitchSeq: 99,
    });
    assert.ok(spoofed !== null);

    const owners = resolveLivePidOwners(
      cliHome,
      [
        { convId: 'conv-legit-1111', envelope: legit },
        { convId: 'conv-spoof-2222', envelope: spoofed },
      ],
      t0 + 1_000,
      (pid) => pid === sharedPid,
    );
    assert.equal(owners.get(sharedPid), 'conv-legit-1111');
  });

  void it('ignores FIFO and outside symlink entries during PID recovery scan without blocking', () => {
    if (process.platform === 'win32') return;
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8105;
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const fifoPath = path.join(cacheDir, 'agy_hud_snapshot_fifo-trap.json');
    execFileSync('mkfifo', [fifoPath]);

    const outsideJson = path.join(tmpRoot, 'outside-envelope.json');
    writeFileSync(
      outsideJson,
      JSON.stringify({
        v: 2,
        convId: 'sym-trap',
        agyPid: sharedPid,
        updatedAtMs: t0,
        heartbeatAtMs: t0,
        pidSwitchSeq: 500,
      }),
      'utf8',
    );
    symlinkSync(outsideJson, path.join(cacheDir, 'agy_hud_snapshot_sym-trap.json'));

    const written = writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'conv-safe-f07', conversation_title: 'Safe', cwd: wsDir },
      sharedPid,
      { nowMs: t0 + 1_000 },
    );
    assert.ok(written !== null);
    assert.equal(written.pidSwitchSeq, 1);
  });

  void it('leaves expired lock files untouched during TTL sweep while removing expired cache data', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const nowMs = Date.parse('2026-06-15T12:00:00Z');
    const oldSec = (nowMs - 8 * 86_400_000) / 1000;
    const pidLock = path.join(cacheDir, '.agy_hud_pid_8199.lock');
    const snapLock = path.join(cacheDir, '.agy_hud_snapshot_old-lock.lock');
    const expiredJson = path.join(cacheDir, 'agy_hud_snapshot_old-lock.json');

    writeFileSync(pidLock, `${JSON.stringify({ pid: 999_999_999, token: 'dead', lockPath: pidLock })}\n`, 'utf8');
    writeFileSync(snapLock, `${JSON.stringify({ pid: 999_999_999, token: 'dead', lockPath: snapLock })}\n`, 'utf8');
    writeFileSync(expiredJson, '{}', 'utf8');
    utimesSync(pidLock, oldSec, oldSec);
    utimesSync(snapLock, oldSec, oldSec);
    utimesSync(expiredJson, oldSec, oldSec);

    assert.equal(sweepStaleSnapshotFiles(cliHome, nowMs), 1);
    assert.equal(existsSync(expiredJson), false);
    assert.equal(existsSync(pidLock), true);
    assert.equal(existsSync(snapLock), true);
  });

  void it('preserves an active reclaimed PID lock during TTL sweep so concurrent acquirers block', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const nowMs = Date.parse('2026-06-15T12:00:00Z');
    const oldSec = (nowMs - 8 * 86_400_000) / 1000;
    const pidLock = path.join(cacheDir, '.agy_hud_pid_8200.lock');

    writeFileSync(pidLock, `${JSON.stringify({ pid: 999_999_999, token: 'dead', lockPath: pidLock })}\n`, 'utf8');
    utimesSync(pidLock, oldSec, oldSec);

    withFileLocksSync(
      [pidLock],
      () => {
        utimesSync(pidLock, oldSec, oldSec);
        assert.equal(sweepStaleSnapshotFiles(cliHome, nowMs), 0);
        assert.equal(existsSync(pidLock), true);
        assert.throws(() => withFileLocksSync([pidLock], () => undefined, 20), FileLockTimeoutError);
      },
      1_000,
    );
  });

  void it('prevents a late HUD frame from reclaiming Tier-1 PID ownership after another session switched', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8201;
    const convA = 'cli-late-a-1111';
    const convB = 'cli-late-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'Session A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'Session B', cwd: wsDir };

    const initialA = writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    assert.ok(initialA !== null);
    const baselineMarkerA = readActivePidMarker(cliHome, sharedPid, t0 + 1_000);
    assert.equal(baselineMarkerA?.convId, convA);

    // Session B switches in the same PID and commits while frame A is delayed.
    const switchedB = writeSnapshotEnvelope(cliHome, dataB, sharedPid, {
      nowMs: t0 + 1_050,
      baselineEnvelope: null,
      baselinePidMarker: baselineMarkerA,
      rejectSuperseded: true,
    });
    assert.equal(switchedB?.pidSwitchSeq, 2);

    // Late frame A resumes and commits with its frame-start baseline.
    writeSnapshotEnvelope(cliHome, { ...dataA, conversation_title: 'Session A Late' }, sharedPid, {
      nowMs: t0 + 1_000,
      baselineEnvelope: initialA,
      baselinePidMarker: baselineMarkerA,
      rejectSuperseded: true,
    });

    const markerAfter = readActivePidMarker(cliHome, sharedPid, t0 + 1_100);
    assert.equal(markerAfter?.convId, convB);
    assert.equal(markerAfter?.switchSeq, 2);
    assert.equal(readSnapshotEnvelope(cliHome, convA)?.pidSwitchSeq, 1);

    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: t0 + 1_100,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convB);
  });

  void it('allows genuine same-millisecond switch back when the new frame observed the latest PID marker', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8202;
    const convA = 'cli-samems-a-1111';
    const convB = 'cli-samems-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'B', cwd: wsDir };

    const envA = writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 });
    const markerB = readActivePidMarker(cliHome, sharedPid, t0);
    assert.equal(markerB?.convId, convB);

    const switchedBack = writeSnapshotEnvelope(cliHome, dataA, sharedPid, {
      nowMs: t0,
      baselineEnvelope: envA,
      baselinePidMarker: markerB,
      rejectSuperseded: true,
    });
    assert.equal(switchedBack?.pidSwitchSeq, 3);
    assert.equal(readActivePidMarker(cliHome, sharedPid, t0)?.convId, convA);
  });

  void it('allows genuine session switch under clock rollback when the frame observed the current PID marker', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8203;
    const convA = 'cli-rollback-a-1111';
    const convB = 'cli-rollback-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'B', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 });
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, { nowMs: t0 + 5_000 });
    const markerB = readActivePidMarker(cliHome, sharedPid, t0 + 4_000);
    assert.equal(markerB?.convId, convB);

    // Clock stepped back 1s, user genuinely switched back to A.
    const switchedBack = writeSnapshotEnvelope(cliHome, dataA, sharedPid, {
      nowMs: t0 + 4_000,
      baselineEnvelope: readSnapshotEnvelope(cliHome, convA),
      baselinePidMarker: markerB,
      rejectSuperseded: true,
    });
    assert.equal(switchedBack?.pidSwitchSeq, 3);
    assert.equal(readActivePidMarker(cliHome, sharedPid, t0 + 4_000)?.convId, convA);
  });

  void it('allows switching back to A after clock rollback even when A had a pre-rollback envelope timestamp', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8205;
    const convA = 'cli-rbback-a-1111';
    const convB = 'cli-rbback-b-2222';
    const dataA = { conversation_id: convA, conversation_title: 'A', cwd: wsDir };
    const dataB = { conversation_id: convB, conversation_title: 'B', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, dataA, sharedPid, { nowMs: t0 + 5_000 });
    const markerA = readActivePidMarker(cliHome, sharedPid, t0 + 4_000);
    writeSnapshotEnvelope(cliHome, dataB, sharedPid, {
      nowMs: t0 + 4_000,
      baselineEnvelope: null,
      baselinePidMarker: markerA,
      rejectSuperseded: true,
    });
    const markerB = readActivePidMarker(cliHome, sharedPid, t0 + 4_100);
    assert.equal(markerB?.convId, convB);

    const switchedBack = writeSnapshotEnvelope(cliHome, dataA, sharedPid, {
      nowMs: t0 + 4_100,
      baselineEnvelope: readSnapshotEnvelope(cliHome, convA),
      baselinePidMarker: markerB,
      rejectSuperseded: true,
    });
    assert.equal(switchedBack?.pidSwitchSeq, 3);
    assert.equal(readActivePidMarker(cliHome, sharedPid, t0 + 4_100)?.convId, convA);
  });

  void it('preserves switched Tier-1 PID ownership when an older runHudRender finishes after a newer session frame', () => {
    const baseSec = Math.floor(Date.parse('2026-06-01T12:00:00Z') / 1000);
    const sharedPid = 8204;
    const convA = 'cli-hud-race-a-1111';
    const convB = 'cli-hud-race-b-2222';
    const hudConfig = buildPresetConfig('compact');
    const emptyTelemetry = { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null };
    const emptyAgents = { kind: 'agents' as const, working: 0, waiting: 0, alive: 0, total: 0, entries: [] };

    writeSnapshotEnvelope(cliHome, { conversation_id: convA, conversation_title: 'A0', cwd: wsDir }, sharedPid, {
      nowMs: baseSec * 1000,
    });

    runHudRender(
      cliHome,
      { conversation_id: convA, conversation_title: 'A Delayed', cwd: wsDir, terminal_width: 120 },
      {
        hudConfig,
        agyPid: sharedPid,
        nowSec: baseSec + 1,
        cliSettings: {},
        telemetry: emptyTelemetry,
        agentsSummary: emptyAgents,
        todos: null,
        collectors: {
          loadTranscriptActivity: () => {
            runHudRender(
              cliHome,
              { conversation_id: convB, conversation_title: 'B Switched', cwd: wsDir, terminal_width: 120 },
              {
                hudConfig,
                agyPid: sharedPid,
                nowSec: baseSec + 2,
                cliSettings: {},
                telemetry: emptyTelemetry,
                activity: { tools: [], skills: [], mcps: [], agents: [] },
                agentsSummary: emptyAgents,
                todos: null,
              },
            );
            return { tools: [], skills: [], mcps: [], agents: [] };
          },
        },
      },
    );

    const marker = readActivePidMarker(cliHome, sharedPid, (baseSec + 3) * 1000);
    assert.equal(marker?.convId, convB);
    assert.equal(marker?.switchSeq, 2);
    const resolved = resolveSession({
      cliHome,
      cwd: otherDir,
      callerAgyPid: sharedPid,
      nowMs: (baseSec + 3) * 1000,
      isAlive: (pid) => pid === sharedPid,
    });
    assert.equal(resolved.tier, 'pid');
    assert.equal(resolved.session.convId, convB);
  });
});
