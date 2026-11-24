import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createFakeAgyBin,
  createTempDirTracker,
  INSTALL_SCRIPT,
  makeIsolatedEnv,
  readJson,
  spawnNodeScriptAsync,
  writeJson,
  type ScriptResult,
} from './helpers.ts';

function runInstallAsync(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  return spawnNodeScriptAsync(INSTALL_SCRIPT, args, env);
}

function makeFastEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const okBin = createFakeAgyBin(root, 'ok', '  exit 0');
  return makeIsolatedEnv(root, {
    PATH: `${okBin}${path.delimiter}${process.env.PATH ?? ''}`,
    ...extra,
  });
}

void describe('CLI shim rollback safety and doctor diagnostics', { concurrency: true }, () => {
  void it('rolls back repointed shim atomically on post-install doctor failure', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-shim-rb-e2e-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    const shimPath = path.join(binDir, 'agy-hud');
    const env = makeFastEnv(root);

    assert.equal(
      (await runInstallAsync(['install', '--target', targetA, '--bin-dir', binDir, '--no-enable', '--quiet'], env))
        .status,
      0,
    );
    const bytesA = readFileSync(shimPath);

    const failBin = createFakeAgyBin(root, 'fail-rb', '  echo "doctor fail" >&2\n  exit 1');
    const envFail = makeIsolatedEnv(root, { PATH: `${failBin}${path.delimiter}${process.env.PATH ?? ''}` });
    const resB = await runInstallAsync(
      ['install', '--target', targetB, '--bin-dir', binDir, '--wire-statusline', '--no-enable', '--quiet'],
      envFail,
    );
    assert.notEqual(resB.status, 0);
    assert.equal(existsSync(targetB), false);
    assert.deepEqual(readFileSync(shimPath), bytesA);
    assert.equal(statSync(shimPath).mode & 0o777, 0o755);
  });

  void it('preserves concurrent external shim edits during failed install rollback', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-shim-rb-ext-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    const shimPath = path.join(binDir, 'agy-hud');
    const env = makeFastEnv(root);

    assert.equal(
      (await runInstallAsync(['install', '--target', targetA, '--bin-dir', binDir, '--no-enable', '--quiet'], env))
        .status,
      0,
    );
    const externalShim = '#!/bin/sh\necho concurrent-winner\n';
    const mutateBin = createFakeAgyBin(
      root,
      'mutate-rb',
      `  "${process.execPath}" -e 'import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(shimPath)}, ${JSON.stringify(externalShim)}, "utf8"))'
  echo "doctor fail" >&2
  exit 1`,
    );
    const envMutate = makeIsolatedEnv(root, { PATH: `${mutateBin}${path.delimiter}${process.env.PATH ?? ''}` });
    const resB = await runInstallAsync(
      ['install', '--target', targetB, '--bin-dir', binDir, '--no-enable', '--quiet'],
      envMutate,
    );
    assert.notEqual(resB.status, 0);
    assert.equal(readFileSync(shimPath, 'utf8'), externalShim);
  });

  void it('rolls back statusLine and shim changes when wire doctor fails', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-wire-rb-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    const settingsPath = path.join(root, '.gemini', 'antigravity-cli', 'settings.json');
    const shimPath = path.join(binDir, 'agy-hud');
    const priorSl = { type: 'command', command: '/prior/user-hud.sh', enabled: true };
    const env = makeFastEnv(root);

    writeJson(settingsPath, { statusLine: priorSl });
    assert.equal(
      (await runInstallAsync(['install', '--target', targetA, '--bin-dir', binDir, '--no-enable', '--quiet'], env))
        .status,
      0,
    );
    assert.equal((await runInstallAsync(['install', '--target', targetB, '--no-enable', '--quiet'], env)).status, 0);
    const bytesA = readFileSync(shimPath);

    const failBin = createFakeAgyBin(root, 'wire-fail', '  echo "wire doctor fail" >&2\n  exit 1');
    const envFail = makeIsolatedEnv(root, { PATH: `${failBin}${path.delimiter}${process.env.PATH ?? ''}` });
    const wireFail = await runInstallAsync(
      ['wire', '--target', targetB, '--bin-dir', binDir, '--no-enable', '--quiet'],
      envFail,
    );
    assert.notEqual(wireFail.status, 0);
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);
    assert.deepEqual(readFileSync(shimPath), bytesA);
  });

  void it('restores plugin target and removed shim on mid-uninstall error', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-uninst-rb-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const cacheDir = path.join(cliHome, 'cache');
    const shimPath = path.join(binDir, 'agy-hud');
    const env = makeFastEnv(root);

    assert.equal((await runInstallAsync(['install', '--target', targetA, '--no-enable', '--quiet'], env)).status, 0);
    assert.equal(
      (await runInstallAsync(['wire', '--target', targetA, '--bin-dir', binDir, '--no-enable', '--quiet'], env)).status,
      0,
    );
    const wiredBytesA = readFileSync(shimPath);
    chmodSync(cacheDir, 0o555);
    try {
      const uninstFail = await runInstallAsync(
        ['uninstall', '--target', targetA, '--bin-dir', binDir, '--restore-statusline', '--no-enable', '--quiet'],
        env,
      );
      if (process.getuid?.() !== 0) {
        assert.notEqual(uninstFail.status, 0);
        assert.equal(existsSync(targetA), true, 'target must be restored on mid-uninstall error');
        assert.deepEqual(readFileSync(shimPath), wiredBytesA, 'removed shim must be restored on mid-uninstall error');
      }
    } finally {
      chmodSync(cacheDir, 0o755);
    }
  });

  void it('keeps standalone doctor informational for non-owned shims', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-doctor-info-');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    const binDir = path.join(root, 'bin');
    const shimPath = path.join(binDir, 'agy-hud');
    const env = makeFastEnv(root);

    assert.equal((await runInstallAsync(['install', '--target', targetA, '--no-enable', '--quiet'], env)).status, 0);
    assert.equal((await runInstallAsync(['install', '--target', targetB, '--no-enable', '--quiet'], env)).status, 0);

    const missingDoc = await runInstallAsync(['doctor', '--target', targetA, '--bin-dir', binDir], env);
    assert.equal(missingDoc.status, 0, missingDoc.stdout);
    assert.ok(missingDoc.stdout.includes('not installed'));

    mkdirSync(binDir, { recursive: true });
    writeFileSync(shimPath, '#!/bin/sh\necho foreign\n', 'utf8');
    const foreignDoc = await runInstallAsync(['doctor', '--target', targetA, '--bin-dir', binDir], env);
    assert.equal(foreignDoc.status, 0, foreignDoc.stdout);
    assert.ok(foreignDoc.stdout.includes('foreign'));

    writeFileSync(shimPath, '#!/bin/sh\n# agy-hud-shim:v1 target=\n', 'utf8');
    const malformedDoc = await runInstallAsync(['doctor', '--target', targetA, '--bin-dir', binDir], env);
    assert.equal(malformedDoc.status, 0, malformedDoc.stdout);
    assert.ok(malformedDoc.stdout.includes('malformed'));

    rmSync(shimPath, { force: true });
    assert.equal(
      (await runInstallAsync(['wire', '--target', targetB, '--bin-dir', binDir, '--no-enable', '--quiet'], env)).status,
      0,
    );
    const otherDoc = await runInstallAsync(['doctor', '--target', targetA, '--bin-dir', binDir], env);
    assert.equal(otherDoc.status, 0, otherDoc.stdout);
    assert.ok(otherDoc.stdout.includes('owned by other install'));
  });

  void it('fails doctor on broken owned shims unless --no-shim is passed', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-doctor-block-');
    const targetB = path.join(root, 'plugin-b');
    const binDir = path.join(root, 'bin');
    const shimPath = path.join(binDir, 'agy-hud');
    const env = makeFastEnv(root);

    assert.equal((await runInstallAsync(['install', '--target', targetB, '--no-enable', '--quiet'], env)).status, 0);
    assert.equal(
      (await runInstallAsync(['wire', '--target', targetB, '--bin-dir', binDir, '--no-enable', '--quiet'], env)).status,
      0,
    );

    const selfDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir], env);
    assert.equal(selfDoc.status, 0, selfDoc.stdout);
    assert.ok(selfDoc.stdout.includes('OK'));
    assert.ok(selfDoc.stdout.includes('not on PATH'));

    chmodSync(shimPath, 0o644);
    const nonExecDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir], env);
    assert.notEqual(nonExecDoc.status, 0);

    const noShimDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir, '--no-shim'], env);
    assert.equal(noShimDoc.status, 0, noShimDoc.stdout);

    chmodSync(shimPath, 0o755);
    const targetCli = path.join(targetB, 'dist', 'cli.mjs');
    writeFileSync(shimPath, `#!/usr/bin/env sh\n# agy-hud-shim:v1 target=${targetCli}\n`, 'utf8');
    const claimingMalformed = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir], env);
    assert.notEqual(claimingMalformed.status, 0);

    rmSync(shimPath, { force: true });
    assert.equal(
      (await runInstallAsync(['wire', '--target', targetB, '--bin-dir', binDir, '--no-enable', '--quiet'], env)).status,
      0,
    );
    rmSync(targetCli, { force: true });
    const missingCliDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir], env);
    assert.notEqual(missingCliDoc.status, 0);
    assert.ok(missingCliDoc.stdout.includes('missing'));
  });
});
