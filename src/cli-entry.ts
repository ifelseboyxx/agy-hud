#!/usr/bin/env node
import { CONFIGURE_NON_TTY_HINT, runConfigureInteractive } from './cli/configure-tui.ts';
import { type ConfigureCliArgs, configureHud, parseConfigureArgs } from './cli/configure.ts';
import { isInstallerCommand } from './cli/installer/args.ts';
import { runInstallerCli } from './cli/installer/index.ts';
import { exportProfile, importProfile } from './cli/migrate.ts';
import { runPreviewCommand } from './cli/preview.ts';
import type { PopupInputStream, PopupOutputStream } from './cli/snapshot-popup.ts';
import {
  executeParsedSnapshotCommand,
  executeParsedSnapshotPopupCommand,
  isSnapshotFilter,
  isSnapshotFlag,
  parseSnapshotArgs,
  runSnapshotCommand,
  type SnapshotRunOptions,
} from './cli/snapshot.ts';
import { isMainEntry } from './core/fs-utils.ts';

export { runInstallerCli };

export interface CliEntryOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly env?: NodeJS.ProcessEnv;
  readonly cliHome?: string;
  readonly geminiRoot?: string;
  readonly cwd?: string;
}

export interface CliAsyncEntryOptions extends CliEntryOptions {
  readonly stdin?: PopupInputStream;
  readonly stdout?: PopupOutputStream;
  readonly escTimeoutMs?: number;
}

function writeOut(text: string, options?: CliEntryOptions): void {
  (options?.stdout ?? process.stdout).write(text);
}

function writeErr(text: string, options?: CliEntryOptions): void {
  (options?.stderr ?? process.stderr).write(text);
}

function toSnapshotOptions(options?: CliEntryOptions): SnapshotRunOptions {
  return {
    cliHome: options?.cliHome,
    cwd: options?.cwd,
    env: options?.env,
  };
}

function printMainHelp(options?: CliEntryOptions): void {
  writeOut(
    `agy-hud CLI

Usage:
  agy-hud [command] [options]

Commands:
  snapshot (snap) Inspect full Activity Snapshot for Antigravity CLI (default)
  preview [width] Preview HUD status bar offline with sample telemetry
  configure       Inspect or update <cliHome>/hud-config.json
  export-profile  Export sanitized Antigravity CLI profile bundle
  import-profile  Import sanitized profile bundle without touching config.json
  wire / unwire   Wire or detach host statusLine and CLI Shim in-place
  install         Install or link agy-hud plugin
  uninstall       Remove agy-hud plugin and optionally restore statusLine
  on / off        Enable or disable agy-hud statusLine and plugin
  doctor / status Check installation and live HUD health

Options:
  -p, --popup     Open interactive snapshot overlay on a TTY (degrades when piped)
  --keybindings   Print terminal popup shortcut snippets (alias: --keymap)
  -h, --help      Show help for agy-hud or a subcommand

Quick inspection:
  !agy-hud        Inspect active session from the Antigravity CLI prompt box
  Cmd+Click       Open per-session Markdown snapshot from '+N more' / 'snapshot' links
`,
    options,
  );
}

function printConfigureHelp(options?: CliEntryOptions): void {
  writeOut(
    `agy-hud configure

Usage:
  agy-hud configure [<preset>] [options]

Presets:
  zen | minimal | compact | swarm | full

Options:
  --show                       Show current hud-config.json (default)
  --preset <preset>            Seed lines and segments from a persona preset
  --enable <id,...>            Enable Line Module(s) or Inline Segment(s) (repeatable)
  --disable <id,...>           Disable Line Module(s) or Inline Segment(s) (repeatable)
  --order <lineId,...>         Set explicit ordered Line Modules list
  --narrow-enable <id,...>     Enable module(s) or segment(s) when width < 100
  --narrow-disable <id,...>    Disable module(s) or segment(s) when width < 100
  --narrow-order <lineId,...>  Set narrow-pane Line Modules order (< 100 cols)
  --narrow-reset               Clear all narrow-pane overrides
  --set <key>=<value>          Set preset, osc8Links, maxAgentChips, costCurrency, usdToCnyRate, segments.<id>, narrow.*
  --reset                      Reset hud-config.json to full defaults
  --json                       Emit JSON output
  -i, --interactive            Launch interactive configuration editor
  -h, --help                   Show this help
`,
    options,
  );
}

