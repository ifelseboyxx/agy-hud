import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

import { cleanAgentLabel } from '../core/activity-aggregate.ts';
import { readRegularJsonObjectSync } from '../core/fs-utils.ts';
import { isPlainObject, nonEmptyStr, parseIsoTimestampSec } from '../core/guards.ts';
import { resolveCliSubdirFile, resolveConversationId, sanitizeSessionId } from '../core/safe-path.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type {
  ActivityAgentEntry,
  AgentEntry,
  AgentsKind,
  AgentsSummary,
  AgentState,
  StatusLineData,
  SubagentStdinItem,
} from '../types.ts';

const TAIL_READ_BYTES = 16384;
const MAX_SWARM_ROSTER_BYTES = 1024 * 1024;

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
  if (rosterPath === null) {
    return null;
  }
  const roster = readRegularJsonObjectSync(rosterPath, MAX_SWARM_ROSTER_BYTES);
  if (roster === null || !isPlainObject(roster.members)) {
    return null;
  }

  const entries: AgentEntry[] = [];
  for (const [name, member] of Object.entries(roster.members)) {
    if (!isPlainObject(member)) {
      continue;
    }
    const cleanName = sanitizeTerminalLabel(name);
    const role = typeof member.role === 'string' ? sanitizeTerminalLabel(member.role).toLowerCase() : '';
    if (cleanName.length === 0 || cleanName === 'coordinator' || role === 'coordinator') {
      continue;
    }
    const isKilled = member.killed === true;
    const stoppedTs = isKilled ? parseIsoTimestampSec(member.killed_at ?? member.stopped_at) : null;
    entries.push({
      name: cleanName,
      type: role.length > 0 && role !== 'worker' ? role : '',
      model: typeof member.model === 'string' ? sanitizeTerminalLabel(member.model) : '',
      state: isKilled ? 'done' : memberSwarmState(cliHome, member),
      ts: stoppedTs,
    });
  }
  return entries;
}

function parseStdinSubagents(stdinSubagents: readonly SubagentStdinItem[] | undefined): ParsedStdinSubagent[] {
  if (!Array.isArray(stdinSubagents)) {
    return [];
  }
  const entries: ParsedStdinSubagent[] = [];
  for (const sa of stdinSubagents) {
    if (!isPlainObject(sa)) {
      continue;
    }
    const rawName = typeof sa.name === 'string' ? sanitizeTerminalLabel(sa.name) : '';
    const rawRole = typeof sa.role === 'string' ? sanitizeTerminalLabel(sa.role) : '';
    const rawType = typeof sa.type_name === 'string' ? sanitizeTerminalLabel(sa.type_name) : '';
    const label = cleanAgentLabel(rawName, rawRole, rawType);
    entries.push({
      name: label,
      key: rawName.toLowerCase(),
      altKey: label.toLowerCase(),
      type: rawType,
      model: typeof sa.model === 'string' ? sanitizeTerminalLabel(sa.model) : '',
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
    if (!target || target.state === 'done') {
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
    type: sanitizeTerminalLabel(agent.type),
    model: sanitizeTerminalLabel(agent.model),
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
