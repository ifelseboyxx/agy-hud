import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCliHomeLockPath, getShimBinLockPath, getTargetLockPath, withFileLocksSync } from '../../core/file-lock.ts';
import { resolveCliHome } from '../../core/paths.ts';
import { getSettingsPaths } from '../../core/statusline-ownership.ts';
import { lstatIfPresentSync, makeTempSuffix } from '../../fs-utils.ts';
import { INSTALLER_HELP_TEXT, parseInstallerArgs, PLUGIN_NAME, type InstallerOptions } from './args.ts';
import { hasAgyCli, runDoctor, toggleAgyPlugin, writeInstallerLine } from './doctor.ts';
import {
  assertDirectoryTreeRemovable,
  assertNotActiveSourceRepo,
  assertRemovableTarget,
  assertRuntimeFilesPresent,
  copyRuntimeFiles,
  inspectTargetRelationship,
  isSameStatIdentity,
  makeRollbackError,
  moveVerifiedTarget,
  removeTargetPath,
  removeVerifiedStagedPath,
  runRollbackSteps,
  type RollbackStep,
} from './fs-ops.ts';
import {
  createWireRollbackSteps,
  disableCliStatusLine,
  preflightStatusLineBackup,
  wireCliStatusLine,
  type WireStatusLineResult,
} from './settings.ts';
import {
  assertShimBinDirUsable,
  assertShimWritablePreflight,
  createShimRemovalRollbackSteps,
  createShimRollbackSteps,
  type ShimWriteReceipt,
} from './shim.ts';
import {
  applyWireShimAndDoctor,
  printPathHintIfNeeded,
  printTeardownResults,
  runUnwire,
  runWire,
  teardownShimAndStatusLine,
  WIRE_REQUIRED_FILES,
  withDynamicInstallerLocks,
  type TeardownReceipts,
  type WireAndShimReceipts,
} from './wire.ts';

const RUNTIME_FILES: readonly string[] = [
  ...WIRE_REQUIRED_FILES,
  'assets/logo.svg',
  'dist/index.mjs',
  'dist/index.d.mts',
  'dist/types.d.mts',
  'scripts/install.mjs',
];

function resolvePackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, 'plugin.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const PACKAGE_ROOT = resolvePackageRoot();

interface InstallStageState {
  stagedPrevPath: string | null;
  prevIdentity: Stats | null;
  stagedNewPath: string | null;
  prevMoved: boolean;
  createdTarget: boolean;
  createdIdentity: Stats | null;
}

function pathExists(p: string): boolean {
  return lstatIfPresentSync(p) !== null;
}

function stagePluginInstall(
  stage: InstallStageState,
  opts: InstallerOptions,
  resolvedSrc: string,
  resolvedDst: string,
  dstStat: Stats | null,
  suffix: string,
): void {
  mkdirSync(path.dirname(resolvedDst), { recursive: true });
  if (!opts.useLink) {
    const stagedNewPath = `${resolvedDst}.new.${suffix}`;
    stage.stagedNewPath = stagedNewPath;
    copyRuntimeFiles(resolvedSrc, stagedNewPath, RUNTIME_FILES);
  }
  if (dstStat) {
    const stagedPrevPath = `${resolvedDst}.prev.${suffix}`;
    stage.stagedPrevPath = stagedPrevPath;
    stage.prevIdentity = dstStat;
    moveVerifiedTarget(resolvedDst, dstStat, stagedPrevPath);
    stage.prevMoved = true;
  } else if (lstatIfPresentSync(resolvedDst) !== null) {
    throw new Error(`Target appeared concurrently before install commit: ${resolvedDst}`);
  }
  if (opts.useLink) {
    symlinkSync(resolvedSrc, resolvedDst, process.platform === 'win32' ? 'junction' : 'dir');
    stage.createdTarget = true;
    stage.createdIdentity = lstatIfPresentSync(resolvedDst);
    if (!opts.quiet) writeInstallerLine(`Linked ${resolvedDst} -> ${resolvedSrc}`);
    return;
  }
  const stagedNewPath = stage.stagedNewPath;
  if (stagedNewPath === null) return;
  const stagedIdentity = lstatIfPresentSync(stagedNewPath);
  renameSync(stagedNewPath, resolvedDst);
  stage.stagedNewPath = null;
  stage.createdTarget = true;
  stage.createdIdentity = stagedIdentity;
  if (!opts.quiet) writeInstallerLine(`Installed ${PLUGIN_NAME} to ${resolvedDst}`);
}

