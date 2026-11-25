import { aggregateCompletedTools } from '../collectors/activity-parse.ts';
import type { CompletedToolAggregate, TodoSummary, TranscriptToolEntry } from '../types.ts';
import { CYAN, DEFAULT_TERM_WIDTH, GRAY, GREEN, RESET, truncateToWidth, visibleLen, YELLOW } from './ansi.ts';
import {
  type ActivityLineFormatOptions,
  formatDefaultOverflow,
  packActivityLine,
  type PackableLineItem,
  resolveLineBudget,
} from './pack-line.ts';

export type { ActivityLineFormatOptions, PackableLineItem } from './pack-line.ts';

const MAX_TOOL_SUMMARY = 8;
const MAX_RUNNING_TOOLS = 2;
const MAX_VISIBLE_NAMES = 8;
const MAX_TODO_LEN = 48;
const HUD_TOOLS_PREFIX_COLS = 2;
const HUD_TOOLS_SEP_COLS = 3;

export interface HudToolRunningSpec {
  readonly name?: string;
  readonly disp: string;
  readonly target: string;
}

export interface HudToolCompletedSpec {
  readonly disp: string;
  readonly count: number;
}

interface ToolsLineLayout {
  readonly allFit: boolean;
  readonly shownRunning: number;
  readonly shownCompleted: number;
}

export function makeRunningToolItem(entry: TranscriptToolEntry): PackableLineItem {
  const disp = entry.disp.length > 0 ? entry.disp : entry.name;
  const tgt = entry.target.length > 0 ? `${GRAY}: ${entry.target}${RESET}` : '';
  const full = `${YELLOW}◐${RESET} ${CYAN}${disp}${RESET}${tgt}`;
  return {
    render: () => full,
    renderEllipsized: (maxCols: number) => {
      if (visibleLen(full) <= maxCols) {
        return full;
      }
      if (maxCols <= 2) {
        return truncateToWidth(`◐ ${disp}`, maxCols);
      }
      const labelAvail = maxCols - 2;
      if (entry.target.length > 0) {
        const dispCols = visibleLen(disp);
        if (dispCols + 3 <= labelAvail) {
          return `${YELLOW}◐${RESET} ${CYAN}${disp}${RESET}${GRAY}: ${truncateToWidth(entry.target, labelAvail - dispCols - 2)}${RESET}`;
        }
        return `${YELLOW}◐${RESET} ${CYAN}${truncateToWidth(`${disp}: ${entry.target}`, labelAvail)}${RESET}`;
      }
      return `${YELLOW}◐${RESET} ${CYAN}${truncateToWidth(disp, labelAvail)}${RESET}`;
    },
  };
}

function makeCompletedToolItem(agg: CompletedToolAggregate): PackableLineItem {
  const countStr = `×${agg.count}`;
  const full = `${GREEN}✓${RESET} ${agg.disp} ${GRAY}${countStr}${RESET}`;
  return {
    render: () => full,
    renderEllipsized: (maxCols: number) => {
      if (visibleLen(full) <= maxCols) {
        return full;
      }
      if (maxCols <= 2) {
        return truncateToWidth(`✓ ${agg.disp}`, maxCols);
      }
      const nameAvail = maxCols - 2 - (1 + countStr.length);
      if (nameAvail >= 2) {
        return `${GREEN}✓${RESET} ${truncateToWidth(agg.disp, nameAvail)} ${GRAY}${countStr}${RESET}`;
      }
      return `${GREEN}✓${RESET} ${truncateToWidth(`${agg.disp} ${countStr}`, maxCols - 2)}`;
    },
  };
}