function printExportHelp(options?: CliEntryOptions): void {
  writeOut(
    `agy-hud export-profile

Usage:
  agy-hud export-profile --out <dir>

Options:
  --out <dir>     Output directory for sanitized templates & plugins-manifest.json
  -h, --help      Show this help
`,
    options,
  );
}

function printImportHelp(options?: CliEntryOptions): void {
  writeOut(
    `agy-hud import-profile

Usage:
  agy-hud import-profile --in <dir> [--merge-mcp]

Options:
  --in <dir>      Profile directory containing exported templates
  --merge-mcp     Add missing MCP servers without overwriting existing ones
  -h, --help      Show this help
`,
    options,
  );
}

function parseValueFlag(argv: readonly string[], flag: string): { help: boolean; value: string; mergeMcp: boolean } {
  let help = false;
  let value = '';
  let mergeMcp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (flag === '--in' && arg === '--merge-mcp') {
      mergeMcp = true;
    } else if (arg === flag) {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing directory path after ${flag}`);
      }
      value = next;
      i += 1;
    } else if (arg.startsWith(`${flag}=`)) {
      const inline = arg.slice(flag.length + 1);
      if (inline.length === 0) {
        throw new Error(`Missing directory path after ${flag}=`);
      }
      value = inline;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { help, value, mergeMcp };
}

function executeParsedConfigure(parsed: ConfigureCliArgs, options?: CliEntryOptions): number {
  if (parsed.help) {
    printConfigureHelp(options);
    return 0;
  }
  if (parsed.interactive) {
    writeErr(CONFIGURE_NON_TTY_HINT, options);
    return 1;
  }
  const result = configureHud({
    ...parsed.options,
    cliHome: options?.cliHome ?? parsed.options.cliHome,
    env: options?.env ?? parsed.options.env,
  });
  if (parsed.json || result.action === 'show') {
    writeOut(`${JSON.stringify(result.config, null, 2)}\n`, options);
    return 0;
  }
  writeOut(`Updated ${result.configPath}\n${JSON.stringify(result.config, null, 2)}\n`, options);
  return 0;
}

function runExportCommand(args: readonly string[], options?: CliEntryOptions): void {
  const parsed = parseValueFlag(args, '--out');
  if (parsed.help) {
    printExportHelp(options);
    return;
  }
  if (parsed.value.length === 0) {
    throw new Error('Missing required option: --out <dir>');
  }
  const result = exportProfile({
    outDir: parsed.value,
    cliHome: options?.cliHome,
    geminiRoot: options?.geminiRoot,
    env: options?.env,
  });
  writeOut(`Exported profile to ${result.outDir}\n`, options);
  for (const file of result.filesWritten) {
    writeOut(`  - ${file}\n`, options);
  }
  writeOut(`Plugins recorded: ${result.pluginCount}\n`, options);
}

function runImportCommand(args: readonly string[], options?: CliEntryOptions): void {
  const parsed = parseValueFlag(args, '--in');
  if (parsed.help) {
    printImportHelp(options);
    return;
  }
  if (parsed.value.length === 0) {
    throw new Error('Missing required option: --in <dir>');
  }
  const result = importProfile({
    inDir: parsed.value,
    mergeMcp: parsed.mergeMcp,
    cliHome: options?.cliHome,
    geminiRoot: options?.geminiRoot,
    env: options?.env,
  });
  writeOut(`Imported profile from ${result.inDir}\n`, options);
  for (const file of result.filesUpdated) {
    writeOut(`  - Updated ${file}\n`, options);
  }
  if (result.mcpAction === 'skipped-exists') {
    writeOut('  - Skipped mcp_config.json (already exists; pass --merge-mcp to add missing servers)\n', options);
  } else if (result.mcpAction !== 'none') {
    writeOut(`  - MCP config: ${result.mcpAction}\n`, options);
  }
  if (result.pluginInstructions.length > 0) {
    writeOut('Manual plugin actions:\n', options);
    for (const line of result.pluginInstructions) {
      writeOut(`  - ${line}\n`, options);
    }
  }
}

type CliRoute =
  | { readonly kind: 'help' }
  | { readonly kind: 'installer'; readonly argv: readonly string[] }
  | { readonly kind: 'snapshot'; readonly args: readonly string[] }
  | { readonly kind: 'preview'; readonly args: readonly string[] }
  | { readonly kind: 'configure'; readonly args: readonly string[] }
  | { readonly kind: 'export-profile'; readonly args: readonly string[] }
  | { readonly kind: 'import-profile'; readonly args: readonly string[] }
  | { readonly kind: 'unknown'; readonly command: string };

function resolveCliRoute(argv: readonly string[]): CliRoute {
  const command = argv[0];
  if (command === '-h' || command === '--help' || command === 'help') {
    return { kind: 'help' };
  }
  if (!command) {
    return { kind: 'snapshot', args: [] };
  }
  if (isSnapshotFlag(command) || isSnapshotFilter(command)) {
    return { kind: 'snapshot', args: argv };
  }
  if (isInstallerCommand(command)) {
    return { kind: 'installer', argv };
  }
  const rest = argv.slice(1);
  switch (command) {
    case 'snapshot':
    case 'snap':
      return { kind: 'snapshot', args: rest };
    case 'preview':
      return { kind: 'preview', args: rest };
    case 'configure':
      return { kind: 'configure', args: rest };
    case 'export-profile':
      return { kind: 'export-profile', args: rest };
    case 'import-profile':
      return { kind: 'import-profile', args: rest };
    default:
      return { kind: 'unknown', command };
  }
}

function writeCliError(err: unknown, options?: CliEntryOptions): number {
  const message = err instanceof Error ? err.message : String(err);
  writeErr(`Error: ${message}\n`, options);
  return 1;
}

function executeNonInteractiveRoute(route: CliRoute, options: CliEntryOptions): number {
  switch (route.kind) {
    case 'help':
      printMainHelp(options);
      return 0;
    case 'installer':
      return runInstallerCli(route.argv, options);
    case 'snapshot':
      writeOut(runSnapshotCommand(route.args, toSnapshotOptions(options)).output, options);
      return 0;
    case 'preview':
      writeOut(
        runPreviewCommand(route.args, {
          cliHome: options.cliHome,
          env: options.env,
          stdoutColumns: (options.stdout as { columns?: number } | undefined)?.columns ?? process.stdout.columns,
        }),
        options,
      );
      return 0;
    case 'configure':
      return executeParsedConfigure(parseConfigureArgs(route.args), options);
    case 'export-profile':
      runExportCommand(route.args, options);
      return 0;
    case 'import-profile':
      runImportCommand(route.args, options);
      return 0;
    case 'unknown':
      throw new Error(`Unknown command: ${route.command}. Run with --help for usage.`);
  }
}

export function runCliEntry(argv: readonly string[] = process.argv.slice(2), options: CliEntryOptions = {}): number {
  const route = resolveCliRoute(argv);
  try {
    return executeNonInteractiveRoute(route, options);
  } catch (err) {
    return writeCliError(err, options);
  }
}

export async function runCliEntryAsync(
  argv: readonly string[] = process.argv.slice(2),
  options: CliAsyncEntryOptions = {},
): Promise<number> {
  const route = resolveCliRoute(argv);
  try {
    if (route.kind === 'configure') {
      const parsed = parseConfigureArgs(route.args);
      if (!parsed.help && parsed.interactive) {
        return await runConfigureInteractive({
          cliHome: options.cliHome,
          env: options.env,
          json: parsed.json,
          configureOptions: parsed.options,
          stdin: options.stdin,
          stdout: options.stdout,
          stderr: options.stderr ?? process.stderr,
          escTimeoutMs: options.escTimeoutMs,
        });
      }
      return executeParsedConfigure(parsed, options);
    }
    if (route.kind === 'snapshot') {
      const parsed = parseSnapshotArgs(route.args);
      if (!parsed.help && !parsed.listSessions && !parsed.json && parsed.keybindings === undefined && parsed.popup) {
        return await executeParsedSnapshotPopupCommand(parsed, options);
      }
      writeOut(executeParsedSnapshotCommand(parsed, toSnapshotOptions(options)).output, options);
      return 0;
    }
    return executeNonInteractiveRoute(route, options);
  } catch (err) {
    return writeCliError(err, options);
  }
}

if (isMainEntry(import.meta.url)) {
  void runCliEntryAsync(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
