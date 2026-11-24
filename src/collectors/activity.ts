import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import { isPlainObject, nonEmptyStr, parseIsoTimestampSec } from '../core/guards.ts';
import type {
  ActivityAgentEntry,
  StatusLineData,
  TodoSummary,
  TranscriptActivity,
  TranscriptToolEntry,
} from '../types.ts';
import {
  ACTIVITY_CACHE_SCHEMA_VERSION,
  type ActivityCacheRecord,
  readActivityCache,
  writeActivityCache,
} from './activity-cache.ts';
import {
  aggregateCompletedTools,
  extractToolTarget,
  extractUserInputSkills,
  listMcpServers,
  parseMcpTool,
  resolveSkillName,
  sanitizeFullTarget,
  shortenTarget,
  unwrapArg,
} from './activity-parse.ts';
import { resolveCliSubdirFile, resolveConversationId, resolveSafeTranscriptFile } from './safe-path.ts';

export {
  aggregateCompletedTools,
  BUILTIN_SLASH_CMDS,
  extractToolTarget,
  parseMcpTool,
  resolveSkillName,
  sanitizeFullTarget,
  shortenTarget,
  unwrapArg,
} from './activity-parse.ts';

const TASK_LINE_RE = /^\s*[-*]\s*\[([ xX/])\]\s+(.+)$/;
const RUNNING_STATUSES: ReadonlySet<string> = new Set(['RUNNING', 'PENDING', 'IN_PROGRESS', 'GENERATING', 'WAITING']);

interface ScanSliceResult {
  activity: TranscriptActivity;
  stableOffset: number;
  stableToolsCount: number;
  stableAgentsCount: number;
}

function addUnique(seq: string[], seen: Set<string>, value: string): void {
  if (value.length > 0 && !seen.has(value)) {
    seen.add(value);
    seq.push(value);
  }
}

function readBufferSlice(filePath: string, startOffset: number): Buffer {
  const fd = openSync(filePath, 'r');
  try {
    const st = fstatSync(fd);
    const readLen = Math.max(0, st.size - startOffset);
    const buf = Buffer.allocUnsafe(readLen);
    let readPos = 0;
    while (readPos < readLen) {
      const bytesRead = readSync(fd, buf, readPos, readLen - readPos, startOffset + readPos);
      if (bytesRead <= 0) {
        break;
      }
      readPos += bytesRead;
    }
    return readPos < readLen ? buf.subarray(0, readPos) : buf;
  } finally {
    closeSync(fd);
  }
}

interface ScanContext {
  cliHome: string;
  workspaceDir: string | undefined;
  mcpServers: readonly string[];
}

interface ScanAccumulators {
  tools: TranscriptToolEntry[];
  skills: string[];
  skillsSeen: Set<string>;
  mcps: string[];
  mcpsSeen: Set<string>;
  agents: ActivityAgentEntry[];
}

function recordPlannerToolCall(
  tc: unknown,
  ctx: ScanContext,
  acc: ScanAccumulators,
  isRunning: boolean,
  stepTs: number | null,
): void {
  if (!isPlainObject(tc)) return;
  const name = typeof tc.name === 'string' ? tc.name.trim() : '';
  if (name.length === 0) return;

  const args = isPlainObject(tc.args) ? tc.args : isPlainObject(tc.arguments) ? tc.arguments : undefined;
  const target = extractToolTarget(name, args);

  const skillName =
    (name === 'read_file' || name === 'view_file') && target.length > 0
      ? resolveSkillName(target, ctx.cliHome, ctx.workspaceDir)
      : null;
  if (skillName !== null) {
    addUnique(acc.skills, acc.skillsSeen, skillName);
  }

  const mcpInfo = parseMcpTool(name, args, ctx.mcpServers);
  if (mcpInfo !== null) {
    addUnique(acc.mcps, acc.mcpsSeen, mcpInfo[0]);
  }

  if (name === 'invoke_subagent' && args) {
    const role = nonEmptyStr(unwrapArg(args.Role)) ?? nonEmptyStr(unwrapArg(args.TypeName)) ?? 'subagent';
    const model = unwrapArg(args.Model);
    acc.agents.push({
      name: role,
      type: unwrapArg(args.TypeName),
      model: model === 'inherit' ? '' : model,
      running: isRunning,
      ts: stepTs,
    });
  }

  const cleanFullTarget = sanitizeFullTarget(target);
  acc.tools.push({
    name,
    disp: mcpInfo !== null ? `${mcpInfo[0]}:${mcpInfo[1]}` : name,
    target: cleanFullTarget.length > 0 ? shortenTarget(cleanFullTarget) : '',
    ...(cleanFullTarget.length > 0 ? { fullTarget: cleanFullTarget } : {}),
    running: isRunning,
    isSkillRead: skillName !== null,
  });
}

