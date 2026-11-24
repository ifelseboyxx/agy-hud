import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';

import { isFiniteNum, isPlainObject, nonEmptyStr } from '../core/guards.ts';
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
} from '../render/ansi.ts';
import { type ActivityLineFormatOptions, packActivityLine, type PackableLineItem } from '../render/pack-line.ts';
import type {
  ActivityAgentEntry,
  AgentEntry,
  AgentsKind,
  AgentsSummary,
  AgentState,
  StatusLineData,
  SubagentStdinItem,
} from '../types.ts';
import { resolveCliSubdirFile, resolveConversationId, sanitizeSessionId } from './safe-path.ts';

const AGENT_RETENTION_SECONDS = 60;
const TAIL_READ_BYTES = 16384;
const MAX_VISIBLE_AGENTS = 8;
const MAX_AGENT_LABEL_LEN = 28;

const WORKING_STATES: ReadonlySet<string> = new Set([
  '',
  'RUNNING',
  'WORKING',
  'INITIALIZING',
  'MERGING',
  'PENDING',
  'IN_PROGRESS',
  'EXECUTING',
]);
const WAITING_STATES: ReadonlySet<string> = new Set(['WAITING', 'IDLE', 'PAUSED', 'SLEEPING']);

export interface ParsedStdinSubagent extends AgentEntry {
  key: string;
  altKey: string;
}

export interface RuntimeBadgesOptions {
  hasTodosLine?: boolean;
}

function classifyStatus(rawStatus: unknown): AgentState {
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toUpperCase() : '';
  if (WORKING_STATES.has(status)) {
    return 'working';
  }
  if (WAITING_STATES.has(status)) {
    return 'waiting';
  }
  return 'done';
}

export function cleanAgentLabel(rawName: unknown, rawRole: unknown, rawType: unknown = ''): string {
  const strip = (val: unknown): string => {
    if (typeof val !== 'string') {
      return '';
    }
    const firstLine = val.trim().split(/\r?\n/, 1)[0] ?? '';
    return firstLine.replace(/^[` ]+|[` ]+$/g, '');
  };

  const name = strip(rawName);
  const role = strip(rawRole);
  const agentType = strip(rawType);

  let chosen: string;
  if (role.length > 0 && role.length <= MAX_AGENT_LABEL_LEN) {
    chosen = role;
  } else if (name.length > 0 && name.length <= MAX_AGENT_LABEL_LEN) {
    chosen = name;
  } else if (role.length > 0) {
    chosen = role;
  } else if (name.length > 0) {
    chosen = name;
  } else if (agentType.length > 0) {
    chosen = agentType;
  } else {
    chosen = 'subagent';
  }

  if (chosen.length > MAX_AGENT_LABEL_LEN) {
    return `${chosen.slice(0, MAX_AGENT_LABEL_LEN - 1).trimEnd()}…`;
  }
  return chosen;
}

export function readTailLines(filePath: string, maxBytes: number = TAIL_READ_BYTES): string[] {
  let rawBuf: Buffer;
  let start = 0;
  try {
    const fd = openSync(filePath, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size <= 0) {
        return [];
      }
      start = Math.max(0, size - maxBytes);
      const len = size - start;
      rawBuf = Buffer.allocUnsafe(len);
      let readPos = 0;
      while (readPos < len) {
        const bytesRead = readSync(fd, rawBuf, readPos, len - readPos, start + readPos);
        if (bytesRead <= 0) {
          break;
        }
        readPos += bytesRead;
      }
      if (readPos < len) {
        rawBuf = rawBuf.subarray(0, readPos);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }

  let lines = rawBuf.toString('utf8').split(/\r?\n/);
  if (start > 0 && lines.length > 0) {
    lines = lines.slice(1);
  }
  return lines.filter((line) => line.trim().length > 0);
}

export function transcriptTurnEnded(lines: readonly string[]): boolean {
  const results: Record<string, unknown>[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    if (raw === undefined) {
      continue;
    }
    let step: unknown;
    try {
      step = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isPlainObject(step)) {
      return false;
    }
    if (step.type === 'GENERIC') {
      results.unshift(step);
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE') {
      return false;
    }
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) {
      return results.length === 0;
    }
    const waitIdx = calls.findIndex((tc) => isPlainObject(tc) && tc.name === 'swarm_wait');
    if (waitIdx < 0 || results.length < calls.length) {
      return false;
    }
    const waitResult = results[waitIdx];
    const waitStatus = waitResult && typeof waitResult.status === 'string' ? waitResult.status.toUpperCase() : '';
    return waitStatus === 'DONE';
  }
  return false;
}

