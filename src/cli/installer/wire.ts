import path from 'node:path';

import { getCliHomeLockPath, getShimBinLockPath, getTargetLockPath, withFileLocksSync } from '../../core/file-lock.ts';
import { resolveCliHome } from '../../core/paths.ts';
import { lstatIfPresentSync, statIfPresentSync } from '../../fs-utils.ts';
import type { InstallerOptions } from './args.ts';
import { preflightPurgeConfig, runPostTeardownCleanup, type CleanupReceipt } from './cleanup.ts';
import { hasAgyCli, runDoctor, toggleAgyPlugin, writeInstallerLine } from './doctor.ts';
import { makeRollbackError, runRollbackSteps, type RollbackStep } from './fs-ops.ts';
import {
  createWireRollbackSteps,
  preflightStatusLineBackup,
  restoreCliStatusLine,
  wireCliStatusLine,
  type RestoreStatusLineResult,
  type WireStatusLineResult,
} from './settings.ts';
import {
  assertShimBinDirUsable,
  assertShimWritablePreflight,
  createShimRemovalRollbackSteps,
  createShimRollbackSteps,
  formatPathHint,
  installCliShim,
  isDirOnPath,
  removeOwnedCliShim,
  type RemoveCliShimResult,
  type ShimWriteReceipt,
} from './shim.ts';

export const WIRE_REQUIRED_FILES: readonly string[] = ['plugin.json', 'dist/hud.mjs', 'dist/cli.mjs'];
const MAX_LOCK_RETRIES = 4;

export interface WireAndShimReceipts {
  wireReceipt: WireStatusLineResult | null;
  shimReceipt: ShimWriteReceipt | null;
}

export interface ApplyWireShimDoctorOptions {
  opts: InstallerOptions;
  cliHome: string;
  resolvedDst: string;
  packageRoot: string;
  wireStatusLine: boolean;
  agyAvailable: boolean;
  doctorFailMessage: string;
  receipts: WireAndShimReceipts;
}

export interface TeardownReceipts {
  removedShim: RemoveCliShimResult | null;
  restored: RestoreStatusLineResult | null;
  cleanup?: CleanupReceipt | null;
}

export function applyWireShimAndDoctor(input: ApplyWireShimDoctorOptions): void {
  const { opts, cliHome, resolvedDst, packageRoot, wireStatusLine, agyAvailable, doctorFailMessage, receipts } = input;
  if (wireStatusLine) {
    receipts.wireReceipt = wireCliStatusLine(cliHome, resolvedDst);
    if (!opts.quiet) writeInstallerLine(`Wired statusLine in ${receipts.wireReceipt.settingsPath}`);
  }
  if (opts.manageShim) {
    receipts.shimReceipt = installCliShim(opts.binDir, resolvedDst);
    if (!opts.quiet) writeInstallerLine(`Installed CLI shim at ${receipts.shimReceipt.primaryPath}`);
  }
  const { ok } = runDoctor({
    targetDir: resolvedDst,
    quiet: opts.quiet,
    packageRoot,
    binDir: opts.binDir,
    requireShim: opts.manageShim,
    noShim: opts.noShim,
    checkMalformedShim: opts.manageShim,
    agyAvailable,
  });
  if (!ok) throw new Error(doctorFailMessage);
}

export function printPathHintIfNeeded(opts: InstallerOptions): void {
  if (opts.manageShim && !opts.quiet && !isDirOnPath(opts.binDir)) {
    writeInstallerLine(formatPathHint(opts.binDir));
  }
}

export interface DynamicInstallerLockOptions {
  readonly includeCliHome: boolean;
  readonly binDir?: string;
}

export interface DynamicInstallerLockState {
  readonly lockTarget: boolean;
  readonly lockCliHome: boolean;
  readonly lockBinDir: boolean;
}

function isExistingDirectory(dirPath: string): boolean {
  return statIfPresentSync(dirPath)?.isDirectory() === true;
}

