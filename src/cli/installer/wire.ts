import path from 'node:path';

import { getCliHomeLockPath, getTargetLockPath, withFileLocksSync } from '../../core/file-lock.ts';
import { resolveCliHome } from '../../core/paths.ts';
import { lstatIfPresentSync } from '../../fs-utils.ts';
import type { InstallerOptions } from './args.ts';
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

const WIRE_REQUIRED_FILES: readonly string[] = ['plugin.json', 'dist/hud.mjs', 'dist/cli.mjs'];
const MAX_UNWIRE_LOCK_RETRIES = 3;

function assertInstalledPluginReady(resolvedDst: string): void {
  if (lstatIfPresentSync(resolvedDst) === null) {
    throw new Error(`Plugin not found at ${resolvedDst}. Install via 'agy plugin install' or 'install' first.`);
  }
  for (const rel of WIRE_REQUIRED_FILES) {
    if (lstatIfPresentSync(path.join(resolvedDst, rel)) === null) {
      throw new Error(`Missing required file at ${resolvedDst}: ${rel}. Reinstall or run 'pnpm build' first.`);
    }
  }
}

export function printShimRemovalResult(result: RemoveCliShimResult | null, quiet: boolean): void {
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

  withFileLocksSync([getTargetLockPath(resolvedDst), getCliHomeLockPath(cliHome)], () => {
    assertInstalledPluginReady(resolvedDst);
    preflightStatusLineBackup(cliHome, resolvedDst, 'wire');
    if (opts.manageShim) assertShimWritablePreflight(opts.binDir, resolvedDst);

    let wireReceipt: WireStatusLineResult | null = null;
    let shimReceipt: ShimWriteReceipt | null = null;
    const agyAvailable = hasAgyCli();

    try {
      wireReceipt = wireCliStatusLine(cliHome, resolvedDst);
      if (!opts.quiet) writeInstallerLine(`Wired statusLine in ${wireReceipt.settingsPath}`);
      if (opts.manageShim) {
        shimReceipt = installCliShim(opts.binDir, resolvedDst);
        if (!opts.quiet) writeInstallerLine(`Installed CLI shim at ${shimReceipt.primaryPath}`);
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
      if (!ok) throw new Error('Post-wire doctor check failed.');
    } catch (err) {
      const steps: RollbackStep[] = [...createShimRollbackSteps(shimReceipt), ...createWireRollbackSteps(wireReceipt)];
      throw makeRollbackError(err, runRollbackSteps(steps));
    }

    toggleAgyPlugin(opts, 'enable', agyAvailable);
    if (opts.manageShim && !opts.quiet && !isDirOnPath(opts.binDir)) {
      writeInstallerLine(formatPathHint(opts.binDir));
    }
  });
}

export function runUnwire(opts: InstallerOptions): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();
  let lockTarget = lstatIfPresentSync(path.dirname(resolvedDst)) !== null;
  let lockCliHome = lstatIfPresentSync(cliHome) !== null;

  for (let attempt = 0; attempt < MAX_UNWIRE_LOCK_RETRIES; attempt += 1) {
    const locks: string[] = [];
    if (lockTarget) locks.push(getTargetLockPath(resolvedDst));
    if (lockCliHome) locks.push(getCliHomeLockPath(cliHome));
    const outcome = withFileLocksSync(locks, (): 'done' | 'retry' => {
      const needTarget = !lockTarget && lstatIfPresentSync(path.dirname(resolvedDst)) !== null;
      const needCliHome = !lockCliHome && lstatIfPresentSync(cliHome) !== null;
      if (needTarget || needCliHome) {
        if (needTarget) lockTarget = true;
        if (needCliHome) lockCliHome = true;
        return 'retry';
      }

      if (lockCliHome) {
        preflightStatusLineBackup(cliHome, resolvedDst, 'restore');
      }

      let removedShim: RemoveCliShimResult | null = null;
      let restored: RestoreStatusLineResult | null = null;
      try {
        if (opts.manageShim) {
          removedShim = removeOwnedCliShim(opts.binDir, resolvedDst);
        }
        if (lockCliHome) {
          restored = restoreCliStatusLine(cliHome, resolvedDst);
        }
      } catch (err) {
        const steps = createShimRemovalRollbackSteps(removedShim);
        throw makeRollbackError(err, runRollbackSteps(steps));
      }

      if (restored?.changed && !opts.quiet) writeInstallerLine('Restored prior statusLine configuration.');
      else if (restored?.skippedReason === 'not-owned' && !opts.quiet) {
        writeInstallerLine('Skipped statusLine restore: current statusLine does not point to this installation.');
      }
      printShimRemovalResult(removedShim, opts.quiet);
      if (!opts.quiet && !restored?.changed && !removedShim?.removed) {
        writeInstallerLine('Nothing to unwire.');
      }
      return 'done';
    });
    if (outcome === 'done') return;
  }
}
