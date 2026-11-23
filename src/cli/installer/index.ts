import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCliHomeLockPath, getTargetLockPath, withFileLocksSync } from '../../core/file-lock.ts';
import { isPlainObject } from '../../core/guards.ts';
import { resolveCliHome } from '../../core/paths.ts';
import { getSettingsPaths, isSameCommandPath } from '../../core/statusline-ownership.ts';
import { lstatIfPresentSync, makeTempSuffix, readJsonObjectSync } from '../../fs-utils.ts';
import { INSTALLER_HELP_TEXT, parseInstallerArgs, PLUGIN_NAME, type InstallerOptions } from './args.ts';
import { checkSqliteBuiltin, runAgyPluginValidate, runHudStdinSmoke } from './doctor.ts';
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
  inspectStatusLineState,
  isSupportedNodeVersion,
  NODE_RANGE_LABEL,
  readStatusLineBackupStrict,
  restoreCliStatusLine,
  wireCliStatusLine,
  type WireStatusLineResult,
} from './settings.ts';

const AGY_PROBE_TIMEOUT_MS = 10_000;
const AGY_COMMAND_TIMEOUT_MS = 10_000;
const MAX_UNINSTALL_LOCK_RETRIES = 3;

const RUNTIME_FILES: readonly string[] = [
  'plugin.json',
  'assets/logo.svg',
  'dist/hud.mjs',
  'dist/cli.mjs',
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

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function pathExists(p: string): boolean {
  return lstatIfPresentSync(p) !== null;
}

function hasAgyCli(): boolean {
  const res = spawnSync('agy', ['--version'], { stdio: 'ignore', timeout: AGY_PROBE_TIMEOUT_MS, windowsHide: true });
  return !res.error && res.status === 0;
}

function toggleAgyPlugin(opts: InstallerOptions, action: 'enable' | 'disable', agyAvailable?: boolean): void {
  if (opts.isProject || opts.isCustomTarget || opts.skipEnable || !(agyAvailable ?? hasAgyCli())) return;
  const res = spawnSync('agy', ['plugin', action, PLUGIN_NAME], { stdio: 'ignore', timeout: AGY_COMMAND_TIMEOUT_MS });
  if (action === 'enable' && !opts.quiet && (res.error || res.status !== 0)) {
    out(`Note: enable '${PLUGIN_NAME}' in Antigravity Customizations UI if needed.`);
  }
}

function runDoctor(targetDir: string, quiet: boolean, agyAvailable?: boolean): { ok: boolean } {
  const nodeVer = process.versions.node;
  if (!isSupportedNodeVersion(nodeVer)) {
    throw new Error(`Node.js ${NODE_RANGE_LABEL} required (current: v${nodeVer})`);
  }
  const resolvedTarget = path.resolve(targetDir);
  const targetExists = pathExists(resolvedTarget);
  const pluginBase = targetExists ? resolvedTarget : PACKAGE_ROOT;
  const hudPath = path.join(pluginBase, 'dist', 'hud.mjs');
  const sqliteOk = checkSqliteBuiltin();
  const hudSmoke = pathExists(hudPath)
    ? runHudStdinSmoke(hudPath, PACKAGE_ROOT)
    : { ok: false, durationMs: 0, bytes: 0, detail: 'missing dist/hud.mjs' };
  const slState = inspectStatusLineState(resolveCliHome(), resolvedTarget);
  const agyValidate =
    (agyAvailable ?? hasAgyCli()) ? runAgyPluginValidate(pluginBase, PACKAGE_ROOT, AGY_COMMAND_TIMEOUT_MS) : null;

  const ok = sqliteOk && hudSmoke.ok && slState.valid && (agyValidate === null || agyValidate.ok);
  if (!quiet) {
    const smokeDesc = hudSmoke.ok
      ? `OK (${hudSmoke.durationMs}ms, ${hudSmoke.bytes} bytes)`
      : `FAILED (${hudSmoke.detail})`;
    out('agy-hud doctor:');
    out(`  - Plugin base  : ${pluginBase}${targetExists ? '' : ' (fallback to repo; not installed at target)'}`);
    out(`  - Node.js      : v${nodeVer} (OK)`);
    out(`  - node:sqlite  : ${sqliteOk ? 'OK' : 'FAILED'}`);
    out(`  - dist/hud.mjs : ${smokeDesc}`);
    out(`  - statusLine   : ${slState.state} (${slState.settingsPath})`);
    if (agyValidate !== null) {
      out(`  - agy validate : ${agyValidate.ok ? 'PASSED (--strict)' : `FAILED (${agyValidate.output})`}`);
    }
  }
  return { ok };
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
    if (!opts.quiet) out(`Linked ${resolvedDst} -> ${resolvedSrc}`);
    return;
  }
  const stagedNewPath = stage.stagedNewPath;
  if (stagedNewPath === null) return;
  const stagedIdentity = lstatIfPresentSync(stagedNewPath);
  renameSync(stagedNewPath, resolvedDst);
  stage.stagedNewPath = null;
  stage.createdTarget = true;
  stage.createdIdentity = stagedIdentity;
  if (!opts.quiet) out(`Installed ${PLUGIN_NAME} to ${resolvedDst}`);
}

