import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCliEntry, runCliEntryAsync } from '../../cli-entry.ts';
import { buildPresetConfig } from '../../core/hud-config.ts';
import type { HudConfig } from '../../types.ts';
import { runConfigureInteractive } from '../configure-tui.ts';
import type { PopupInputStream, PopupOutputStream } from '../snapshot-popup.ts';

const tempDirs: string[] = [];

function makeTempCliHome(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return path.join(root, '.gemini', 'antigravity-cli');
}

class MockConfigureInput extends EventEmitter implements PopupInputStream {
  isTTY: boolean;
  rawModes: boolean[] = [];
  resumed = false;
  paused = false;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }

  resume(): void {
    this.resumed = true;
  }

  pause(): void {
    this.paused = true;
  }
}

class MockConfigureOutput extends EventEmitter implements PopupOutputStream {
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

  joined(): string {
    return this.chunks.join('');
  }
}

function makeStderrCapture(): { stream: { write(chunk: string): boolean }; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    },
    text: (): string => chunks.join(''),
  };
}

function captureProcessRun(fn: () => number): { code: number; stdout: string; stderr: string } {
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
    return { code: fn(), stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function makeStreams(
  isTTY: boolean,
  cols = 100,
  rows = 24,
): {
  stdin: MockConfigureInput;
  stdout: MockConfigureOutput;
  stderr: ReturnType<typeof makeStderrCapture>;
} {
  return {
    stdin: new MockConfigureInput(isTTY),
    stdout: new MockConfigureOutput(isTTY, isTTY ? cols : undefined, isTTY ? rows : undefined),
    stderr: makeStderrCapture(),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

void describe('runConfigureInteractive TTY runner', () => {
  void it('exits 1 with actionable non-interactive hint without writing disk when not a TTY', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-nontty-hint-');
    const { stdin, stdout, stderr } = makeStreams(false);

    const code = await runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream });

    assert.equal(code, 1);
    assert.ok(stderr.text().includes('agy-hud configure <preset>'));
    assert.equal(existsSync(path.join(cliHome, 'hud-config.json')), false);
  });

  void it('emits zero ANSI control sequences and skips raw mode on non-TTY', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-nontty-ansi-');
    const { stdin, stdout, stderr } = makeStreams(false);

    await runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream });

    assert.deepEqual(stdin.rawModes, []);
    assert.equal(stdin.resumed, false);
    assert.equal(stdout.joined(), '');
    assert.equal(stderr.text().includes('\x1b['), false);
  });

  void it('saves selected Tier 1 preset atomically on Enter', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-t1-save-');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    // full (idx 4) -> Up -> swarm (idx 3) -> Enter
    stdin.emit('data', Buffer.from('\x1b[A'));
    stdin.emit('data', Buffer.from('\r'));
    const code = await promise;

    assert.equal(code, 0);
    const saved = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.equal(saved.preset, 'swarm');
    assert.deepEqual(saved.lines, ['mode', 'identity', 'usage', 'agents', 'todos']);
  });

  void it('restores raw mode, alt-screen, cursor, and stream listeners on exit', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-t1-restore-');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    assert.deepEqual(stdin.rawModes, [true]);
    assert.equal(stdin.resumed, true);
    assert.ok(stdout.joined().startsWith('\x1b[?1049h\x1b[?25l'));

    stdin.emit('data', Buffer.from('\r'));
    assert.equal(await promise, 0);
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, true);
    assert.ok(stdout.joined().includes('\x1b[?25h\x1b[?1049l'));
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.equal(stdin.listenerCount('data'), 0);
  });

  void it('redraws the interactive frame when stdout emits resize', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-resize-');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    const writesBeforeResize = stdout.chunks.length;
    stdout.columns = 112;
    stdout.rows = 28;
    stdout.emit('resize');
    assert.ok(stdout.chunks.length > writesBeforeResize);

    stdin.emit('data', Buffer.from('q'));
    assert.equal(await promise, 0);
  });

  void it('persists Tier 2 line reordering on Enter', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-t2-order-');
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(path.join(cliHome, 'hud-config.json'), `${JSON.stringify(buildPresetConfig('compact'))}\n`, 'utf8');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    stdin.emit('data', Buffer.from('\t'));
    stdin.emit('data', Buffer.from('\x1b[B'));
    stdin.emit('data', Buffer.from('\x1b[B'));
    stdin.emit('data', Buffer.from('['));
    stdin.emit('data', Buffer.from('\r'));

    assert.equal(await promise, 0);
    const saved = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.deepEqual(saved.lines, ['mode', 'usage', 'identity', 'activity']);
  });

  void it('persists Tier 2 line module toggle on Enter', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-t2-toggle-');
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(path.join(cliHome, 'hud-config.json'), `${JSON.stringify(buildPresetConfig('compact'))}\n`, 'utf8');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    stdin.emit('data', Buffer.from('\t'));
    for (let i = 0; i < 4; i += 1) {
      stdin.emit('data', Buffer.from('\x1b[B'));
    }
    stdin.emit('data', Buffer.from(' '));
    stdin.emit('data', Buffer.from('\r'));

    assert.equal(await promise, 0);
    const saved = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.deepEqual(saved.lines, ['mode', 'identity', 'usage', 'activity', 'tools']);
  });

  void it('persists Tier 2 osc8Links toggle on Enter', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-t2-osc8-');
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(path.join(cliHome, 'hud-config.json'), `${JSON.stringify(buildPresetConfig('compact'))}\n`, 'utf8');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    stdin.emit('data', Buffer.from('\t'));
    for (let i = 0; i < 20; i += 1) {
      stdin.emit('data', Buffer.from('j'));
    }
    stdin.emit('data', Buffer.from(' '));
    stdin.emit('data', Buffer.from('\r'));

    assert.equal(await promise, 0);
    const saved = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.equal(saved.osc8Links, false);
  });

  void it('cancels on q without modifying existing hud-config.json on disk', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-cancel-q-');
    mkdirSync(cliHome, { recursive: true });
    const configPath = path.join(cliHome, 'hud-config.json');
    const originalRaw = `${JSON.stringify(buildPresetConfig('zen'), null, 2)}\n`;
    writeFileSync(configPath, originalRaw, 'utf8');

    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    stdin.emit('data', Buffer.from('\x1b[B'));
    stdin.emit('data', Buffer.from('q'));
    const code = await promise;

    assert.equal(code, 0);
    assert.equal(readFileSync(configPath, 'utf8'), originalRaw);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('cancels on Ctrl+C in Tier 2 without modifying existing hud-config.json on disk', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-cancel-ctrlc-');
    mkdirSync(cliHome, { recursive: true });
    const configPath = path.join(cliHome, 'hud-config.json');
    const originalRaw = `${JSON.stringify(buildPresetConfig('compact'), null, 2)}\n`;
    writeFileSync(configPath, originalRaw, 'utf8');

    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false });
    stdin.emit('data', Buffer.from('\t'));
    stdin.emit('data', Buffer.from(' '));
    stdin.emit('data', Buffer.from('\x03'));
    const code = await promise;

    assert.equal(code, 0);
    assert.equal(readFileSync(configPath, 'utf8'), originalRaw);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('treats split CSI arrow sequence as navigation without canceling', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-csi-');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({
      cliHome,
      stdin,
      stdout,
      stderr: stderr.stream,
      color: false,
      escTimeoutMs: 25,
    });
    const initialWrites = stdout.chunks.length;
    stdin.emit('data', Buffer.from('\x1b'));
    await new Promise((r) => setTimeout(r, 5));
    stdin.emit('data', Buffer.from('[A'));
    await new Promise((r) => setTimeout(r, 35));

    assert.ok(stdout.chunks.length > initialWrites, 'split arrow CSI should update selection and redraw');
    assert.equal(stdout.joined().includes('\x1b[?1049l'), false, 'split arrow CSI must not cancel');

    stdin.emit('data', Buffer.from('q'));
    assert.equal(await promise, 0);
  });

  void it('cancels without writing disk after standalone Esc timeout', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-esc-');
    const { stdin, stdout, stderr } = makeStreams(true);

    const promise = runConfigureInteractive({
      cliHome,
      stdin,
      stdout,
      stderr: stderr.stream,
      color: false,
      escTimeoutMs: 25,
    });
    stdin.emit('data', Buffer.from('\x1b'));
    const code = await promise;

    assert.equal(code, 0);
    assert.equal(existsSync(path.join(cliHome, 'hud-config.json')), false);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('restores alt-screen and cursor in finally even if entering raw mode throws', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-err-');
    const { stdin, stdout, stderr } = makeStreams(true);
    stdin.setRawMode = (): void => {
      throw new Error('raw mode failed');
    };

    await assert.rejects(
      runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false }),
      /raw mode failed/,
    );
    assert.ok(stdout.joined().startsWith('\x1b[?1049h\x1b[?25l'));
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
    assert.equal(stdin.paused, true);
  });

  void it('rejects corrupted hud-config.json before entering alt-screen and leaves file untouched', async () => {
    const cliHome = makeTempCliHome('agy-hud-tui-corrupt-');
    mkdirSync(cliHome, { recursive: true });
    const configPath = path.join(cliHome, 'hud-config.json');
    const rawCorrupt = '{broken-json';
    writeFileSync(configPath, rawCorrupt, 'utf8');

    const { stdin, stdout, stderr } = makeStreams(true);

    await assert.rejects(
      runConfigureInteractive({ cliHome, stdin, stdout, stderr: stderr.stream, color: false }),
      /Invalid JSON/,
    );
    assert.equal(stdout.joined(), '');
    assert.deepEqual(stdin.rawModes, []);
    assert.equal(readFileSync(configPath, 'utf8'), rawCorrupt);
  });
});

