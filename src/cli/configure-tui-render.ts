import os from 'node:os';
import path from 'node:path';

import { HUD_LINE_IDS, HUD_SEGMENT_IDS, VALID_HUD_PRESETS } from '../core/hud-config.ts';
import {
  BOLD,
  BRIGHT_CYAN,
  BRIGHT_WHITE,
  GRAY,
  GREEN,
  padEndVisible,
  RESET,
  stripAnsi,
  truncateToWidth,
  visibleLen,
  YELLOW,
} from '../render/ansi.ts';
import { renderHudLines } from '../render/lines.ts';
import type {
  AgentsSummary,
  HudConfig,
  HudLineId,
  HudPreset,
  HudSegmentId,
  SessionTelemetry,
  StatusLineData,
  TodoSummary,
  TranscriptActivity,
} from '../types.ts';

const ESC_CHAR = String.fromCharCode(0x1b);
const CLEAR_HOME = `${ESC_CHAR}[H${ESC_CHAR}[2J`;
const BAR_BG = `${ESC_CHAR}[48;5;236m${ESC_CHAR}[97m`;
const ACTIVE_ROW_BG = `${ESC_CHAR}[48;5;237m`;
const DEFAULT_TUI_COLS = 104;
const MIN_TUI_COLS = 56;
const DEFAULT_TUI_ROWS = 28;
const MIN_TUI_ROWS = 12;
const PREVIEW_NOW_SEC = 1_780_000_000;
const PREVIEW_UNUSED_CLI_HOME = path.join(os.tmpdir(), 'agy-hud-configure-preview-unused');

export type ConfigureTuiTier = 'presets' | 'modules';

export type ConfigureTuiKeyEffect = 'redraw' | 'noop' | 'save' | 'cancel';

export type ConfigureTier2Item =
  | { readonly kind: 'line'; readonly id: HudLineId; readonly enabled: boolean; readonly orderIndex: number }
  | { readonly kind: 'segment'; readonly id: HudSegmentId; readonly enabled: boolean }
  | { readonly kind: 'option'; readonly id: 'osc8Links'; readonly enabled: boolean };

export interface ConfigureTuiState {
  tier: ConfigureTuiTier;
  presetIndex: number;
  tier2Cursor: number;
  tier2ScrollOffset: number;
  draft: HudConfig;
}

export interface ConfigureTuiFrameOptions {
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
}

export interface ConfigureTuiRenderedFrame {
  readonly output: string;
  readonly previewLines: readonly string[];
}

export const CONFIGURE_PRESET_DESCRIPTIONS: Readonly<Record<HudPreset, string>> = {
  zen: '1-row focus bar for narrow terminals & split panes',
  minimal: '2-row visual bars (identity + usage) without extra noise',
  compact: '3-4 row daily coding default with collapsed Activity Summary',
  swarm: '4-5 row multi-agent orchestration with Agents & Todos',
  full: 'Up to 8-row full diagnostics for tools, skills, MCPs & agents',
};

const LINE_DESCRIPTIONS: Readonly<Record<HudLineId, string>> = {
  mode: 'Permission / plan mode banner',
  identity: 'Model, workspace git, duration, badges, cost, perf',
  usage: 'Context progress bar & primary/secondary quota',
  activity: 'Collapsed single-line Activity Summary',
  tools: 'Live running & completed tool calls',
  skills: 'Active session skills',
  mcps: 'MCP server call counts',
  agents: 'Live subagent / swarm chips',
  todos: 'Current task checklist progress',
};

const SEGMENT_DESCRIPTIONS: Readonly<Record<HudSegmentId, string>> = {
  model: 'identity: model name & effort badge',
  git: 'identity: workspace folder & git branch',
  duration: 'identity: session elapsed time',
  badges: 'identity: inline Agents/Swarm & runtime flags',
  cost: 'identity: cumulative session USD cost',
  perf: 'identity: TPS, TTFT, and cache hit capsule',
  context: 'usage/zen: context bar or compact Ctx%',
  quota: 'usage/zen: primary/secondary quota windows',
};

