import { existsSync, readFileSync } from 'node:fs';

import { nonEmptyStr } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { StatusLineData, TodoSummary, TranscriptActivity, TranscriptToolEntry } from '../types.ts';
import {
  ACTIVITY_CACHE_SCHEMA_VERSION,
  type ActivityCacheRecord,
  readActivityCache,
  writeActivityCache,
} from './activity-cache.ts';
import { aggregateCompletedTools, listMcpServers, shortenTarget } from './activity-parse.ts';
import { resolveCliSubdirFile, resolveConversationId, resolveSafeTranscriptFile } from './safe-path.ts';
import { scanTranscriptWithCache, type ScannedToolCall } from './transcript-scanner.ts';

const TASK_LINE_RE = /^\s*[-*]\s*\[([ xX/])\]\s+(.+)$/;

function projectHudToolCall(call: ScannedToolCall): TranscriptToolEntry {
  return {
    name: call.name,
    disp: call.disp,
    target: call.fullTarget.length > 0 ? shortenTarget(call.fullTarget) : '',
    ...(call.fullTarget.length > 0 ? { fullTarget: call.fullTarget } : {}),
    running: call.running,
    isSkillRead: call.isSkillRead,
  };
}

export function resolveTranscriptPath(cliHome: string, data: StatusLineData): string | null {
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

  const convId = resolveConversationId(data) ?? 'default';
  const cacheFile = resolveCliSubdirFile(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
  const cached = cacheFile !== null ? readActivityCache(cacheFile) : null;

  const scanned = scanTranscriptWithCache<TranscriptToolEntry>({
    transcriptPath,
    skillRootDir: cliHome,
    workspaceDir: nonEmptyStr(data.workspace?.current_dir) ?? nonEmptyStr(data.cwd),
    mcpServers: listMcpServers(cliHome),
    seed:
      cached !== null
        ? {
            meta: cached,
            tools: cached.data.tools,
            skills: cached.data.skills,
            mcps: cached.data.mcps,
            agents: cached.data.agents,
            lastModel: '',
          }
        : null,
    projectToolCall: projectHudToolCall,
  });
  if (scanned === null) {
    return null;
  }
  if (scanned.cacheHit && cached !== null) {
    return cached.data;
  }

  const activity: TranscriptActivity = {
    tools: scanned.tools,
    skills: scanned.skills,
    mcps: scanned.mcps,
    agents: scanned.agents,
    completedTools: aggregateCompletedTools(scanned.tools, scanned.skills.length > 0),
  };

  if (cacheFile !== null && scanned.cacheable) {
    const nextRecord: ActivityCacheRecord = {
      v: ACTIVITY_CACHE_SCHEMA_VERSION,
      ...scanned.meta,
      data: activity,
    };
    writeActivityCache(cacheFile, nextRecord);
  }

  return activity;
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
        current = sanitizeTerminalLabel(match[2]);
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
