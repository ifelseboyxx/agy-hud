import { applyHudLineToggle, buildPresetConfig, cloneHudConfig, VALID_HUD_PRESETS } from '../core/hud-config.ts';
import type { HudConfig } from '../types.ts';
import {
  buildConfigurePreviewLines,
  CONFIGURE_PRESET_DESCRIPTIONS,
  getConfigureTier2Items,
  renderConfigureTuiFrame,
  type ConfigureTier2Item,
  type ConfigureTuiFrameOptions,
  type ConfigureTuiKeyEffect,
  type ConfigureTuiRenderedFrame,
  type ConfigureTuiState,
  type ConfigureTuiTier,
} from './configure-tui-render.ts';
import { type ConfigureHudOptions, loadInteractiveDraftConfig, writeHudConfigAtomic } from './configure.ts';
import {
  ESC_SEQUENCE_TIMEOUT_MS,
  isPopupInteractiveTty,
  type PopupInputStream,
  type PopupOutputStream,
} from './snapshot-popup.ts';
import { shouldUseSnapshotColor } from './snapshot-render.ts';

export {
  buildConfigurePreviewLines,
  CONFIGURE_PRESET_DESCRIPTIONS,
  getConfigureTier2Items,
  renderConfigureTuiFrame,
  type ConfigureTier2Item,
  type ConfigureTuiFrameOptions,
  type ConfigureTuiKeyEffect,
  type ConfigureTuiRenderedFrame,
  type ConfigureTuiState,
  type ConfigureTuiTier,
};

export const CONFIGURE_NON_TTY_HINT: string =
  'Interactive configure (-i/--interactive) requires an interactive TTY (stdin and stdout).\n' +
  'Use non-interactive flags instead:\n' +
  '  agy-hud configure <preset> [--enable <id,...>] [--disable <id,...>] [--order <lineId,...>] [--set <key>=<value>]\n' +
  `Presets: ${VALID_HUD_PRESETS.join(' | ')}\n`;

export interface ConfigureErrorStream {
  write(chunk: string): boolean;
}

export interface RunConfigureInteractiveOptions {
  readonly cliHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly json?: boolean;
  readonly color?: boolean;
  readonly configureOptions?: ConfigureHudOptions;
  readonly stdin?: PopupInputStream;
  readonly stdout?: PopupOutputStream;
  readonly stderr?: ConfigureErrorStream;
  readonly escTimeoutMs?: number;
}

const ESC_CHAR = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);
const ALT_SCREEN_ENTER = `${ESC_CHAR}[?1049h`;
const ALT_SCREEN_EXIT = `${ESC_CHAR}[?1049l`;
const CURSOR_HIDE = `${ESC_CHAR}[?25l`;
const CURSOR_SHOW = `${ESC_CHAR}[?25h`;
const DEFAULT_INTERACTIVE_COLS = 104;
const DEFAULT_INTERACTIVE_ROWS = 28;

function isMoveDownKey(seq: string): boolean {
  return seq === 'j' || seq === `${ESC_CHAR}[B` || seq === `${ESC_CHAR}OB`;
}

function isMoveUpKey(seq: string): boolean {
  return seq === 'k' || seq === `${ESC_CHAR}[A` || seq === `${ESC_CHAR}OA`;
}

function isReorderUpKey(seq: string): boolean {
  return seq === '[' || seq === 'K' || seq === `${ESC_CHAR}[1;2A` || seq === `${ESC_CHAR}[1;3A`;
}

function isReorderDownKey(seq: string): boolean {
  return seq === ']' || seq === 'J' || seq === `${ESC_CHAR}[1;2B` || seq === `${ESC_CHAR}[1;3B`;
}

function reorderEnabledLine(state: ConfigureTuiState, item: ConfigureTier2Item, delta: -1 | 1): ConfigureTuiKeyEffect {
  if (item.kind !== 'line' || !item.enabled) return 'noop';
  const targetIdx = item.orderIndex + delta;
  if (targetIdx < 0 || targetIdx >= state.draft.lines.length) return 'noop';
  const currentId = state.draft.lines[item.orderIndex];
  const swapId = state.draft.lines[targetIdx];
  if (currentId === undefined || swapId === undefined) return 'noop';
  state.draft.lines[item.orderIndex] = swapId;
  state.draft.lines[targetIdx] = currentId;
  state.tier2Cursor = targetIdx;
  return 'redraw';
}

export function createConfigureTuiState(initialConfig: HudConfig): ConfigureTuiState {
  const foundIdx = VALID_HUD_PRESETS.indexOf(initialConfig.preset);
  return {
    tier: 'presets',
    presetIndex: foundIdx >= 0 ? foundIdx : 0,
    tier2Cursor: 0,
    tier2ScrollOffset: 0,
    draft: cloneHudConfig(initialConfig),
  };
}

