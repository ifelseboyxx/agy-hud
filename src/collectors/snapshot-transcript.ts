import { existsSync } from 'node:fs';

import { isPlainObject } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import { readRegularJsonObjectSync, writeBoundedPrivateJsonCache } from '../fs-utils.ts';
import type { SessionRecord } from '../snapshot-types.ts';
import type { ActivityAgentEntry } from '../types.ts';
import { MAX_ACTIVITY_CACHE_BYTES, parseActivityAgents, parseSanitizedStringList } from './activity-cache.ts';
import { listMcpServers, shortenTarget } from './activity-parse.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';
import {
  parseTranscriptCacheMeta,
  scanTranscriptWithCache,
  type ScannedToolCall,
  type TranscriptCacheMeta,
} from './transcript-scanner.ts';

const SNAPSHOT_ACTIVITY_CACHE_VERSION = 4;
const MAX_SNAPSHOT_CACHE_BYTES = MAX_ACTIVITY_CACHE_BYTES;
export const SNAPSHOT_TARGET_DISPLAY_LEN = 34;

export interface SnapshotRawToolCall {
  name: string;
  disp: string;
  target: string;
  fullTarget: string;
  targetLinkable: boolean;
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
  v: 4;
  data: SnapshotTranscriptData;
}

function parseSnapshotToolRecord(value: unknown): SnapshotRawToolCall | null {
  if (
    !isPlainObject(value) ||
    typeof value.name !== 'string' ||
    typeof value.disp !== 'string' ||
    typeof value.target !== 'string' ||
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
    target: sanitizeTerminalLabel(value.target),
    fullTarget: cleanFullTarget,
    targetLinkable,
    running: value.running,
    isSkillRead: value.isSkillRead,
    mcpServer: mcpServer !== null && mcpServer.length > 0 ? mcpServer : null,
    mcpSubtool: mcpSubtool !== null && mcpSubtool.length > 0 ? mcpSubtool : null,
  };
}

function readSnapshotTranscriptCache(cacheFile: string): SnapshotTranscriptCacheRecord | null {
  const parsed = readRegularJsonObjectSync(cacheFile, MAX_SNAPSHOT_CACHE_BYTES, { requirePrivateMode: true });
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
  const skills = parseSanitizedStringList(parsed.data.skills);
  const agents = parseActivityAgents(parsed.data.agents);
  if (skills === null || agents === null) return null;
  return {
    v: SNAPSHOT_ACTIVITY_CACHE_VERSION,
    ...meta,
    data: { tools, skills, agents, lastModel: sanitizeTerminalLabel(parsed.data.lastModel) },
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
    targetLinkable: call.targetLinkable,
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
    writeBoundedPrivateJsonCache(cacheFile, nextRecord, MAX_SNAPSHOT_CACHE_BYTES);
  }

  return data;
}
