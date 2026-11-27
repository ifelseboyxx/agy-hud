import path from 'node:path';

import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { mergeHudConfig } from '../core/hud-config.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import {
  DEFAULT_MAX_REGULAR_JSON_BYTES,
  readBoundedJsonObjectSync,
  readRegularJsonObjectSync,
  writeBoundedPrivateJsonCache,
} from '../fs-utils.ts';
import type { CliSettings, GitBranchInfo, HudConfig, StatusLineData, StatusLineVcs } from '../types.ts';
import { readGitRepoHeadBranch } from './git.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';

export type { GitBranchInfo };

const SESSION_TTL_SECONDS = 7 * 86400;

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

export function detectGitBranch(cwd: string | undefined, stdinVcs?: StatusLineVcs): GitBranchInfo {
  const dirty = Boolean(stdinVcs?.dirty);
  const stdinBranch = nonEmptyStr(stdinVcs?.branch);
  if (stdinBranch !== undefined) {
    return { branch: stdinBranch, dirty };
  }
  return { branch: readGitRepoHeadBranch(cwd), dirty };
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
