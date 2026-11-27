import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { readSnapshotEnvelope } from '../../collectors/snapshot-envelope.ts';
import { computeMarkdownDigest, materializeSnapshotMarkdownIfNeeded } from '../../hud-snapshot-publish.ts';
import type { AgentsSummary } from '../../types.ts';
import { GRAY, RESET, stripAnsi, visibleLen } from '../ansi.ts';
import {
  canEmitOsc8Links,
  countEmittedOsc8Links,
  formatActivitySummarySnapshotTail,
  formatOsc8Overflow,
  resolveSnapshotMarkdownUri,
  wrapOsc8Link,
} from '../osc8.ts';

const ESC = String.fromCharCode(0x1b);

void describe('canEmitOsc8Links', () => {
  void it('returns true when config enables OSC 8 for a local session', () => {
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', { TERM: 'xterm-256color' }), true);
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', {}), true);
  });

  void it('returns false when config.osc8Links is false', () => {
    assert.equal(canEmitOsc8Links({ osc8Links: false }, 'conv-123', { TERM: 'xterm-256color' }), false);
  });

  void it('returns false when conversation id is missing', () => {
    assert.equal(canEmitOsc8Links({ osc8Links: true }, null, { TERM: 'xterm-256color' }), false);
    assert.equal(canEmitOsc8Links({ osc8Links: true }, '   ', { TERM: 'xterm-256color' }), false);
  });

  void it('returns false when NO_COLOR is defined', () => {
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', { NO_COLOR: '1' }), false);
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', { NO_COLOR: '' }), false);
  });

  void it('returns false when TERM is dumb regardless of letter case', () => {
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', { TERM: 'dumb' }), false);
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', { TERM: 'DUMB' }), false);
  });

  void it('returns false when SSH_CONNECTION is non-empty', () => {
    assert.equal(
      canEmitOsc8Links({ osc8Links: true }, 'conv-123', { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' }),
      false,
    );
  });

  void it('returns false when SSH_CLIENT is non-empty', () => {
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', { SSH_CLIENT: '10.0.0.1 50000 22' }), false);
  });

  void it('returns false when SSH_TTY is non-empty', () => {
    assert.equal(canEmitOsc8Links({ osc8Links: true }, 'conv-123', { SSH_TTY: '/dev/pts/0' }), false);
  });

  void it('returns true when SSH environment variables are empty strings', () => {
    assert.equal(
      canEmitOsc8Links({ osc8Links: true }, 'conv-123', { SSH_CONNECTION: '', SSH_CLIENT: '  ', SSH_TTY: '' }),
      true,
    );
  });
});

void describe('OSC 8 URI resolution and hyperlink formatting', async () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-osc8-'));
    cliHome = path.join(tmpRoot, 'space dir #1', '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await it('resolves an empty-authority percent-encoded file URI inside cache without query or fragment', () => {
    const target = resolveSnapshotMarkdownUri(cliHome, 'conv-abc_1');
    assert.ok(target !== null);
    assert.equal(target.absPath, path.join(cliHome, 'cache', 'agy_hud_snapshot_conv-abc_1.md'));
    assert.equal(target.uri.startsWith('file:///'), true);
    assert.equal(target.uri.includes('%20'), true);
    assert.equal(target.uri.includes('%23'), true);
    assert.equal(target.uri.includes('#'), false);
    assert.equal(target.uri.includes('?'), false);
    assert.ok(Buffer.byteLength(`8;;${target.uri}`, 'utf8') < 4096);
  });

  await it('rejects traversal session ids in resolveSnapshotMarkdownUri', () => {
    assert.equal(resolveSnapshotMarkdownUri(cliHome, '../escape'), null);
    assert.equal(resolveSnapshotMarkdownUri(cliHome, '__proto__'), null);
  });

  await it('rejects snapshot URIs that reach or exceed the 4096-byte OSC buffer ceiling', () => {
    const deepSegments = Array.from({ length: 45 }, () => 'a'.repeat(100));
    const overlongHome = path.join(tmpRoot, ...deepSegments);
    assert.equal(resolveSnapshotMarkdownUri(overlongHome, 'conv-long'), null);
  });

  await it('wraps text in a same-line ST-closed OSC 8 sequence with zero visibleLen inflation', () => {
    const uri = 'file:///tmp/agy_hud_snapshot_conv-1.md';
    const linked = wrapOsc8Link('+3 more', uri);
    assert.equal(linked, `${ESC}]8;;${uri}${ESC}\\+3 more${ESC}]8;;${ESC}\\`);
    assert.equal(stripAnsi(linked), '+3 more');
    assert.equal(visibleLen(linked), 7);
  });

  await it('formats Activity Line overflow badges in gray with zero SGR underline', () => {
    const uri = 'file:///tmp/agy_hud_snapshot_conv-1.md';
    const badge = formatOsc8Overflow(4, uri);
    assert.equal(badge, `${GRAY}${ESC}]8;;${uri}${ESC}\\+4 more${ESC}]8;;${ESC}\\${RESET}`);
    assert.equal(stripAnsi(badge), '+4 more');
    assert.equal(visibleLen(badge), 7);
    assert.equal(badge.includes(`${ESC}[4m`), false);
  });

  await it('emits the Activity Summary snapshot tail when remainingCols is at least 11', () => {
    const uri = 'file:///tmp/agy_hud_snapshot_conv-1.md';
    const tail = formatActivitySummarySnapshotTail(11, uri);
    assert.equal(tail, ` ${GRAY}· ${ESC}]8;;${uri}${ESC}\\snapshot${ESC}]8;;${ESC}\\${RESET}`);
    assert.equal(stripAnsi(tail), ' · snapshot');
    assert.equal(visibleLen(tail), 11);
  });

  await it('omits the Activity Summary snapshot tail when remainingCols is below 11', () => {
    const uri = 'file:///tmp/agy_hud_snapshot_conv-1.md';
    assert.equal(formatActivitySummarySnapshotTail(10, uri), '');
    assert.equal(formatActivitySummarySnapshotTail(0, uri), '');
  });

  await it('counts emitted OSC 8 hyperlinks across rendered HUD lines', () => {
    const uri = 'file:///tmp/agy_hud_snapshot_conv-1.md';
    const lines = [
      '  [G4 Carbon]',
      `  ✓ Read ×5 | ${formatOsc8Overflow(2, uri)}`,
      `  ✓ Tools 5${formatActivitySummarySnapshotTail(20, uri)}`,
    ];
    assert.equal(countEmittedOsc8Links(lines, uri), 2);
    assert.equal(countEmittedOsc8Links(['  [G4 Carbon]'], uri), 0);
  });
});

