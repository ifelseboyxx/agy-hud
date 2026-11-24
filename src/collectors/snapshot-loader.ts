import { nonEmptyStr } from '../core/guards.ts';
import type {
  ActivitySnapshot,
  SessionRecord,
  SiblingSessionHint,
  SnapshotAgent,
  SnapshotCompletedTool,
  SnapshotMcpServer,
  SnapshotResolutionTier,
  SnapshotRunningTool,
} from '../snapshot-types.ts';
import type { ActivityAgentEntry, AgentEntry, StatusLineData } from '../types.ts';
import { shortenTarget } from './activity-parse.ts';
import { loadTodos } from './activity.ts';
import { cleanAgentLabel, collectAgentsSummary } from './agents.ts';
import { readCliSettings } from './settings.ts';
import { formatRelativeAge, formatSurfaceBadge } from './snapshot-envelope.ts';
import { loadSnapshotTranscript, SNAPSHOT_TARGET_DISPLAY_LEN } from './snapshot-transcript.ts';
import { loadSessionTelemetryFromRoot } from './telemetry.ts';

const MAX_RECENT_TARGETS = 6;

export interface LoadActivitySnapshotOptions {
  cacheCliHome: string;
  resolutionTier?: SnapshotResolutionTier;
  siblings?: readonly SiblingSessionHint[];
  nowMs?: number;
}

function mergeSnapshotAgents(
  summaryEntries: readonly AgentEntry[],
  kind: 'swarm' | 'agents',
  hasEnvelopeSubagents: boolean,
  transcriptAgents: readonly ActivityAgentEntry[],
  nowMs: number,
): SnapshotAgent[] {
  const combined: AgentEntry[] = [...summaryEntries];
  if (kind === 'agents' && hasEnvelopeSubagents && transcriptAgents.length > 0) {
    const existingDoneNames = new Set<string>(
      summaryEntries.filter((e) => e.state === 'done').map((e) => e.name.toLowerCase()),
    );
    for (const ta of transcriptAgents) {
      if (ta.running) continue;
      const label = cleanAgentLabel(ta.name, '', ta.type);
      if (existingDoneNames.has(label.toLowerCase())) continue;
      combined.push({ name: label, type: ta.type, model: ta.model, state: 'done', ts: ta.ts });
    }
  }

  return combined.map((entry) => ({
    name: entry.name,
    type: entry.type || 'subagent',
    model: entry.model || 'inherit',
    state: entry.state,
    ts: entry.ts,
    ageLabel:
      entry.ts !== null ? formatRelativeAge(nowMs - entry.ts * 1000) : entry.state === 'done' ? 'recent' : 'live',
  }));
}

function formatSiblingHintLine(siblings: readonly SiblingSessionHint[]): string {
  if (siblings.length === 0) return '';
  const noun = siblings.length === 1 ? 'session' : 'sessions';
  const items = siblings.map((s) => `--session ${s.shortId} ([${formatSurfaceBadge(s.surface)}])`).join(', ');
  return `${siblings.length} other active/recent ${noun} in this workspace: ${items}`;
}

export function loadActivitySnapshot(session: SessionRecord, options: LoadActivitySnapshotOptions): ActivitySnapshot {
  const nowMs = options.nowMs ?? Date.now();
  const siblings = options.siblings ? [...options.siblings] : [];
  const scanned = loadSnapshotTranscript(session, options.cacheCliHome);

  const syntheticData: StatusLineData = {
    conversation_id: session.convId,
    conversation_title: session.title,
    cwd: session.envelope?.cwd || session.workspace || undefined,
    workspace: {
      current_dir: session.envelope?.workspaceCurrentDir || session.workspace || undefined,
      project_dir: session.envelope?.workspaceProjectDir || session.workspace || undefined,
    },
    subagents: session.envelope?.subagents,
    task_count: session.envelope?.taskCount ?? undefined,
  };

  const telemetry = loadSessionTelemetryFromRoot(session.dataRoot, options.cacheCliHome, session.convId, syntheticData);
  const agentsSummary = collectAgentsSummary(session.dataRoot, syntheticData, scanned.agents);
  const todos = loadTodos(session.dataRoot, syntheticData);

  const runningTools: SnapshotRunningTool[] = [];
  const completedMap = new Map<string, { count: number; targets: string[]; isMcp: boolean }>();
  const mcpOrder: string[] = [];
  const mcpSubMap = new Map<string, Map<string, number>>();
  let totalToolCalls = 0;

  for (const call of scanned.tools) {
    if (call.mcpServer !== null && call.mcpSubtool !== null) {
      let subCounts = mcpSubMap.get(call.mcpServer);
      if (!subCounts) {
        mcpOrder.push(call.mcpServer);
        subCounts = new Map<string, number>();
        mcpSubMap.set(call.mcpServer, subCounts);
      }
      subCounts.set(call.mcpSubtool, (subCounts.get(call.mcpSubtool) ?? 0) + 1);
    }

    if (call.isSkillRead) continue;
    totalToolCalls += 1;

    if (call.running) {
      runningTools.push({
        name: call.name,
        disp: call.disp,
        target: call.target,
        fullTarget: call.fullTarget,
        isMcp: call.mcpServer !== null,
      });
    } else {
      const prev = completedMap.get(call.disp) ?? { count: 0, targets: [], isMcp: call.mcpServer !== null };
      prev.count += 1;
      if (call.fullTarget.length > 0) {
        const existingIdx = prev.targets.indexOf(call.fullTarget);
        if (existingIdx !== -1) prev.targets.splice(existingIdx, 1);
        prev.targets.unshift(call.fullTarget);
        if (prev.targets.length > MAX_RECENT_TARGETS) prev.targets.pop();
      }
      completedMap.set(call.disp, prev);
    }
  }

  const completedTools: SnapshotCompletedTool[] = [...completedMap.entries()]
    .map(([disp, info]) => {
      const fullTarget = info.targets[0] ?? '';
      return {
        disp,
        count: info.count,
        latestTarget: fullTarget.length > 0 ? shortenTarget(fullTarget, SNAPSHOT_TARGET_DISPLAY_LEN) : '',
        fullTarget,
        recentTargets: info.targets,
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

  const hasEnvelopeSubagents = (session.envelope?.subagents.length ?? 0) > 0;
  const agents = mergeSnapshotAgents(
    agentsSummary.entries,
    agentsSummary.kind,
    hasEnvelopeSubagents,
    scanned.agents,
    nowMs,
  );

  let model = scanned.lastModel;
  if (model.length === 0 && session.surface === 'cli') {
    model = nonEmptyStr(readCliSettings(session.dataRoot).model) ?? '';
  }

  return {
    convId: session.convId,
    shortId: session.shortId,
    surface: session.surface,
    title: session.title,
    model,
    workspace: session.workspace,
    dataRoot: session.dataRoot,
    resolutionTier: options.resolutionTier ?? 'fallback',
    running: session.running || runningTools.length > 0,
    updatedAtMs: session.updatedAtMs,
    ageLabel: session.ageLabel,
    livePid: session.livePid,
    siblingCandidates: siblings,
    siblingHint: formatSiblingHintLine(siblings),
    telemetry,
    runningTools,
    completedTools,
    totalToolCalls,
    skills: scanned.skills,
    mcps,
    agentsKind: agentsSummary.kind,
    agents,
    todos,
  };
}
