import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nonEmptyStr } from '../core/guards.ts';
import { resolveGlobalPluginDir, SAFE_POSIX_SHELL_PATH_RE, SAFE_WIN_SHELL_PATH_RE } from '../core/paths.ts';
import { hasTerminalControlChars, sanitizeTerminalText } from '../core/terminal-text.ts';
import { BOLD, CYAN, GRAY, RESET } from '../render/ansi.ts';
import { PLUGIN_NAME } from './installer/args.ts';
import { expectedCliMjsPath, quotePosixSh } from './installer/shim-format.ts';
import { inspectCliShim, resolveShimBinDir, resolveShimPaths } from './installer/shim.ts';
import { shouldUseSnapshotColor } from './snapshot-render.ts';

export type HostTerminal = 'tmux' | 'kitty' | 'wezterm' | 'ghostty' | 'iterm2';
export type KeybindingsTarget = HostTerminal | 'all';

const HOST_ORDER: readonly HostTerminal[] = ['tmux', 'kitty', 'wezterm', 'ghostty', 'iterm2'];
const VALID_TARGETS: ReadonlySet<string> = new Set([...HOST_ORDER, 'all']);

export interface ResolveKeybindingCommandOptions {
  readonly binDir?: string;
  readonly pluginRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface ResolvedKeybindingCommand {
  readonly source: 'shim' | 'node-fallback';
  readonly shimPath: string | null;
  readonly cliMjsPath: string;
  readonly popupArgs: readonly string[];
  readonly shellCommand: string;
}

export interface RenderKeybindingsOptions extends ResolveKeybindingCommandOptions {
  readonly target?: KeybindingsTarget | 'auto';
  readonly color?: boolean;
  readonly noColor?: boolean;
}

export function detectHostTerminal(env: NodeJS.ProcessEnv = process.env): HostTerminal | null {
  if (nonEmptyStr(env.TMUX) !== undefined) return 'tmux';
  if (nonEmptyStr(env.KITTY_PID) !== undefined) return 'kitty';
  if (nonEmptyStr(env.WEZTERM_PANE) !== undefined) return 'wezterm';
  const termProgram = env.TERM_PROGRAM?.trim().toLowerCase() ?? '';
  if (nonEmptyStr(env.GHOSTTY_RESOURCES_DIR) !== undefined || termProgram === 'ghostty') return 'ghostty';
  if (nonEmptyStr(env.ITERM_SESSION_ID) !== undefined || termProgram === 'iterm.app') return 'iterm2';
  return null;
}

export function parseKeybindingsTarget(raw: string): KeybindingsTarget {
  const normalized = raw.trim().toLowerCase();
  if (VALID_TARGETS.has(normalized)) {
    return normalized as KeybindingsTarget;
  }
  throw new Error(`Invalid --keybindings target "${raw}" (expected: tmux | kitty | wezterm | ghostty | iterm2 | all)`);
}

function resolveKeybindingsPluginRoot(env: NodeJS.ProcessEnv): string {
  const globalDir = resolveGlobalPluginDir(PLUGIN_NAME, env);
  if (existsSync(path.join(globalDir, 'dist', 'cli.mjs'))) {
    return globalDir;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, 'plugin.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return globalDir;
}

function assertSafeKeybindingPath(value: string): void {
  if (hasTerminalControlChars(value)) {
    throw new Error('Invalid keybinding command path: path must not contain control, escape, or bidi characters.');
  }
}

function quoteShellArgForPlatform(value: string, platform: NodeJS.Platform, alwaysQuoteSafe = false): string {
  assertSafeKeybindingPath(value);
  if (platform === 'win32') {
    if (!alwaysQuoteSafe && SAFE_WIN_SHELL_PATH_RE.test(value)) return value;
    return `"${value.replaceAll('"', '""').replaceAll('%', '%%')}"`;
  }
  if (SAFE_POSIX_SHELL_PATH_RE.test(value)) {
    return alwaysQuoteSafe ? `"${value}"` : value;
  }
  return quotePosixSh(value);
}

function quoteTmuxCommandString(shellCommand: string): string {
  if (!shellCommand.includes("'") && shellCommand.includes('"')) {
    return `'${shellCommand}'`;
  }
  return `"${shellCommand.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;
}

function quoteLuaSingle(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export function resolveKeybindingCommand(options: ResolveKeybindingCommandOptions = {}): ResolvedKeybindingCommand {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pluginRoot = options.pluginRoot ?? resolveKeybindingsPluginRoot(env);
  const binDir = resolveShimBinDir(options.binDir, env, platform);
  const paths = resolveShimPaths(binDir, platform);
  const cliMjsPath = expectedCliMjsPath(pluginRoot, platform);
  assertSafeKeybindingPath(cliMjsPath);
  const inspection = inspectCliShim(binDir, pluginRoot, env, platform);

  if (inspection.status === 'owned-self' || inspection.status === 'owned-other') {
    const shimPath = paths.primaryPath;
    return {
      source: 'shim',
      shimPath,
      cliMjsPath,
      popupArgs: [shimPath, '-p'],
      shellCommand: `${quoteShellArgForPlatform(shimPath, platform)} -p`,
    };
  }

  return {
    source: 'node-fallback',
    shimPath: null,
    cliMjsPath,
    popupArgs: ['node', cliMjsPath, '-p'],
    shellCommand: `node ${quoteShellArgForPlatform(cliMjsPath, platform, true)} -p`,
  };
}

function formatHostSnippet(
  host: HostTerminal,
  cmd: ResolvedKeybindingCommand,
  useColor: boolean,
  platform: NodeJS.Platform,
): string[] {
  const b = useColor ? BOLD : '';
  const c = useColor ? CYAN : '';
  const d = useColor ? GRAY : '';
  const r = useColor ? RESET : '';

  if (host === 'tmux') {
    const tmuxPopupCmd = quoteTmuxCommandString(cmd.shellCommand);
    return [
      `${b}tmux${r} ${d}(~/.tmux.conf)${r}`,
      `  ${c}bind-key g display-popup -E -w 85% -h 80% -d "#{pane_current_path}" ${tmuxPopupCmd}${r}`,
    ];
  }

  if (host === 'kitty') {
    return [
      `${b}Kitty${r} ${d}(~/.config/kitty/kitty.conf)${r}`,
      `  ${c}map ctrl+shift+h launch --type=overlay --cwd=current ${cmd.shellCommand}${r}`,
    ];
  }

  if (host === 'wezterm') {
    const luaArgs = cmd.popupArgs.map(quoteLuaSingle).join(', ');
    return [
      `${b}WezTerm${r} ${d}(~/.wezterm.lua — inside config.keys; inherits active pane cwd & CloseOnCleanExit)${r}`,
      `  ${c}{${r}`,
      `  ${c}  key = 'H',${r}`,
      `  ${c}  mods = 'CTRL|SHIFT',${r}`,
      `  ${c}  action = wezterm.action.SplitPane {${r}`,
      `  ${c}    direction = 'Down',${r}`,
      `  ${c}    size = { Percent = 45 },${r}`,
      `  ${c}    command = { args = { ${luaArgs} } },${r}`,
      `  ${c}  },${r}`,
      `  ${c}}${r}`,
    ];
  }

  if (host === 'ghostty') {
    const lines = [
      `${b}Ghostty${r} ${d}(~/.config/ghostty/config)${r}`,
      `  Native Cmd+Click on status line '+N more' / 'snapshot' links works zero-config.`,
      `  ${c}keybind = super+shift+h=text:!agy-hud\\n${r}`,
      `  ${d}Caution: Ghostty text: types directly into the focused pane; trigger only inside the agy prompt.${r}`,
    ];
    if (cmd.source === 'node-fallback') {
      const ghosttyArg = quoteShellArgForPlatform(cmd.cliMjsPath, platform, true).replaceAll('\\', '\\\\');
      lines.push(`  ${d}Without CLI Shim on PATH: keybind = super+shift+h=text:!node ${ghosttyArg}\\n${r}`);
    }
    return lines;
  }

  return [
    `${b}iTerm2${r} ${d}(Settings -> Profiles -> Keys -> Configure Hotkey Window; plus native Cmd+Click)${r}`,
    `  Command:           ${c}${cmd.shellCommand}${r}`,
    `  Working Directory: Reuse previous session's directory`,
    `  Session:           Close sessions on end`,
  ];
}

export function renderKeybindings(options: RenderKeybindingsOptions = {}): string {
  const env = options.env ?? process.env;
  const useColor = options.color !== undefined ? options.color : shouldUseSnapshotColor(options.noColor ?? false, env);
  const b = useColor ? BOLD : '';
  const d = useColor ? GRAY : '';
  const r = useColor ? RESET : '';

  const detected = detectHostTerminal(env);
  const requested = options.target ?? 'auto';
  const hosts: readonly HostTerminal[] =
    requested === 'all'
      ? HOST_ORDER
      : requested === 'auto'
        ? detected !== null
          ? [detected]
          : HOST_ORDER
        : [requested];

  const platform = options.platform ?? process.platform;
  const resolved = resolveKeybindingCommand(options);
  const lines: string[] = [`${b}agy-hud Popup Keybinding Snippets${r}`];

  if (requested === 'auto') {
    if (detected !== null) {
      lines.push(`${d}Detected host: ${detected} (run "agy-hud snapshot --keybindings all" for all terminals)${r}`);
    } else {
      lines.push(`${d}Host terminal not detected; showing all supported templates.${r}`);
    }
  }

  const commandSourceNote =
    resolved.source === 'shim'
      ? `Command: ${sanitizeTerminalText(resolved.shimPath ?? '')} (CLI Shim)`
      : `Command: node "${sanitizeTerminalText(resolved.cliMjsPath)}" (fallback — CLI Shim not installed)`;
  lines.push(`${d}${commandSourceNote}${r}`);

  for (const host of hosts) {
    lines.push('');
    lines.push(...formatHostSnippet(host, resolved, useColor, platform));
  }

  lines.push('');
  lines.push(`${d}Note: agy-hud never modifies terminal config files; paste the snippet above manually.${r}`);
  return `${lines.join('\n')}\n`;
}