void describe('computeMarkdownDigest', () => {
  void it('formats deterministic digest as ino:mtimeMs:size:agentsDigest', () => {
    const stat = { ino: 42, mtimeMs: 1700000000123, size: 8192 };
    const agents: AgentsSummary = {
      kind: 'swarm',
      working: 1,
      waiting: 1,
      alive: 2,
      total: 2,
      entries: [
        { name: 'alpha', type: 'worker', model: 'gemini-4-carbon', state: 'working', ts: 1000 },
        { name: 'beta', type: 'worker', model: '', state: 'waiting', ts: 1001 },
      ],
    };
    const d1 = computeMarkdownDigest(stat, agents);
    assert.equal(d1, computeMarkdownDigest(stat, agents));
    assert.equal(d1.startsWith('42:1700000000123:8192:'), true);
    assert.equal(d1.split(':').length, 4);
    assert.equal(computeMarkdownDigest(null, null), '0:0:0:none');
  });

  void it('invalidates markdown digest when transcript stat changes', () => {
    assert.notEqual(
      computeMarkdownDigest({ ino: 10, mtimeMs: 1000, size: 512 }, null),
      computeMarkdownDigest({ ino: 10, mtimeMs: 1001, size: 640 }, null),
    );
  });

  void it('invalidates markdown digest when agent state changes', () => {
    const stat = { ino: 10, mtimeMs: 1000, size: 512 };
    const working: AgentsSummary = {
      kind: 'agents',
      working: 1,
      waiting: 0,
      alive: 1,
      total: 1,
      entries: [{ name: 'scout', type: 'explorer', model: '', state: 'working', ts: 500 }],
    };
    const done: AgentsSummary = {
      kind: 'agents',
      working: 0,
      waiting: 0,
      alive: 0,
      total: 1,
      entries: [{ name: 'scout', type: 'explorer', model: '', state: 'done', ts: 520 }],
    };
    assert.notEqual(computeMarkdownDigest(stat, working), computeMarkdownDigest(stat, done));
  });

  void it('invalidates markdown digest when only model name changes', () => {
    const stat = { ino: 10, mtimeMs: 1000, size: 512 };
    const d1 = computeMarkdownDigest(stat, null, {
      convId: 'conv-model',
      data: { conversation_id: 'conv-model', model: { display_name: 'Gemini 4 Carbon' } },
    });
    const d2 = computeMarkdownDigest(stat, null, {
      convId: 'conv-model',
      data: { conversation_id: 'conv-model', model: { display_name: 'Claude Opus 4' } },
    });
    assert.notEqual(d1, d2);
  });
});

