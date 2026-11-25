import { nonEmptyStr } from '../core/guards.ts';
import type { ActivitySnapshot, SessionRecord, SiblingSessionHint, SnapshotResolutionTier } from '../snapshot-types.ts';
import type { StatusLineData } from '../types.ts';
import { aggregateActivityTools, mergeActivityAgents } from './activity-aggregate.ts';
import { loadTodos } from './activity.ts';
import { collectAgentsSummary } from './agents.ts';
import { readCliFallbackModel } from './settings.ts';
import { formatSurfaceBadge, isExitedCliSession } from './snapshot-envelope.ts';
import { loadSnapshotTranscript, SNAPSHOT_TARGET_DISPLAY_LEN } from './snapshot-transcript.ts';
import { loadSessionTelemetryFromRoot } from './telemetry.ts';

export interface LoadActivitySnapshotOptions {
  cacheCliHome: string;
  resolutionTier?: SnapshotResolutionTier;
  siblings?: readonly SiblingSessionHint[];
  nowMs?: number;
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
    cwd: nonEmptyStr(session.envelope?.cwd) ?? nonEmptyStr(session.workspace),
    workspace: {
      current_dir: nonEmptyStr(session.envelope?.workspaceCurrentDir) ?? nonEmptyStr(session.workspace),
      project_dir: nonEmptyStr(session.envelope?.workspaceProjectDir) ?? nonEmptyStr(session.workspace),
    },
    subagents: session.envelope?.subagents,
    task_count: session.envelope?.taskCount ?? undefined,
  };

  const telemetry = loadSessionTelemetryFromRoot(session.dataRoot, options.cacheCliHome, session.convId, syntheticData);
  const agentsSummary = collectAgentsSummary(session.dataRoot, syntheticData, scanned.agents);
  const todos = loadTodos(session.dataRoot, syntheticData);

  const aggregatedTools = aggregateActivityTools(scanned.tools, {
    targetDisplayLen: SNAPSHOT_TARGET_DISPLAY_LEN,
    hideSkillReads: true,
  });
  const mergedAgents = mergeActivityAgents(agentsSummary, scanned.agents, nowMs);

  let model = scanned.lastModel;
  if (model.length === 0 && session.surface === 'cli') {
    model = readCliFallbackModel(session.dataRoot);
  }

  const isExitedCli = isExitedCliSession(session);

  return {
    convId: session.convId,
    shortId: session.shortId,
    surface: session.surface,
    title: session.title,
    model,
    workspace: session.workspace,
    dataRoot: session.dataRoot,
    resolutionTier: options.resolutionTier ?? 'fallback',
    running: isExitedCli ? false : session.running || aggregatedTools.runningTools.length > 0,
    updatedAtMs: session.updatedAtMs,
    ageLabel: session.ageLabel,
    livePid: session.livePid,
    siblingCandidates: siblings,
    siblingHint: formatSiblingHintLine(siblings),
    telemetry,
    runningTools: aggregatedTools.runningTools,
    completedTools: aggregatedTools.completedTools,
    totalToolCalls: aggregatedTools.totalToolCalls,
    skills: scanned.skills,
    mcps: aggregatedTools.mcps,
    agentsKind: mergedAgents.kind,
    agents: mergedAgents.entries,
    todos,
  };
}
