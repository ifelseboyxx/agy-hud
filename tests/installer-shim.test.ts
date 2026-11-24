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

void describe('plugin-first wire/unwire and CLI Shim lifecycle', { concurrency: true }, () => {
  void it('wires statusLine and CLI Shim in-place without recopying files, prints PATH hint, and detaches on unwire', async (t) => {
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

  void it('emits actionable rm diagnostic on stderr after plugin deletion and still removes owned shim on unwire', async (t) => {
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
    assert.ok(staleRun.stderr.includes(`rm "${shimPath}"`));
    assert.equal(existsSync(shimPath), true, 'stale shim must never self-delete');

    const unwireRes = await runInstallAsync(['unwire', '--no-enable', '--quiet'], env);
    assert.equal(unwireRes.status, 0, unwireRes.stderr);
    assert.equal(existsSync(shimPath), false);
  });

  void it('isolates --project and --target from global shims and preserves shims across on/off toggles', async (t) => {
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

  void it('refuses foreign shim files in preflight before staging files or editing settings and skips them on uninstall', async (t) => {
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

  void it('rolls back repointed shim atomically on post-install doctor failure and preserves concurrent external edits', async (t) => {
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

    const externalShim = '#!/bin/sh\necho concurrent-winner\n';
    const mutateBin = createFakeAgyBin(
      root,
      'mutate-rb',
      `  "${process.execPath}" -e 'import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(shimPath)}, ${JSON.stringify(externalShim)}, "utf8"))'
  echo "doctor fail" >&2
  exit 1`,
    );
    const envMutate = makeIsolatedEnv(root, { PATH: `${mutateBin}${path.delimiter}${process.env.PATH ?? ''}` });
    const resB2 = await runInstallAsync(
      ['install', '--target', targetB, '--bin-dir', binDir, '--no-enable', '--quiet'],
      envMutate,
    );
    assert.notEqual(resB2.status, 0);
    assert.equal(readFileSync(shimPath, 'utf8'), externalShim);
  });

  void it('rolls back both statusLine and shim on wire doctor failure and restores removed shim on mid-uninstall error', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-wire-uninst-rb-');
    const binDir = path.join(root, 'bin');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const cacheDir = path.join(cliHome, 'cache');
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

  void it('enforces blocking doctor checks for owned shims while keeping standalone missing/foreign/other informational', async (t) => {
    if (process.platform === 'win32') return;
    const localTracker = createTempDirTracker();
    t.after(() => localTracker.cleanup());
    const root = localTracker.makeTempDir('agy-hud-doctor-shim-');
    const targetA = path.join(root, 'plugin-a');
    const targetB = path.join(root, 'plugin-b');
    const binDir = path.join(root, 'bin');
    const shimPath = path.join(binDir, 'agy-hud');
    const env = makeFastEnv(root);

    assert.equal((await runInstallAsync(['install', '--target', targetA, '--no-enable', '--quiet'], env)).status, 0);
    assert.equal((await runInstallAsync(['install', '--target', targetB, '--no-enable', '--quiet'], env)).status, 0);

    const missingDoc = await runInstallAsync(['doctor', '--target', targetA, '--bin-dir', binDir], env);
    assert.equal(missingDoc.status, 0, missingDoc.stdout);
    assert.ok(missingDoc.stdout.includes('CLI shim'));
    assert.ok(missingDoc.stdout.includes('not installed'));

    mkdirSync(binDir, { recursive: true });
    writeFileSync(shimPath, '#!/bin/sh\necho foreign\n', 'utf8');
    const foreignDoc = await runInstallAsync(['doctor', '--target', targetA, '--bin-dir', binDir], env);
    assert.equal(foreignDoc.status, 0, foreignDoc.stdout);
    assert.ok(foreignDoc.stdout.includes('foreign'));

    rmSync(shimPath, { force: true });
    assert.equal(
      (await runInstallAsync(['wire', '--target', targetB, '--bin-dir', binDir, '--no-enable', '--quiet'], env)).status,
      0,
    );
    const otherDoc = await runInstallAsync(['doctor', '--target', targetA, '--bin-dir', binDir], env);
    assert.equal(otherDoc.status, 0, otherDoc.stdout);
    assert.ok(otherDoc.stdout.includes('owned by other install'));

    const selfDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir], env);
    assert.equal(selfDoc.status, 0, selfDoc.stdout);
    assert.ok(selfDoc.stdout.includes('OK'));
    assert.ok(selfDoc.stdout.includes('not on PATH'));

    // Missing execute bit -> blocking failure
    chmodSync(shimPath, 0o644);
    const nonExecDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir], env);
    assert.notEqual(nonExecDoc.status, 0);

    // --no-shim downgrades to informational
    const noShimDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir, '--no-shim'], env);
    assert.equal(noShimDoc.status, 0, noShimDoc.stdout);

    // Missing dist/cli.mjs while shim claims targetB -> blocking failure
    chmodSync(shimPath, 0o755);
    rmSync(path.join(targetB, 'dist', 'cli.mjs'), { force: true });
    const missingCliDoc = await runInstallAsync(['doctor', '--target', targetB, '--bin-dir', binDir], env);
    assert.notEqual(missingCliDoc.status, 0);
    assert.ok(missingCliDoc.stdout.includes('missing'));
  });
});
