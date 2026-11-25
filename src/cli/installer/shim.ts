import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, rmSync } from 'node:fs';
import path from 'node:path';

import { isSameCanonicalFilePath } from '../../core/statusline-ownership.ts';
import {
  captureEntrySnapshotSync,
  type EntrySnapshotSync,
  lstatIfPresentSync,
  restoreOwnedEntrySnapshotSync,
  statIfPresentSync,
  writeBufferAtomicSync,
} from '../../fs-utils.ts';
import { makeRollbackError, runRollbackSteps, type RollbackStep } from './fs-ops.ts';
import {
  expectedCliMjsPath,
  formatPathHint,
  formatShimScriptCmd,
  formatShimScriptPosix,
  isDirOnPath,
  resolveInstallNodePath,
  resolveShimBinDir,
  resolveShimPaths,
  SHIM_HEADER_VERSION,
  type ShimPaths,
} from './shim-format.ts';

export {
  formatPathHint,
  formatShimScriptCmd,
  formatShimScriptPosix,
  isDirOnPath,
  resolveInstallNodePath,
  resolveShimBinDir,
  resolveShimPaths,
  SHIM_HEADER_VERSION,
  type ShimPaths,
};

const SHIM_FILE_MODE = 0o755;
const EXEC_BIT_MASK = 0o111;
const MAX_SHIM_HEADER_BYTES = 4096;
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

export interface RemoveCliShimResult {
  readonly binDir: string;
  readonly primaryPath: string;
  readonly removed: boolean;
  readonly skippedReason: 'missing' | 'foreign' | 'owned-other' | null;
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
    const buf = Buffer.alloc(MAX_SHIM_HEADER_BYTES);
    const bytesRead = readSync(fd, buf, 0, MAX_SHIM_HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
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
  if (!raw || raw.includes(0)) {
    return { filePath, kind, state: 'foreign', target: null, matchesSelf: false, executable };
  }
  const lines = raw.toString('utf8').split(/\r?\n/);
  const line1 = lines[0] ?? '';
  const line2 = lines[1] ?? '';
  const expectedLine1 = kind === 'cmd' ? '@echo off' : '#!/bin/sh';
  const headerPrefix = kind === 'cmd' ? `@rem ${SHIM_HEADER_VERSION}` : `# ${SHIM_HEADER_VERSION}`;

  if (line2 !== headerPrefix && !line2.startsWith(`${headerPrefix} `)) {
    return { filePath, kind, state: 'foreign', target: null, matchesSelf: false, executable };
  }
  const rest = line2.slice(headerPrefix.length).trim();
  const match = /^target=(.+)$/.exec(rest);
  const parsedTarget = match?.[1]?.trim() ?? '';
  const matchesSelf = parsedTarget.length > 0 && isSameCanonicalFilePath(parsedTarget, expectedTarget);
  if (line1 !== expectedLine1 || parsedTarget.length === 0) {
    return {
      filePath,
      kind,
      state: 'malformed',
      target: parsedTarget.length > 0 ? parsedTarget : null,
      matchesSelf,
      executable,
    };
  }
  return { filePath, kind, state: 'valid', target: parsedTarget, matchesSelf, executable };
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

export function assertShimWritablePreflight(
  binDir: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dirStat = statIfPresentSync(binDir);
  if (dirStat !== null && !dirStat.isDirectory()) {
    throw new Error(`CLI shim directory path is not a directory: ${binDir}. Pass --bin-dir <dir> or --no-shim.`);
  }
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
  try {
    for (const file of ownedFiles) {
      const snapshot = captureEntrySnapshotSync(file.filePath);
      rmSync(file.filePath, { force: true });
      removedFiles.push({ filePath: file.filePath, snapshot });
    }
  } catch (err) {
    const rbErrors = runRollbackSteps(
      createShimRemovalRollbackSteps({
        binDir,
        primaryPath: inspection.primaryPath,
        removed: true,
        skippedReason: null,
        removedFiles,
      }),
    );
    throw makeRollbackError(err, rbErrors);
  }
  return { binDir, primaryPath: inspection.primaryPath, removed: true, skippedReason: null, removedFiles };
}

export function createShimRemovalRollbackSteps(result: RemoveCliShimResult | null): RollbackStep[] {
  if (!result || result.removedFiles.length === 0) return [];
  const steps: RollbackStep[] = [];
  for (let i = result.removedFiles.length - 1; i >= 0; i -= 1) {
    const item = result.removedFiles[i];
    if (!item) continue;
    steps.push([
      `restore removed CLI shim ${path.basename(item.filePath)}`,
      () => {
        restoreOwnedEntrySnapshotSync(item.snapshot, null);
      },
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
  const res =
    platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', shimPath, '--help'], {
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
        })
      : spawnSync(shimPath, ['--help'], {
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
        });
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
