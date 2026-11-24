import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { isFiniteNum, isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { lstatIfPresentSync, readJsonObjectSync, writeJsonAtomicSync } from '../fs-utils.ts';
import type { SessionSurface, SnapshotEnvelope } from '../snapshot-types.ts';
import type { StatusLineData, SubagentStdinItem } from '../types.ts';
import { resolveCliSubdirFile, resolveConversationId, resolveTrustedCliDir, sanitizeSessionId } from './safe-path.ts';

const ENVELOPE_VERSION = 1;
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_CACHE_FILE_RE = /^agy_hud_snapshot_.+\.(?:json|md)$/;

export interface WriteSnapshotEnvelopeOptions {
  mdDigest?: string | null;
  nowMs?: number;
}

export function formatRelativeAge(deltaMs: number): string {
  const sec = Math.max(0, Math.floor(deltaMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatSurfaceBadge(surface: SessionSurface): string {
  if (surface === 'cli') return 'CLI';
  if (surface === 'ide') return 'IDE';
  return 'App';
}

function parseEnvelopeSubagents(raw: unknown): SubagentStdinItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SubagentStdinItem[] = [];
  for (const item of raw) {
    if (isPlainObject(item)) {
      items.push(item as SubagentStdinItem);
    }
  }
  return items;
}

export function parseEnvelopeRecord(raw: Record<string, unknown>): SnapshotEnvelope | null {
  if (raw.v !== ENVELOPE_VERSION) return null;
  const convId = typeof raw.convId === 'string' ? sanitizeSessionId(raw.convId) : null;
  if (convId === null) return null;
  const agyPid = raw.agyPid === null ? null : isFiniteNum(raw.agyPid) && raw.agyPid > 1 ? Math.trunc(raw.agyPid) : null;
  const taskCount =
    raw.taskCount === null
      ? null
      : isFiniteNum(raw.taskCount) && Number.isInteger(raw.taskCount) && raw.taskCount >= 0
        ? raw.taskCount
        : null;
  const mdDigest = typeof raw.mdDigest === 'string' ? raw.mdDigest : null;
  const updatedAtMs = isFiniteNum(raw.updatedAtMs) ? raw.updatedAtMs : 0;

  return {
    v: ENVELOPE_VERSION,
    convId,
    conversationTitle: typeof raw.conversationTitle === 'string' ? raw.conversationTitle : '',
    agyPid,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    workspaceCurrentDir: typeof raw.workspaceCurrentDir === 'string' ? raw.workspaceCurrentDir : '',
    workspaceProjectDir: typeof raw.workspaceProjectDir === 'string' ? raw.workspaceProjectDir : '',
    subagents: parseEnvelopeSubagents(raw.subagents),
    taskCount,
    mdDigest,
    updatedAtMs,
  };
}

export function readSnapshotEnvelope(cliHome: string, convId: string): SnapshotEnvelope | null {
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) return null;
  const filePath = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_snapshot_${safeId}.json`);
  if (filePath === null) return null;
  const raw = readJsonObjectSync(filePath, false);
  return raw !== null ? parseEnvelopeRecord(raw) : null;
}

export function sweepStaleSnapshotFiles(cliHome: string, nowMs: number = Date.now()): number {
  const cacheDir = resolveTrustedCliDir(cliHome, 'cache');
  if (cacheDir === null) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return 0;
  }
  const cutoff = nowMs - SNAPSHOT_TTL_MS;
  for (const name of entries) {
    if (!SNAPSHOT_CACHE_FILE_RE.test(name)) continue;
    const fullPath = path.join(cacheDir, name);
    const st = lstatIfPresentSync(fullPath);
    if (st === null || st.isSymbolicLink() || !st.isFile()) continue;
    if (st.mtimeMs < cutoff) {
      try {
        rmSync(fullPath, { force: true });
        removed += 1;
      } catch {
        // Ignore best-effort TTL sweep errors.
      }
    }
  }
  return removed;
}

export function writeSnapshotEnvelope(
  cliHome: string,
  data: StatusLineData,
  agyPid: number | null,
  options: WriteSnapshotEnvelopeOptions = {},
): SnapshotEnvelope | null {
  const convId = resolveConversationId(data);
  if (convId === null) return null;
  const filePath = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_snapshot_${convId}.json`);
  if (filePath === null) return null;

  const existing = readSnapshotEnvelope(cliHome, convId);
  const nowMs = options.nowMs ?? Date.now();
  const normalizedPid = agyPid !== null && Number.isInteger(agyPid) && agyPid > 1 ? agyPid : null;
  const taskCount =
    typeof data.task_count === 'number' && Number.isInteger(data.task_count) && data.task_count >= 0
      ? data.task_count
      : null;

  const envelope: SnapshotEnvelope = {
    v: ENVELOPE_VERSION,
    convId,
    conversationTitle: nonEmptyStr(data.conversation_title) ?? '',
    agyPid: normalizedPid,
    cwd: nonEmptyStr(data.cwd) ?? '',
    workspaceCurrentDir: nonEmptyStr(data.workspace?.current_dir) ?? '',
    workspaceProjectDir: nonEmptyStr(data.workspace?.project_dir) ?? '',
    subagents: parseEnvelopeSubagents(data.subagents),
    taskCount,
    mdDigest: options.mdDigest !== undefined ? options.mdDigest : (existing?.mdDigest ?? null),
    updatedAtMs: nowMs,
  };

  try {
    writeJsonAtomicSync(filePath, envelope);
    if (existing === null) {
      sweepStaleSnapshotFiles(cliHome, nowMs);
    }
    return envelope;
  } catch {
    return null;
  }
}