function computeToolsLineLayout(
  runningWidths: readonly number[],
  totalRunning: number,
  completedWidths: readonly number[],
  totalCompleted: number,
  budget: number,
  formatOverflow: (hiddenCount: number) => string,
): ToolsLineLayout {
  const totalSlots = totalRunning + totalCompleted;
  if (totalRunning <= MAX_RUNNING_TOOLS && totalCompleted <= MAX_TOOL_SUMMARY) {
    const allWidths = [...runningWidths, ...completedWidths];
    let fullCols = HUD_TOOLS_PREFIX_COLS;
    for (let i = 0; i < allWidths.length; i += 1) {
      fullCols += (i > 0 ? HUD_TOOLS_SEP_COLS : 0) + (allWidths[i] ?? 0);
    }
    if (fullCols <= budget) {
      return { allFit: true, shownRunning: runningWidths.length, shownCompleted: completedWidths.length };
    }
  }

  let shownRunning = 0;
  let curCols = HUD_TOOLS_PREFIX_COLS;
  if (runningWidths.length > 0) {
    shownRunning = 1;
    if (runningWidths.length === 2 && totalSlots > 2) {
      const twoCols =
        HUD_TOOLS_PREFIX_COLS +
        (runningWidths[0] ?? 0) +
        HUD_TOOLS_SEP_COLS +
        (runningWidths[1] ?? 0) +
        HUD_TOOLS_SEP_COLS +
        visibleLen(formatOverflow(totalSlots - 2));
      if (twoCols <= budget) {
        shownRunning = 2;
      }
    }
    curCols =
      HUD_TOOLS_PREFIX_COLS +
      (runningWidths[0] ?? 0) +
      (shownRunning === 2 ? HUD_TOOLS_SEP_COLS + (runningWidths[1] ?? 0) : 0);
  }

  let shownCompleted = 0;
  if (shownRunning === runningWidths.length) {
    for (let k = 1; k <= completedWidths.length; k += 1) {
      const hidden = totalSlots - shownRunning - k;
      if (runningWidths.length > 0 && hidden <= 0) {
        break;
      }
      const width = completedWidths[k - 1] ?? 0;
      const itemCols = shownRunning === 0 && k === 1 ? width : HUD_TOOLS_SEP_COLS + width;
      curCols += itemCols;
      const overflowCols = hidden > 0 ? HUD_TOOLS_SEP_COLS + visibleLen(formatOverflow(hidden)) : 0;
      if (curCols + overflowCols <= budget) {
        shownCompleted = k;
      } else {
        break;
      }
    }
  }
  if (runningWidths.length === 0 && completedWidths.length > 0 && shownCompleted === 0) {
    shownCompleted = 1;
  }
  return { allFit: false, shownRunning, shownCompleted };
}

export interface HudVisibleToolsCap {
  readonly shownRunning: number;
  readonly shownCompleted: number;
}

export function computeHudVisibleToolsCap(
  runningTools: readonly HudToolRunningSpec[],
  completedTools: readonly HudToolCompletedSpec[],
  maxCols: number,
  formatOverflow: (hiddenCount: number) => string = formatDefaultOverflow,
): HudVisibleToolsCap {
  if (runningTools.length === 0 && completedTools.length === 0) {
    return { shownRunning: 0, shownCompleted: 0 };
  }
  const runningWidths = runningTools
    .slice(-MAX_RUNNING_TOOLS)
    .reverse()
    .map((rt) => {
      const disp = rt.disp.length > 0 ? rt.disp : (rt.name ?? '');
      return visibleLen(rt.target.length > 0 ? `◐ ${disp}: ${rt.target}` : `◐ ${disp}`);
    });
  const completedWidths = completedTools
    .slice(0, MAX_TOOL_SUMMARY)
    .map((ct) => visibleLen(`✓ ${ct.disp} ×${ct.count}`));
  const layout = computeToolsLineLayout(
    runningWidths,
    runningTools.length,
    completedWidths,
    completedTools.length,
    maxCols,
    formatOverflow,
  );
  return { shownRunning: layout.shownRunning, shownCompleted: layout.shownCompleted };
}

export function computeHudVisibleCompletedCap(
  runningTools: readonly HudToolRunningSpec[],
  completedTools: readonly HudToolCompletedSpec[],
  maxCols: number,
  formatOverflow: (hiddenCount: number) => string = formatDefaultOverflow,
): number {
  return computeHudVisibleToolsCap(runningTools, completedTools, maxCols, formatOverflow).shownCompleted;
}

