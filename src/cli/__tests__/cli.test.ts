import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCliEntry, runCliEntryAsync } from '../../cli-entry.ts';
import { DEFAULT_HUD_CONFIG } from '../../core/hud-config.ts';
import { configureHud, parseConfigureArgs } from '../configure.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

void describe('configureHud', async () => {
  await it('returns defaults on --show when hud-config.json does not exist', () => {
    const root = makeTempDir('agy-hud-cfg-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');

    const result = configureHud({ cliHome, show: true });
    assert.equal(result.action, 'show');
    assert.equal(result.changed, false);
    assert.deepEqual(result.config, DEFAULT_HUD_CONFIG);
    assert.equal(existsSync(result.configPath), false);
  });

  await it('applies a preset to hud-config.json', () => {
    const root = makeTempDir('agy-hud-cfg-preset-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');

    const updated = configureHud({ cliHome, preset: 'compact' });
    assert.equal(updated.changed, true);
    assert.equal(updated.config.preset, 'compact');
    assert.equal(readJson(path.join(cliHome, 'hud-config.json')).preset, 'compact');
  });

  await it('applies valid --set overrides to hud-config.json', () => {
    const root = makeTempDir('agy-hud-cfg-set-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');

    const updated = configureHud({
      cliHome,
      sets: ['segments.cost=false', 'segments.quota=false', 'maxAgentChips=8'],
    });
    assert.equal(updated.changed, true);
    assert.equal(updated.config.segments.cost, false);
    assert.equal(updated.config.segments.quota, false);
    assert.equal(updated.config.maxAgentChips, 8);
    assert.equal(readJson(path.join(cliHome, 'hud-config.json')).maxAgentChips, 8);
  });

  await it('resets hud-config.json back to DEFAULT_HUD_CONFIG on --reset', () => {
    const root = makeTempDir('agy-hud-cfg-reset-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    configureHud({ cliHome, preset: 'zen', sets: ['maxAgentChips=2'] });

    const reset = configureHud({ cliHome, reset: true });
    assert.equal(reset.action, 'reset');
    assert.deepEqual(reset.config, DEFAULT_HUD_CONFIG);
  });

  await it('rejects unknown --set keys', () => {
    const cliHome = path.join(makeTempDir('agy-hud-cfg-'), '.gemini', 'antigravity-cli');
    assert.throws(() => configureHud({ cliHome, sets: ['unknownKey=true'] }), /Unknown configuration key/);
  });

  await it('rejects __proto__ prototype-pollution --set keys', () => {
    const cliHome = path.join(makeTempDir('agy-hud-cfg-'), '.gemini', 'antigravity-cli');
    assert.throws(() => configureHud({ cliHome, sets: ['__proto__=true'] }), /Unknown configuration key/);
  });

  await it('rejects non-boolean values for boolean --set keys', () => {
    const cliHome = path.join(makeTempDir('agy-hud-cfg-'), '.gemini', 'antigravity-cli');
    assert.throws(() => configureHud({ cliHome, sets: ['segments.cost=yes'] }), /Invalid boolean value/);
  });

  await it('rejects negative maxAgentChips values as invalid integers', () => {
    const cliHome = path.join(makeTempDir('agy-hud-cfg-'), '.gemini', 'antigravity-cli');
    assert.throws(() => configureHud({ cliHome, sets: ['maxAgentChips=-1'] }), /Invalid integer value/);
  });

  await it('rejects out-of-range maxAgentChips values', () => {
    const cliHome = path.join(makeTempDir('agy-hud-cfg-'), '.gemini', 'antigravity-cli');
    assert.throws(() => configureHud({ cliHome, sets: ['maxAgentChips=99'] }), /Out-of-range value/);
  });

  await it('rejects unknown preset names in --set', () => {
    const cliHome = path.join(makeTempDir('agy-hud-cfg-'), '.gemini', 'antigravity-cli');
    assert.throws(() => configureHud({ cliHome, sets: ['preset=ultra'] }), /Invalid preset/);
  });

  await it('rejects unknown CLI flags in parseConfigureArgs', () => {
    assert.throws(() => parseConfigureArgs(['--bogus']), /Unknown configure option/);
  });
});

void describe('runCliEntry', async () => {
  await it('returns 0 when --help is requested for top-level and subcommands', () => {
    assert.equal(runCliEntry(['--help']), 0);
    assert.equal(runCliEntry(['configure', '--help']), 0);
    assert.equal(runCliEntry(['install', '--help']), 0);
  });

  await it('returns 1 on unknown CLI commands', () => {
    assert.equal(runCliEntry(['unknown-cmd']), 1);
  });

  await it('returns 1 when required export-profile or import-profile flags are omitted', () => {
    assert.equal(runCliEntry(['export-profile']), 1);
    assert.equal(runCliEntry(['import-profile']), 1);
  });

  await it('forwards cliHome and stdout options through runCliEntryAsync for non-interactive commands', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-cli-entry-'));
    try {
      const isolatedCliHome = path.join(tmpRoot, 'cli-home');
      mkdirSync(isolatedCliHome, { recursive: true });
      let out = '';
      let err = '';
      const stdout = Object.assign(new (await import('node:events')).EventEmitter(), {
        isTTY: false,
        write(chunk: string): boolean {
          out += chunk;
          return true;
        },
      });
      const stderr = {
        write(chunk: string): boolean {
          err += chunk;
          return true;
        },
      };

      const setCode = await runCliEntryAsync(['configure', 'minimal', '--json'], {
        cliHome: isolatedCliHome,
        stdout,
        stderr,
      });
      assert.equal(setCode, 0);
      assert.equal(err, '');
      const parsed = JSON.parse(out) as { preset: string };
      assert.equal(parsed.preset, 'minimal');
      assert.equal(existsSync(path.join(isolatedCliHome, 'hud-config.json')), true);

      let installerOut = '';
      const helpCode = runCliEntry(['install', '--help'], {
        stdout: {
          write(chunk: string): boolean {
            installerOut += chunk;
            return true;
          },
        },
      });
      assert.equal(helpCode, 0);
      assert.ok(installerOut.includes('agy-hud installer'));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
