import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, openSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import {
  captureEntrySnapshotSync,
  type EntrySnapshotSync,
  lstatIfPresentSync,
  POSIX_MODE_MASK,
  readFdRange,
  restoreOwnedEntrySnapshotSync,
  statIfPresentSync,
  writeBufferAtomicSync,
} from '../../core/fs-utils.ts';
import { getErrCode } from '../../core/guards.ts';
import { isSameStatIdentity, makeRollbackError, runRollbackSteps, type RollbackStep } from './fs-ops.ts';
import {
  expectedCliMjsPath,
  formatShimScriptCmd,
  formatShimScriptPosix,
  isDirOnPath,
  parseShimHeader,
  resolveInstallNodePath,
  resolveShimPaths,
  type ShimPaths,
} from './shim-format.ts';

const SHIM_FILE_MODE = 0o755;
const EXEC_BIT_MASK = 0o111;
const MAX_SHIM_HEADER_BYTES = 4096;
const MAX_SHIM_FILE_BYTES = 64 * 1024;
const DEFAULT_SHIM_SMOKE_TIMEOUT_MS = 5000;
const MS_PER_SECOND = 1000;

export type CliShimStatus = 'missing' | 'owned-self' | 'owned-other' | 'foreign' | 'malformed' | 'incomplete-win-pair';

export interface CliShimFileInspection {
  readonly filePath: string;
  readonly kind: 'posix' | 'cmd';
  readonly state: 'missing' | 'valid' | 'foreign' | 'malformed';
  readonly target: string | null;
  readonly matchesSelf: boolean;
  readonly executable: boolean;
}

export interface CliShimInspection {
  readonly binDir: string;
  readonly primaryPath: string;
  readonly paths: ShimPaths;
  readonly status: CliShimStatus;
  readonly target: string | null;
  readonly expectedTarget: string;
  readonly claimsSelf: boolean;
  readonly executable: boolean;
  readonly onPath: boolean;
  readonly files: readonly CliShimFileInspection[];
  readonly detail: string;
}

export interface ShimFileReceipt {
  readonly filePath: string;
  readonly snapshot: EntrySnapshotSync;
  readonly writtenContent: Buffer;
}

export interface ShimWriteReceipt {
  readonly binDir: string;
  readonly primaryPath: string;
  readonly cliMjsPath: string;
  readonly files: readonly ShimFileReceipt[];
}

export interface RemovedShimFile {
  readonly filePath: string;
  readonly snapshot: EntrySnapshotSync;
}

export type ShimSkipReason = 'missing' | 'foreign' | 'owned-other';

export interface RemoveCliShimResult {
  readonly binDir: string;
  readonly primaryPath: string;
  readonly removed: boolean;
  readonly skippedReason: ShimSkipReason | null;
  readonly removedFiles: readonly RemovedShimFile[];
}

export interface CliShimSmokeResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly detail: string;
}

function readHeaderPrefixSync(filePath: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    return readFdRange(fd, 0, MAX_SHIM_HEADER_BYTES);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure on read-only header inspection.
      }
    }
  }
}

function inspectSingleShimFile(
  filePath: string,
  kind: 'posix' | 'cmd',
  expectedTarget: string,
  platform: NodeJS.Platform,
): CliShimFileInspection {
  const st = lstatIfPresentSync(filePath);
  if (!st) {
    return { filePath, kind, state: 'missing', target: null, matchesSelf: false, executable: false };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { filePath, kind, state: 'foreign', target: null, matchesSelf: false, executable: false };
  }
  const executable = platform === 'win32' || (st.mode & EXEC_BIT_MASK) !== 0;
  const raw = readHeaderPrefixSync(filePath);
  if (!raw) {
    return { filePath, kind, state: 'foreign', target: null, matchesSelf: false, executable };
  }
  const parsed = parseShimHeader(raw, kind, expectedTarget);
  return { filePath, kind, state: parsed.state, target: parsed.target, matchesSelf: parsed.matchesSelf, executable };
}