export function applyConfigureTuiKey(state: ConfigureTuiState, seq: string): ConfigureTuiKeyEffect {
  if (seq === 'q' || seq === 'Q' || seq === CTRL_C || seq === ESC_CHAR) {
    return 'cancel';
  }
  if (seq === '\r' || seq === '\n') {
    return 'save';
  }
  if (seq === '\t' || seq === `${ESC_CHAR}[Z`) {
    state.tier = state.tier === 'presets' ? 'modules' : 'presets';
    return 'redraw';
  }
  if (state.tier === 'presets') {
    if (isMoveDownKey(seq)) {
      const nextIdx = Math.min(VALID_HUD_PRESETS.length - 1, state.presetIndex + 1);
      if (nextIdx === state.presetIndex) return 'noop';
      const nextPreset = VALID_HUD_PRESETS[nextIdx];
      if (!nextPreset) return 'noop';
      state.presetIndex = nextIdx;
      state.draft = buildPresetConfig(nextPreset, {
        maxAgentChips: state.draft.maxAgentChips,
        osc8Links: state.draft.osc8Links,
      });
      return 'redraw';
    }
    if (isMoveUpKey(seq)) {
      const nextIdx = Math.max(0, state.presetIndex - 1);
      if (nextIdx === state.presetIndex) return 'noop';
      const nextPreset = VALID_HUD_PRESETS[nextIdx];
      if (!nextPreset) return 'noop';
      state.presetIndex = nextIdx;
      state.draft = buildPresetConfig(nextPreset, {
        maxAgentChips: state.draft.maxAgentChips,
        osc8Links: state.draft.osc8Links,
      });
      return 'redraw';
    }
    return 'noop';
  }

  const items = getConfigureTier2Items(state.draft);
  if (items.length === 0) return 'noop';
  const clampedCursor = Math.max(0, Math.min(state.tier2Cursor, items.length - 1));
  state.tier2Cursor = clampedCursor;

  if (isMoveDownKey(seq)) {
    const nextCursor = Math.min(items.length - 1, clampedCursor + 1);
    if (nextCursor === clampedCursor) return 'noop';
    state.tier2Cursor = nextCursor;
    return 'redraw';
  }
  if (isMoveUpKey(seq)) {
    const nextCursor = Math.max(0, clampedCursor - 1);
    if (nextCursor === clampedCursor) return 'noop';
    state.tier2Cursor = nextCursor;
    return 'redraw';
  }
  if (seq === ' ') {
    const active = items[clampedCursor];
    if (!active) return 'noop';
    if (active.kind === 'line') {
      state.draft.lines = applyHudLineToggle(state.draft.lines, active.id, !active.enabled);
      const updatedItems = getConfigureTier2Items(state.draft);
      const nextIdx = updatedItems.findIndex((item) => item.kind === 'line' && item.id === active.id);
      if (nextIdx >= 0) {
        state.tier2Cursor = nextIdx;
      }
      return 'redraw';
    }
    if (active.kind === 'segment') {
      state.draft.segments[active.id] = !active.enabled;
      return 'redraw';
    }
    state.draft.osc8Links = !state.draft.osc8Links;
    return 'redraw';
  }
  if (isReorderUpKey(seq)) {
    const active = items[clampedCursor];
    return active ? reorderEnabledLine(state, active, -1) : 'noop';
  }
  if (isReorderDownKey(seq)) {
    const active = items[clampedCursor];
    return active ? reorderEnabledLine(state, active, 1) : 'noop';
  }
  return 'noop';
}

export async function runConfigureInteractive(options: RunConfigureInteractiveOptions = {}): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;

  if (!isPopupInteractiveTty(stdin, stdout)) {
    stderr.write(CONFIGURE_NON_TTY_HINT);
    return 1;
  }

  const initialConfig = loadInteractiveDraftConfig({
    ...options.configureOptions,
    cliHome: options.cliHome,
    env,
  });
  const state = createConfigureTuiState(initialConfig);
  const useColor = options.color !== undefined ? options.color : shouldUseSnapshotColor(false, env);
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

  const draw = (): void => {
    const cols = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : DEFAULT_INTERACTIVE_COLS;
    const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : DEFAULT_INTERACTIVE_ROWS;
    const frame = renderConfigureTuiFrame(state, { cols, rows, color: useColor });
    stdout.write(frame.output);
  };

  let decision: 'save' | 'cancel' = 'cancel';
  stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}`);
  try {
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
      rawModeEnabled = true;
    }
    stdin.resume();
    draw();
    stdout.on('resize', draw);

    decision = await new Promise<'save' | 'cancel'>((resolve) => {
      const finish = (outcome: 'save' | 'cancel'): void => {
        clearPendingEsc();
        if (onData !== null) {
          stdin.off('data', onData);
          onData = null;
        }
        resolve(outcome);
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
            finish('cancel');
          }, escTimeoutMs);
          return;
        }

        const effect = applyConfigureTuiKey(state, seq);
        if (effect === 'save') {
          finish('save');
          return;
        }
        if (effect === 'cancel') {
          finish('cancel');
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

  if (decision === 'cancel') {
    return 0;
  }

  const saved = writeHudConfigAtomic(state.draft, { cliHome: options.cliHome, env });
  if (options.json) {
    stdout.write(`${JSON.stringify(saved.config, null, 2)}\n`);
  } else {
    stdout.write(`Updated ${saved.configPath}\n`);
  }
  return 0;
}
