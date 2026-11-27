import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { SessionRecord } from '../../snapshot-types.ts';
import { MAX_ACTIVITY_CACHE_BYTES } from '../activity-cache.ts';
import { loadTranscriptActivity } from '../activity.ts';
import { detectAgyProcess } from '../proc.ts';
import { getSessionElapsedSeconds, readCliFallbackModel, readHudConfig } from '../settings.ts';
import { readSnapshotEnvelope } from '../snapshot-envelope.ts';
import { loadSnapshotTranscript } from '../snapshot-transcript.ts';
import { readSqliteVersionTag } from '../sqlite-readonly.ts';
import { loadSessionTelemetry } from '../telemetry.ts';

void describe('collector cache file permissions', () => {
  let tmpRoot = '';
  let cliHome = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-cache-mode-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    wsDir = path.join(tmpRoot, 'ws');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('writes activity cache with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-mode-act';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }] })}\n`,
      'utf8',
    );
    loadTranscriptActivity(cliHome, { conversation_id: convId });
    const cachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  });

  void it('writes snapshot transcript cache with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-mode-snap';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }] })}\n`,
      'utf8',
    );
    const session: SessionRecord = {
      convId,
      shortId: convId.slice(0, 8),
      title: 'Snap',
      workspace: wsDir,
      workspaces: [wsDir],
      dataRoot: cliHome,
      running: false,
      livePid: null,
      hasEnvelope: false,
      envelope: null,
      updatedAtMs: 1_000,
      ageLabel: '1s ago',
    };
    loadSnapshotTranscript(session, cliHome);
    const cachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  });

  void it('writes proc cache with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 3001,
      isAlive: (pid) => pid === 3001 || pid === 3000,
      readProc: (pid) =>
        pid === 3001
          ? { pid: 3001, ppid: 3000, comm: 'sh', args: 'sh -c hud.mjs' }
          : pid === 3000
            ? { pid: 3000, ppid: 1, comm: 'agy', args: 'agy --mode plan' }
            : null,
    });
    const cachePath = path.join(cliHome, 'cache', 'agy_hud_proc.json');
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  });

  void it('writes session start cache with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    getSessionElapsedSeconds(cliHome, 'cache-mode-sess', { conversation_id: 'cache-mode-sess' });
    const cachePath = path.join(cliHome, 'cache', 'agy_hud_sessions.json');
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  });

  void it('writes telemetry cache with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-mode-tel';
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(path.join(convDir, `${convId}.db`));
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, Buffer.from([0x0a, 0x00]));
    } finally {
      db.close();
    }
    loadSessionTelemetry(cliHome, { conversation_id: convId });
    const cachePath = path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  });

  void it('rebuilds a pre-existing 0o644 activity cache as 0o600 on unchanged transcript', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-mode-tighten-act';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }] })}\n`,
      'utf8',
    );
    loadTranscriptActivity(cliHome, { conversation_id: convId });
    const actCachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    chmodSync(actCachePath, 0o644);
    assert.equal(statSync(actCachePath).mode & 0o777, 0o644);

    const reloadedAct = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.equal(reloadedAct?.completedTools?.[0]?.disp, 'read_file');
    assert.equal(statSync(actCachePath).mode & 0o777, 0o600);
  });

  void it('rebuilds a pre-existing 0o644 snapshot transcript cache as 0o600 on unchanged transcript', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-mode-tighten-snap';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }] })}\n`,
      'utf8',
    );
    const session: SessionRecord = {
      convId,
      shortId: convId.slice(0, 8),
      title: 'Tighten',
      workspace: wsDir,
      workspaces: [wsDir],
      dataRoot: cliHome,
      running: false,
      livePid: null,
      hasEnvelope: false,
      envelope: null,
      updatedAtMs: 1_000,
      ageLabel: '1s ago',
    };
    loadSnapshotTranscript(session, cliHome);
    const snapCachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    chmodSync(snapCachePath, 0o644);
    assert.equal(statSync(snapCachePath).mode & 0o777, 0o644);

    const reloadedSnap = loadSnapshotTranscript(session, cliHome);
    assert.equal(reloadedSnap.tools[0]?.disp, 'read_file');
    assert.equal(statSync(snapCachePath).mode & 0o777, 0o600);
  });

  void it('refuses to mutate external file when activity cache path is a pre-existing symlink', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-sym-target';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }] })}\n`,
      'utf8',
    );
    const outside = path.join(tmpRoot, 'outside-target.txt');
    writeFileSync(outside, 'keep-me-intact', { mode: 0o644 });
    chmodSync(outside, 0o644);
    const actCachePath = path.join(cacheDir, `agy_hud_activity_${convId}.json`);
    symlinkSync(outside, actCachePath);

    const activity = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.equal(activity?.completedTools?.[0]?.disp, 'read_file');
    assert.equal(readFileSync(outside, 'utf8'), 'keep-me-intact');
    assert.equal(statSync(outside).mode & 0o777, 0o644);
    assert.equal(lstatSync(actCachePath).isSymbolicLink(), true);
  });

  void it('returns null from readSnapshotEnvelope when cache directory is unreadable', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const convId = 'cache-eacces-env';
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    chmodSync(cacheDir, 0o000);
    try {
      assert.equal(readSnapshotEnvelope(cliHome, convId), null);
    } finally {
      chmodSync(cacheDir, 0o700);
    }
  });

  void it('loads transcript activity without throwing when cache directory is unreadable', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const convId = 'cache-eacces-act';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }] })}\n`,
      'utf8',
    );
    chmodSync(cacheDir, 0o000);
    try {
      const activity = loadTranscriptActivity(cliHome, { conversation_id: convId });
      assert.equal(activity?.completedTools?.[0]?.disp, 'read_file');
    } finally {
      chmodSync(cacheDir, 0o700);
    }
  });

  void it('rebuilds a pre-existing 0o644 telemetry cache as 0o600 on unchanged DB', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-mode-tighten-tel';
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, Buffer.from([0x0a, 0x00]));
    } finally {
      db.close();
    }

    loadSessionTelemetry(cliHome, { conversation_id: convId });
    const cachePath = path.join(cliHome, 'cache', `agy_hud_telemetry_${convId}.json`);
    chmodSync(cachePath, 0o644);
    assert.equal(statSync(cachePath).mode & 0o777, 0o644);

    loadSessionTelemetry(cliHome, { conversation_id: convId });
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  });

  void it('ignores an oversized telemetry cache exceeding 16 MiB and reloads from DB', () => {
    const convId = 'cache-oversize-tel';
    const convDir = path.join(cliHome, 'conversations');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = path.join(convDir, `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        1,
        Buffer.from([0x0a, 0x04, 0x22, 0x02, 0x10, 0x2a]),
      );
    } finally {
      db.close();
    }
    const versionTag = readSqliteVersionTag(dbPath);
    const cachePath = path.join(cacheDir, `agy_hud_telemetry_${convId}.json`);
    const fakePayload = JSON.stringify({
      v: 2,
      versionTag,
      rows: {
        '1': { in: 42, out: 0, cw: 0, cr: 0, ttft: 0, stream: 0, ctxUsed: 0, ctxMax: 0 },
        '2': { in: 99, out: 0, cw: 0, cr: 0, ttft: 0, stream: 0, ctxUsed: 0, ctxMax: 0 },
      },
      ckpt: null,
    });
    writeFileSync(cachePath, `${' '.repeat(MAX_ACTIVITY_CACHE_BYTES + 64)}${fakePayload}`, { mode: 0o600 });

    const telemetry = loadSessionTelemetry(cliHome, { conversation_id: convId });
    assert.equal(telemetry.genCount, 1);
  });

  void it('rebuilds a pre-existing 0o644 session timestamp cache as 0o600', () => {
    if (process.platform === 'win32') return;
    const convId = 'cache-mode-tighten-sess';
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'agy_hud_sessions.json');
    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(cachePath, JSON.stringify({ [convId]: oldTs }), { mode: 0o644 });
    chmodSync(cachePath, 0o644);

    const elapsed = getSessionElapsedSeconds(cliHome, convId);
    assert.ok(elapsed !== null && elapsed < 30);
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  });

  void it('ignores an oversized session timestamp cache exceeding 512 KiB', () => {
    const convId = 'cache-oversize-sess';
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'agy_hud_sessions.json');
    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(cachePath, `${' '.repeat(512 * 1024 + 64)}${JSON.stringify({ [convId]: oldTs })}`, { mode: 0o600 });

    const elapsed = getSessionElapsedSeconds(cliHome, convId);
    assert.ok(elapsed !== null && elapsed < 30);
  });

  void it('reads symlinked settings.json in readCliFallbackModel', () => {
    const target = path.join(tmpRoot, 'dotfiles-settings.json');
    writeFileSync(target, JSON.stringify({ model: 'Gemini 4 Neon' }), { mode: 0o644 });
    symlinkSync(target, path.join(cliHome, 'settings.json'));

    assert.equal(readCliFallbackModel(cliHome), 'Gemini 4 Neon');
  });

  void it('falls back to empty string when settings.json exceeds 512 KiB in readCliFallbackModel', () => {
    writeFileSync(
      path.join(cliHome, 'settings.json'),
      `${' '.repeat(512 * 1024 + 64)}${JSON.stringify({ model: 'Gemini 4 Neon' })}`,
      'utf8',
    );

    assert.equal(readCliFallbackModel(cliHome), '');
  });

  void it('reads symlinked hud-config.json in readHudConfig', () => {
    const target = path.join(tmpRoot, 'dotfiles-hud-config.json');
    writeFileSync(target, JSON.stringify({ preset: 'zen' }), { mode: 0o644 });
    symlinkSync(target, path.join(cliHome, 'hud-config.json'));

    assert.equal(readHudConfig(cliHome).preset, 'zen');
  });

  void it('falls back to default config when hud-config.json exceeds 512 KiB in readHudConfig', () => {
    writeFileSync(
      path.join(cliHome, 'hud-config.json'),
      `${' '.repeat(512 * 1024 + 64)}${JSON.stringify({ preset: 'zen' })}`,
      'utf8',
    );

    assert.equal(readHudConfig(cliHome).preset, 'full');
  });
});
