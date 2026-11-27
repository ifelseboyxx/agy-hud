/* @host-contract
 * Two-gate OSC 8 Markdown materialization and CLI session envelope publication (docs/host-contracts.md §4):
 * - Gate 1: skip .md file creation unless the rendered HUD frame emitted >= 1 OSC 8 hyperlink.
 * - Gate 2: rewrite .md only when missing on disk or when rendered digest (transcript stat + agents + rendered body) changes.
 * - Acquires sorted snapshot + PID locks with a 30ms non-stalling hot-path timeout and rejects superseded frames.
 */
import { createHash } from 'node:crypto';

import { aggregateActivityTools, mergeActivityAgents } from './collectors/activity-aggregate.ts';
import {
  isEnvelopeWriteSuperseded,
  readActivePidMarker,
  readSnapshotEnvelope,
  resolveSnapshotLockPlan,
  SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS,
  SNAPSHOT_TTL_MS,
  sweepStaleSnapshotFiles,
  writeSnapshotEnvelope,
  type ActivePidMarker,
} from './collectors/snapshot-envelope.ts';
import { attachSubagentTelemetryRollups } from './collectors/subagent-rollup.ts';
import { withFileLocksSync } from './core/file-lock.ts';
import { nonEmptyStr } from './core/guards.ts';
import {
  captureEntrySnapshotSync,
  createWorkspaceRegularFileChecker,
  lstatIfPresentSync,
  PRIVATE_FILE_MODE,
  restoreEntrySnapshotSync,
  touchRegularFileTimesSync,
  writeBufferAtomicSync,
} from './fs-utils.ts';
import { resolveMarkdownFileTargetLink } from './render/file-link.ts';
import { renderSnapshotMarkdownWithDigest } from './render/osc8-markdown.ts';
import type { SnapshotMarkdownTarget } from './render/osc8.ts';
import type { SnapshotAgent, SnapshotEnvelope, SubagentAggregateRollup } from './snapshot-types.ts';
import type { AgentsSummary, HudCostCurrency, SessionTelemetry, StatusLineData, TranscriptActivity } from './types.ts';

export interface TranscriptStatFingerprint {
  ino: number;
  mtimeMs: number;
  size: number;
}

export interface MarkdownDigestContext {
  convId?: string;
  data?: StatusLineData;
  activity?: TranscriptActivity | null;
  telemetry?: SessionTelemetry | null;
  snapshotAgents?: readonly SnapshotAgent[];
  subagentRollup?: SubagentAggregateRollup | null;
  resolvedFileLinks?: ReadonlyMap<string, string>;
  costCurrency?: HudCostCurrency;
  usdToCnyRate?: number;
  nowMs?: number;
}

export interface MaterializeSnapshotMarkdownOptions {
  cliHome: string;
  convId: string;
  target: SnapshotMarkdownTarget | null;
  emittedOsc8Count: number;
  data: StatusLineData;
  agyPid: number | null;
  existingEnvelope: SnapshotEnvelope | null;
  baselinePidMarker?: ActivePidMarker | null;
  transcriptStat: TranscriptStatFingerprint | null;
  activity: TranscriptActivity | null;
  agentsSummary: AgentsSummary | null;
  telemetry?: SessionTelemetry | null;
  costCurrency?: HudCostCurrency;
  usdToCnyRate?: number;
  nowMs?: number;
}

export interface MaterializeSnapshotMarkdownResult {
  written: boolean;
  mdDigest: string | null;
  sweptCount: number;
  envelope: SnapshotEnvelope | null;
}

