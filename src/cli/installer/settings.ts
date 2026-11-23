import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isPlainObject } from '../../core/guards.ts';
import {
  getSettingsPaths,
  isSameCommandPath,
  isValidBackupRecord,
  type StatusLineBackupPayload,
} from '../../core/statusline-ownership.ts';
import {
  captureEntrySnapshotSync,
  type EntrySnapshotSync,
  lstatIfPresentSync,
  readJsonObjectSync,
  restoreEntrySnapshotSync,
  restoreOwnedEntrySnapshotSync,
  serializeJsonBuffer,
  writeBufferAtomicSync,
  writeJsonAtomicSync,
} from '../../fs-utils.ts';
import { makeRollbackError, runRollbackSteps, type RollbackStep } from './fs-ops.ts';

export const NODE_RANGE_LABEL = '^22.20.0 || >=24.0.0';

const NODE_LTS_MAJOR = 22;
const NODE_LTS_MIN_MINOR = 20;
const NODE_CURRENT_MIN_MAJOR = 24;

export interface RestoreStatusLineResult {
  changed: boolean;
  skippedReason: 'missing-settings' | 'not-owned' | null;
}

export interface DisableStatusLineResult {
  changed: boolean;
  skippedReason: 'not-owned' | null;
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

export function isSupportedNodeVersion(version: string): boolean {
  const [rawMajor = 0, rawMinor = 0] = String(version)
    .split('.')
    .map((p) => Number.parseInt(p, 10));
  const major = Number.isFinite(rawMajor) ? rawMajor : 0;
  const minor = Number.isFinite(rawMinor) ? rawMinor : 0;
  return (major === NODE_LTS_MAJOR && minor >= NODE_LTS_MIN_MINOR) || major >= NODE_CURRENT_MIN_MAJOR;
}

interface StatusLineRollbackSpec {
  receipt: SettingsRollbackReceipt;
  expectedHasStatusLine: boolean;
  expectedStatusLine: unknown;
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
    parsed = JSON.parse(currentBytes.toString('utf8'));
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
  writeJsonAtomicSync(settingsSnapshot.filePath, next);
}

export function readStatusLineBackupStrict(backupPath: string): Record<string, unknown> | null {
  const parsed = readJsonObjectSync(backupPath, true);
  if (parsed === null) return null;
  if (!isValidBackupRecord(parsed)) {
    throw new Error(`Invalid statusLine backup format in ${backupPath}`);
  }
  return parsed;
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
  writeBufferAtomicSync(backupPath, content);
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
  const hudCmd = path.join(targetDir, 'dist', 'hud.mjs');
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
    writeBufferAtomicSync(settingsPath, writtenSettingsContent);
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

export function disableCliStatusLine(cliHome: string, targetDir: string): DisableStatusLineResult {
  const { settingsPath, backupPath } = getSettingsPaths(cliHome);
  const existing = readJsonObjectSync(settingsPath, true) ?? {};
  const hudCmd = path.join(targetDir, 'dist', 'hud.mjs');
  const rawSl = existing.statusLine;
  const hasConfiguredSl = rawSl !== undefined && rawSl !== null;

  if (hasConfiguredSl && (!isPlainObject(rawSl) || !isSameCommandPath(rawSl.command, hudCmd))) {
    return { changed: false, skippedReason: 'not-owned' };
  }

  const prevSl = isPlainObject(rawSl) ? rawSl : null;
  if (prevSl === null) readStatusLineBackupStrict(backupPath);
  const backupSnap = prevSl === null ? captureEntrySnapshotSync(backupPath) : null;
  let writtenBackupContent: Buffer | null = null;
  try {
    if (prevSl === null) {
      writtenBackupContent = writeBackupPayload(backupPath, hudCmd, null);
    }
    const nextSl = prevSl ?? { type: 'command', command: hudCmd, stack_with_default: false };
    writeJsonAtomicSync(settingsPath, { ...existing, statusLine: { ...nextSl, enabled: false } });
  } catch (err) {
    if (writtenBackupContent !== null) {
      rethrowWithRollback(err, 'restore backup', () => restoreOwnedEntrySnapshotSync(backupSnap, writtenBackupContent));
    }
    throw err;
  }
  return { changed: true, skippedReason: null };
}

export function restoreCliStatusLine(cliHome: string, targetDir: string): RestoreStatusLineResult {
  const { settingsPath, backupPath } = getSettingsPaths(cliHome);
  const existing = readJsonObjectSync(settingsPath, true);
  if (!existing) return { changed: false, skippedReason: 'missing-settings' };

  const hudCmd = path.join(targetDir, 'dist', 'hud.mjs');
  const curCmd = isPlainObject(existing.statusLine) ? existing.statusLine.command : undefined;
  if (!isSameCommandPath(curCmd, hudCmd)) {
    return { changed: false, skippedReason: 'not-owned' };
  }

  const backup = readStatusLineBackupStrict(backupPath);
  const backupOwned = backup !== null && isSameCommandPath(backup.wiredCommand, hudCmd);

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
  writeBufferAtomicSync(settingsPath, writtenSettingsContent);

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
  const isSelf = isSameCommandPath(cmd, path.join(targetDir, 'dist', 'hud.mjs'));
  if (isSelf && sl.enabled === false) {
    return { settingsPath, state: 'disabled (wired to agy-hud, enabled=false)', valid: true };
  }
  return { settingsPath, state: isSelf ? 'wired to agy-hud' : `custom (${cmd ?? 'unset'})`, valid: true };
}
