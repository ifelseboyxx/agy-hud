import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { resolveTrustedCliDir } from '../../collectors/safe-path.ts';
import { isPlainObject, isSupportedNodeVersion, NODE_RANGE_LABEL } from '../../core/guards.ts';
import {
  formatStatusLineCommand,
  getSettingsPaths,
  isSameCommandPath,
  isValidBackupRecord,
  type StatusLineBackupPayload,
  unwrapCommandScriptPath,
} from '../../core/statusline-ownership.ts';
import {
  captureEntrySnapshotSync,
  decodeStrictUtf8,
  type EntrySnapshotSync,
  lstatIfPresentSync,
  POSIX_MODE_MASK,
  PRIVATE_FILE_MODE,
  readJsonObjectSync,
  restoreEntrySnapshotSync,
  restoreOwnedEntrySnapshotSync,
  serializeJsonBuffer,
  statIfPresentSync,
  writeBufferAtomicSync,
  writeJsonAtomicSync,
} from '../../fs-utils.ts';
import { PLUGIN_NAME } from './args.ts';
import { makeRollbackError, runRollbackSteps, type RollbackStep } from './fs-ops.ts';

export { isSupportedNodeVersion, NODE_RANGE_LABEL };

export interface RestoreStatusLineResult {
  changed: boolean;
  skippedReason: 'missing-settings' | 'not-owned' | null;
  removedBackupPath?: string | null;
}

export interface DisableStatusLineResult {
  changed: boolean;
  skippedReason: 'not-configured' | 'not-owned' | null;
}

export interface StatusLineInspection {
  settingsPath: string;
  state: string;
  valid: boolean;
}

export interface WiredStatusLineConfig {
  type: 'command';
  command: string;
  enabled: boolean;
  stack_with_default: boolean;
}

export interface SettingsRollbackReceipt {
  settingsSnapshot: EntrySnapshotSync | null;
  writtenSettingsContent: Buffer | null;
  hadPreviousStatusLine: boolean;
  previousStatusLine: unknown;
}

export interface WireStatusLineResult {
  settingsPath: string;
  settingsRollback: SettingsRollbackReceipt;
  writtenStatusLine: WiredStatusLineConfig;
  backupSnapshot: EntrySnapshotSync | null;
  writtenBackupContent: Buffer | null;
}

interface StatusLineRollbackSpec {
  receipt: SettingsRollbackReceipt;
  expectedHasStatusLine: boolean;
  expectedStatusLine: unknown;
}

function getCapturedFileMode(snap: EntrySnapshotSync): number | undefined {
  return snap.kind === 'file' ? snap.mode : undefined;
}

function rollbackStatusLineField(spec: StatusLineRollbackSpec): void {
  const { settingsSnapshot, writtenSettingsContent, hadPreviousStatusLine, previousStatusLine } = spec.receipt;
  if (!settingsSnapshot || !writtenSettingsContent) return;
  const cur = lstatIfPresentSync(settingsSnapshot.filePath);
  if (!cur?.isFile()) return;
  const currentBytes = readFileSync(settingsSnapshot.filePath);
  if (currentBytes.equals(writtenSettingsContent)) {
    restoreEntrySnapshotSync(settingsSnapshot);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeStrictUtf8(currentBytes));
  } catch {
    return;
  }
  if (!isPlainObject(parsed) || Object.hasOwn(parsed, 'statusLine') !== spec.expectedHasStatusLine) return;
  if (spec.expectedHasStatusLine && !isDeepStrictEqual(parsed.statusLine, spec.expectedStatusLine)) return;
  const next: Record<string, unknown> = { ...parsed };
  if (hadPreviousStatusLine) {
    next.statusLine = structuredClone(previousStatusLine);
  } else {
    delete next.statusLine;
  }
  writeJsonAtomicSync(
    settingsSnapshot.filePath,
    next,
    process.platform === 'win32' ? undefined : cur.mode & POSIX_MODE_MASK,
  );
}

export function readStatusLineBackupStrict(backupPath: string): Record<string, unknown> | null {
  const parsed = readJsonObjectSync(backupPath, true);
  if (parsed === null) return null;
  if (!isValidBackupRecord(parsed)) {
    throw new Error(`Invalid statusLine backup format in ${backupPath}`);
  }
  return parsed;
}

function assertTrustedCacheDir(cliHome: string): string | null {
  const rawCacheDir = path.join(cliHome, 'cache');
  const cacheStat = lstatIfPresentSync(rawCacheDir);
  if (cacheStat === null) return null;
  const trusted = resolveTrustedCliDir(cliHome, 'cache');
  if (trusted === null) {
    throw new Error(
      `Refusing to access statusLine backup inside untrusted or symlinked cache directory: ${rawCacheDir}`,
    );
  }
  return trusted;
}

