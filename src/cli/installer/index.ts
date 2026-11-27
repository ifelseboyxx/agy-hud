import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCliHomeLockPath, getShimBinLockPath, getTargetLockPath, withFileLocksSync } from '../../core/file-lock.ts';
import { lstatIfPresentSync, makeTempSuffix } from '../../core/fs-utils.ts';
import { resolveCliHome } from '../../core/paths.ts';
import { getSettingsPaths } from '../../core/statusline-ownership.ts';
import { INSTALLER_HELP_TEXT, parseInstallerArgs, PLUGIN_NAME, type InstallerOptions } from './args.ts';
import { preflightPurgeConfig, runPostTeardownCleanup } from './cleanup.ts';
import {
  hasAgyCli,
  type InstallerRuntimeContext,
  runDoctor,
  toggleAgyPlugin,
  uninstallAgyPlugin,
  writeInstallerLine,
} from './doctor.ts';
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
  stdout?: { write(chunk: string): boolean },
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
    if (!opts.quiet) writeInstallerLine(`Linked ${resolvedDst} -> ${resolvedSrc}`, stdout);
    return;
  }
  const stagedNewPath = stage.stagedNewPath;
  if (stagedNewPath === null) return;
  const stagedIdentity = lstatIfPresentSync(stagedNewPath);
  renameSync(stagedNewPath, resolvedDst);
  stage.stagedNewPath = null;
  stage.createdTarget = true;
  stage.createdIdentity = stagedIdentity;
  if (!opts.quiet) writeInstallerLine(`Installed ${PLUGIN_NAME} to ${resolvedDst}`, stdout);
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

function runInstall(opts: InstallerOptions, runtime?: InstallerRuntimeContext): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const env = runtime?.env ?? process.env;
  const cliHome = resolveCliHome(runtime?.cliHome, env);
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
    const agyAvailable = hasAgyCli(env);

    try {
      if (sameDirectory) {
        if (!opts.quiet) {
          writeInstallerLine(`Repository is already at target plugin directory: ${resolvedDst}`, runtime?.stdout);
        }
      } else {
        stagePluginInstall(stage, opts, resolvedSrc, resolvedDst, dstStat, makeTempSuffix(), runtime?.stdout);
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
        runtime,
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

    toggleAgyPlugin(opts, 'enable', agyAvailable, runtime);
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
    printPathHintIfNeeded(opts, runtime);
  });
}

