import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { runAltScreenTtySession, type TtyInputStream, type TtyOutputStream } from '../tty-session.ts';

class TrackingTtyInput extends EventEmitter implements TtyInputStream {
  readonly isTTY = true;
  readonly rawModes: boolean[] = [];
  paused = false;

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

class TrackingTtyOutput extends EventEmitter implements TtyOutputStream {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  joined(): string {
    return this.chunks.join('');
  }
}

void describe('runAltScreenTtySession exception cleanup', () => {
  void it('restores terminal state when onKey callback throws', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();

    const session = runAltScreenTtySession<void>({
      stdin,
      stdout,
      render: () => {},
      onEscTimeout: (finish) => finish(),
      onKey: () => {
        throw new Error('keypress boom');
      },
    });

    stdin.emit('data', Buffer.from('x'));
    await assert.rejects(session, /keypress boom/);

    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, true);
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('restores terminal state when resize render callback throws', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();
    let renderCalls = 0;

    const session = runAltScreenTtySession<void>({
      stdin,
      stdout,
      render: () => {
        renderCalls += 1;
        if (renderCalls === 2) {
          throw new Error('resize boom');
        }
      },
      onEscTimeout: (finish) => finish(),
      onKey: () => {},
    });

    stdout.emit('resize');
    await assert.rejects(session, /resize boom/);

    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, true);
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('restores terminal state when Esc timeout callback throws', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();

    const session = runAltScreenTtySession<void>({
      stdin,
      stdout,
      escTimeoutMs: 10,
      render: () => {},
      onEscTimeout: () => {
        throw new Error('esc timer boom');
      },
      onKey: () => {},
    });

    stdin.emit('data', Buffer.from('\x1b'));
    await assert.rejects(session, /esc timer boom/);

    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, true);
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdin.listenerCount('end'), 0);
    assert.equal(stdin.listenerCount('close'), 0);
    assert.equal(stdin.listenerCount('error'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('settles cleanly when stdin emits end', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();

    const session = runAltScreenTtySession<'save' | 'cancel'>({
      stdin,
      stdout,
      escTimeoutMs: 500,
      render: () => {},
      onEscTimeout: (finish) => finish('cancel'),
      onKey: () => {},
    });

    stdin.emit('data', Buffer.from('\x1b'));
    stdin.emit('end');
    assert.equal(await session, 'cancel');
  });

  void it('restores terminal state when stdin emits end', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();

    const session = runAltScreenTtySession<'save' | 'cancel'>({
      stdin,
      stdout,
      escTimeoutMs: 500,
      render: () => {},
      onEscTimeout: (finish) => finish('cancel'),
      onKey: () => {},
    });

    stdin.emit('data', Buffer.from('\x1b'));
    stdin.emit('end');
    await session;
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, true);
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdin.listenerCount('end'), 0);
    assert.equal(stdin.listenerCount('close'), 0);
    assert.equal(stdin.listenerCount('error'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('settles cleanly when stdin emits close', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();

    const session = runAltScreenTtySession<'save' | 'cancel'>({
      stdin,
      stdout,
      render: () => {},
      onEscTimeout: (finish) => finish('cancel'),
      onKey: () => {},
    });

    stdin.emit('close');
    assert.equal(await session, 'cancel');
    assert.equal(stdin.listenerCount('close'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
  });

  void it('rejects when stdin emits error', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();

    const session = runAltScreenTtySession<void>({
      stdin,
      stdout,
      render: () => {},
      onEscTimeout: (finish) => finish(),
      onKey: () => {},
    });

    stdin.emit('error', new Error('stdin broken pipe'));
    await assert.rejects(session, /stdin broken pipe/);
  });

  void it('restores terminal state when stdin emits error', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();

    const session = runAltScreenTtySession<void>({
      stdin,
      stdout,
      render: () => {},
      onEscTimeout: (finish) => finish(),
      onKey: () => {},
    });

    stdin.emit('error', new Error('stdin broken pipe'));
    await assert.rejects(session);
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.listenerCount('error'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.ok(stdout.joined().endsWith('\x1b[?25h\x1b[?1049l'));
  });

  void it('splits coalesced keys inside a single data chunk', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();
    const received: string[] = [];

    const session = runAltScreenTtySession<string[]>({
      stdin,
      stdout,
      escTimeoutMs: 25,
      render: () => {},
      onEscTimeout: (finish) => finish(received),
      onKey: (seq, finish) => {
        received.push(seq);
        if (seq === 'q') finish(received);
      },
    });

    stdin.emit('data', Buffer.from('\x1b[B\x1b[A\t\rjq'));
    const keys = await session;
    assert.deepEqual(keys, ['\x1b[B', '\x1b[A', '\t', '\r', 'j', 'q']);
  });

  void it('separates consecutive Esc followed by CSI arrow without corrupting the arrow sequence', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();
    const received: string[] = [];

    const session = runAltScreenTtySession<string[]>({
      stdin,
      stdout,
      escTimeoutMs: 25,
      render: () => {},
      onEscTimeout: (finish) => finish(received),
      onKey: (seq, finish) => {
        received.push(seq);
        if (seq === 'q') finish(received);
      },
    });

    stdin.emit('data', Buffer.from('\x1b\x1b[Aq'));
    assert.deepEqual(await session, ['\x1b', '\x1b[A', 'q']);
  });

  void it('reassembles CSI sequences split across chunks', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();
    const received: string[] = [];

    const session = runAltScreenTtySession<string[]>({
      stdin,
      stdout,
      escTimeoutMs: 25,
      render: () => {},
      onEscTimeout: (finish) => finish(received),
      onKey: (seq, finish) => {
        received.push(seq);
        if (seq === 'q') finish(received);
      },
    });

    stdin.emit('data', Buffer.from('\x1b['));
    stdin.emit('data', Buffer.from('Bq'));
    assert.deepEqual(await session, ['\x1b[B', 'q']);
  });

  void it('fires Esc timeout for a trailing standalone Esc after normal keys', async () => {
    const stdin = new TrackingTtyInput();
    const stdout = new TrackingTtyOutput();
    const received: string[] = [];

    const session = runAltScreenTtySession<string[]>({
      stdin,
      stdout,
      escTimeoutMs: 15,
      render: () => {},
      onEscTimeout: (finish) => {
        received.push('ESC_TIMEOUT');
        finish(received);
      },
      onKey: (seq) => {
        received.push(seq);
      },
    });

    stdin.emit('data', Buffer.from('j\x1b'));
    assert.deepEqual(await session, ['j', 'ESC_TIMEOUT']);
  });
});
