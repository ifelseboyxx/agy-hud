import { existsSync } from 'node:fs';

import { shortenTarget, SNAPSHOT_TARGET_DISPLAY_LEN } from '../core/activity-aggregate.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from '../core/safe-path.ts';
import type { SessionRecord } from '../snapshot-types.ts';
import type { ActivityAgentEntry } from '../types.ts';
import { loadCanonicalTranscriptActivity } from './activity-cache.ts';
import { listMcpServers } from './activity-parse.ts';
import type { ScannedToolCall } from './transcript-scanner.ts';

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

  const canonical = loadCanonicalTranscriptActivity({
    transcriptPath,
    cacheCliHome,
    cacheId: safeId,
    skillRootDir: session.dataRoot,
    workspaceDir: session.workspace.length > 0 ? session.workspace : undefined,
    mcpServers: mergeMcpServerLists(session.dataRoot, cacheCliHome),
  });
  if (canonical === null) return empty;

  return {
    tools: canonical.tools.map(projectSnapshotToolCall),
    skills: canonical.skills,
    agents: canonical.agents,
    lastModel: canonical.lastModel,
  };
}
