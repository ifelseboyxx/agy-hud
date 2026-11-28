import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { formatStatusLineCommand, isSameCommandPath } from '../../../core/statusline-ownership.ts';
import { runInstallerCli } from '../index.ts';

function seedMockPlugin(dir: string): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), '{"name":"agy-hud"}\n', 'utf8');
  const hudPath = path.join(dir, 'dist', 'hud.mjs');
  writeFileSync(hudPath, "process.stdout.write('ok\\n');\n", 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(hudPath, 0o755);
  }
  writeFileSync(path.join(dir, 'dist', 'cli.mjs'), "process.stdout.write('help\\n');\n", 'utf8');
}

function createBufferStdout(): { readonly stream: { write(chunk: string): boolean }; read(): string } {
  let out = '';
  return {
    stream: {
      write(chunk: string): boolean {
        out += chunk;
        return true;
      },
    },
    read(): string {
      return out;
    },
  };
}

function stripHostAgyFromPath(rawPath: string | undefined): string {
  const nodeDir = path.dirname(process.execPath);
  if (!rawPath) return nodeDir;
  const agyNames = process.platform === 'win32' ? ['agy.cmd', 'agy.exe', 'agy'] : ['agy'];
  const kept = rawPath.split(path.delimiter).filter((dir) => {
    const trimmed = dir.trim().replace(/^"(.*)"$/, '$1');
    if (trimmed.length === 0) return false;
    return !agyNames.some((bin) => existsSync(path.join(trimmed, bin)));
  });
  if (!kept.includes(nodeDir)) kept.unshift(nodeDir);
  return kept.join(path.delimiter);
}

function writeFakeAgy(fakeBinDir: string, logPath: string, disableExitCode: number): void {
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeAgy = path.join(fakeBinDir, 'agy');
  writeFileSync(
    fakeAgy,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "agy 1.5.18"; exit 0; fi',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      `if [ "$1" = "plugin" ] && [ "$2" = "disable" ]; then exit ${String(disableExitCode)}; fi`,
      'exit 0',
    ].join('\n'),
    'utf8',
  );
  chmodSync(fakeAgy, 0o755);
}

