import { existsSync } from 'node:fs';

import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { readJsonObjectSync, writeJsonAtomicSync } from '../fs-utils.ts';
import type { SessionRecord } from '../snapshot-types.ts';
import type { ActivityAgentEntry } from '../types.ts';
import { listMcpServers, shortenTarget } from './activity-parse.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';
import {
  parseTranscriptCacheMeta,
  scanTranscriptWithCache,
  type ScannedToolCall,
  type TranscriptCacheMeta,
} from './transcript-scanner.ts';

const SNAPSHOT_ACTIVITY_CACHE_VERSION = 2;
export const SNAPSHOT_TARGET_DISPLAY_LEN = 34;

export interface SnapshotRawToolCall {
  name: string;
  disp: string;
  target: string;
  fullTarget: string;
  running: boolean;
  isSkillRead: boolean;
  mcpServer: string | null;
  mcpSubtool: string | null;
}

export interface SnapshotTranscriptData {
  tools: SnapshotRawToolCall[];
  skills: string[];
  agents: ActivityAgentEntry[];
  lastModel: string;
}

interface SnapshotTranscriptCacheRecord extends TranscriptCacheMeta {
  v: 2;
  data: SnapshotTranscriptData;
}

function parseSnapshotToolRecord(value: unknown): SnapshotRawToolCall | null {
  if (
    !isPlainObject(value) ||
    typeof value.name !== 'string' ||
    typeof value.disp !== 'string' ||
    typeof value.target !== 'string' ||
    typeof value.fullTarget !== 'string' ||
    typeof value.running !== 'boolean' ||
    typeof value.isSkillRead !== 'boolean'
  ) {
    return null;
  }
  const mcpServer = typeof value.mcpServer === 'string' ? value.mcpServer : value.mcpServer === null ? null : undefined;
  const mcpSubtool =
    typeof value.mcpSubtool === 'string' ? value.mcpSubtool : value.mcpSubtool === null ? null : undefined;
  if (mcpServer === undefined || mcpSubtool === undefined) return null;
  return {
    name: value.name,
    disp: value.disp,
    target: value.target,
    fullTarget: value.fullTarget,
    running: value.running,
    isSkillRead: value.isSkillRead,
    mcpServer,
    mcpSubtool,
  };
}

function parseSnapshotAgentRecord(value: unknown): ActivityAgentEntry | null {
  if (
    !isPlainObject(value) ||
    typeof value.name !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.running !== 'boolean' ||
    !(value.ts === null || isFiniteNum(value.ts))
  ) {
    return null;
  }
  return { name: value.name, type: value.type, model: value.model, running: value.running, ts: value.ts };
}

function readSnapshotTranscriptCache(cacheFile: string): SnapshotTranscriptCacheRecord | null {
  const parsed = readJsonObjectSync(cacheFile, false);
  if (parsed === null || parsed.v !== SNAPSHOT_ACTIVITY_CACHE_VERSION) {
    return null;
  }
  const meta = parseTranscriptCacheMeta(parsed);
  if (
    meta === null ||
    !isPlainObject(parsed.data) ||
    !Array.isArray(parsed.data.tools) ||
    !Array.isArray(parsed.data.skills) ||
    !Array.isArray(parsed.data.agents) ||
    typeof parsed.data.lastModel !== 'string'
  ) {
    return null;
  }
  const tools: SnapshotRawToolCall[] = [];
  for (const item of parsed.data.tools) {
    const rec = parseSnapshotToolRecord(item);
    if (rec === null) return null;
    tools.push(rec);
  }
  const skills: string[] = [];
  for (const sk of parsed.data.skills) {
    if (typeof sk !== 'string') return null;
    skills.push(sk);
  }
  const agents: ActivityAgentEntry[] = [];
  for (const item of parsed.data.agents) {
    const rec = parseSnapshotAgentRecord(item);
    if (rec === null) return null;
    agents.push(rec);
  }
  return {
    v: SNAPSHOT_ACTIVITY_CACHE_VERSION,
    ...meta,
    data: { tools, skills, agents, lastModel: parsed.data.lastModel },
  };
}

function mergeMcpServerLists(dataRoot: string, cacheCliHome: string): string[] {
  const unique = new Set<string>([...listMcpServers(dataRoot), ...listMcpServers(cacheCliHome)]);
  return [...unique].sort((a, b) => b.length - a.length);
}

function projectSnapshotToolCall(call: ScannedToolCall): SnapshotRawToolCall {
  return {
    name: call.name,
    disp: call.disp,
    target: call.fullTarget.length > 0 ? shortenTarget(call.fullTarget, SNAPSHOT_TARGET_DISPLAY_LEN) : '',
    fullTarget: call.fullTarget,
    running: call.running,
    isSkillRead: call.isSkillRead,
    mcpServer: call.mcpServer,
    mcpSubtool: call.mcpSubtool,
  };
}

export function loadSnapshotTranscript(session: SessionRecord, cacheCliHome: string): SnapshotTranscriptData {
  const empty: SnapshotTranscriptData = { tools: [], skills: [], agents: [], lastModel: '' };
  const safeId = sanitizeSessionId(session.convId);
  if (safeId === null) return empty;
  const transcriptPath = resolveCliSubdirFile(
    session.dataRoot,
    'brain',
    safeId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  if (transcriptPath === null || !existsSync(transcriptPath)) return empty;

  const cacheFile = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_activity_snapshot_${safeId}.json`);
  const cached = cacheFile !== null ? readSnapshotTranscriptCache(cacheFile) : null;
  const cachedMcps: string[] = [];
  if (cached !== null) {
    const seenMcp = new Set<string>();
    for (const tool of cached.data.tools) {
      if (tool.mcpServer !== null && !seenMcp.has(tool.mcpServer)) {
        seenMcp.add(tool.mcpServer);
        cachedMcps.push(tool.mcpServer);
      }
    }
  }
  const scanned = scanTranscriptWithCache<SnapshotRawToolCall>({
    transcriptPath,
    skillRootDir: session.dataRoot,
    workspaceDir: session.workspace.length > 0 ? session.workspace : undefined,
    mcpServers: mergeMcpServerLists(session.dataRoot, cacheCliHome),
    seed:
      cached !== null
        ? {
            meta: cached,
            tools: cached.data.tools,
            skills: cached.data.skills,
            mcps: cachedMcps,
            agents: cached.data.agents,
            lastModel: cached.data.lastModel,
          }
        : null,
    projectToolCall: projectSnapshotToolCall,
  });
  if (scanned === null) return empty;
  if (scanned.cacheHit && cached !== null) {
    return cached.data;
  }

  const data: SnapshotTranscriptData = {
    tools: scanned.tools,
    skills: scanned.skills,
    agents: scanned.agents,
    lastModel: scanned.lastModel,
  };

  if (cacheFile !== null && scanned.cacheable) {
    const nextRecord: SnapshotTranscriptCacheRecord = {
      v: SNAPSHOT_ACTIVITY_CACHE_VERSION,
      ...scanned.meta,
      data,
    };
    try {
      writeJsonAtomicSync(cacheFile, nextRecord);
    } catch {
      // Best-effort snapshot activity cache write inside cliHome/cache.
    }
  }

  return data;
}
