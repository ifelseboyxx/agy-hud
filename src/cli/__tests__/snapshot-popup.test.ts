import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { stripAnsi } from '../../render/ansi.ts';
import type { ActivitySnapshot, SnapshotCompletedTool } from '../../snapshot-types.ts';
import {
  applyPopupKey,
  createPopupState,
  type PopupInputStream,
  type PopupOutputStream,
  renderPopupFrame,
  runSnapshotPopup,
} from '../snapshot-popup.ts';

function makePopupSnapshot(toolCount = 12, title = 'Popup Session'): ActivitySnapshot {
  const completedTools: SnapshotCompletedTool[] = Array.from({ length: toolCount }, (_, idx) => ({
    disp: `tool_${String(idx + 1).padStart(2, '0')}`,
    count: toolCount - idx,
    latestTarget: `src/file_${idx + 1}.ts`,
    fullTarget: `/repo/src/file_${idx + 1}.ts`,
    recentTargets: [`/repo/src/file_${idx + 1}.ts`],
    isMcp: false,
  }));

  return {
    convId: 'popup-12345678',
    shortId: 'popup-12',
    surface: 'cli',
    title,
    model: 'Gemini 4 Carbon',
    workspace: '/repo/agy-hud',
    dataRoot: '/home/.gemini/antigravity-cli',
    resolutionTier: 'pid',
    running: false,
    updatedAtMs: Date.parse('2026-06-01T12:00:00Z'),
    ageLabel: '5s ago',
    livePid: 1001,
    siblingCandidates: [],
    siblingHint: '',
    telemetry: {
      genCount: 1,
      tps: 80,
      ttft: 1.1,
      cachePct: 90,
      ctxUsed: 10_000,
      ctxMax: 200_000,
    },
    runningTools: [],
    completedTools,
    totalToolCalls: 78,
    skills: ['tdd', 'codebase-design'],
    mcps: [{ server: 'agy-fast', totalCalls: 3, subtools: [{ name: 'run_checks', count: 3 }] }],
    agentsKind: 'agents',
    agents: [
      { name: 'Reviewer', type: 'review', model: 'Gemini 4 Flash', state: 'done', ts: null, ageLabel: '1m ago' },
    ],
    todos: null,
  };
}

