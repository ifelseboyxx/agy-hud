import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nonEmptyStr } from './guards.ts';

export const SAFE_POSIX_SHELL_PATH_RE: RegExp = /^[A-Za-z0-9_./:@%+,-]+$/;
export const SAFE_WIN_SHELL_PATH_RE: RegExp = /^[A-Za-z0-9_.:\\/+-]+$/;

export interface ResolvedProfileRoots {
  cliHome: string;
  geminiRoot: string;
}

export function getHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return nonEmptyStr(env.USERPROFILE) ?? nonEmptyStr(env.HOME) ?? os.homedir();
  }
  return nonEmptyStr(env.HOME) ?? nonEmptyStr(env.USERPROFILE) ?? os.homedir();
}

export function expandHome(inputPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (inputPath === '~') return getHomeDir(env);
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(getHomeDir(env), inputPath.slice(2));
  }
  return inputPath;
}

export function resolveCliHome(cliHome?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmptyStr(cliHome);
  if (explicit !== undefined) {
    return path.resolve(expandHome(explicit, env));
  }
  const rawBase = nonEmptyStr(env.GEMINI_CLI_HOME);
  const root = rawBase !== undefined ? path.resolve(expandHome(rawBase, env)) : getHomeDir(env);
  return path.join(root, '.gemini', 'antigravity-cli');
}

export function resolveGlobalPluginDir(pluginName: string, env: NodeJS.ProcessEnv = process.env): string {
  const rawHome = nonEmptyStr(env.GEMINI_HOME);
  const base = rawHome !== undefined ? path.resolve(expandHome(rawHome, env)) : path.join(getHomeDir(env), '.gemini');
  return path.join(base, 'config', 'plugins', pluginName);
}

export function resolveProfileRoots(
  cliHomeOpt: string | undefined,
  geminiRootOpt: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProfileRoots {
  const cliHome = resolveCliHome(cliHomeOpt, env);
  const explicitGemini = nonEmptyStr(geminiRootOpt);
  if (explicitGemini !== undefined) {
    return { cliHome, geminiRoot: path.resolve(expandHome(explicitGemini, env)) };
  }

  const explicitCli = nonEmptyStr(cliHomeOpt);
  if (explicitCli !== undefined) {
    const geminiRoot =
      path.basename(cliHome) === 'antigravity-cli' ? path.dirname(cliHome) : path.join(cliHome, '.gemini');
    return { cliHome, geminiRoot };
  }

  const envGemini = nonEmptyStr(env.GEMINI_HOME);
  if (envGemini !== undefined) {
    return { cliHome, geminiRoot: path.resolve(expandHome(envGemini, env)) };
  }

  const envCli = nonEmptyStr(env.GEMINI_CLI_HOME);
  if (envCli !== undefined) {
    return { cliHome, geminiRoot: path.join(path.resolve(expandHome(envCli, env)), '.gemini') };
  }

  return { cliHome, geminiRoot: path.join(getHomeDir(env), '.gemini') };
}

export function toComparePath(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? path.resolve(p).toLowerCase()
    : path.resolve(p);
}

export function toPosixPath(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

export function isSameOrDescendantPath(ancestorPath: string, candidatePath: string): boolean {
  if (ancestorPath === candidatePath) return true;
  const rel = path.relative(ancestorPath, candidatePath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function realpathExistingPrefixSync(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  const tail: string[] = [];
  let cur = resolved;
  while (true) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return resolved;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function isMainEntry(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
