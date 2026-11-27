import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { normalizeHostAgentState } from '../core/quota-pace.ts';
import { formatErrorReasonShortCode } from '../core/telemetry-error.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { AgentEntry, AgentsSummary, SessionTelemetry, StatusLineData } from '../types.ts';
import {
  BRIGHT_CYAN,
  BRIGHT_RED,
  BRIGHT_WHITE,
  BRIGHT_YELLOW,
  CYAN,
  DEFAULT_TERM_WIDTH,
  GRAY,
  GREEN,
  MAGENTA,
  RESET,
  truncateToWidth,
  YELLOW,
} from './ansi.ts';
import { isActiveShimmerState } from './effort-style.ts';
import { type ActivityLineFormatOptions, packActivityLine, type PackableLineItem } from './pack-line.ts';

const AGENT_RETENTION_SECONDS = 60;
const MAX_VISIBLE_AGENTS = 8;

export interface RuntimeBadgesOptions {
  hasTodosLine?: boolean;
  telemetry?: SessionTelemetry | null;
}

export function formatRuntimeBadges(data: StatusLineData, options?: RuntimeBadgesOptions): string[] {
  const badges: string[] = [];
  const rawAgentName = nonEmptyStr(data.agent?.name);
  const aname = rawAgentName !== undefined ? sanitizeTerminalLabel(rawAgentName) : '';
  if (aname.length > 0) {
    badges.push(`${BRIGHT_CYAN}@${aname.slice(0, 20)}${RESET}`);
  }

  const battle = data.battle;
  if (battle) {
    const bstatus = nonEmptyStr(battle.status)?.toLowerCase() ?? '';
    if (
      bstatus.length > 0 &&
      bstatus !== 'none' &&
      bstatus !== 'inactive' &&
      bstatus !== 'ended' &&
      bstatus !== 'idle'
    ) {
      const rawArm = nonEmptyStr(battle.focused_arm);
      const arm = rawArm !== undefined ? sanitizeTerminalLabel(rawArm) : '';
      const armStr = arm.length > 0 ? ` ${arm}` : '';
      badges.push(`${BRIGHT_YELLOW}Battle${armStr}${RESET}`);
    }
  }

  if (options?.hasTodosLine !== true && typeof data.task_count === 'number' && data.task_count > 0) {
    badges.push(`${CYAN}Bg Tasks ${BRIGHT_WHITE}${data.task_count}${RESET}`);
  }

  if (data.tool_confirmation_pending === true) {
    badges.push(`${BRIGHT_RED}! Approval${RESET}`);
  }

  const hostState = normalizeHostAgentState(data.agent_state);
  const activeTurn = isActiveShimmerState(data.agent_state);
  if (hostState === 'authenticating') {
    badges.push(`${BRIGHT_RED}! Auth${RESET}`);
  } else if (hostState === 'reviewing' && data.tool_confirmation_pending !== true) {
    badges.push(`${BRIGHT_CYAN}Review${RESET}`);
  }

  const tel = options?.telemetry ?? null;
  const isErrorActive = hostState === 'error' || (!activeTurn && tel?.lastErrorCode != null);
  if (isErrorActive) {
    const code = tel?.lastErrorCode ? formatErrorReasonShortCode(tel.lastErrorCode) : '';
    const suffix = code.length > 0 ? ` ${code}` : '';
    badges.push(`${BRIGHT_RED}! Error${suffix}${RESET}`);
  } else if (tel !== null && isFiniteNum(tel.lastRetries) && tel.lastRetries > 0) {
    const code = tel.lastRetryReason ? formatErrorReasonShortCode(tel.lastRetryReason) : '';
    const candidate = code.length > 0 ? `Retry ×${tel.lastRetries} ${code}` : `Retry ×${tel.lastRetries}`;
    const label = candidate.length <= 15 ? candidate : `Retry ×${tel.lastRetries}`;
    badges.push(`${BRIGHT_YELLOW}${label}${RESET}`);
  }

  if (typeof data.pending_input_count === 'number' && data.pending_input_count > 0) {
    badges.push(`${YELLOW}Queued ${data.pending_input_count}${RESET}`);
  }

  return badges;
}

