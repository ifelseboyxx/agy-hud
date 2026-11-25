import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { resolveCliSubdirFile, sanitizeSessionId } from '../collectors/safe-path.ts';
import {
  isSupersededEnvelopeWrite,
  isVerifiedClockRollbackWrite,
  readActivePidMarker,
  readSnapshotEnvelope,
  resolveSnapshotLockPlan,
  SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS,
  SNAPSHOT_TTL_MS,
  sweepStaleSnapshotFiles,
  writeSnapshotEnvelope,
  type ActivePidMarker,
} from '../collectors/snapshot-envelope.ts';
import { withFileLocksSync } from '../core/file-lock.ts';
import { nonEmptyStr } from '../core/guards.ts';
import {
  lstatIfPresentSync,
  PRIVATE_FILE_MODE,
  touchRegularFileTimesSync,
  writeBufferAtomicSync,
} from '../fs-utils.ts';
import type { SessionSurface, SnapshotEnvelope } from '../snapshot-types.ts';
import type { AgentsSummary, HudConfig, SessionTelemetry, StatusLineData, TranscriptActivity } from '../types.ts';
import { GRAY, RESET } from './ansi.ts';
import { formatMarkdownTelemetry, renderSnapshotMarkdown } from './osc8-markdown.ts';

export { renderSnapshotMarkdown, type SnapshotMarkdownRenderOptions } from './osc8-markdown.ts';

const ESC = String.fromCharCode(0x1b);
const MAX_OSC8_DATA_BYTES = 4096;

export const ACTIVITY_SUMMARY_SNAPSHOT_TAIL_COLS: number = 11;

export interface SnapshotMarkdownTarget {
  absPath: string;
  uri: string;
}

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
  surface?: SessionSurface;
  nowMs?: number;
}

export interface MaterializeSnapshotMarkdownResult {
  written: boolean;
  mdDigest: string | null;
  sweptCount: number;
  envelope: SnapshotEnvelope | null;
}

export function canEmitOsc8Links(
  config: Pick<HudConfig, 'osc8Links'>,
  convId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!config.osc8Links || convId === null || convId.trim().length === 0) {
    return false;
  }
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  if (env.TERM?.trim().toLowerCase() === 'dumb') {
    return false;
  }
  if (
    nonEmptyStr(env.SSH_CONNECTION) !== undefined ||
    nonEmptyStr(env.SSH_CLIENT) !== undefined ||
    nonEmptyStr(env.SSH_TTY) !== undefined
  ) {
    return false;
  }
  return true;
}

export function resolveSnapshotMarkdownUri(cliHome: string, convId: string): SnapshotMarkdownTarget | null {
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) {
    return null;
  }
  const absPath = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_snapshot_${safeId}.md`);
  if (absPath === null) {
    return null;
  }
  let uri: string;
  try {
    uri = pathToFileURL(absPath).href;
  } catch {
    return null;
  }
  if (!uri.startsWith('file:///') || uri.includes('#') || uri.includes('?')) {
    return null;
  }
  if (Buffer.byteLength(`8;;${uri}`, 'utf8') >= MAX_OSC8_DATA_BYTES) {
    return null;
  }
  return { absPath, uri };
}

export function wrapOsc8Link(text: string, uri: string): string {
  return `${ESC}]8;;${uri}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

export function formatOsc8Overflow(hiddenCount: number, uri: string): string {
  return `${GRAY}${wrapOsc8Link(`+${hiddenCount} more`, uri)}${RESET}`;
}

export function formatActivitySummarySnapshotTail(remainingCols: number, uri: string): string {
  if (remainingCols < ACTIVITY_SUMMARY_SNAPSHOT_TAIL_COLS) {
    return '';
  }
  return ` ${GRAY}· ${wrapOsc8Link('snapshot', uri)}${RESET}`;
}

export function countEmittedOsc8Links(lines: readonly string[], uri: string): number {
  const openSeq = `${ESC}]8;;${uri}${ESC}\\`;
  let count = 0;
  for (const line of lines) {
    let idx = line.indexOf(openSeq);
    while (idx !== -1) {
      count += 1;
      idx = line.indexOf(openSeq, idx + openSeq.length);
    }
  }
  return count;
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
  const act = context.activity;
  const payload = JSON.stringify({
    convId: context.convId ?? '',
    surface: context.surface ?? 'cli',
    title,
    workspace,
    model,
    telLine,
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
  // Gate 1: skip .md materialization unless the current render frame emitted >= 1 OSC 8 link.
  if (target === null || options.emittedOsc8Count < 1) {
    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, {
      nowMs,
      baselineEnvelope: options.existingEnvelope,
      baselinePidMarker: options.baselinePidMarker,
      rejectSuperseded: true,
    });
    return { written: false, mdDigest: prevDigest, sweptCount: 0, envelope };
  }

  // Gate 2: write .md only when missing on disk or rendered content digest changed.
  const mdDigest = computeMarkdownDigest(options.transcriptStat, options.agentsSummary, {
    convId: options.convId,
    surface: options.surface,
    data: options.data,
    activity: options.activity,
    telemetry: options.telemetry,
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
    surface: options.surface,
    nowMs,
  });

  const { lockPaths, holdsPidLock } = lockPlan;

  const publish = (): MaterializeSnapshotMarkdownResult => {
    const currentEnvelope = readSnapshotEnvelope(options.cliHome, options.convId);
    const currentMarker =
      lockPlan.normalizedPid !== null ? readActivePidMarker(options.cliHome, lockPlan.normalizedPid, nowMs) : null;
    const lockedMdStat = lstatQuietSync(target.absPath);
    const hasRegularMd = lockedMdStat !== null && !lockedMdStat.isSymbolicLink() && lockedMdStat.isFile();
    const superseded =
      currentEnvelope !== null &&
      isSupersededEnvelopeWrite(currentEnvelope, nowMs, options.existingEnvelope) &&
      !isVerifiedClockRollbackWrite(
        currentEnvelope,
        currentMarker,
        options.convId,
        nowMs,
        options.existingEnvelope,
        options.baselinePidMarker,
      );
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
        baselineEnvelope: options.existingEnvelope,
        baselinePidMarker: options.baselinePidMarker,
        rejectSuperseded: true,
      });
      return { written: false, mdDigest: prevDigest, sweptCount, envelope };
    }

    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, {
      nowMs,
      mdDigest,
      skipPidLock: holdsPidLock,
      skipSnapshotLock: true,
      baselineEnvelope: options.existingEnvelope,
      baselinePidMarker: options.baselinePidMarker,
      rejectSuperseded: true,
    });
    return { written: envelope !== null, mdDigest: envelope?.mdDigest ?? prevDigest, sweptCount, envelope };
  };

  try {
    return withFileLocksSync(lockPaths, publish, SNAPSHOT_HOT_PATH_LOCK_TIMEOUT_MS);
  } catch {
    return { written: false, mdDigest: prevDigest, sweptCount: 0, envelope: options.existingEnvelope };
  }
}