function buildInstallRollbackSteps(
  wireReceipt: WireStatusLineResult | null,
  shimReceipt: ShimWriteReceipt | null,
  stage: InstallStageState,
  resolvedDst: string,
  sameDirectory: boolean,
): RollbackStep[] {
  const ownsTarget = (): boolean => {
    if (!stage.createdTarget || sameDirectory) return true;
    return isSameStatIdentity(lstatIfPresentSync(resolvedDst), stage.createdIdentity);
  };
  const steps: RollbackStep[] = [
    ...createShimRollbackSteps(shimReceipt, ownsTarget),
    ...createWireRollbackSteps(wireReceipt, ownsTarget),
  ];
  const stagedNewPath = stage.stagedNewPath;
  if (stagedNewPath !== null) {
    steps.push([
      'clean staged install',
      () => {
        const st = lstatIfPresentSync(stagedNewPath);
        if (st) removeTargetPath(stagedNewPath, st);
      },
    ]);
  }
  if (stage.createdTarget && !sameDirectory) {
    steps.push([
      'remove failed install',
      () => {
        const curStat = lstatIfPresentSync(resolvedDst);
        if (curStat && isSameStatIdentity(curStat, stage.createdIdentity)) removeTargetPath(resolvedDst, curStat);
      },
    ]);
  }
  const stagedPrevPath = stage.stagedPrevPath;
  if (stage.prevMoved && stagedPrevPath !== null) {
    steps.push([
      'restore prior install',
      () => {
        if (!pathExists(resolvedDst) && isSameStatIdentity(lstatIfPresentSync(stagedPrevPath), stage.prevIdentity)) {
          renameSync(stagedPrevPath, resolvedDst);
        }
      },
    ]);
  }
  return steps;
}

function runInstall(opts: InstallerOptions): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();
  if (opts.manageShim) assertShimBinDirUsable(opts.binDir);
  const locks = [getTargetLockPath(resolvedDst)];
  if (opts.wireStatusLine || opts.manageShim) locks.push(getCliHomeLockPath(cliHome));
  if (opts.manageShim) locks.push(getShimBinLockPath(opts.binDir));
  withFileLocksSync(locks, () => {
    const resolvedSrc = realpathSync(PACKAGE_ROOT);
    const dstStat = lstatIfPresentSync(resolvedDst);
    const { sameDirectory } = inspectTargetRelationship(resolvedSrc, resolvedDst, dstStat);
    assertRuntimeFilesPresent(resolvedSrc, RUNTIME_FILES);
    if (!sameDirectory && dstStat) {
      assertRemovableTarget(resolvedDst, dstStat, PLUGIN_NAME);
      if (!dstStat.isSymbolicLink()) assertDirectoryTreeRemovable(resolvedDst);
    }

    if (opts.wireStatusLine) {
      preflightStatusLineBackup(cliHome, resolvedDst, 'wire');
    }
    if (opts.manageShim) assertShimWritablePreflight(opts.binDir, resolvedDst);

    const stage: InstallStageState = {
      stagedPrevPath: null,
      prevIdentity: null,
      stagedNewPath: null,
      prevMoved: false,
      createdTarget: false,
      createdIdentity: null,
    };
    const receipts: WireAndShimReceipts = { wireReceipt: null, shimReceipt: null };
    const agyAvailable = hasAgyCli();

    try {
      if (sameDirectory) {
        if (!opts.quiet) writeInstallerLine(`Repository is already at target plugin directory: ${resolvedDst}`);
      } else {
        stagePluginInstall(stage, opts, resolvedSrc, resolvedDst, dstStat, makeTempSuffix());
      }
      applyWireShimAndDoctor({
        opts,
        cliHome,
        resolvedDst,
        packageRoot: PACKAGE_ROOT,
        wireStatusLine: opts.wireStatusLine,
        agyAvailable,
        doctorFailMessage: 'Post-install doctor check failed.',
        receipts,
      });
    } catch (err) {
      const steps = buildInstallRollbackSteps(
        receipts.wireReceipt,
        receipts.shimReceipt,
        stage,
        resolvedDst,
        sameDirectory,
      );
      throw makeRollbackError(err, runRollbackSteps(steps));
    }

    toggleAgyPlugin(opts, 'enable', agyAvailable);
    if (stage.prevMoved && stage.stagedPrevPath !== null && stage.prevIdentity !== null) {
      try {
        removeVerifiedStagedPath(stage.stagedPrevPath, stage.prevIdentity);
      } catch (cleanupErr) {
        const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        throw new Error(
          `Installed ${PLUGIN_NAME} to ${resolvedDst}, but failed to remove previous directory ${stage.stagedPrevPath}: ${detail}`,
        );
      }
    }
    printPathHintIfNeeded(opts);
  });
}

