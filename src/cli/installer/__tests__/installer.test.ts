import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isSupportedNodeVersion, NODE_RANGE_LABEL } from '../../../core/guards.ts';
import { isInstallerCommand, parseInstallerArgs } from '../args.ts';
import { assertRuntimeFilesPresent, moveVerifiedTarget, removeVerifiedStagedPath } from '../fs-ops.ts';
import { createWireRollbackSteps, disableCliStatusLine, restoreCliStatusLine, wireCliStatusLine } from '../settings.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
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

void describe('installer staging identity verification', async () => {
  await it('verifies target identity before moving or deleting staged plugin directories', () => {
    const root = makeTempDir('agy-hud-stage-id-');
    const targetDir = path.join(root, 'plugin');
    const stagedDir = path.join(root, 'plugin.prev.test');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'plugin.json'), JSON.stringify({ name: 'agy-hud' }), 'utf8');
    const precheckedStat = lstatSync(targetDir);

    // Move aside rather than deleting so ext4 cannot immediately recycle the freed inode on recreate.
    renameSync(targetDir, path.join(root, 'previous-target'));
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'important-user-data.txt'), 'keep', 'utf8');

    assert.throws(() => moveVerifiedTarget(targetDir, precheckedStat, stagedDir), /Target changed/i);
    assert.equal(existsSync(path.join(targetDir, 'important-user-data.txt')), true);
    assert.equal(existsSync(stagedDir), false);

    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(path.join(stagedDir, 'unverified.txt'), 'do-not-delete', 'utf8');
    assert.throws(() => removeVerifiedStagedPath(stagedDir, precheckedStat), /modified staged entry/i);
    assert.equal(existsSync(path.join(stagedDir, 'unverified.txt')), true);
  });
});

void describe('installer runtime file preflight', async () => {
  await it('accepts regular files in assertRuntimeFilesPresent', () => {
    const root = makeTempDir('agy-hud-rt-regular-');
    const srcRoot = path.join(root, 'src-root');
    mkdirSync(path.join(srcRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(srcRoot, 'dist', 'hud.mjs'), 'export {};\n', 'utf8');

    assert.doesNotThrow(() => assertRuntimeFilesPresent(srcRoot, ['dist/hud.mjs']));
  });

  await it('accepts valid symlinked files in assertRuntimeFilesPresent', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-rt-symlink-');
    const realFile = path.join(root, 'real-hud.mjs');
    const srcRoot = path.join(root, 'src-root');
    mkdirSync(path.join(srcRoot, 'dist'), { recursive: true });
    writeFileSync(realFile, 'export {};\n', 'utf8');
    symlinkSync(realFile, path.join(srcRoot, 'dist', 'hud.mjs'));

    assert.doesNotThrow(() => assertRuntimeFilesPresent(srcRoot, ['dist/hud.mjs']));
  });

  await it('rejects a directory standing in for a required file in assertRuntimeFilesPresent', () => {
    const root = makeTempDir('agy-hud-rt-dir-');
    const srcRoot = path.join(root, 'src-root');
    const hudPath = path.join(srcRoot, 'dist', 'hud.mjs');
    mkdirSync(path.dirname(hudPath), { recursive: true });
    writeFileSync(hudPath, 'export {};\n', 'utf8');
    assert.doesNotThrow(() => assertRuntimeFilesPresent(srcRoot, ['dist/hud.mjs']));

    rmSync(hudPath);
    mkdirSync(hudPath);
    assert.throws(() => assertRuntimeFilesPresent(srcRoot, ['dist/hud.mjs']), /Missing required file: dist\/hud\.mjs/);
  });

  await it('rejects a dangling symlink in assertRuntimeFilesPresent', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-rt-dangling-');
    const srcRoot = path.join(root, 'src-root');
    const hudPath = path.join(srcRoot, 'dist', 'hud.mjs');
    mkdirSync(path.dirname(hudPath), { recursive: true });
    writeFileSync(hudPath, 'export {};\n', 'utf8');
    assert.doesNotThrow(() => assertRuntimeFilesPresent(srcRoot, ['dist/hud.mjs']));

    rmSync(hudPath);
    symlinkSync(path.join(root, 'nonexistent.mjs'), hudPath);
    assert.throws(() => assertRuntimeFilesPresent(srcRoot, ['dist/hud.mjs']), /Missing required file: dist\/hud\.mjs/);
  });
});

