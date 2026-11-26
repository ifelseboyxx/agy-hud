import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { installCliShim } from '../src/cli/installer/shim.ts';
import { getCliHomeLockPath, getShimBinLockPath, getTargetLockPath } from '../src/core/file-lock.ts';
import {
  createFakeAgyBin,
  createTempDirTracker,
  INSTALL_SCRIPT,
  makeIsolatedEnv,
  readJson,
  REPO_ROOT,
  type ScriptResult,
  spawnNodeAsync,
  waitForFile,
  writeJson,
} from './helpers.ts';

const tracker = createTempDirTracker();
const makeTempDir = (prefix: string): string => tracker.makeTempDir(prefix);

function spawnLockHolder(
  lockPath: string,
  enteredFlag: string,
  releaseFlag: string,
  env: NodeJS.ProcessEnv,
): Promise<ScriptResult> {
  const code = `import { existsSync, writeFileSync } from 'node:fs';
import { withFileLocksSync } from './src/core/file-lock.ts';
const cell = new Int32Array(new SharedArrayBuffer(4));
withFileLocksSync([${JSON.stringify(lockPath)}], () => {
  writeFileSync(${JSON.stringify(enteredFlag)}, 'held', 'utf8');
  while (!existsSync(${JSON.stringify(releaseFlag)})) Atomics.wait(cell, 0, 0, 15);
}, 10_000);
`;
  return spawnNodeAsync(['--input-type=module', '-e', code], env);
}

afterEach(() => {
  tracker.cleanup();
});

