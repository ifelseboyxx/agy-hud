import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createFakeAgyBin,
  createTempDirTracker,
  INSTALL_SCRIPT,
  makeIsolatedEnv,
  readJson,
  spawnNodeAsync,
  waitForFile,
  writeJson,
} from './helpers.ts';

const tracker = createTempDirTracker();
const makeTempDir = (prefix: string): string => tracker.makeTempDir(prefix);

afterEach(() => {
  tracker.cleanup();
});

void describe('installer resource-scoped locks, stale reclamation, and CLI home coordination', async () => {
  await it('serializes concurrent upgrades on the same target even when processes use different TMPDIRs', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-diff-tmpdir-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const tmpA = path.join(root, 'tmp-a');
    const tmpB = path.join(root, 'tmp-b');
    mkdirSync(tmpA, { recursive: true });
    mkdirSync(tmpB, { recursive: true });

    const priorSl = { type: 'command', command: '/prior/tmpdir-hud.py', enabled: true };
    writeJson(path.join(targetDir, 'plugin.json'), { name: 'agy-hud', version: '0.0.1-stable' });
    writeFileSync(path.join(targetDir, 'sentinel.txt'), 'stable-v1', 'utf8');
    writeJson(settingsPath, { model: 'Gemini 4 Carbon', statusLine: priorSl });

    const aEntered = path.join(root, 'a-entered.flag');
    const aRelease = path.join(root, 'a-release.flag');
    const bEntered = path.join(root, 'b-entered.flag');
    const binA = createFakeAgyBin(
      root,
      'a',
      `  echo "entered" > ${JSON.stringify(aEntered)}
  while [ ! -f ${JSON.stringify(aRelease)} ]; do sleep 0.02; done
  echo "simulated A failure" >&2
  exit 1`,
    );
    const binB = createFakeAgyBin(
      root,
      'b',
      `  echo "entered" > ${JSON.stringify(bEntered)}
  echo "simulated B failure" >&2
  exit 1`,
    );

    const envA = makeIsolatedEnv(root, {
      TMPDIR: tmpA,
      PATH: `${binA}${path.delimiter}${process.env.PATH ?? ''}`,
    });
    const envB = makeIsolatedEnv(root, {
      TMPDIR: tmpB,
      PATH: `${binB}${path.delimiter}${process.env.PATH ?? ''}`,
    });

    const procA = spawnNodeAsync(
      [INSTALL_SCRIPT, 'install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      envA,
    );
    await waitForFile(aEntered, procA);

    const procB = spawnNodeAsync(
      [INSTALL_SCRIPT, 'install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      envB,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(bEntered), false, 'install B under different TMPDIR must still wait for install A lock');
    writeFileSync(aRelease, 'go', 'utf8');

    const [resA, resB] = await Promise.all([procA, procB]);
    assert.notEqual(resA.status, 0);
    assert.notEqual(resB.status, 0);
    assert.equal(existsSync(bEntered), true);
    assert.equal(readJson(path.join(targetDir, 'plugin.json')).version, '0.0.1-stable');
    assert.equal(readFileSync(path.join(targetDir, 'sentinel.txt'), 'utf8'), 'stable-v1');
    assert.deepEqual(
      readdirSync(root).filter((n) => n.includes('.prev.')),
      [],
      'no stranded .prev.* should remain across different TMPDIRs',
    );
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);
    assert.equal(existsSync(backupPath), false);
  });

  await it('serializes different targets sharing one CLI home on cliHomeLock', async () => {
    if (process.platform === 'win32') return;

    // 1. Two different targets concurrently wiring the same CLI home and both failing doctor:
    //    both target dirs must be removed AND settings.json must revert cleanly to priorSl (never pointing to deleted targetA).
    const root1 = makeTempDir('agy-hud-shared-cli-');
    const targetA = path.join(root1, 'plugin-a');
    const targetB = path.join(root1, 'plugin-b');
    const cliHome1 = path.join(root1, '.gemini', 'antigravity-cli');
    const settingsPath1 = path.join(cliHome1, 'settings.json');
    const backupPath1 = path.join(cliHome1, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/shared-cli.py', enabled: true };
    writeJson(settingsPath1, { model: 'Gemini 4 Carbon', statusLine: priorSl });

    const aEntered1 = path.join(root1, 'a-entered.flag');
    const aRelease1 = path.join(root1, 'a-release.flag');
    const bEntered1 = path.join(root1, 'b-entered.flag');
    const binA1 = createFakeAgyBin(
      root1,
      'a1',
      `  echo "entered" > ${JSON.stringify(aEntered1)}
  while [ ! -f ${JSON.stringify(aRelease1)} ]; do sleep 0.02; done
  echo "A doctor fail" >&2
  exit 1`,
    );
    const binB1 = createFakeAgyBin(
      root1,
      'b1',
      `  echo "entered" > ${JSON.stringify(bEntered1)}
  echo "B doctor fail" >&2
  exit 1`,
    );

    const envA1 = makeIsolatedEnv(root1, { PATH: `${binA1}${path.delimiter}${process.env.PATH ?? ''}` });
    const envB1 = makeIsolatedEnv(root1, { PATH: `${binB1}${path.delimiter}${process.env.PATH ?? ''}` });

    const procA1 = spawnNodeAsync(
      [INSTALL_SCRIPT, 'install', '--target', targetA, '--no-enable', '--wire-statusline', '--quiet'],
      envA1,
    );
    await waitForFile(aEntered1, procA1);

    const procB1 = spawnNodeAsync(
      [INSTALL_SCRIPT, 'install', '--target', targetB, '--no-enable', '--wire-statusline', '--quiet'],
      envB1,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(bEntered1), false, 'targetB wiring same CLI home must wait for targetA transaction');
    writeFileSync(aRelease1, 'go', 'utf8');

    const [resA1, resB1] = await Promise.all([procA1, procB1]);
    assert.notEqual(resA1.status, 0);
    assert.notEqual(resB1.status, 0);
    assert.equal(existsSync(targetA), false);
    assert.equal(existsSync(targetB), false);
    assert.deepEqual(
      readJson(settingsPath1).statusLine,
      priorSl,
      'settings.json must revert to priorSl rather than pointing to deleted targetA',
    );
    assert.equal(existsSync(backupPath1), false);
  });
});
