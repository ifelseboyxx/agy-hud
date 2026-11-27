import { activityCacheFileName } from '../core/cache-registry.ts';
import { readRegularJsonObjectSync, writeBoundedPrivateJsonCache } from '../core/fs-utils.ts';
import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { resolveCliSubdirFile } from '../core/safe-path.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { ActivityAgentEntry } from '../types.ts';
import {
  parseTranscriptCacheMeta,
  scanTranscriptWithCache,
  type ScannedToolCall,
  type TranscriptCacheMeta,
} from './transcript-scanner.ts';

export const ACTIVITY_CACHE_SCHEMA_VERSION: number = 6;
export const MAX_ACTIVITY_CACHE_BYTES: number = 16 * 1024 * 1024;

export interface CanonicalTranscriptActivity {
  tools: ScannedToolCall[];
  skills: string[];
  mcps: string[];
  agents: ActivityAgentEntry[];
  lastModel: string;
}

export interface ActivityCacheRecord extends TranscriptCacheMeta {
  v: number;
  data: CanonicalTranscriptActivity;
}

export interface LoadCanonicalTranscriptOptions {
  readonly transcriptPath: string;
  readonly cacheCliHome: string;
  readonly cacheId: string;
  readonly skillRootDir: string;
  readonly workspaceDir: string | undefined;
  readonly mcpServers: readonly string[];
}

function parseSanitizedStringList(value: unknown): string[] | null {
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

function parseActivityAgents(value: unknown): ActivityAgentEntry[] | null {
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

function parseScannedToolCall(value: unknown): ScannedToolCall | null {
  if (
    !isPlainObject(value) ||
    typeof value.name !== 'string' ||
    typeof value.disp !== 'string' ||
    typeof value.fullTarget !== 'string' ||
    typeof value.targetLinkable !== 'boolean' ||
    typeof value.running !== 'boolean' ||
    typeof value.isSkillRead !== 'boolean'
  ) {
    return null;
  }
  const mcpServer =
    typeof value.mcpServer === 'string'
      ? sanitizeTerminalLabel(value.mcpServer)
      : value.mcpServer === null
        ? null
        : undefined;
  const mcpSubtool =
    typeof value.mcpSubtool === 'string'
      ? sanitizeTerminalLabel(value.mcpSubtool)
      : value.mcpSubtool === null
        ? null
        : undefined;
  if (mcpServer === undefined || mcpSubtool === undefined) return null;
  const cleanFullTarget = sanitizeTerminalLabel(value.fullTarget);
  const targetLinkable = value.targetLinkable && cleanFullTarget.length > 0 && value.fullTarget === cleanFullTarget;
  return {
    name: sanitizeTerminalLabel(value.name),
    disp: sanitizeTerminalLabel(value.disp),
    fullTarget: cleanFullTarget,
    targetLinkable,
    running: value.running,
    isSkillRead: value.isSkillRead,
    mcpServer: mcpServer !== null && mcpServer.length > 0 ? mcpServer : null,
    mcpSubtool: mcpSubtool !== null && mcpSubtool.length > 0 ? mcpSubtool : null,
  };
}

function parseCanonicalTranscriptActivity(value: unknown): CanonicalTranscriptActivity | null {
  if (!isPlainObject(value) || !Array.isArray(value.tools) || typeof value.lastModel !== 'string') {
    return null;
  }
  const skills = parseSanitizedStringList(value.skills);
  const mcps = parseSanitizedStringList(value.mcps);
  const agents = parseActivityAgents(value.agents);
  if (skills === null || mcps === null || agents === null) return null;
  const tools: ScannedToolCall[] = [];
  for (const entry of value.tools) {
    const rec = parseScannedToolCall(entry);
    if (rec === null) return null;
    tools.push(rec);
  }
  return {
    tools,
    skills,
    mcps,
    agents,
    lastModel: sanitizeTerminalLabel(value.lastModel),
  };
}

function readActivityCache(cacheFile: string): ActivityCacheRecord | null {
  const parsed = readRegularJsonObjectSync(cacheFile, MAX_ACTIVITY_CACHE_BYTES, { requirePrivateMode: true });
  if (parsed === null || parsed.v !== ACTIVITY_CACHE_SCHEMA_VERSION) {
    return null;
  }
  const meta = parseTranscriptCacheMeta(parsed);
  if (meta === null) return null;
  const data = parseCanonicalTranscriptActivity(parsed.data);
  if (data === null) return null;
  return {
    v: parsed.v,
    ...meta,
    data,
  };
}

export function loadCanonicalTranscriptActivity(
  options: LoadCanonicalTranscriptOptions,
): CanonicalTranscriptActivity | null {
  const cacheFile = resolveCliSubdirFile(options.cacheCliHome, 'cache', activityCacheFileName(options.cacheId));
  const cached = cacheFile !== null ? readActivityCache(cacheFile) : null;

  const scanned = scanTranscriptWithCache<ScannedToolCall>({
    transcriptPath: options.transcriptPath,
    skillRootDir: options.skillRootDir,
    workspaceDir: options.workspaceDir,
    mcpServers: options.mcpServers,
    seed:
      cached !== null
        ? {
            meta: cached,
            tools: cached.data.tools,
            skills: cached.data.skills,
            mcps: cached.data.mcps,
            agents: cached.data.agents,
            lastModel: cached.data.lastModel,
          }
        : null,
    projectToolCall: (call) => call,
  });
  if (scanned === null) {
    return null;
  }
  if (scanned.cacheHit && cached !== null) {
    return cached.data;
  }

  const data: CanonicalTranscriptActivity = {
    tools: scanned.tools,
    skills: scanned.skills,
    mcps: scanned.mcps,
    agents: scanned.agents,
    lastModel: scanned.lastModel,
  };

  if (cacheFile !== null && scanned.cacheable) {
    const nextRecord: ActivityCacheRecord = {
      v: ACTIVITY_CACHE_SCHEMA_VERSION,
      ...scanned.meta,
      data,
    };
    writeBoundedPrivateJsonCache(cacheFile, nextRecord, MAX_ACTIVITY_CACHE_BYTES);
  }

  return data;
}
