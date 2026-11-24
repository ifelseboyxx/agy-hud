import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nonEmptyStr } from '../../core/guards.ts';
import { realpathExistingPrefixSync } from '../../core/paths.ts';

export const SHIM_HEADER_VERSION = 'agy-hud-shim:v1';

const SHIM_BIN_NAME = 'agy-hud';
const SHIM_CMD_NAME = 'agy-hud.cmd';

export interface ShimPaths {
  readonly primaryPath: string;
  readonly posixPath: string;
  readonly cmdPath: string | null;
  readonly allPaths: readonly string[];
}

function isWindowsPathStyle(sample: string): boolean {
  return /^[a-zA-Z]:/.test(sample) || sample.includes('\\');
}

export function selectShimPathApi(
  platform: NodeJS.Platform,
  ...samples: readonly (string | undefined)[]
): path.PlatformPath {
  if (platform === process.platform) return path;
  if (platform === 'win32') {
    return samples.some((s) => s !== undefined && isWindowsPathStyle(s)) ? path.win32 : path;
  }
  return path.posix;
}

function resolvePlatformHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return nonEmptyStr(env.USERPROFILE) ?? nonEmptyStr(env.HOME) ?? os.homedir();
  }
  return nonEmptyStr(env.HOME) ?? nonEmptyStr(env.USERPROFILE) ?? os.homedir();
}

function expandPlatformHome(
  inputPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  pathApi: path.PlatformPath,
): string {
  const home = resolvePlatformHome(env, platform);
  if (inputPath === '~') return home;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return pathApi.join(home, inputPath.slice(2));
  }
  return inputPath;
}

function isContainedInDir(parentDir: string, candidateDir: string, pathApi: path.PlatformPath, ci: boolean): boolean {
  const normParent = ci ? pathApi.resolve(parentDir).toLowerCase() : pathApi.resolve(parentDir);
  const normCand = ci ? pathApi.resolve(candidateDir).toLowerCase() : pathApi.resolve(candidateDir);
  const rel = pathApi.relative(normParent, normCand);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

export function resolveShimBinDir(
  explicitBinDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const homeDir = resolvePlatformHome(env, platform);
  const rawExplicit = nonEmptyStr(explicitBinDir) ?? nonEmptyStr(env.AGY_HUD_BIN_DIR);
  if (rawExplicit !== undefined) {
    const pathApi = selectShimPathApi(platform, rawExplicit, homeDir);
    return pathApi.resolve(expandPlatformHome(rawExplicit, env, platform, pathApi));
  }
  if (platform === 'win32') {
    const localAppData = nonEmptyStr(env.LOCALAPPDATA);
    const pathApi = selectShimPathApi(platform, homeDir, localAppData);
    if (
      localAppData !== undefined &&
      pathApi.isAbsolute(localAppData) &&
      isContainedInDir(homeDir, localAppData, pathApi, true)
    ) {
      return pathApi.join(pathApi.resolve(localAppData), 'agy', 'bin');
    }
    return pathApi.join(pathApi.resolve(homeDir), 'AppData', 'Local', 'agy', 'bin');
  }
  const pathApi = selectShimPathApi(platform, homeDir);
  return pathApi.join(pathApi.resolve(homeDir), '.local', 'bin');
}

export function resolveShimPaths(binDir: string, platform: NodeJS.Platform = process.platform): ShimPaths {
  const pathApi = selectShimPathApi(platform, binDir);
  const posixPath = pathApi.join(binDir, SHIM_BIN_NAME);
  if (platform === 'win32') {
    const cmdPath = pathApi.join(binDir, SHIM_CMD_NAME);
    return { primaryPath: cmdPath, posixPath, cmdPath, allPaths: [cmdPath, posixPath] };
  }
  return { primaryPath: posixPath, posixPath, cmdPath: null, allPaths: [posixPath] };
}

export function expectedCliMjsPath(targetDir: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = selectShimPathApi(platform, targetDir);
  return pathApi.join(pathApi.resolve(targetDir), 'dist', 'cli.mjs');
}

export function resolveInstallNodePath(execPath: string = process.execPath): string {
  try {
    return realpathSync(execPath);
  } catch {
    return execPath;
  }
}

function normalizePathEntryForCompare(
  rawEntry: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  pathApi: path.PlatformPath,
): string {
  const expanded = expandPlatformHome(rawEntry, env, platform, pathApi);
  const resolved = platform === process.platform ? realpathExistingPrefixSync(expanded) : pathApi.resolve(expanded);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export function isDirOnPath(
  binDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rawPath = platform === 'win32' ? (env.PATH ?? env.Path ?? '') : (env.PATH ?? '');
  if (rawPath.trim().length === 0) return false;
  const pathApi = selectShimPathApi(platform, binDir, rawPath);
  const delimiter = platform === 'win32' ? ';' : ':';
  const targetNorm = normalizePathEntryForCompare(binDir, env, platform, pathApi);
  for (const part of rawPath.split(delimiter)) {
    const cleaned = platform === 'win32' ? part.trim().replace(/^"(.*)"$/, '$1') : part.trim();
    if (cleaned.length === 0) continue;
    if (normalizePathEntryForCompare(cleaned, env, platform, pathApi) === targetNorm) return true;
  }
  return false;
}

export function formatPathHint(binDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `Note: add "${binDir}" to PATH to invoke 'agy-hud' directly.`;
  }
  return `Note: add "${binDir}" to PATH to invoke 'agy-hud' directly (e.g., export PATH="${binDir}:$PATH").`;
}

function assertNoNewlines(label: string, value: string): void {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`Invalid ${label}: path must not contain newline characters.`);
  }
}