function createPreviewFixture(termWidth: number): {
  data: StatusLineData;
  telemetry: SessionTelemetry;
  activity: TranscriptActivity;
  agentsSummary: AgentsSummary;
  todos: TodoSummary;
} {
  const reset5hIso = new Date((PREVIEW_NOW_SEC + 8_100) * 1000).toISOString();
  const reset7dIso = new Date((PREVIEW_NOW_SEC + 345_600) * 1000).toISOString();

  const data: StatusLineData = {
    model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', effort: 'high' },
    workspace: { current_dir: '/workspace/agy-hud', project_dir: '/workspace/agy-hud' },
    context_window: { used_percentage: 38, context_window_size: 200_000 },
    cost: { total_usd: 0.42 },
    quota: {
      'gemini-5h': { remaining_fraction: 0.82, reset_time: reset5hIso },
      'gemini-weekly': { remaining_fraction: 0.91, reset_time: reset7dIso },
    },
    terminal_width: termWidth,
  };

  const telemetry: SessionTelemetry = {
    genCount: 12,
    tps: 94.2,
    ttft: 1.4,
    cachePct: 87,
    ctxUsed: 76_000,
    ctxMax: 200_000,
  };

  const activity: TranscriptActivity = {
    tools: [
      {
        name: 'read_file',
        disp: 'read_file',
        target: 'configure-tui.ts',
        fullTarget: 'src/cli/configure-tui.ts',
        running: true,
        isSkillRead: false,
      },
      { name: 'run_checks', disp: 'run_checks', target: 'test', running: false, isSkillRead: false },
      { name: 'run_checks', disp: 'run_checks', target: 'lint', running: false, isSkillRead: false },
      { name: 'edit_file', disp: 'edit_file', target: 'cli-entry.ts', running: false, isSkillRead: false },
      { name: 'batch_search', disp: 'batch_search', target: 'src/cli', running: false, isSkillRead: false },
    ],
    skills: ['tdd', 'codebase-design'],
    mcps: ['agy-fast (6)', 'chrome-devtools (2)'],
    agents: [],
  };

  const agentsSummary: AgentsSummary = {
    kind: 'swarm',
    working: 2,
    waiting: 0,
    alive: 2,
    total: 3,
    entries: [
      { name: 'Reviewer', type: 'review', model: 'Gemini 4 Flash', state: 'working', ts: PREVIEW_NOW_SEC - 15 },
      { name: 'Tester', type: 'test', model: 'Gemini 4 Flash', state: 'working', ts: PREVIEW_NOW_SEC - 8 },
      { name: 'Planner', type: 'plan', model: 'Gemini 4 Carbon', state: 'done', ts: PREVIEW_NOW_SEC - 25 },
    ],
  };

  const todos: TodoSummary = {
    total: 5,
    completed: 3,
    current: 'Wire configure -i TUI',
  };

  return { data, telemetry, activity, agentsSummary, todos };
}

export function getConfigureTier2Items(config: HudConfig): readonly ConfigureTier2Item[] {
  const items: ConfigureTier2Item[] = [];
  const enabledLines = new Set<HudLineId>(config.lines);
  for (let i = 0; i < config.lines.length; i += 1) {
    const lineId = config.lines[i];
    if (lineId !== undefined) {
      items.push({ kind: 'line', id: lineId, enabled: true, orderIndex: i });
    }
  }
  for (const lineId of HUD_LINE_IDS) {
    if (!enabledLines.has(lineId)) {
      items.push({ kind: 'line', id: lineId, enabled: false, orderIndex: -1 });
    }
  }
  for (const segId of HUD_SEGMENT_IDS) {
    items.push({ kind: 'segment', id: segId, enabled: config.segments[segId] });
  }
  items.push({ kind: 'option', id: 'osc8Links', enabled: config.osc8Links });
  return items;
}

export function buildConfigurePreviewLines(config: HudConfig, termWidth: number, color: boolean): string[] {
  const width = Math.max(MIN_TUI_COLS, Math.floor(termWidth));
  const fixture = createPreviewFixture(width);
  const lines = renderHudLines(PREVIEW_UNUSED_CLI_HOME, fixture.data, {
    cliSettings: {},
    hudConfig: config,
    telemetry: fixture.telemetry,
    activity: fixture.activity,
    agentsSummary: fixture.agentsSummary,
    todos: fixture.todos,
    nowSec: PREVIEW_NOW_SEC,
    agyPid: null,
    bypass: false,
    cliMode: 'plan',
    branch: 'main',
    dirty: true,
    elapsedSeconds: 754,
  });
  return color ? lines : lines.map((line) => stripAnsi(line));
}

