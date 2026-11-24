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
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
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
}

export function isInteractiveTty(
  stdin: TtyInputStream = process.stdin,
  stdout: TtyOutputStream = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function runAltScreenTtySession<TResult>(options: AltScreenTtySessionOptions<TResult>): Promise<TResult> {
  const { stdin, stdout, render, onKey, onEscTimeout } = options;
  const escTimeoutMs = options.escTimeoutMs ?? ESC_SEQUENCE_TIMEOUT_MS;

  let pendingEsc = false;
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  let rawModeEnabled = false;
  let onData: ((chunk: Buffer | string) => void) | null = null;

  const clearPendingEsc = (): void => {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
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
    stdout.on('resize', render);

    return await new Promise<TResult>((resolve) => {
      let settled = false;
      const finish = (result: TResult): void => {
        if (settled) return;
        settled = true;
        clearPendingEsc();
        if (onData !== null) {
          stdin.off('data', onData);
          onData = null;
        }
        resolve(result);
      };

      onData = (chunk: Buffer | string): void => {
        clearPendingEsc();
        const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const seq = pendingEsc ? `${ESC_CHAR}${raw}` : raw;
        pendingEsc = false;

        if (seq === ESC_CHAR) {
          pendingEsc = true;
          escTimer = setTimeout(() => {
            escTimer = null;
            pendingEsc = false;
            onEscTimeout(finish);
          }, escTimeoutMs);
          return;
        }

        onKey(seq, finish);
      };

      stdin.on('data', onData);
    });
  } finally {
    clearPendingEsc();
    stdout.off('resize', render);
    if (onData !== null) {
      stdin.off('data', onData);
    }
    if (rawModeEnabled && typeof stdin.setRawMode === 'function') {
      try {
        stdin.setRawMode(false);
      } catch {
        // Ignore raw mode restore failure if stream already closed.
      }
    }
    stdin.pause();
    stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_EXIT}`);
  }
}
