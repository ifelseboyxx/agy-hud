import { StringDecoder } from 'node:string_decoder';

export const ESC_SEQUENCE_TIMEOUT_MS: number = 25;
export const ESC_CHAR: string = String.fromCharCode(0x1b);
export const CTRL_C: string = String.fromCharCode(0x03);

const ALT_SCREEN_ENTER = `${ESC_CHAR}[?1049h`;
const ALT_SCREEN_EXIT = `${ESC_CHAR}[?1049l`;
const CURSOR_HIDE = `${ESC_CHAR}[?25l`;
const CURSOR_SHOW = `${ESC_CHAR}[?25h`;

export interface TtyInputStream {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'end' | 'close', listener: () => void): unknown;
  off(event: 'error', listener: (err: Error) => void): unknown;
}

export interface TtyOutputStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

export interface AltScreenTtySessionOptions<TResult> {
  readonly stdin: TtyInputStream;
  readonly stdout: TtyOutputStream;
  readonly escTimeoutMs?: number;
  readonly render: () => void;
  readonly onKey: (seq: string, finish: (result: TResult) => void) => void;
  readonly onEscTimeout: (finish: (result: TResult) => void) => void;
  readonly onClose?: (finish: (result: TResult) => void) => void;
}

export function isInteractiveTty(
  stdin: TtyInputStream = process.stdin,
  stdout: TtyOutputStream = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

function consumeTtyInputBuffer(buffer: string): { keys: string[]; pending: string } {
  const keys: string[] = [];
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] === ESC_CHAR) {
      if (i + 1 >= buffer.length) {
        return { keys, pending: buffer.slice(i) };
      }
      const next = buffer[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < buffer.length) {
          const code = buffer.charCodeAt(j);
          if (code >= 0x30 && code <= 0x3f) {
            j += 1;
            continue;
          }
          break;
        }
        while (j < buffer.length) {
          const code = buffer.charCodeAt(j);
          if (code >= 0x20 && code <= 0x2f) {
            j += 1;
            continue;
          }
          break;
        }
        if (j >= buffer.length) {
          return { keys, pending: buffer.slice(i) };
        }
        const finalCode = buffer.charCodeAt(j);
        if (finalCode >= 0x40 && finalCode <= 0x7e) {
          keys.push(buffer.slice(i, j + 1));
          i = j + 1;
          continue;
        }
        keys.push(ESC_CHAR);
        i += 1;
        continue;
      }
      if (next === ESC_CHAR) {
        keys.push(ESC_CHAR);
        i += 1;
        continue;
      }
      if (next === 'O') {
        if (i + 2 >= buffer.length) {
          return { keys, pending: buffer.slice(i) };
        }
        const ss3Final = buffer.charCodeAt(i + 2);
        if (ss3Final >= 0x40 && ss3Final <= 0x7e) {
          keys.push(buffer.slice(i, i + 3));
          i += 3;
          continue;
        }
        keys.push(ESC_CHAR);
        i += 1;
        continue;
      }
      keys.push(buffer.slice(i, i + 2));
      i += 2;
      continue;
    }
    const cp = buffer.codePointAt(i);
    const ch = cp !== undefined ? String.fromCodePoint(cp) : (buffer[i] ?? '');
    if (ch.length === 0) break;
    keys.push(ch);
    i += ch.length;
  }
  return { keys, pending: '' };
}

export async function runAltScreenTtySession<TResult>(options: AltScreenTtySessionOptions<TResult>): Promise<TResult> {
  const { stdin, stdout, render, onKey, onEscTimeout } = options;
  const escTimeoutMs = options.escTimeoutMs ?? ESC_SEQUENCE_TIMEOUT_MS;

  let pendingBuffer = '';
  const utf8Decoder = new StringDecoder('utf8');
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  let rawModeEnabled = false;
  let onData: ((chunk: Buffer | string) => void) | null = null;
  let onStreamClose: (() => void) | null = null;
  let onStreamError: ((err: Error) => void) | null = null;
  let onResize: (() => void) | null = null;

  const clearPendingEsc = (): void => {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  };

  const detachListeners = (): void => {
    clearPendingEsc();
    if (onResize !== null) {
      stdout.off('resize', onResize);
      onResize = null;
    }
    if (onData !== null) {
      stdin.off('data', onData);
      onData = null;
    }
    if (onStreamClose !== null) {
      stdin.off('end', onStreamClose);
      stdin.off('close', onStreamClose);
      onStreamClose = null;
    }
    if (onStreamError !== null) {
      stdin.off('error', onStreamError);
      onStreamError = null;
    }
  };

  stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}`);
  try {
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
      rawModeEnabled = true;
    }
    stdin.resume();
    render();

    return await new Promise<TResult>((resolve, reject) => {
      let settled = false;
      const finish = (result: TResult): void => {
        if (settled) return;
        settled = true;
        detachListeners();
        resolve(result);
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        detachListeners();
        reject(err);
      };

      onResize = (): void => {
        if (settled) return;
        try {
          render();
        } catch (err) {
          fail(err);
        }
      };

      onData = (chunk: Buffer | string): void => {
        if (settled) return;
        try {
          clearPendingEsc();
          const raw = typeof chunk === 'string' ? chunk : utf8Decoder.write(chunk);
          const combined = pendingBuffer.length > 0 ? `${pendingBuffer}${raw}` : raw;
          pendingBuffer = '';
          const { keys, pending } = consumeTtyInputBuffer(combined);

          for (const key of keys) {
            if (settled) return;
            onKey(key, finish);
          }

          if (!settled && pending.length > 0) {
            pendingBuffer = pending;
            escTimer = setTimeout(() => {
              escTimer = null;
              const timedOut = pendingBuffer;
              pendingBuffer = '';
              if (settled) return;
              try {
                if (timedOut === ESC_CHAR) {
                  onEscTimeout(finish);
                } else if (timedOut.length > 0) {
                  onKey(timedOut, finish);
                }
              } catch (err) {
                fail(err);
              }
            }, escTimeoutMs);
          }
        } catch (err) {
          fail(err);
        }
      };

      onStreamClose = (): void => {
        if (settled) return;
        try {
          (options.onClose ?? onEscTimeout)(finish);
        } catch (err) {
          fail(err);
        }
      };

      onStreamError = (err: Error): void => {
        fail(err);
      };

      stdout.on('resize', onResize);
      stdin.on('data', onData);
      stdin.on('end', onStreamClose);
      stdin.on('close', onStreamClose);
      stdin.on('error', onStreamError);
    });
  } finally {
    detachListeners();
    if (rawModeEnabled && typeof stdin.setRawMode === 'function') {
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore raw mode restore failure if stream already closed.
      }
    }
    try {
      stdin.pause();
    } catch {
      // Ignore pause failure if stream already closed.
    }
    try {
      stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
    } catch {
      // Ignore write failure during terminal restore.
    }
  }
}
