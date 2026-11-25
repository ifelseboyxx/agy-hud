import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildPresetConfig } from '../../core/hud-config.ts';
import type { HudConfig } from '../../types.ts';
import { runConfigureInteractive } from '../configure-tui.ts';
import {
  configureHud,
  HudConfigConflictError,
  loadInteractiveDraftSession,
  writeHudConfigAtomic,
} from '../configure.ts';
import type { TtyInputStream, TtyOutputStream } from '../tty-session.ts';

const createdDirs: string[] = [];

function makeTempCliHome(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

class MockTtyIn extends EventEmitter implements TtyInputStream {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

class MockTtyOut extends EventEmitter implements TtyOutputStream {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 24;
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function makeErrCapture(): { stream: { write(chunk: string): boolean }; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

void describe('interactive configure optimistic concurrency protection', () => {
  void it('preserves concurrent configure write when stale interactive draft saves', async () => {
    const cliHome = makeTempCliHome('agy-hud-conf-conflict-');
    mkdirSync(cliHome, { recursive: true });
    const configPath = path.join(cliHome, 'hud-config.json');
    const initial = buildPresetConfig('full', { maxAgentChips: 8 });
    writeFileSync(configPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');

    const stdin = new MockTtyIn();
    const stdout = new MockTtyOut();
    const stderr = makeErrCapture();

    const interactivePromise = runConfigureInteractive({
      cliHome,
      stdin,
      stdout,
      stderr: stderr.stream,
      color: false,
    });

    // Interleaved concurrent CLI update while interactive session is open.
    configureHud({ cliHome, sets: ['maxAgentChips=3'] });

    // Stale interactive draft attempts to save.
    stdin.emit('data', Buffer.from('\r'));
    const code = await interactivePromise;

    assert.equal(code, 1);
    assert.match(stderr.text(), /modified concurrently/i);
    assert.match(stderr.text(), /Reopen interactive configure/i);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as HudConfig;
    assert.equal(onDisk.maxAgentChips, 3);
  });

  void it('preserves concurrently created hud-config.json when draft opened without file', async () => {
    const cliHome = makeTempCliHome('agy-hud-conf-create-');
    const stdin = new MockTtyIn();
    const stdout = new MockTtyOut();
    const stderr = makeErrCapture();

    const interactivePromise = runConfigureInteractive({
      cliHome,
      stdin,
      stdout,
      stderr: stderr.stream,
      color: false,
    });

    configureHud({ cliHome, preset: 'compact', sets: ['maxAgentChips=4'] });

    stdin.emit('data', Buffer.from('\r'));
    const code = await interactivePromise;

    assert.equal(code, 1);
    assert.match(stderr.text(), /modified concurrently/i);
    const onDisk = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.equal(onDisk.preset, 'compact');
    assert.equal(onDisk.maxAgentChips, 4);
  });

  void it('throws HudConfigConflictError when expectedVersion mismatches under lock', () => {
    const cliHome = makeTempCliHome('agy-hud-conf-ver-');
    configureHud({ cliHome, preset: 'full', sets: ['maxAgentChips=8'] });
    const draft = loadInteractiveDraftSession({ cliHome });

    configureHud({ cliHome, sets: ['maxAgentChips=2'] });

    assert.throws(
      () => writeHudConfigAtomic(draft.config, { cliHome, expectedVersion: draft.version }),
      HudConfigConflictError,
    );
    const onDisk = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.equal(onDisk.maxAgentChips, 2);
  });

  void it('saves draft cleanly when expectedVersion matches current file', () => {
    const cliHome = makeTempCliHome('agy-hud-conf-ok-');
    configureHud({ cliHome, preset: 'full', sets: ['maxAgentChips=8'] });
    const draft = loadInteractiveDraftSession({ cliHome });
    draft.config.preset = 'compact';

    const saved = writeHudConfigAtomic(draft.config, { cliHome, expectedVersion: draft.version });
    assert.equal(saved.changed, true);
    const onDisk = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.equal(onDisk.preset, 'compact');
  });
});
