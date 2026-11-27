import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createTempDirTracker,
  INSTALL_SCRIPT,
  makeIsolatedEnv as makeFastEnv,
  readJson,
  spawnNodeScriptAsync,
  writeJson,
  type ScriptResult,
} from './helpers.ts';

function runInstallAsync(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  return spawnNodeScriptAsync(INSTALL_SCRIPT, args, env);
}

void describe('plugin-first wire/unwire and CLI Shim lifecycle', { concurrency: true }, () => {
  void it('wires statusLine and CLI Shim in-place without recopying plugin files', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-wire-e2e-');
    const pluginDir = path.join(root, '.gemini', 'config', 'plugins', 'agy-hud');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const shimPath = path.join(root, '.local', 'bin', 'agy-hud');
    const priorSl = { type: 'command', command: '/prior/custom-hud.sh', enabled: true };
    const env = makeFastEnv(root);

    writeJson(settingsPath, { model: 'Gemini 4 Carbon', statusLine: priorSl });
    assert.equal((await runInstallAsync(['install', '--target', pluginDir, '--no-enable', '--quiet'], env)).status, 0);
    writeFileSync(path.join(pluginDir, 'keep-sentinel.txt'), 'plugin-owned', 'utf8');
    assert.equal(existsSync(shimPath), false, '--target without --bin-dir must not create global shim');

    const wireRes = await runInstallAsync(['wire', '--no-enable'], env);
    assert.equal(wireRes.status, 0, `${wireRes.stdout}\n${wireRes.stderr}`);
    assert.equal(existsSync(shimPath), true);
    assert.equal(statSync(shimPath).mode & 0o777, 0o755);
    assert.ok(
      readFileSync(shimPath, 'utf8').includes(`# agy-hud-shim:v1 target=${path.join(pluginDir, 'dist', 'cli.mjs')}`),
    );
    assert.equal(existsSync(path.join(pluginDir, 'keep-sentinel.txt')), true, 'wire must not replace plugin files');
    assert.ok(wireRes.stdout.includes('PATH'), 'wire should emit 1-line PATH hint when binDir is absent from PATH');
    assert.equal(
      (readJson(settingsPath).statusLine as Record<string, unknown>).command,
      path.join(pluginDir, 'dist', 'hud.mjs'),
    );

    const shimRun = spawnSync(shimPath, ['--help'], { env, encoding: 'utf8' });
    assert.equal(shimRun.status, 0, shimRun.stderr);
    assert.ok(shimRun.stdout.includes('wire'));
    assert.ok(shimRun.stdout.includes('unwire'));

    const unwireRes = await runInstallAsync(['unwire', '--no-enable'], env);
    assert.equal(unwireRes.status, 0, `${unwireRes.stdout}\n${unwireRes.stderr}`);
    assert.equal(existsSync(shimPath), false);
    assert.equal(existsSync(pluginDir), true, 'unwire must preserve installed plugin directory');
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl);
    assert.equal(existsSync(backupPath), false);
  });

  void it('emits actionable rm diagnostic after plugin deletion before unwire cleanup', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-post-uninst-');
    const pluginDir = path.join(root, '.gemini', 'config', 'plugins', 'agy-hud');
    const shimPath = path.join(root, '.local', 'bin', 'agy-hud');
    const env = makeFastEnv(root);

    assert.equal((await runInstallAsync(['install', '--no-enable', '--wire-statusline', '--quiet'], env)).status, 0);
    assert.equal(existsSync(shimPath), true);

    rmSync(pluginDir, { recursive: true, force: true });
    const staleRun = spawnSync(shimPath, ['--help'], { env, encoding: 'utf8' });
    assert.equal(staleRun.status, 1);
    assert.equal(staleRun.stdout, '');
    assert.ok(staleRun.stderr.includes(`rm -- '${shimPath}'`));
    assert.equal(existsSync(shimPath), true, 'stale shim must never self-delete');

    const unwireRes = await runInstallAsync(['unwire', '--no-enable', '--quiet'], env);
    assert.equal(unwireRes.status, 0, unwireRes.stderr);
    assert.equal(existsSync(shimPath), false);
  });

  void it('skips global shim management for --project or --target unless --bin-dir is provided', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-isolation-');
    const globalShim = path.join(root, '.local', 'bin', 'agy-hud');
    const projectDir = path.join(root, 'my-proj');
    const customTarget = path.join(root, 'custom-target');
    const customBin = path.join(root, 'custom-bin');
    mkdirSync(projectDir, { recursive: true });
    const env = makeFastEnv(root);

    assert.equal(
      (await runInstallAsync(['install', '--project', projectDir, '--no-enable', '--quiet'], env)).status,
      0,
    );
    assert.equal(
      (await runInstallAsync(['install', '--target', customTarget, '--no-enable', '--quiet'], env)).status,
      0,
    );
    assert.equal(existsSync(globalShim), false);

    const optIn = await runInstallAsync(
      ['install', '--target', customTarget, '--bin-dir', customBin, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.equal(optIn.status, 0, optIn.stderr);
    const customShim = path.join(customBin, 'agy-hud');
    assert.equal(existsSync(customShim), true);
    const shimBeforeToggle = readFileSync(customShim, 'utf8');

    assert.equal((await runInstallAsync(['off', '--target', customTarget, '--no-enable', '--quiet'], env)).status, 0);
    assert.equal(readFileSync(customShim, 'utf8'), shimBeforeToggle);
    assert.equal((await runInstallAsync(['on', '--target', customTarget, '--no-enable', '--quiet'], env)).status, 0);
    assert.equal(readFileSync(customShim, 'utf8'), shimBeforeToggle);

    const uninst = await runInstallAsync(
      ['uninstall', '--target', customTarget, '--no-enable', '--restore-statusline', '--quiet'],
      makeFastEnv(root, { AGY_HUD_BIN_DIR: customBin }),
    );
    assert.equal(uninst.status, 0, uninst.stderr);
    assert.equal(existsSync(customShim), false);
  });

  void it('refuses foreign shim files in preflight without modifying plugin files or settings', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-foreign-');
    const binDir = path.join(root, '.local', 'bin');
    const shimPath = path.join(binDir, 'agy-hud');
    const pluginDir = path.join(root, '.gemini', 'config', 'plugins', 'agy-hud');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const priorSl = { type: 'command', command: '/prior/hud.sh', enabled: true };
    const env = makeFastEnv(root);

    mkdirSync(binDir, { recursive: true });
    writeFileSync(shimPath, '#!/bin/sh\necho foreign-tool\n', 'utf8');
    chmodSync(shimPath, 0o755);
    writeJson(settingsPath, { statusLine: priorSl });

    const instRes = await runInstallAsync(['install', '--wire-statusline', '--no-enable', '--quiet'], env);
    assert.notEqual(instRes.status, 0);
    assert.match(instRes.stderr, /foreign/i);
    assert.equal(existsSync(pluginDir), false, 'preflight refusal must happen before staging plugin files');
    assert.deepEqual(readJson(settingsPath).statusLine, priorSl, 'preflight refusal must not modify settings.json');
    assert.equal(readFileSync(shimPath, 'utf8'), '#!/bin/sh\necho foreign-tool\n');

    const noShimRes = await runInstallAsync(
      ['install', '--wire-statusline', '--no-shim', '--no-enable', '--quiet'],
      env,
    );
    assert.equal(noShimRes.status, 0, noShimRes.stderr);
    assert.equal(readFileSync(shimPath, 'utf8'), '#!/bin/sh\necho foreign-tool\n');

    rmSync(shimPath, { force: true });
    symlinkSync('/tmp/other-binary', shimPath);
    const unwireRes = await runInstallAsync(['unwire', '--no-enable'], env);
    assert.equal(unwireRes.status, 0, unwireRes.stderr);
    assert.equal(lstatSync(shimPath).isSymbolicLink(), true);
  });
});
