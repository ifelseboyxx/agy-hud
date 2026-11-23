import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install.mjs');

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeIsolatedEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    GEMINI_HOME: path.join(root, '.gemini'),
    GEMINI_CLI_HOME: root,
    ...extra,
  };
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function runNodeScript(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdinText = '',
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env,
    input: stdinText,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function createFakeFailingAgyBin(root: string): string {
  const binDir = path.join(root, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const agyBin = path.join(binDir, 'agy');
  writeFileSync(
    agyBin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy 1.5.14"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "validate" ]; then
  echo "simulated strict validation failure" >&2
  exit 1
fi
exit 0
`,
    'utf8',
  );
  chmodSync(agyBin, 0o755);
  return binDir;
}

function restoreWritableDirs(dirPath: string): void {
  try {
    chmodSync(dirPath, 0o755);
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        restoreWritableDirs(path.join(dirPath, entry.name));
      }
    }
  } catch {
    // Ignore missing or transient cleanup errors before rmSync.
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      restoreWritableDirs(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

void describe('installer configuration safety and rollback', async () => {
  await it('refuses to overwrite corrupt settings.json across install, on, off, and uninstall restore', () => {
    const root = makeTempDir('agy-hud-corrupt-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const corruptRaw = '{ "model": "Gemini 4 Carbon", broken-json\n';
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(settingsPath, corruptRaw, 'utf8');
    const env = makeIsolatedEnv(root);

    const installRes = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.notEqual(installRes.status, 0, 'install --wire-statusline must fail on corrupt settings.json');
    assert.equal(readFileSync(settingsPath, 'utf8'), corruptRaw, 'corrupt settings.json must remain intact');
    assert.equal(existsSync(backupPath), false, 'backup must not be created when settings.json is corrupt');
    assert.equal(existsSync(targetDir), false, 'targetDir must not remain installed after failed wire');

    // Install cleanly into a fresh root first, then corrupt settings.json to verify on/off/uninstall/doctor.
    const root2 = makeTempDir('agy-hud-corrupt-ops-');
    const targetDir2 = path.join(root2, 'installed-plugin');
    const cliHome2 = path.join(root2, '.gemini', 'antigravity-cli');
    const settingsPath2 = path.join(cliHome2, 'settings.json');
    const env2 = makeIsolatedEnv(root2);

    const installClean = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir2, '--no-enable', '--quiet'],
      env2,
    );
    assert.equal(installClean.status, 0, installClean.stderr);
    mkdirSync(cliHome2, { recursive: true });
    writeFileSync(settingsPath2, corruptRaw, 'utf8');

    const onRes = runNodeScript(INSTALL_SCRIPT, ['on', '--target', targetDir2, '--no-enable', '--quiet'], env2);
    assert.notEqual(onRes.status, 0, 'on must fail on corrupt settings.json');
    assert.equal(readFileSync(settingsPath2, 'utf8'), corruptRaw);

    const offRes = runNodeScript(INSTALL_SCRIPT, ['off', '--target', targetDir2, '--no-enable', '--quiet'], env2);
    assert.notEqual(offRes.status, 0, 'off must fail on corrupt settings.json');
    assert.equal(readFileSync(settingsPath2, 'utf8'), corruptRaw);

    const uninstallRes = runNodeScript(
      INSTALL_SCRIPT,
      ['uninstall', '--target', targetDir2, '--no-enable', '--restore-statusline', '--quiet'],
      env2,
    );
    assert.notEqual(uninstallRes.status, 0, 'uninstall --restore-statusline must fail on corrupt settings.json');
    assert.equal(readFileSync(settingsPath2, 'utf8'), corruptRaw);
    assert.equal(existsSync(targetDir2), true, 'targetDir must remain when restore fails on corrupt settings.json');

    const doctorRes = runNodeScript(INSTALL_SCRIPT, ['doctor', '--target', targetDir2], env2);
    assert.notEqual(doctorRes.status, 0, 'doctor must fail on corrupt settings.json');
    assert.ok(doctorRes.stdout.includes('corrupt settings.json'));
  });

  await it('validates uninstall target before mutating settings.json or consuming backup', () => {
    const root = makeTempDir('agy-hud-uninst-order-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const wiredRepoStatusLine = {
      type: 'command',
      command: path.join(REPO_ROOT, 'dist', 'hud.mjs'),
      enabled: true,
      stack_with_default: false,
    };
    writeJson(settingsPath, { statusLine: wiredRepoStatusLine });
    writeJson(backupPath, {
      hadStatusLine: true,
      previousStatusLine: { type: 'command', command: '/prior/hud.py', enabled: true },
    });

    const uninstallRepoRes = runNodeScript(
      INSTALL_SCRIPT,
      ['uninstall', '--target', REPO_ROOT, '--no-enable', '--restore-statusline', '--quiet'],
      makeIsolatedEnv(root),
    );
    assert.notEqual(uninstallRepoRes.status, 0, 'uninstall must refuse to delete active source repo');
    assert.deepEqual(
      readJson(settingsPath).statusLine,
      wiredRepoStatusLine,
      'settings.json must stay untouched when uninstall fails target validation',
    );
    assert.equal(existsSync(backupPath), true, 'backup must stay intact when uninstall aborts');
  });

  await it('rolls back prior installation and statusLine when post-install doctor fails during upgrade', () => {
    const root = makeTempDir('agy-hud-rollback-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const priorStatusLine = { type: 'command', command: '/prior/custom-hud.sh', enabled: true };

    writeJson(path.join(targetDir, 'plugin.json'), { name: 'agy-hud', version: '0.0.1-old' });
    writeFileSync(path.join(targetDir, 'sentinel.txt'), 'old-install', 'utf8');
    writeJson(settingsPath, { model: 'Gemini 4 Carbon', statusLine: priorStatusLine });

    const fakeBin = createFakeFailingAgyBin(root);
    const env = makeIsolatedEnv(root, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    });

    const upgradeRes = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.notEqual(upgradeRes.status, 0, 'upgrade must fail when doctor fails');
    assert.equal(
      readJson(path.join(targetDir, 'plugin.json')).version,
      '0.0.1-old',
      'prior installation must be restored on upgrade failure',
    );
    assert.equal(readFileSync(path.join(targetDir, 'sentinel.txt'), 'utf8'), 'old-install');
    assert.deepEqual(
      readJson(settingsPath).statusLine,
      priorStatusLine,
      'prior statusLine must be restored on upgrade failure',
    );
    assert.equal(existsSync(backupPath), false, 'fresh backup must be cleaned up on rollback');
  });

  await it('skips statusLine restore and preserves backup when user later switched to another statusLine', () => {
    const root = makeTempDir('agy-hud-ownership-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const originalStatusLine = { type: 'command', command: '/original/statusline.py', enabled: true };
    const laterUserStatusLine = { type: 'command', command: '/user/new-statusline.sh', enabled: true };
    writeJson(settingsPath, { statusLine: originalStatusLine });
    const env = makeIsolatedEnv(root);

    const installRes = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.equal(installRes.status, 0, installRes.stderr);
    assert.equal(existsSync(backupPath), true);

    // User later replaces statusLine with a different command.
    writeJson(settingsPath, { statusLine: laterUserStatusLine });

    const uninstallRes = runNodeScript(
      INSTALL_SCRIPT,
      ['uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
      env,
    );
    assert.equal(uninstallRes.status, 0, uninstallRes.stderr);
    assert.equal(existsSync(targetDir), false);
    assert.deepEqual(
      readJson(settingsPath).statusLine,
      laterUserStatusLine,
      'uninstall restore must not overwrite a statusLine owned by another command',
    );
    assert.equal(existsSync(backupPath), true, 'backup must not be deleted when restore was skipped');
  });

  await it('updates statusLine backup on re-install after user switched to a newer statusLine', () => {
    const root = makeTempDir('agy-hud-reinstall-bkp-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const firstStatusLine = { type: 'command', command: '/first/statusline.py', enabled: true };
    const newerStatusLine = { type: 'command', command: '/newer/statusline.sh', enabled: true };
    const env = makeIsolatedEnv(root);

    writeJson(settingsPath, { statusLine: firstStatusLine });

    // Install #1 takes over from firstStatusLine.
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      ).status,
      0,
    );

    // User switches to newerStatusLine; uninstall #1 skips restore and leaves stale backup.
    writeJson(settingsPath, { statusLine: newerStatusLine });
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.deepEqual(readJson(settingsPath).statusLine, newerStatusLine);
    assert.equal(existsSync(backupPath), true);

    // Install #2 takes over from newerStatusLine; backup must update to newerStatusLine.
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
        env,
      ).status,
      0,
    );

    // Uninstall #2 must restore newerStatusLine, NOT stale firstStatusLine.
    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
        env,
      ).status,
      0,
    );
    assert.deepEqual(
      readJson(settingsPath).statusLine,
      newerStatusLine,
      'second uninstall must restore the statusLine active before the second install',
    );
    assert.equal(existsSync(backupPath), false);
  });

  await it('rolls back settings.json and preserves plugin when uninstall fails deleting backup or plugin tree', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    // Case 1: backup is readable, settings.json is writable, but cache dir is read-only so backup unlink fails.
    const root1 = makeTempDir('agy-hud-uninst-bkpfail-');
    const targetDir1 = path.join(root1, 'installed-plugin');
    const cliHome1 = path.join(root1, '.gemini', 'antigravity-cli');
    const settingsPath1 = path.join(cliHome1, 'settings.json');
    const cacheDir1 = path.join(cliHome1, 'cache');
    const backupPath1 = path.join(cacheDir1, 'agy-hud-statusline-backup.json');
    const env1 = makeIsolatedEnv(root1);
    writeJson(settingsPath1, { statusLine: { type: 'command', command: '/prior/hud.py', enabled: true } });

    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--target', targetDir1, '--no-enable', '--wire-statusline', '--quiet'],
        env1,
      ).status,
      0,
    );
    const wiredSl1 = readJson(settingsPath1).statusLine;

    chmodSync(cacheDir1, 0o555);
    try {
      const res = runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', targetDir1, '--no-enable', '--restore-statusline', '--quiet'],
        env1,
      );
      assert.notEqual(res.status, 0, 'uninstall must fail when backup cannot be deleted');
      assert.deepEqual(
        readJson(settingsPath1).statusLine,
        wiredSl1,
        'settings.json must be rolled back when backup deletion fails',
      );
      assert.equal(existsSync(backupPath1), true);
      assert.equal(existsSync(path.join(targetDir1, 'plugin.json')), true);
      assert.equal(
        existsSync(path.join(targetDir1, 'dist', 'hud.mjs')),
        true,
        'rollbackable failure must preserve full plugin directory including dist/hud.mjs',
      );
    } finally {
      chmodSync(cacheDir1, 0o755);
    }

    // Case 2: subdirectory inside plugin is read-only so recursive removal would partially fail.
    const root2 = makeTempDir('agy-hud-uninst-rmfail-');
    const targetDir2 = path.join(root2, 'installed-plugin');
    const cliHome2 = path.join(root2, '.gemini', 'antigravity-cli');
    const settingsPath2 = path.join(cliHome2, 'settings.json');
    const backupPath2 = path.join(cliHome2, 'cache', 'agy-hud-statusline-backup.json');
    const env2 = makeIsolatedEnv(root2);
    writeJson(settingsPath2, { statusLine: { type: 'command', command: '/prior/hud.py', enabled: true } });

    assert.equal(
      runNodeScript(
        INSTALL_SCRIPT,
        ['install', '--target', targetDir2, '--no-enable', '--wire-statusline', '--quiet'],
        env2,
      ).status,
      0,
    );
    const wiredSl2 = readJson(settingsPath2).statusLine;
    const lockedDir = path.join(targetDir2, 'dist', 'locked-dir');
    mkdirSync(lockedDir, { recursive: true });
    writeFileSync(path.join(lockedDir, 'keep.txt'), 'locked', 'utf8');
    chmodSync(lockedDir, 0o555);
    try {
      const res = runNodeScript(
        INSTALL_SCRIPT,
        ['uninstall', '--target', targetDir2, '--no-enable', '--restore-statusline', '--quiet'],
        env2,
      );
      assert.notEqual(res.status, 0, 'uninstall must fail when plugin tree cannot be deleted');
      assert.equal(
        existsSync(path.join(targetDir2, 'plugin.json')),
        true,
        'plugin files must remain intact instead of partially deleted',
      );
      assert.deepEqual(readJson(settingsPath2).statusLine, wiredSl2);
      assert.equal(existsSync(backupPath2), true);
    } finally {
      if (existsSync(lockedDir)) chmodSync(lockedDir, 0o755);
    }
  });
});
