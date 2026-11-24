import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { isSameCommandPath } from '../core/statusline-ownership.ts';
import { captureEntrySnapshotSync, restoreEntrySnapshotSync, writeBufferAtomicSync } from '../fs-utils.ts';

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
});
