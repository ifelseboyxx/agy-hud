import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isFiniteNum, isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { DEFAULT_MAX_REGULAR_JSON_BYTES, readRegularJsonObjectSync, statIfPresentSync } from '../fs-utils.ts';
import type { GitStatusInfo, StatusLineVcs } from '../types.ts';
import { writeBoundedPrivateJsonCache } from './activity-cache.ts';
import { resolveCliSubdirFile } from './safe-path.ts';

export const GIT_CACHE_TTL_MS: number = 2_000;
const GIT_CMD_TIMEOUT_MS = 150;
const GIT_CMD_MAX_BUFFER = 512 * 1024;
const MAX_GIT_META_BYTES = 64 * 1024;

export const SAFE_GIT_CONFIG_ARGS: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
];

const SAFE_GIT_DIFF_FLAGS: readonly string[] = ['--numstat', '--no-ext-diff', '--no-textconv'];

const SAFE_GIT_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
];

export function buildSafeGitEnv(repoRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.platform() === 'win32' ? 'NUL' : '/dev/null',
    GIT_EXTERNAL_DIFF: '',
    GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(repoRoot)),
  };
  for (const key of SAFE_GIT_ENV_KEYS) {
    const val = baseEnv[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  return env;
}

export interface GitRepoLocations {
  readonly repoRoot: string;
  readonly gitDir: string;
}

interface GitCacheRecord {
  readonly ts: number;
  readonly head: string;
  readonly indexMtimeMs: number;
  readonly indexSize: number;
  readonly info: GitStatusInfo;
}

export interface DetectGitStatusOptions {
  readonly nowMs?: number;
  readonly timeoutMs?: number;
}

function readBoundedRegularMeta(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_GIT_META_BYTES) {
      return null;
    }
    const buf = Buffer.allocUnsafe(MAX_GIT_META_BYTES + 1);
    let total = 0;
    while (total <= MAX_GIT_META_BYTES) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n <= 0) break;
      total += n;
    }
    if (total > MAX_GIT_META_BYTES) {
      return null;
    }
    return buf.subarray(0, total).toString('utf8').trim();
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors on read-only metadata fd.
      }
    }
  }
}