void describe('configure -i CLI entry wiring', () => {
  void it('enforces non-TTY guard through runCliEntryAsync configure --interactive', async () => {
    const cliHome = makeTempCliHome('agy-hud-cli-tui-nontty-');
    const { stdin: nonTtyIn, stdout: nonTtyOut, stderr: nonTtyErr } = makeStreams(false);

    const code = await runCliEntryAsync(['configure', '--interactive'], {
      cliHome,
      stdin: nonTtyIn,
      stdout: nonTtyOut,
      stderr: nonTtyErr.stream,
      env: {},
    });
    assert.equal(code, 1);
    assert.equal(nonTtyOut.joined(), '');
    assert.equal(nonTtyErr.text().includes('\x1b['), false);
    assert.ok(nonTtyErr.text().includes('agy-hud configure <preset>'));
  });

  void it('saves preset edits through runCliEntryAsync configure -i on a TTY', async () => {
    const cliHome = makeTempCliHome('agy-hud-cli-tui-tty-');
    const { stdin: ttyIn, stdout: ttyOut, stderr: ttyErr } = makeStreams(true);

    const savePromise = runCliEntryAsync(['configure', '-i'], {
      cliHome,
      stdin: ttyIn,
      stdout: ttyOut,
      stderr: ttyErr.stream,
      env: { NO_COLOR: '1' },
    });
    assert.ok(ttyOut.joined().startsWith('\x1b[?1049h\x1b[?25l'));
    ttyIn.emit('data', Buffer.from('\x1b[A')); // full -> swarm
    ttyIn.emit('data', Buffer.from('\r'));
    const saveCode = await savePromise;

    assert.equal(saveCode, 0);
    assert.equal(ttyErr.text(), '');
    const saved = JSON.parse(readFileSync(path.join(cliHome, 'hud-config.json'), 'utf8')) as HudConfig;
    assert.equal(saved.preset, 'swarm');
  });

  void it('returns exit 1 with Error on stderr when configure -i encounters corrupted hud-config.json', async () => {
    const cliHome = makeTempCliHome('agy-hud-cli-tui-corrupt-');
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(path.join(cliHome, 'hud-config.json'), '{bad', 'utf8');

    const { stdin: ttyIn, stdout: ttyOut, stderr: ttyErr } = makeStreams(true);
    const code = await runCliEntryAsync(['configure', '-i'], {
      cliHome,
      stdin: ttyIn,
      stdout: ttyOut,
      stderr: ttyErr.stream,
      env: {},
    });
    assert.equal(code, 1);
    assert.equal(ttyOut.joined(), '');
    assert.ok(ttyErr.text().includes('Error:'));
  });

  void it('prints configure help when configure -i --help is requested', () => {
    const helpRun = captureProcessRun(() => runCliEntry(['configure', '-i', '--help']));
    assert.equal(helpRun.code, 0);
    assert.ok(helpRun.stdout.includes('agy-hud configure'));
  });

  void it('emits non-TTY usage hint synchronously when runCliEntry receives configure -i', () => {
    const syncInteractive = captureProcessRun(() => runCliEntry(['configure', '-i']));
    assert.equal(syncInteractive.code, 1);
    assert.equal(syncInteractive.stdout, '');
    assert.equal(syncInteractive.stderr.includes('\x1b['), false);
    assert.ok(syncInteractive.stderr.includes('agy-hud configure <preset>'));
  });
});