function quotePosixSh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeCmdSetValue(value: string): string {
  return value.replaceAll('%', '%%');
}

function escapeCmdEchoText(value: string): string {
  return value
    .replaceAll('%', '%%')
    .replaceAll('^', '^^')
    .replaceAll('&', '^&')
    .replaceAll('|', '^|')
    .replaceAll('<', '^<')
    .replaceAll('>', '^>')
    .replaceAll(')', '^)');
}

function resolvePluginDirFromCliPath(cliMjsPath: string, pathApi: path.PlatformPath): string {
  return pathApi.dirname(pathApi.dirname(cliMjsPath));
}

export function formatShimScriptPosix(cliMjsPath: string, installNodePath: string, shimPath: string): string {
  assertNoNewlines('cliMjsPath', cliMjsPath);
  assertNoNewlines('installNodePath', installNodePath);
  assertNoNewlines('shimPath', shimPath);
  const pathApi = isWindowsPathStyle(cliMjsPath) ? path.win32 : path.posix;
  const pluginDir = resolvePluginDirFromCliPath(cliMjsPath, pathApi);
  const missingMsg = `agy-hud plugin not found at ${pluginDir}. If uninstalled via 'agy plugin uninstall', remove this stale CLI shim: rm "${shimPath}"`;
  return [
    '#!/bin/sh',
    `# ${SHIM_HEADER_VERSION} target=${cliMjsPath}`,
    `TARGET=${quotePosixSh(cliMjsPath)}`,
    `FALLBACK_NODE=${quotePosixSh(installNodePath)}`,
    'if [ ! -f "$TARGET" ]; then',
    `  printf '%s\\n' ${quotePosixSh(missingMsg)} >&2`,
    '  exit 1',
    'fi',
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$TARGET" "$@"',
    'fi',
    'exec "$FALLBACK_NODE" "$TARGET" "$@"',
    '',
  ].join('\n');
}

export function formatShimScriptCmd(cliMjsPath: string, installNodePath: string, shimPath: string): string {
  assertNoNewlines('cliMjsPath', cliMjsPath);
  assertNoNewlines('installNodePath', installNodePath);
  assertNoNewlines('shimPath', shimPath);
  const pathApi = isWindowsPathStyle(cliMjsPath) ? path.win32 : path.posix;
  const pluginDir = resolvePluginDirFromCliPath(cliMjsPath, pathApi);
  const missingMsg = `agy-hud plugin not found at ${pluginDir}. If uninstalled via 'agy plugin uninstall', remove this stale CLI shim: del "${shimPath}"`;
  return [
    '@echo off',
    `@rem ${SHIM_HEADER_VERSION} target=${cliMjsPath}`,
    'setlocal',
    `set "TARGET=${escapeCmdSetValue(cliMjsPath)}"`,
    `set "FALLBACK_NODE=${escapeCmdSetValue(installNodePath)}"`,
    'if not exist "%TARGET%" goto :missing',
    'where node >nul 2>nul',
    'if not errorlevel 1 goto :use_path_node',
    '"%FALLBACK_NODE%" "%TARGET%" %*',
    'exit /b %errorlevel%',
    ':use_path_node',
    'node "%TARGET%" %*',
    'exit /b %errorlevel%',
    ':missing',
    `echo ${escapeCmdEchoText(missingMsg)} >&2`,
    'exit /b 1',
    '',
  ].join('\r\n');
}
