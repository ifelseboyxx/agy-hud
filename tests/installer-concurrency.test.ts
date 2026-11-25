import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createTempDirTracker,
  INSTALL_SCRIPT,
  makeFastIsolatedEnv as makeIsolatedEnv,
  readJson,
  runNodeScript,
  writeJson,
} from './helpers.ts';

const tracker = createTempDirTracker();
const makeTempDir = (prefix: string): string => tracker.makeTempDir(prefix);

afterEach(() => {
  tracker.cleanup();
});

void describe('installer symlink, backup state machine, and rollback safety', async () => {
  await it('preserves dangling settings.json symlinks across install, on, off, and uninstall', () => {
    const root = makeTempDir('agy-hud-dangling-inst-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const env = makeIsolatedEnv(root);

    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['install', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );

    mkdirSync(cliHome, { recursive: true });
    symlinkSync(path.join(root, 'missing-dotfiles-settings.json'), settingsPath);

    assert.notEqual(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.equal(lstatSync(settingsPath).isSymbolicLink(), true, 'install must not overwrite dangling settings.json');

    assert.notEqual(
      runNodeScript(INSTALL_SCRIPT, ['on', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );
    assert.notEqual(
      runNodeScript(INSTALL_SCRIPT, ['off', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );
    assert.notEqual(
      runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
  });

  await it('keeps backup consistent across delete -> off -> on and foreign statusLine off', () => {
    const root = makeTempDir('agy-hud-state-machine-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const env = makeIsolatedEnv(root);
    const staleFirstSl = { type: 'command', command: '/stale/first.py', enabled: true };
    const foreignSl = { type: 'command', command: '/foreign/custom.sh', enabled: true };

    writeJson(settingsPath, { statusLine: staleFirstSl });
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      ).status,
      0,
    );

    // User runs /statusline delete (statusLine removed), then toggles off -> on -> uninstall --restore-statusline.
    writeJson(settingsPath, { model: 'Gemini 4 Carbon' });
    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['off', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );
    assert.equal(runNodeScript(INSTALL_SCRIPT, ['on', '--target', targetDir, '--no-enable', '--quiet'], env).status, 0);
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.equal(
      readJson(settingsPath).statusLine,
      undefined,
      'uninstall must not resurrect stale backup after statusLine was deleted prior to off -> on',
    );

    // Reinstall without wiring; foreign statusLine must not be disabled by off.
    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['install', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );
    writeJson(settingsPath, { statusLine: foreignSl });
    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['off', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );
    assert.deepEqual(readJson(settingsPath).statusLine, foreignSl, 'off must not mutate foreign statusLine');
  });

  await it('rolls back backupPath when `on` fails to write settings.json', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = makeTempDir('agy-hud-on-rb-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const env = makeIsolatedEnv(root);

    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['install', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );

    const priorBackup = { wiredCommand: '/old/hud.mjs', hadStatusLine: true, previousStatusLine: { command: '/a' } };
    writeJson(settingsPath, { statusLine: { type: 'command', command: '/new/custom.py', enabled: true } });
    writeJson(backupPath, priorBackup);
    chmodSync(cliHome, 0o555);
    try {
      const onRes = runNodeScript(INSTALL_SCRIPT, ['on', '--target', targetDir, '--no-enable', '--quiet'], env);
      assert.notEqual(onRes.status, 0);
      assert.deepEqual(readJson(backupPath), priorBackup, 'backupPath must roll back when settings.json write fails');
    } finally {
      chmodSync(cliHome, 0o755);
    }
  });

  await it('prechecks locked upgrade subdirectories before staging .prev.*', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = makeTempDir('agy-hud-locked-upg-');
    const targetDir = path.join(root, 'installed-plugin');
    const env = makeIsolatedEnv(root);

    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['install', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );

    const lockedSub = path.join(targetDir, 'dist', 'locked');
    mkdirSync(lockedSub, { recursive: true });
    writeFileSync(path.join(lockedSub, 'f.txt'), 'x', 'utf8');
    chmodSync(lockedSub, 0o555);
    try {
      const upgRes = runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      );
      assert.notEqual(upgRes.status, 0);
      const strayPrev = readdirSync(root).filter((n) => n.includes('.prev.'));
      assert.deepEqual(strayPrev, [], 'locked upgrade must fail before moving target to .prev.*');
    } finally {
      if (existsSync(lockedSub)) chmodSync(lockedSub, 0o755);
    }
  });

  await it('protects concurrent target replacement during rollback via dev/ino identity guard', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = makeTempDir('agy-hud-conc-race-');
    const freshTarget = path.join(root, 'concurrent-plugin');
    const binDir = path.join(root, 'race-bin');
    mkdirSync(binDir, { recursive: true });
    const raceAgy = path.join(binDir, 'agy');
    writeFileSync(
      raceAgy,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy 1.5.14"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "validate" ]; then
  rm -rf "$3"
  mkdir -p "$3"
  echo '{"name":"agy-hud","version":"9.9.9"}' > "$3/plugin.json"
  echo "concurrent-winner" > "$3/winner.txt"
  exit 1
fi
exit 0
`,
      'utf8',
    );
    chmodSync(raceAgy, 0o755);

    const raceEnv = makeIsolatedEnv(root, { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` });
    const raceRes = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', freshTarget, '--no-enable', '--quiet'],
      raceEnv,
    );
    assert.notEqual(raceRes.status, 0);
    assert.equal(
      existsSync(path.join(freshTarget, 'winner.txt')),
      true,
      'rollback must not delete concurrent target with different dev/ino',
    );
  });
});
