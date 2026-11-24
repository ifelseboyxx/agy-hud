import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolveCliSubdirFile, sanitizeSessionId } from '../collectors/safe-path.ts';
import { sweepStaleSnapshotFiles, writeSnapshotEnvelope } from '../collectors/snapshot-envelope.ts';
import { nonEmptyStr } from '../core/guards.ts';
import { writeBufferAtomicSync } from '../fs-utils.ts';
import type { SnapshotEnvelope } from '../snapshot-types.ts';
import type { AgentsSummary, HudConfig, SessionTelemetry, StatusLineData, TranscriptActivity } from '../types.ts';
import { GRAY, RESET } from './ansi.ts';
import { renderSnapshotMarkdown } from './osc8-markdown.ts';

export { renderSnapshotMarkdown, type SnapshotMarkdownRenderOptions } from './osc8-markdown.ts';

const ESC = String.fromCharCode(0x1b);
const MAX_OSC8_DATA_BYTES = 4096;
const SNAPSHOT_MD_MODE = 0o600;

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

export interface MaterializeSnapshotMarkdownOptions {
  cliHome: string;
  convId: string;
  target: SnapshotMarkdownTarget | null;
  emittedOsc8Count: number;
  data: StatusLineData;
  agyPid: number | null;
  existingEnvelope: SnapshotEnvelope | null;
  transcriptStat: TranscriptStatFingerprint | null;
  activity: TranscriptActivity | null;
  agentsSummary: AgentsSummary | null;
  telemetry?: SessionTelemetry | null;
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

export function computeMarkdownDigest(
  transcriptStat: TranscriptStatFingerprint | null | undefined,
  agentsSummary: AgentsSummary | null | undefined,
): string {
  const ino = transcriptStat ? transcriptStat.ino : 0;
  const mtimeMs = transcriptStat ? transcriptStat.mtimeMs : 0;
  const size = transcriptStat ? transcriptStat.size : 0;
  return `${ino}:${mtimeMs}:${size}:${computeAgentsDigest(agentsSummary)}`;
}

export function materializeSnapshotMarkdownIfNeeded(
  options: MaterializeSnapshotMarkdownOptions,
): MaterializeSnapshotMarkdownResult {
  const nowMs = options.nowMs ?? Date.now();
  const prevDigest = options.existingEnvelope?.mdDigest ?? null;

  // Gate 1: skip .md materialization unless the current render frame emitted >= 1 OSC 8 link.
  if (options.target === null || options.emittedOsc8Count < 1) {
    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, { nowMs });
    return { written: false, mdDigest: prevDigest, sweptCount: 0, envelope };
  }

  // Gate 2: write .md only when missing on disk or activity digest changed.
  const mdDigest = computeMarkdownDigest(options.transcriptStat, options.agentsSummary);
  if (existsSync(options.target.absPath) && prevDigest === mdDigest) {
    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, { nowMs });
    return { written: false, mdDigest, sweptCount: 0, envelope };
  }

  const markdown = renderSnapshotMarkdown({
    convId: options.convId,
    data: options.data,
    activity: options.activity,
    agentsSummary: options.agentsSummary,
    telemetry: options.telemetry,
    nowMs,
  });

  const sweptCount = sweepStaleSnapshotFiles(options.cliHome, nowMs);
  try {
    writeBufferAtomicSync(options.target.absPath, markdown, SNAPSHOT_MD_MODE);
  } catch {
    const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, { nowMs });
    return { written: false, mdDigest: prevDigest, sweptCount, envelope };
  }

  const envelope = writeSnapshotEnvelope(options.cliHome, options.data, options.agyPid, { nowMs, mdDigest });
  return { written: true, mdDigest, sweptCount, envelope };
}