// Teardown commands must never mkdir missing host/bin directories solely to place `.lock` files,
// so re-check inside acquired locks and retry if a concurrent install/wire created a directory mid-flight.
export function withDynamicInstallerLocks(
  resolvedDst: string,
  cliHome: string,
  options: DynamicInstallerLockOptions,
  fn: (state: DynamicInstallerLockState) => void,
): void {
  const { includeCliHome } = options;
  const resolvedBinDir = options.binDir !== undefined ? path.resolve(options.binDir) : null;
  let lockTarget = lstatIfPresentSync(path.dirname(resolvedDst)) !== null;
  let lockCliHome = includeCliHome && lstatIfPresentSync(cliHome) !== null;
  let lockBinDir = resolvedBinDir !== null && isExistingDirectory(resolvedBinDir);

  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt += 1) {
    const locks: string[] = [];
    if (lockTarget) locks.push(getTargetLockPath(resolvedDst));
    if (lockCliHome) locks.push(getCliHomeLockPath(cliHome));
    if (lockBinDir && resolvedBinDir !== null) locks.push(getShimBinLockPath(resolvedBinDir));
    const outcome = withFileLocksSync(locks, (): 'done' | 'retry' => {
      const needTarget = !lockTarget && lstatIfPresentSync(path.dirname(resolvedDst)) !== null;
      const needCliHome = includeCliHome && !lockCliHome && lstatIfPresentSync(cliHome) !== null;
      const needBinDir = resolvedBinDir !== null && !lockBinDir && isExistingDirectory(resolvedBinDir);
      if (needTarget || needCliHome || needBinDir) {
        if (needTarget) lockTarget = true;
        if (needCliHome) lockCliHome = true;
        if (needBinDir) lockBinDir = true;
        return 'retry';
      }
      fn({ lockTarget, lockCliHome, lockBinDir });
      return 'done';
    });
    if (outcome === 'done') return;
  }
  throw new Error('Failed to stabilize installer locks after maximum retries.');
}

export function teardownShimAndStatusLine(
  opts: InstallerOptions,
  cliHome: string,
  resolvedDst: string,
  restoreStatusLine: boolean,
  receipts: TeardownReceipts,
  removeShim: boolean,
): void {
  if (removeShim) {
    receipts.removedShim = removeOwnedCliShim(opts.binDir, resolvedDst);
  }
  if (restoreStatusLine) {
    receipts.restored = restoreCliStatusLine(cliHome, resolvedDst);
  }
}

export function printTeardownResults(receipts: TeardownReceipts, quiet: boolean): void {
  if (receipts.restored?.changed && !quiet) {
    writeInstallerLine('Restored prior statusLine configuration.');
    if (receipts.restored.removedBackupPath) {
      writeInstallerLine(`Removed statusLine backup at ${receipts.restored.removedBackupPath}`);
    }
  } else if (receipts.restored?.skippedReason === 'not-owned' && !quiet) {
    writeInstallerLine('Skipped statusLine restore: current statusLine does not point to this installation.');
  }
  printShimRemovalResult(receipts.removedShim, quiet);
  const cleanup = receipts.cleanup;
  if (!quiet && cleanup) {
    if (cleanup.removedCaches.length > 0) {
      const names = cleanup.removedCaches.map((p) => path.basename(p));
      writeInstallerLine(
        `Removed ${cleanup.removedCaches.length} transient agy-hud cache file(s) (${names.join(', ')}).`,
      );
    }
    for (const bkp of cleanup.removedBackups) {
      writeInstallerLine(`Removed orphaned statusLine backup at ${bkp}`);
    }
    if (cleanup.skippedBackupReason === 'owned-other-live') {
      writeInstallerLine('Skipped statusLine backup purge: settings.json is wired to another active agy-hud install.');
    }
    if (cleanup.removedConfig !== null) {
      writeInstallerLine(`Removed ${cleanup.removedConfig}`);
    } else if (cleanup.configPreserved) {
      writeInstallerLine('Preserved hud-config.json (pass --purge to remove user HUD preferences).');
    }
  }
}