void describe('materializeSnapshotMarkdownIfNeeded two-gate discipline', async () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-mat-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await it('skips markdown write under Gate 1 when zero OSC 8 links were emitted while writing envelope', () => {
    const convId = 'conv-gate1';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const res = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 0,
      data: { conversation_id: convId, cwd: tmpRoot },
      agyPid: process.pid,
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 100, size: 50 },
      activity: { tools: [], skills: ['tdd'], mcps: [], agents: [] },
      agentsSummary: null,
      nowMs: 10_000,
    });
    assert.equal(res.written, false);
    assert.equal(existsSync(target.absPath), false);
    assert.equal(existsSync(path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`)), true);
  });

  await it('writes non-executable 0o600 markdown with mdDigest persisted in json envelope', () => {
    const convId = 'conv-mode';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const stat = { ino: 7, mtimeMs: 2000, size: 300 };
    const data = { conversation_id: convId, cwd: tmpRoot };
    const res = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data,
      agyPid: process.pid,
      existingEnvelope: null,
      transcriptStat: stat,
      activity: null,
      agentsSummary: null,
      nowMs: 20_000,
    });
    assert.equal(res.written, true);
    assert.equal(existsSync(target.absPath), true);
    if (process.platform !== 'win32') {
      const mode = statSync(target.absPath).mode & 0o777;
      assert.equal(mode, 0o600);
      assert.equal(mode & 0o111, 0);
    }
    assert.equal(
      readSnapshotEnvelope(cliHome, convId)?.mdDigest,
      computeMarkdownDigest(stat, null, { convId, data, activity: null }),
    );
  });

  await it('deduplicates unchanged Gate 2 ticks then rewrites when mdDigest changes', () => {
    const convId = 'conv-gate2';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const statA = { ino: 7, mtimeMs: 2000, size: 300 };
    const statB = { ino: 7, mtimeMs: 2005, size: 420 };
    const data = { conversation_id: convId, cwd: tmpRoot };
    const baseOpts = {
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data,
      agyPid: process.pid,
      activity: null,
      agentsSummary: null,
    };

    const first = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      existingEnvelope: null,
      transcriptStat: statA,
      nowMs: 20_000,
    });
    const sentinel = new Date(1_700_000_000_000);
    utimesSync(target.absPath, sentinel, sentinel);

    const second = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      existingEnvelope: first.envelope,
      transcriptStat: statA,
      nowMs: 21_000,
    });
    assert.equal(second.written, false);
    assert.equal(Math.trunc(statSync(target.absPath).mtimeMs), 1_700_000_000_000);

    const third = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      existingEnvelope: second.envelope,
      transcriptStat: statB,
      nowMs: 22_000,
    });
    assert.equal(third.written, true);
    assert.notEqual(Math.trunc(statSync(target.absPath).mtimeMs), 1_700_000_000_000);
    assert.equal(
      readSnapshotEnvelope(cliHome, convId)?.mdDigest,
      computeMarkdownDigest(statB, null, { convId, data, activity: null }),
    );
  });

  await it('rewrites materialized markdown when only model display name changes', () => {
    const convId = 'conv-model-rewrite';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const stat = { ino: 11, mtimeMs: 3000, size: 200 };

    const first = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, model: { display_name: 'Gemini 4 Carbon' } },
      agyPid: process.pid,
      existingEnvelope: null,
      transcriptStat: stat,
      activity: null,
      agentsSummary: null,
      nowMs: 40_000,
    });
    assert.equal(first.written, true);

    const second = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, model: { display_name: 'Claude Opus 4' } },
      agyPid: process.pid,
      existingEnvelope: first.envelope,
      transcriptStat: stat,
      activity: null,
      agentsSummary: null,
      nowMs: 41_000,
    });
    assert.equal(second.written, true);
    assert.notEqual(second.mdDigest, first.mdDigest);
    assert.ok(readFileSync(target.absPath, 'utf8').includes('`Claude Opus 4`'));
  });

  await it('rematerializes markdown when deleted on disk even if mdDigest matches envelope', () => {
    const convId = 'conv-missing-md';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const stat = { ino: 9, mtimeMs: 500, size: 120 };
    const first = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, cwd: tmpRoot },
      agyPid: null,
      existingEnvelope: null,
      transcriptStat: stat,
      activity: null,
      agentsSummary: null,
      nowMs: 30_000,
    });
    rmSync(target.absPath);
    const recreated = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, cwd: tmpRoot },
      agyPid: null,
      existingEnvelope: first.envelope,
      transcriptStat: stat,
      activity: null,
      agentsSummary: null,
      nowMs: 31_000,
    });
    assert.equal(recreated.written, true);
    assert.equal(existsSync(target.absPath), true);
  });

  await it('sweeps stale snapshot cache files older than 7 days', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 8 * 24 * 60 * 60 * 1000);
    const freshDate = new Date(nowMs - 2 * 24 * 60 * 60 * 1000);

    const staleMd = path.join(cacheDir, 'agy_hud_snapshot_old-1.md');
    const staleJson = path.join(cacheDir, 'agy_hud_snapshot_old-1.json');
    const freshMd = path.join(cacheDir, 'agy_hud_snapshot_recent-1.md');
    const otherFile = path.join(cacheDir, 'unrelated.md');
    for (const p of [staleMd, staleJson, freshMd, otherFile]) {
      writeFileSync(p, '{}', 'utf8');
    }
    utimesSync(staleMd, staleDate, staleDate);
    utimesSync(staleJson, staleDate, staleDate);
    utimesSync(otherFile, staleDate, staleDate);
    utimesSync(freshMd, freshDate, freshDate);

    const convId = 'conv-sweep-trigger';
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);
    const res = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, cwd: tmpRoot },
      agyPid: null,
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 1, size: 1 },
      activity: null,
      agentsSummary: null,
      nowMs,
    });
    assert.equal(res.written, true);
    assert.equal(res.sweptCount, 2);
    assert.equal(existsSync(staleMd), false);
    assert.equal(existsSync(staleJson), false);
    assert.equal(existsSync(freshMd), true);
    assert.equal(existsSync(otherFile), true);
  });

  await it('skips stale Markdown publish when a newer render already updated the on-disk envelope', () => {
    const convId = 'conv-stale-race';
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
    const initial = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      data: { conversation_id: convId, conversation_title: 'V0', cwd: tmpRoot },
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 100, size: 10 },
      nowMs: baseMs,
    });
    assert.equal(initial.written, true);
    const newer = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      data: { conversation_id: convId, conversation_title: 'Newer V2', cwd: tmpRoot },
      existingEnvelope: initial.envelope,
      transcriptStat: { ino: 1, mtimeMs: 300, size: 30 },
      nowMs: baseMs + 2000,
    });
    assert.equal(newer.written, true);
    const stale = materializeSnapshotMarkdownIfNeeded({
      ...baseOpts,
      data: { conversation_id: convId, conversation_title: 'Stale V1', cwd: tmpRoot },
      existingEnvelope: initial.envelope,
      transcriptStat: { ino: 1, mtimeMs: 200, size: 20 },
      nowMs: baseMs + 1000,
    });
    assert.equal(stale.written, false);
    assert.ok(readFileSync(target.absPath, 'utf8').includes('Newer V2'));
  });
});
