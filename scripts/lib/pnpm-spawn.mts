import path from 'node:path';

import { nonEmptyStr } from '../../src/core/guards.ts';

const PNPM_SCRIPT_RE = /pnpm[^\\/]*\.[cm]?js$/i;

export interface PnpmSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export function resolvePnpmSpawnSpec(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  silent: boolean = true,
): PnpmSpawnSpec {
  const pnpmArgs = silent ? ['--silent', ...args] : [...args];
  if (platform !== 'win32') {
    return { command: 'pnpm', args: pnpmArgs };
  }
  const npmExecPath = nonEmptyStr(env.npm_execpath);
  if (npmExecPath !== undefined && PNPM_SCRIPT_RE.test(path.win32.basename(npmExecPath))) {
    return { command: execPath, args: [npmExecPath, ...pnpmArgs] };
  }
  const comspec = nonEmptyStr(env.ComSpec) ?? nonEmptyStr(env.COMSPEC) ?? 'cmd.exe';
  return { command: comspec, args: ['/d', '/s', '/c', 'pnpm.cmd', ...pnpmArgs] };
}
