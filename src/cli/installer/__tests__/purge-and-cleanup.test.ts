import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { resolveCliHome } from '../../../core/paths.ts';
import { parseInstallerArgs } from '../args.ts';
import { sweepTransientHudCaches } from '../cleanup.ts';
import { runDoctor } from '../doctor.ts';
import { assertNotActiveSourceRepo } from '../fs-ops.ts';
import { runInstallerCli } from '../index.ts';
import { purgeOrphanedStatusLineBackup, restoreCliStatusLine, wireCliStatusLine } from '../settings.ts';

function seedMockPlugin(dir: string, options: { executable?: boolean; includeSrc?: boolean } = {}): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), '{"name":"agy-hud","version":"0.1.0"}\n', 'utf8');
  writeFileSync(path.join(dir, 'mcp_config.json'), '{"mcpServers":{}}\n', 'utf8');
  writeFileSync(path.join(dir, 'dist', 'hud.mjs'), '#!/usr/bin/env node\nprocess.stdout.write("hud-ok\\n");\n', 'utf8');
  writeFileSync(path.join(dir, 'dist', 'cli.mjs'), '#!/usr/bin/env node\nprocess.stdout.write("cli-ok\\n");\n', 'utf8');
  writeFileSync(path.join(dir, 'dist', 'mcp-hud.mjs'), '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
  if (options.includeSrc) {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
  }
  if (process.platform !== 'win32') {
    const mode = options.executable === false ? 0o644 : 0o755;
    chmodSync(path.join(dir, 'dist', 'hud.mjs'), mode);
    chmodSync(path.join(dir, 'dist', 'cli.mjs'), mode);
    chmodSync(path.join(dir, 'dist', 'mcp-hud.mjs'), mode);
  }
}

function captureStdout<T>(fn: () => T): { result: T; stdout: string } {
  let stdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: fn(), stdout };
  } finally {
    process.stdout.write = origWrite;
  }
}

