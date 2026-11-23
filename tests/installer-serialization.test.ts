import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createFakeAgyBin,
  createTempDirTracker,
  INSTALL_SCRIPT,
  makeIsolatedEnv,
  readJson,
  spawnNodeScriptAsync,
  waitForFile,
  writeJson,
} from './helpers.ts';

const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

void describe('installer same-target concurrency serialization', async () => {
  await it('rolls back cleanly to v1 when two concurrent upgrades both fail doctor', async () => {
    if (process.platform === 'win32') return;

    const root = tracker.makeTempDir('agy-hud-conc-bothfail-');
    const target = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/user-hud.py', enabled: true };
    writeJson(path.join(target, 'plugin.json'), { name: 'agy-hud', version: '0.0.1-working' });
    writeFileSync(path.join(target, 'sentinel.txt'), 'working-v1', 'utf8');
    writeJson(settingsPath, { model: 'Gemini 4 Carbon', statusLine: priorSl });

    const aEntered = path.join(root, 'a-in-doctor.flag');
    const aRelease = path.join(root, 'a-release.flag');
    const binA = createFakeAgyBin(
      root,
      'a-fail',
      `  echo "entered" > ${JSON.stringify(aEntered)}
  while [ ! -f ${JSON.stringify(aRelease)} ]; do sleep 0.02; done
  echo "simulated A doctor fail" >&2
  exit 1`,
    );
    const bEntered = path.join(root, 'b-in-doctor.flag');
    const binB = createFakeAgyBin(
      root,
      'b-fail',
      `  echo "entered" > ${JSON.stringify(bEntered)}
  echo "simulated B doctor fail" >&2
  exit 1`,
    );

    const envA = makeIsolatedEnv(root, { PATH: `${binA}${path.delimiter}${process.env.PATH ?? ''}` });
    const envB = makeIsolatedEnv(root, { PATH: `${binB}${path.delimiter}${process.env.PATH ?? ''}` });

    const procA = spawnNodeScriptAsync(
      INSTALL_SCRIPT,
      ['install', '--target', target, '--no-enable', '--wire-statusline', '--quiet'],
      envA,
    );
    await waitForFile(aEntered, procA);
    const procB = spawnNodeScriptAsync(
      INSTALL_SCRIPT,
      ['install', '--target', target, '--no-enable', '--wire-statusline', '--quiet'],
      envB,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(existsSync(bEntered), false, 'install B must wait on target lock until install A finishes rollback');
    writeFileSync(aRelease, 'go', 'utf8');

    const [resA, resB] = await Promise.all([procA, procB]);
    assert.equal(existsSync(bEntered), true, 'install B must run after install A releases target lock');
    assert.notEqual(resA.status, 0);
    assert.notEqual(resB.status, 0);
    assert.equal(readJson(path.join(target, 'plugin.json')).version, '0.0.1-working');
    assert.equal(readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'working-v1');
    assert.deepEqual(
      readdirSync(root).filter((n) => n.includes('.prev.')),
      [],
    );
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);
    assert.equal(existsSync(backupPath), false);
  });

  await it('keeps non-wiring install B intact while rolling back failed wiring install A', async () => {
    if (process.platform === 'win32') return;

    const root = tracker.makeTempDir('agy-hud-conc-nowire-b-');
    const target = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/user-hud.py', enabled: true };
    writeJson(settingsPath, { model: 'Gemini 4 Carbon', statusLine: priorSl });

    const aEntered = path.join(root, 'a-in-doctor.flag');
    const aRelease = path.join(root, 'a-release.flag');
    const binA = createFakeAgyBin(
      root,
      'a-fail-2',
      `  echo "entered" > ${JSON.stringify(aEntered)}
  while [ ! -f ${JSON.stringify(aRelease)} ]; do sleep 0.02; done
  echo "simulated A doctor fail" >&2
  exit 1`,
    );
    const binB = createFakeAgyBin(root, 'b-ok', '  exit 0');

    const envA = makeIsolatedEnv(root, { PATH: `${binA}${path.delimiter}${process.env.PATH ?? ''}` });
    const envB = makeIsolatedEnv(root, { PATH: `${binB}${path.delimiter}${process.env.PATH ?? ''}` });

    const procA = spawnNodeScriptAsync(
      INSTALL_SCRIPT,
      ['install', '--target', target, '--no-enable', '--wire-statusline', '--quiet'],
      envA,
    );
    await waitForFile(aEntered, procA);
    const procB = spawnNodeScriptAsync(INSTALL_SCRIPT, ['install', '--target', target, '--no-enable', '--quiet'], envB);
    await new Promise((resolve) => setTimeout(resolve, 120));
    writeFileSync(aRelease, 'go', 'utf8');

    const [resA, resB] = await Promise.all([procA, procB]);
    assert.notEqual(resA.status, 0);
    assert.equal(resB.status, 0, resB.stderr);
    assert.equal(existsSync(path.join(target, 'dist', 'hud.mjs')), true);
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);
    assert.equal(existsSync(backupPath), false);
  });

  await it('preserves wiring install B after failed wiring install A rolls back', async () => {
    if (process.platform === 'win32') return;

    const root = tracker.makeTempDir('agy-hud-conc-wire-b-');
    const target = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/user-hud.py', enabled: true };
    writeJson(settingsPath, { model: 'Gemini 4 Carbon', statusLine: priorSl });

    const aEntered = path.join(root, 'a-in-doctor.flag');
    const aRelease = path.join(root, 'a-release.flag');
    const binA = createFakeAgyBin(
      root,
      'a-fail-3',
      `  echo "entered" > ${JSON.stringify(aEntered)}
  while [ ! -f ${JSON.stringify(aRelease)} ]; do sleep 0.02; done
  echo "simulated A doctor fail" >&2
  exit 1`,
    );
    const binB = createFakeAgyBin(root, 'b-ok-3', '  exit 0');

    const envA = makeIsolatedEnv(root, { PATH: `${binA}${path.delimiter}${process.env.PATH ?? ''}` });
    const envB = makeIsolatedEnv(root, { PATH: `${binB}${path.delimiter}${process.env.PATH ?? ''}` });

    const procA = spawnNodeScriptAsync(
      INSTALL_SCRIPT,
      ['install', '--target', target, '--no-enable', '--wire-statusline', '--quiet'],
      envA,
    );
    await waitForFile(aEntered, procA);
    const procB = spawnNodeScriptAsync(
      INSTALL_SCRIPT,
      ['install', '--target', target, '--no-enable', '--wire-statusline', '--quiet'],
      envB,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    writeFileSync(aRelease, 'go', 'utf8');

    const [resA, resB] = await Promise.all([procA, procB]);
    assert.notEqual(resA.status, 0);
    assert.equal(resB.status, 0, resB.stderr);
    assert.equal(existsSync(path.join(target, 'dist', 'hud.mjs')), true);
    assert.equal(
      (readJson(settingsPath).statusLine as Record<string, unknown>).command,
      path.join(target, 'dist', 'hud.mjs'),
    );
    assert.equal(existsSync(backupPath), true);
    assert.deepEqual(readJson(backupPath).previousStatusLine, priorSl);
  });
});