function formatConfigureRule(title: string, width: number, color: boolean): string {
  const safeTitle = truncateToWidth(title, Math.max(4, width - 6));
  const prefix = `── ${safeTitle} `;
  const fillCount = Math.max(2, width - visibleLen(prefix));
  const plain = `${prefix}${'─'.repeat(fillCount)}`;
  const fitted = truncateToWidth(plain, width);
  return color ? `${GRAY}${fitted}${RESET}` : fitted;
}

function formatHeaderLine(state: ConfigureTuiState, width: number, color: boolean): string {
  const tier1Label = state.tier === 'presets' ? '[1] Presets' : ' 1  Presets';
  const tier2Label = state.tier === 'modules' ? '[2] Modules & Order' : ' 2  Modules & Order';
  if (!color) {
    return truncateToWidth(`agy-hud configure  |  ${tier1Label}   ${tier2Label}   (Tab to switch)`, width);
  }
  const t1 = state.tier === 'presets' ? `${BRIGHT_CYAN}${BOLD}${tier1Label}${RESET}` : `${GRAY}${tier1Label}${RESET}`;
  const t2 = state.tier === 'modules' ? `${BRIGHT_CYAN}${BOLD}${tier2Label}${RESET}` : `${GRAY}${tier2Label}${RESET}`;
  return truncateToWidth(`${BOLD}${BRIGHT_WHITE}agy-hud configure${RESET}  ${GRAY}│${RESET}  ${t1}   ${t2}`, width);
}

function renderTier1Rows(state: ConfigureTuiState, width: number, color: boolean): string[] {
  const rows: string[] = [formatConfigureRule('Persona Presets', width, color)];
  for (let i = 0; i < VALID_HUD_PRESETS.length; i += 1) {
    const preset = VALID_HUD_PRESETS[i];
    if (!preset) continue;
    const active = i === state.presetIndex;
    const pointer = active ? '▸' : ' ';
    const desc = CONFIGURE_PRESET_DESCRIPTIONS[preset];
    const linePlain = ` ${pointer} ${preset.padEnd(8)}  ${desc}`;
    const fitted = padEndVisible(truncateToWidth(linePlain, width), width);
    if (!color) {
      rows.push(fitted);
    } else if (active) {
      rows.push(`${ACTIVE_ROW_BG}${BRIGHT_CYAN}${BOLD}${fitted}${RESET}`);
    } else {
      rows.push(`   ${BRIGHT_WHITE}${preset.padEnd(8)}${RESET}  ${GRAY}${truncateToWidth(desc, width - 14)}${RESET}`);
    }
  }
  return rows;
}

function formatTier2ItemRow(item: ConfigureTier2Item, active: boolean, width: number, color: boolean): string {
  const pointer = active ? '▸' : ' ';
  const check = item.enabled ? '[x]' : '[ ]';
  let label = '';
  let desc = '';
  if (item.kind === 'line') {
    const orderTag = item.enabled ? `#${String(item.orderIndex + 1).padEnd(2)}` : '   ';
    label = `${orderTag} ${item.id.padEnd(10)}`;
    desc = LINE_DESCRIPTIONS[item.id];
  } else if (item.kind === 'segment') {
    label = `    ${item.id.padEnd(10)}`;
    desc = SEGMENT_DESCRIPTIONS[item.id];
  } else {
    label = `    ${item.id.padEnd(10)}`;
    desc = 'Clickable OSC 8 overflow & snapshot hyperlinks';
  }
  const plain = ` ${pointer} ${check} ${label} ${desc}`;
  const fitted = padEndVisible(truncateToWidth(plain, width), width);
  if (!color) {
    return fitted;
  }
  if (active) {
    return `${ACTIVE_ROW_BG}${BRIGHT_CYAN}${BOLD}${fitted}${RESET}`;
  }
  const checkStyled = item.enabled ? `${GREEN}${check}${RESET}` : `${GRAY}${check}${RESET}`;
  const labelStyled = item.enabled ? `${BRIGHT_WHITE}${label}${RESET}` : `${GRAY}${label}${RESET}`;
  const maxDesc = Math.max(8, width - 24);
  return `   ${checkStyled} ${labelStyled} ${GRAY}${truncateToWidth(desc, maxDesc)}${RESET}`;
}