class MockTtyInput extends EventEmitter implements PopupInputStream {
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

class MockTtyOutput extends EventEmitter implements PopupOutputStream {
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

void describe('snapshot interactive popup overlay', () => {
  void it('handles dismiss keys, section filters, reload, and clamped scroll in pure key reducer', () => {
    for (const dismissSeq of ['q', 'Q', '\r', '\n', '\x03']) {
      const st = createPopupState([]);
      assert.equal(applyPopupKey(st, dismissSeq, 10), 'dismiss', `expected ${JSON.stringify(dismissSeq)} to dismiss`);
    }

    const state = createPopupState([]);
    assert.equal(applyPopupKey(state, '1', 10), 'redraw');
    assert.deepEqual(state.sections, ['tools']);
    assert.equal(applyPopupKey(state, '1', 10), 'redraw');
    assert.deepEqual(state.sections, [], 'pressing active section toggles back to all');

    assert.equal(applyPopupKey(state, '2', 10), 'redraw');
    assert.deepEqual(state.sections, ['skills']);
    assert.equal(applyPopupKey(state, '3', 10), 'redraw');
    assert.deepEqual(state.sections, ['mcps']);
    assert.equal(applyPopupKey(state, '4', 10), 'redraw');
    assert.deepEqual(state.sections, ['agents']);
    assert.equal(applyPopupKey(state, 'a', 10), 'redraw');
    assert.deepEqual(state.sections, []);

    assert.equal(applyPopupKey(state, 'r', 10), 'reload');

    assert.equal(applyPopupKey(state, 'j', 2), 'redraw');
    assert.equal(state.scrollOffset, 1);
    assert.equal(applyPopupKey(state, '\x1b[B', 2), 'redraw');
    assert.equal(state.scrollOffset, 2);
    assert.equal(applyPopupKey(state, 'j', 2), 'noop', 'clamps at maxScrollOffset');
    assert.equal(state.scrollOffset, 2);
    assert.equal(applyPopupKey(state, '\x1b[A', 2), 'redraw');
    assert.equal(state.scrollOffset, 1);
    assert.equal(applyPopupKey(state, 'k', 2), 'redraw');
    assert.equal(state.scrollOffset, 0);
    assert.equal(applyPopupKey(state, 'k', 2), 'noop', 'clamps at 0');
  });

  void it('degrades immediately to one-shot non-interactive print when stdin or stdout is not a TTY', async () => {
    const stdin = new MockTtyInput(false);
    const stdout = new MockTtyOutput(false);

    const code = await runSnapshotPopup({
      loadSnapshot: () => makePopupSnapshot(4),
      stdin,
      stdout,
      color: false,
    });

    assert.equal(code, 0);
    assert.deepEqual(stdin.rawModes, []);
    assert.equal(stdin.resumed, false);
    const text = stdout.joined();
    assert.equal(text.includes('\x1b[?1049h'), false);
    assert.ok(text.includes('[CLI] Activity Snapshot'));
    assert.ok(text.includes('tool_01'));
  });

  void it('enters alt-screen + hidden cursor + raw mode, redraws on resize, reloads on r, and restores in finally', async () => {
    const stdin = new MockTtyInput(true);
    const stdout = new MockTtyOutput(true, 90, 12);
    let loadCount = 0;

    const promise = runSnapshotPopup({
      loadSnapshot: () => {
        loadCount += 1;
        return makePopupSnapshot(12, loadCount === 1 ? 'First Load' : 'Reloaded Load');
      },
      stdin,
      stdout,
      color: false,
      escTimeoutMs: 25,
    });

    assert.equal(loadCount, 1);
    assert.deepEqual(stdin.rawModes, [true]);
    assert.equal(stdin.resumed, true);
    assert.ok(stdout.joined().startsWith('\x1b[?1049h\x1b[?25l'));
    assert.ok(stdout.joined().includes('First Load'));

    const writesBeforeResize = stdout.chunks.length;
    stdout.columns = 104;
    stdout.rows = 14;
    stdout.emit('resize');
    assert.ok(stdout.chunks.length > writesBeforeResize, 'resize should trigger redraw');

    stdin.emit('data', Buffer.from('r'));
    assert.equal(loadCount, 2, 'r should live-reload snapshot');
    assert.ok(stdout.joined().includes('Reloaded Load'));

    stdin.emit('data', Buffer.from('q'));
    const code = await promise;

    assert.equal(code, 0);
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, true);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.equal(stdin.listenerCount('data'), 0);
  });

  void it('distinguishes standalone Esc (25ms dismiss) from split arrow CSI sequences without dismissing', async () => {
    const stdin = new MockTtyInput(true);
    const stdout = new MockTtyOutput(true, 88, 10);

    const promise = runSnapshotPopup({
      loadSnapshot: () => makePopupSnapshot(16),
      stdin,
      stdout,
      color: false,
      escTimeoutMs: 25,
    });

    const initialWriteCount = stdout.chunks.length;
    stdin.emit('data', Buffer.from('\x1b'));
    await new Promise((r) => setTimeout(r, 5));
    stdin.emit('data', Buffer.from('[B'));
    await new Promise((r) => setTimeout(r, 35));

    assert.ok(stdout.chunks.length > initialWriteCount, 'split arrow sequence should scroll and redraw');
    assert.equal(stdout.joined().includes('\x1b[?1049l'), false, 'split arrow CSI must NOT dismiss popup');

    stdin.emit('data', Buffer.from('\x1b'));
    const code = await promise;
    assert.equal(code, 0);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('clips body rows and shows scroll progress in the bottom shortcut bar when content exceeds viewport', () => {
    const snap = makePopupSnapshot(20);
    const state = createPopupState([]);
    const frame0 = renderPopupFrame(snap, state, { cols: 88, rows: 10, color: false });
    assert.ok(frame0.maxScrollOffset > 0);
    assert.ok(stripAnsi(frame0.output).includes('[1-4/a] all'));
    assert.ok(stripAnsi(frame0.output).includes('[q/Esc/Enter] Close'));
    assert.ok(stripAnsi(frame0.output).includes('L1-8/'));

    state.scrollOffset = 3;
    const frame3 = renderPopupFrame(snap, state, { cols: 88, rows: 10, color: false });
    assert.ok(stripAnsi(frame3.output).includes('L4-11/'));
  });

  void it('restores alt-screen and cursor in finally even if entering raw mode throws', async () => {
    const stdin = new MockTtyInput(true);
    stdin.setRawMode = (): void => {
      throw new Error('raw mode unsupported');
    };
    const stdout = new MockTtyOutput(true, 90, 12);

    await assert.rejects(
      runSnapshotPopup({
        loadSnapshot: () => makePopupSnapshot(4),
        stdin,
        stdout,
        color: false,
      }),
      /raw mode unsupported/,
    );
    assert.ok(stdout.joined().startsWith('\x1b[?1049h\x1b[?25l'));
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
    assert.equal(stdin.paused, true);
  });

  void it('dismisses in applyPopupKey on standalone Esc character', () => {
    assert.equal(applyPopupKey(createPopupState([]), '\x1b', 10), 'dismiss');
  });

  void it('dismisses popup immediately on rapid double Esc sequence', async () => {
    const stdin = new MockTtyInput(true);
    const stdout = new MockTtyOutput(true, 88, 12);
    const promise = runSnapshotPopup({
      loadSnapshot: () => makePopupSnapshot(4),
      stdin,
      stdout,
      color: false,
      escTimeoutMs: 500,
    });
    stdin.emit('data', Buffer.from('\x1b\x1b'));
    const code = await promise;
    assert.equal(code, 0);
  });
});
