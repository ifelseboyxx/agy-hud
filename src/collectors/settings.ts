import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { mergeHudConfig } from '../core/hud-config.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import { DEFAULT_MAX_REGULAR_JSON_BYTES, readBoundedJsonObjectSync, readRegularJsonObjectSync } from '../fs-utils.ts';
import type { CliSettings, HudConfig, StatusLineData, StatusLineVcs } from '../types.ts';
import { writeBoundedPrivateJsonCache } from './activity-cache.ts';
import { detectAgyFlags, type AgyProcFlags } from './proc.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';

export { detectAgyFlags, mergeHudConfig, type AgyProcFlags };

const SESSION_TTL_SECONDS = 7 * 86400;

export interface GitBranchInfo {
  branch: string;
  dirty: boolean;
}

export function readCliSettings(cliHome: string): CliSettings {
  const loaded = readBoundedJsonObjectSync(path.join(cliHome, 'settings.json'));
  return loaded !== null ? (loaded as CliSettings) : {};
}

export function readCliFallbackModel(cliHome: string): string {
  return sanitizeTerminalLabel(nonEmptyStr(readCliSettings(cliHome).model) ?? '');
}

export function readHudConfig(cliHome: string): HudConfig {
  const loaded = readBoundedJsonObjectSync(path.join(cliHome, 'hud-config.json'));
  return mergeHudConfig(loaded);
}

function readGitHeadBranch(gitEntry: string): string {
  try {
    const st = statSync(gitEntry);
    let headPath = '';
    if (st.isDirectory()) {
      headPath = path.join(gitEntry, 'HEAD');
    } else if (st.isFile()) {
      const ptr = readFileSync(gitEntry, 'utf8').trim();
      if (ptr.startsWith('gitdir:')) {
        const gitDir = path.resolve(path.dirname(gitEntry), ptr.slice('gitdir:'.length).trim());
        headPath = path.join(gitDir, 'HEAD');
      }
    }
    if (headPath.length === 0 || !existsSync(headPath)) {
      return '';
    }
    const content = readFileSync(headPath, 'utf8').trim();
    if (content.startsWith('ref: refs/heads/')) {
      return content.slice('ref: refs/heads/'.length);
    }
    return content.slice(0, 7);
  } catch {
    return '';
  }
}

export function detectGitBranch(cwd: string | undefined, stdinVcs?: StatusLineVcs): GitBranchInfo {
  const dirty = Boolean(stdinVcs?.dirty);
  const stdinBranch = nonEmptyStr(stdinVcs?.branch);
  if (stdinBranch !== undefined) {
    return { branch: stdinBranch, dirty };
  }
  const startDir = nonEmptyStr(cwd);
  if (startDir === undefined) {
    return { branch: '', dirty };
  }

  let cur = path.resolve(startDir);
  while (true) {
    const gitEntry = path.join(cur, '.git');
    if (existsSync(gitEntry)) {
      return { branch: readGitHeadBranch(gitEntry), dirty };
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return { branch: '', dirty };
    }
    cur = parent;
  }
}

export function getSessionElapsedSeconds(
  cliHome: string,
  convId: string | undefined,
  data?: StatusLineData,
): number | null {
  if (data) {
    if (isFiniteNum(data.duration_ms)) {
      return Math.max(0, data.duration_ms / 1000);
    }
    if (isFiniteNum(data.total_duration_ms)) {
      return Math.max(0, data.total_duration_ms / 1000);
    }
    if (isFiniteNum(data.cost?.total_duration_ms)) {
      return Math.max(0, data.cost.total_duration_ms / 1000);
    }
    if (isFiniteNum(data.elapsed_seconds)) {
      return Math.max(0, data.elapsed_seconds);
    }
  }

  const sessionKey = sanitizeSessionId(
    nonEmptyStr(convId) ?? nonEmptyStr(data?.session_id) ?? nonEmptyStr(data?.conversation_id),
  );
  if (sessionKey === null) {
    return null;
  }

  const cacheFile = resolveCliSubdirFile(cliHome, 'cache', 'agy_hud_sessions.json');
  if (cacheFile === null) {
    return null;
  }
  const nowSec = Date.now() / 1000;
  const loaded = readRegularJsonObjectSync(cacheFile, DEFAULT_MAX_REGULAR_JSON_BYTES, { requirePrivateMode: true });
  const records: Record<string, number> = Object.create(null) as Record<string, number>;

  if (loaded) {
    for (const [k, v] of Object.entries(loaded)) {
      if (sanitizeSessionId(k) !== null && isFiniteNum(v) && nowSec - v < SESSION_TTL_SECONDS) {
        records[k] = v;
      }
    }
  }

  let startTs = records[sessionKey];
  if (!isFiniteNum(startTs)) {
    startTs = nowSec;
    records[sessionKey] = nowSec;
    writeBoundedPrivateJsonCache(cacheFile, records, DEFAULT_MAX_REGULAR_JSON_BYTES);
  }

  return Math.max(0, nowSec - startTs);
}
