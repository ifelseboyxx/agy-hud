import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isPidAlive } from '../core/file-lock.ts';
import { isFiniteNum, isPlainObject } from '../core/guards.ts';
import { readJsonObjectSync, writeJsonAtomicSync } from '../fs-utils.ts';
import { resolveCliSubdirFile } from './safe-path.ts';

const MAX_ANCESTOR_HOPS = 8;
const PROC_CACHE_VERSION = 2;
const MAX_CACHE_ENTRIES = 64;
const POSIX_PS_TIMEOUT_MS = 300;
const WIN32_PS_TIMEOUT_MS = 800;

const SHELL_AND_NODE_WRAPPERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'node',
  'node.exe',
]);

export interface AgyProcFlags {
  bypass: boolean;
  cliMode: string;
}

export interface AgyProcessInfo extends AgyProcFlags {
  agyPid: number | null;
}

export interface AncestorProcSample {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
  tokens?: readonly string[];
}

export interface DetectAgyProcessOptions {
  platform?: NodeJS.Platform;
  startPid?: number;
  knownLiveAgyPid?: number | null;
  readProc?: (pid: number) => AncestorProcSample | null;
  readWin32Ancestors?: (startPid: number) => AncestorProcSample[] | null;
  isAlive?: (pid: number) => boolean;
  nowMs?: number;
}

interface CachedPpidEntry {
  agyPid: number | null;
  bypass: boolean;
  cliMode: string;
  updatedAtMs: number;
}

interface CachedAgyEntry {
  bypass: boolean;
  cliMode: string;
  updatedAtMs: number;
}

interface ProcCacheStore {
  v: 2;
  byPpid: Record<string, CachedPpidEntry>;
  byAgyPid: Record<string, CachedAgyEntry>;
}

function emptyProcCache(): ProcCacheStore {
  return { v: PROC_CACHE_VERSION, byPpid: {}, byAgyPid: {} };
}

function normalizeExeName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const base = path.win32.basename(trimmed).toLowerCase();
  return base.startsWith('-') ? base.slice(1) : base;
}

function isAgyBinaryName(exe: string): boolean {
  return exe === 'agy' || exe === 'agy.exe';
}