void describe('installer purge, transient cleanup, Marketplace node prefix, and host uninstall', () => {
  let tmpRoot = '';
  let prevHome: string | undefined;
  let prevCliHome: string | undefined;
  let prevGeminiHome: string | undefined;
  let prevPath: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-purge-unit-'));
    prevHome = process.env.HOME;
    prevCliHome = process.env.GEMINI_CLI_HOME;
    prevGeminiHome = process.env.GEMINI_HOME;
    prevPath = process.env.PATH;
    process.env.HOME = tmpRoot;
    process.env.GEMINI_CLI_HOME = tmpRoot;
    delete process.env.GEMINI_HOME;
    if (process.platform !== 'win32') {
      process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
    }
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCliHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = prevCliHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('parses --purge flag and exposes it in help output', () => {
    assert.equal(parseInstallerArgs(['unwire']).purge, false);
    assert.equal(parseInstallerArgs(['unwire', '--purge']).purge, true);
    assert.equal(parseInstallerArgs(['uninstall', '--restore-statusline', '--purge']).purge, true);
  });

  void it('sweeps transient agy_hud_* caches on unwire while preserving hud-config.json unless --purge is passed', () => {
    const cliHome = resolveCliHome();
    const cacheDir = path.join(cliHome, 'cache');
    const targetDir = path.join(tmpRoot, 'plugin');
    const binDir = path.join(tmpRoot, 'bin');
    seedMockPlugin(targetDir);
    mkdirSync(cacheDir, { recursive: true });
    process.env.PATH = path.dirname(process.execPath);

    // Wire first (positive control).
    runInstallerCli(['wire', '--target', targetDir, '--bin-dir', binDir, '--no-enable', '--quiet']);

    // Populate transient caches, a dead lock, an unrelated foreign cache, and hud-config.json.
    const gitCache = path.join(cacheDir, 'agy_hud_git_deadbeef.json');
    const snapCache = path.join(cacheDir, 'agy_hud_snapshot_1234.json');
    const procCache = path.join(cacheDir, 'agy_hud_proc.json');
    const deadLock = path.join(cacheDir, '.agy_hud_test.lock');
    const foreignFile = path.join(cacheDir, 'other_tool_cache.json');
    const configPath = path.join(cliHome, 'hud-config.json');
    writeFileSync(gitCache, '{}', 'utf8');
    writeFileSync(snapCache, '{}', 'utf8');
    writeFileSync(procCache, '{}', 'utf8');
    writeFileSync(deadLock, `${JSON.stringify({ pid: 999999999, token: 'dead-lock' })}\n`, 'utf8');
    const oldTs = new Date(Date.now() - 1000);
    utimesSync(deadLock, oldTs, oldTs);
    writeFileSync(foreignFile, '{"keep":true}', 'utf8');
    writeFileSync(configPath, '{"preset":"zen"}\n', 'utf8');

    // Default unwire sweeps transient caches, preserves hud-config.json & foreign files, prints receipt.
    const unwireOut = captureStdout(() =>
      runInstallerCli(['unwire', '--target', targetDir, '--bin-dir', binDir, '--no-enable']),
    );
    assert.equal(unwireOut.result, 0);
    assert.equal(existsSync(gitCache), false);
    assert.equal(existsSync(snapCache), false);
    assert.equal(existsSync(procCache), false);
    assert.equal(existsSync(deadLock), false);
    assert.equal(existsSync(foreignFile), true);
    assert.equal(existsSync(configPath), true);
    assert.match(unwireOut.stdout, /Removed 4 transient agy-hud cache file/);
    assert.match(unwireOut.stdout, /Preserved hud-config\.json/);

    // Now write corrupt hud-config.json + orphaned backup + tmp backup and run unwire --purge.
    const orphanBackup = path.join(cacheDir, 'agy-hud-statusline-backup.json');
    const orphanTmp = path.join(cacheDir, 'agy-hud-statusline-backup.json.tmp.123.456.0123456789abcdef');
    writeFileSync(configPath, '{ corrupt-hud-config', 'utf8');
    writeFileSync(
      orphanBackup,
      JSON.stringify({ wiredCommand: '/stale/dist/hud.mjs', hadStatusLine: false, previousStatusLine: null }),
      'utf8',
    );
    writeFileSync(orphanTmp, '{}', 'utf8');

    const purgeOut = captureStdout(() =>
      runInstallerCli(['unwire', '--target', targetDir, '--bin-dir', binDir, '--no-enable', '--purge']),
    );
    assert.equal(purgeOut.result, 0);
    assert.equal(existsSync(configPath), false, '--purge must remove hud-config.json even when corrupt');
    assert.equal(existsSync(orphanBackup), false, '--purge must remove orphaned statusLine backup');
    assert.equal(existsSync(orphanTmp), false, '--purge must remove orphaned backup temp files');
    assert.match(purgeOut.stdout, /Removed orphaned statusLine backup/);
  });

  void it('skips purging backup owned by another live agy-hud install and fails closed on corrupt backup JSON', () => {
    const cliHome = resolveCliHome();
    const cacheDir = path.join(cliHome, 'cache');
    const targetA = path.join(tmpRoot, 'plugin A');
    const targetB = path.join(tmpRoot, 'plugin B');
    seedMockPlugin(targetA);
    seedMockPlugin(targetB);
    mkdirSync(cacheDir, { recursive: true });

    // Wire targetB so settings.json points to another live agy-hud install (with space in path!).
    wireCliStatusLine(cliHome, targetB);
    const backupPath = path.join(cacheDir, 'agy-hud-statusline-backup.json');
    assert.equal(existsSync(backupPath), true);

    const skipped = purgeOrphanedStatusLineBackup(cliHome, targetA);
    assert.equal(skipped.skippedReason, 'owned-other-live');
    assert.deepEqual(skipped.removedPaths, []);
    assert.equal(existsSync(backupPath), true);

    // Corrupt backup fails closed on unwire --purge without removing hud-config.json.
    const configPath = path.join(cliHome, 'hud-config.json');
    writeFileSync(configPath, '{"preset":"compact"}\n', 'utf8');
    writeFileSync(backupPath, '{ broken-backup', 'utf8');
    assert.throws(
      () => runInstallerCli(['unwire', '--target', targetA, '--no-shim', '--no-enable', '--purge', '--quiet']),
      /corrupt|invalid|json/i,
    );
    assert.equal(existsSync(configPath), true, 'fail-closed preflight must leave hud-config.json untouched');
    assert.equal(readFileSync(backupPath, 'utf8'), '{ broken-backup');
  });

  void it('prefixes node automatically for non-executable Marketplace hud.mjs and round-trips restore', () => {
    if (process.platform === 'win32') return;
    const cliHome = resolveCliHome();
    const targetDir = path.join(tmpRoot, 'marketplace-plugin');
    seedMockPlugin(targetDir, { executable: false });

    const wired = wireCliStatusLine(cliHome, targetDir, 'darwin');
    assert.ok(
      wired.writtenStatusLine.command.startsWith('node '),
      `expected node prefix, got ${wired.writtenStatusLine.command}`,
    );

    const restored = restoreCliStatusLine(cliHome, targetDir, 'darwin');
    assert.equal(restored.changed, true);
    assert.equal(restored.skippedReason, null);
  });

  void it('distinguishes Plugin Install from active source repo in assertNotActiveSourceRepo', () => {
    const repoDir = path.join(tmpRoot, 'my-work-repo');
    seedMockPlugin(repoDir, { includeSrc: true });
    assert.throws(
      () => assertNotActiveSourceRepo(realpathSync(repoDir), repoDir, lstatSync(repoDir)),
      /Refusing to delete active source repository/,
    );

    const pluginInstallDir = path.join(tmpRoot, '.gemini', 'config', 'plugins', 'agy-hud');
    seedMockPlugin(pluginInstallDir, { includeSrc: true });
    assert.throws(
      () => assertNotActiveSourceRepo(realpathSync(pluginInstallDir), pluginInstallDir, lstatSync(pluginInstallDir)),
      /Cannot self-delete Plugin Install[\s\S]*unwire \[--purge\][\s\S]*agy plugin uninstall agy-hud/,
    );
  });

  void it('prints Link Install migration guidance in doctor when target is a symlink', () => {
    if (process.platform === 'win32') return;
    const realPlugin = path.join(tmpRoot, 'source-plugin');
    const linkTarget = path.join(tmpRoot, 'linked-plugin');
    const binDir = path.join(tmpRoot, 'bin');
    seedMockPlugin(realPlugin);
    symlinkSync(realPlugin, linkTarget, 'dir');

    const { result, stdout } = captureStdout(() =>
      runDoctor({
        targetDir: linkTarget,
        quiet: false,
        packageRoot: realPlugin,
        binDir,
        agyAvailable: false,
      }),
    );
    assert.equal(result.ok, true);
    assert.match(stdout, /Link Install ->/);
    assert.match(
      stdout,
      /agy plugin uninstall agy-hud && agy plugin install https:\/\/github\.com\/ifelseboyxx\/agy-hud/,
    );
  });

  void it('invokes agy plugin uninstall (never disable) after detaching statusLine, shim, and caches', () => {
    if (process.platform === 'win32') return;
    const cliHome = resolveCliHome();
    const cacheDir = path.join(cliHome, 'cache');
    const settingsPath = path.join(cliHome, 'settings.json');
    const pluginDir = path.join(tmpRoot, '.gemini', 'config', 'plugins', 'agy-hud');
    const binDir = path.join(tmpRoot, 'bin');
    const fakeBinDir = path.join(tmpRoot, 'fake-bin');
    const logPath = path.join(tmpRoot, 'agy-invocations.log');
    seedMockPlugin(pluginDir);
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    // Wire plugin first without fake agy on PATH.
    process.env.PATH = path.dirname(process.execPath);
    runInstallerCli(['wire', '--bin-dir', binDir, '--no-enable', '--quiet']);
    writeFileSync(path.join(cacheDir, 'agy_hud_git_abc.json'), '{}', 'utf8');

    // Fake `agy` logs invocations and records whether settings.json statusLine was already detached.
    const fakeAgy = path.join(fakeBinDir, 'agy');
    writeFileSync(
      fakeAgy,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "agy 0.1.0"; exit 0; fi',
        `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
        `if [ "$1" = "plugin" ] && [ "$2" = "uninstall" ]; then`,
        `  grep -q statusLine ${JSON.stringify(settingsPath)} && echo "STILL_WIRED" >> ${JSON.stringify(logPath)} || echo "DETACHED_OK" >> ${JSON.stringify(logPath)}`,
        `  rm -rf ${JSON.stringify(pluginDir)}`,
        'fi',
        'exit 0',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeAgy, 0o755);
    process.env.PATH = `${fakeBinDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;

    const code = runInstallerCli(['uninstall', '--restore-statusline', '--bin-dir', binDir, '--quiet']);
    assert.equal(code, 0);
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /plugin uninstall agy-hud/);
    assert.match(log, /DETACHED_OK/);
    assert.doesNotMatch(log, /plugin disable/);
    assert.equal(existsSync(pluginDir), false);
    assert.equal(existsSync(path.join(cacheDir, 'agy_hud_git_abc.json')), false);
  });

  void it('ignores symlinks inside cache directory during sweepTransientHudCaches', () => {
    if (process.platform === 'win32') return;
    const cliHome = resolveCliHome();
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const victim = path.join(tmpRoot, 'victim.txt');
    writeFileSync(victim, 'preserve-me', 'utf8');
    symlinkSync(victim, path.join(cacheDir, 'agy_hud_git_symlink.json'));

    const removed = sweepTransientHudCaches(cliHome);
    assert.deepEqual(removed, []);
    assert.equal(existsSync(victim), true);
    assert.equal(readFileSync(victim, 'utf8'), 'preserve-me');
  });

  void it('blocks symlinked cache parent dir across wire, restore, and --purge after positive regular-dir check', () => {
    if (process.platform === 'win32') return;
    const cliHome = resolveCliHome();
    const targetDir = path.join(tmpRoot, 'plugin');
    const externalCache = path.join(tmpRoot, 'external-cache');
    seedMockPlugin(targetDir);
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    mkdirSync(externalCache, { recursive: true });

    // Positive control: normal cache dir wires, restores, and cleans up.
    wireCliStatusLine(cliHome, targetDir);
    assert.equal(restoreCliStatusLine(cliHome, targetDir).changed, true);

    // Replace cache with symlink to external dir containing a backup: wire, restore, and purge must all fail closed.
    rmSync(path.join(cliHome, 'cache'), { recursive: true, force: true });
    const extBackup = path.join(externalCache, 'agy-hud-statusline-backup.json');
    writeFileSync(
      extBackup,
      JSON.stringify({ wiredCommand: '/stale/dist/hud.mjs', hadStatusLine: false, previousStatusLine: null }),
      'utf8',
    );
    symlinkSync(externalCache, path.join(cliHome, 'cache'), 'dir');

    assert.throws(() => wireCliStatusLine(cliHome, targetDir), /untrusted or symlinked cache/i);
    writeFileSync(
      path.join(cliHome, 'settings.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: path.join(targetDir, 'dist', 'hud.mjs'), enabled: true },
      }),
      'utf8',
    );
    assert.throws(() => restoreCliStatusLine(cliHome, targetDir), /untrusted or symlinked cache/i);
    assert.throws(
      () => runInstallerCli(['unwire', '--target', targetDir, '--no-shim', '--no-enable', '--purge', '--quiet']),
      /untrusted or symlinked cache/i,
    );
    assert.equal(existsSync(extBackup), true, 'symlinked external cache backup must stay untouched');
  });

  void it('sweeps transient caches on default --target --no-shim uninstall and lists all 6+ filenames in receipt', () => {
    const cliHome = resolveCliHome();
    const cacheDir = path.join(cliHome, 'cache');
    const targetDir = path.join(tmpRoot, 'custom-plugin');
    seedMockPlugin(targetDir);
    mkdirSync(cacheDir, { recursive: true });
    for (let i = 1; i <= 6; i += 1) {
      writeFileSync(path.join(cacheDir, `agy_hud_git_f${i}.json`), '{}', 'utf8');
    }
    writeFileSync(path.join(cliHome, 'hud-config.json'), '{"preset":"zen"}\n', 'utf8');

    const { result, stdout } = captureStdout(() =>
      runInstallerCli(['uninstall', '--target', targetDir, '--no-shim', '--no-enable']),
    );
    assert.equal(result, 0);
    for (let i = 1; i <= 6; i += 1) {
      assert.equal(existsSync(path.join(cacheDir, `agy_hud_git_f${i}.json`)), false);
      assert.ok(stdout.includes(`agy_hud_git_f${i}.json`), `receipt must list agy_hud_git_f${i}.json`);
    }
    assert.equal(existsSync(path.join(cliHome, 'hud-config.json')), true);
  });

  void it('fails closed when hud-config.json is a directory on --purge without mutating settings', () => {
    const cliHome = resolveCliHome();
    const targetDir = path.join(tmpRoot, 'plugin-dir-cfg');
    seedMockPlugin(targetDir);
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    wireCliStatusLine(cliHome, targetDir);
    const settingsBefore = readFileSync(path.join(cliHome, 'settings.json'), 'utf8');
    mkdirSync(path.join(cliHome, 'hud-config.json'), { recursive: true });
    assert.throws(
      () => runInstallerCli(['unwire', '--target', targetDir, '--no-shim', '--no-enable', '--purge', '--quiet']),
      /is a directory/i,
    );
    assert.equal(readFileSync(path.join(cliHome, 'settings.json'), 'utf8'), settingsBefore);
  });

  void it('auto-restores statusLine on uninstall --purge and refuses purging active or corrupt-manifest backups', () => {
    const cliHome = resolveCliHome();
    const targetDir = path.join(tmpRoot, 'plugin-active');
    seedMockPlugin(targetDir);
    const priorSl = { type: 'command', command: '/prior/custom.sh', enabled: true };
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(path.join(cliHome, 'settings.json'), JSON.stringify({ statusLine: priorSl }), 'utf8');
    wireCliStatusLine(cliHome, targetDir);

    // While targetDir is still wired, direct purge must skip deleting the live backup.
    const activeSkip = purgeOrphanedStatusLineBackup(cliHome, targetDir);
    assert.equal(activeSkip.skippedReason, 'owned-other-live');
    assert.equal(existsSync(path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json')), true);

    // Corrupt plugin.json on another live agy-hud target must fail-closed and preserve backup.
    const otherDir = path.join(tmpRoot, 'plugin-corrupt-manifest');
    seedMockPlugin(otherDir);
    writeFileSync(path.join(otherDir, 'plugin.json'), '{ broken', 'utf8');
    wireCliStatusLine(cliHome, otherDir);
    const corruptSkip = purgeOrphanedStatusLineBackup(cliHome, targetDir);
    assert.equal(corruptSkip.skippedReason, 'owned-other-live');

    // uninstall --purge (without explicit --restore-statusline) restores statusLine first, then cleans up.
    writeFileSync(path.join(otherDir, 'plugin.json'), '{"name":"agy-hud","version":"0.1.0"}\n', 'utf8');
    writeFileSync(path.join(cliHome, 'hud-config.json'), '{"preset":"zen"}\n', 'utf8');
    const code = runInstallerCli(['uninstall', '--target', otherDir, '--no-shim', '--no-enable', '--purge', '--quiet']);
    assert.equal(code, 0);
    assert.equal(existsSync(otherDir), false);
    assert.equal(existsSync(path.join(cliHome, 'hud-config.json')), false);
    assert.equal(existsSync(path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json')), false);
    const restoredSettings = JSON.parse(readFileSync(path.join(cliHome, 'settings.json'), 'utf8')) as {
      statusLine?: unknown;
    };
    assert.deepEqual(restoredSettings.statusLine, priorSl);
  });

  void it('surfaces failure when agy plugin uninstall fails and still deregisters when plugin dir is missing', () => {
    if (process.platform === 'win32') return;
    const pluginDir = path.join(tmpRoot, '.gemini', 'config', 'plugins', 'agy-hud');
    const fakeBinDir = path.join(tmpRoot, 'fake-bin-fail');
    const logPath = path.join(tmpRoot, 'agy-fail.log');
    seedMockPlugin(pluginDir);
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeAgy = path.join(fakeBinDir, 'agy');
    writeFileSync(
      fakeAgy,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "agy 0.1.0"; exit 0; fi',
        `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
        'echo "simulated host uninstall error" >&2',
        'exit 1',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeAgy, 0o755);
    process.env.PATH = `${fakeBinDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;

    assert.throws(
      () => runInstallerCli(['uninstall', '--restore-statusline', '--no-shim', '--quiet']),
      /agy plugin uninstall agy-hud.*failed/i,
    );
    assert.equal(existsSync(pluginDir), true, 'plugin dir must stay intact for retry when host uninstall fails');

    // When plugin dir is already missing, global uninstall still invokes agy plugin uninstall to clear stale registration.
    rmSync(pluginDir, { recursive: true, force: true });
    writeFileSync(
      fakeAgy,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "agy 0.1.0"; exit 0; fi',
        `printf 'MISSING_DIR:%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
        'exit 0',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeAgy, 0o755);
    const code = runInstallerCli(['uninstall', '--restore-statusline', '--no-shim', '--quiet']);
    assert.equal(code, 0);
    assert.match(readFileSync(logPath, 'utf8'), /MISSING_DIR:plugin uninstall agy-hud/);

    // When plugin dir is missing and host uninstall fails with a real error (not 'not installed'), surface the error.
    writeFileSync(
      fakeAgy,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "agy 0.1.0"; exit 0; fi',
        'echo "lock timeout" >&2',
        'exit 1',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeAgy, 0o755);
    assert.throws(
      () => runInstallerCli(['uninstall', '--restore-statusline', '--no-shim', '--quiet']),
      /lock timeout/i,
    );
  });
});