void describe('installer target/cliHome lock intersection and escalation', async () => {
  await it('blocks `on` on target lock during unvalidated install and fast-fails when target parent dir does not exist', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-on-race-');
    const missingParent = path.join(root, 'brand-new-plugins-dir');
    const missingTarget = path.join(missingParent, 'agy-hud');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/on-race.py', enabled: true };
    writeJson(settingsPath, { model: 'Gemini 4 Carbon', statusLine: priorSl });
    const envOn = makeIsolatedEnv(root);

    const fastFail = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, 'on', '--target', missingTarget, '--no-enable', '--quiet'],
      { cwd: REPO_ROOT, env: envOn, encoding: 'utf8' },
    );
    assert.notEqual(fastFail.status, 0);
    assert.match(fastFail.stderr, /Missing .*hud\.mjs/i);
    assert.equal(existsSync(missingParent), false, '`on` must not create non-existent target parent directory');

    const targetDir = path.join(root, 'installed-plugin');
    const enteredFlag = path.join(root, 'install-in-doctor.flag');
    const releaseFlag = path.join(root, 'install-release.flag');
    const binA = createFakeAgyBin(
      root,
      'inst-fail',
      `  echo "entered" > ${JSON.stringify(enteredFlag)}
  while [ ! -f ${JSON.stringify(releaseFlag)} ]; do sleep 0.02; done
  echo "doctor fail" >&2
  exit 1`,
    );
    const envInstall = makeIsolatedEnv(root, { PATH: `${binA}${path.delimiter}${process.env.PATH ?? ''}` });

    const procInstall = spawnNodeAsync(
      [INSTALL_SCRIPT, 'install', '--target', targetDir, '--no-enable', '--quiet'],
      envInstall,
    );
    await waitForFile(enteredFlag, procInstall);

    let onSettled = false;
    const procOn = spawnNodeAsync([INSTALL_SCRIPT, 'on', '--target', targetDir, '--no-enable', '--quiet'], envOn).then(
      (res) => {
        onSettled = true;
        return res;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(onSettled, false, '`on` must wait on target lock while install is still validating in doctor');
    writeFileSync(releaseFlag, 'go', 'utf8');

    const [resInstall, resOn] = await Promise.all([procInstall, procOn]);
    assert.notEqual(resInstall.status, 0);
    assert.notEqual(resOn.status, 0, '`on` must fail after failed install rolled back targetDir');
    assert.equal(existsSync(targetDir), false);
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);
    assert.equal(existsSync(backupPath), false);
  });

  await it('escalates uninstall locks to cliHomeLock when cliHome appears concurrently', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-uninst-escalate-');
    const targetDir = path.join(root, 'a-plugin');
    const cliHome = path.join(root, 'z-home', '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/escalate.py', enabled: true };
    const env = makeIsolatedEnv(path.join(root, 'z-home'));
    assert.equal(existsSync(cliHome), false);

    const targetEntered = path.join(root, 'target-lock-entered.flag');
    const targetRelease = path.join(root, 'target-lock-release.flag');
    const cliEntered = path.join(root, 'cli-lock-entered.flag');
    const cliRelease = path.join(root, 'cli-lock-release.flag');

    const procTargetHold = spawnLockHolder(getTargetLockPath(targetDir), targetEntered, targetRelease, env);
    await waitForFile(targetEntered, procTargetHold);

    let uninstSettled = false;
    const procUninst = spawnNodeAsync(
      [INSTALL_SCRIPT, 'uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
      env,
    ).then((res) => {
      uninstSettled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(uninstSettled, false, 'uninstall must wait on targetLock');
    assert.equal(existsSync(cliHome), false, 'uninstall must not create missing cliHome before locking');

    writeJson(path.join(targetDir, 'plugin.json'), { name: 'agy-hud' });
    const hudCmd = path.join(targetDir, 'dist', 'hud.mjs');
    writeJson(settingsPath, {
      model: 'Gemini 4 Carbon',
      statusLine: { type: 'command', command: hudCmd, enabled: true, stack_with_default: false },
    });
    writeJson(backupPath, {
      wiredCommand: hudCmd,
      hadStatusLine: true,
      previousStatusLine: priorSl,
      savedAt: new Date().toISOString(),
    });

    const procCliHold = spawnLockHolder(getCliHomeLockPath(cliHome), cliEntered, cliRelease, env);
    await waitForFile(cliEntered, procCliHold);

    writeFileSync(targetRelease, 'go', 'utf8');
    await procTargetHold;

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(uninstSettled, false, 'uninstall must escalate to cliHomeLock once cliHome appears concurrently');
    const updatedPriorSl = { type: 'command', command: '/prior/escalate-after-lock.py', enabled: true };
    writeJson(backupPath, {
      wiredCommand: hudCmd,
      hadStatusLine: true,
      previousStatusLine: updatedPriorSl,
      savedAt: new Date().toISOString(),
    });
    writeFileSync(cliRelease, 'go', 'utf8');
    await procCliHold;

    const resUninst = await procUninst;
    assert.equal(resUninst.status, 0, resUninst.stderr);
    assert.equal(existsSync(targetDir), false);
    assert.deepEqual(readJson(settingsPath).statusLine, updatedPriorSl);
    assert.equal(existsSync(backupPath), false);
  });

  await it('escalates uninstall locks to binDirLock when binDir appears concurrently', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-uninst-bin-escalate-');
    const targetA = path.join(root, 'a-plugin');
    const targetB = path.join(root, 'b-plugin');
    const sharedBin = path.join(root, 'z-bin');
    const env = makeIsolatedEnv(path.join(root, 'home-a'));
    assert.equal(existsSync(sharedBin), false);

    const targetEntered = path.join(root, 'target-entered.flag');
    const targetRelease = path.join(root, 'target-release.flag');
    const binEntered = path.join(root, 'bin-entered.flag');
    const binRelease = path.join(root, 'bin-release.flag');

    const procTargetHold = spawnLockHolder(getTargetLockPath(targetA), targetEntered, targetRelease, env);
    let procBinHold: Promise<ScriptResult> | null = null;
    let procUninst: Promise<ScriptResult> | null = null;
    try {
      await waitForFile(targetEntered, procTargetHold);

      let uninstSettled = false;
      procUninst = spawnNodeAsync(
        [INSTALL_SCRIPT, 'uninstall', '--target', targetA, '--bin-dir', sharedBin, '--no-enable', '--quiet'],
        env,
      ).then((res) => {
        uninstSettled = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(uninstSettled, false, 'uninstall must wait on targetLock');
      assert.equal(existsSync(sharedBin), false, 'uninstall must not create missing binDir before locking');

      writeJson(path.join(targetA, 'plugin.json'), { name: 'agy-hud' });
      const shimA = installCliShim(sharedBin, targetA, env);
      assert.equal(existsSync(shimA.primaryPath), true);

      procBinHold = spawnLockHolder(getShimBinLockPath(sharedBin), binEntered, binRelease, env);
      await waitForFile(binEntered, procBinHold);

      writeFileSync(targetRelease, 'go', 'utf8');
      await procTargetHold;

      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(uninstSettled, false, 'uninstall must escalate to binDirLock once binDir appears concurrently');

      const shimB = installCliShim(sharedBin, targetB, env);
      const bytesB = readFileSync(shimB.primaryPath);
      writeFileSync(binRelease, 'go', 'utf8');
      await procBinHold;

      const resUninst = await procUninst;
      assert.equal(resUninst.status, 0, resUninst.stderr);
      assert.equal(existsSync(targetA), false);
      assert.deepEqual(readFileSync(shimB.primaryPath), bytesB);
    } finally {
      if (!existsSync(targetRelease)) writeFileSync(targetRelease, 'go', 'utf8');
      if (!existsSync(binRelease)) writeFileSync(binRelease, 'go', 'utf8');
      await Promise.allSettled([
        procTargetHold,
        ...(procBinHold ? [procBinHold] : []),
        ...(procUninst ? [procUninst] : []),
      ]);
    }
  });
});