void describe('installer off / on ownership, rewiring, and best-effort host plugin toggle', () => {
  let tmpRoot = '';
  let cliHome = '';
  let geminiHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-toggle-'));
    geminiHome = path.join(tmpRoot, '.gemini');
    cliHome = path.join(geminiHome, 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  function makeEnv(extraPathDir?: string): NodeJS.ProcessEnv {
    const stripped = stripHostAgyFromPath(process.env.PATH);
    return {
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      GEMINI_HOME: geminiHome,
      GEMINI_CLI_HOME: cliHome,
      PATH: extraPathDir ? `${extraPathDir}${path.delimiter}${stripped}` : stripped,
    };
  }

  void it('prints a fallback note without failing off when agy plugin disable exits non-zero', () => {
    if (process.platform === 'win32') return;
    const defaultPluginDir = path.join(geminiHome, 'config', 'plugins', 'agy-hud');
    const fakeBinDir = path.join(tmpRoot, 'fake-bin');
    const logPath = path.join(tmpRoot, 'agy.log');
    seedMockPlugin(defaultPluginDir);
    const settingsPath = path.join(cliHome, 'settings.json');
    const env = makeEnv(fakeBinDir);

    // Positive control: succeeding `agy plugin disable` produces no fallback note.
    writeFakeAgy(fakeBinDir, logPath, 0);
    assert.equal(runInstallerCli(['on', '--no-enable', '--quiet'], { cliHome, env }), 0);
    const okOut = createBufferStdout();
    assert.equal(runInstallerCli(['off'], { cliHome, env, stdout: okOut.stream }), 0);
    const okSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: { enabled?: boolean } };
    assert.equal(okSettings.statusLine?.enabled, false);
    assert.match(okOut.read(), /Disabled agy-hud statusLine/);
    assert.doesNotMatch(okOut.read(), /Customizations UI/);
    assert.match(readFileSync(logPath, 'utf8'), /plugin disable agy-hud/);

    // Failure path: non-zero `agy plugin disable` still disables statusLine with exit 0 and prints fallback note.
    writeFakeAgy(fakeBinDir, logPath, 1);
    assert.equal(runInstallerCli(['on', '--no-enable', '--quiet'], { cliHome, env }), 0);
    const failOut = createBufferStdout();
    assert.equal(runInstallerCli(['off'], { cliHome, env, stdout: failOut.stream }), 0);
    const failSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: { enabled?: boolean } };
    assert.equal(failSettings.statusLine?.enabled, false);
    assert.match(failOut.read(), /Note: disable 'agy-hud' in Antigravity Customizations UI if needed\./);
    assert.match(failOut.read(), /Disabled agy-hud statusLine/);
  });

  void it('skips agy plugin toggle when --no-enable is passed', () => {
    if (process.platform === 'win32') return;
    const defaultPluginDir = path.join(geminiHome, 'config', 'plugins', 'agy-hud');
    const fakeBinDir = path.join(tmpRoot, 'fake-bin-no-enable');
    const logPath = path.join(tmpRoot, 'agy-no-enable.log');
    seedMockPlugin(defaultPluginDir);
    writeFakeAgy(fakeBinDir, logPath, 0);
    const env = makeEnv(fakeBinDir);

    // Positive control: default global `on` invokes `agy plugin enable agy-hud`.
    assert.equal(runInstallerCli(['on', '--quiet'], { cliHome, env }), 0);
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'plugin enable agy-hud');

    assert.equal(runInstallerCli(['off', '--no-enable', '--quiet'], { cliHome, env }), 0);
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'plugin enable agy-hud');
  });

  void it('skips agy plugin toggle when --target is passed', () => {
    if (process.platform === 'win32') return;
    const defaultPluginDir = path.join(geminiHome, 'config', 'plugins', 'agy-hud');
    const customTargetDir = path.join(tmpRoot, 'custom-plugin');
    const fakeBinDir = path.join(tmpRoot, 'fake-bin-target');
    const logPath = path.join(tmpRoot, 'agy-target.log');
    seedMockPlugin(defaultPluginDir);
    seedMockPlugin(customTargetDir);
    writeFakeAgy(fakeBinDir, logPath, 0);
    const env = makeEnv(fakeBinDir);

    // Positive control: default global `on` invokes `agy plugin enable agy-hud`.
    assert.equal(runInstallerCli(['on', '--quiet'], { cliHome, env }), 0);
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'plugin enable agy-hud');

    assert.equal(runInstallerCli(['on', '--target', customTargetDir, '--quiet'], { cliHome, env }), 0);
    assert.equal(runInstallerCli(['off', '--target', customTargetDir, '--quiet'], { cliHome, env }), 0);
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'plugin enable agy-hud');
  });

  void it('disables an owned statusLine on off but leaves a foreign statusLine untouched', () => {
    const targetDir = path.join(tmpRoot, 'plugin-off-guard');
    seedMockPlugin(targetDir);
    const settingsPath = path.join(cliHome, 'settings.json');
    const env = makeEnv();

    // Positive control: owned statusLine is disabled cleanly.
    const ownedCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'));
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ statusLine: { type: 'command', command: ownedCmd, enabled: true } }, null, 2)}\n`,
      'utf8',
    );
    const ownedOut = createBufferStdout();
    assert.equal(
      runInstallerCli(['off', '--target', targetDir, '--no-enable'], { cliHome, env, stdout: ownedOut.stream }),
      0,
    );
    assert.match(ownedOut.read(), /Disabled agy-hud statusLine/);
    assert.equal(
      (JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: { enabled?: boolean } }).statusLine?.enabled,
      false,
    );

    // Blocking check: foreign statusLine is skipped and left unchanged.
    const foreignSl = { type: 'command', command: '/custom/other-hud.sh', enabled: true };
    writeFileSync(settingsPath, `${JSON.stringify({ statusLine: foreignSl }, null, 2)}\n`, 'utf8');
    const foreignOut = createBufferStdout();
    assert.equal(
      runInstallerCli(['off', '--target', targetDir, '--no-enable'], { cliHome, env, stdout: foreignOut.stream }),
      0,
    );
    assert.match(foreignOut.read(), /does not point to this installation/);
    assert.deepEqual(
      (JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: unknown }).statusLine,
      foreignSl,
    );
  });

  void it('rewires a foreign statusLine to the target install on on and saves a backup', () => {
    const targetDir = path.join(tmpRoot, 'plugin-on-rewire');
    seedMockPlugin(targetDir);
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const foreignSl = { type: 'command', command: '/custom/other-hud.sh', enabled: true };
    writeFileSync(settingsPath, `${JSON.stringify({ statusLine: foreignSl }, null, 2)}\n`, 'utf8');
    const env = makeEnv();

    const onOut = createBufferStdout();
    assert.equal(
      runInstallerCli(['on', '--target', targetDir, '--no-enable'], { cliHome, env, stdout: onOut.stream }),
      0,
    );
    const afterOn = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      statusLine?: { command?: string; enabled?: boolean };
    };
    const expectedCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'));
    assert.equal(afterOn.statusLine?.enabled, true);
    assert.equal(isSameCommandPath(afterOn.statusLine?.command, expectedCmd, env), true);

    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as {
      wiredCommand?: string;
      previousStatusLine?: unknown;
    };
    assert.equal(isSameCommandPath(backup.wiredCommand, expectedCmd, env), true);
    assert.deepEqual(backup.previousStatusLine, foreignSl);
  });
});
