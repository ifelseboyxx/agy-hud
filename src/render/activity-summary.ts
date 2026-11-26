import { aggregateCompletedTools } from '../collectors/activity-aggregate.ts';
import { isFiniteNum, selectNewestFirst } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { AgentsSummary, CompletedToolAggregate, HudLineId, TranscriptActivity } from '../types.ts';
import { makeRunningToolItem, type PackableLineItem } from './activity-lines.ts';
import { CYAN, GRAY, GREEN, MAGENTA, RESET, truncateToWidth, visibleLen, YELLOW } from './ansi.ts';
import { resolveLineBudget } from './pack-line.ts';

const AGENT_SUMMARY_RETENTION_SEC = 60;
const MAX_SUMMARY_RUNNING_TOOLS = 2;
const SNAPSHOT_TAIL_RESERVE_COLS = 11;

export interface ActivitySummaryInput {
  enabledLines: ReadonlySet<HudLineId>;
  activity: TranscriptActivity | null;
  agentsSummary: AgentsSummary | null;
  termWidth?: number;
  nowSec?: number;
  formatTail?: (remainingCols: number) => string;
}

interface SummaryCategory {
  readonly startsWithCheck: boolean;
  readonly items: readonly string[];
  readonly totalCount: number;
  readonly render: (shownCount: number) => string;
}

function formatOverflowSuffix(totalCount: number, shownCount: number): string {
  const hidden = totalCount - shownCount;
  return hidden > 0 ? ` ${GRAY}(+${hidden})${RESET}` : '';
}

function buildCompletedToolsCategory(completed: readonly CompletedToolAggregate[]): SummaryCategory | null {
  if (completed.length === 0) return null;
  const items = completed.map((agg) => `${sanitizeTerminalLabel(agg.disp)} ${GRAY}×${agg.count}${RESET}`);
  const totalCount = completed.length;
  return {
    startsWithCheck: true,
    items,
    totalCount,
    render: (shownCount: number): string =>
      `${GREEN}✓${RESET} ${items.slice(0, shownCount).join(', ')}${formatOverflowSuffix(totalCount, shownCount)}`,
  };
}

function buildNamedSummaryCategory(title: string, names: readonly string[]): SummaryCategory | null {
  if (names.length === 0) return null;
  const items = names.map((name) => `${CYAN}${sanitizeTerminalLabel(name)}${RESET}`);
  const totalCount = names.length;
  return {
    startsWithCheck: false,
    items,
    totalCount,
    render: (shownCount: number): string =>
      `${GRAY}${title}:${RESET} ${items.slice(0, shownCount).join(', ')}${formatOverflowSuffix(totalCount, shownCount)}`,
  };
}

function buildAgentsSummaryCategory(summary: AgentsSummary | null, nowSec: number): SummaryCategory | null {
  if (!summary || summary.entries.length === 0) return null;
  const label = summary.kind === 'swarm' ? 'Swarm' : 'Agents';

  if (summary.alive > 0) {
    const ordered = [
      ...summary.entries.filter((entry) => entry.state === 'working'),
      ...summary.entries.filter((entry) => entry.state === 'waiting'),
    ];
    if (ordered.length === 0) return null;
    const items = ordered.map((entry) => {
      const icon = entry.state === 'working' ? `${YELLOW}◐${RESET}` : `${CYAN}◌${RESET}`;
      return `${icon} ${MAGENTA}${sanitizeTerminalLabel(entry.name)}${RESET}`;
    });
    const totalCount = Math.max(ordered.length, summary.total);
    return {
      startsWithCheck: false,
      items,
      totalCount,
      render: (shownCount: number): string =>
        `${MAGENTA}${label}:${RESET} ${items.slice(0, shownCount).join(', ')}${formatOverflowSuffix(totalCount, shownCount)}`,
    };
  }

  const recent: { name: string; ts: number; idx: number }[] = [];
  for (let idx = 0; idx < summary.entries.length; idx += 1) {
    const entry = summary.entries[idx];
    if (entry && entry.state === 'done' && isFiniteNum(entry.ts) && nowSec - entry.ts <= AGENT_SUMMARY_RETENTION_SEC) {
      recent.push({ name: sanitizeTerminalLabel(entry.name), ts: entry.ts, idx });
    }
  }
  if (recent.length === 0) return null;
  const byNewest = [...recent].sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.idx - a.idx));
  const items = byNewest.map((item) => `${GREEN}✓${RESET} ${MAGENTA}${item.name}${RESET}`);
  const totalCount = items.length;
  return {
    startsWithCheck: false,
    items,
    totalCount,
    render: (shownCount: number): string =>
      `${MAGENTA}${label}:${RESET} ${items.slice(0, shownCount).join(', ')}${formatOverflowSuffix(totalCount, shownCount)}`,
  };
}

