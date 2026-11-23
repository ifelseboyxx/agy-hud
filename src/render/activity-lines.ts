import type { TodoSummary, TranscriptToolEntry } from '../types.ts';
import { CYAN, GRAY, GREEN, RESET, YELLOW } from './ansi.ts';

const MAX_TOOL_SUMMARY = 4;
const MAX_RUNNING_TOOLS = 2;
const MAX_VISIBLE_NAMES = 4;
const MAX_TODO_LEN = 48;

export function formatToolsLine(tools: readonly TranscriptToolEntry[], hasSkills: boolean): string {
  const filtered = tools.filter((t) => !(hasSkills && t.isSkillRead));
  if (filtered.length === 0) {
    return '';
  }

  const parts: string[] = [];
  const runningTools = filtered.filter((t) => t.running).slice(-MAX_RUNNING_TOOLS);
  for (const t of runningTools) {
    const disp = t.disp.length > 0 ? t.disp : t.name;
    const tgt = t.target.length > 0 ? `${GRAY}: ${t.target}${RESET}` : '';
    parts.push(`${YELLOW}◐${RESET} ${CYAN}${disp}${RESET}${tgt}`);
  }

  const counts = new Map<string, number>();
  for (const t of filtered) {
    if (!t.running) {
      const disp = t.disp.length > 0 ? t.disp : t.name;
      counts.set(disp, (counts.get(disp) ?? 0) + 1);
    }
  }

  const ordered = [...counts.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])));
  for (const [name, cnt] of ordered.slice(0, MAX_TOOL_SUMMARY)) {
    parts.push(`${GREEN}✓${RESET} ${name} ${GRAY}×${cnt}${RESET}`);
  }
  if (ordered.length > MAX_TOOL_SUMMARY) {
    parts.push(`${GRAY}+${ordered.length - MAX_TOOL_SUMMARY} more${RESET}`);
  }

  return parts.length > 0 ? `  ${parts.join(` ${GRAY}|${RESET} `)}` : '';
}

export function formatNamesLine(
  title: string,
  names: readonly string[],
  maxVisible: number = MAX_VISIBLE_NAMES,
): string {
  if (names.length === 0) {
    return '';
  }
  const shown = names.slice(0, maxVisible).map((n) => `${CYAN}${n}${RESET}`);
  if (names.length > maxVisible) {
    shown.push(`${GRAY}+${names.length - maxVisible} more${RESET}`);
  }
  return `  ${GREEN}✓${RESET} ${title} ${GRAY}(${names.length}):${RESET} ${shown.join(', ')}`;
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