export function inspectCliShim(
  binDir: string,
  targetDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliShimInspection {
  const paths = resolveShimPaths(binDir, platform);
  const expectedTarget = expectedCliMjsPath(targetDir, platform);
  const files: CliShimFileInspection[] = [];
  if (paths.cmdPath !== null) {
    files.push(inspectSingleShimFile(paths.cmdPath, 'cmd', expectedTarget, platform));
  }
  files.push(inspectSingleShimFile(paths.posixPath, 'posix', expectedTarget, platform));

  const base = {
    binDir,
    primaryPath: paths.primaryPath,
    paths,
    expectedTarget,
    claimsSelf: files.some((f) => f.matchesSelf),
    onPath: isDirOnPath(binDir, env, platform),
    files,
  };
  const foreign = files.find((f) => f.state === 'foreign');
  if (foreign) return { ...base, status: 'foreign', target: null, executable: false, detail: foreign.filePath };

  const malformed = files.find((f) => f.state === 'malformed');
  if (malformed) {
    return { ...base, status: 'malformed', target: malformed.target, executable: false, detail: malformed.filePath };
  }
  if (files.every((f) => f.state === 'missing')) {
    return {
      ...base,
      status: 'missing',
      target: null,
      claimsSelf: false,
      executable: false,
      detail: paths.primaryPath,
    };
  }
  const firstTarget = files.find((f) => f.target !== null)?.target ?? null;
  const missing = files.find((f) => f.state === 'missing');
  if (missing) {
    return {
      ...base,
      status: 'incomplete-win-pair',
      target: firstTarget,
      executable: false,
      detail: `missing ${missing.filePath}`,
    };
  }
  if (files.every((f) => f.matchesSelf)) {
    return {
      ...base,
      status: 'owned-self',
      target: firstTarget,
      claimsSelf: true,
      executable: files.every((f) => f.executable),
      detail: paths.primaryPath,
    };
  }
  if (base.claimsSelf) {
    return {
      ...base,
      status: 'incomplete-win-pair',
      target: firstTarget,
      executable: false,
      detail: 'Windows shim pair targets diverge',
    };
  }
  return {
    ...base,
    status: 'owned-other',
    target: firstTarget,
    claimsSelf: false,
    executable: files.every((f) => f.executable),
    detail: firstTarget ?? paths.primaryPath,
  };
}

export function assertShimBinDirUsable(binDir: string): void {
  const dirStat = statIfPresentSync(binDir);
  if (dirStat !== null && !dirStat.isDirectory()) {
    throw new Error(`CLI shim directory path is not a directory: ${binDir}. Pass --bin-dir <dir> or --no-shim.`);
  }
  if (dirStat === null && lstatIfPresentSync(binDir)?.isSymbolicLink()) {
    throw new Error(`CLI shim directory path is a dangling symlink: ${binDir}. Pass --bin-dir <dir> or --no-shim.`);
  }
}

export function assertShimWritablePreflight(
  binDir: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertShimBinDirUsable(binDir);
  const inspection = inspectCliShim(binDir, targetDir, env, platform);
  if (inspection.status === 'foreign') {
    throw new Error(
      `Refusing to overwrite foreign entry at ${inspection.detail}. Remove it, pass --bin-dir <dir>, or pass --no-shim.`,
    );
  }
  if (inspection.status === 'malformed') {
    throw new Error(
      `Refusing to overwrite malformed CLI shim at ${inspection.detail}. Remove it, pass --bin-dir <dir>, or pass --no-shim.`,
    );
  }
}

export function installCliShim(
  binDir: string,
  targetDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ShimWriteReceipt {
  assertShimWritablePreflight(binDir, targetDir, platform, env);
  const paths = resolveShimPaths(binDir, platform);
  const cliMjsPath = expectedCliMjsPath(targetDir, platform);
  const installNodePath = resolveInstallNodePath();

  const planned: Array<{ filePath: string; content: Buffer; mode?: number }> = [];
  if (paths.cmdPath !== null) {
    planned.push({
      filePath: paths.cmdPath,
      content: Buffer.from(formatShimScriptCmd(cliMjsPath, installNodePath, paths.cmdPath), 'utf8'),
    });
  }
  planned.push({
    filePath: paths.posixPath,
    content: Buffer.from(formatShimScriptPosix(cliMjsPath, installNodePath, paths.posixPath), 'utf8'),
    mode: SHIM_FILE_MODE,
  });

  const snapshots = planned.map((item) => captureEntrySnapshotSync(item.filePath));
  const written: ShimFileReceipt[] = [];
  try {
    for (let i = 0; i < planned.length; i += 1) {
      const item = planned[i];
      const snap = snapshots[i];
      if (!item || !snap) continue;
      writeBufferAtomicSync(item.filePath, item.content, item.mode);
      written.push({ filePath: item.filePath, snapshot: snap, writtenContent: item.content });
    }
  } catch (err) {
    const rbErrors = runRollbackSteps(
      createShimRollbackSteps({ binDir, primaryPath: paths.primaryPath, cliMjsPath, files: written }),
    );
    throw makeRollbackError(err, rbErrors);
  }
  return { binDir, primaryPath: paths.primaryPath, cliMjsPath, files: written };
}

export function createShimRollbackSteps(
  receipt: ShimWriteReceipt | null,
  isStillOwned?: () => boolean,
): RollbackStep[] {
  if (!receipt) return [];
  const steps: RollbackStep[] = [];
  for (let i = receipt.files.length - 1; i >= 0; i -= 1) {
    const file = receipt.files[i];
    if (!file) continue;
    steps.push([
      `restore CLI shim ${path.basename(file.filePath)}`,
      () => {
        if (isStillOwned && !isStillOwned()) return;
        restoreOwnedEntrySnapshotSync(file.snapshot, file.writtenContent);
      },
    ]);
  }
  return steps;
}

type VerifiedShimRemovalCandidate =
  | { readonly ok: true; readonly snapshot: EntrySnapshotSync; readonly stat: Stats }
  | { readonly ok: false; readonly reason: ShimSkipReason };

type UnlinkVerifiedShimResult =
  | { readonly removed: true; readonly item: RemovedShimFile }
  | { readonly removed: false; readonly reason: ShimSkipReason };

function readOwnedShimFileForRemoval(
  filePath: string,
  kind: 'posix' | 'cmd',
  expectedTarget: string,
): VerifiedShimRemovalCandidate {
  const preStat = lstatIfPresentSync(filePath);
  if (!preStat) return { ok: false, reason: 'missing' };
  if (preStat.isSymbolicLink() || !preStat.isFile()) return { ok: false, reason: 'foreign' };

  let flags = fsConstants.O_RDONLY;
  if (process.platform !== 'win32') {
    if (typeof fsConstants.O_NOFOLLOW === 'number') flags |= fsConstants.O_NOFOLLOW;
    if (typeof fsConstants.O_NONBLOCK === 'number') flags |= fsConstants.O_NONBLOCK;
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, flags);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size > MAX_SHIM_FILE_BYTES) return { ok: false, reason: 'foreign' };
    const content = readFdRange(fd, 0, fdStat.size);
    const parsed = parseShimHeader(content.subarray(0, MAX_SHIM_HEADER_BYTES), kind, expectedTarget);
    if (parsed.state !== 'valid') return { ok: false, reason: 'foreign' };
    if (!parsed.matchesSelf) return { ok: false, reason: 'owned-other' };
    return {
      ok: true,
      stat: fdStat,
      snapshot: { filePath, kind: 'file', content, mode: fdStat.mode & POSIX_MODE_MASK },
    };
  } catch (err) {
    const code = getErrCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    if (code === 'ELOOP') return { ok: false, reason: 'foreign' };
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure after verified shim read.
      }
    }
  }
}

