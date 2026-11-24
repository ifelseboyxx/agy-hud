import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import type { ActivityAgentEntry, CompletedToolAggregate, TranscriptActivity, TranscriptToolEntry } from '../types.ts';

export const ACTIVITY_CACHE_SCHEMA_VERSION: number = 4;

export interface ActivityCacheRecord {
  v: number;
  path: string;
  ino: number;
  mtimeMs: number;
  size: number;
  stableOffset: number;
  stableToolsCount: number;
  stableAgentsCount: number;
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
    if (
      !isPlainObject(parsed) ||
      parsed.v !== ACTIVITY_CACHE_SCHEMA_VERSION ||
      typeof parsed.path !== 'string' ||
      !isFiniteNum(parsed.ino) ||
      !isFiniteNum(parsed.mtimeMs) ||
      !isFiniteNum(parsed.size) ||
      !isFiniteNum(parsed.stableOffset) ||
      !isFiniteNum(parsed.stableToolsCount) ||
      !isFiniteNum(parsed.stableAgentsCount)
    ) {
      return null;
    }
    const data = parseTranscriptActivity(parsed.data);
    if (data === null) return null;
    return {
      v: parsed.v,
      path: parsed.path,
      ino: parsed.ino,
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      stableOffset: parsed.stableOffset,
      stableToolsCount: parsed.stableToolsCount,
      stableAgentsCount: parsed.stableAgentsCount,
      data,
    };
  } catch {
    // Ignore missing or corrupt cache.
  }
  return null;
}

export function writeActivityCache(cacheFile: string, record: ActivityCacheRecord): void {
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(record), 'utf8');
  } catch {
    // Best-effort cache write.
  }
}