export function preflightStatusLineBackup(
  cliHome: string,
  targetDir: string,
  mode: 'wire' | 'restore',
  purge = false,
): void {
  const { settingsPath, backupPath } = getSettingsPaths(cliHome);
  const hudCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'));
  const existingSettings = readJsonObjectSync(settingsPath, true);
  const curCmd = isPlainObject(existingSettings?.statusLine) ? existingSettings.statusLine.command : undefined;
  const owned = isSameCommandPath(curCmd, hudCmd);
  if (purge || (mode === 'wire' ? !owned : owned)) {
    assertTrustedCacheDir(cliHome);
    readStatusLineBackupStrict(backupPath);
  }
}

export interface PurgeOrphanedBackupResult {
  readonly removedPaths: readonly string[];
  readonly skippedReason: 'missing' | 'owned-other-live' | null;
}

const BACKUP_TMP_RE = /^agy-hud-statusline-backup\.json\.tmp\.\d+\.\d+\.[0-9a-f]{16}$/;

function isOtherLiveAgyHudCommand(curCmd: unknown, targetDir: string, platform: NodeJS.Platform): boolean {
  if (typeof curCmd !== 'string' || curCmd.trim().length === 0) return false;
  const ownCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'), platform);
  if (isSameCommandPath(curCmd, ownCmd, process.env, platform)) return false;
  const candidateHud = unwrapCommandScriptPath(curCmd, process.env, platform);
  if (candidateHud === null) return false;
  const normalized = candidateHud.split(path.sep).join('/').toLowerCase();
  if (!normalized.endsWith('/dist/hud.mjs')) return false;
  const hudStat = statIfPresentSync(candidateHud);
  if (hudStat === null || !hudStat.isFile()) return false;
  const pluginDir = path.dirname(path.dirname(candidateHud));
  const manifestPath = path.join(pluginDir, 'plugin.json');
  try {
    const manifest = readJsonObjectSync(manifestPath, true);
    return manifest?.name === PLUGIN_NAME;
  } catch {
    // Fail closed: if another agy-hud candidate has a corrupt manifest, do not delete its backup.
    return true;
  }
}

export function purgeOrphanedStatusLineBackup(
  cliHome: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): PurgeOrphanedBackupResult {
  const { settingsPath } = getSettingsPaths(cliHome);
  const trustedCacheDir = assertTrustedCacheDir(cliHome);
  const existing = readJsonObjectSync(settingsPath, true);
  if (trustedCacheDir === null) {
    return { removedPaths: [], skippedReason: 'missing' };
  }
  const backupPath = path.join(trustedCacheDir, 'agy-hud-statusline-backup.json');
  const backup = readStatusLineBackupStrict(backupPath);
  const curCmd = isPlainObject(existing?.statusLine) ? existing.statusLine.command : undefined;
  const ownCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'), platform);
  const stillWiredToBackup =
    backup !== null &&
    typeof backup.wiredCommand === 'string' &&
    isSameCommandPath(curCmd, backup.wiredCommand, process.env, platform);
  if (
    isSameCommandPath(curCmd, ownCmd, process.env, platform) ||
    stillWiredToBackup ||
    isOtherLiveAgyHudCommand(curCmd, targetDir, platform)
  ) {
    return { removedPaths: [], skippedReason: 'owned-other-live' };
  }

  const removedPaths: string[] = [];
  const backupStat = lstatIfPresentSync(backupPath);
  if (backupStat !== null && !backupStat.isSymbolicLink() && backupStat.isFile()) {
    rmSync(backupPath, { force: true });
    removedPaths.push(backupPath);
  }
  try {
    for (const name of readdirSync(trustedCacheDir)) {
      if (!BACKUP_TMP_RE.test(name)) continue;
      const tmpPath = path.join(trustedCacheDir, name);
      const st = lstatIfPresentSync(tmpPath);
      if (st !== null && !st.isSymbolicLink() && st.isFile()) {
        rmSync(tmpPath, { force: true });
        removedPaths.push(tmpPath);
      }
    }
  } catch {
    // Ignore missing cache directory.
  }
  return { removedPaths, skippedReason: removedPaths.length === 0 ? 'missing' : null };
}

function writeBackupPayload(
  backupPath: string,
  wiredCommand: string,
  previousStatusLine: Record<string, unknown> | null,
): Buffer {
  const backupPayload: StatusLineBackupPayload = {
    wiredCommand,
    hadStatusLine: previousStatusLine !== null,
    previousStatusLine,
    savedAt: new Date().toISOString(),
  };
  const content = serializeJsonBuffer(backupPayload);
  writeBufferAtomicSync(backupPath, content, PRIVATE_FILE_MODE);
  return content;
}