function resolveGitDirFromEntry(gitEntry: string): string | null {
  try {
    const st = statIfPresentSync(gitEntry);
    if (st === null) return null;
    if (st.isDirectory()) {
      return gitEntry;
    }
    if (st.isFile()) {
      const ptr = readBoundedRegularMeta(gitEntry);
      if (ptr !== null && ptr.startsWith('gitdir:')) {
        return path.resolve(path.dirname(gitEntry), ptr.slice('gitdir:'.length).trim());
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function findGitRepoRoot(cwd: string | undefined): GitRepoLocations | null {
  const startDir = nonEmptyStr(cwd);
  if (startDir === undefined) return null;
  let cur = path.resolve(startDir);
  while (true) {
    const gitEntry = path.join(cur, '.git');
    if (existsSync(gitEntry)) {
      const gitDir = resolveGitDirFromEntry(gitEntry);
      return gitDir !== null ? { repoRoot: cur, gitDir } : null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function readRawHeadContent(gitDir: string): string {
  return readBoundedRegularMeta(path.join(gitDir, 'HEAD')) ?? '';
}

export function readGitRepoHeadBranch(cwd: string | undefined): string {
  const loc = findGitRepoRoot(cwd);
  if (loc === null) return '';
  return parseBranchFromHeadContent(readRawHeadContent(loc.gitDir));
}

export function parseBranchFromHeadContent(headContent: string): string {
  if (headContent.length === 0) return '';
  if (headContent.startsWith('ref: refs/heads/')) {
    return headContent.slice('ref: refs/heads/'.length);
  }
  return headContent.slice(0, 7);
}

function statGitIndex(gitDir: string): { mtimeMs: number; size: number } {
  try {
    const st = statIfPresentSync(path.join(gitDir, 'index'));
    if (st === null || !st.isFile()) {
      return { mtimeMs: 0, size: 0 };
    }
    return { mtimeMs: Math.trunc(st.mtimeMs), size: st.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function resolveGitCachePath(cliHome: string, repoRoot: string): string | null {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  return resolveCliSubdirFile(cliHome, 'cache', `agy_hud_git_${hash}.json`);
}

function parseNonNegInt(val: unknown): number {
  return isFiniteNum(val) && Number.isInteger(val) && val >= 0 ? val : 0;
}

function parseCachedGitRecord(raw: Record<string, unknown> | null): GitCacheRecord | null {
  if (raw === null || !isFiniteNum(raw.ts) || typeof raw.head !== 'string') return null;
  if (!isFiniteNum(raw.indexMtimeMs) || !isFiniteNum(raw.indexSize) || !isPlainObject(raw.info)) return null;
  const info = raw.info;
  if (typeof info.branch !== 'string' || typeof info.dirty !== 'boolean') return null;
  return {
    ts: raw.ts,
    head: raw.head,
    indexMtimeMs: raw.indexMtimeMs,
    indexSize: raw.indexSize,
    info: {
      branch: info.branch,
      dirty: info.dirty,
      staged: parseNonNegInt(info.staged),
      modified: parseNonNegInt(info.modified),
      deleted: parseNonNegInt(info.deleted),
      renamed: parseNonNegInt(info.renamed),
      untracked: parseNonNegInt(info.untracked),
      conflicted: parseNonNegInt(info.conflicted),
      stash: parseNonNegInt(info.stash),
      ahead: parseNonNegInt(info.ahead),
      behind: parseNonNegInt(info.behind),
      diffAdded: parseNonNegInt(info.diffAdded),
      diffDeleted: parseNonNegInt(info.diffDeleted),
    },
  };
}

export function parsePorcelainV2Status(stdout: string, fallbackBranch: string): GitStatusInfo {
  let branch = fallbackBranch;
  let headOid = '';
  let staged = 0;
  let modified = 0;
  let deleted = 0;
  let renamed = 0;
  let untracked = 0;
  let conflicted = 0;
  let stash = 0;
  let ahead = 0;
  let behind = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.startsWith('# branch.oid ')) {
      headOid = line.slice('# branch.oid '.length).trim();
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') {
        branch = headOid.length >= 7 && headOid !== '(initial)' ? headOid.slice(0, 7) : fallbackBranch;
      } else if (head.length > 0) {
        branch = head;
      }
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (match?.[1] && match[2]) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
    } else if (line.startsWith('# stash ')) {
      const count = Number.parseInt(line.slice('# stash '.length).trim(), 10);
      if (Number.isFinite(count) && count > 0) stash = count;
    } else if (line.startsWith('u ')) {
      conflicted += 1;
    } else if (line.startsWith('? ')) {
      untracked += 1;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      if (x === 'R' || x === 'C') {
        renamed += 1;
      } else if (x === 'D') {
        staged += 1;
        deleted += 1;
      } else if (x !== '.' && x !== '?') {
        staged += 1;
      }
      if (y === 'D') {
        deleted += 1;
      } else if (y !== '.' && y !== '?') {
        modified += 1;
      }
    }
  }

  const dirty = staged > 0 || modified > 0 || deleted > 0 || renamed > 0 || untracked > 0 || conflicted > 0;
  return {
    branch,
    dirty,
    staged,
    modified,
    deleted,
    renamed,
    untracked,
    conflicted,
    stash,
    ahead,
    behind,
    diffAdded: 0,
    diffDeleted: 0,
  };
}

export function parseDiffNumstat(stdout: string): { readonly diffAdded: number; readonly diffDeleted: number } {
  let diffAdded = 0;
  let diffDeleted = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [rawAdd, rawDel] = line.split('\t');
    if (rawAdd === undefined || rawDel === undefined || rawAdd === '-' || rawDel === '-') continue;
    const add = Number.parseInt(rawAdd, 10);
    const del = Number.parseInt(rawDel, 10);
    if (Number.isFinite(add) && add > 0) diffAdded += add;
    if (Number.isFinite(del) && del > 0) diffDeleted += del;
  }
  return { diffAdded, diffDeleted };
}

function runGitCmd(repoRoot: string, args: readonly string[], timeoutMs: number): { ok: boolean; stdout: string } {
  const res = spawnSync('git', [...SAFE_GIT_CONFIG_ARGS, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: GIT_CMD_MAX_BUFFER,
    windowsHide: true,
    env: buildSafeGitEnv(repoRoot),
  });
  return { ok: !res.error && res.status === 0, stdout: res.stdout ?? '' };
}

function buildFallbackGitInfo(headContent: string, stdinVcs?: StatusLineVcs): GitStatusInfo {
  const branch = nonEmptyStr(stdinVcs?.branch) ?? parseBranchFromHeadContent(headContent);
  const dirty = Boolean(stdinVcs?.dirty);
  const ahead = isFiniteNum(stdinVcs?.ahead) && stdinVcs.ahead > 0 ? Math.trunc(stdinVcs.ahead) : undefined;
  const behind = isFiniteNum(stdinVcs?.behind) && stdinVcs.behind > 0 ? Math.trunc(stdinVcs.behind) : undefined;
  return {
    branch,
    dirty,
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
  };
}

export function detectGitStatus(
  cliHome: string | undefined,
  cwd: string | undefined,
  stdinVcs?: StatusLineVcs,
  options?: DetectGitStatusOptions,
): GitStatusInfo {
  const repo = findGitRepoRoot(nonEmptyStr(stdinVcs?.repo_root) ?? cwd);
  if (repo === null) {
    return buildFallbackGitInfo('', stdinVcs);
  }

  const nowMs = options?.nowMs ?? Date.now();
  const timeoutMs = options?.timeoutMs ?? GIT_CMD_TIMEOUT_MS;
  const headContent = readRawHeadContent(repo.gitDir);
  const indexStat = statGitIndex(repo.gitDir);
  const cachePath = cliHome !== undefined ? resolveGitCachePath(cliHome, repo.repoRoot) : null;

  if (cachePath !== null) {
    const cached = parseCachedGitRecord(
      readRegularJsonObjectSync(cachePath, DEFAULT_MAX_REGULAR_JSON_BYTES, { requirePrivateMode: true }),
    );
    if (
      cached !== null &&
      nowMs - cached.ts >= 0 &&
      nowMs - cached.ts < GIT_CACHE_TTL_MS &&
      cached.head === headContent &&
      cached.indexMtimeMs === indexStat.mtimeMs &&
      cached.indexSize === indexStat.size
    ) {
      return cached.info;
    }
  }

  const statusRes = runGitCmd(repo.repoRoot, ['status', '--porcelain=v2', '--branch', '--show-stash'], timeoutMs);
  if (!statusRes.ok) {
    return buildFallbackGitInfo(headContent, stdinVcs);
  }

  const fallbackBranch = nonEmptyStr(stdinVcs?.branch) ?? parseBranchFromHeadContent(headContent);
  const parsed = parsePorcelainV2Status(statusRes.stdout, fallbackBranch);
  const hasTrackedChanges =
    (parsed.staged ?? 0) > 0 ||
    (parsed.modified ?? 0) > 0 ||
    (parsed.deleted ?? 0) > 0 ||
    (parsed.renamed ?? 0) > 0 ||
    (parsed.conflicted ?? 0) > 0;

  if (hasTrackedChanges) {
    const isUnbornHead = /(?:^|\r?\n)# branch\.oid \(initial\)(?:\r?\n|$)/.test(statusRes.stdout);
    if (isUnbornHead) {
      const cachedRes = runGitCmd(repo.repoRoot, ['diff', '--cached', ...SAFE_GIT_DIFF_FLAGS, '--'], timeoutMs);
      if (cachedRes.ok) {
        const stagedStats = parseDiffNumstat(cachedRes.stdout);
        parsed.diffAdded = stagedStats.diffAdded;
        parsed.diffDeleted = stagedStats.diffDeleted;
      }
      if ((parsed.modified ?? 0) > 0 || (parsed.deleted ?? 0) > 0) {
        const wtRes = runGitCmd(repo.repoRoot, ['diff', ...SAFE_GIT_DIFF_FLAGS, '--'], timeoutMs);
        if (wtRes.ok) {
          const wtStats = parseDiffNumstat(wtRes.stdout);
          parsed.diffAdded = (parsed.diffAdded ?? 0) + wtStats.diffAdded;
          parsed.diffDeleted = (parsed.diffDeleted ?? 0) + wtStats.diffDeleted;
        }
      }
    } else {
      const diffRes = runGitCmd(repo.repoRoot, ['diff', ...SAFE_GIT_DIFF_FLAGS, 'HEAD', '--'], timeoutMs);
      if (diffRes.ok) {
        const stats = parseDiffNumstat(diffRes.stdout);
        parsed.diffAdded = stats.diffAdded;
        parsed.diffDeleted = stats.diffDeleted;
      }
    }
  }

  if (cachePath !== null) {
    const record: GitCacheRecord = {
      ts: nowMs,
      head: headContent,
      indexMtimeMs: indexStat.mtimeMs,
      indexSize: indexStat.size,
      info: parsed,
    };
    writeBoundedPrivateJsonCache(cachePath, record, DEFAULT_MAX_REGULAR_JSON_BYTES);
  }

  return parsed;
}