void describe('installer Node version gate', async () => {
  await it('aligns installer Node version gate with package.json engines (^22.20.0 || >=24.0.0)', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines: Record<string, string>;
    };
    assert.equal(NODE_RANGE_LABEL, pkg.engines.node);
    assert.equal(isSupportedNodeVersion('22.18.0'), false);
    assert.equal(isSupportedNodeVersion('22.19.9'), false);
    assert.equal(isSupportedNodeVersion('22.20.0'), true);
    assert.equal(isSupportedNodeVersion('23.0.0'), false);
    assert.equal(isSupportedNodeVersion('23.11.0'), false);
    assert.equal(isSupportedNodeVersion('24.0.0'), true);
    assert.equal(isSupportedNodeVersion('25.2.0'), true);
  });
});

void describe('installer CLI argument parsing for wire/unwire and shim options', async () => {
  await it('recognizes wire and unwire as valid installer commands with default manageShim enabled globally', () => {
    assert.equal(isInstallerCommand('wire'), true);
    assert.equal(isInstallerCommand('unwire'), true);
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice' };
    assert.equal(parseInstallerArgs(['wire'], env).manageShim, true);
    assert.equal(parseInstallerArgs(['unwire'], env).manageShim, true);
    assert.equal(parseInstallerArgs(['install'], env).manageShim, true);
    assert.equal(parseInstallerArgs(['uninstall'], env).manageShim, true);
    assert.equal(parseInstallerArgs(['wire', '--no-shim'], env).manageShim, false);
    assert.equal(parseInstallerArgs(['install', '--no-shim'], env).noShim, true);
  });

  await it('skips shim management on --project and --target unless --bin-dir or AGY_HUD_BIN_DIR is supplied', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/Users/alice' };
    assert.equal(parseInstallerArgs(['install', '--project', '/tmp/proj'], env).manageShim, false);
    assert.equal(parseInstallerArgs(['install', '--target', '/tmp/dst'], env).manageShim, false);
    assert.equal(parseInstallerArgs(['wire', '--target', '/tmp/dst'], env).manageShim, false);

    const withFlag = parseInstallerArgs(['install', '--target', '/tmp/dst', '--bin-dir', '/tmp/bin'], env);
    assert.equal(withFlag.manageShim, true);
    assert.equal(withFlag.explicitBinDir, true);
    assert.equal(withFlag.binDir, path.resolve('/tmp/bin'));

    const withInline = parseInstallerArgs(['wire', '--project', '/tmp/proj', '--bin-dir=/tmp/inline-bin'], env);
    assert.equal(withInline.manageShim, true);
    assert.equal(withInline.binDir, path.resolve('/tmp/inline-bin'));

    const withEnv = parseInstallerArgs(['install', '--target', '/tmp/dst'], {
      HOME: '/Users/alice',
      AGY_HUD_BIN_DIR: '/tmp/env-bin',
    });
    assert.equal(withEnv.manageShim, true);
    assert.equal(withEnv.explicitBinDir, true);
    assert.equal(withEnv.binDir, path.resolve('/tmp/env-bin'));

    const overriddenByNoShim = parseInstallerArgs(
      ['install', '--target', '/tmp/dst', '--bin-dir', '/tmp/bin', '--no-shim'],
      env,
    );
    assert.equal(overriddenByNoShim.manageShim, false);

    assert.throws(() => parseInstallerArgs(['wire', '--bin-dir'], env), /Missing directory path after --bin-dir/);
    assert.throws(() => parseInstallerArgs(['wire', '--bin-dir='], env), /Missing directory path after --bin-dir=/);
  });
});

