import path from 'node:path';

import { isPlainObject } from './guards.ts';
import {
  expandHome,
  realpathExistingPrefixSync,
  SAFE_POSIX_SHELL_PATH_RE,
  SAFE_WIN_SHELL_PATH_RE,
  toComparePath,
} from './paths.ts';

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

const POSIX_UNQUOTED_SHELL_META_RE = /[;&|<>`$*?[\]\\\r\n]/;
const WIN_UNQUOTED_SHELL_META_RE = /[;&|<>`$*?[\]\r\n]/;
const POSIX_DOUBLE_QUOTED_META_RE = /[$`\\]/;
const WIN_DOUBLE_QUOTED_META_RE = /[%!]/;

function hasDisallowedControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function formatStatusLineCommand(hudScriptPath: string, platform: NodeJS.Platform = process.platform): string {
  if (hudScriptPath.length === 0 || hasDisallowedControlChars(hudScriptPath)) {
    throw new Error('Invalid statusLine target path: path must not be empty or contain control/newline characters.');
  }
  if (platform === 'win32') {
    if (SAFE_WIN_SHELL_PATH_RE.test(hudScriptPath)) return hudScriptPath;
    if (hudScriptPath.includes('"') || hudScriptPath.includes('%') || hudScriptPath.includes('!')) {
      throw new Error(
        'Invalid Windows statusLine target path: path must not contain double quotes, percent signs, or exclamation marks.',
      );
    }
    return `"${hudScriptPath}"`;
  }
  if (SAFE_POSIX_SHELL_PATH_RE.test(hudScriptPath)) return hudScriptPath;
  return `'${hudScriptPath.replaceAll("'", "'\\''")}'`;
}

interface ParsedCommandToken {
  readonly token: string;
  readonly rest: string;
  readonly quoted: boolean;
}

function parseSingleQuotedShellToken(s: string): ParsedCommandToken | null {
  let token = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      const closeIdx = s.indexOf("'", i + 1);
      if (closeIdx === -1) return null;
      token += s.slice(i + 1, closeIdx);
      i = closeIdx + 1;
      continue;
    }
    if (ch === '\\' && s[i + 1] === "'") {
      token += "'";
      i += 2;
      continue;
    }
    if (ch !== undefined && /\s/.test(ch)) {
      break;
    }
    return null;
  }
  return { token, rest: s.slice(i).trimStart(), quoted: true };
}

function parseCommandToken(input: string, platform: NodeJS.Platform): ParsedCommandToken | null {
  const s = input.trimStart();
  if (s.length === 0 || hasDisallowedControlChars(s)) return null;
  const quote = s[0];
  if (quote === "'") {
    if (platform === 'win32') return null;
    return parseSingleQuotedShellToken(s);
  }
  if (quote === '"') {
    const closeIdx = s.indexOf('"', 1);
    if (closeIdx === -1) return null;
    const after = s.slice(closeIdx + 1);
    if (after.length > 0 && !/^\s/.test(after)) return null;
    const token = s.slice(1, closeIdx);
    const metaRe = platform === 'win32' ? WIN_DOUBLE_QUOTED_META_RE : POSIX_DOUBLE_QUOTED_META_RE;
    if (metaRe.test(token)) return null;
    return { token, rest: after.trimStart(), quoted: true };
  }
  const spaceIdx = s.search(/\s/);
  if (spaceIdx === -1) return { token: s, rest: '', quoted: false };
  return { token: s.slice(0, spaceIdx), rest: s.slice(spaceIdx + 1).trimStart(), quoted: false };
}

function hasDisallowedUnquotedMeta(token: string, platform: NodeJS.Platform): boolean {
  const unquotedMetaRe = platform === 'win32' ? WIN_UNQUOTED_SHELL_META_RE : POSIX_UNQUOTED_SHELL_META_RE;
  return unquotedMetaRe.test(token) || token.includes('"') || token.includes("'");
}

function unwrapCommandScriptPath(rawCmd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const trimmed = rawCmd.trim();
  if (trimmed.length === 0) return null;
  const first = parseCommandToken(trimmed, platform);
  if (first === null || first.token.length === 0) return null;
  if (!first.quoted && hasDisallowedUnquotedMeta(first.token, platform)) {
    return null;
  }
  const exeName = path.win32.basename(first.token).toLowerCase();
  if (exeName === 'node' || exeName === 'node.exe') {
    if (first.rest.length === 0) return null;
    const next = parseCommandToken(first.rest, platform);
    if (next === null || next.token.length === 0 || next.rest.length > 0 || next.token.startsWith('-')) {
      return null;
    }
    if (!next.quoted && hasDisallowedUnquotedMeta(next.token, platform)) {
      return null;
    }
    return next.quoted ? next.token : expandHome(next.token, env);
  }
  if (first.rest.length > 0) return null;
  return first.quoted ? first.token : expandHome(first.token, env);
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

export function isSameCanonicalFilePath(pathA: unknown, pathB: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof pathA !== 'string' || typeof pathB !== 'string') return false;
  const trimmedA = pathA.trim();
  const trimmedB = pathB.trim();
  if (trimmedA.length === 0 || trimmedB.length === 0) return false;
  if (hasDisallowedControlChars(trimmedA) || hasDisallowedControlChars(trimmedB)) return false;
  return canonicalizeExpandedPath(expandHome(trimmedA, env)) === canonicalizeExpandedPath(expandHome(trimmedB, env));
}

export function isSameCommandPath(
  cmdA: unknown,
  cmdB: unknown,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof cmdA !== 'string' || typeof cmdB !== 'string') return false;
  const trimmedA = cmdA.trim();
  const trimmedB = cmdB.trim();
  if (trimmedA.length === 0 || trimmedB.length === 0) return false;
  const expandedA = unwrapCommandScriptPath(trimmedA, env, platform);
  const expandedB = unwrapCommandScriptPath(trimmedB, env, platform);
  if (expandedA === null || expandedB === null) return false;
  return canonicalizeExpandedPath(expandedA) === canonicalizeExpandedPath(expandedB);
}

export function isValidBackupRecord(raw: Record<string, unknown>): boolean {
  if (typeof raw.hadStatusLine !== 'boolean') return false;
  if (typeof raw.wiredCommand !== 'string' || raw.wiredCommand.trim().length === 0) return false;
  if (raw.hadStatusLine) return isPlainObject(raw.previousStatusLine);
  return raw.previousStatusLine === null || raw.previousStatusLine === undefined;
}