function runUninstall(opts: InstallerOptions, runtime?: InstallerRuntimeContext): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const env = runtime?.env ?? process.env;
  const cliHome = resolveCliHome(runtime?.cliHome, env);
  const resolvedSrc = realpathSync(PACKAGE_ROOT);
  assertNotActiveSourceRepo(resolvedSrc, resolvedDst, lstatIfPresentSync(resolvedDst));

  withDynamicInstallerLocks(
    resolvedDst,
    cliHome,
    {
      includeCliHome: true,
      binDir: opts.manageShim ? opts.binDir : undefined,
    },
    ({ lockTarget, lockCliHome, lockBinDir }) => {
      const dstStat = lockTarget ? lstatIfPresentSync(resolvedDst) : null;
      if (dstStat) {
        assertNotActiveSourceRepo(resolvedSrc, resolvedDst, dstStat);
        assertRemovableTarget(resolvedDst, dstStat, PLUGIN_NAME);
        if (!dstStat.isSymbolicLink()) assertDirectoryTreeRemovable(resolvedDst);
      }
      const shouldRestoreStatusLine = (opts.restoreStatusLine || opts.purge) && lockCliHome;
      if (shouldRestoreStatusLine) {
        preflightStatusLineBackup(cliHome, resolvedDst, 'restore', opts.purge);
      }
      if (opts.purge && lockCliHome) {
        preflightPurgeConfig(cliHome);
      }
      const useHostPluginUninstall = !opts.isProject && !opts.isCustomTarget && !opts.skipEnable && hasAgyCli();
      const stagedRemovalPath =
        dstStat && !useHostPluginUninstall ? `${resolvedDst}.removing.${makeTempSuffix()}` : null;
      let movedToStaging = false;
      const receipts: TeardownReceipts = { removedShim: null, restored: null, cleanup: null };
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
      if (movedToStaging && stagedRemovalPath !== null && dstStat !== null) {
        try {
          removeVerifiedStagedPath(stagedRemovalPath, dstStat);
        } catch (cleanupErr) {
          const detail = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          throw new Error(
            `Uninstalled ${PLUGIN_NAME} from ${resolvedDst}, but failed to remove staged directory ${stagedRemovalPath}: ${detail}`,
          );
        }
      }
      if (lockCliHome) {
        receipts.cleanup = runPostTeardownCleanup(cliHome, resolvedDst, opts.purge);
      }
      printTeardownResults(receipts, opts.quiet, runtime?.stdout);
      if (!dstStat) {
        if (useHostPluginUninstall) {
          const hostRes = uninstallAgyPlugin(opts, true, env);
          if (hostRes.ok) {
            if (!opts.quiet) {
              writeInstallerLine(
                `Removed stale ${PLUGIN_NAME} host registration via agy plugin uninstall.`,
                runtime?.stdout,
              );
            }
            return;
          }
          const isAlreadyAbsent = /not installed|not found|no such plugin|does not exist/i.test(hostRes.detail);
          if (hostRes.attempted && !isAlreadyAbsent) {
            const detail = hostRes.detail.length > 0 ? `: ${hostRes.detail}` : '';
            throw new Error(
              `'agy plugin uninstall ${PLUGIN_NAME}' failed while checking stale host registration${detail}.`,
            );
          }
        }
        const hadCleanup =
          (receipts.cleanup?.removedCaches.length ?? 0) > 0 ||
          (receipts.cleanup?.removedBackups.length ?? 0) > 0 ||
          Boolean(receipts.cleanup?.removedConfig);
        if (!opts.quiet && !receipts.removedShim?.removed && !hadCleanup) {
          writeInstallerLine(`Nothing to remove (${resolvedDst} does not exist).`, runtime?.stdout);
        }
        return;
      }
      if (useHostPluginUninstall) {
        const hostRes = uninstallAgyPlugin(opts, true, env);
        const remainingStat = lstatIfPresentSync(resolvedDst);
        if (!hostRes.ok) {
          const detail = hostRes.detail.length > 0 ? `: ${hostRes.detail}` : '';
          throw new Error(
            `Detached statusLine/shim/caches, but 'agy plugin uninstall ${PLUGIN_NAME}' failed${detail}. ` +
              `Run 'agy plugin uninstall ${PLUGIN_NAME}' manually to remove host registration and ${resolvedDst}.`,
          );
        }
        if (remainingStat !== null) {
          if (!isSameStatIdentity(remainingStat, dstStat)) {
            throw new Error(`Target changed during host uninstall; refusing to delete ${resolvedDst}.`);
          }
          assertRemovableTarget(resolvedDst, remainingStat, PLUGIN_NAME);
          removeTargetPath(resolvedDst, remainingStat);
        }
        if (!opts.quiet) writeInstallerLine(`Removed ${PLUGIN_NAME} from ${resolvedDst}`, runtime?.stdout);
        return;
      }
      if (!opts.quiet) writeInstallerLine(`Removed ${PLUGIN_NAME} from ${resolvedDst}`, runtime?.stdout);
    },
  );
}

function runToggle(opts: InstallerOptions, enable: boolean, runtime?: InstallerRuntimeContext): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const env = runtime?.env ?? process.env;
  const cliHome = resolveCliHome(runtime?.cliHome, env);
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
      toggleAgyPlugin(opts, 'enable', undefined, runtime);
      if (!opts.quiet) writeInstallerLine(`Enabled agy-hud statusLine in ${settingsPath}`, runtime?.stdout);
      return;
    }
    const disabled = disableCliStatusLine(cliHome, resolvedDst);
    toggleAgyPlugin(opts, 'disable', undefined, runtime);
    if (!opts.quiet) {
      const msg = disabled.changed
        ? `Disabled agy-hud statusLine in ${settingsPath}`
        : disabled.skippedReason === 'not-configured'
          ? `Skipped statusLine disable: statusLine is not configured in ${settingsPath}.`
          : `Skipped statusLine disable: current statusLine does not point to this installation.`;
      writeInstallerLine(msg, runtime?.stdout);
    }
  });
}

export function runInstallerCli(args: readonly string[], runtime?: InstallerRuntimeContext): number {
  const opts = parseInstallerArgs(args, runtime?.env);
  if (opts.showHelp) {
    writeInstallerLine(INSTALLER_HELP_TEXT, runtime?.stdout);
    return 0;
  }
  switch (opts.command) {
    case 'wire':
      runWire(opts, PACKAGE_ROOT, runtime);
      return 0;
    case 'unwire':
      runUnwire(opts, runtime);
      return 0;
    case 'install':
      runInstall(opts, runtime);
      return 0;
    case 'uninstall':
      runUninstall(opts, runtime);
      return 0;
    case 'on':
    case 'enable':
      runToggle(opts, true, runtime);
      return 0;
    case 'off':
    case 'disable':
      runToggle(opts, false, runtime);
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
        cliHome: runtime?.cliHome,
        env: runtime?.env,
        stdout: runtime?.stdout,
      });
      return ok ? 0 : 1;
    }
  }
}