function rethrowWithRollback(err: unknown, label: string, action: () => void): never {
  const rbErrors = runRollbackSteps([[label, action]]);
  throw makeRollbackError(err, rbErrors);
}

export function createWireRollbackSteps(
  receipt: WireStatusLineResult | null,
  isStillOwned?: () => boolean,
): RollbackStep[] {
  if (!receipt) return [];
  const steps: RollbackStep[] = [];
  if (receipt.settingsRollback.writtenSettingsContent !== null) {
    steps.push([
      'restore settings.json',
      () => {
        if (isStillOwned && !isStillOwned()) return;
        rollbackStatusLineField({
          receipt: receipt.settingsRollback,
          expectedHasStatusLine: true,
          expectedStatusLine: receipt.writtenStatusLine,
        });
      },
    ]);
  }
  if (receipt.writtenBackupContent !== null) {
    steps.push([
      'restore backup',
      () => {
        if (isStillOwned && !isStillOwned()) return;
        restoreOwnedEntrySnapshotSync(receipt.backupSnapshot, receipt.writtenBackupContent);
      },
    ]);
  }
  return steps;
}

function resolveInheritedPriorStatusLine(
  cur: unknown,
  curCmd: unknown,
  existingBackup: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (
    existingBackup !== null &&
    typeof existingBackup.wiredCommand === 'string' &&
    isSameCommandPath(curCmd, existingBackup.wiredCommand)
  ) {
    return existingBackup.hadStatusLine === true && isPlainObject(existingBackup.previousStatusLine)
      ? existingBackup.previousStatusLine
      : null;
  }
  return isPlainObject(cur) ? cur : null;
}

function shouldUseNodePrefix(hudScriptPath: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return true;
  const st = statIfPresentSync(hudScriptPath);
  return st !== null && st.isFile() && (st.mode & 0o111) === 0;
}

export function wireCliStatusLine(
  cliHome: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): WireStatusLineResult {
  const { settingsPath, backupPath } = getSettingsPaths(cliHome);
  const existing = readJsonObjectSync(settingsPath, true) ?? {};
  const hudScriptPath = path.join(targetDir, 'dist', 'hud.mjs');
  const hudCmd = formatStatusLineCommand(hudScriptPath, platform, {
    useNode: shouldUseNodePrefix(hudScriptPath, platform),
  });
  const cur = existing.statusLine;
  const curCmd = isPlainObject(cur) ? cur.command : undefined;
  const needsBackup = !isSameCommandPath(curCmd, hudCmd);
  if (needsBackup) {
    assertTrustedCacheDir(cliHome);
  }
  const existingBackup = needsBackup ? readStatusLineBackupStrict(backupPath) : null;

  const nextStatusLine: WiredStatusLineConfig = {
    type: 'command',
    command: hudCmd,
    enabled: true,
    stack_with_default: false,
  };
  const settingsSnap = captureEntrySnapshotSync(settingsPath);
  const hadPreviousStatusLine = Object.hasOwn(existing, 'statusLine');
  const previousStatusLine = hadPreviousStatusLine ? structuredClone(cur) : undefined;

  if (!needsBackup && settingsSnap.kind !== 'missing' && isDeepStrictEqual(cur, nextStatusLine)) {
    return {
      settingsPath,
      settingsRollback: {
        settingsSnapshot: null,
        writtenSettingsContent: null,
        hadPreviousStatusLine,
        previousStatusLine,
      },
      writtenStatusLine: nextStatusLine,
      backupSnapshot: null,
      writtenBackupContent: null,
    };
  }

  const previousToSave = needsBackup ? resolveInheritedPriorStatusLine(cur, curCmd, existingBackup) : null;
  const backupSnap = needsBackup ? captureEntrySnapshotSync(backupPath) : null;
  let writtenBackupContent: Buffer | null = null;
  let writtenSettingsContent: Buffer | null = null;
  try {
    if (needsBackup) {
      writtenBackupContent = writeBackupPayload(backupPath, hudCmd, previousToSave);
    }
    writtenSettingsContent = serializeJsonBuffer({ ...existing, statusLine: nextStatusLine });
    writeBufferAtomicSync(settingsPath, writtenSettingsContent, getCapturedFileMode(settingsSnap));
  } catch (err) {
    if (writtenBackupContent !== null) {
      rethrowWithRollback(err, 'restore backup', () => restoreOwnedEntrySnapshotSync(backupSnap, writtenBackupContent));
    }
    throw err;
  }
  return {
    settingsPath,
    settingsRollback: {
      settingsSnapshot: settingsSnap,
      writtenSettingsContent,
      hadPreviousStatusLine,
      previousStatusLine,
    },
    writtenStatusLine: nextStatusLine,
    backupSnapshot: backupSnap,
    writtenBackupContent,
  };
}