function runUninstall(opts: InstallerOptions): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();
  const resolvedSrc = realpathSync(PACKAGE_ROOT);
  assertNotActiveSourceRepo(resolvedSrc, resolvedDst, lstatIfPresentSync(resolvedDst));

  withDynamicInstallerLocks(
    resolvedDst,
    cliHome,
    {
      includeCliHome: opts.restoreStatusLine || opts.manageShim,
      binDir: opts.manageShim ? opts.binDir : undefined,
    },
    ({ lockTarget, lockCliHome, lockBinDir }) => {
      const dstStat = lockTarget ? lstatIfPresentSync(resolvedDst) : null;
      if (dstStat) {
        assertNotActiveSourceRepo(resolvedSrc, resolvedDst, dstStat);
        assertRemovableTarget(resolvedDst, dstStat, PLUGIN_NAME);
        if (!dstStat.isSymbolicLink()) assertDirectoryTreeRemovable(resolvedDst);
      }
      const shouldRestoreStatusLine = opts.restoreStatusLine && lockCliHome;
      if (shouldRestoreStatusLine) {
        preflightStatusLineBackup(cliHome, resolvedDst, 'restore');
      }
      const stagedRemovalPath = dstStat ? `${resolvedDst}.removing.${makeTempSuffix()}` : null;
      let movedToStaging = false;
      const receipts: TeardownReceipts = { removedShim: null, restored: null };
      try {
        if (dstStat && stagedRemovalPath !== null) {
          moveVerifiedTarget(resolvedDst, dstStat, stagedRemovalPath);
          movedToStaging = true;
        }
        teardownShimAndStatusLine(
          opts,
          cliHome,
          resolvedDst,
          shouldRestoreStatusLine,
          receipts,
          opts.manageShim && lockBinDir,
        );
      } catch (err) {
        const steps: RollbackStep[] = [...createShimRemovalRollbackSteps(receipts.removedShim)];
        if (movedToStaging && stagedRemovalPath !== null && dstStat !== null) {
          steps.push([
            'restore plugin target',
            () => {
              if (!pathExists(resolvedDst) && isSameStatIdentity(lstatIfPresentSync(stagedRemovalPath), dstStat)) {
                renameSync(stagedRemovalPath, resolvedDst);
              }
            },
          ]);
        }
        throw makeRollbackError(err, runRollbackSteps(steps));
      }
      printTeardownResults(receipts, opts.quiet);
      if (!dstStat) {
        if (!opts.quiet && !receipts.removedShim?.removed) {
          writeInstallerLine(`Nothing to remove (${resolvedDst} does not exist).`);
        }
        return;
      }
      toggleAgyPlugin(opts, 'disable');
      if (movedToStaging && stagedRemovalPath !== null) {
        try {
          removeVerifiedStagedPath(stagedRemovalPath, dstStat);
        } catch (cleanupErr) {
          const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          throw new Error(
            `Uninstalled ${PLUGIN_NAME} from ${resolvedDst}, but failed to remove staged directory ${stagedRemovalPath}: ${detail}`,
          );
        }
      }
      if (!opts.quiet) writeInstallerLine(`Removed ${PLUGIN_NAME} from ${resolvedDst}`);
    },
  );
}

function runToggle(opts: InstallerOptions, enable: boolean): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();
  const hudScriptPath = path.join(resolvedDst, 'dist', 'hud.mjs');
  if (enable && !pathExists(path.dirname(resolvedDst))) {
    throw new Error(`Missing ${hudScriptPath}. Run 'pnpm build' and install first.`);
  }
  const locks = enable ? [getCliHomeLockPath(cliHome), getTargetLockPath(resolvedDst)] : [getCliHomeLockPath(cliHome)];
  withFileLocksSync(locks, () => {
    const { settingsPath } = getSettingsPaths(cliHome);
    if (enable) {
      if (!pathExists(hudScriptPath)) throw new Error(`Missing ${hudScriptPath}. Run 'pnpm build' and install first.`);
      wireCliStatusLine(cliHome, resolvedDst);
      toggleAgyPlugin(opts, 'enable');
      if (!opts.quiet) writeInstallerLine(`Enabled agy-hud statusLine in ${settingsPath}`);
      return;
    }
    const disabled = disableCliStatusLine(cliHome, resolvedDst);
    toggleAgyPlugin(opts, 'disable');
    if (!opts.quiet) {
      const msg = disabled.changed
        ? `Disabled agy-hud statusLine in ${settingsPath}`
        : disabled.skippedReason === 'not-configured'
          ? `Skipped statusLine disable: statusLine is not configured in ${settingsPath}.`
          : `Skipped statusLine disable: current statusLine does not point to this installation.`;
      writeInstallerLine(msg);
    }
  });
}

export function runInstallerCli(args: readonly string[]): number {
  const opts = parseInstallerArgs(args);
  if (opts.showHelp) {
    writeInstallerLine(INSTALLER_HELP_TEXT);
    return 0;
  }
  switch (opts.command) {
    case 'wire':
      runWire(opts, PACKAGE_ROOT);
      return 0;
    case 'unwire':
      runUnwire(opts);
      return 0;
    case 'install':
      runInstall(opts);
      return 0;
    case 'uninstall':
      runUninstall(opts);
      return 0;
    case 'on':
    case 'enable':
      runToggle(opts, true);
      return 0;
    case 'off':
    case 'disable':
      runToggle(opts, false);
      return 0;
    case 'status':
    case 'doctor': {
      const { ok } = runDoctor({
        targetDir: opts.targetDir,
        quiet: opts.quiet,
        packageRoot: PACKAGE_ROOT,
        binDir: opts.binDir,
        requireShim: false,
        noShim: opts.noShim,
        checkMalformedShim: false,
      });
      return ok ? 0 : 1;
    }
  }
}