function unlinkVerifiedOwnedShimFile(
  file: CliShimFileInspection,
  expectedTarget: string,
  platform: NodeJS.Platform,
): UnlinkVerifiedShimResult {
  const verified = readOwnedShimFileForRemoval(file.filePath, file.kind, expectedTarget);
  if (!verified.ok) return { removed: false, reason: verified.reason };

  const curStat = lstatIfPresentSync(file.filePath);
  const unchanged =
    curStat !== null &&
    isSameStatIdentity(curStat, verified.stat) &&
    curStat.size === verified.stat.size &&
    curStat.mtimeMs === verified.stat.mtimeMs;
  if (!unchanged) {
    const rechecked = inspectSingleShimFile(file.filePath, file.kind, expectedTarget, platform);
    const reason =
      rechecked.state === 'missing'
        ? 'missing'
        : rechecked.state === 'valid' && !rechecked.matchesSelf
          ? 'owned-other'
          : 'foreign';
    return { removed: false, reason };
  }

  try {
    unlinkSync(file.filePath);
  } catch (unlinkErr) {
    if (getErrCode(unlinkErr) === 'ENOENT') return { removed: false, reason: 'missing' };
    throw unlinkErr;
  }
  return { removed: true, item: { filePath: file.filePath, snapshot: verified.snapshot } };
}

