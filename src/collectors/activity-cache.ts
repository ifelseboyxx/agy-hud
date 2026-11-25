import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import { PRIVATE_FILE_MODE, readRegularJsonObjectSync, writeBufferAtomicSync } from '../fs-utils.ts';
import type { ActivityAgentEntry, CompletedToolAggregate, TranscriptActivity, TranscriptToolEntry } from '../types.ts';
import { parseTranscriptCacheMeta, type TranscriptCacheMeta } from './transcript-scanner.ts';

export const ACTIVITY_CACHE_SCHEMA_VERSION: number = 5;
export const MAX_ACTIVITY_CACHE_BYTES: number = 16 * 1024 * 1024;

export interface ActivityCacheRecord extends TranscriptCacheMeta {
  v: number;
  data: TranscriptActivity;
}

export function parseSanitizedStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const clean = sanitizeTerminalLabel(item);
    if (clean.length > 0) {
      items.push(clean);
    }
  }
  return items;
}

function isTranscriptToolEntry(value: unknown): value is TranscriptToolEntry {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    typeof value.disp === 'string' &&
    typeof value.target === 'string' &&
    (value.fullTarget === undefined || typeof value.fullTarget === 'string') &&
    typeof value.running === 'boolean' &&
    typeof value.isSkillRead === 'boolean'
  );
}

function isCompletedToolAggregate(value: unknown): value is CompletedToolAggregate {
  if (
    !isPlainObject(value) ||
    typeof value.disp !== 'string' ||
    !isFiniteNum(value.count) ||
    typeof value.latestTarget !== 'string' ||
    typeof value.fullTarget !== 'string'
  ) {
    return false;
  }
  return Array.isArray(value.recentTargets) && value.recentTargets.every((item) => typeof item === 'string');
}

export function isActivityAgentEntry(value: unknown): value is ActivityAgentEntry {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.model === 'string' &&
    typeof value.running === 'boolean' &&
    (value.ts === null || isFiniteNum(value.ts))
  );
}

export function parseActivityAgents(value: unknown): ActivityAgentEntry[] | null {
  if (!Array.isArray(value)) return null;
  const agents: ActivityAgentEntry[] = [];
  for (const entry of value) {
    if (!isActivityAgentEntry(entry)) return null;
    agents.push({
      name: sanitizeTerminalLabel(entry.name),
      type: sanitizeTerminalLabel(entry.type),
      model: sanitizeTerminalLabel(entry.model),
      running: entry.running,
      ts: entry.ts,
    });
  }
  return agents;
}

function parseTranscriptActivity(value: unknown): TranscriptActivity | null {
  if (!isPlainObject(value) || !Array.isArray(value.tools)) {
    return null;
  }
  const skills = parseSanitizedStringList(value.skills);
  const mcps = parseSanitizedStringList(value.mcps);
  const agents = parseActivityAgents(value.agents);
  if (skills === null || mcps === null || agents === null) return null;
  const tools: TranscriptToolEntry[] = [];
  for (const entry of value.tools) {
    if (!isTranscriptToolEntry(entry)) return null;
    tools.push({
      name: sanitizeTerminalLabel(entry.name),
      disp: sanitizeTerminalLabel(entry.disp),
      target: sanitizeTerminalLabel(entry.target),
      ...(entry.fullTarget !== undefined ? { fullTarget: sanitizeTerminalLabel(entry.fullTarget) } : {}),
      running: entry.running,
      isSkillRead: entry.isSkillRead,
    });
  }
  let completedTools: CompletedToolAggregate[] | undefined;
  if (value.completedTools !== undefined) {
    if (!Array.isArray(value.completedTools)) return null;
    completedTools = [];
    for (const entry of value.completedTools) {
      if (!isCompletedToolAggregate(entry)) return null;
      const recentTargets = parseSanitizedStringList(entry.recentTargets);
      if (recentTargets === null) return null;
      completedTools.push({
        disp: sanitizeTerminalLabel(entry.disp),
        count: entry.count,
        latestTarget: sanitizeTerminalLabel(entry.latestTarget),
        fullTarget: sanitizeTerminalLabel(entry.fullTarget),
        recentTargets,
      });
    }
  }
  return completedTools !== undefined
    ? { tools, skills, mcps, agents, completedTools }
    : { tools, skills, mcps, agents };
}

export function readActivityCache(cacheFile: string): ActivityCacheRecord | null {
  const parsed = readRegularJsonObjectSync(cacheFile, MAX_ACTIVITY_CACHE_BYTES, { requirePrivateMode: true });
  if (parsed === null || parsed.v !== ACTIVITY_CACHE_SCHEMA_VERSION) {
    return null;
  }
  const meta = parseTranscriptCacheMeta(parsed);
  if (meta === null) return null;
  const data = parseTranscriptActivity(parsed.data);
  if (data === null) return null;
  return {
    v: parsed.v,
    ...meta,
    data,
  };
}

export function writeBoundedPrivateJsonCache(
  cacheFile: string,
  record: unknown,
  maxBytes: number = MAX_ACTIVITY_CACHE_BYTES,
): boolean {
  try {
    const serialized = Buffer.from(JSON.stringify(record), 'utf8');
    if (serialized.byteLength > maxBytes) return false;
    writeBufferAtomicSync(cacheFile, serialized, PRIVATE_FILE_MODE);
    return true;
  } catch {
    return false;
  }
}

export function writeActivityCache(
  cacheFile: string,
  record: ActivityCacheRecord,
  maxBytes: number = MAX_ACTIVITY_CACHE_BYTES,
): void {
  writeBoundedPrivateJsonCache(cacheFile, record, maxBytes);
}
