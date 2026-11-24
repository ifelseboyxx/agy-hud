import path from 'node:path';

import { nonEmptyStr } from '../../core/guards.ts';
import { expandHome, resolveGlobalPluginDir } from '../../core/paths.ts';
import { resolveShimBinDir } from './shim.ts';

export const PLUGIN_NAME = 'agy-hud';

export type InstallerCommand =
  | 'install'
  | 'uninstall'
  | 'wire'
  | 'unwire'
  | 'on'
  | 'enable'
  | 'off'
  | 'disable'
  | 'doctor'
  | 'status';

const VALID_COMMANDS: ReadonlySet<string> = new Set<InstallerCommand>([
  'install',
  'uninstall',
  'wire',
  'unwire',
  'on',
  'enable',
  'off',
  'disable',
  'doctor',
  'status',
]);

export function isInstallerCommand(value: string): value is InstallerCommand {
  return VALID_COMMANDS.has(value);
}

type BooleanFlagKey =
  | 'showHelp'
  | 'useLink'
  | 'skipEnable'
  | 'wireStatusLine'
  | 'restoreStatusLine'
  | 'noShim'
  | 'quiet';

export interface InstallerOptions {
  command: InstallerCommand;
  useLink: boolean;
  skipEnable: boolean;
  wireStatusLine: boolean;
  restoreStatusLine: boolean;
  noShim: boolean;
  manageShim: boolean;
  binDir: string;
  explicitBinDir: boolean;
  quiet: boolean;
  showHelp: boolean;
  targetDir: string;
  isProject: boolean;
  isCustomTarget: boolean;
}

const FLAG_MAP: Readonly<Record<string, BooleanFlagKey>> = {
  '-h': 'showHelp',
  '--help': 'showHelp',
  '--link': 'useLink',
  '--no-enable': 'skipEnable',
  '--wire-statusline': 'wireStatusLine',
  '--restore-statusline': 'restoreStatusLine',
  '--no-shim': 'noShim',
  '--quiet': 'quiet',
  '-q': 'quiet',
};

export const INSTALLER_HELP_TEXT = `agy-hud installer
Usage: agy-hud [wire|unwire|install|uninstall|on|enable|off|disable|doctor|status] [options]
Commands:
  wire / unwire          Wire or detach host statusLine and CLI Shim in-place
  install / uninstall    Install or remove agy-hud plugin (link or copy)
  on|enable / off|disable
                         Toggle statusLine.enabled and plugin state (preserves CLI Shim)
  doctor / status        Check installation, CLI Shim, and live health
Options:
  --target <dir>         Custom plugin target directory (skips CLI Shim unless --bin-dir)
  --project [dir]        Install into <dir>/.agents/plugins/agy-hud (skips CLI Shim unless --bin-dir)
  --link                 Create a symlink to this repository
  --bin-dir <dir>        Custom CLI Shim directory (also honors AGY_HUD_BIN_DIR)
  --no-shim              Skip CLI Shim creation or removal
  --no-enable            Skip running agy plugin enable/disable
  --wire-statusline      Wire statusLine in <cliHome>/settings.json
  --restore-statusline   Restore prior statusLine backup on uninstall
  --quiet, -q            Suppress informational output
  -h, --help             Show this help`;

export function parseInstallerArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): InstallerOptions {
  let targetDir: string | undefined;
  let projectDir: string | undefined;
  let cliBinDir: string | undefined;
  const opts = {
    command: 'install' as InstallerCommand,
    useLink: false,
    skipEnable: false,
    wireStatusLine: false,
    restoreStatusLine: false,
    noShim: false,
    quiet: false,
    showHelp: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    const flagKey = FLAG_MAP[a];
    if (flagKey !== undefined) {
      opts[flagKey] = true;
    } else if (a === '--target') {
      const next = args[++i];
      if (!next || next.startsWith('-')) throw new Error('Missing directory path after --target');
      targetDir = path.resolve(expandHome(next, env));
    } else if (a === '--project') {
      const next = args[i + 1];
      projectDir = next && !next.startsWith('-') ? path.resolve(expandHome(args[++i] ?? '', env)) : process.cwd();
    } else if (a === '--bin-dir') {
      const next = args[++i];
      if (!next || next.startsWith('-')) throw new Error('Missing directory path after --bin-dir');
      cliBinDir = next;
    } else if (a.startsWith('--bin-dir=')) {
      const inline = a.slice('--bin-dir='.length);
      if (inline.length === 0) throw new Error('Missing directory path after --bin-dir=');
      cliBinDir = inline;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  if (positional.length > 1) throw new Error(`Unexpected extra argument: '${positional[1] ?? ''}'`);
  if (positional.length === 1 && positional[0] !== undefined) {
    if (isInstallerCommand(positional[0])) {
      opts.command = positional[0];
    } else if (!opts.showHelp) {
      throw new Error(`Unknown command: ${positional[0]}. Run with --help for usage.`);
    }
  }
  const isProject = projectDir !== undefined;
  const isCustomTarget = targetDir !== undefined;
  const explicitBinDir = nonEmptyStr(cliBinDir) !== undefined || nonEmptyStr(env.AGY_HUD_BIN_DIR) !== undefined;
  const binDir = resolveShimBinDir(cliBinDir, env);
  const manageShim = !opts.noShim && ((!isProject && !isCustomTarget) || explicitBinDir);
  const resolvedTarget =
    targetDir ??
    (projectDir !== undefined
      ? path.join(projectDir, '.agents', 'plugins', PLUGIN_NAME)
      : resolveGlobalPluginDir(PLUGIN_NAME, env));
  return {
    ...opts,
    manageShim,
    binDir,
    explicitBinDir,
    targetDir: resolvedTarget,
    isProject,
    isCustomTarget,
  };
}
