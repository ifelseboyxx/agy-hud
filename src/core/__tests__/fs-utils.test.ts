import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  captureEntrySnapshotSync,
  makeTempSuffix,
  readBoundedJsonObjectSync,
  readJsonObjectSync,
  readRegularJsonObjectSync,
  restoreEntrySnapshotSync,
  touchRegularFileTimesSync,
  writeBufferAtomicSync,
} from '../fs-utils.ts';
import { isSameCommandPath } from '../statusline-ownership.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

void describe('fs-utils atomic mode writes and cli.mjs ownership canonicalization', async () => {
  await it('applies explicit POSIX mode overriding umask in writeBufferAtomicSync', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-fs-mode-');
    const execFile = path.join(root, 'shim');
    const secretFile = path.join(root, 'secret.md');
    const prevMask = process.umask(0o077);
    try {
      writeBufferAtomicSync(execFile, '#!/bin/sh\n', 0o755);
      writeBufferAtomicSync(secretFile, 'private\n', 0o600);
    } finally {
      process.umask(prevMask);
    }
    assert.equal(statSync(execFile).mode & 0o777, 0o755);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
  });

  await it('preserves original POSIX file mode when restoring an EntrySnapshotSync', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-snap-mode-');
    const target = path.join(root, 'agy-hud');
    writeBufferAtomicSync(target, '#!/bin/sh\necho old\n', 0o755);
    const snap = captureEntrySnapshotSync(target);
    writeBufferAtomicSync(target, '#!/bin/sh\necho new\n', 0o644);
    restoreEntrySnapshotSync(snap);
    assert.equal(statSync(target).mode & 0o777, 0o755);
  });

  await it('scopes dist/cli.mjs ownership per link target and matches after target deletion', () => {
    const root = makeTempDir('agy-hud-cli-own-');
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, 'dist'), { recursive: true });
    writeFileSync(path.join(repo, 'dist', 'cli.mjs'), '// cli\n', 'utf8');
    const linkA = path.join(root, 'link-a');
    const linkB = path.join(root, 'link-b');
    symlinkSync(repo, linkA, process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(repo, linkB, process.platform === 'win32' ? 'junction' : 'dir');

    const cliA = path.join(linkA, 'dist', 'cli.mjs');
    const cliB = path.join(linkB, 'dist', 'cli.mjs');
    assert.equal(isSameCommandPath(cliA, cliB), false);

    rmSync(linkA, { force: true });
    const cliAViaRealParent = path.join(realpathSync(root), 'link-a', 'dist', 'cli.mjs');
    assert.equal(isSameCommandPath(cliA, cliAViaRealParent), true);
  });

  await it('rejects invalid truncated UTF-8 bytes in strict readJsonObjectSync without mutating file', () => {
    const root = makeTempDir('agy-hud-utf8-');
    const filePath = path.join(root, 'hud-config.json');
    // Valid ASCII JSON prefix/suffix surrounding a truncated 3-byte UTF-8 CJK lead sequence (0xe4 0xb8).
    const rawBytes = Buffer.concat([
      Buffer.from('{"preset":"full","note":"', 'utf8'),
      Buffer.from([0xe4, 0xb8]),
      Buffer.from('"}\n', 'utf8'),
    ]);
    writeFileSync(filePath, rawBytes);
    assert.throws(() => readJsonObjectSync(filePath, true), /Invalid UTF-8/);
    assert.equal(readJsonObjectSync(filePath, false), null);
    assert.deepEqual(readFileSync(filePath), rawBytes);
  });

  await it('refuses to follow or delete a pre-existing symlink at the atomic temp path', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-atomic-sym-');
    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'original-secret', { mode: 0o644 });
    chmodSync(outside, 0o644);
    const target = path.join(root, 'cache.json');
    const fixedSuffix = 'collision-test';
    const tmpPath = `${target}.tmp.${fixedSuffix}`;
    symlinkSync(outside, tmpPath);

    assert.throws(() => writeBufferAtomicSync(target, 'overwritten', 0o600, fixedSuffix));
    assert.equal(readFileSync(outside, 'utf8'), 'original-secret');
    assert.equal(statSync(outside).mode & 0o777, 0o644);
    assert.equal(lstatSync(tmpPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(tmpPath), outside);
  });

  await it('generates 16-hex-character cryptographic temp suffixes', () => {
    const a = makeTempSuffix();
    const b = makeTempSuffix();
    assert.match(a, /^\d+\.\d+\.[0-9a-f]{16}$/);
    assert.notEqual(a, b);
  });

  await it('returns null when lstat hits EACCES in readRegularJsonObjectSync', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = makeTempDir('agy-hud-eacces-read-');
    const lockedDir = path.join(root, 'locked');
    mkdirSync(lockedDir, { mode: 0o700 });
    const filePath = path.join(lockedDir, 'data.json');
    writeFileSync(filePath, '{"ok":true}', { mode: 0o600 });
    chmodSync(lockedDir, 0o000);
    try {
      assert.equal(readRegularJsonObjectSync(filePath), null);
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });

  await it('no-ops without throwing when lstat hits EACCES in touchRegularFileTimesSync', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = makeTempDir('agy-hud-eacces-touch-');
    const lockedDir = path.join(root, 'locked');
    mkdirSync(lockedDir, { mode: 0o700 });
    const filePath = path.join(lockedDir, 'data.json');
    writeFileSync(filePath, '{"ok":true}', { mode: 0o600 });
    chmodSync(lockedDir, 0o000);
    try {
      assert.doesNotThrow(() => touchRegularFileTimesSync(filePath, Date.now()));
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });

  await it('reads valid JSON through a file symlink within maxBytes in readBoundedJsonObjectSync', () => {
    const root = makeTempDir('agy-hud-bounded-sym-');
    const target = path.join(root, 'real-settings.json');
    const link = path.join(root, 'settings.json');
    writeFileSync(target, JSON.stringify({ model: 'Gemini 4 Neon' }), { mode: 0o644 });
    symlinkSync(target, link);

    assert.deepEqual(readBoundedJsonObjectSync(link, 4096), { model: 'Gemini 4 Neon' });
  });

  await it('returns null when file size exceeds maxBytes in readBoundedJsonObjectSync', () => {
    const root = makeTempDir('agy-hud-bounded-cap-');
    const target = path.join(root, 'huge.json');
    writeFileSync(target, `${' '.repeat(512)}${JSON.stringify({ ok: true })}`, 'utf8');

    assert.equal(readBoundedJsonObjectSync(target, 256), null);
  });

  await it('returns null for directories in readBoundedJsonObjectSync', () => {
    const root = makeTempDir('agy-hud-bounded-dir-');
    assert.equal(readBoundedJsonObjectSync(root, 4096), null);
  });
});