function renderTier2Rows(state: ConfigureTuiState, width: number, maxRows: number, color: boolean): string[] {
  const items = getConfigureTier2Items(state.draft);
  const clampedCursor = Math.max(0, Math.min(state.tier2Cursor, Math.max(0, items.length - 1)));
  state.tier2Cursor = clampedCursor;

  interface DisplayRow {
    readonly itemIndex: number;
    readonly text: string;
  }

  const allRows: DisplayRow[] = [];
  let addedSegmentHeader = false;
  let addedOptionHeader = false;
  allRows.push({ itemIndex: -1, text: formatConfigureRule('Line Modules (ordered top-to-bottom)', width, color) });

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === 'segment' && !addedSegmentHeader) {
      addedSegmentHeader = true;
      allRows.push({ itemIndex: -1, text: formatConfigureRule('Inline Segments', width, color) });
    } else if (item.kind === 'option' && !addedOptionHeader) {
      addedOptionHeader = true;
      allRows.push({ itemIndex: -1, text: formatConfigureRule('Hyperlinks', width, color) });
    }
    allRows.push({ itemIndex: i, text: formatTier2ItemRow(item, i === clampedCursor, width, color) });
  }

  const windowHeight = Math.max(3, maxRows);
  const activeDisplayIdx = Math.max(
    0,
    allRows.findIndex((row) => row.itemIndex === clampedCursor),
  );
  let start = Math.max(0, Math.min(state.tier2ScrollOffset, Math.max(0, allRows.length - windowHeight)));
  if (activeDisplayIdx < start) {
    start = Math.max(0, activeDisplayIdx - 1);
  } else if (activeDisplayIdx >= start + windowHeight) {
    start = activeDisplayIdx - windowHeight + 1;
  }
  state.tier2ScrollOffset = start;

  return allRows.slice(start, start + windowHeight).map((row) => row.text);
}

export function renderConfigureTuiFrame(
  state: ConfigureTuiState,
  options: ConfigureTuiFrameOptions,
): ConfigureTuiRenderedFrame {
  const cols =
    Number.isFinite(options.cols) && options.cols >= MIN_TUI_COLS ? Math.floor(options.cols) : DEFAULT_TUI_COLS;
  const rows =
    Number.isFinite(options.rows) && options.rows >= MIN_TUI_ROWS ? Math.floor(options.rows) : DEFAULT_TUI_ROWS;
  const width = Math.max(MIN_TUI_COLS, cols - 1);

  const rawPreview = buildConfigurePreviewLines(state.draft, width, options.color);
  const previewRows =
    rawPreview.length > 0
      ? rawPreview.map((line) => truncateToWidth(line, width))
      : [
          options.color
            ? `${YELLOW} (all status line modules disabled)${RESET}`
            : ' (all status line modules disabled)',
        ];

  const previewTitle = `Live Preview (${state.draft.preset} · ${state.draft.lines.length} lines · OSC8 ${state.draft.osc8Links ? 'on' : 'off'})`;
  const maxPreviewDisplay = Math.max(1, Math.min(previewRows.length, Math.max(2, Math.floor(rows / 3))));
  const previewBlock = [
    formatConfigureRule(previewTitle, width, options.color),
    ...previewRows.slice(0, maxPreviewDisplay),
  ];

  const headerLines = [formatHeaderLine(state, width, options.color), ''];
  const footerPlain =
    state.tier === 'presets'
      ? ' [Up/Down] Preset | [Tab] Modules & Order | [Enter] Save | [q/Esc] Cancel '
      : ' [Up/Down] Move | [Space] Toggle | [[/] / Shift+Up/Down] Reorder | [Tab] Presets | [Enter] Save | [q/Esc] Cancel ';
  const footerFitted = padEndVisible(truncateToWidth(footerPlain, width), width);
  const footerLine = options.color ? `${BAR_BG}${footerFitted}${RESET}` : footerFitted;

  const reservedRows = headerLines.length + 1 + previewBlock.length + 1;
  const bodyBudget = Math.max(3, rows - reservedRows);
  const bodyLines =
    state.tier === 'presets'
      ? renderTier1Rows(state, width, options.color).slice(0, bodyBudget)
      : renderTier2Rows(state, width, bodyBudget, options.color);

  const combined = [...headerLines, ...bodyLines, '', ...previewBlock];
  const maxContentRows = Math.max(1, rows - 1);
  const clipped = combined.slice(0, maxContentRows);
  const fillerCount = Math.max(0, maxContentRows - clipped.length);
  const output = `${CLEAR_HOME}${clipped.join('\n')}${'\n'.repeat(fillerCount + 1)}${footerLine}`;
  return { output, previewLines: rawPreview };
}
