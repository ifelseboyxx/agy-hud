#!/usr/bin/env node
import { configureHud, parseConfigureArgs } from './cli/configure.ts';
import { isInstallerCommand } from './cli/installer/args.ts';
import { runInstallerCli } from './cli/installer/index.ts';
import { exportProfile, importProfile } from './cli/migrate.ts';
import { isSnapshotFlag, runSnapshotCommand } from './cli/snapshot.ts';
import { isMainEntry } from './core/paths.ts';

export { runInstallerCli };

function writeOut(text: string): void {
  process.stdout.write(text);
}

function writeErr(text: string): void {
  process.stderr.write(text);
}

function printMainHelp(): void {
  writeOut(`agy-hud CLI

Usage:
  agy-hud [command] [options]

Commands:
  snapshot (snap) Inspect full Activity Snapshot across CLI/App/IDE (default)
  configure       Inspect or update <cliHome>/hud-config.json
  export-profile  Export sanitized Antigravity CLI profile bundle
  import-profile  Import sanitized profile bundle without touching config.json
  wire / unwire   Wire or detach host statusLine and CLI Shim in-place
  install         Install or link agy-hud plugin
  uninstall       Remove agy-hud plugin and optionally restore statusLine
  on / off        Enable or disable agy-hud statusLine and plugin
  doctor / status Check installation and live HUD health

Options:
  -h, --help      Show help for agy-hud or a subcommand
`);
}

function printConfigureHelp(): void {
  writeOut(`agy-hud configure

Usage:
  agy-hud configure [options]

Options:
  --show                       Show current hud-config.json (default)
  --preset <full|compact|minimal>
                               Set display preset
  --set <key>=<value>          Set a specific config key (repeatable)
  --reset                      Reset hud-config.json to defaults
  --json                       Emit JSON output
  -h, --help                   Show this help
`);
}

function printExportHelp(): void {
  writeOut(`agy-hud export-profile

Usage:
  agy-hud export-profile --out <dir>

Options:
  --out <dir>     Output directory for sanitized templates & plugins-manifest.json
  -h, --help      Show this help
`);
}

function printImportHelp(): void {
  writeOut(`agy-hud import-profile

Usage:
  agy-hud import-profile --in <dir> [--merge-mcp]

Options:
  --in <dir>      Profile directory containing exported templates
  --merge-mcp     Add missing MCP servers without overwriting existing ones
  -h, --help      Show this help
`);
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

function runConfigureCommand(args: readonly string[]): void {
  const parsed = parseConfigureArgs(args);
  if (parsed.help) {
    printConfigureHelp();
    return;
  }
  const result = configureHud(parsed.options);
  if (parsed.json || result.action === 'show') {
    writeOut(`${JSON.stringify(result.config, null, 2)}\n`);
    return;
  }
  writeOut(`Updated ${result.configPath}\n${JSON.stringify(result.config, null, 2)}\n`);
}

function runExportCommand(args: readonly string[]): void {
  const parsed = parseValueFlag(args, '--out');
  if (parsed.help) {
    printExportHelp();
    return;
  }
  if (parsed.value.length === 0) {
    throw new Error('Missing required option: --out <dir>');
  }
  const result = exportProfile({ outDir: parsed.value });
  writeOut(`Exported profile to ${result.outDir}\n`);
  for (const file of result.filesWritten) {
    writeOut(`  - ${file}\n`);
  }
  writeOut(`Plugins recorded: ${result.pluginCount}\n`);
}

function runImportCommand(args: readonly string[]): void {
  const parsed = parseValueFlag(args, '--in');
  if (parsed.help) {
    printImportHelp();
    return;
  }
  if (parsed.value.length === 0) {
    throw new Error('Missing required option: --in <dir>');
  }
  const result = importProfile({ inDir: parsed.value, mergeMcp: parsed.mergeMcp });
  writeOut(`Imported profile from ${result.inDir}\n`);
  for (const file of result.filesUpdated) {
    writeOut(`  - Updated ${file}\n`);
  }
  if (result.mcpAction === 'skipped-exists') {
    writeOut('  - Skipped mcp_config.json (already exists; pass --merge-mcp to add missing servers)\n');
  } else if (result.mcpAction !== 'none') {
    writeOut(`  - MCP config: ${result.mcpAction}\n`);
  }
  if (result.pluginInstructions.length > 0) {
    writeOut('Manual plugin actions:\n');
    for (const line of result.pluginInstructions) {
      writeOut(`  - ${line}\n`);
    }
  }
}

export function runCliEntry(argv: readonly string[] = process.argv.slice(2)): number {
  const command = argv[0];
  if (command === '-h' || command === '--help' || command === 'help') {
    printMainHelp();
    return 0;
  }

  try {
    if (!command) {
      writeOut(runSnapshotCommand([]).output);
      return 0;
    }
    if (isSnapshotFlag(command)) {
      writeOut(runSnapshotCommand(argv).output);
      return 0;
    }
    const rest = argv.slice(1);
    if (isInstallerCommand(command)) {
      return runInstallerCli(argv);
    }
    switch (command) {
      case 'snapshot':
      case 'snap':
        writeOut(runSnapshotCommand(rest).output);
        return 0;
      case 'configure':
        runConfigureCommand(rest);
        return 0;
      case 'export-profile':
        runExportCommand(rest);
        return 0;
      case 'import-profile':
        runImportCommand(rest);
        return 0;
      default:
        throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`Error: ${message}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  const code = runCliEntry(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