function assertInstalledPluginReady(resolvedDst: string): void {
  const dstStat = statIfPresentSync(resolvedDst);
  if (dstStat === null || !dstStat.isDirectory()) {
    throw new Error(`Plugin not found at ${resolvedDst}. Install via 'agy plugin install' or 'install' first.`);
  }
  for (const rel of WIRE_REQUIRED_FILES) {
    const fileStat = statIfPresentSync(path.join(resolvedDst, rel));
    if (fileStat === null || !fileStat.isFile()) {
      throw new Error(`Missing required file at ${resolvedDst}: ${rel}. Reinstall or run 'pnpm build' first.`);
    }
  }
}

function printShimRemovalResult(result: RemoveCliShimResult | null, quiet: boolean): void {
  if (quiet || !result) return;
  if (result.removed) {
    writeInstallerLine(`Removed CLI shim at ${result.primaryPath}`);
  } else if (result.skippedReason === 'foreign') {
    writeInstallerLine(`Skipped CLI shim removal: ${result.primaryPath} is not owned by agy-hud.`);
  } else if (result.skippedReason === 'owned-other') {
    writeInstallerLine(`Skipped CLI shim removal: ${result.primaryPath} belongs to another agy-hud installation.`);
  }
}

export function runWire(opts: InstallerOptions, packageRoot: string): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();
  assertInstalledPluginReady(resolvedDst);
  if (opts.manageShim) assertShimBinDirUsable(opts.binDir);

  const locks = [getTargetLockPath(resolvedDst), getCliHomeLockPath(cliHome)];
  if (opts.manageShim) locks.push(getShimBinLockPath(opts.binDir));
  withFileLocksSync(locks, () => {
    assertInstalledPluginReady(resolvedDst);
    preflightStatusLineBackup(cliHome, resolvedDst, 'wire');
    if (opts.manageShim) assertShimWritablePreflight(opts.binDir, resolvedDst);

    const receipts: WireAndShimReceipts = { wireReceipt: null, shimReceipt: null };
    const agyAvailable = hasAgyCli();

    try {
      applyWireShimAndDoctor({
        opts,
        cliHome,
        resolvedDst,
        packageRoot,
        wireStatusLine: true,
        agyAvailable,
        doctorFailMessage: 'Post-wire doctor check failed.',
        receipts,
      });
    } catch (err) {
      const steps: RollbackStep[] = [
        ...createShimRollbackSteps(receipts.shimReceipt),
        ...createWireRollbackSteps(receipts.wireReceipt),
      ];
      throw makeRollbackError(err, runRollbackSteps(steps));
    }

    toggleAgyPlugin(opts, 'enable', agyAvailable);
    printPathHintIfNeeded(opts);
  });
}

export function runUnwire(opts: InstallerOptions): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();

  withDynamicInstallerLocks(
    resolvedDst,
    cliHome,
    { includeCliHome: true, binDir: opts.manageShim ? opts.binDir : undefined },
    ({ lockCliHome, lockBinDir }) => {
      if (lockCliHome) {
        preflightStatusLineBackup(cliHome, resolvedDst, 'restore', opts.purge);
        if (opts.purge) preflightPurgeConfig(cliHome);
      }

      const receipts: TeardownReceipts = { removedShim: null, restored: null, cleanup: null };
      try {
        teardownShimAndStatusLine(opts, cliHome, resolvedDst, lockCliHome, receipts, opts.manageShim && lockBinDir);
      } catch (err) {
        const steps = createShimRemovalRollbackSteps(receipts.removedShim);
        throw makeRollbackError(err, runRollbackSteps(steps));
      }
      if (lockCliHome) {
        receipts.cleanup = runPostTeardownCleanup(cliHome, resolvedDst, opts.purge);
      }

      printTeardownResults(receipts, opts.quiet);
      const hadCleanup =
        (receipts.cleanup?.removedCaches.length ?? 0) > 0 ||
        (receipts.cleanup?.removedBackups.length ?? 0) > 0 ||
        Boolean(receipts.cleanup?.removedConfig);
      if (!opts.quiet && !receipts.restored?.changed && !receipts.removedShim?.removed && !hadCleanup) {
        writeInstallerLine('Nothing to unwire.');
      }
    },
  );
}
