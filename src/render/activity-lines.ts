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

export type { ActivityLineFormatOptions } from './pack-line.ts';

const MAX_TOOL_SUMMARY = 8;
const MAX_RUNNING_TOOLS = 2;
const MAX_VISIBLE_NAMES = 8;
const MAX_TODO_LEN = 48;

function makeRunningToolItem(entry: TranscriptToolEntry): PackableLineItem {
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
  const prefixCols = visibleLen(prefix);
  const sepCols = visibleLen(separator);
  const totalRunning = allRunning.length;
  const totalCompleted = completed.length;
  const totalSlots = totalRunning + totalCompleted;

  const runningCandidates = allRunning.slice(-MAX_RUNNING_TOOLS).reverse().map(makeRunningToolItem);
  const completedCandidates = completed.slice(0, MAX_TOOL_SUMMARY).map(makeCompletedToolItem);
  const runningRendered = runningCandidates.map((item) => item.render());
  const runningWidths = runningRendered.map(visibleLen);
  const completedRendered = completedCandidates.map((item) => item.render());
  const completedWidths = completedRendered.map(visibleLen);

  if (totalRunning <= MAX_RUNNING_TOOLS && totalCompleted <= MAX_TOOL_SUMMARY) {
    const allRendered = [...runningRendered, ...completedRendered];
    const allWidths = [...runningWidths, ...completedWidths];
    let fullCols = prefixCols;
    for (let i = 0; i < allWidths.length; i += 1) {
      fullCols += (i > 0 ? sepCols : 0) + (allWidths[i] ?? 0);
    }
    if (fullCols <= budget) {
      return `${prefix}${allRendered.join(separator)}`;
    }
    if (totalSlots === 1) {
      const only = runningCandidates[0];
      return only ? `${prefix}${only.renderEllipsized(Math.max(1, budget - prefixCols))}` : '';
    }
  }

  let shownRunning = 1;
  if (runningCandidates.length === 2) {
    const hiddenIfTwo = totalSlots - 2;
    if (hiddenIfTwo > 0) {
      const twoCols =
        prefixCols +
        (runningWidths[0] ?? 0) +
        sepCols +
        (runningWidths[1] ?? 0) +
        sepCols +
        visibleLen(formatOverflow(hiddenIfTwo));
      if (twoCols <= budget) {
        shownRunning = 2;
      }
    }
  }

  if (shownRunning === 1) {
    const overflowIfOne = formatOverflow(totalSlots - 1);
    const oneCols = prefixCols + (runningWidths[0] ?? 0) + sepCols + visibleLen(overflowIfOne);
    if (oneCols > budget) {
      const firstRunning = runningCandidates[0];
      if (!firstRunning) {
        return '';
      }
      const avail = Math.max(1, budget - prefixCols - sepCols - visibleLen(overflowIfOne));
      return `${prefix}${firstRunning.renderEllipsized(avail)}${separator}${overflowIfOne}`;
    }
  }

  let baseCols = prefixCols + (runningWidths[0] ?? 0);
  if (shownRunning === 2) {
    baseCols += sepCols + (runningWidths[1] ?? 0);
  }
  let bestCompleted = 0;
  let curCols = baseCols;
  for (let k = 1; k <= completedCandidates.length; k += 1) {
    const hidden = totalSlots - shownRunning - k;
    if (hidden <= 0) {
      break;
    }
    curCols += sepCols + (completedWidths[k - 1] ?? 0);
    if (curCols + sepCols + visibleLen(formatOverflow(hidden)) <= budget) {
      bestCompleted = k;
    } else {
      break;
    }
  }

  const hidden = totalSlots - shownRunning - bestCompleted;
  const parts = [
    ...runningRendered.slice(0, shownRunning),
    ...completedRendered.slice(0, bestCompleted),
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
