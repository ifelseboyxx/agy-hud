import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { lstatIfPresentSync, makeTempSuffix } from '../fs-utils.ts';
import { getErrCode, isPlainObject } from './guards.ts';
import { realpathExistingPrefixSync, toComparePath } from './paths.ts';

const CLI_LOCK_NAME = '.agy-hud-settings.lock';
const MCP_LOCK_NAME = '.agy-hud-mcp.lock';
const LOCK_POLL_MIN_MS = 25;
const LOCK_POLL_JITTER_MS = 35;
const STALE_LOCK_GRACE_MS = 150;
const CORRUPT_LOCK_GRACE_MS = 5000;
const LOCK_FILE_MODE = 0o600;
const MAX_RECLAIM_ATTEMPTS = 16;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export const DEFAULT_CLI_LOCK_TIMEOUT_MS = 65_000;

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for lock ${lockPath}`);
    this.name = 'FileLockTimeoutError';
  }
}

interface AcquiredLock {
  lockPath: string;
  token: string;
}

interface StaleLockSnapshot {
  dev: number;
  ino: number;
  raw: string;
}

export function getTargetLockPath(targetDir: string): string {
  const resolved = path.resolve(targetDir);
  const parent = path.dirname(resolved);
  const canonicalParent = parent === resolved ? resolved : realpathExistingPrefixSync(parent);
  const baseName = path.basename(resolved);
  const lockName = baseName.length > 0 ? `.${baseName}.agy-hud.lock` : '.agy-hud-target.lock';
  return path.join(canonicalParent, lockName);
}

export function getCliHomeLockPath(cliHome: string): string {
  return path.join(realpathExistingPrefixSync(cliHome), CLI_LOCK_NAME);
}

export function getMcpConfigLockPath(geminiRoot: string): string {
  return path.join(realpathExistingPrefixSync(geminiRoot), MCP_LOCK_NAME);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return getErrCode(err) === 'EPERM';
  }
}

function readStaleLockSnapshot(lockPath: string): StaleLockSnapshot | null {
  const st = lstatIfPresentSync(lockPath);
  if (!st?.isFile()) return null;
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < STALE_LOCK_GRACE_MS) return null;
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && typeof parsed.pid === 'number') {
      return parsed.pid !== process.pid && !isPidAlive(parsed.pid) ? { dev: st.dev, ino: st.ino, raw } : null;
    }
  } catch {
    return ageMs >= CORRUPT_LOCK_GRACE_MS ? { dev: st.dev, ino: st.ino, raw } : null;
  }
  return ageMs >= CORRUPT_LOCK_GRACE_MS ? { dev: st.dev, ino: st.ino, raw } : null;
}

function cleanupStalePriorReclaims(reclaimPrefix: string, count: number): void {
  for (let prev = 0; prev < count; prev += 1) {
    const prevPath = `${reclaimPrefix}.${prev}`;
    if (readStaleLockSnapshot(prevPath) !== null) {
      try {
        unlinkSync(prevPath);
      } catch {
        // Ignore prior reclaim cleanup error.
      }
    }
  }
}

function tryReclaimStaleLock(lockPath: string): boolean {
  const stale = readStaleLockSnapshot(lockPath);
  if (!stale) return false;
  const reclaimPrefix = `${lockPath}.reclaim.${stale.dev}.${stale.ino}`;
  const reclaimPayload = `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`;

  let staleSlots = 0;
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const reclaimPath = `${reclaimPrefix}.${attempt}`;
    let fd: number | undefined;
    try {
      fd = openSync(reclaimPath, 'wx', LOCK_FILE_MODE);
    } catch (err) {
      if (getErrCode(err) !== 'EEXIST') return false;
      if (readStaleLockSnapshot(reclaimPath) !== null) {
        staleSlots += 1;
        continue;
      }
      return false;
    }

    try {
      writeFileSync(fd, reclaimPayload, 'utf8');
      closeSync(fd);
      fd = undefined;
      const current = readStaleLockSnapshot(lockPath);
      if (!current || current.dev !== stale.dev || current.ino !== stale.ino || current.raw !== stale.raw) {
        return false;
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        return getErrCode(unlinkErr) === 'ENOENT';
      }
      return true;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failure.
        }
      }
      cleanupStalePriorReclaims(reclaimPrefix, attempt);
      try {
        unlinkSync(reclaimPath);
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
  if (staleSlots === MAX_RECLAIM_ATTEMPTS) {
    cleanupStalePriorReclaims(reclaimPrefix, MAX_RECLAIM_ATTEMPTS);
    return true;
  }
  return false;
}

function releaseLock(lock: AcquiredLock): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
    if (isPlainObject(parsed) && parsed.token === lock.token) {
      unlinkSync(lock.lockPath);
    }
  } catch {
    // Lock already removed or unreadable.
  }
}

function tryAcquireOnce(lockPath: string, token: string, payload: string): AcquiredLock | null {
  let fd: number | undefined;
  let createdStat: Stats | undefined;
  try {
    fd = openSync(lockPath, 'wx', LOCK_FILE_MODE);
    createdStat = fstatSync(fd);
    writeFileSync(fd, payload, 'utf8');
    closeSync(fd);
    fd = undefined;
    return { lockPath, token };
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error.
      }
    }
    if (createdStat !== undefined) {
      try {
        const curStat = lstatIfPresentSync(lockPath);
        if (curStat !== null && curStat.dev === createdStat.dev && curStat.ino === createdStat.ino) {
          unlinkSync(lockPath);
        }
      } catch {
        // Ignore cleanup error for partially written lock.
      }
      throw err;
    }
    if (getErrCode(err) !== 'EEXIST') throw err;
    return null;
  }
}

function acquireSingleLockSync(lockPath: string, deadline: number): AcquiredLock {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = makeTempSuffix();
  const payload = `${JSON.stringify({ pid: process.pid, token, lockPath })}\n`;

  while (true) {
    const acquired = tryAcquireOnce(lockPath, token, payload);
    if (acquired) return acquired;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath);
    if (tryReclaimStaleLock(lockPath)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FileLockTimeoutError(lockPath);
    const delay = Math.min(remaining, LOCK_POLL_MIN_MS + Math.floor(Math.random() * LOCK_POLL_JITTER_MS));
    Atomics.wait(SLEEP_CELL, 0, 0, delay);
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderLockPaths(lockPaths: readonly string[]): string[] {
  const uniqueByKey = new Map<string, string>();
  for (const raw of lockPaths) {
    const resolved = path.resolve(raw);
    const key = toComparePath(resolved);
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, resolved);
  }
  return [...uniqueByKey.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, p]) => p);
}

export function withFileLocksSync<T>(
  lockPaths: readonly string[],
  action: () => T,
  timeoutMs: number = DEFAULT_CLI_LOCK_TIMEOUT_MS,
): T {
  const ordered = orderLockPaths(lockPaths);
  const deadline = Date.now() + timeoutMs;
  const acquired: AcquiredLock[] = [];
  try {
    for (const lockPath of ordered) {
      acquired.push(acquireSingleLockSync(lockPath, deadline));
    }
    return action();
  } finally {
    for (let i = acquired.length - 1; i >= 0; i -= 1) {
      const item = acquired[i];
      if (item) releaseLock(item);
    }
  }
}

export function withCliHomeLockSync<T>(
  cliHome: string,
  action: () => T,
  timeoutMs: number = DEFAULT_CLI_LOCK_TIMEOUT_MS,
): T {
  return withFileLocksSync([getCliHomeLockPath(cliHome)], action, timeoutMs);
}