export function formatAgentsBadge(summary: AgentsSummary | null | undefined): string {
  if (!summary || summary.alive <= 0) {
    return '';
  }
  const { kind, working, alive, total } = summary;
  if (kind === 'swarm') {
    const wColor = working > 0 ? BRIGHT_YELLOW : GRAY;
    return `${MAGENTA}Swarm ${wColor}${working}${GRAY}/${BRIGHT_WHITE}${alive}${RESET}`;
  }
  if (total > alive) {
    return `${MAGENTA}Agents ${BRIGHT_YELLOW}${alive}${GRAY}/${BRIGHT_WHITE}${total}${RESET}`;
  }
  return `${MAGENTA}Agents ${BRIGHT_YELLOW}${alive}${RESET}`;
}

function makeMemberChipItem(entry: AgentEntry): PackableLineItem {
  const icon = entry.state === 'working' ? `${YELLOW}◐${RESET}` : `${CYAN}◌${RESET}`;
  const cleanName = sanitizeTerminalLabel(entry.name);
  return {
    render: () => `${icon} ${MAGENTA}${cleanName}${RESET}`,
    renderEllipsized: (maxCols: number) =>
      maxCols >= 3
        ? `${icon} ${MAGENTA}${truncateToWidth(cleanName, maxCols - 2)}${RESET}`
        : `${MAGENTA}${truncateToWidth(cleanName, maxCols)}${RESET}`,
  };
}

export function formatAgentsSection(
  summary: AgentsSummary | null | undefined,
  maxAgentChips: number = MAX_VISIBLE_AGENTS,
  nowSec: number = Date.now() / 1000,
  termWidth: number = DEFAULT_TERM_WIDTH,
  options?: ActivityLineFormatOptions,
): string {
  if (!summary || summary.entries.length === 0 || maxAgentChips <= 0) {
    return '';
  }
  const { kind, working, alive, total, entries } = summary;

  if (alive > 0) {
    const ordered = [...entries.filter((e) => e.state === 'working'), ...entries.filter((e) => e.state === 'waiting')];
    const prefix =
      kind === 'swarm'
        ? `  ${working > 0 ? `${YELLOW}◐${RESET}` : `${CYAN}◌${RESET}`} Swarm ${GRAY}(${working === 0 ? `0/${alive} waiting` : `${working}/${alive}`}):${RESET} `
        : `  ${YELLOW}◐${RESET} Agents ${GRAY}(${total > alive ? `${alive}/${total}` : String(alive)}):${RESET} `;
    return packActivityLine({
      prefix,
      separator: ', ',
      items: ordered.map(makeMemberChipItem),
      maxItems: maxAgentChips,
      termWidth,
      formatOverflow: options?.formatOverflow,
    });
  }

  const recent: { entry: AgentEntry; ts: number; idx: number }[] = [];
  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx];
    if (entry && entry.state === 'done' && isFiniteNum(entry.ts) && nowSec - entry.ts <= AGENT_RETENTION_SECONDS) {
      recent.push({ entry, ts: entry.ts, idx });
    }
  }
  if (recent.length === 0) {
    return '';
  }

  const byNewest = [...recent].sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.idx - a.idx));
  const doneItems: PackableLineItem[] = byNewest.map(({ entry }) => {
    const cleanName = sanitizeTerminalLabel(entry.name);
    return {
      render: () => `${MAGENTA}${cleanName}${RESET}`,
      renderEllipsized: (maxCols: number) => `${MAGENTA}${truncateToWidth(cleanName, maxCols)}${RESET}`,
    };
  });
  const donePrefix =
    kind === 'swarm'
      ? `  ${GREEN}✓${RESET} Swarm ${GRAY}(${recent.length} stopped):${RESET} `
      : `  ${GREEN}✓${RESET} Agents ${GRAY}(${recent.length} done):${RESET} `;
  return packActivityLine({
    prefix: donePrefix,
    separator: ', ',
    items: doneItems,
    maxItems: maxAgentChips,
    termWidth,
    formatOverflow: options?.formatOverflow,
    sortSelectedIndices: (selected) =>
      [...selected].sort((ia, ib) => {
        const a = byNewest[ia];
        const b = byNewest[ib];
        if (!a || !b) {
          return ia - ib;
        }
        return a.ts !== b.ts ? a.ts - b.ts : a.idx - b.idx;
      }),
  });
}
