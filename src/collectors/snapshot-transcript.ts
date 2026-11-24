import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

import { isFiniteNum, isPlainObject, nonEmptyStr, parseIsoTimestampSec } from '../core/guards.ts';
import { readJsonObjectSync, writeJsonAtomicSync } from '../fs-utils.ts';
import type { SessionRecord } from '../snapshot-types.ts';
import type { ActivityAgentEntry } from '../types.ts';
import {
  extractToolTarget,
  extractUserInputSkills,
  listMcpServers,
  parseMcpTool,
  resolveSkillName,
  shortenTarget,
  unwrapArg,
} from './activity-parse.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';

const SNAPSHOT_ACTIVITY_CACHE_VERSION = 1;
export const SNAPSHOT_TARGET_DISPLAY_LEN = 34;
const SNAPSHOT_RUNNING_STATUSES: ReadonlySet<string> = new Set([
  'RUNNING',
  'PENDING',
  'IN_PROGRESS',
  'GENERATING',
  'WAITING',
]);

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

interface SnapshotScanResult {
  data: SnapshotTranscriptData;
  stableOffset: number;
  stableToolsCount: number;
  stableAgentsCount: number;
}

interface SnapshotTranscriptCacheRecord {
  v: 1;
  path: string;
  ino: number;
  mtimeMs: number;
  size: number;
  stableOffset: number;
  stableToolsCount: number;
  stableAgentsCount: number;
  data: SnapshotTranscriptData;
}

function appendUniqueString(seq: string[], seen: Set<string>, value: string): void {
  if (value.length > 0 && !seen.has(value)) {
    seen.add(value);
    seq.push(value);
  }
}

function readTranscriptSlice(filePath: string, startOffset: number): Buffer {
  const fd = openSync(filePath, 'r');
  try {
    const st = fstatSync(fd);
    const readLen = Math.max(0, st.size - startOffset);
    const buf = Buffer.allocUnsafe(readLen);
    let readPos = 0;
    while (readPos < readLen) {
      const bytesRead = readSync(fd, buf, readPos, readLen - readPos, startOffset + readPos);
      if (bytesRead <= 0) break;
      readPos += bytesRead;
    }
    return readPos < readLen ? buf.subarray(0, readPos) : buf;
  } finally {
    closeSync(fd);
  }
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
  if (
    parsed === null ||
    parsed.v !== SNAPSHOT_ACTIVITY_CACHE_VERSION ||
    typeof parsed.path !== 'string' ||
    !isFiniteNum(parsed.ino) ||
    !isFiniteNum(parsed.mtimeMs) ||
    !isFiniteNum(parsed.size) ||
    !isFiniteNum(parsed.stableOffset) ||
    !isFiniteNum(parsed.stableToolsCount) ||
    !isFiniteNum(parsed.stableAgentsCount) ||
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
    path: parsed.path,
    ino: parsed.ino,
    mtimeMs: parsed.mtimeMs,
    size: parsed.size,
    stableOffset: parsed.stableOffset,
    stableToolsCount: parsed.stableToolsCount,
    stableAgentsCount: parsed.stableAgentsCount,
    data: { tools, skills, agents, lastModel: parsed.data.lastModel },
  };
}

function mergeMcpServerLists(dataRoot: string, cacheCliHome: string): string[] {
  const unique = new Set<string>([...listMcpServers(dataRoot), ...listMcpServers(cacheCliHome)]);
  return [...unique].sort((a, b) => b.length - a.length);
}

function recordSnapshotToolCall(
  tc: unknown,
  dataRoot: string,
  workspaceDir: string | undefined,
  mcpServers: readonly string[],
  isRunning: boolean,
  stepTs: number | null,
  tools: SnapshotRawToolCall[],
  skills: string[],
  skillsSeen: Set<string>,
  agents: ActivityAgentEntry[],
): void {
  if (!isPlainObject(tc)) return;
  const name = typeof tc.name === 'string' ? tc.name.trim() : '';
  if (name.length === 0) return;
  const args = isPlainObject(tc.args) ? tc.args : isPlainObject(tc.arguments) ? tc.arguments : undefined;
  const rawTarget = extractToolTarget(name, args);

  const skillName =
    (name === 'read_file' || name === 'view_file') && rawTarget.length > 0
      ? resolveSkillName(rawTarget, dataRoot, workspaceDir)
      : null;
  if (skillName !== null) {
    appendUniqueString(skills, skillsSeen, skillName);
  }

  const mcpInfo = parseMcpTool(name, args, mcpServers);
  if (name === 'invoke_subagent' && args) {
    const role = nonEmptyStr(unwrapArg(args.Role)) ?? nonEmptyStr(unwrapArg(args.TypeName)) ?? 'subagent';
    const model = unwrapArg(args.Model);
    agents.push({
      name: role,
      type: unwrapArg(args.TypeName),
      model: model === 'inherit' ? '' : model,
      running: isRunning,
      ts: stepTs,
    });
  }

  tools.push({
    name,
    disp: mcpInfo !== null ? `${mcpInfo[0]}:${mcpInfo[1]}` : name,
    target: rawTarget.length > 0 ? shortenTarget(rawTarget, SNAPSHOT_TARGET_DISPLAY_LEN) : '',
    fullTarget: rawTarget,
    running: isRunning,
    isSkillRead: skillName !== null,
    mcpServer: mcpInfo !== null ? mcpInfo[0] : null,
    mcpSubtool: mcpInfo !== null ? mcpInfo[1] : null,
  });
}

