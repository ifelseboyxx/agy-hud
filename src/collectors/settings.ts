import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isFiniteNum, isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { mergeHudConfig } from '../core/hud-config.ts';
import { resolveCliHome } from '../core/paths.ts';
import type { CliSettings, HudConfig, StatusLineData, StatusLineVcs } from '../types.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';

export { mergeHudConfig };

const SESSION_TTL_SECONDS = 7 * 86400;
const MAX_ANCESTOR_HOPS = 4;

export interface AgyProcFlags {
  bypass: boolean;
  cliMode: string;
}

export interface GitBranchInfo {
  branch: string;
  dirty: boolean;
}

export function cliHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCliHome(undefined, env);
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readCliSettings(cliHome: string): CliSettings {
  const loaded = readJsonRecord(path.join(cliHome, 'settings.json'));
  return loaded !== null ? (loaded as CliSettings) : {};
}

export function readHudConfig(cliHome: string): HudConfig {
  const loaded = readJsonRecord(path.join(cliHome, 'hud-config.json'));
  return mergeHudConfig(loaded);
}

function splitShellTokens(cmdline: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | '' = '';
  let escaped = false;

  for (let i = 0; i < cmdline.length; i += 1) {
    const ch = cmdline[i];
    if (ch === undefined) {
      continue;
    }
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && (quote === '' || quote === ch)) {
      quote = quote === '' ? ch : '';
      continue;
    }
    if (/\s/.test(ch) && quote === '') {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) {
    tokens.push(cur);
  }
  return tokens;
}

function extractAgyTokens(tokens: string[]): AgyProcFlags | null {
  const exe = tokens[0] !== undefined ? path.basename(tokens[0]) : '';
  const hasBypass = tokens.includes('--dangerously-skip-permissions');
  if (exe !== 'agy' && !hasBypass) {
    return null;
  }
  let cliMode = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) {
      continue;
    }
    if (tok.startsWith('--mode=')) {
      cliMode = tok.slice('--mode='.length);
    } else if (tok === '--mode') {
      const next = tokens[i + 1];
      if (next !== undefined) {
        cliMode = next;
      }
    }
  }
  return { bypass: hasBypass, cliMode };
}

export function detectAgyFlags(cliHome: string): AgyProcFlags {
  const ppid = process.ppid;
  const cacheFile = resolveCliSubdirFile(cliHome, 'cache', 'agy_hud_proc.json');
  const cached = cacheFile !== null ? readJsonRecord(cacheFile) : null;
  if (cached && cached.ppid === ppid) {
    return {
      bypass: Boolean(cached.bypass),
      cliMode: typeof cached.cliMode === 'string' ? cached.cliMode : '',
    };
  }

  let bypass = false;
  let cliMode = '';
  let pid = ppid;

  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    if (pid <= 1) {
      break;
    }
    let output = '';
    try {
      output = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 300,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      break;
    }
    if (output.length === 0) {
      break;
    }
    const match = /^\s*(\d+)\s*(.*)$/s.exec(output);
    const nextPid = match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
    const cmdline = match?.[2] ?? '';
    const extracted = extractAgyTokens(splitShellTokens(cmdline));
    if (extracted !== null) {
      bypass = extracted.bypass;
      cliMode = extracted.cliMode;
      break;
    }
    pid = nextPid;
  }

  if (cacheFile !== null) {
    try {
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ ppid, bypass, cliMode }), 'utf8');
    } catch {
      // Best-effort process cache write.
    }
  }

  return { bypass, cliMode };
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
  const loaded = readJsonRecord(cacheFile);
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
    try {
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(records), 'utf8');
    } catch {
      // Best-effort session timestamp persistence.
    }
  }

  return Math.max(0, nowSec - startTs);
}