export function formatToolsLine(
  tools: readonly TranscriptToolEntry[],
  hasSkills: boolean,
  termWidth: number = DEFAULT_TERM_WIDTH,
  options?: ActivityLineFormatOptions,
): string {
  const filtered = tools.filter((t) => !(hasSkills && t.isSkillRead));
  if (filtered.length === 0) {
    return '';
  }

  const prefix = '  ';
  const separator = ` ${GRAY}|${RESET} `;
  const allRunning = filtered.filter((t) => t.running);
  const completed = aggregateCompletedTools(filtered, false);

  if (allRunning.length === 0) {
    return packActivityLine({
      prefix,
      separator,
      items: completed.map(makeCompletedToolItem),
      maxItems: MAX_TOOL_SUMMARY,
      termWidth,
      formatOverflow: options?.formatOverflow,
    });
  }

  const budget = resolveLineBudget(termWidth);
  const formatOverflow = options?.formatOverflow ?? formatDefaultOverflow;
  const totalRunning = allRunning.length;
  const totalCompleted = completed.length;
  const totalSlots = totalRunning + totalCompleted;

  const runningCandidates = allRunning.slice(-MAX_RUNNING_TOOLS).reverse().map(makeRunningToolItem);
  const completedCandidates = completed.slice(0, MAX_TOOL_SUMMARY).map(makeCompletedToolItem);
  const runningRendered = runningCandidates.map((item) => item.render());
  const runningWidths = runningRendered.map(visibleLen);
  const completedRendered = completedCandidates.map((item) => item.render());
  const completedWidths = completedRendered.map(visibleLen);

  const layout = computeToolsLineLayout(
    runningWidths,
    totalRunning,
    completedWidths,
    totalCompleted,
    budget,
    formatOverflow,
  );
  if (layout.allFit) {
    return `${prefix}${[...runningRendered, ...completedRendered].join(separator)}`;
  }
  if (totalSlots === 1) {
    const only = runningCandidates[0];
    return only ? `${prefix}${only.renderEllipsized(Math.max(1, budget - HUD_TOOLS_PREFIX_COLS))}` : '';
  }

  if (layout.shownRunning === 1) {
    const overflowIfOne = formatOverflow(totalSlots - 1);
    const oneCols = HUD_TOOLS_PREFIX_COLS + (runningWidths[0] ?? 0) + HUD_TOOLS_SEP_COLS + visibleLen(overflowIfOne);
    if (oneCols > budget) {
      const firstRunning = runningCandidates[0];
      if (!firstRunning) {
        return '';
      }
      const avail = Math.max(1, budget - HUD_TOOLS_PREFIX_COLS - HUD_TOOLS_SEP_COLS - visibleLen(overflowIfOne));
      return `${prefix}${firstRunning.renderEllipsized(avail)}${separator}${overflowIfOne}`;
    }
  }

  const hidden = totalSlots - layout.shownRunning - layout.shownCompleted;
  const parts = [
    ...runningRendered.slice(0, layout.shownRunning),
    ...completedRendered.slice(0, layout.shownCompleted),
    formatOverflow(hidden),
  ];
  return `${prefix}${parts.join(separator)}`;
}

export function formatNamesLine(
  title: string,
  names: readonly string[],
  maxVisible: number = MAX_VISIBLE_NAMES,
  termWidth: number = DEFAULT_TERM_WIDTH,
  options?: ActivityLineFormatOptions,
): string {
  if (names.length === 0 || maxVisible <= 0) {
    return '';
  }
  const items: PackableLineItem[] = names.map((name) => ({
    render: () => `${CYAN}${name}${RESET}`,
    renderEllipsized: (maxCols) => `${CYAN}${truncateToWidth(name, maxCols)}${RESET}`,
  }));
  return packActivityLine({
    prefix: `  ${GREEN}✓${RESET} ${title} ${GRAY}(${names.length}):${RESET} `,
    separator: ', ',
    items,
    maxItems: maxVisible,
    termWidth,
    formatOverflow: options?.formatOverflow,
  });
}

export function formatTodosLine(todoInfo: TodoSummary | null | undefined): string {
  if (!todoInfo) {
    return '';
  }
  const bgSuffix =
    typeof todoInfo.taskCount === 'number' && todoInfo.taskCount > 0
      ? ` ${GRAY}│${RESET} ${CYAN}BG ${todoInfo.taskCount}${RESET}`
      : '';

  if (typeof todoInfo.total === 'number') {
    const total = todoInfo.total;
    const done = todoInfo.completed ?? 0;
    const prog = `${GRAY}(${done}/${total})${RESET}`;
    if (typeof todoInfo.current === 'string' && todoInfo.current.length > 0) {
      const text =
        todoInfo.current.length > MAX_TODO_LEN ? `${todoInfo.current.slice(0, MAX_TODO_LEN)}…` : todoInfo.current;
      return `  ${YELLOW}▸${RESET} ${text} ${prog}${bgSuffix}`;
    }
    if (done === total) {
      return `  ${GREEN}✓${RESET} All todos complete ${prog}${bgSuffix}`;
    }
    return `  ${YELLOW}▸${RESET} Tasks ${prog}${bgSuffix}`;
  }

  if (typeof todoInfo.taskCount === 'number' && todoInfo.taskCount > 0) {
    return `  ${YELLOW}▸${RESET} Background tasks ${GRAY}(${todoInfo.taskCount})${RESET}`;
  }
  return '';
}
