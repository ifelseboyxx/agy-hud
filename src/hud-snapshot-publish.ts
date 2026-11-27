/* @host-contract
 * Two-gate OSC 8 Markdown materialization and CLI session envelope publication (docs/host-contracts.md §4):
 * - Gate 1: skip .md file creation unless the rendered HUD frame emitted >= 1 OSC 8 hyperlink.
 * - Gate 2: rewrite .md only when missing on disk or when rendered digest (transcript stat + agents + fields) changes.
 * - Acquires sorted snapshot + PID locks with a 30ms non-stalling hot-path timeout and rejects superseded frames.
 */
import { createHash } from 'node:crypto';

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
import { withFileLocksSync } from './core/file-lock.ts';
import { nonEmptyStr } from './core/guards.ts';
import { lstatIfPresentSync, PRIVATE_FILE_MODE, touchRegularFileTimesSync, writeBufferAtomicSync } from './fs-utils.ts';
import { formatMarkdownCost, formatMarkdownTelemetry, renderSnapshotMarkdown } from './render/osc8-markdown.ts';
import type { SnapshotMarkdownTarget } from './render/osc8.ts';
import type { SessionSurface, SnapshotEnvelope } from './snapshot-types.ts';
import type { AgentsSummary, HudCostCurrency, SessionTelemetry, StatusLineData, TranscriptActivity } from './types.ts';

export interface TranscriptStatFingerprint {
  ino: number;
  mtimeMs: number;
  size: number;
}

export interface MarkdownDigestContext {
  convId?: string;
  surface?: SessionSurface;
  data?: StatusLineData;
  activity?: TranscriptActivity | null;
  telemetry?: SessionTelemetry | null;
  costCurrency?: HudCostCurrency;
  usdToCnyRate?: number;
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
  surface?: SessionSurface;
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

function computeRenderedFieldsDigest(context: MarkdownDigestContext): string {
  const data = context.data;
  const title = nonEmptyStr(data?.conversation_title) ?? '';
  const workspace =
    nonEmptyStr(data?.workspace?.current_dir) ??
    nonEmptyStr(data?.workspace?.project_dir) ??
    nonEmptyStr(data?.cwd) ??
    '';
  const model = nonEmptyStr(data?.model?.display_name) ?? nonEmptyStr(data?.model?.id) ?? '';
  const telLine = formatMarkdownTelemetry(context.telemetry);
  const costLine = formatMarkdownCost(data, context.costCurrency, context.usdToCnyRate);
  const act = context.activity;
  const payload = JSON.stringify({
    convId: context.convId ?? '',
    surface: context.surface ?? 'cli',
    title,
    workspace,
    model,
    telLine,
    costLine,
    activity: act
      ? {
          tools: act.tools.map((t) => [t.name, t.disp, t.target, t.fullTarget ?? '', t.running, t.isSkillRead]),
          skills: act.skills,
          mcps: act.mcps,
          agents: act.agents.map((a) => [a.name, a.type, a.model, a.running, a.ts]),
        }
      : null,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function computeMarkdownDigest(
  transcriptStat: TranscriptStatFingerprint | null | undefined,
  agentsSummary: AgentsSummary | null | undefined,
  context?: MarkdownDigestContext,
): string {
  const ino = transcriptStat ? transcriptStat.ino : 0;
  const mtimeMs = transcriptStat ? transcriptStat.mtimeMs : 0;
  const size = transcriptStat ? transcriptStat.size : 0;
  const base = `${ino}:${mtimeMs}:${size}:${computeAgentsDigest(agentsSummary)}`;
  if (context === undefined) {
    return base;
  }
  return `${base}:${computeRenderedFieldsDigest(context)}`;
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

  const mdDigest = computeMarkdownDigest(options.transcriptStat, options.agentsSummary, {
    convId: options.convId,
    surface: options.surface,
    data: options.data,
    activity: options.activity,
    telemetry: options.telemetry,
    costCurrency: options.costCurrency,
    usdToCnyRate: options.usdToCnyRate,
  });
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

  const markdown = renderSnapshotMarkdown({
    convId: options.convId,
    data: options.data,
    activity: options.activity,
    agentsSummary: options.agentsSummary,
    telemetry: options.telemetry,
    costCurrency: options.costCurrency,
    usdToCnyRate: options.usdToCnyRate,
    surface: options.surface,
    nowMs,
  });

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

    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, {
      nowMs,
      mdDigest,
      skipPidLock: holdsPidLock,
      skipSnapshotLock: true,
      ...supersedeOpts,
    });
    return { written: envelope !== null, mdDigest: envelope?.mdDigest ?? prevDigest, sweptCount, envelope };
  };

  try {
    return withFileLocksSync(lockPaths, publish, SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS);
  } catch {
    return { written: false, mdDigest: prevDigest, sweptCount: 0, envelope: options.existingEnvelope };
  }
}
