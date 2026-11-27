import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { readSnapshotEnvelope, writeSnapshotEnvelope } from '../../collectors/snapshot-envelope.ts';
import { readActivePidMarker } from '../../collectors/snapshot-pid-marker.ts';
import { buildPresetConfig } from '../../core/hud-config.ts';
import { runHudRender } from '../../hud-runner.ts';
import { materializeSnapshotMarkdownIfNeeded, resolveSnapshotMarkdownUri } from '../../hud-snapshot-publish.ts';

void describe('osc8 concurrency, TTL preservation, and required lock enforcement', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-osc8-conc-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('keeps newer markdown and envelope when older runHudRender collects before newer frame publishes', () => {
    const convId = 'conv-f04-hud-race';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const baseSec = Math.floor(Date.parse('2026-06-01T12:00:00Z') / 1000);
    const hudConfig = buildPresetConfig('compact');
    hudConfig.osc8Links = true;
    const env = { TERM: 'xterm-256color' };

    const staleAct = {
      tools: [{ name: 'read_file', disp: 'Read', target: 'old.ts', running: false, isSkillRead: false }],
      skills: [],
      mcps: [],
      agents: [],
    };
    const newerAct = {
      tools: [{ name: 'edit_file', disp: 'Edit', target: 'new.ts', running: false, isSkillRead: false }],
      skills: ['tdd'],
      mcps: [],
      agents: [],
    };

    const emptyTelemetry = { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null };
    const emptyAgents = { kind: 'agents' as const, working: 0, waiting: 0, alive: 0, total: 0, entries: [] };
    const olderLines = runHudRender(
      cliHome,
      { conversation_id: convId, conversation_title: 'Stale V1', cwd: tmpRoot, terminal_width: 120 },
      {
        hudConfig,
        env,
        agyPid: null,
        nowSec: baseSec + 1,
        cliSettings: {},
        telemetry: emptyTelemetry,
        agentsSummary: emptyAgents,
        todos: null,
        collectors: {
          loadTranscriptActivity: () => {
            runHudRender(
              cliHome,
              { conversation_id: convId, conversation_title: 'Newer V2', cwd: tmpRoot, terminal_width: 120 },
              {
                hudConfig,
                env,
                agyPid: null,
                nowSec: baseSec + 2,
                cliSettings: {},
                telemetry: emptyTelemetry,
                activity: newerAct,
                agentsSummary: emptyAgents,
                todos: null,
              },
            );
            return staleAct;
          },
        },
      },
    );

    assert.ok(olderLines.length > 0);
    const mdText = readFileSync(target.absPath, 'utf8');
    assert.ok(mdText.includes('Newer V2'));
    assert.equal(mdText.includes('Stale V1'), false);
    const envelope = readSnapshotEnvelope(cliHome, convId);
    assert.equal(envelope?.conversationTitle, 'Newer V2');
    assert.equal(envelope?.updatedAtMs, (baseSec + 2) * 1000);
  });

  void it('rejects stale markdown publish even when older frame observed newer envelope mdDigest as prevDigest', () => {
    const convId = 'conv-f04-prev-digest';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const baseMs = Date.parse('2026-06-01T12:00:00Z');
    const baseOpts = {
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      agyPid: null,
      activity: null,
      agentsSummary: null,
    };

    const newer = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      data: { conversation_id: convId, conversation_title: 'Newer V2', cwd: tmpRoot },
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 300, size: 30 },
      nowMs: baseMs + 2000,
    });
    assert.equal(newer.written, true);

    const stale = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      data: { conversation_id: convId, conversation_title: 'Stale V1', cwd: tmpRoot },
      existingEnvelope: newer.envelope,
      transcriptStat: { ino: 1, mtimeMs: 200, size: 20 },
      nowMs: baseMs + 1000,
    });
    assert.equal(stale.written, false);
    assert.ok(readFileSync(target.absPath, 'utf8').includes('Newer V2'));
    assert.equal(readSnapshotEnvelope(cliHome, convId)?.conversationTitle, 'Newer V2');
    assert.equal(readSnapshotEnvelope(cliHome, convId)?.mdDigest, newer.mdDigest);
  });

  void it('keeps newer envelope when older Gate-1 frame commits without markdown write', () => {
    const convId = 'conv-f04-gate1';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const baseMs = Date.parse('2026-06-01T12:00:00Z');

    const newer = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, conversation_title: 'Newer V2', cwd: tmpRoot },
      agyPid: null,
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 300, size: 30 },
      activity: null,
      agentsSummary: null,
      nowMs: baseMs + 2000,
    });
    assert.equal(newer.written, true);

    materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 0,
      data: { conversation_id: convId, conversation_title: 'Stale V1', cwd: tmpRoot },
      agyPid: null,
      existingEnvelope: newer.envelope,
      transcriptStat: null,
      activity: null,
      agentsSummary: null,
      nowMs: baseMs + 1000,
    });

    const envelope = readSnapshotEnvelope(cliHome, convId);
    assert.equal(envelope?.conversationTitle, 'Newer V2');
    assert.equal(envelope?.mdDigest, newer.mdDigest);
  });

  void it('preserves active markdown older than 7 days on Gate-2 heartbeat while sweeping other stale files', () => {
    const convId = 'conv-f05-active';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const nowMs = Date.parse('2026-06-15T12:00:00Z');
    const eightDaysAgo = new Date(nowMs - 8 * 24 * 60 * 60 * 1000);
    const stat = { ino: 7, mtimeMs: 2000, size: 300 };
    const data = { conversation_id: convId, conversation_title: 'Long Idle Session', cwd: tmpRoot };

    const first = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data,
      agyPid: null,
      existingEnvelope: null,
      transcriptStat: stat,
      activity: null,
      agentsSummary: null,
      nowMs: nowMs - 60_000,
    });
    assert.equal(first.written, true);

    const otherStaleMd = path.join(cliHome, 'cache', 'agy_hud_snapshot_other-stale.md');
    writeFileSync(otherStaleMd, '# stale\n', 'utf8');
    utimesSync(otherStaleMd, eightDaysAgo, eightDaysAgo);
    utimesSync(target.absPath, eightDaysAgo, eightDaysAgo);

    materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data,
      agyPid: null,
      existingEnvelope: first.envelope,
      transcriptStat: stat,
      activity: null,
      agentsSummary: null,
      nowMs,
    });

    assert.equal(existsSync(target.absPath), true);
    assert.equal(existsSync(otherStaleMd), false);
  });

  void it('skips stale markdown publish when a newer Gate-1 frame already updated envelope without writing markdown', () => {
    const convId = 'conv-f04-gate1-blocks-md';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const baseMs = Date.parse('2026-06-01T12:00:00Z');

    writeSnapshotEnvelope(cliHome, { conversation_id: convId, conversation_title: 'Newer Gate1', cwd: tmpRoot }, null, {
      nowMs: baseMs + 2000,
    });

    const stale = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, conversation_title: 'Stale V1', cwd: tmpRoot },
      agyPid: null,
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 100, size: 10 },
      activity: null,
      agentsSummary: null,
      nowMs: baseMs + 1000,
    });

    assert.equal(stale.written, false);
    assert.equal(existsSync(target.absPath), false);
    assert.equal(readSnapshotEnvelope(cliHome, convId)?.conversationTitle, 'Newer Gate1');
  });

  void it('skips markdown, envelope, and PID marker writes when snapshot lock path is a directory', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const convId = 'conv-f06-dir';
    const pid = 9101;
    mkdirSync(path.join(cacheDir, `.agy_hud_snapshot_${convId}.lock`), { recursive: true });

    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const res = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, conversation_title: 'Dir Lock', cwd: tmpRoot },
      agyPid: pid,
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 100, size: 10 },
      activity: null,
      agentsSummary: null,
      nowMs: 50_000,
    });
    assert.equal(res.written, false);
    assert.equal(existsSync(target.absPath), false);
    assert.equal(existsSync(path.join(cacheDir, `agy_hud_snapshot_${convId}.json`)), false);
    assert.equal(existsSync(path.join(cacheDir, `agy_hud_pid_${pid}.json`)), false);
  });

  void it('skips envelope and PID marker writes when PID lock path is an outside symlink', () => {
    if (process.platform === 'win32') return;
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const convId = 'conv-f06-sym-env';
    const pid = 9102;
    const outside = path.join(tmpRoot, 'outside-env.lock');
    writeFileSync(outside, 'x', 'utf8');
    symlinkSync(outside, path.join(cacheDir, `.agy_hud_pid_${pid}.lock`));

    const envRes = writeSnapshotEnvelope(
      cliHome,
      { conversation_id: convId, conversation_title: 'Sym Lock', cwd: tmpRoot },
      pid,
      { nowMs: 51_000 },
    );
    assert.equal(envRes, null);
    assert.equal(existsSync(path.join(cacheDir, `agy_hud_snapshot_${convId}.json`)), false);
    assert.equal(existsSync(path.join(cacheDir, `agy_hud_pid_${pid}.json`)), false);
  });

  void it('renders HUD normally while skipping cache writes when PID lock path is an outside symlink', () => {
    if (process.platform === 'win32') return;
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const convId = 'conv-f06-sym-hud';
    const pid = 9103;
    const outside = path.join(tmpRoot, 'outside-hud.lock');
    writeFileSync(outside, 'x', 'utf8');
    symlinkSync(outside, path.join(cacheDir, `.agy_hud_pid_${pid}.lock`));

    const lines = runHudRender(
      cliHome,
      { conversation_id: convId, conversation_title: 'Sym Lock', cwd: tmpRoot, terminal_width: 120 },
      {
        hudConfig: buildPresetConfig('compact'),
        env: { TERM: 'xterm-256color' },
        agyPid: pid,
        cliSettings: {},
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
        activity: {
          tools: [{ name: 'read_file', disp: 'Read', target: 'a.ts', running: false, isSkillRead: false }],
          skills: [],
          mcps: [],
          agents: [],
        },
        agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
        todos: null,
      },
    );
    assert.ok(lines.length > 0);
    assert.equal(
      lines.some((line) => line.includes('\x1b]8;;')),
      false,
    );
    assert.equal(existsSync(path.join(cacheDir, `agy_hud_snapshot_${convId}.md`)), false);
    assert.equal(existsSync(path.join(cacheDir, `agy_hud_snapshot_${convId}.json`)), false);
    assert.equal(existsSync(path.join(cacheDir, `agy_hud_pid_${pid}.json`)), false);
  });

  void it('strips dead OSC 8 overflow links to plain +N more when initial markdown publish fails', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const convId = 'conv-f14-dead-link';
    mkdirSync(path.join(cacheDir, `.agy_hud_snapshot_${convId}.lock`), { recursive: true });

    const hudConfig = buildPresetConfig('full');
    hudConfig.lines = ['tools'];
    hudConfig.osc8Links = true;
    const tools = Array.from({ length: 12 }, (_, idx) => ({
      name: `tool_${idx}`,
      disp: `tool_${idx}`,
      target: `file_${idx}.ts`,
      running: false,
      isSkillRead: false,
    }));

    const lines = runHudRender(
      cliHome,
      { conversation_id: convId, conversation_title: 'Overflow Dead Link', cwd: tmpRoot, terminal_width: 60 },
      {
        hudConfig,
        env: { TERM: 'xterm-256color' },
        agyPid: null,
        cliSettings: {},
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
        activity: { tools, skills: [], mcps: [], agents: [] },
        agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
        todos: null,
      },
    );

    assert.equal(existsSync(path.join(cacheDir, `agy_hud_snapshot_${convId}.md`)), false);
    assert.equal(
      lines.some((line) => line.includes('\x1b]8;;')),
      false,
    );
    assert.ok(lines.some((line) => /\+\d+ more/.test(line)));
  });

  void it('blocks an older dirty frame from overwriting markdown and envelope after a newer pure heartbeat', () => {
    const convId = 'conv-f03-heartbeat-guard';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const baseData = { conversation_id: convId, conversation_title: 'Baseline V1', cwd: tmpRoot };
    const baseStat = { ino: 1, mtimeMs: 100, size: 10 };

    const baseline = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: baseData,
      agyPid: null,
      existingEnvelope: null,
      transcriptStat: baseStat,
      activity: null,
      agentsSummary: null,
      nowMs: t0,
    });
    assert.equal(baseline.written, true);

    // Pure 30s+ heartbeat at t0 + 40s keeps updatedAtMs = t0, advances heartbeatAtMs = t0 + 40_000.
    const heartbeat = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: baseData,
      agyPid: null,
      existingEnvelope: baseline.envelope,
      transcriptStat: baseStat,
      activity: null,
      agentsSummary: null,
      nowMs: t0 + 40_000,
    });
    assert.equal(heartbeat.envelope?.updatedAtMs, t0);
    assert.equal(heartbeat.envelope?.heartbeatAtMs, t0 + 40_000);

    // Older dirty frame captured at t0 + 20s resumes after the t0 + 40s heartbeat.
    const staleDirty = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { ...baseData, conversation_title: 'Stale Dirty T20' },
      agyPid: null,
      existingEnvelope: baseline.envelope,
      transcriptStat: { ino: 1, mtimeMs: 200, size: 20 },
      activity: null,
      agentsSummary: null,
      nowMs: t0 + 20_000,
    });

    assert.equal(staleDirty.written, false);
    const mdAfter = readFileSync(target.absPath, 'utf8');
    assert.ok(mdAfter.includes('Baseline V1'));
    assert.equal(mdAfter.includes('Stale Dirty T20'), false);
    const envAfter = readSnapshotEnvelope(cliHome, convId);
    assert.equal(envAfter?.conversationTitle, 'Baseline V1');
    assert.equal(envAfter?.heartbeatAtMs, t0 + 40_000);
  });

  void it('publishes updated markdown for a single-writer CLI session after <= 5 minute clock rollback', () => {
    const convId = 'conv-j03-osc8-rollback';
    const pid = 9201;
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const t0 = Date.parse('2026-06-01T12:00:00Z');

    const first = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, conversation_title: 'Before Rollback', cwd: tmpRoot },
      agyPid: pid,
      existingEnvelope: null,
      baselinePidMarker: null,
      transcriptStat: { ino: 1, mtimeMs: 100, size: 10 },
      activity: null,
      agentsSummary: null,
      nowMs: t0 + 60_000,
    });
    assert.equal(first.written, true);
    const marker = readActivePidMarker(cliHome, pid, t0);
    assert.equal(marker?.convId, convId);

    const afterRollback = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, conversation_title: 'After Rollback', cwd: tmpRoot },
      agyPid: pid,
      existingEnvelope: first.envelope,
      baselinePidMarker: marker,
      transcriptStat: { ino: 1, mtimeMs: 200, size: 20 },
      activity: null,
      agentsSummary: null,
      nowMs: t0,
    });
    assert.equal(afterRollback.written, true);
    assert.ok(readFileSync(target.absPath, 'utf8').includes('After Rollback'));
    assert.equal(readSnapshotEnvelope(cliHome, convId)?.conversationTitle, 'After Rollback');
  });
});