function memberSwarmState(cliHome: string, member: Record<string, unknown>): AgentState {
  const convId = sanitizeSessionId(nonEmptyStr(member.conversation_id));
  if (convId !== null) {
    const tpath = resolveCliSubdirFile(cliHome, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (tpath !== null && existsSync(tpath)) {
      const tail = readTailLines(tpath);
      if (tail.length > 0) {
        return transcriptTurnEnded(tail) ? 'waiting' : 'working';
      }
    }
  }
  const wakeMode = typeof member.wake_mode === 'string' ? member.wake_mode.trim().toLowerCase() : '';
  if (wakeMode === 'mentions' || wakeMode === 'anything') {
    return 'waiting';
  }
  return 'working';
}

function loadSwarmEntries(cliHome: string, data: StatusLineData): AgentEntry[] | null {
  const convId = resolveConversationId(data);
  if (convId === null) {
    return null;
  }
  const rosterPath = resolveCliSubdirFile(cliHome, 'brain', convId, '.system_generated', 'swarm', 'members.json');
  if (rosterPath === null || !existsSync(rosterPath)) {
    return null;
  }
  let roster: unknown;
  try {
    roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(roster) || !isPlainObject(roster.members)) {
    return null;
  }

  const entries: AgentEntry[] = [];
  for (const [name, member] of Object.entries(roster.members)) {
    if (!isPlainObject(member)) {
      continue;
    }
    const role = typeof member.role === 'string' ? member.role.trim().toLowerCase() : '';
    if (name === 'coordinator' || role === 'coordinator' || member.killed === true) {
      continue;
    }
    entries.push({
      name,
      type: role.length > 0 && role !== 'worker' ? role : '',
      model: typeof member.model === 'string' ? member.model.trim() : '',
      state: memberSwarmState(cliHome, member),
      ts: null,
    });
  }
  return entries;
}

export function parseStdinSubagents(stdinSubagents: readonly SubagentStdinItem[] | undefined): ParsedStdinSubagent[] {
  if (!Array.isArray(stdinSubagents)) {
    return [];
  }
  const entries: ParsedStdinSubagent[] = [];
  for (const sa of stdinSubagents) {
    if (!isPlainObject(sa)) {
      continue;
    }
    const rawName = typeof sa.name === 'string' ? sa.name.trim() : '';
    const rawRole = typeof sa.role === 'string' ? sa.role.trim() : '';
    const rawType = typeof sa.type_name === 'string' ? sa.type_name.trim() : '';
    const label = cleanAgentLabel(rawName, rawRole, rawType);
    entries.push({
      name: label,
      key: rawName.toLowerCase(),
      altKey: label.toLowerCase(),
      type: rawType,
      model: typeof sa.model === 'string' ? sa.model.trim() : '',
      state: classifyStatus(sa.status ?? sa.state),
      ts: null,
    });
  }
  return entries;
}

export function syncSwarmFromStdin(
  swarmEntries: AgentEntry[],
  stdinEntries: readonly ParsedStdinSubagent[],
): AgentEntry[] {
  const byName = new Map<string, AgentEntry>();
  for (const entry of swarmEntries) {
    byName.set(entry.name.toLowerCase(), entry);
  }
  for (const sa of stdinEntries) {
    const target = byName.get(sa.key) ?? byName.get(sa.altKey);
    if (!target) {
      continue;
    }
    if (sa.state === 'working' || sa.state === 'waiting') {
      target.state = sa.state;
    }
    if (sa.model.length > 0 && target.model.length === 0) {
      target.model = sa.model;
    }
  }
  return swarmEntries;
}

function convertActivityAgents(activityAgents: readonly ActivityAgentEntry[] | undefined): AgentEntry[] {
  if (!activityAgents) {
    return [];
  }
  return activityAgents.map((agent) => ({
    name: cleanAgentLabel(agent.name, '', agent.type),
    type: agent.type,
    model: agent.model,
    state: agent.running ? 'working' : 'done',
    ts: agent.ts,
  }));
}

export function collectAgentsSummary(
  cliHome: string,
  data: StatusLineData,
  activityAgents?: readonly ActivityAgentEntry[],
): AgentsSummary {
  const swarmEntries = loadSwarmEntries(cliHome, data);
  const stdinEntries = parseStdinSubagents(data.subagents);

  let entries: AgentEntry[];
  let kind: AgentsKind;
  if (swarmEntries !== null) {
    entries = syncSwarmFromStdin(swarmEntries, stdinEntries);
    kind = 'swarm';
  } else if (stdinEntries.length > 0) {
    entries = stdinEntries.map(({ name, type, model, state, ts }) => ({ name, type, model, state, ts }));
    kind = 'agents';
  } else {
    entries = convertActivityAgents(activityAgents);
    kind = 'agents';
  }

  let working = 0;
  let waiting = 0;
  for (const entry of entries) {
    if (entry.state === 'working') {
      working += 1;
    } else if (entry.state === 'waiting') {
      waiting += 1;
    }
  }
  const alive = working + waiting;
  return {
    kind,
    working,
    waiting,
    alive,
    total: kind === 'swarm' ? alive : entries.length,
    entries,
  };
}

export function formatRuntimeBadges(data: StatusLineData, options?: RuntimeBadgesOptions): string[] {
  const badges: string[] = [];
  const aname = nonEmptyStr(data.agent?.name);
  if (aname !== undefined) {
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
      const arm = nonEmptyStr(battle.focused_arm);
      const armStr = arm !== undefined ? ` ${arm}` : '';
      badges.push(`${BRIGHT_YELLOW}Battle${armStr}${RESET}`);
    }
  }

  if (options?.hasTodosLine !== true && typeof data.task_count === 'number' && data.task_count > 0) {
    badges.push(`${CYAN}BG ${BRIGHT_WHITE}${data.task_count}${RESET}`);
  }

  if (data.tool_confirmation_pending === true) {
    badges.push(`${BRIGHT_RED}! Approval${RESET}`);
  }

  if (typeof data.pending_input_count === 'number' && data.pending_input_count > 0) {
    badges.push(`${YELLOW}Q:${data.pending_input_count}${RESET}`);
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
  return {
    render: () => `${icon} ${MAGENTA}${entry.name}${RESET}`,
    renderEllipsized: (maxCols: number) =>
      maxCols >= 3
        ? `${icon} ${MAGENTA}${truncateToWidth(entry.name, maxCols - 2)}${RESET}`
        : `${MAGENTA}${truncateToWidth(entry.name, maxCols)}${RESET}`,
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
  const doneItems: PackableLineItem[] = byNewest.map(({ entry }) => ({
    render: () => `${MAGENTA}${entry.name}${RESET}`,
    renderEllipsized: (maxCols: number) => `${MAGENTA}${truncateToWidth(entry.name, maxCols)}${RESET}`,
  }));
  return packActivityLine({
    prefix: `  ${GREEN}✓${RESET} Agents ${GRAY}(${recent.length} done):${RESET} `,
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