function buildInstallRollbackSteps(
  wireReceipt: WireStatusLineResult | null,
  stage: InstallStageState,
  resolvedDst: string,
  sameDirectory: boolean,
): RollbackStep[] {
  const ownsTarget = (): boolean => {
    if (!stage.createdTarget || sameDirectory) return true;
    return isSameStatIdentity(lstatIfPresentSync(resolvedDst), stage.createdIdentity);
  };
  const steps: RollbackStep[] = [...createWireRollbackSteps(wireReceipt, ownsTarget)];
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
  const locks = opts.wireStatusLine
    ? [getTargetLockPath(resolvedDst), getCliHomeLockPath(cliHome)]
    : [getTargetLockPath(resolvedDst)];
  withFileLocksSync(locks, () => {
    const resolvedSrc = realpathSync(PACKAGE_ROOT);
    const dstStat = lstatIfPresentSync(resolvedDst);
    const { sameDirectory } = inspectTargetRelationship(resolvedSrc, resolvedDst, dstStat);
    assertRuntimeFilesPresent(resolvedSrc, RUNTIME_FILES);
    if (!sameDirectory && dstStat) {
      assertRemovableTarget(resolvedDst, dstStat, PLUGIN_NAME);
      if (!dstStat.isSymbolicLink()) assertDirectoryTreeRemovable(resolvedDst);
    }

    const { settingsPath, backupPath } = getSettingsPaths(cliHome);
    const hudCmd = path.join(resolvedDst, 'dist', 'hud.mjs');
    if (opts.wireStatusLine) {
      const existingSettings = readJsonObjectSync(settingsPath, true);
      const curCmd = isPlainObject(existingSettings?.statusLine) ? existingSettings.statusLine.command : undefined;
      if (!isSameCommandPath(curCmd, hudCmd)) readStatusLineBackupStrict(backupPath);
    }

    const stage: InstallStageState = {
      stagedPrevPath: null,
      prevIdentity: null,
      stagedNewPath: null,
      prevMoved: false,
      createdTarget: false,
      createdIdentity: null,
    };
    let wireReceipt: WireStatusLineResult | null = null;
    const agyAvailable = hasAgyCli();

    try {
      if (sameDirectory) {
        if (!opts.quiet) out(`Repository is already at target plugin directory: ${resolvedDst}`);
      } else {
        stagePluginInstall(stage, opts, resolvedSrc, resolvedDst, dstStat, makeTempSuffix());
      }
      if (opts.wireStatusLine) {
        wireReceipt = wireCliStatusLine(cliHome, resolvedDst);
        if (!opts.quiet) out(`Wired statusLine in ${wireReceipt.settingsPath}`);
      }
      const { ok } = runDoctor(resolvedDst, opts.quiet, agyAvailable);
      if (!ok) throw new Error('Post-install doctor check failed.');
    } catch (err) {
      const steps = buildInstallRollbackSteps(wireReceipt, stage, resolvedDst, sameDirectory);
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
  });
}

function runUninstall(opts: InstallerOptions): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();
  const resolvedSrc = realpathSync(PACKAGE_ROOT);
  assertNotActiveSourceRepo(resolvedSrc, resolvedDst, lstatIfPresentSync(resolvedDst));
  let lockTarget = pathExists(path.dirname(resolvedDst));
  let lockCliHome = opts.restoreStatusLine && pathExists(cliHome);

  for (let attempt = 0; attempt < MAX_UNINSTALL_LOCK_RETRIES; attempt += 1) {
    const locks: string[] = [];
    if (lockTarget) locks.push(getTargetLockPath(resolvedDst));
    if (lockCliHome) locks.push(getCliHomeLockPath(cliHome));
    const outcome = withFileLocksSync(locks, (): 'done' | 'retry' => {
      const needTarget = !lockTarget && pathExists(path.dirname(resolvedDst));
      const needCliHome = opts.restoreStatusLine && !lockCliHome && pathExists(cliHome);
      if (needTarget || needCliHome) {
        if (needTarget) lockTarget = true;
        if (needCliHome) lockCliHome = true;
        return 'retry';
      }
      const dstStat = lockTarget ? lstatIfPresentSync(resolvedDst) : null;
      const { settingsPath, backupPath } = getSettingsPaths(cliHome);
      const hudCmd = path.join(resolvedDst, 'dist', 'hud.mjs');
      if (dstStat) {
        assertNotActiveSourceRepo(resolvedSrc, resolvedDst, dstStat);
        assertRemovableTarget(resolvedDst, dstStat, PLUGIN_NAME);
        if (!dstStat.isSymbolicLink()) assertDirectoryTreeRemovable(resolvedDst);
      }
      if (opts.restoreStatusLine && lockCliHome) {
        const existingSettings = readJsonObjectSync(settingsPath, true);
        const curCmd = isPlainObject(existingSettings?.statusLine) ? existingSettings.statusLine.command : undefined;
        if (isSameCommandPath(curCmd, hudCmd)) readStatusLineBackupStrict(backupPath);
      }
      const stagedRemovalPath = dstStat ? `${resolvedDst}.removing.${makeTempSuffix()}` : null;
      let movedToStaging = false;
      let restored = null;
      try {
        if (dstStat && stagedRemovalPath !== null) {
          moveVerifiedTarget(resolvedDst, dstStat, stagedRemovalPath);
          movedToStaging = true;
        }
        if (opts.restoreStatusLine && lockCliHome) {
          restored = restoreCliStatusLine(cliHome, resolvedDst);
        }
      } catch (err) {
        const steps: RollbackStep[] = [];
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
      if (restored?.changed && !opts.quiet) out('Restored prior statusLine configuration.');
      else if (restored?.skippedReason === 'not-owned' && !opts.quiet) {
        out('Skipped statusLine restore: current statusLine does not point to this installation.');
      }
      if (!dstStat) {
        if (!opts.quiet) out(`Nothing to remove (${resolvedDst} does not exist).`);
        return 'done';
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
      if (!opts.quiet) out(`Removed ${PLUGIN_NAME} from ${resolvedDst}`);
      return 'done';
    });
    if (outcome === 'done') return;
  }
}

function runToggle(opts: InstallerOptions, enable: boolean): void {
  const resolvedDst = path.resolve(opts.targetDir);
  const cliHome = resolveCliHome();
  const hudCmd = path.join(resolvedDst, 'dist', 'hud.mjs');
  if (enable && !pathExists(path.dirname(resolvedDst))) {
    throw new Error(`Missing ${hudCmd}. Run 'pnpm build' and install first.`);
  }
  const locks = enable ? [getCliHomeLockPath(cliHome), getTargetLockPath(resolvedDst)] : [getCliHomeLockPath(cliHome)];
  withFileLocksSync(locks, () => {
    const { settingsPath } = getSettingsPaths(cliHome);
    if (enable) {
      if (!pathExists(hudCmd)) throw new Error(`Missing ${hudCmd}. Run 'pnpm build' and install first.`);
      wireCliStatusLine(cliHome, resolvedDst);
      toggleAgyPlugin(opts, 'enable');
      if (!opts.quiet) out(`Enabled agy-hud statusLine in ${settingsPath}`);
      return;
    }
    const disabled = disableCliStatusLine(cliHome, resolvedDst);
    toggleAgyPlugin(opts, 'disable');
    if (!opts.quiet) {
      out(
        disabled.changed
          ? `Disabled agy-hud statusLine in ${settingsPath}`
          : `Skipped statusLine disable: current statusLine does not point to this installation.`,
      );
    }
  });
}

export function runInstallerCli(args: readonly string[]): number {
  const opts = parseInstallerArgs(args);
  if (opts.showHelp) {
    out(INSTALLER_HELP_TEXT);
    return 0;
  }
  switch (opts.command) {
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
      const { ok } = runDoctor(opts.targetDir, opts.quiet);
      return ok ? 0 : 1;
    }
  }
}
