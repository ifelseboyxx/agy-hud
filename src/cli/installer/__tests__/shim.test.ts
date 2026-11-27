import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
import { afterEach, describe, it } from 'node:test';

import { runRollbackSteps } from '../fs-ops.ts';
import {
  formatPathHint,
  formatShimScriptCmd,
  formatShimScriptPosix,
  isDirOnPath,
  resolveShimBinDir,
  resolveShimPaths,
  SHIM_HEADER_VERSION,
} from '../shim-format.ts';
import {
  assertShimWritablePreflight,
  createShimRemovalRollbackSteps,
  createShimRollbackSteps,
  inspectCliShim,
  installCliShim,
  removeOwnedCliShim,
  runCliShimSmoke,
} from '../shim.ts';

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

void describe('CLI shim path resolution and wrapper formatting', async () => {
  await it('resolves binDir with precedence: explicit > AGY_HUD_BIN_DIR > POSIX ~/.local/bin', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice', AGY_HUD_BIN_DIR: '~/env-bin' };
    assert.equal(resolveShimBinDir('~/custom-bin', env, 'darwin'), '/Users/alice/custom-bin');
    assert.equal(resolveShimBinDir(undefined, env, 'linux'), '/Users/alice/env-bin');
    assert.equal(resolveShimBinDir(undefined, { HOME: '/Users/alice' }, 'darwin'), '/Users/alice/.local/bin');
  });

  await it('resolves Windows binDir using LOCALAPPDATA only when contained inside USERPROFILE', () => {
    const inside = resolveShimBinDir(
      undefined,
      { USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      'win32',
    );
    assert.equal(inside, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin');

    const outsideSibling = resolveShimBinDir(
      undefined,
      { USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'C:\\Users\\alice2\\AppData\\Local' },
      'win32',
    );
    assert.equal(outsideSibling, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin');

    const outsideTraversal = resolveShimBinDir(
      undefined,
      { USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'C:\\Users\\alice\\..\\bob\\AppData\\Local' },
      'win32',
    );
    assert.equal(outsideTraversal, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin');

    const outsideDrive = resolveShimBinDir(
      undefined,
      { USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'D:\\Shared\\Local' },
      'win32',
    );
    assert.equal(outsideDrive, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin');

    const relativeLocal = resolveShimBinDir(
      undefined,
      { USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'AppData\\Local' },
      'win32',
    );
    assert.equal(relativeLocal, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin');
  });

  await it('resolves POSIX single shim path and Windows .cmd + companion POSIX pair', () => {
    const posix = resolveShimPaths('/Users/alice/.local/bin', 'darwin');
    assert.equal(posix.primaryPath, '/Users/alice/.local/bin/agy-hud');
    assert.equal(posix.posixPath, '/Users/alice/.local/bin/agy-hud');
    assert.equal(posix.cmdPath, null);
    assert.deepEqual(posix.allPaths, ['/Users/alice/.local/bin/agy-hud']);

    const win = resolveShimPaths('C:\\Users\\alice\\AppData\\Local\\agy\\bin', 'win32');
    assert.equal(win.primaryPath, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy-hud.cmd');
    assert.equal(win.posixPath, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy-hud');
    assert.equal(win.cmdPath, 'C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy-hud.cmd');
    assert.deepEqual(win.allPaths, [
      'C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy-hud.cmd',
      'C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy-hud',
    ]);
  });

  await it('detects PATH membership across POSIX and Windows delimiters and formats a single-line hint', () => {
    assert.equal(
      isDirOnPath(
        '/Users/alice/.local/bin',
        { HOME: '/Users/alice', PATH: '/usr/bin:/Users/alice/.local/bin/' },
        'linux',
      ),
      true,
    );
    assert.equal(
      isDirOnPath('/Users/alice/.local/bin', { HOME: '/Users/alice', PATH: '/usr/bin:/bin' }, 'linux'),
      false,
    );
    assert.equal(
      isDirOnPath(
        'C:\\Users\\Alice\\AppData\\Local\\agy\\bin',
        { Path: 'C:\\Windows;"c:\\users\\alice\\appdata\\local\\agy\\bin\\"' },
        'win32',
      ),
      true,
    );
    const hint = formatPathHint('/Users/alice/.local/bin', 'darwin');
    assert.equal(hint.includes('\n'), false);
    assert.ok(hint.includes('/Users/alice/.local/bin'));

    const trickyHint = formatPathHint('/tmp/$(id);foo', 'darwin');
    assert.ok(trickyHint.includes('export PATH=\'/tmp/$(id);foo\':"$PATH"'));
    assert.throws(() => formatPathHint('/tmp/bad\npath', 'darwin'), /newline/i);
  });

  await it('formats POSIX wrapper with v1 header, PATH-first exec node, realpath fallback, and rm diagnostic', () => {
    const cliPath = '/Users/alice/.gemini/config/plugins/agy-hud/dist/cli.mjs';
    const nodePath = '/opt/node/bin/node';
    const shimPath = '/Users/alice/.local/bin/agy-hud';
    const script = formatShimScriptPosix(cliPath, nodePath, shimPath);
    const lines = script.split('\n');
    assert.equal(lines[0], '#!/bin/sh');
    assert.equal(lines[1], `# ${SHIM_HEADER_VERSION} target=${cliPath}`);
    assert.ok(script.includes('exec node "$TARGET" "$@"'));
    assert.ok(script.includes('exec "$FALLBACK_NODE" "$TARGET" "$@"'));
    assert.ok(script.includes(`rm -- '\\''${shimPath}'\\''`));
    assert.equal(script.includes('\r'), false);
    assert.throws(() => formatShimScriptPosix(`${cliPath}\nbad`, nodePath, shimPath), /newline/i);
  });

  await it('single-quotes shell metacharacters in the POSIX shim missing-plugin cleanup hint', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-shim-rm-quote-');
    const missingCli = path.join(root, 'missing-plugin', 'dist', 'cli.mjs');
    const evilShimDir = path.join(root, 'bin-$(id)`uname`"x"');
    const evilShimPath = path.join(evilShimDir, 'agy-hud');
    mkdirSync(evilShimDir, { recursive: true });
    const script = formatShimScriptPosix(missingCli, process.execPath, evilShimPath);
    writeFileSync(evilShimPath, script, { mode: 0o755 });

    const res = spawnSync('/bin/sh', [evilShimPath], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes(`rm -- '${evilShimPath}'`), `expected single-quoted rm hint, got: ${res.stderr}`);
  });

  await it('formats Windows .cmd wrapper with v1 header, PATH-first where node, fallback node, and del diagnostic', () => {
    const cliPath = path.win32.join('C:\\Users\\alice', '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'cli.mjs');
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const shimPath = 'C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy-hud.cmd';
    const script = formatShimScriptCmd(cliPath, nodePath, shimPath);
    const lines = script.split('\r\n');
    assert.equal(lines[0], '@echo off');
    assert.equal(lines[1], `@rem ${SHIM_HEADER_VERSION} target=${cliPath}`);
    assert.ok(script.includes('where node >nul 2>nul'));
    assert.ok(script.includes('node "%TARGET%" %*'));
    assert.ok(script.includes('"%FALLBACK_NODE%" "%TARGET%" %*'));
    assert.ok(script.includes(`del "${shimPath}"`));
    assert.ok(script.includes('exit /b 1'));
  });
});

void describe('CLI shim inspection, preflight, atomic write/rollback, removal, and execution', async () => {
  await it('classifies missing, owned-self, owned-other, foreign, malformed, and incomplete-win-pair states', () => {
    const root = makeTempDir('agy-hud-shim-inspect-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    mkdirSync(binDir, { recursive: true });

    assert.equal(inspectCliShim(binDir, targetA, { HOME: root, PATH: binDir }, 'darwin').status, 'missing');

    const receipt = installCliShim(binDir, targetA, { HOME: root }, 'darwin');
    const selfInfo = inspectCliShim(binDir, targetA, { HOME: root, PATH: binDir }, 'darwin');
    assert.equal(selfInfo.status, 'owned-self');
    assert.equal(selfInfo.claimsSelf, true);
    if (process.platform !== 'win32') {
      assert.equal(selfInfo.executable, true);
    }
    assert.equal(selfInfo.onPath, true);
    assert.equal(inspectCliShim(binDir, targetB, { HOME: root }, 'darwin').status, 'owned-other');

    if (process.platform !== 'win32') {
      chmodSync(receipt.primaryPath, 0o644);
      assert.equal(inspectCliShim(binDir, targetA, { HOME: root }, 'darwin').executable, false);
    }

    writeFileSync(receipt.primaryPath, '#!/bin/sh\n# agy-hud-shim:v1 target=\n', 'utf8');
    assert.equal(inspectCliShim(binDir, targetA, { HOME: root }, 'darwin').status, 'malformed');

    writeFileSync(receipt.primaryPath, '#!/bin/sh\necho foreign\n', 'utf8');
    assert.equal(inspectCliShim(binDir, targetA, { HOME: root }, 'darwin').status, 'foreign');

    rmSync(receipt.primaryPath, { force: true });
    symlinkSync(path.join(root, 'somewhere'), receipt.primaryPath);
    assert.equal(inspectCliShim(binDir, targetA, { HOME: root }, 'darwin').status, 'foreign');

    // Windows incomplete pair check on real filesystem
    const winBin = path.join(root, 'win-bin');
    installCliShim(winBin, targetA, { USERPROFILE: root }, 'win32');
    const winPaths = resolveShimPaths(winBin, 'win32');
    assert.equal(inspectCliShim(winBin, targetA, { USERPROFILE: root }, 'win32').status, 'owned-self');
    rmSync(winPaths.posixPath, { force: true });
    const incomplete = inspectCliShim(winBin, targetA, { USERPROFILE: root }, 'win32');
    assert.equal(incomplete.status, 'incomplete-win-pair');
    assert.equal(incomplete.claimsSelf, true);
  });

  await it('refuses foreign files, symlinks, directories, and malformed headers in preflight', () => {
    const root = makeTempDir('agy-hud-shim-preflight-');
    const target = path.join(root, 'plugin');
    const binFile = path.join(root, 'bin-file');
    const binLink = path.join(root, 'bin-link');
    const binDirConflict = path.join(root, 'bin-dir');
    const binMalformed = path.join(root, 'bin-malformed');
    for (const d of [binFile, binLink, binDirConflict, binMalformed]) mkdirSync(d, { recursive: true });

    writeFileSync(path.join(binFile, 'agy-hud'), '#!/bin/sh\necho foreign\n', 'utf8');
    symlinkSync('/tmp/other-bin', path.join(binLink, 'agy-hud'));
    mkdirSync(path.join(binDirConflict, 'agy-hud'));
    writeFileSync(path.join(binMalformed, 'agy-hud'), '#!/bin/sh\n# agy-hud-shim:v1\n', 'utf8');

    assert.throws(() => assertShimWritablePreflight(binFile, target, 'darwin'), /--bin-dir.*--no-shim/i);
    assert.throws(() => assertShimWritablePreflight(binLink, target, 'darwin'), /foreign/i);
    assert.throws(() => assertShimWritablePreflight(binDirConflict, target, 'darwin'), /foreign/i);
    assert.throws(() => assertShimWritablePreflight(binMalformed, target, 'darwin'), /malformed/i);
  });

  await it('performs byte-verified rollback when re-pointing owned shims without clobbering concurrent writes', () => {
    const root = makeTempDir('agy-hud-shim-rb-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');

    const receiptA = installCliShim(binDir, targetA, { HOME: root }, 'darwin');
    const bytesA = readFileSync(receiptA.primaryPath);

    const receiptB = installCliShim(binDir, targetB, { HOME: root }, 'darwin');
    assert.ok(readFileSync(receiptB.primaryPath, 'utf8').includes(targetB));
    assert.deepEqual(runRollbackSteps(createShimRollbackSteps(receiptB)), []);
    assert.deepEqual(readFileSync(receiptA.primaryPath), bytesA);
    if (process.platform !== 'win32') {
      assert.equal(statSync(receiptA.primaryPath).mode & 0o777, 0o755);
    }

    // Concurrent external modification prevents rollback from clobbering newer file
    const receiptB2 = installCliShim(binDir, targetB, { HOME: root }, 'darwin');
    const externalBytes = Buffer.from('#!/bin/sh\necho external-update\n', 'utf8');
    writeFileSync(receiptB2.primaryPath, externalBytes);
    assert.deepEqual(runRollbackSteps(createShimRollbackSteps(receiptB2)), []);
    assert.deepEqual(readFileSync(receiptB2.primaryPath), externalBytes);
  });

  await it('removes owned shims even after target deletion, skips foreign/other, and supports removal rollback', () => {
    const root = makeTempDir('agy-hud-shim-rm-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    mkdirSync(targetA, { recursive: true });

    const receipt = installCliShim(binDir, targetA, { HOME: root }, 'darwin');
    const savedBytes = readFileSync(receipt.primaryPath);

    // Owned by A: removing for B must skip and preserve A's shim
    const skipOther = removeOwnedCliShim(binDir, targetB, { HOME: root }, 'darwin');
    assert.equal(skipOther.removed, false);
    assert.equal(skipOther.skippedReason, 'owned-other');
    assert.equal(existsSync(receipt.primaryPath), true);

    // Delete targetA first, then remove owned shim for A -> must still succeed and support rollback
    rmSync(targetA, { recursive: true, force: true });
    const removedA = removeOwnedCliShim(binDir, targetA, { HOME: root }, 'darwin');
    assert.equal(removedA.removed, true);
    assert.equal(existsSync(receipt.primaryPath), false);

    assert.deepEqual(runRollbackSteps(createShimRemovalRollbackSteps(removedA)), []);
    assert.deepEqual(readFileSync(receipt.primaryPath), savedBytes);

    // Foreign symlink is skipped cleanly
    rmSync(receipt.primaryPath, { force: true });
    symlinkSync('/tmp/foreign', receipt.primaryPath);
    const skipForeign = removeOwnedCliShim(binDir, targetA, { HOME: root }, 'darwin');
    assert.equal(skipForeign.removed, false);
    assert.equal(skipForeign.skippedReason, 'foreign');
    assert.equal(lstatSync(receipt.primaryPath).isSymbolicLink(), true);
  });

  await it('executes POSIX shim with PATH-first node, fallback node when PATH lacks node, and stderr diagnostic when target deleted', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-shim-exec-');
    const binDir = path.join(root, 'bin');
    const targetDir = path.join(root, 'plugin dir');
    const cliMjs = path.join(targetDir, 'dist', 'cli.mjs');
    mkdirSync(path.dirname(cliMjs), { recursive: true });
    writeFileSync(
      cliMjs,
      `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), ppid: process.ppid }) + '\\n');\n`,
      'utf8',
    );

    const receipt = installCliShim(binDir, targetDir, { HOME: root }, process.platform);
    const smoke = runCliShimSmoke(receipt.primaryPath);
    assert.equal(smoke.ok, true, smoke.detail);

    // PATH-first exec node preserves direct parent pid (zero extra ppid hops)
    const pathNodeRes = spawnSync(receipt.primaryPath, ['--help'], {
      env: { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    assert.equal(pathNodeRes.status, 0, pathNodeRes.stderr);
    const pathParsed = JSON.parse(pathNodeRes.stdout) as { argv: string[]; ppid: number };
    assert.equal(pathParsed.ppid, process.pid);

    // Fallback to install-time realpath node when PATH has no `node`, still with zero extra ppid hops
    const noNodeRes = spawnSync(receipt.primaryPath, ['--help', 'arg with space'], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    assert.equal(noNodeRes.status, 0, noNodeRes.stderr);
    const parsed = JSON.parse(noNodeRes.stdout) as { argv: string[]; ppid: number };
    assert.deepEqual(parsed.argv, ['--help', 'arg with space']);
    assert.equal(parsed.ppid, process.pid);

    // Simulate `agy plugin uninstall`: delete dist/cli.mjs and verify exit 1, stderr rm hint, and no self-deletion
    rmSync(cliMjs, { force: true });
    const missingRes = spawnSync(receipt.primaryPath, ['--help'], {
      env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    assert.equal(missingRes.status, 1);
    assert.equal(missingRes.stdout, '');
    assert.ok(missingRes.stderr.includes(`rm -- '${receipt.primaryPath}'`));
    assert.ok(missingRes.stderr.includes('agy plugin uninstall'));
    assert.equal(existsSync(receipt.primaryPath), true, 'stale shim must not self-delete');
  });
});
