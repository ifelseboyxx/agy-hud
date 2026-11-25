import { nonEmptyStr } from '../core/guards.ts';
import { sanitizeTerminalLabel, sanitizeTerminalText } from '../core/terminal-text.ts';
import type {
  SnapshotAgent,
  SnapshotCompletedTool,
  SnapshotMcpServer,
  SnapshotRunningTool,
} from '../snapshot-types.ts';
import type { ActivityAgentEntry, AgentEntry, AgentsKind, AgentsSummary } from '../types.ts';
import { shortenTarget } from './activity-parse.ts';
import { cleanAgentLabel } from './agents.ts';
import { formatRelativeAge } from './snapshot-envelope.ts';
import { SNAPSHOT_TARGET_DISPLAY_LEN } from './snapshot-transcript.ts';

const MAX_RECENT_TARGETS = 6;

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

  for (const srv of knownServers) {
    if (srv.length > 0) {
      ensureServer(srv);
    }
  }
  const knownSet = new Set<string>(knownServers);
  let totalToolCalls = 0;

  for (const call of tools) {
    const mcpPair = resolveToolMcpPair(call, knownSet);
    if (mcpPair !== null) {
      const subCounts = ensureServer(mcpPair[0]);
      subCounts.set(mcpPair[1], (subCounts.get(mcpPair[1]) ?? 0) + 1);
    }

    if (hideSkillReads && call.isSkillRead) continue;
    totalToolCalls += 1;

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
        latestTarget: fullTarget.length > 0 ? shortenTarget(fullTarget, targetDisplayLen) : info.latestShort,
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
