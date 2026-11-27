import { nonEmptyStr } from '../core/guards.ts';
import { resolveSnapshotQuotaBuckets } from '../core/quota-pace.ts';
import { resolveTurnPhase } from '../core/telemetry-error.ts';
import type { ActivitySnapshot, SessionRecord, SiblingSessionHint, SnapshotResolutionTier } from '../snapshot-types.ts';
import type { StatusLineData } from '../types.ts';
import { aggregateActivityTools, mergeActivityAgents } from './activity-aggregate.ts';
import { loadTodos } from './activity.ts';
import { collectAgentsSummary } from './agents.ts';
import { readCliFallbackModel, readCliSettings } from './settings.ts';
import { isExitedCliSession } from './snapshot-envelope.ts';
import { loadSnapshotTranscript, SNAPSHOT_TARGET_DISPLAY_LEN } from './snapshot-transcript.ts';
import { attachSubagentTelemetryRollups } from './subagent-rollup.ts';
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
  const items = siblings.map((s) => `--session ${s.shortId}`).join(', ');
  return `${siblings.length} other active/recent ${noun} in this workspace: ${items}`;
}

export function loadActivitySnapshot(session: SessionRecord, options: LoadActivitySnapshotOptions): ActivitySnapshot {
  const nowMs = options.nowMs ?? Date.now();
  const siblings = options.siblings ? [...options.siblings] : [];
  const scanned = loadSnapshotTranscript(session, options.cacheCliHome);

  const cliSettings = readCliSettings(session.dataRoot);
  const fallbackCliModel = readCliFallbackModel(session.dataRoot);
  const hostModelDisplay =
    nonEmptyStr(session.envelope?.modelDisplayName) ?? nonEmptyStr(scanned.lastModel) ?? nonEmptyStr(fallbackCliModel);
  const envWinSize = session.envelope?.nominalContextWindowSize;
  const envUsedPct = session.envelope?.stdinContextUsedPct;
  const syntheticData: StatusLineData = {
    conversation_id: session.convId,
    conversation_title: session.title,
    ...(hostModelDisplay !== undefined ? { model: { display_name: hostModelDisplay } } : {}),
    ...(envWinSize != null || envUsedPct != null
      ? {
          context_window: {
            ...(envWinSize != null ? { context_window_size: envWinSize } : {}),
            ...(envUsedPct != null ? { used_percentage: envUsedPct } : {}),
          },
        }
      : {}),
    cwd: nonEmptyStr(session.envelope?.cwd) ?? nonEmptyStr(session.workspace),
    workspace: {
      current_dir: nonEmptyStr(session.envelope?.workspaceCurrentDir) ?? nonEmptyStr(session.workspace),
      project_dir: nonEmptyStr(session.envelope?.workspaceProjectDir) ?? nonEmptyStr(session.workspace),
    },
    subagents: session.envelope?.subagents,
    task_count: session.envelope?.taskCount ?? undefined,
  };

  const telemetry = loadSessionTelemetryFromRoot(
    session.dataRoot,
    options.cacheCliHome,
    session.convId,
    syntheticData,
    cliSettings,
  );
  const agentsSummary = collectAgentsSummary(session.dataRoot, syntheticData, scanned.agents);
  const todos = loadTodos(session.dataRoot, syntheticData);

  const aggregatedTools = aggregateActivityTools(scanned.tools, {
    targetDisplayLen: SNAPSHOT_TARGET_DISPLAY_LEN,
    hideSkillReads: true,
  });
  const mergedAgents = mergeActivityAgents(agentsSummary, scanned.agents, nowMs);
  const subagentResult = attachSubagentTelemetryRollups({
    parentConvId: session.convId,
    dataRoot: session.dataRoot,
    cacheCliHome: options.cacheCliHome,
    agents: mergedAgents.entries,
  });

  let model = scanned.lastModel;
  if (model.length === 0 && telemetry.lastModelName) {
    model = telemetry.lastModelName;
  }
  if (model.length === 0 && session.envelope?.modelDisplayName) {
    model = session.envelope.modelDisplayName;
  }
  if (model.length === 0) {
    model = fallbackCliModel;
  }

  const isExitedCli = isExitedCliSession(session);
  const quotaBuckets = resolveSnapshotQuotaBuckets(session.envelope?.quota, nowMs / 1000);
  const turnPhase = resolveTurnPhase({
    isExitedCli,
    hasLiveHostState: session.livePid !== null && session.envelope !== null,
    toolConfirmationPending: session.envelope?.toolConfirmationPending,
    agentState: session.envelope?.agentState,
    tailStepPhase: telemetry.tailStepPhase,
    lastErrorCode: telemetry.lastErrorCode,
  });

  return {
    convId: session.convId,
    shortId: session.shortId,
    title: session.title,
    model,
    workspace: session.workspace,
    dataRoot: session.dataRoot,
    resolutionTier: options.resolutionTier ?? 'fallback',
    running: isExitedCli ? false : session.running || aggregatedTools.runningTools.length > 0,
    updatedAtMs: session.updatedAtMs,
    ageLabel: session.ageLabel,
    livePid: session.livePid,
    turnPhase,
    siblingCandidates: siblings,
    siblingHint: formatSiblingHintLine(siblings),
    telemetry,
    nominalContextWindowSize: session.envelope?.nominalContextWindowSize ?? null,
    cost: session.envelope?.cost ?? null,
    quota: quotaBuckets.length > 0 ? quotaBuckets : null,
    runningTools: aggregatedTools.runningTools,
    completedTools: aggregatedTools.completedTools,
    totalToolCalls: aggregatedTools.totalToolCalls,
    skills: scanned.skills,
    mcps: aggregatedTools.mcps,
    agentsKind: mergedAgents.kind,
    agents: subagentResult.agents,
    subagentRollup: subagentResult.rollup,
    todos,
  };
}