export function disableCliStatusLine(
  cliHome: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): DisableStatusLineResult {
  const { settingsPath } = getSettingsPaths(cliHome);
  const existing = readJsonObjectSync(settingsPath, true);
  if (!existing || existing.statusLine === undefined || existing.statusLine === null) {
    return { changed: false, skippedReason: 'not-configured' };
  }

  const hudCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'), platform);
  const rawSl = existing.statusLine;
  if (!isPlainObject(rawSl) || !isSameCommandPath(rawSl.command, hudCmd, process.env, platform)) {
    return { changed: false, skippedReason: 'not-owned' };
  }

  const settingsSnap = captureEntrySnapshotSync(settingsPath);
  writeJsonAtomicSync(
    settingsPath,
    { ...existing, statusLine: { ...rawSl, enabled: false } },
    getCapturedFileMode(settingsSnap),
  );
  return { changed: true, skippedReason: null };
}

export function restoreCliStatusLine(
  cliHome: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): RestoreStatusLineResult {
  const { settingsPath, backupPath } = getSettingsPaths(cliHome);
  const existing = readJsonObjectSync(settingsPath, true);
  if (!existing) return { changed: false, skippedReason: 'missing-settings' };

  const hudCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'), platform);
  const curCmd = isPlainObject(existing.statusLine) ? existing.statusLine.command : undefined;
  if (!isSameCommandPath(curCmd, hudCmd, process.env, platform)) {
    return { changed: false, skippedReason: 'not-owned' };
  }

  assertTrustedCacheDir(cliHome);
  const backup = readStatusLineBackupStrict(backupPath);
  const backupOwned = backup !== null && isSameCommandPath(backup.wiredCommand, hudCmd, process.env, platform);

  const settingsSnap = captureEntrySnapshotSync(settingsPath);
  const hadPreviousStatusLine = Object.hasOwn(existing, 'statusLine');
  const previousStatusLine = hadPreviousStatusLine ? structuredClone(existing.statusLine) : undefined;
  const nextSettings: Record<string, unknown> = { ...existing };

  if (backupOwned && backup.hadStatusLine && isPlainObject(backup.previousStatusLine)) {
    nextSettings.statusLine = backup.previousStatusLine;
  } else {
    delete nextSettings.statusLine;
  }

  const writtenSettingsContent = serializeJsonBuffer(nextSettings);
  writeBufferAtomicSync(settingsPath, writtenSettingsContent, getCapturedFileMode(settingsSnap));

  let removedBackupPath: string | null = null;
  if (backupOwned) {
    try {
      rmSync(backupPath, { force: true });
      removedBackupPath = backupPath;
    } catch (err) {
      rethrowWithRollback(err, 'restore settings.json', () =>
        rollbackStatusLineField({
          receipt: {
            settingsSnapshot: settingsSnap,
            writtenSettingsContent,
            hadPreviousStatusLine,
            previousStatusLine,
          },
          expectedHasStatusLine: Object.hasOwn(nextSettings, 'statusLine'),
          expectedStatusLine: nextSettings.statusLine,
        }),
      );
    }
  }
  return { changed: true, skippedReason: null, removedBackupPath };
}

export function inspectStatusLineState(cliHome: string, targetDir: string): StatusLineInspection {
  const { settingsPath } = getSettingsPaths(cliHome);
  let settings: Record<string, unknown> | null;
  try {
    settings = readJsonObjectSync(settingsPath, true);
  } catch {
    return { settingsPath, state: 'invalid (corrupt settings.json)', valid: false };
  }
  const sl = settings?.statusLine;
  if (!isPlainObject(sl)) return { settingsPath, state: 'not configured', valid: true };
  const cmd = typeof sl.command === 'string' && sl.command.trim().length > 0 ? sl.command.trim() : undefined;
  let expectedCmd: string;
  try {
    expectedCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'));
  } catch {
    expectedCmd = '';
  }
  const isSelf = expectedCmd.length > 0 && isSameCommandPath(cmd, expectedCmd);
  if (isSelf && sl.enabled === false) {
    return { settingsPath, state: 'disabled (wired to agy-hud, enabled=false)', valid: true };
  }
  return { settingsPath, state: isSelf ? 'wired to agy-hud' : `custom (${cmd ?? 'unset'})`, valid: true };
}