function splitShellTokens(cmdline: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | '' = '';
  let escaped = false;

  for (let i = 0; i < cmdline.length; i += 1) {
    const ch = cmdline[i];
    if (ch === undefined) continue;
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      const next = cmdline[i + 1];
      if (next === ' ' || next === '\t' || next === '"' || next === "'" || next === '\\') {
        escaped = true;
        continue;
      }
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
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function extractAgyTokens(tokens: readonly string[], comm = ''): AgyProcFlags | null {
  const commExe = normalizeExeName(comm);
  const argvExe = normalizeExeName(tokens[0] ?? '');
  if (SHELL_AND_NODE_WRAPPERS.has(commExe) || SHELL_AND_NODE_WRAPPERS.has(argvExe)) {
    return null;
  }
  if (!isAgyBinaryName(commExe) && !isAgyBinaryName(argvExe)) {
    return null;
  }
  const hasBypass = tokens.includes('--dangerously-skip-permissions');
  let cliMode = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (tok.startsWith('--mode=')) {
      cliMode = tok.slice('--mode='.length);
    } else if (tok === '--mode') {
      const next = tokens[i + 1];
      if (next !== undefined) cliMode = next;
    }
  }
  return { bypass: hasBypass, cliMode };
}

export function parseLinuxProcStat(raw: string): { comm: string; ppid: number } | null {
  const openIdx = raw.indexOf('(');
  const closeIdx = raw.lastIndexOf(')');
  if (openIdx === -1 || closeIdx <= openIdx) return null;
  const comm = raw.slice(openIdx + 1, closeIdx);
  const rest = raw.slice(closeIdx + 1).trim();
  const fields = rest.split(/\s+/);
  const ppidRaw = fields[1];
  if (ppidRaw === undefined || !/^\d+$/.test(ppidRaw)) return null;
  return { comm, ppid: Number.parseInt(ppidRaw, 10) };
}

function readPosixPsSample(pid: number): AncestorProcSample | null {
  let output = '';
  try {
    output = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: POSIX_PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (output.length === 0) return null;
  const match = /^\s*(\d+)\s*(.*)$/s.exec(output);
  const ppid = match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
  const args = match?.[2] ?? '';
  return { pid, ppid, comm: '', args };
}

function readLinuxProcSample(pid: number): AncestorProcSample | null {
  try {
    const statRaw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parsed = parseLinuxProcStat(statRaw);
    if (parsed !== null) {
      let tokens: string[] = [];
      let args = '';
      try {
        const cmdBuf = readFileSync(`/proc/${pid}/cmdline`);
        const rawParts = cmdBuf.toString('utf8').split('\0');
        while (rawParts.length > 0 && rawParts[rawParts.length - 1] === '') {
          rawParts.pop();
        }
        tokens = rawParts;
        args = tokens.join(' ');
      } catch {
        // Fallback to comm-only sample when cmdline is unreadable.
      }
      return { pid, ppid: parsed.ppid, comm: parsed.comm, args, tokens };
    }
  } catch {
    // Fall back to ps when /proc is unavailable.
  }
  return readPosixPsSample(pid);
}

function readWin32AncestorsViaPowerShell(startPid: number): AncestorProcSample[] | null {
  if (!Number.isInteger(startPid) || startPid <= 1) return null;
  const script =
    `$p=${startPid};$r=@();for($i=0;$i -lt ${MAX_ANCESTOR_HOPS} -and $p -gt 1;$i++){` +
    `$x=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;` +
    `if(-not $x){break};` +
    `$r+=[pscustomobject]@{pid=[int]$x.ProcessId;ppid=[int]$x.ParentProcessId;comm=[string]$x.Name;args=[string]$x.CommandLine};` +
    `$p=[int]$x.ParentProcessId};$r|ConvertTo-Json -Compress`;
  let stdout = '';
  try {
    stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: WIN32_PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (stdout.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : isPlainObject(parsed) ? [parsed] : [];
  const samples: AncestorProcSample[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const pid = isFiniteNum(item.pid) ? Math.trunc(item.pid) : 0;
    const ppid = isFiniteNum(item.ppid) ? Math.trunc(item.ppid) : 0;
    if (pid <= 0) continue;
    samples.push({
      pid,
      ppid,
      comm: typeof item.comm === 'string' ? item.comm : '',
      args: typeof item.args === 'string' ? item.args : '',
    });
  }
  return samples;
}

function readProcCache(cacheFile: string): ProcCacheStore {
  const parsed = readJsonObjectSync(cacheFile, false);
  if (parsed === null || parsed.v !== PROC_CACHE_VERSION) {
    return emptyProcCache();
  }
  const byPpid: Record<string, CachedPpidEntry> = {};
  if (isPlainObject(parsed.byPpid)) {
    for (const [k, v] of Object.entries(parsed.byPpid)) {
      if (!/^\d+$/.test(k) || !isPlainObject(v)) continue;
      const agyPid = v.agyPid === null ? null : isFiniteNum(v.agyPid) ? Math.trunc(v.agyPid) : undefined;
      if (agyPid === undefined || typeof v.bypass !== 'boolean' || typeof v.cliMode !== 'string') continue;
      byPpid[k] = {
        agyPid,
        bypass: v.bypass,
        cliMode: v.cliMode,
        updatedAtMs: isFiniteNum(v.updatedAtMs) ? v.updatedAtMs : 0,
      };
    }
  }
  const byAgyPid: Record<string, CachedAgyEntry> = {};
  if (isPlainObject(parsed.byAgyPid)) {
    for (const [k, v] of Object.entries(parsed.byAgyPid)) {
      if (!/^\d+$/.test(k) || !isPlainObject(v)) continue;
      if (typeof v.bypass !== 'boolean' || typeof v.cliMode !== 'string') continue;
      byAgyPid[k] = {
        bypass: v.bypass,
        cliMode: v.cliMode,
        updatedAtMs: isFiniteNum(v.updatedAtMs) ? v.updatedAtMs : 0,
      };
    }
  }
  return { v: PROC_CACHE_VERSION, byPpid, byAgyPid };
}

function prunePidMap<T extends { updatedAtMs: number }>(
  map: Record<string, T>,
  isAlive: (pid: number) => boolean,
  extraCheck?: (entry: T) => boolean,
): Record<string, T> {
  const liveEntries: Array<[string, T]> = [];
  for (const [key, entry] of Object.entries(map)) {
    const pid = Number.parseInt(key, 10);
    if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) continue;
    if (extraCheck && !extraCheck(entry)) continue;
    liveEntries.push([key, entry]);
  }
  liveEntries.sort((a, b) => b[1].updatedAtMs - a[1].updatedAtMs);
  const bounded = liveEntries.slice(0, MAX_CACHE_ENTRIES);
  const next: Record<string, T> = {};
  for (const [key, entry] of bounded) {
    next[key] = entry;
  }
  return next;
}

function matchSample(sample: AncestorProcSample): AgyProcessInfo | null {
  const tokens = sample.tokens ?? splitShellTokens(sample.args);
  const extracted = extractAgyTokens(tokens, sample.comm);
  if (extracted === null) return null;
  return { agyPid: sample.pid, bypass: extracted.bypass, cliMode: extracted.cliMode };
}

function walkAncestors(options: DetectAgyProcessOptions): AgyProcessInfo {
  const platform = options.platform ?? process.platform;
  const startPid = options.startPid ?? process.ppid;
  if (!Number.isInteger(startPid) || startPid <= 1) {
    return { agyPid: null, bypass: false, cliMode: '' };
  }

  if (platform === 'win32') {
    const winReader = options.readWin32Ancestors ?? readWin32AncestorsViaPowerShell;
    const samples = winReader(startPid);
    if (!samples) return { agyPid: null, bypass: false, cliMode: '' };
    const limit = Math.min(samples.length, MAX_ANCESTOR_HOPS);
    for (let i = 0; i < limit; i += 1) {
      const sample = samples[i];
      if (!sample) continue;
      const matched = matchSample(sample);
      if (matched !== null) return matched;
    }
    return { agyPid: null, bypass: false, cliMode: '' };
  }

  const reader = options.readProc ?? (platform === 'linux' ? readLinuxProcSample : readPosixPsSample);
  let pid = startPid;
  const visited = new Set<number>();

  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    if (pid <= 1 || visited.has(pid)) break;
    visited.add(pid);
    const sample = reader(pid);
    if (sample === null) break;
    const matched = matchSample(sample);
    if (matched !== null) return matched;
    pid = sample.ppid;
  }

  return { agyPid: null, bypass: false, cliMode: '' };
}

export function findAncestorAgyPid(options: DetectAgyProcessOptions = {}): number | null {
  const checkAlive = options.isAlive ?? isPidAlive;
  const found = walkAncestors(options);
  return found.agyPid !== null && checkAlive(found.agyPid) ? found.agyPid : null;
}

export function detectAgyProcess(cliHome: string, options: DetectAgyProcessOptions = {}): AgyProcessInfo {
  const platform = options.platform ?? process.platform;
  const startPid = options.startPid ?? process.ppid;
  const checkAlive = options.isAlive ?? isPidAlive;
  const nowMs = options.nowMs ?? Date.now();
  const cacheFile = resolveCliSubdirFile(cliHome, 'cache', 'agy_hud_proc.json');
  const store = cacheFile !== null ? readProcCache(cacheFile) : emptyProcCache();

  if (
    platform === 'win32' &&
    options.knownLiveAgyPid !== undefined &&
    options.knownLiveAgyPid !== null &&
    checkAlive(options.knownLiveAgyPid)
  ) {
    const knownEntry = store.byAgyPid[String(options.knownLiveAgyPid)];
    return {
      agyPid: options.knownLiveAgyPid,
      bypass: knownEntry?.bypass ?? false,
      cliMode: knownEntry?.cliMode ?? '',
    };
  }

  const cachedByPpid = store.byPpid[String(startPid)];
  if (
    cachedByPpid !== undefined &&
    checkAlive(startPid) &&
    (cachedByPpid.agyPid === null || checkAlive(cachedByPpid.agyPid))
  ) {
    return {
      agyPid: cachedByPpid.agyPid,
      bypass: cachedByPpid.bypass,
      cliMode: cachedByPpid.cliMode,
    };
  }

  const detected = walkAncestors(options);
  if (cacheFile !== null) {
    const nextByPpid: Record<string, CachedPpidEntry> = { ...store.byPpid };
    if (Number.isInteger(startPid) && startPid > 1 && checkAlive(startPid)) {
      nextByPpid[String(startPid)] = {
        agyPid: detected.agyPid,
        bypass: detected.bypass,
        cliMode: detected.cliMode,
        updatedAtMs: nowMs,
      };
    }
    const nextByAgyPid: Record<string, CachedAgyEntry> = { ...store.byAgyPid };
    if (detected.agyPid !== null && checkAlive(detected.agyPid)) {
      nextByAgyPid[String(detected.agyPid)] = {
        bypass: detected.bypass,
        cliMode: detected.cliMode,
        updatedAtMs: nowMs,
      };
    }

    const pruned: ProcCacheStore = {
      v: PROC_CACHE_VERSION,
      byPpid: prunePidMap(nextByPpid, checkAlive, (e) => e.agyPid === null || checkAlive(e.agyPid)),
      byAgyPid: prunePidMap(nextByAgyPid, checkAlive),
    };
    try {
      writeJsonAtomicSync(cacheFile, pruned);
    } catch {
      // Best-effort process cache write.
    }
  }

  return detected;
}

export function detectAgyFlags(cliHome: string): AgyProcFlags {
  const info = detectAgyProcess(cliHome);
  return { bypass: info.bypass, cliMode: info.cliMode };
}
