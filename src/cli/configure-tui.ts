import {
  applyHudLineToggle,
  buildPresetConfig,
  cloneHudConfig,
  VALID_COST_CURRENCIES,
  VALID_HUD_PRESETS,
} from '../core/hud-config.ts';
import type { HudConfig } from '../types.ts';
import {
  getConfigureTier2Items,
  renderConfigureTuiFrame,
  type ConfigureTier2Item,
  type ConfigureTuiFrameOptions,
  type ConfigureTuiKeyEffect,
  type ConfigureTuiRenderedFrame,
  type ConfigureTuiState,
  type ConfigureTuiTier,
} from './configure-tui-render.ts';
import {
  type ConfigureHudOptions,
  HudConfigConflictError,
  loadInteractiveDraftSession,
  writeHudConfigAtomic,
} from './configure.ts';
import { shouldUseSnapshotColor } from './snapshot-render.ts';
import {
  CTRL_C,
  ESC_CHAR,
  ESC_SEQUENCE_TIMEOUT_MS,
  isInteractiveTty,
  runAltScreenTtySession,
  type TtyInputStream,
  type TtyOutputStream,
} from './tty-session.ts';

export {
  getConfigureTier2Items,
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
  readonly stdin?: TtyInputStream;
  readonly stdout?: TtyOutputStream;
  readonly stderr?: ConfigureErrorStream;
  readonly escTimeoutMs?: number;
}

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
        costCurrency: state.draft.costCurrency,
        usdToCnyRate: state.draft.usdToCnyRate,
        narrow: state.draft.narrow,
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
        costCurrency: state.draft.costCurrency,
        usdToCnyRate: state.draft.usdToCnyRate,
        narrow: state.draft.narrow,
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
    if (active.kind === 'option') {
      state.draft.osc8Links = !state.draft.osc8Links;
      return 'redraw';
    }
    const idx = VALID_COST_CURRENCIES.indexOf(state.draft.costCurrency);
    state.draft.costCurrency = VALID_COST_CURRENCIES[(idx + 1) % VALID_COST_CURRENCIES.length] ?? 'usd';
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

  if (!isInteractiveTty(stdin, stdout)) {
    stderr.write(CONFIGURE_NON_TTY_HINT);
    return 1;
  }

  const draftSession = loadInteractiveDraftSession({
    ...options.configureOptions,
    cliHome: options.cliHome,
    env,
  });
  const state = createConfigureTuiState(draftSession.config);
  const useColor = options.color !== undefined ? options.color : shouldUseSnapshotColor(false, env);
  const escTimeoutMs = options.escTimeoutMs ?? ESC_SEQUENCE_TIMEOUT_MS;

  const draw = (): void => {
    const cols = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : DEFAULT_INTERACTIVE_COLS;
    const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : DEFAULT_INTERACTIVE_ROWS;
    const frame = renderConfigureTuiFrame(state, { cols, rows, color: useColor });
    stdout.write(frame.output);
  };

  const decision = await runAltScreenTtySession<'save' | 'cancel'>({
    stdin,
    stdout,
    escTimeoutMs,
    render: draw,
    onEscTimeout: (finish) => finish('cancel'),
    onKey: (seq, finish) => {
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
    },
  });

  if (decision === 'cancel') {
    return 0;
  }

  let saved;
  try {
    saved = writeHudConfigAtomic(state.draft, {
      cliHome: options.cliHome,
      env,
      expectedVersion: draftSession.version,
    });
  } catch (err) {
    if (err instanceof HudConfigConflictError) {
      stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  if (options.json) {
    stdout.write(`${JSON.stringify(saved.config, null, 2)}\n`);
  } else {
    stdout.write(`Updated ${saved.configPath}\n`);
  }
  return 0;
}