function renderSummaryCategories(
  base: string,
  bridge: string,
  categories: readonly SummaryCategory[],
  counts: readonly number[],
  dotSep: string,
): string {
  const parts: string[] = [];
  for (let i = 0; i < counts.length; i += 1) {
    const cat = categories[i];
    const count = counts[i];
    if (cat && count !== undefined && count > 0) {
      parts.push(cat.render(count));
    }
  }
  return parts.length > 0 ? `${base}${bridge}${parts.join(dotSep)}` : base;
}

function packSummaryCategories(
  base: string,
  bridge: string,
  categories: readonly SummaryCategory[],
  budget: number,
  expandBudget: number,
  dotSep: string,
): string | null {
  let catCount = 0;
  for (let c = categories.length; c >= 1; c -= 1) {
    const ones = Array<number>(c).fill(1);
    const candidate = renderSummaryCategories(base, bridge, categories, ones, dotSep);
    if (visibleLen(candidate) <= budget) {
      catCount = c;
      break;
    }
  }
  if (catCount === 0) return null;

  const counts = Array<number>(catCount).fill(1);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < catCount; i += 1) {
      const cat = categories[i];
      const cur = counts[i] ?? 0;
      if (!cat || cur >= cat.items.length) continue;

      counts[i] = cur + 1;
      const candidate = renderSummaryCategories(base, bridge, categories, counts, dotSep);
      if (visibleLen(candidate) <= expandBudget) {
        progressed = true;
        continue;
      }

      if (cur + 2 === cat.items.length && cat.totalCount === cat.items.length) {
        counts[i] = cat.items.length;
        const fullCandidate = renderSummaryCategories(base, bridge, categories, counts, dotSep);
        if (visibleLen(fullCandidate) <= expandBudget) {
          progressed = true;
          continue;
        }
      }
      counts[i] = cur;
    }
  }
  return renderSummaryCategories(base, bridge, categories, counts, dotSep);
}

function fitSummaryWithRunningTools(
  runningItems: readonly PackableLineItem[],
  categories: readonly SummaryCategory[],
  budget: number,
  expandBudget: number,
  runSep: string,
  bridgeSep: string,
  dotSep: string,
): string {
  const prefix = '  ';
  const rendered = runningItems.map((item) => item.render());
  const firstRun = rendered[0] ?? '';
  const base1 = `${prefix}${firstRun}`;

  if (rendered.length >= 2) {
    const base2 = `${prefix}${firstRun}${runSep}${rendered[1] ?? ''}`;
    if (categories.length === 0) {
      if (visibleLen(base2) <= budget) return base2;
    } else {
      const packed2 = packSummaryCategories(base2, bridgeSep, categories, budget, expandBudget, dotSep);
      if (packed2 !== null) return packed2;
    }
  }

  if (categories.length > 0) {
    const packed1 = packSummaryCategories(base1, bridgeSep, categories, budget, expandBudget, dotSep);
    if (packed1 !== null) return packed1;
  }

  if (rendered.length >= 2) {
    const base2 = `${prefix}${firstRun}${runSep}${rendered[1] ?? ''}`;
    if (visibleLen(base2) <= budget) return base2;
  }
  if (visibleLen(base1) <= budget) return base1;

  const firstItem = runningItems[0];
  if (!firstItem) return '';
  const prefixCols = visibleLen(prefix);
  if (budget <= prefixCols) {
    return firstItem.renderEllipsized(budget);
  }
  return `${prefix}${firstItem.renderEllipsized(budget - prefixCols)}`;
}

