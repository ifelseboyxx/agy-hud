import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runCliEntry, runCliEntryAsync } from '../../cli-entry.ts';
import { writeSnapshotEnvelope } from '../../collectors/snapshot-envelope.ts';
import { stripAnsi } from '../../render/ansi.ts';
import { installCliShim } from '../installer/shim.ts';
import type { PopupInputStream, PopupOutputStream } from '../snapshot-popup.ts';
import { executeParsedSnapshotCommand, isSnapshotFlag, parseSnapshotArgs, runSnapshotCommand } from '../snapshot.ts';

class FakeTtyIn extends EventEmitter implements PopupInputStream {
  isTTY: boolean;
  rawModes: boolean[] = [];

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }

  resume(): void {}

  pause(): void {}
}

class FakeTtyOut extends EventEmitter implements PopupOutputStream {
  isTTY: boolean;
  columns: number | undefined;
  rows: number | undefined;
  chunks: string[] = [];

  constructor(isTTY: boolean, columns?: number, rows?: number) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
    this.rows = rows;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

function captureSyncRun(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

void describe('snapshot CLI wiring (-p/--popup, --keybindings/--keymap, Structured Inspector)', () => {
  let tmpRoot = '';
  let cliHome = '';
  let wsDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-snap-wire-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    wsDir = path.join(tmpRoot, 'project-a');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('parses -p/--popup and --keybindings/--keymap flags and marks them as snapshot flags', () => {
    assert.equal(isSnapshotFlag('-p'), true);
    assert.equal(isSnapshotFlag('--popup'), true);
    assert.equal(isSnapshotFlag('--keybindings'), true);
    assert.equal(isSnapshotFlag('--keybindings=tmux'), true);
    assert.equal(isSnapshotFlag('--keymap'), true);
    assert.equal(isSnapshotFlag('--keymap=ghostty'), true);

    assert.equal(parseSnapshotArgs(['-p']).popup, true);
    assert.equal(parseSnapshotArgs(['--popup', 'tools']).popup, true);
    assert.equal(parseSnapshotArgs(['--keybindings']).keybindings, 'auto');
    assert.equal(parseSnapshotArgs(['--keybindings', 'tmux']).keybindings, 'tmux');
    assert.equal(parseSnapshotArgs(['--keymap=kitty']).keybindings, 'kitty');
    assert.equal(parseSnapshotArgs(['--keybindings', '--no-color']).keybindings, 'auto');
    assert.equal(parseSnapshotArgs(['--keybindings', '--no-color']).noColor, true);

    assert.throws(() => parseSnapshotArgs(['--keybindings=']), /Missing value after --keybindings=/);
    assert.throws(() => parseSnapshotArgs(['--keymap', 'bogus']), /Invalid --keybindings target/);
  });

  void it('renders Structured Inspector with ANSI rules by default and suppresses ANSI on --no-color or NO_COLOR', () => {
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'cli-struct-1111', conversation_title: 'Inspector Check', cwd: wsDir },
      process.pid,
    );
    const defaultRes = runSnapshotCommand([], {
      cliHome,
      cwd: wsDir,
      width: 100,
      env: {},
      isAlive: (p) => p === process.pid,
    });
    assert.notEqual(defaultRes.output, stripAnsi(defaultRes.output), 'default piped output preserves ANSI SGR');
    assert.ok(stripAnsi(defaultRes.output).includes('── Tools ('));

    const noColorRes = runSnapshotCommand(['--no-color'], {
      cliHome,
      cwd: wsDir,
      width: 100,
      env: {},
      isAlive: (p) => p === process.pid,
    });
    assert.equal(noColorRes.output, stripAnsi(noColorRes.output));

    const envNoColorRes = runSnapshotCommand([], {
      cliHome,
      cwd: wsDir,
      width: 100,
      env: { NO_COLOR: '1' },
      isAlive: (p) => p === process.pid,
    });
    assert.equal(envNoColorRes.output, stripAnsi(envNoColorRes.output));
  });

  void it('serves --keybindings / --keymap synchronously through runSnapshotCommand and runCliEntry', () => {
    const homeDir = path.join(tmpRoot, 'home');
    const pluginRoot = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud');
    const binDir = path.join(homeDir, '.local', 'bin');
    mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(pluginRoot, 'dist', 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8');
    installCliShim(binDir, pluginRoot, { HOME: homeDir }, 'darwin');

    const res = runSnapshotCommand(['--keymap', 'tmux', '--no-color'], {
      env: { HOME: homeDir },
      pluginRoot,
      platform: 'darwin',
    });
    assert.ok(res.output.includes('display-popup'));
    assert.ok(res.output.includes(path.join(binDir, 'agy-hud')));

    const syncRun = captureSyncRun(() => runCliEntry(['--keybindings', 'ghostty', '--no-color']));
    assert.equal(syncRun.code, 0);
    assert.ok(syncRun.stdout.includes('text:!agy-hud\\n'));
  });

  void it('launches interactive TTY popup via runCliEntryAsync and degrades cleanly when non-TTY', async () => {
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'popup-wire-2222', conversation_title: 'Popup Wire', cwd: wsDir },
      process.pid,
    );

    const nonTtyIn = new FakeTtyIn(false);
    const nonTtyOut = new FakeTtyOut(false);
    const nonTtyCode = await runCliEntryAsync(['-p', '--no-color'], {
      stdin: nonTtyIn,
      stdout: nonTtyOut,
      cliHome,
      cwd: wsDir,
      env: {},
    });
    assert.equal(nonTtyCode, 0);
    assert.equal(nonTtyOut.text().includes('\x1b[?1049h'), false);
    assert.ok(nonTtyOut.text().includes('Popup Wire'));

    const ttyIn = new FakeTtyIn(true);
    const ttyOut = new FakeTtyOut(true, 96, 14);
    const popupPromise = runCliEntryAsync(['snapshot', '--popup', '--no-color'], {
      stdin: ttyIn,
      stdout: ttyOut,
      cliHome,
      cwd: wsDir,
      env: {},
    });
    assert.ok(ttyOut.text().startsWith('\x1b[?1049h\x1b[?25l'));
    ttyIn.emit('data', Buffer.from('\r'));
    const ttyCode = await popupPromise;
    assert.equal(ttyCode, 0);
    assert.ok(ttyOut.text().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('returns exit code 1 without entering alt-screen when interactive popup fails session lookup', async () => {
    const ttyIn = new FakeTtyIn(true);
    const ttyOut = new FakeTtyOut(true, 96, 14);
    let errText = '';
    const code = await runCliEntryAsync(['snapshot', '-p', '-s', 'missing-9999'], {
      stdin: ttyIn,
      stdout: ttyOut,
      stderr: {
        write: (chunk: string): boolean => {
          errText += chunk;
          return true;
        },
      },
      cliHome,
      cwd: wsDir,
      env: {},
    });
    assert.equal(code, 1);
    assert.equal(ttyOut.text().includes('\x1b[?1049h'), false);
    assert.ok(errText.includes('Error:'));
  });

  void it('executes pre-parsed snapshot arguments without reparsing', () => {
    const parsed = parseSnapshotArgs(['--help']);
    const result = executeParsedSnapshotCommand(parsed);
    assert.ok(result.output.includes('agy-hud snapshot'));
  });

  void it('routes bare snapshot filter arguments through runCliEntry', () => {
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'bare-filter-3333', conversation_title: 'Bare Filter Session', cwd: wsDir },
      process.pid,
    );

    const syncRes = captureSyncRun(() =>
      runCliEntry(['tools', '--no-color'], {
        cliHome,
        cwd: wsDir,
        env: {},
      }),
    );
    assert.equal(syncRes.code, 0);
    assert.ok(syncRes.stdout.includes('── Tools ('));
    assert.equal(syncRes.stdout.includes('── Skills ('), false);
    assert.throws(() => parseSnapshotArgs(['constructor']), /Unknown snapshot filter/);
  });

  void it('routes bare snapshot filter with popup flag through runCliEntryAsync', async () => {
    writeSnapshotEnvelope(
      cliHome,
      { conversation_id: 'bare-filter-4444', conversation_title: 'Bare Popup Filter', cwd: wsDir },
      process.pid,
    );

    const ttyIn = new FakeTtyIn(true);
    const ttyOut = new FakeTtyOut(true, 96, 14);
    const asyncPromise = runCliEntryAsync(['tools', '-p', '--no-color'], {
      stdin: ttyIn,
      stdout: ttyOut,
      cliHome,
      cwd: wsDir,
      env: {},
    });
    assert.ok(ttyOut.text().includes('── Tools ('));
    ttyIn.emit('data', Buffer.from('q'));
    assert.equal(await asyncPromise, 0);
  });
});
