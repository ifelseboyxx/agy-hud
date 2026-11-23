import path from 'node:path';

import { isPlainObject } from './guards.ts';
import { realpathExistingPrefixSync, toComparePath } from './paths.ts';

export interface SettingsPaths {
  settingsPath: string;
  backupPath: string;
}

export interface StatusLineBackupPayload {
  wiredCommand: string;
  hadStatusLine: boolean;
  previousStatusLine: Record<string, unknown> | null;
  savedAt: string;
}

export function getSettingsPaths(cliHome: string): SettingsPaths {
  return {
    settingsPath: path.join(cliHome, 'settings.json'),
    backupPath: path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json'),
  };
}

export function canonicalizeCommandPath(rawCmd: string): string {
  const resolved = path.resolve(rawCmd);
  const fileName = path.basename(resolved);
  const distDir = path.dirname(resolved);
  const distName = path.basename(distDir);
  const pluginDir = path.dirname(distDir);
  const pluginName = path.basename(pluginDir);
  const pluginParent = path.dirname(pluginDir);
  if (
    fileName.toLowerCase() === 'hud.mjs' &&
    distName.toLowerCase() === 'dist' &&
    pluginName.length > 0 &&
    pluginParent !== pluginDir
  ) {
    return toComparePath(path.join(realpathExistingPrefixSync(pluginParent), pluginName, distName, fileName));
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) return toComparePath(resolved);
  return toComparePath(path.join(realpathExistingPrefixSync(parent), fileName));
}

export function isSameCommandPath(cmdA: unknown, cmdB: unknown): boolean {
  if (typeof cmdA !== 'string' || typeof cmdB !== 'string') return false;
  const trimmedA = cmdA.trim();
  const trimmedB = cmdB.trim();
  if (trimmedA.length === 0 || trimmedB.length === 0) return false;
  if (toComparePath(trimmedA) === toComparePath(trimmedB)) return true;
  return canonicalizeCommandPath(trimmedA) === canonicalizeCommandPath(trimmedB);
}

export function isValidBackupRecord(raw: Record<string, unknown>): boolean {
  if (typeof raw.hadStatusLine !== 'boolean') return false;
  if (typeof raw.wiredCommand !== 'string' || raw.wiredCommand.trim().length === 0) return false;
  if (raw.hadStatusLine) return isPlainObject(raw.previousStatusLine);
  return raw.previousStatusLine === null || raw.previousStatusLine === undefined;
}
