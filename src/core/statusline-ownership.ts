import path from 'node:path';

import { isPlainObject } from './guards.ts';
import { expandHome, realpathExistingPrefixSync, toComparePath } from './paths.ts';

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

const UNQUOTED_SHELL_META_RE = /[;&|<>`$\r\n]/;

interface ParsedCommandToken {
  readonly token: string;
  readonly rest: string;
  readonly quoted: boolean;
}

function parseCommandToken(input: string): ParsedCommandToken | null {
  const s = input.trimStart();
  if (s.length === 0) return null;
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const closeIdx = s.indexOf(quote, 1);
    if (closeIdx === -1) return null;
    const after = s.slice(closeIdx + 1);
    if (after.length > 0 && !/^\s/.test(after)) return null;
    return { token: s.slice(1, closeIdx), rest: after.trimStart(), quoted: true };
  }
  const spaceIdx = s.search(/\s/);
  if (spaceIdx === -1) return { token: s, rest: '', quoted: false };
  return { token: s.slice(0, spaceIdx), rest: s.slice(spaceIdx + 1).trimStart(), quoted: false };
}

function unwrapCommandScriptPath(rawCmd: string, env: NodeJS.ProcessEnv): string | null {
  const trimmed = rawCmd.trim();
  if (trimmed.length === 0) return null;
  const first = parseCommandToken(trimmed);
  if (first === null || first.token.length === 0) return null;
  if (
    !first.quoted &&
    (UNQUOTED_SHELL_META_RE.test(first.token) || first.token.includes('"') || first.token.includes("'"))
  ) {
    return null;
  }
  const exeName = path.win32.basename(first.token).toLowerCase();
  if (exeName === 'node' || exeName === 'node.exe') {
    if (first.rest.length === 0) return null;
    const next = parseCommandToken(first.rest);
    if (next === null || next.token.length === 0 || next.rest.length > 0 || next.token.startsWith('-')) {
      return null;
    }
    if (
      !next.quoted &&
      (UNQUOTED_SHELL_META_RE.test(next.token) || next.token.includes('"') || next.token.includes("'"))
    ) {
      return null;
    }
    return expandHome(next.token, env);
  }
  if (first.quoted) {
    if (first.rest.length > 0) return null;
    return expandHome(first.token, env);
  }
  if (UNQUOTED_SHELL_META_RE.test(trimmed) || trimmed.includes('"') || trimmed.includes("'")) {
    return null;
  }
  return expandHome(trimmed, env);
}

function canonicalizeExpandedPath(expanded: string): string {
  const resolved = path.resolve(expanded);
  const fileName = path.basename(resolved);
  const distDir = path.dirname(resolved);
  const distName = path.basename(distDir);
  const pluginDir = path.dirname(distDir);
  const pluginName = path.basename(pluginDir);
  const pluginParent = path.dirname(pluginDir);
  const lowerName = fileName.toLowerCase();
  if (
    (lowerName === 'hud.mjs' || lowerName === 'cli.mjs') &&
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

export function canonicalizeCommandPath(rawCmd: string, env: NodeJS.ProcessEnv = process.env): string {
  const expanded = unwrapCommandScriptPath(rawCmd, env);
  if (expanded === null) return '';
  return canonicalizeExpandedPath(expanded);
}

export function isSameCommandPath(cmdA: unknown, cmdB: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof cmdA !== 'string' || typeof cmdB !== 'string') return false;
  const trimmedA = cmdA.trim();
  const trimmedB = cmdB.trim();
  if (trimmedA.length === 0 || trimmedB.length === 0) return false;
  const expandedA = unwrapCommandScriptPath(trimmedA, env);
  const expandedB = unwrapCommandScriptPath(trimmedB, env);
  if (expandedA === null || expandedB === null) return false;
  return canonicalizeExpandedPath(expandedA) === canonicalizeExpandedPath(expandedB);
}

export function isValidBackupRecord(raw: Record<string, unknown>): boolean {
  if (typeof raw.hadStatusLine !== 'boolean') return false;
  if (typeof raw.wiredCommand !== 'string' || raw.wiredCommand.trim().length === 0) return false;
  if (raw.hadStatusLine) return isPlainObject(raw.previousStatusLine);
  return raw.previousStatusLine === null || raw.previousStatusLine === undefined;
}