export function removeOwnedCliShim(
  binDir: string,
  targetDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RemoveCliShimResult {
  const inspection = inspectCliShim(binDir, targetDir, env, platform);
  const ownedFiles = inspection.files.filter((f) => f.state === 'valid' && f.matchesSelf);
  if (ownedFiles.length === 0) {
    const skippedReason =
      inspection.status === 'missing' ? 'missing' : inspection.status === 'owned-other' ? 'owned-other' : 'foreign';
    return { binDir, primaryPath: inspection.primaryPath, removed: false, skippedReason, removedFiles: [] };
  }

  const removedFiles: RemovedShimFile[] = [];
  let lastSkipReason: ShimSkipReason = 'missing';
  try {
    for (const file of ownedFiles) {
      const outcome = unlinkVerifiedOwnedShimFile(file, inspection.expectedTarget, platform);
      if (outcome.removed) {
        removedFiles.push(outcome.item);
      } else {
        lastSkipReason = outcome.reason;
      }
    }
  } catch (err) {
    const rbResult: RemoveCliShimResult = {
      binDir,
      primaryPath: inspection.primaryPath,
      removed: true,
      skippedReason: null,
      removedFiles,
    };
    throw makeRollbackError(err, runRollbackSteps(createShimRemovalRollbackSteps(rbResult)));
  }
  const removed = removedFiles.length > 0;
  return {
    binDir,
    primaryPath: inspection.primaryPath,
    removed,
    skippedReason: removed ? null : lastSkipReason,
    removedFiles,
  };
}

export function createShimRemovalRollbackSteps(result: RemoveCliShimResult | null): RollbackStep[] {
  if (!result || result.removedFiles.length === 0) return [];
  const steps: RollbackStep[] = [];
  for (let i = result.removedFiles.length - 1; i >= 0; i -= 1) {
    const item = result.removedFiles[i];
    if (!item) continue;
    steps.push([
      `restore removed CLI shim ${path.basename(item.filePath)}`,
      () => restoreOwnedEntrySnapshotSync(item.snapshot, null),
    ]);
  }
  return steps;
}

export function runCliShimSmoke(
  shimPath: string,
  timeoutMs: number = DEFAULT_SHIM_SMOKE_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
): CliShimSmokeResult {
  const start = Date.now();
  const cmd = platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : shimPath;
  const args = platform === 'win32' ? ['/d', '/c', shimPath, '--help'] : ['--help'];
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  const durationMs = Date.now() - start;
  if (res.error) {
    const isTimeout = 'code' in res.error && res.error.code === 'ETIMEDOUT';
    const sec = Math.round(timeoutMs / MS_PER_SECOND);
    return { ok: false, durationMs, detail: isTimeout ? `timed out after ${sec}s` : res.error.message };
  }
  const stdout = (res.stdout ?? '').trim();
  const stderr = (res.stderr ?? '').trim();
  const ok = res.status === 0 && stdout.length > 0;
  const detail = ok ? '' : stderr || stdout || `exited with code ${res.status ?? 'unknown'}`;
  return { ok, durationMs, detail };
}