function computeAgentsDigest(agentsSummary: AgentsSummary | null | undefined): string {
  if (!agentsSummary || agentsSummary.entries.length === 0) {
    return 'none';
  }
  const payload = [
    `${agentsSummary.kind}|${agentsSummary.working}|${agentsSummary.waiting}|${agentsSummary.alive}|${agentsSummary.total}`,
    ...agentsSummary.entries.map(
      (entry) => `${entry.name}\0${entry.type}\0${entry.model}\0${entry.state}\0${entry.ts ?? ''}`,
    ),
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function formatBaseDigest(
  transcriptStat: TranscriptStatFingerprint | null | undefined,
  agentsSummary: AgentsSummary | null | undefined,
): string {
  const ino = transcriptStat ? transcriptStat.ino : 0;
  const mtimeMs = transcriptStat ? transcriptStat.mtimeMs : 0;
  const size = transcriptStat ? transcriptStat.size : 0;
  return `${ino}:${mtimeMs}:${size}:${computeAgentsDigest(agentsSummary)}`;
}

function resolveSnapshotFileLinks(
  activity: TranscriptActivity | null | undefined,
  data: StatusLineData | undefined,
): ReadonlyMap<string, string> {
  const links = new Map<string, string>();
  const workspace =
    nonEmptyStr(data?.workspace?.current_dir) ?? nonEmptyStr(data?.workspace?.project_dir) ?? nonEmptyStr(data?.cwd);
  if (workspace === undefined || !activity || activity.tools.length === 0) {
    return links;
  }
  const aggregated = aggregateActivityTools(activity.tools, {
    knownMcpServers: activity.mcps,
    hideSkillReads: activity.skills.length > 0,
  });
  const candidates = new Set<string>();
  for (const rt of aggregated.runningTools) {
    if (rt.targetLinkable === false) continue;
    const raw = nonEmptyStr(rt.fullTarget) ?? rt.target;
    if (raw.length > 0) candidates.add(raw);
  }
  for (const ct of aggregated.completedTools) {
    const latest = ct.fullTarget.length > 0 ? ct.fullTarget : ct.latestTarget;
    if (latest.length > 0 && ct.unlinkedTargets?.includes(latest) !== true) {
      candidates.add(latest);
    }
  }
  if (candidates.size === 0) {
    return links;
  }
  const checker = createWorkspaceRegularFileChecker(workspace);
  for (const rawTarget of candidates) {
    const uri = resolveMarkdownFileTargetLink(rawTarget, workspace, checker);
    if (uri !== null) {
      links.set(rawTarget, uri);
    }
  }
  return links;
}

export function computeMarkdownDigest(
  transcriptStat: TranscriptStatFingerprint | null | undefined,
  agentsSummary: AgentsSummary | null | undefined,
  context?: MarkdownDigestContext,
): string {
  const base = formatBaseDigest(transcriptStat, agentsSummary);
  if (context === undefined) {
    return base;
  }
  const { contentDigest } = renderSnapshotMarkdownWithDigest({
    convId: context.convId ?? '',
    data: context.data ?? {},
    activity: context.activity ?? null,
    agentsSummary: agentsSummary ?? null,
    telemetry: context.telemetry,
    snapshotAgents: context.snapshotAgents,
    subagentRollup: context.subagentRollup,
    resolvedFileLinks: context.resolvedFileLinks ?? resolveSnapshotFileLinks(context.activity, context.data),
    costCurrency: context.costCurrency,
    usdToCnyRate: context.usdToCnyRate,
    nowMs: context.nowMs,
  });
  return `${base}:${contentDigest}`;
}

function lstatQuietSync(filePath: string): ReturnType<typeof lstatIfPresentSync> {
  try {
    return lstatIfPresentSync(filePath);
  } catch {
    return null;
  }
}

export function materializeSnapshotMarkdownIfNeeded(
  options: MaterializeSnapshotMarkdownOptions,
): MaterializeSnapshotMarkdownResult {
  const nowMs = options.nowMs ?? Date.now();
  const prevDigest = options.existingEnvelope?.mdDigest ?? null;
  const target = options.target;

  if (target === null || options.emittedOsc8Count < 1) {
    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, {
      nowMs,
      baselineEnvelope: options.existingEnvelope,
      baselinePidMarker: options.baselinePidMarker,
      rejectSuperseded: true,
    });
    return { written: false, mdDigest: prevDigest, sweptCount: 0, envelope };
  }

  // Cache-only subagent rollup on statusLine hot path (maxColdDbReads: 0 -> strictly 0 child SQLite DB opens).
  let snapshotAgents: SnapshotAgent[] | undefined;
  let subagentRollup: SubagentAggregateRollup | null = null;
  const mergedForRollup = mergeActivityAgents(options.agentsSummary, options.activity?.agents ?? [], nowMs);
  if (mergedForRollup.entries.length > 0) {
    const cachedRollup = attachSubagentTelemetryRollups({
      parentConvId: options.convId,
      dataRoot: options.cliHome,
      cacheCliHome: options.cliHome,
      agents: mergedForRollup.entries,
      maxColdDbReads: 0,
    });
    if (cachedRollup.rollup !== null) {
      snapshotAgents = cachedRollup.agents;
      subagentRollup = cachedRollup.rollup;
    }
  }

  const resolvedFileLinks = resolveSnapshotFileLinks(options.activity, options.data);
  const { markdown, contentDigest } = renderSnapshotMarkdownWithDigest({
    convId: options.convId,
    data: options.data,
    activity: options.activity,
    agentsSummary: options.agentsSummary,
    telemetry: options.telemetry,
    snapshotAgents,
    subagentRollup,
    resolvedFileLinks,
    costCurrency: options.costCurrency,
    usdToCnyRate: options.usdToCnyRate,
    nowMs,
  });
  const mdDigest = `${formatBaseDigest(options.transcriptStat, options.agentsSummary)}:${contentDigest}`;

  const existingMdStat = lstatQuietSync(target.absPath);
  if (
    existingMdStat !== null &&
    !existingMdStat.isSymbolicLink() &&
    existingMdStat.isFile() &&
    prevDigest === mdDigest
  ) {
    if (nowMs - existingMdStat.mtimeMs >= SNAPSHOT_TTL_MS / 2) {
      touchRegularFileTimesSync(target.absPath, nowMs);
    }
    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, {
      nowMs,
      baselineEnvelope: options.existingEnvelope,
      baselinePidMarker: options.baselinePidMarker,
      rejectSuperseded: true,
    });
    return { written: false, mdDigest, sweptCount: 0, envelope };
  }

  const lockPlan = resolveSnapshotLockPlan(options.cliHome, options.convId, options.agyPid);
  if (lockPlan === null) {
    return { written: false, mdDigest: prevDigest, sweptCount: 0, envelope: options.existingEnvelope };
  }

  const { lockPaths, holdsPidLock } = lockPlan;
  const supersedeOpts = {
    rejectSuperseded: true,
    baselineEnvelope: options.existingEnvelope,
    baselinePidMarker: options.baselinePidMarker,
  } as const;

  const publish = (): MaterializeSnapshotMarkdownResult => {
    const currentEnvelope = readSnapshotEnvelope(options.cliHome, options.convId);
    const currentMarker =
      lockPlan.normalizedPid !== null ? readActivePidMarker(options.cliHome, lockPlan.normalizedPid, nowMs) : null;
    const lockedMdStat = lstatQuietSync(target.absPath);
    const hasRegularMd = lockedMdStat !== null && !lockedMdStat.isSymbolicLink() && lockedMdStat.isFile();
    const superseded = isEnvelopeWriteSuperseded(currentEnvelope, currentMarker, options.convId, nowMs, supersedeOpts);
    if (currentEnvelope !== null && ((currentEnvelope.mdDigest === mdDigest && hasRegularMd) || superseded)) {
      return { written: false, mdDigest: currentEnvelope.mdDigest, sweptCount: 0, envelope: currentEnvelope };
    }

    const sweptCount = sweepStaleSnapshotFiles(options.cliHome, nowMs, options.convId);
    const origMdSnap = captureEntrySnapshotSync(target.absPath);
    try {
      writeBufferAtomicSync(target.absPath, markdown, PRIVATE_FILE_MODE);
    } catch {
      const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, {
        nowMs,
        skipPidLock: holdsPidLock,
        skipSnapshotLock: true,
        ...supersedeOpts,
      });
      return { written: false, mdDigest: prevDigest, sweptCount, envelope };
    }

    let envelope: SnapshotEnvelope | null = null;
    try {
      envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, {
        nowMs,
        mdDigest,
        skipPidLock: holdsPidLock,
        skipSnapshotLock: true,
        ...supersedeOpts,
      });
    } catch {
      envelope = null;
    }
    if (envelope === null) {
      // Keep on-disk .md synchronized with envelope.mdDigest if envelope persistence failed.
      try {
        restoreEntrySnapshotSync(origMdSnap);
      } catch {
        // Best-effort rollback on hot path.
      }
      return { written: false, mdDigest: prevDigest, sweptCount, envelope: null };
    }
    return { written: true, mdDigest: envelope.mdDigest, sweptCount, envelope };
  };

  try {
    return withFileLocksSync(lockPaths, publish, SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS);
  } catch {
    return { written: false, mdDigest: prevDigest, sweptCount: 0, envelope: options.existingEnvelope };
  }
}