function scanSnapshotTranscript(
  transcriptPath: string,
  startOffset: number,
  dataRoot: string,
  workspaceDir: string | undefined,
  mcpServers: readonly string[],
  seed?: SnapshotScanResult,
): SnapshotScanResult {
  const tools = seed ? seed.data.tools.slice(0, seed.stableToolsCount) : [];
  const skills = seed ? [...seed.data.skills] : [];
  const skillsSeen = new Set<string>(skills);
  const agents = seed ? seed.data.agents.slice(0, seed.stableAgentsCount) : [];
  let lastModel = seed ? seed.data.lastModel : '';

  let stableOffset = startOffset;
  let stableToolsCount = tools.length;
  let stableAgentsCount = agents.length;
  let sawRunningStep = false;

  const chunkBuf = readTranscriptSlice(transcriptPath, startOffset);
  let cursor = 0;

  while (cursor < chunkBuf.length) {
    const nlIdx = chunkBuf.indexOf(0x0a, cursor);
    if (nlIdx === -1) break;
    const lineStart = startOffset + cursor;
    const lineEnd = startOffset + nlIdx + 1;
    const rawLine = chunkBuf.subarray(cursor, nlIdx).toString('utf8').trim();
    cursor = nlIdx + 1;

    if (rawLine.length === 0) {
      if (!sawRunningStep) stableOffset = lineEnd;
      continue;
    }

    let step: unknown;
    try {
      step = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isPlainObject(step)) continue;

    if (step.type === 'USER_INPUT') {
      const content = typeof step.content === 'string' ? step.content : '';
      for (const sk of extractUserInputSkills(content)) {
        appendUniqueString(skills, skillsSeen, sk);
      }
      if (!sawRunningStep) {
        stableOffset = lineEnd;
        stableToolsCount = tools.length;
        stableAgentsCount = agents.length;
      }
      continue;
    }

    if (step.type !== 'PLANNER_RESPONSE') {
      if (!sawRunningStep) {
        stableOffset = lineEnd;
        stableToolsCount = tools.length;
        stableAgentsCount = agents.length;
      }
      continue;
    }

    if (typeof step.model === 'string' && step.model.trim().length > 0) {
      lastModel = step.model.trim();
    }
    const status = typeof step.status === 'string' ? step.status.toUpperCase() : '';
    const isRunning = SNAPSHOT_RUNNING_STATUSES.has(status);
    if (isRunning && !sawRunningStep) {
      sawRunningStep = true;
      stableOffset = lineStart;
      stableToolsCount = tools.length;
      stableAgentsCount = agents.length;
    }

    const stepTs = parseIsoTimestampSec(step.created_at);
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (const tc of toolCalls) {
      recordSnapshotToolCall(
        tc,
        dataRoot,
        workspaceDir,
        mcpServers,
        isRunning,
        stepTs,
        tools,
        skills,
        skillsSeen,
        agents,
      );
    }

    if (!sawRunningStep) {
      stableOffset = lineEnd;
      stableToolsCount = tools.length;
      stableAgentsCount = agents.length;
    }
  }

  return {
    data: { tools, skills, agents, lastModel },
    stableOffset,
    stableToolsCount,
    stableAgentsCount,
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

  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return empty;
  }
  if (!st.isFile()) return empty;

  const cacheFile = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_activity_snapshot_${safeId}.json`);
  const cached = cacheFile !== null ? readSnapshotTranscriptCache(cacheFile) : null;
  if (
    cached !== null &&
    cached.path === transcriptPath &&
    cached.ino === st.ino &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size
  ) {
    return cached.data;
  }

  const mcpServers = mergeMcpServerLists(session.dataRoot, cacheCliHome);
  const wsDir = session.workspace.length > 0 ? session.workspace : undefined;
  const canResume =
    cached !== null &&
    cached.path === transcriptPath &&
    cached.ino === st.ino &&
    cached.stableOffset <= st.size &&
    cached.stableOffset >= 0;

  let scanned: SnapshotScanResult;
  try {
    scanned = canResume
      ? scanSnapshotTranscript(transcriptPath, cached.stableOffset, session.dataRoot, wsDir, mcpServers, {
          data: cached.data,
          stableOffset: cached.stableOffset,
          stableToolsCount: cached.stableToolsCount,
          stableAgentsCount: cached.stableAgentsCount,
        })
      : scanSnapshotTranscript(transcriptPath, 0, session.dataRoot, wsDir, mcpServers);
  } catch {
    return empty;
  }

  if (cacheFile !== null) {
    const nextRecord: SnapshotTranscriptCacheRecord = {
      v: SNAPSHOT_ACTIVITY_CACHE_VERSION,
      path: transcriptPath,
      ino: st.ino,
      mtimeMs: st.mtimeMs,
      size: st.size,
      stableOffset: scanned.stableOffset,
      stableToolsCount: scanned.stableToolsCount,
      stableAgentsCount: scanned.stableAgentsCount,
      data: scanned.data,
    };
    try {
      writeJsonAtomicSync(cacheFile, nextRecord);
    } catch {
      // Best-effort snapshot activity cache write inside cliHome/cache.
    }
  }

  return scanned.data;
}
