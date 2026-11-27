import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DEFAULT_MAX_REGULAR_JSON_BYTES } from '../../fs-utils.ts';
import { materializeSnapshotMarkdownIfNeeded } from '../../hud-snapshot-publish.ts';
import { resolveSnapshotMarkdownUri } from '../../render/osc8.ts';
import {
  readActivePidMarker,
  readSnapshotEnvelope,
  sweepStaleSnapshotFiles,
  writeSnapshotEnvelope,
} from '../snapshot-envelope.ts';

void describe('snapshot-envelope temp cleanup, rollback exemption, and size budget', () => {
  let tmpRoot = '';
  let cliHome = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-env-harden-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    wsDir = path.join(tmpRoot, 'ws');
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('removes crashed .tmp cache orphans older than 1 hour during sweepStaleSnapshotFiles', () => {
    const cacheDir = path.join(cliHome, 'cache');
    const nowMs = Date.parse('2026-06-15T12:00:00Z');
    const twoHoursAgoSec = (nowMs - 2 * 60 * 60 * 1000) / 1000;
    const orphans = [
      'agy_hud_snapshot_dead.json.tmp.1234.1700000000000.0123456789abcdef',
      'agy_hud_snapshot_dead.md.tmp.1234.1700000000000.0123456789abcdef',
      'agy_hud_telemetry_dead.json.tmp.1234.1700000000000.fedcba9876543210',
      'agy_hud_proc.json.tmp.1234.1700000000000.0011223344556677',
      'agy_hud_sessions.json.tmp.1234.1700000000000.8899aabbccddeeff',
      'agy-hud-statusline-backup.json.tmp.1234.1700000000000.1122334455667788',
    ];
    for (const name of orphans) {
      const fullPath = path.join(cacheDir, name);
      writeFileSync(fullPath, '{}', 'utf8');
      utimesSync(fullPath, twoHoursAgoSec, twoHoursAgoSec);
    }

    const removed = sweepStaleSnapshotFiles(cliHome, nowMs, 'dead');
    assert.equal(removed, orphans.length);
    for (const name of orphans) {
      assert.equal(existsSync(path.join(cacheDir, name)), false);
    }
  });

  void it('preserves recent .tmp cache files within the 1-hour grace window during sweepStaleSnapshotFiles', () => {
    const cacheDir = path.join(cliHome, 'cache');
    const nowMs = Date.parse('2026-06-15T12:00:00Z');
    const thirtyMinAgoSec = (nowMs - 30 * 60 * 1000) / 1000;
    const activeTmp = path.join(cacheDir, 'agy_hud_snapshot_live.json.tmp.1234.1700000000000.0123456789abcdef');
    writeFileSync(activeTmp, '{}', 'utf8');
    utimesSync(activeTmp, thirtyMinAgoSec, thirtyMinAgoSec);

    assert.equal(sweepStaleSnapshotFiles(cliHome, nowMs), 0);
    assert.equal(existsSync(activeTmp), true);
  });

  void it('ignores symlinked .tmp entries during sweepStaleSnapshotFiles', () => {
    if (process.platform === 'win32') return;
    const cacheDir = path.join(cliHome, 'cache');
    const outside = path.join(tmpRoot, 'outside-target.txt');
    writeFileSync(outside, 'keep', 'utf8');
    const symTmp = path.join(cacheDir, 'agy_hud_snapshot_sym.json.tmp.1234.1700000000000.0123456789abcdef');
    symlinkSync(outside, symTmp);

    const futureNowMs = Date.now() + 2 * 60 * 60 * 1000;
    assert.equal(sweepStaleSnapshotFiles(cliHome, futureNowMs), 0);
    assert.equal(lstatSync(symTmp).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, 'utf8'), 'keep');
  });

  void it('allows single-writer envelope update after clock rollback when marker still points to self', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8301;
    const convId = 'cli-single-rollback-1111';
    const data = { conversation_id: convId, conversation_title: 'Before Rollback', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, data, sharedPid, { nowMs: t0 + 60_000 });
    const baselineEnvelope = readSnapshotEnvelope(cliHome, convId);
    const baselinePidMarker = readActivePidMarker(cliHome, sharedPid, t0);
    assert.equal(baselinePidMarker?.convId, convId);

    const updated = writeSnapshotEnvelope(cliHome, { ...data, conversation_title: 'After Rollback' }, sharedPid, {
      nowMs: t0,
      baselineEnvelope,
      baselinePidMarker,
      rejectSuperseded: true,
    });
    assert.equal(updated?.conversationTitle, 'After Rollback');
    assert.equal(updated?.heartbeatAtMs, t0);
    assert.equal(readSnapshotEnvelope(cliHome, convId)?.conversationTitle, 'After Rollback');
  });

  void it('rejects stale concurrent same-session write when disk envelope changed since baseline', () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const sharedPid = 8302;
    const convId = 'cli-stale-race-1111';
    const data = { conversation_id: convId, conversation_title: 'V0', cwd: wsDir };

    writeSnapshotEnvelope(cliHome, data, sharedPid, { nowMs: t0 });
    const oldBaselineEnv = readSnapshotEnvelope(cliHome, convId);
    const oldBaselineMarker = readActivePidMarker(cliHome, sharedPid, t0 + 1_000);

    // Newer frame commits while older frame is still running.
    writeSnapshotEnvelope(cliHome, { ...data, conversation_title: 'V2 Newer' }, sharedPid, {
      nowMs: t0 + 2_000,
      baselineEnvelope: oldBaselineEnv,
      baselinePidMarker: oldBaselineMarker,
      rejectSuperseded: true,
    });

    const staleRes = writeSnapshotEnvelope(cliHome, { ...data, conversation_title: 'V1 Stale' }, sharedPid, {
      nowMs: t0 + 1_000,
      baselineEnvelope: oldBaselineEnv,
      baselinePidMarker: oldBaselineMarker,
      rejectSuperseded: true,
    });
    assert.equal(staleRes?.conversationTitle, 'V2 Newer');
    assert.equal(readSnapshotEnvelope(cliHome, convId)?.conversationTitle, 'V2 Newer');
  });

  void it('trims oversized subagents payload on write so snapshot envelope stays readable within 512 KiB', () => {
    const convId = 'cli-oversize-subagents-1111';
    const largeSubagents = Array.from({ length: 10 }, (_, idx) => ({
      name: `agent-${idx}`,
      role: 'x'.repeat(80 * 1024),
      status: 'RUNNING',
    }));

    const written = writeSnapshotEnvelope(
      cliHome,
      { conversation_id: convId, conversation_title: 'Big Subagents', cwd: wsDir, subagents: largeSubagents },
      8303,
      { nowMs: Date.parse('2026-06-01T12:00:00Z') },
    );
    assert.ok(written !== null);
    const filePath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`);
    assert.ok(statSync(filePath).size <= DEFAULT_MAX_REGULAR_JSON_BYTES);

    const reloaded = readSnapshotEnvelope(cliHome, convId);
    assert.ok(reloaded !== null);
    assert.equal(reloaded.conversationTitle, 'Big Subagents');
    assert.ok(reloaded.subagents.length > 0 && reloaded.subagents.length < largeSubagents.length);
  });

  void it('keeps .md synchronized with committed envelope mdDigest even if auxiliary PID marker write fails', () => {
    const convId = 'cli-pid-marker-fail-1111';
    const pid = 8304;
    const nowMs = Date.parse('2026-06-01T12:00:00Z');
    // Pre-create a directory at the PID marker path so marker persistence fails after the envelope is committed
    mkdirSync(path.join(cliHome, 'cache', `agy_hud_pid_${pid}.json`), { recursive: true });

    const data = { conversation_id: convId, conversation_title: 'Marker Failure Sync', cwd: wsDir };
    const result = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target: resolveSnapshotMarkdownUri(cliHome, convId),
      emittedOsc8Count: 1,
      data,
      activity: null,
      agentsSummary: null,
      agyPid: pid,
      transcriptStat: null,
      existingEnvelope: null,
      baselinePidMarker: null,
      nowMs,
    });
    assert.equal(result.written, true);
    assert.ok(result.envelope !== null);
    assert.equal(result.envelope?.mdDigest, result.mdDigest);
    const mdPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`);
    assert.equal(existsSync(mdPath), true);
    assert.ok(readFileSync(mdPath, 'utf8').includes('Marker Failure Sync'));
  });
});
