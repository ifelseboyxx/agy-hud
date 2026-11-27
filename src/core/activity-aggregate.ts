import type {
  SnapshotAgent,
  SnapshotCompletedTool,
  SnapshotMcpServer,
  SnapshotRunningTool,
} from '../snapshot-types.ts';
import type {
  ActivityAgentEntry,
  AgentEntry,
  AgentsKind,
  AgentsSummary,
  CompletedToolAggregate,
  TranscriptToolEntry,
} from '../types.ts';
import { formatRelativeAge, nonEmptyStr } from './guards.ts';
import { sanitizeTerminalLabel, sanitizeTerminalText } from './terminal-text.ts';

const MAX_TARGET_LEN = 20;
export const SNAPSHOT_TARGET_DISPLAY_LEN: number = 34;

const MAX_RECENT_TARGETS = 6;
const MAX_AGENT_LABEL_LEN = 28;

export interface AggregatableToolCall {
  name: string;
  disp: string;
  target: string;
  fullTarget?: string;
  targetLinkable?: boolean;
  running: boolean;
  isSkillRead: boolean;
  mcpServer?: string | null;
  mcpSubtool?: string | null;
}

export interface AggregateToolsOptions {
  knownMcpServers?: readonly string[];
  targetDisplayLen?: number;
  hideSkillReads?: boolean;
  preferEntryTarget?: boolean;
  collectMcps?: boolean;
  collectRunning?: boolean;
}

export interface AggregatedToolActivity {
  runningTools: SnapshotRunningTool[];
  completedTools: SnapshotCompletedTool[];
  totalToolCalls: number;
  mcps: SnapshotMcpServer[];
}

export interface MergedActivityAgents {
  kind: AgentsKind;
  entries: SnapshotAgent[];
}

