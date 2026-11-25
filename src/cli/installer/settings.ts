import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isPlainObject, isSupportedNodeVersion, NODE_RANGE_LABEL } from '../../core/guards.ts';
import {
  formatStatusLineCommand,
  getSettingsPaths,
  isSameCommandPath,
  isValidBackupRecord,
  type StatusLineBackupPayload,
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
  writeBufferAtomicSync,
  writeJsonAtomicSync,
} from '../../fs-utils.ts';
import { makeRollbackError, runRollbackSteps, type RollbackStep } from './fs-ops.ts';

export { isSupportedNodeVersion, NODE_RANGE_LABEL };

export interface RestoreStatusLineResult {
  changed: boolean;
  skippedReason: 'missing-settings' | 'not-owned' | null;
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

export function preflightStatusLineBackup(cliHome: string, targetDir: string, mode: 'wire' | 'restore'): void {
  const { settingsPath, backupPath } = getSettingsPaths(cliHome);
  const hudCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'));
  const existingSettings = readJsonObjectSync(settingsPath, true);
  const curCmd = isPlainObject(existingSettings?.statusLine) ? existingSettings.statusLine.command : undefined;
  const owned = isSameCommandPath(curCmd, hudCmd);
  if (mode === 'wire' ? !owned : owned) {
    readStatusLineBackupStrict(backupPath);
  }
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

export function wireCliStatusLine(cliHome: string, targetDir: string): WireStatusLineResult {
  const { settingsPath, backupPath } = getSettingsPaths(cliHome);
  const existing = readJsonObjectSync(settingsPath, true) ?? {};
  const hudCmd = formatStatusLineCommand(path.join(targetDir, 'dist', 'hud.mjs'));
  const cur = existing.statusLine;
  const curCmd = isPlainObject(cur) ? cur.command : undefined;
  const needsBackup = !isSameCommandPath(curCmd, hudCmd);
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

  if (backupOwned) {
    try {
      rmSync(backupPath, { force: true });
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
  return { changed: true, skippedReason: null };
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
