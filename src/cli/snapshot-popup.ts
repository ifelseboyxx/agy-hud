import { padEndVisible, RESET, truncateToWidth } from '../render/ansi.ts';
import type { ActivitySnapshot, SnapshotSection } from '../snapshot-types.ts';
import {
  DEFAULT_INSPECTOR_WIDTH,
  renderStructuredInspector,
  renderStructuredInspectorLines,
  resolveInspectorWidth,
  shouldUseSnapshotColor,
} from './snapshot-render.ts';

export const ESC_SEQUENCE_TIMEOUT_MS: number = 25;

const DEFAULT_POPUP_ROWS = 32;
const MIN_POPUP_ROWS = 4;
const ESC_CHAR = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);
const ALT_SCREEN_ENTER = `${ESC_CHAR}[?1049h`;
const ALT_SCREEN_EXIT = `${ESC_CHAR}[?1049l`;
const CURSOR_HIDE = `${ESC_CHAR}[?25l`;
const CURSOR_SHOW = `${ESC_CHAR}[?25h`;
const CLEAR_HOME = `${ESC_CHAR}[H${ESC_CHAR}[2J`;
const BAR_BG = `${ESC_CHAR}[48;5;236m${ESC_CHAR}[97m`;

export interface PopupInputStream {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface PopupOutputStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

export interface PopupState {
  sections: SnapshotSection[];
  scrollOffset: number;
  statusNote: string;
}

export type PopupKeyEffect = 'dismiss' | 'redraw' | 'reload' | 'noop';

export interface PopupFrameOptions {
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
}

export interface PopupRenderedFrame {
  readonly output: string;
  readonly maxScrollOffset: number;
  readonly totalBodyLines: number;
}

export interface RunSnapshotPopupOptions {
  readonly loadSnapshot: () => ActivitySnapshot;
  readonly initialSections?: readonly SnapshotSection[];
  readonly color?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: PopupInputStream;
  readonly stdout?: PopupOutputStream;
  readonly escTimeoutMs?: number;
}

export function isPopupInteractiveTty(
  stdin: PopupInputStream = process.stdin,
  stdout: PopupOutputStream = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export function createPopupState(initialSections: readonly SnapshotSection[] = []): PopupState {
  return {
    sections: [...initialSections],
    scrollOffset: 0,
    statusNote: '',
  };
}

function togglePopupSection(state: PopupState, target: SnapshotSection): PopupKeyEffect {
  if (state.sections.length === 1 && state.sections[0] === target) {
    state.sections = [];
  } else {
    state.sections = [target];
  }
  state.scrollOffset = 0;
  state.statusNote = '';
  return 'redraw';
}

export function applyPopupKey(state: PopupState, seq: string, maxScrollOffset: number): PopupKeyEffect {
  if (seq === 'q' || seq === 'Q' || seq === '\r' || seq === '\n' || seq === CTRL_C) {
    return 'dismiss';
  }
  if (seq === '1') return togglePopupSection(state, 'tools');
  if (seq === '2') return togglePopupSection(state, 'skills');
  if (seq === '3') return togglePopupSection(state, 'mcps');
  if (seq === '4') return togglePopupSection(state, 'agents');
  if (seq === 'a' || seq === 'A' || seq === '0') {
    state.sections = [];
    state.scrollOffset = 0;
    state.statusNote = '';
    return 'redraw';
  }
  if (seq === 'r' || seq === 'R') {
    return 'reload';
  }
  if (seq === 'j' || seq === `${ESC_CHAR}[B` || seq === `${ESC_CHAR}OB`) {
    const next = Math.min(Math.max(0, maxScrollOffset), state.scrollOffset + 1);
    if (next === state.scrollOffset) return 'noop';
    state.scrollOffset = next;
    return 'redraw';
  }
  if (seq === 'k' || seq === `${ESC_CHAR}[A` || seq === `${ESC_CHAR}OA`) {
    const next = Math.max(0, state.scrollOffset - 1);
    if (next === state.scrollOffset) return 'noop';
    state.scrollOffset = next;
    return 'redraw';
  }
  return 'noop';
}

export function renderPopupFrame(
  snapshot: ActivitySnapshot,
  state: PopupState,
  options: PopupFrameOptions,
): PopupRenderedFrame {
  const cols = resolveInspectorWidth(options.cols, DEFAULT_INSPECTOR_WIDTH);
  const rows =
    Number.isFinite(options.rows) && options.rows >= MIN_POPUP_ROWS ? Math.floor(options.rows) : DEFAULT_POPUP_ROWS;
  const bodyLines = renderStructuredInspectorLines(snapshot, {
    sections: state.sections,
    width: cols,
    color: options.color,
  });

  const bodyHeight = Math.max(1, rows - 2);
  const maxScrollOffset = Math.max(0, bodyLines.length - bodyHeight);
  const clampedOffset = Math.max(0, Math.min(state.scrollOffset, maxScrollOffset));
  const visibleBody = bodyLines.slice(clampedOffset, clampedOffset + bodyHeight);

  const secLabel = state.sections.length === 0 ? 'all' : state.sections.join('+');
  const scrollLabel =
    maxScrollOffset > 0 ? ` | L${clampedOffset + 1}-${clampedOffset + visibleBody.length}/${bodyLines.length}` : '';
  const noteLabel = state.statusNote.length > 0 ? ` | ${state.statusNote}` : '';
  const barWidth = Math.max(10, cols - 1);
  const barPlain = ` [1-4/a] ${secLabel} | [j/k] Scroll${scrollLabel} | [r] Reload | [q/Esc/Enter] Close${noteLabel} `;
  const barFitted = padEndVisible(truncateToWidth(barPlain, barWidth), barWidth);
  const bar = options.color ? `${BAR_BG}${barFitted}${RESET}` : barFitted;

  const fillerCount = Math.max(0, rows - 1 - visibleBody.length);
  const output = `${CLEAR_HOME}${visibleBody.join('\n')}${'\n'.repeat(fillerCount + 1)}${bar}`;
  return { output, maxScrollOffset, totalBodyLines: bodyLines.length };
}

export async function runSnapshotPopup(options: RunSnapshotPopupOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const useColor = options.color !== undefined ? options.color : shouldUseSnapshotColor(options.noColor ?? false, env);
  const escTimeoutMs = options.escTimeoutMs ?? ESC_SEQUENCE_TIMEOUT_MS;

  if (!isPopupInteractiveTty(stdin, stdout)) {
    const snapshot = options.loadSnapshot();
    stdout.write(
      renderStructuredInspector(snapshot, {
        sections: options.initialSections,
        width: stdout.columns,
        color: useColor,
        env,
      }),
    );
    return 0;
  }

  let snapshot = options.loadSnapshot();
  const state = createPopupState(options.initialSections);
  let lastMaxScroll = 0;
  let pendingEsc = false;
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  let rawModeEnabled = false;

  const clearPendingEsc = (): void => {
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  };

  const draw = (): void => {
    const cols = resolveInspectorWidth(stdout.columns, DEFAULT_INSPECTOR_WIDTH);
    const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : DEFAULT_POPUP_ROWS;
    const frame = renderPopupFrame(snapshot, state, { cols, rows, color: useColor });
    lastMaxScroll = frame.maxScrollOffset;
    if (state.scrollOffset > lastMaxScroll) {
      state.scrollOffset = lastMaxScroll;
    }
    stdout.write(frame.output);
  };

  let onData: ((chunk: Buffer | string) => void) | null = null;
  stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}`);
  try {
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
      rawModeEnabled = true;
    }
    stdin.resume();
    draw();
    stdout.on('resize', draw);
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearPendingEsc();
        if (onData !== null) {
          stdin.off('data', onData);
          onData = null;
        }
        resolve();
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
            finish();
          }, escTimeoutMs);
          return;
        }

        const effect = applyPopupKey(state, seq, lastMaxScroll);
        if (effect === 'dismiss') {
          finish();
          return;
        }
        if (effect === 'reload') {
          try {
            snapshot = options.loadSnapshot();
            state.statusNote = '';
          } catch {
            state.statusNote = 'reload failed';
          }
          draw();
          return;
        }
        if (effect === 'redraw') {
          draw();
        }
      };

      stdin.on('data', onData);
    });
  } finally {
    clearPendingEsc();
    stdout.off('resize', draw);
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
  return 0;
}