export function shortenTarget(text: string, maxLen: number = MAX_TARGET_LEN): string {
  let clean = sanitizeTerminalText(text).replaceAll('\\', '/').trim();
  if (clean.length === 0) {
    return '';
  }
  if (clean.includes('/')) {
    const trimmed = clean.replace(/\/+$/, '');
    const parts = trimmed.split('/');
    const tail = parts[parts.length - 1];
    if (tail !== undefined && tail.length > 0) {
      clean = tail;
    }
  }
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 1)}…`;
}

export function cleanAgentLabel(rawName: unknown, rawRole: unknown, rawType: unknown = ''): string {
  const strip = (val: unknown): string => {
    if (typeof val !== 'string') {
      return '';
    }
    const firstLine = val.trim().split(/\r?\n/, 1)[0] ?? '';
    return sanitizeTerminalText(firstLine)
      .trim()
      .replace(/^[` ]+|[` ]+$/g, '');
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

function resolveToolMcpPair(
  call: AggregatableToolCall,
  knownSet: ReadonlySet<string>,
): readonly [string, string] | null {
  if (typeof call.mcpServer === 'string' && typeof call.mcpSubtool === 'string') {
    return call.mcpServer.length > 0 && call.mcpSubtool.length > 0 ? [call.mcpServer, call.mcpSubtool] : null;
  }
  if (call.mcpServer === null || call.mcpSubtool === null) {
    return null;
  }
  const colonIdx = call.disp.indexOf(':');
  if (colonIdx <= 0 || colonIdx >= call.disp.length - 1) {
    return null;
  }
  const prefix = call.disp.slice(0, colonIdx);
  const subtool = call.disp.slice(colonIdx + 1);
  const isMcpCall =
    knownSet.has(prefix) ||
    (prefix !== 'mcp' &&
      (call.name.startsWith('mcp') ||
        call.name === 'call_mcp_tool' ||
        call.name === 'list_resources' ||
        call.name === 'read_resource'));
  return isMcpCall ? [prefix, subtool] : null;
}

export function aggregateActivityTools(
  tools: readonly AggregatableToolCall[],
  options: AggregateToolsOptions = {},
): AggregatedToolActivity {
  const knownServers = options.knownMcpServers ?? [];
  const targetDisplayLen = options.targetDisplayLen ?? SNAPSHOT_TARGET_DISPLAY_LEN;
  const hideSkillReads = options.hideSkillReads ?? true;
  const preferEntryTarget = options.preferEntryTarget === true;
  const collectMcps = options.collectMcps !== false;
  const collectRunning = options.collectRunning !== false;

  const runningTools: SnapshotRunningTool[] = [];
  const completedMap = new Map<
    string,
    { count: number; targets: string[]; unlinkedTargets: Set<string>; latestShort: string; isMcp: boolean }
  >();
  const mcpOrder: string[] = [];
  const mcpSubMap = new Map<string, Map<string, number>>();
  const ensureServer = (server: string): Map<string, number> => {
    let subCounts = mcpSubMap.get(server);
    if (!subCounts) {
      mcpOrder.push(server);
      subCounts = new Map<string, number>();
      mcpSubMap.set(server, subCounts);
    }
    return subCounts;
  };

  if (collectMcps) {
    for (const srv of knownServers) {
      if (srv.length > 0) {
        ensureServer(srv);
      }
    }
  }
  const knownSet = new Set<string>(knownServers);
  let totalToolCalls = 0;

  for (const call of tools) {
    const mcpPair = collectMcps ? resolveToolMcpPair(call, knownSet) : null;
    if (mcpPair !== null) {
      const subCounts = ensureServer(mcpPair[0]);
      subCounts.set(mcpPair[1], (subCounts.get(mcpPair[1]) ?? 0) + 1);
    }

    if (hideSkillReads && call.isSkillRead) continue;
    totalToolCalls += 1;
    if (call.running && !collectRunning) continue;

    const disp = call.disp.length > 0 ? call.disp : call.name;
    const rawTarget = typeof call.fullTarget === 'string' && call.fullTarget.length > 0 ? call.fullTarget : call.target;

    if (call.running) {
      runningTools.push({
        name: call.name,
        disp,
        target: call.target,
        fullTarget: rawTarget,
        ...(call.targetLinkable === false ? { targetLinkable: false } : {}),
        isMcp: mcpPair !== null,
      });
      continue;
    }

    const prev = completedMap.get(disp) ?? {
      count: 0,
      targets: [],
      unlinkedTargets: new Set<string>(),
      latestShort: '',
      isMcp: mcpPair !== null,
    };
    prev.count += 1;
    if (call.target.length > 0) {
      prev.latestShort = call.target;
    }
    if (rawTarget.length > 0) {
      const existingIdx = prev.targets.indexOf(rawTarget);
      if (existingIdx !== -1) prev.targets.splice(existingIdx, 1);
      prev.targets.unshift(rawTarget);
      if (prev.targets.length > MAX_RECENT_TARGETS) prev.targets.pop();
      if (call.targetLinkable === false) {
        prev.unlinkedTargets.add(rawTarget);
      }
    }
    completedMap.set(disp, prev);
  }

  const completedTools: SnapshotCompletedTool[] = [...completedMap.entries()]
    .map(([disp, info]) => {
      const fullTarget = info.targets[0] ?? '';
      const unlinkedTargets = info.targets.filter((target) => info.unlinkedTargets.has(target));
      return {
        disp,
        count: info.count,
        latestTarget: preferEntryTarget
          ? info.latestShort
          : fullTarget.length > 0
            ? shortenTarget(fullTarget, targetDisplayLen)
            : info.latestShort,
        fullTarget,
        recentTargets: info.targets,
        ...(unlinkedTargets.length > 0 ? { unlinkedTargets } : {}),
        isMcp: info.isMcp,
      };
    })
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.disp.localeCompare(b.disp)));

  const mcps: SnapshotMcpServer[] = mcpOrder.map((server) => {
    const subtools = [...(mcpSubMap.get(server)?.entries() ?? [])]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)));
    const totalCalls = subtools.reduce((sum, item) => sum + item.count, 0);
    return { server, totalCalls, subtools };
  });

  return { runningTools, completedTools, totalToolCalls, mcps };
}

export function aggregateCompletedTools(
  tools: readonly TranscriptToolEntry[],
  hasSkills = false,
): CompletedToolAggregate[] {
  const { completedTools } = aggregateActivityTools(tools, {
    hideSkillReads: hasSkills,
    preferEntryTarget: true,
    collectMcps: false,
    collectRunning: false,
  });
  return completedTools.map(({ disp, count, latestTarget, fullTarget, recentTargets }) => ({
    disp,
    count,
    latestTarget,
    fullTarget,
    recentTargets,
  }));
}

export function mergeActivityAgents(
  agentsSummary: AgentsSummary | null,
  transcriptAgents: readonly ActivityAgentEntry[],
  nowMs: number,
): MergedActivityAgents {
  const kind: AgentsKind = agentsSummary?.kind ?? 'agents';
  const combined: AgentEntry[] = agentsSummary ? [...agentsSummary.entries] : [];

  if (!agentsSummary) {
    for (const ta of transcriptAgents) {
      combined.push({
        name: cleanAgentLabel(ta.name, '', ta.type),
        type: ta.type,
        model: ta.model,
        state: ta.running ? 'working' : 'done',
        ts: ta.ts,
      });
    }
  } else if (transcriptAgents.length > 0) {
    const existingDoneCounts = new Map<string, number>();
    for (const entry of combined) {
      if (entry.state !== 'done') continue;
      const key = entry.name.toLowerCase();
      existingDoneCounts.set(key, (existingDoneCounts.get(key) ?? 0) + 1);
    }
    for (const ta of transcriptAgents) {
      if (ta.running) continue;
      const label = cleanAgentLabel(ta.name, '', ta.type);
      const key = label.toLowerCase();
      const remaining = existingDoneCounts.get(key) ?? 0;
      if (remaining > 0) {
        existingDoneCounts.set(key, remaining - 1);
        continue;
      }
      combined.push({ name: label, type: ta.type, model: ta.model, state: 'done', ts: ta.ts });
    }
  }

  return {
    kind,
    entries: combined.map((entry) => ({
      name: sanitizeTerminalLabel(entry.name),
      type: nonEmptyStr(sanitizeTerminalText(entry.type)) ?? (kind === 'swarm' ? 'worker' : 'subagent'),
      model: nonEmptyStr(sanitizeTerminalText(entry.model)) ?? 'inherit',
      state: entry.state,
      ts: entry.ts,
      ageLabel:
        entry.ts !== null ? formatRelativeAge(nowMs - entry.ts * 1000) : entry.state === 'done' ? 'recent' : 'live',
    })),
  };
}
