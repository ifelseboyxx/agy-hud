import { existsSync, readFileSync } from 'node:fs';

import { aggregateCompletedTools, shortenTarget } from '../core/activity-aggregate.ts';
import { nonEmptyStr } from '../core/guards.ts';
import { resolveCliSubdirFile, resolveConversationId, resolveSafeTranscriptFile } from '../core/safe-path.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { StatusLineData, TodoSummary, TranscriptActivity, TranscriptToolEntry } from '../types.ts';
import { loadCanonicalTranscriptActivity } from './activity-cache.ts';
import { listMcpServers } from './activity-parse.ts';
import type { ScannedToolCall } from './transcript-scanner.ts';

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

  const canonical = loadCanonicalTranscriptActivity({
    transcriptPath,
    cacheCliHome: cliHome,
    cacheId: resolveConversationId(data) ?? 'default',
    skillRootDir: cliHome,
    workspaceDir: nonEmptyStr(data.workspace?.current_dir) ?? nonEmptyStr(data.cwd),
    mcpServers: listMcpServers(cliHome),
  });
  if (canonical === null) {
    return null;
  }

  const tools = canonical.tools.map(projectHudToolCall);
  return {
    tools,
    skills: canonical.skills,
    mcps: canonical.mcps,
    agents: canonical.agents,
    completedTools: aggregateCompletedTools(tools, canonical.skills.length > 0),
  };
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
