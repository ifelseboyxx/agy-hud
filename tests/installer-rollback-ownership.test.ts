import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { formatStatusLineCommand } from '../src/core/statusline-ownership.ts';
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

function createFailingDoctorAgyWithMutator(root: string, name: string, mutatorSource: string): string {
  const binDir = path.join(root, `fake-bin-${name}`);
  mkdirSync(binDir, { recursive: true });
  const mutatorPath = path.join(binDir, 'mutator.mjs');
  writeFileSync(mutatorPath, mutatorSource, 'utf8');
  const agyBin = path.join(binDir, 'agy');
  writeFileSync(
    agyBin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy 1.5.14"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "validate" ]; then
  "${process.execPath}" "${mutatorPath}"
  echo "simulated doctor failure" >&2
  exit 1
fi
exit 0
`,
    'utf8',
  );
  chmodSync(agyBin, 0o755);
  return binDir;
}

afterEach(() => {
  tracker.cleanup();
});

void describe('installer surgical rollback, link ownership, and backup validation', async () => {
  await it('preserves concurrent user settings edits and external statusLine/backup updates on install rollback', () => {
    if (process.platform === 'win32') return;

    // 1. User modifies `model` in settings.json while doctor is running; rollback must keep new model and only revert statusLine.
    const root1 = makeTempDir('agy-hud-rb-model-');
    const target1 = path.join(root1, 'installed-plugin');
    const cliHome1 = path.join(root1, '.gemini', 'antigravity-cli');
    const settingsPath1 = path.join(cliHome1, 'settings.json');
    const backupPath1 = path.join(cliHome1, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/custom.sh', enabled: true };
    writeJson(settingsPath1, { model: 'Old Model', statusLine: priorSl });

    const bin1 = createFailingDoctorAgyWithMutator(
      root1,
      'model',
      `import { readFileSync, writeFileSync } from 'node:fs';
const p = ${JSON.stringify(settingsPath1)};
const cur = JSON.parse(readFileSync(p, 'utf8'));
cur.model = 'User Saved Model';
writeFileSync(p, JSON.stringify(cur, null, 2) + '\\n', 'utf8');
`,
    );
    const env1 = makeIsolatedEnv(root1, { PATH: `${bin1}${path.delimiter}${process.env.PATH ?? ''}` });
    const res1 = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', target1, '--no-enable', '--wire-statusline', '--quiet'],
      env1,
    );
    assert.notEqual(res1.status, 0);
    assert.equal(existsSync(target1), false);
    const after1 = readJson(settingsPath1);
    assert.equal(after1.model, 'User Saved Model', 'rollback must not overwrite concurrent user model edit');
    assert.deepEqual(after1.statusLine, priorSl, 'rollback must still revert statusLine written by this install');
    assert.equal(existsSync(backupPath1), false, 'fresh backup still owned by this install must be cleaned up');

    // 2. User changes BOTH `model` and `statusLine`, and another install replaces backup during doctor; rollback must leave both untouched.
    const root2 = makeTempDir('agy-hud-rb-superseded-');
    const target2 = path.join(root2, 'installed-plugin');
    const cliHome2 = path.join(root2, '.gemini', 'antigravity-cli');
    const settingsPath2 = path.join(cliHome2, 'settings.json');
    const backupPath2 = path.join(cliHome2, 'cache', 'agy-hud-statusline-backup.json');
    const externalSl = { type: 'command', command: '/external/newer-hud.sh', enabled: true };
    const externalBackup = {
      wiredCommand: '/other-install/dist/hud.mjs',
      hadStatusLine: true,
      previousStatusLine: { type: 'command', command: '/other/prior.sh', enabled: true },
      savedAt: '2099-01-01T00:00:00.000Z',
    };
    writeJson(settingsPath2, { model: 'Old Model' });

    const bin2 = createFailingDoctorAgyWithMutator(
      root2,
      'superseded',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(settingsPath2)}, JSON.stringify({ model: 'Newer Model', statusLine: ${JSON.stringify(externalSl)} }, null, 2) + '\\n', 'utf8');
writeFileSync(${JSON.stringify(backupPath2)}, JSON.stringify(${JSON.stringify(externalBackup)}, null, 2) + '\\n', 'utf8');
`,
    );
    const env2 = makeIsolatedEnv(root2, { PATH: `${bin2}${path.delimiter}${process.env.PATH ?? ''}` });
    const res2 = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', target2, '--no-enable', '--wire-statusline', '--quiet'],
      env2,
    );
    assert.notEqual(res2.status, 0);
    assert.deepEqual(readJson(settingsPath2), { model: 'Newer Model', statusLine: externalSl });
    assert.deepEqual(
      readJson(backupPath2),
      externalBackup,
      'rollback must not overwrite newer backup owned by another op',
    );
  });

  await it('scopes statusLine and backup ownership by install target when two --link installs share one repository', () => {
    const root = makeTempDir('agy-hud-two-links-');
    const linkA = path.join(root, 'link-a');
    const linkB = path.join(root, 'link-b');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/user-hud.py', enabled: true };
    const env = makeIsolatedEnv(root);

    writeJson(settingsPath, { statusLine: priorSl });

    // Install both A and B linked to REPO_ROOT, wiring statusLine ONLY for A.
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--link', '--target', linkA, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['install', '--link', '--target', linkB, '--no-enable', '--quiet'], env).status,
      0,
    );

    const wiredA = readJson(settingsPath).statusLine as Record<string, unknown>;
    assert.equal(
      wiredA.command,
      formatStatusLineCommand(path.join(linkA, 'dist', 'hud.mjs'), process.platform, {
        useNode: process.platform === 'win32',
      }),
    );
    const backupRawBefore = readFileSync(backupPath, 'utf8');

    // `off --target B` must NOT disable A.
    assert.equal(runNodeScript(INSTALL_SCRIPT, ['off', '--target', linkB, '--no-enable', '--quiet'], env).status, 0);
    assert.deepEqual(readJson(settingsPath).statusLine, wiredA, 'off on link B must not touch link A statusLine');

    // `uninstall --target B --restore-statusline` must NOT restore A's statusLine or consume A's backup.
    const uninstB = runNodeScript(
      INSTALL_SCRIPT,
      ['uninstall', '--target', linkB, '--no-enable', '--restore-statusline', '--quiet'],
      env,
    );
    assert.equal(uninstB.status, 0, uninstB.stderr);
    assert.equal(existsSync(linkB), false);
    assert.equal(existsSync(linkA), true, 'link A must remain installed');
    assert.deepEqual(
      readJson(settingsPath).statusLine,
      wiredA,
      'uninstalling link B must leave link A statusLine intact',
    );
    assert.equal(existsSync(backupPath), true, 'uninstalling link B must not delete link A backup');
    assert.equal(readFileSync(backupPath, 'utf8'), backupRawBefore);

    // Uninstalling link A (even via realpath-canonical parent path on macOS) must restore priorSl and remove backup.
    const realRoot = realpathSync(root);
    const linkAViaRealParent = path.join(realRoot, 'link-a');
    const uninstA = runNodeScript(
      INSTALL_SCRIPT,
      ['uninstall', '--target', linkAViaRealParent, '--no-enable', '--restore-statusline', '--quiet'],
      env,
    );
    assert.equal(uninstA.status, 0, uninstA.stderr);
    assert.equal(existsSync(linkA), false);
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);
    assert.equal(existsSync(backupPath), false);
  });

  await it('validates existing backup JSON before replacing it during install, on, off, and uninstall', () => {
    const root = makeTempDir('agy-hud-corrupt-bkp-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const env = makeIsolatedEnv(root);

    const priorSl = { type: 'command', command: '/prior/statusline.py', enabled: true };
    const corruptBackupRaw = '{ "wiredCommand": broken-backup\n';
    writeJson(settingsPath, { statusLine: priorSl });
    mkdirSync(path.dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, corruptBackupRaw, 'utf8');

    // 1. `install --wire-statusline` must fail upfront and preserve corrupt backup, settings, and targetDir absence.
    const instRes = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.notEqual(instRes.status, 0, 'install --wire-statusline must reject corrupt backup');
    assert.equal(readFileSync(backupPath, 'utf8'), corruptBackupRaw, 'corrupt backup must remain untouched');
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl, 'settings.json must remain untouched');
    assert.equal(existsSync(targetDir), false, 'targetDir must not be created when backup precheck fails');

    // Install without wiring so `on` and `off` can be tested against the corrupt backup.
    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['install', '--target', targetDir, '--no-enable', '--quiet'], env).status,
      0,
    );

    // 2. `on` must reject corrupt backup and preserve both files.
    const onRes = runNodeScript(INSTALL_SCRIPT, ['on', '--target', targetDir, '--no-enable', '--quiet'], env);
    assert.notEqual(onRes.status, 0, 'on must reject corrupt backup');
    assert.equal(readFileSync(backupPath, 'utf8'), corruptBackupRaw);
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);

    // 3. `off` when settings has no statusLine must be a no-op without mutating settings or backup.
    writeJson(settingsPath, { model: 'Gemini 4 Carbon' });
    const nonObjectBackupRaw = '["not-an-object"]\n';
    writeFileSync(backupPath, nonObjectBackupRaw, 'utf8');
    const offRes = runNodeScript(INSTALL_SCRIPT, ['off', '--target', targetDir, '--no-enable', '--quiet'], env);
    assert.equal(offRes.status, 0, 'off must succeed as a no-op when statusLine is not configured');
    assert.equal(readFileSync(backupPath, 'utf8'), nonObjectBackupRaw);
    assert.equal(readJson(settingsPath).statusLine, undefined);

    // 4. Dangling symlink backup must also be preserved by `install --wire-statusline`.
    rmSync(backupPath, { force: true });
    symlinkSync(path.join(root, 'missing-backup-target.json'), backupPath);

    const instDangling = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.notEqual(instDangling.status, 0, 'install --wire-statusline must reject dangling backup symlink');
    assert.equal(lstatSync(backupPath).isSymbolicLink(), true, 'install must preserve dangling backup symlink');

    // 5. Schema-corrupt JSON-object backup must be rejected and preserved across install and uninstall.
    rmSync(backupPath, { force: true });
    const badSchemaRaw = `${JSON.stringify({ wiredCommand: 123, hadStatusLine: true, previousStatusLine: 'broken' })}\n`;
    writeFileSync(backupPath, badSchemaRaw, 'utf8');
    writeJson(settingsPath, { statusLine: priorSl });

    const instBadSchema = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.notEqual(instBadSchema.status, 0, 'install must reject schema-corrupt backup object');
    assert.equal(readFileSync(backupPath, 'utf8'), badSchemaRaw, 'install must preserve schema-corrupt backup');

    // Wire settings directly to targetDir and ensure uninstall rejects and preserves the schema-corrupt backup.
    const wiredTargetSl = {
      type: 'command',
      command: path.join(targetDir, 'dist', 'hud.mjs'),
      enabled: true,
      stack_with_default: false,
    };
    writeJson(settingsPath, { statusLine: wiredTargetSl });
    const uninstBadSchema = runNodeScript(
      INSTALL_SCRIPT,
      ['uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
      env,
    );
    assert.notEqual(uninstBadSchema.status, 0, 'uninstall must reject schema-corrupt backup instead of deleting it');
    assert.equal(readFileSync(backupPath, 'utf8'), badSchemaRaw, 'uninstall must preserve schema-corrupt backup');
    assert.deepEqual(readJson(settingsPath).statusLine, wiredTargetSl);
    assert.equal(existsSync(targetDir), true);
  });

  await it('preserves original user backup when switching active wiring from install A to install B and guards non-object statusLine on off', () => {
    const root = makeTempDir('agy-hud-switch-ab-');
    const linkA = path.join(root, 'link-a');
    const linkB = path.join(root, 'link-b');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorSl = { type: 'command', command: '/prior/original-user.py', enabled: true };
    const env = makeIsolatedEnv(root);

    writeJson(settingsPath, { statusLine: priorSl });

    // 1. Wire install A, then switch active statusLine to install B via --wire-statusline.
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--link', '--target', linkA, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--link', '--target', linkB, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      ).status,
      0,
    );

    // 2. Remove now-inactive install A, then uninstall active install B with --restore-statusline.
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', linkA, '--no-enable', '--restore-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', linkB, '--no-enable', '--restore-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.deepEqual(
      readJson(settingsPath).statusLine,
      priorSl,
      'switching A -> B then uninstalling A and B must restore original user statusLine rather than deleted A',
    );
    assert.equal(existsSync(backupPath), false);

    // 3. `off` must not clobber a non-object statusLine or existing backup.
    assert.equal(
      runNodeScript(INSTALL_SCRIPT, ['install', '--link', '--target', linkA, '--no-enable', '--quiet'], env).status,
      0,
    );
    writeJson(settingsPath, { statusLine: 'legacy-string-statusline' });
    const keptBackup = { wiredCommand: '/other/hud.mjs', hadStatusLine: true, previousStatusLine: priorSl };
    writeJson(backupPath, keptBackup);

    const offNonObj = runNodeScript(INSTALL_SCRIPT, ['off', '--target', linkA, '--no-enable', '--quiet'], env);
    assert.equal(offNonObj.status, 0, offNonObj.stderr);
    assert.equal(
      readJson(settingsPath).statusLine,
      'legacy-string-statusline',
      'off must not overwrite non-object statusLine owned by user',
    );
    assert.deepEqual(
      readJson(backupPath),
      keptBackup,
      'off must not replace backup when skipping non-object statusLine',
    );
  });
});
