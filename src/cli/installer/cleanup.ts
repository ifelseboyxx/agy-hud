import { readdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { HUD_CACHE_LOCK_RE, TRANSIENT_HUD_CACHE_RE, TRANSIENT_HUD_TMP_RE } from '../../core/cache-registry.ts';
import { tryReclaimStaleLock } from '../../core/file-lock.ts';
import { lstatIfPresentSync } from '../../core/fs-utils.ts';
import { getErrCode } from '../../core/guards.ts';
import { resolveTrustedCliDir } from '../../core/safe-path.ts';
import { purgeOrphanedStatusLineBackup } from './settings.ts';

export interface CleanupReceipt {
  readonly removedCaches: readonly string[];
  readonly removedConfig: string | null;
  readonly configPreserved: boolean;
  readonly removedBackups: readonly string[];
  readonly skippedBackupReason: 'missing' | 'owned-other-live' | null;
}

export function preflightPurgeConfig(cliHome: string): void {
  const configPath = path.join(cliHome, 'hud-config.json');
  const st = lstatIfPresentSync(configPath);
  if (st !== null && st.isDirectory()) {
    throw new Error(`Refusing to purge hud-config.json: ${configPath} is a directory.`);
  }
}

export function sweepTransientHudCaches(cliHome: string): string[] {
  const cacheDir = resolveTrustedCliDir(cliHome, 'cache');
  if (cacheDir === null) return [];
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries.sort()) {
    const isCache = TRANSIENT_HUD_CACHE_RE.test(name) || TRANSIENT_HUD_TMP_RE.test(name);
    const isLock = HUD_CACHE_LOCK_RE.test(name);
    if (!isCache && !isLock) continue;
    const fullPath = path.join(cacheDir, name);
    const st = lstatIfPresentSync(fullPath);
    if (st === null || st.isSymbolicLink() || !st.isFile()) continue;
    if (isLock) {
      if (tryReclaimStaleLock(fullPath) && lstatIfPresentSync(fullPath) === null) {
        removed.push(fullPath);
      }
      continue;
    }
    try {
      rmSync(fullPath, { force: true });
      removed.push(fullPath);
    } catch {
      // Tolerate ENOENT/EBUSY on best-effort transient cache cleanup.
    }
  }
  return removed;
}

export function runPostTeardownCleanup(cliHome: string, targetDir: string, purge: boolean): CleanupReceipt {
  const removedCaches = sweepTransientHudCaches(cliHome);
  const configPath = path.join(cliHome, 'hud-config.json');
  const configStat = lstatIfPresentSync(configPath);
  const configExists = configStat !== null;

  if (!purge) {
    return {
      removedCaches,
      removedConfig: null,
      configPreserved: configExists,
      removedBackups: [],
      skippedBackupReason: null,
    };
  }

  preflightPurgeConfig(cliHome);
  // Remove hud-config.json before purging orphaned backup so a config unlink failure leaves backup intact.
  let removedConfig: string | null = null;
  if (configExists) {
    try {
      unlinkSync(configPath);
      removedConfig = configPath;
    } catch (err) {
      if (getErrCode(err) !== 'ENOENT') {
        throw err;
      }
    }
  }
  const backupPurge = purgeOrphanedStatusLineBackup(cliHome, targetDir);
  return {
    removedCaches,
    removedConfig,
    configPreserved: false,
    removedBackups: backupPurge.removedPaths,
    skippedBackupReason: backupPurge.skippedReason,
  };
}
