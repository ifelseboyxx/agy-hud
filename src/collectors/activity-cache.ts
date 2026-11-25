import { readFileSync } from 'node:fs';

import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { writeBufferAtomicSync } from '../fs-utils.ts';
import type { ActivityAgentEntry, CompletedToolAggregate, TranscriptActivity, TranscriptToolEntry } from '../types.ts';
import { parseTranscriptCacheMeta, type TranscriptCacheMeta } from './transcript-scanner.ts';

export const ACTIVITY_CACHE_SCHEMA_VERSION: number = 4;

export interface ActivityCacheRecord extends TranscriptCacheMeta {
  v: number;
  data: TranscriptActivity;
}

function parseStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    items.push(item);
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
  return parseStringList(value.recentTargets) !== null;
}

function isActivityAgentEntry(value: unknown): value is ActivityAgentEntry {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.model === 'string' &&
    typeof value.running === 'boolean' &&
    (value.ts === null || isFiniteNum(value.ts))
  );
}

function parseTranscriptActivity(value: unknown): TranscriptActivity | null {
  if (!isPlainObject(value) || !Array.isArray(value.tools) || !Array.isArray(value.agents)) {
    return null;
  }
  const skills = parseStringList(value.skills);
  const mcps = parseStringList(value.mcps);
  if (skills === null || mcps === null) return null;
  const tools: TranscriptToolEntry[] = [];
  for (const entry of value.tools) {
    if (!isTranscriptToolEntry(entry)) return null;
    tools.push(entry);
  }
  const agents: ActivityAgentEntry[] = [];
  for (const entry of value.agents) {
    if (!isActivityAgentEntry(entry)) return null;
    agents.push(entry);
  }
  let completedTools: CompletedToolAggregate[] | undefined;
  if (value.completedTools !== undefined) {
    if (!Array.isArray(value.completedTools)) return null;
    completedTools = [];
    for (const entry of value.completedTools) {
      if (!isCompletedToolAggregate(entry)) return null;
      completedTools.push(entry);
    }
  }
  return completedTools !== undefined
    ? { tools, skills, mcps, agents, completedTools }
    : { tools, skills, mcps, agents };
}

export function readActivityCache(cacheFile: string): ActivityCacheRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!isPlainObject(parsed) || parsed.v !== ACTIVITY_CACHE_SCHEMA_VERSION) {
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
  } catch {
    // Ignore missing or corrupt cache.
  }
  return null;
}

export function writeActivityCache(cacheFile: string, record: ActivityCacheRecord): void {
  try {
    writeBufferAtomicSync(cacheFile, JSON.stringify(record));
  } catch {
    // Best-effort cache write.
  }
}
