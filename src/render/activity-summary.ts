import { isFiniteNum } from '../core/guards.ts';
import type { AgentsSummary, HudLineId, TranscriptActivity, TranscriptToolEntry } from '../types.ts';
import {
  BRIGHT_WHITE,
  BRIGHT_YELLOW,
  CYAN,
  GRAY,
  GREEN,
  MAGENTA,
  RESET,
  truncateToWidth,
  visibleLen,
  YELLOW,
} from './ansi.ts';
import { resolveLineBudget } from './pack-line.ts';

const AGENT_SUMMARY_RETENTION_SEC = 60;
const MAX_SUMMARY_RUNNING_TOOLS = 2;

export interface ActivitySummaryInput {
  enabledLines: ReadonlySet<HudLineId>;
  activity: TranscriptActivity | null;
  agentsSummary: AgentsSummary | null;
  termWidth?: number;
  nowSec?: number;
  formatTail?: (remainingCols: number) => string;
}

function formatSummaryRunningChip(entry: TranscriptToolEntry): {
  full: string;
  ellipsize: (maxCols: number) => string;
} {
  const disp = entry.disp.length > 0 ? entry.disp : entry.name;
  const tgt = entry.target.length > 0 ? `${GRAY}: ${entry.target}${RESET}` : '';
  const full = `${YELLOW}◐${RESET} ${CYAN}${disp}${RESET}${tgt}`;
  return {
    full,
    ellipsize: (maxCols: number): string => {
      if (visibleLen(full) <= maxCols) return full;
      if (maxCols <= 2) return truncateToWidth(`◐ ${disp}`, maxCols);
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

function formatSummaryAgentsToken(summary: AgentsSummary | null, nowSec: number): string {
  if (!summary) return '';
  if (summary.alive > 0) {
    if (summary.kind === 'swarm') {
      const wColor = summary.working > 0 ? BRIGHT_YELLOW : GRAY;
      return `${MAGENTA}Swarm ${wColor}${summary.working}${GRAY}/${BRIGHT_WHITE}${summary.alive}${RESET}`;
    }
    const suffix = summary.total > summary.alive ? `${GRAY}/${BRIGHT_WHITE}${summary.total}` : '';
    return `${MAGENTA}Agents ${BRIGHT_YELLOW}${summary.alive}${suffix}${RESET}`;
  }
  const recentDone = summary.entries.filter(
    (entry) => entry.state === 'done' && isFiniteNum(entry.ts) && nowSec - entry.ts <= AGENT_SUMMARY_RETENTION_SEC,
  ).length;
  return recentDone > 0 ? `${MAGENTA}Agents ${GRAY}${recentDone} done${RESET}` : '';
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
  const runningChips = includeTools
    ? filteredTools
        .filter((t) => t.running)
        .slice(-MAX_SUMMARY_RUNNING_TOOLS)
        .reverse()
        .map(formatSummaryRunningChip)
    : [];

  const countTokens: string[] = [];
  if (includeTools && filteredTools.length > 0) {
    countTokens.push(`${GRAY}Tools ${BRIGHT_WHITE}${filteredTools.length}${RESET}`);
  }
  if (includeSkills && skills.length > 0) {
    countTokens.push(`${GRAY}Skills ${CYAN}${skills.length}${RESET}`);
  }
  if (includeMcps && mcps.length > 0) {
    countTokens.push(`${GRAY}MCPs ${CYAN}${mcps.length}${RESET}`);
  }
  if (includeAgents) {
    const agentToken = formatSummaryAgentsToken(agentsSummary, input.nowSec ?? Date.now() / 1000);
    if (agentToken.length > 0) {
      countTokens.push(agentToken);
    }
  }

  if (runningChips.length === 0 && countTokens.length === 0) {
    return '';
  }

  const budget = resolveLineBudget(input.termWidth);
  const runSep = ` ${GRAY}|${RESET} `;
  const bridgeSep = ` ${GRAY}│${RESET} `;
  const dotSep = ` ${GRAY}·${RESET} `;
  let line = '';

  if (runningChips.length > 0) {
    const prefix = '  ';
    const tryBuild = (runCount: number, countLen: number): string => {
      const runPart = runningChips
        .slice(0, runCount)
        .map((c) => c.full)
        .join(runSep);
      const countPart = countTokens.slice(0, countLen).join(dotSep);
      return countPart.length > 0 ? `${prefix}${runPart}${bridgeSep}${countPart}` : `${prefix}${runPart}`;
    };

    const candidates: string[] = [tryBuild(runningChips.length, countTokens.length)];
    if (runningChips.length > 1) {
      candidates.push(tryBuild(1, countTokens.length));
    }
    for (let c = countTokens.length - 1; c >= 0; c -= 1) {
      candidates.push(tryBuild(1, c));
    }
    const fit = candidates.find((cand) => visibleLen(cand) <= budget);
    if (fit !== undefined) {
      line = fit;
    } else {
      const firstChip = runningChips[0];
      line = firstChip ? `${prefix}${firstChip.ellipsize(Math.max(1, budget - visibleLen(prefix)))}` : '';
    }
  } else {
    const prefix = `  ${GREEN}✓${RESET} `;
    for (let c = countTokens.length; c >= 1; c -= 1) {
      const candidate = `${prefix}${countTokens.slice(0, c).join(dotSep)}`;
      if (visibleLen(candidate) <= budget) {
        line = candidate;
        break;
      }
    }
    if (line.length === 0) {
      const firstToken = countTokens[0];
      line = firstToken ? `${prefix}${truncateToWidth(firstToken, Math.max(1, budget - visibleLen(prefix)))}` : '';
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