void describe('installer statusLine ownership preservation for compound commands', async () => {
  await it('preserves compound user statusLine command during disableCliStatusLine', () => {
    const root = makeTempDir('agy-hud-compound-off-');
    const cliHome = path.join(root, 'cli-home');
    const targetDir = path.join(root, 'plugin');
    const hudCmd = path.join(targetDir, 'dist', 'hud.mjs');
    const compoundSl = { type: 'command', command: `node ${hudCmd} && echo custom`, enabled: true };
    const settingsPath = path.join(cliHome, 'settings.json');
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ statusLine: compoundSl }, null, 2)}\n`, 'utf8');

    const res = disableCliStatusLine(cliHome, targetDir);
    assert.deepEqual(res, { changed: false, skippedReason: 'not-owned' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: unknown };
    assert.deepEqual(after.statusLine, compoundSl);
  });

  await it('preserves compound user statusLine command during restoreCliStatusLine', () => {
    const root = makeTempDir('agy-hud-compound-restore-');
    const cliHome = path.join(root, 'cli-home');
    const targetDir = path.join(root, 'plugin');
    const hudCmd = path.join(targetDir, 'dist', 'hud.mjs');
    const compoundSl = { type: 'command', command: `node "${hudCmd}" && echo custom`, enabled: true };
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    mkdirSync(path.dirname(backupPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ statusLine: compoundSl }, null, 2)}\n`, 'utf8');
    writeFileSync(
      backupPath,
      `${JSON.stringify({ wiredCommand: hudCmd, hadStatusLine: false, previousStatusLine: null, savedAt: '2026-06-01T00:00:00Z' })}\n`,
      'utf8',
    );

    const res = restoreCliStatusLine(cliHome, targetDir);
    assert.deepEqual(res, { changed: false, skippedReason: 'not-owned' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: unknown };
    assert.deepEqual(after.statusLine, compoundSl);
    assert.equal(existsSync(backupPath), true);
  });
});

void describe('installer settings and backup POSIX file permissions', async () => {
  await it('writes statusLine backup file with 0o600 permissions on POSIX', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-backup-mode-');
    const cliHome = path.join(root, 'cli-home');
    const targetDir = path.join(root, 'plugin');
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(path.join(cliHome, 'settings.json'), JSON.stringify({ model: 'default' }), { mode: 0o644 });

    wireCliStatusLine(cliHome, targetDir);
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  });

  await it('preserves 0o600 permissions on settings.json during wireCliStatusLine', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-wire-mode-');
    const cliHome = path.join(root, 'cli-home');
    const targetDir = path.join(root, 'plugin');
    mkdirSync(cliHome, { recursive: true });
    const settingsPath = path.join(cliHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ model: 'default' }), { mode: 0o600 });
    chmodSync(settingsPath, 0o600);

    wireCliStatusLine(cliHome, targetDir);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  });

  await it('preserves 0o600 permissions on settings.json during disableCliStatusLine', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-disable-mode-');
    const cliHome = path.join(root, 'cli-home');
    const targetDir = path.join(root, 'plugin');
    mkdirSync(cliHome, { recursive: true });
    const settingsPath = path.join(cliHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ model: 'default' }), { mode: 0o600 });
    chmodSync(settingsPath, 0o600);
    wireCliStatusLine(cliHome, targetDir);
    chmodSync(settingsPath, 0o600);

    const res = disableCliStatusLine(cliHome, targetDir);
    assert.equal(res.changed, true);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  });

  await it('preserves 0o600 permissions on settings.json during restoreCliStatusLine', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-restore-mode-');
    const cliHome = path.join(root, 'cli-home');
    const targetDir = path.join(root, 'plugin');
    mkdirSync(cliHome, { recursive: true });
    const settingsPath = path.join(cliHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ model: 'default' }), { mode: 0o600 });
    chmodSync(settingsPath, 0o600);
    wireCliStatusLine(cliHome, targetDir);
    chmodSync(settingsPath, 0o600);

    const res = restoreCliStatusLine(cliHome, targetDir);
    assert.equal(res.changed, true);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  });

  await it('preserves 0o600 permissions on settings.json during partial rollback after concurrent edit', () => {
    if (process.platform === 'win32') return;
    const root = makeTempDir('agy-hud-rb-mode-');
    const cliHome = path.join(root, 'cli-home');
    const targetDir = path.join(root, 'plugin');
    mkdirSync(cliHome, { recursive: true });
    const settingsPath = path.join(cliHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ model: 'default' }), { mode: 0o600 });
    chmodSync(settingsPath, 0o600);

    const receipt = wireCliStatusLine(cliHome, targetDir);
    const current = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(settingsPath, `${JSON.stringify({ ...current, theme: 'dark' }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(settingsPath, 0o600);

    for (const [, step] of createWireRollbackSteps(receipt)) {
      step();
    }
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    assert.equal(after.theme, 'dark');
    assert.equal(Object.hasOwn(after, 'statusLine'), false);
  });
});