export function formatActivitySummaryLine(input: ActivitySummaryInput): string {
  const { enabledLines, activity, agentsSummary, formatTail } = input;
  const includeTools = !enabledLines.has('tools');
  const includeSkills = !enabledLines.has('skills');
  const includeMcps = !enabledLines.has('mcps');
  const includeAgents = !enabledLines.has('agents');

  if (!includeTools && !includeSkills && !includeMcps && !includeAgents) {
    return '';
  }

  const skills = activity?.skills ?? [];
  const mcps = activity?.mcps ?? [];
  const filteredTools = (activity?.tools ?? []).filter((t) => !(skills.length > 0 && t.isSkillRead));
  const runningItems = includeTools
    ? selectNewestFirst(
        filteredTools.filter((t) => t.running),
        MAX_SUMMARY_RUNNING_TOOLS,
      ).map(makeRunningToolItem)
    : [];

  const categories: SummaryCategory[] = [];
  if (includeTools) {
    const toolsCat = buildCompletedToolsCategory(aggregateCompletedTools(filteredTools, false));
    if (toolsCat !== null) categories.push(toolsCat);
  }
  if (includeSkills) {
    const skillsCat = buildNamedSummaryCategory('Skills', skills);
    if (skillsCat !== null) categories.push(skillsCat);
  }
  if (includeMcps) {
    const mcpsCat = buildNamedSummaryCategory('MCPs', mcps);
    if (mcpsCat !== null) categories.push(mcpsCat);
  }
  if (includeAgents) {
    const agentsCat = buildAgentsSummaryCategory(agentsSummary, input.nowSec ?? Date.now() / 1000);
    if (agentsCat !== null) categories.push(agentsCat);
  }

  if (runningItems.length === 0 && categories.length === 0) {
    return '';
  }

  const budget = resolveLineBudget(input.termWidth);
  const expandBudget = formatTail ? Math.max(0, budget - SNAPSHOT_TAIL_RESERVE_COLS) : budget;
  const runSep = ` ${GRAY}|${RESET} `;
  const bridgeSep = ` ${GRAY}│${RESET} `;
  const dotSep = ` ${GRAY}·${RESET} `;

  let line = '';
  if (runningItems.length > 0) {
    line = fitSummaryWithRunningTools(runningItems, categories, budget, expandBudget, runSep, bridgeSep, dotSep);
  } else {
    const firstCat = categories[0];
    const prefix = firstCat?.startsWithCheck ? '  ' : `  ${GREEN}✓${RESET} `;
    const packed = packSummaryCategories(prefix, '', categories, budget, expandBudget, dotSep);
    if (packed !== null) {
      line = packed;
    } else if (firstCat !== undefined) {
      const prefixCols = visibleLen(prefix);
      line =
        budget <= prefixCols
          ? truncateToWidth(firstCat.render(1), budget)
          : `${prefix}${truncateToWidth(firstCat.render(1), budget - prefixCols)}`;
    }
  }

  if (line.length === 0) {
    return '';
  }
  if (formatTail) {
    const remainingCols = budget - visibleLen(line);
    const tail = formatTail(remainingCols);
    if (tail.length > 0 && visibleLen(line) + visibleLen(tail) <= budget) {
      return `${line}${tail}`;
    }
  }
  return line;
}
