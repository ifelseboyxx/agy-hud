import path from 'node:path';

import { expandHome, resolveGlobalPluginDir } from '../../core/paths.ts';

export const PLUGIN_NAME = 'agy-hud';

export type InstallerCommand = 'install' | 'uninstall' | 'on' | 'enable' | 'off' | 'disable' | 'doctor' | 'status';

const VALID_COMMANDS: ReadonlySet<string> = new Set<InstallerCommand>([
  'install',
  'uninstall',
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

type BooleanFlagKey = 'showHelp' | 'useLink' | 'skipEnable' | 'wireStatusLine' | 'restoreStatusLine' | 'quiet';

export interface InstallerOptions {
  command: InstallerCommand;
  useLink: boolean;
  skipEnable: boolean;
  wireStatusLine: boolean;
  restoreStatusLine: boolean;
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
  '--quiet': 'quiet',
  '-q': 'quiet',
};

export const INSTALLER_HELP_TEXT = `agy-hud installer
Usage: agy-hud [install|uninstall|on|enable|off|disable|doctor|status] [options]
Commands:
  install / uninstall    Install or remove agy-hud plugin
  on|enable / off|disable
                         Toggle statusLine.enabled and plugin state
  doctor / status        Check installation and live health
Options:
  --target <dir>         Custom plugin target directory
  --project [dir]        Install into <dir>/.agents/plugins/agy-hud
  --link                 Create a symlink to this repository
  --no-enable            Skip running agy plugin enable/disable
  --wire-statusline      Wire statusLine in <cliHome>/settings.json
  --restore-statusline   Restore prior statusLine backup on uninstall
  --quiet, -q            Suppress informational output
  -h, --help             Show this help`;

export function parseInstallerArgs(args: readonly string[]): InstallerOptions {
  let targetDir: string | undefined;
  let projectDir: string | undefined;
  const opts = {
    command: 'install' as InstallerCommand,
    useLink: false,
    skipEnable: false,
    wireStatusLine: false,
    restoreStatusLine: false,
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
      targetDir = path.resolve(expandHome(next));
    } else if (a === '--project') {
      const next = args[i + 1];
      projectDir = next && !next.startsWith('-') ? path.resolve(expandHome(args[++i] ?? '')) : process.cwd();
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
  const resolvedTarget =
    targetDir ??
    (projectDir !== undefined
      ? path.join(projectDir, '.agents', 'plugins', PLUGIN_NAME)
      : resolveGlobalPluginDir(PLUGIN_NAME));
  return {
    ...opts,
    targetDir: resolvedTarget,
    isProject: projectDir !== undefined,
    isCustomTarget: targetDir !== undefined,
  };
}