function scanChunkFromOffset(
  transcriptPath: string,
  startOffset: number,
  ctx: ScanContext,
  seed?: ScanSliceResult,
): ScanSliceResult {
  const tools: TranscriptToolEntry[] = seed ? seed.activity.tools.slice(0, seed.stableToolsCount) : [];
  const skills: string[] = seed ? [...seed.activity.skills] : [];
  const skillsSeen = new Set<string>(skills);
  const mcps: string[] = seed ? [...seed.activity.mcps] : [];
  const mcpsSeen = new Set<string>(mcps);
  const agents: ActivityAgentEntry[] = seed ? seed.activity.agents.slice(0, seed.stableAgentsCount) : [];

  let stableOffset = startOffset;
  let stableToolsCount = tools.length;
  let stableAgentsCount = agents.length;
  let sawRunningStep = false;

  const chunkBuf = readBufferSlice(transcriptPath, startOffset);
  let cursor = 0;

  while (cursor < chunkBuf.length) {
    const nlIdx = chunkBuf.indexOf(0x0a, cursor);
    if (nlIdx === -1) {
      break;
    }
    const lineStart = startOffset + cursor;
    const lineEnd = startOffset + nlIdx + 1;
    const rawLine = chunkBuf.subarray(cursor, nlIdx).toString('utf8').trim();
    cursor = nlIdx + 1;

    if (rawLine.length === 0) {
      if (!sawRunningStep) {
        stableOffset = lineEnd;
      }
      continue;
    }

    let step: unknown;
    try {
      step = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isPlainObject(step)) {
      continue;
    }

    if (step.type === 'USER_INPUT') {
      const rawContent = typeof step.content === 'string' ? step.content : '';
      for (const sk of extractUserInputSkills(rawContent)) {
        addUnique(skills, skillsSeen, sk);
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

    const status = typeof step.status === 'string' ? step.status.toUpperCase() : '';
    const isRunning = RUNNING_STATUSES.has(status);
    if (isRunning && !sawRunningStep) {
      sawRunningStep = true;
      stableOffset = lineStart;
      stableToolsCount = tools.length;
      stableAgentsCount = agents.length;
    }

    const stepTs = parseIsoTimestampSec(step.created_at);
    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const acc: ScanAccumulators = { tools, skills, skillsSeen, mcps, mcpsSeen, agents };

    for (const tc of toolCalls) {
      recordPlannerToolCall(tc, ctx, acc, isRunning, stepTs);
    }

    if (!sawRunningStep) {
      stableOffset = lineEnd;
      stableToolsCount = tools.length;
      stableAgentsCount = agents.length;
    }
  }

  return {
    activity: {
      tools,
      skills,
      mcps,
      agents,
      completedTools: aggregateCompletedTools(tools, skills.length > 0),
    },
    stableOffset,
    stableToolsCount,
    stableAgentsCount,
  };
}

function resolveTranscriptPath(cliHome: string, data: StatusLineData): string | null {
  const convId = resolveConversationId(data);
  if (convId !== null) {
    const candidate = resolveCliSubdirFile(cliHome, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (candidate !== null && existsSync(candidate)) {
      return candidate;
    }
  }
  const rawPath = nonEmptyStr(data.transcript_path);
  if (rawPath !== undefined) {
    return resolveSafeTranscriptFile(cliHome, rawPath);
  }
  return null;
}

export function loadTranscriptActivity(cliHome: string, data: StatusLineData): TranscriptActivity | null {
  const transcriptPath = resolveTranscriptPath(cliHome, data);
  if (transcriptPath === null) {
    return null;
  }

  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return null;
  }
  if (!st.isFile()) {
    return null;
  }

  const convId = resolveConversationId(data) ?? 'default';
  const cacheFile = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
  const cached = cacheFile !== null ? readActivityCache(cacheFile) : null;

  if (
    cached &&
    cached.path === transcriptPath &&
    cached.ino === st.ino &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size
  ) {
    return cached.data;
  }

  const scanCtx: ScanContext = {
    cliHome,
    workspaceDir: nonEmptyStr(data.workspace?.current_dir) ?? nonEmptyStr(data.cwd),
    mcpServers: listMcpServers(cliHome),
  };
  const canResume =
    cached !== null &&
    cached.path === transcriptPath &&
    cached.ino === st.ino &&
    cached.stableOffset <= st.size &&
    cached.stableOffset >= 0;

  let scanned: ScanSliceResult;
  try {
    scanned = canResume
      ? scanChunkFromOffset(transcriptPath, cached.stableOffset, scanCtx, {
          activity: cached.data,
          stableOffset: cached.stableOffset,
          stableToolsCount: cached.stableToolsCount,
          stableAgentsCount: cached.stableAgentsCount,
        })
      : scanChunkFromOffset(transcriptPath, 0, scanCtx);
  } catch {
    return null;
  }

  const nextRecord: ActivityCacheRecord = {
    v: ACTIVITY_CACHE_SCHEMA_VERSION,
    path: transcriptPath,
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    size: st.size,
    stableOffset: scanned.stableOffset,
    stableToolsCount: scanned.stableToolsCount,
    stableAgentsCount: scanned.stableAgentsCount,
    data: scanned.activity,
  };

  if (cacheFile !== null) {
    writeActivityCache(cacheFile, nextRecord);
  }

  return scanned.activity;
}

function parseTaskFileCounts(taskFile: string): { total: number; completed: number; current: string } | null {
  try {
    const lines = readFileSync(taskFile, 'utf8').split(/\r?\n/);
    let total = 0;
    let completed = 0;
    let current = '';
    for (const line of lines) {
      const match = TASK_LINE_RE.exec(line);
      if (!match?.[1] || !match[2]) continue;
      total += 1;
      if (match[1].toLowerCase() === 'x') {
        completed += 1;
      } else if (match[1] === '/' && current.length === 0) {
        current = match[2].trim();
      }
    }
    return total > 0 ? { total, completed, current } : null;
  } catch {
    return null;
  }
}

export function loadTodos(cliHome: string, data: StatusLineData): TodoSummary | null {
  const info: TodoSummary = {};
  const convId = resolveConversationId(data);

  if (convId !== null) {
    const taskFile = resolveCliSubdirFile(cliHome, 'brain', convId, 'task.md');
    const counts = taskFile !== null && existsSync(taskFile) ? parseTaskFileCounts(taskFile) : null;
    if (counts !== null) {
      info.total = counts.total;
      info.completed = counts.completed;
      info.current = counts.current;
    }
  }

  if (typeof data.task_count === 'number' && Number.isInteger(data.task_count) && data.task_count > 0) {
    info.taskCount = data.task_count;
  }

  return info.total !== undefined || info.taskCount !== undefined ? info : null;
}
