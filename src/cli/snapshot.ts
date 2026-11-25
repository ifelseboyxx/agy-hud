import path from 'node:path';

import { discoverSessions } from '../collectors/session-discovery.ts';
import { matchesSourceFilter, resolveSession, type ResolveSessionOptions } from '../collectors/session-index.ts';
import { formatSurfaceBadge } from '../collectors/snapshot-envelope.ts';
import { loadActivitySnapshot } from '../collectors/snapshot-loader.ts';
import { nonEmptyStr } from '../core/guards.ts';
import { resolveProfileRoots } from '../core/paths.ts';
import { sanitizeTerminalLabel, sanitizeTerminalText } from '../core/terminal-text.ts';
import type { ActivitySnapshot, SessionRecord, SessionSourceFilter, SnapshotSection } from '../snapshot-types.ts';
import { type KeybindingsTarget, parseKeybindingsTarget, renderKeybindings } from './keybindings.ts';
import { type PopupInputStream, type PopupOutputStream, runSnapshotPopup } from './snapshot-popup.ts';
import {
  renderStructuredInspector,
  shouldUseSnapshotColor,
  type StructuredInspectorOptions,
} from './snapshot-render.ts';

const VALID_SOURCES: ReadonlySet<string> = new Set(['auto', 'cli', 'app', 'all']);

const FILTER_ALIASES: Readonly<Record<string, SnapshotSection | 'all'>> = {
  all: 'all',
  tool: 'tools',
  tools: 'tools',
  skill: 'skills',
  skills: 'skills',
  mcp: 'mcps',
  mcps: 'mcps',
  agent: 'agents',
  agents: 'agents',
  swarm: 'agents',
  swarms: 'agents',
};

export const SNAPSHOT_HELP_TEXT: string = `agy-hud snapshot (alias: snap; default when run with no arguments)

Usage:
  agy-hud [snapshot|snap] [filters...] [options]

Filters (repeatable, case-insensitive):
  all | tools | skills | mcps | agents | swarm

Options:
  -s, --session <id|prefix>    Inspect a specific session by full ID or unique >=4-char prefix
  --sessions                   List active and recent top-level sessions across surfaces
  --source <auto|cli|app|all>  Filter discovery source (default: auto; app includes app + ide)
  -p, --popup                  Open interactive single-key-dismiss overlay on a TTY (degrades when piped)
  --keybindings [target]       Print terminal popup shortcut snippets (alias: --keymap)
                               Targets: tmux | kitty | wezterm | ghostty | iterm2 | all
  --json                       Emit ANSI-free structured JSON output
  --no-color                   Disable ANSI colors in text output
  -h, --help                   Show this help

Channels:
  !agy-hud                     One-shot Structured Inspector in the Antigravity CLI prompt box
  agy-hud -p                   Interactive popup overlay (q/Esc/Enter to close, 1-4/a filter, r reload)
  Cmd+Click                    Open per-session Markdown snapshot from status line '+N more' / 'snapshot'
`;

export interface SnapshotCliArgs {
  help: boolean;
  listSessions: boolean;
  popup: boolean;
  keybindings?: KeybindingsTarget | 'auto';
  json: boolean;
  noColor: boolean;
  source: SessionSourceFilter;
  session?: string;
  sections: SnapshotSection[];
}

export interface SnapshotRunOptions extends Omit<ResolveSessionOptions, 'session' | 'source'> {
  env?: NodeJS.ProcessEnv;
  width?: number;
  binDir?: string;
  pluginRoot?: string;
  platform?: NodeJS.Platform;
}

export interface SnapshotPopupCommandOptions extends SnapshotRunOptions {
  stdin?: PopupInputStream;
  stdout?: PopupOutputStream;
  escTimeoutMs?: number;
}

export interface SnapshotRunResult {
  output: string;
  snapshot?: ActivitySnapshot;
  sessions?: SessionRecord[];
}

export function isSnapshotFilter(arg: string): boolean {
  return Object.hasOwn(FILTER_ALIASES, arg.toLowerCase());
}

export function isSnapshotFlag(arg: string): boolean {
  return (
    arg === '-s' ||
    arg === '--session' ||
    arg.startsWith('--session=') ||
    arg === '--sessions' ||
    arg === '--source' ||
    arg.startsWith('--source=') ||
    arg === '-p' ||
    arg === '--popup' ||
    arg === '--keybindings' ||
    arg.startsWith('--keybindings=') ||
    arg === '--keymap' ||
    arg.startsWith('--keymap=') ||
    arg === '--json' ||
    arg === '--no-color'
  );
}

function parseSourceFlagValue(raw: string): SessionSourceFilter {
  const normalized = raw.trim().toLowerCase();
  if (VALID_SOURCES.has(normalized)) {
    return normalized as SessionSourceFilter;
  }
  throw new Error(`Invalid --source value "${raw}" (expected: auto | cli | app | all)`);
}

export function parseSnapshotArgs(argv: readonly string[]): SnapshotCliArgs {
  let help = false;
  let listSessions = false;
  let popup = false;
  let keybindings: KeybindingsTarget | 'auto' | undefined;
  let json = false;
  let noColor = false;
  let source: SessionSourceFilter = 'auto';
  let session: string | undefined;
  let explicitAll = false;
  const sections: SnapshotSection[] = [];
  const seenSections = new Set<SnapshotSection>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--sessions') {
      listSessions = true;
      continue;
    }
    if (arg === '-p' || arg === '--popup') {
      popup = true;
      continue;
    }
    if (arg === '--keybindings' || arg === '--keymap') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        keybindings = parseKeybindingsTarget(next);
        i += 1;
      } else {
        keybindings = 'auto';
      }
      continue;
    }
    if (arg.startsWith('--keybindings=') || arg.startsWith('--keymap=')) {
      const eqIdx = arg.indexOf('=');
      const prefix = arg.slice(0, eqIdx + 1);
      const val = arg.slice(eqIdx + 1);
      if (val.length === 0) {
        throw new Error(`Missing value after ${prefix}`);
      }
      keybindings = parseKeybindingsTarget(val);
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--no-color') {
      noColor = true;
      continue;
    }
    if (arg === '-s' || arg === '--session') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing value after ${arg}`);
      }
      session = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--session=')) {
      const val = arg.slice('--session='.length);
      if (val.length === 0) {
        throw new Error('Missing value after --session=');
      }
      session = val;
      continue;
    }
    if (arg === '--source') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value after --source');
      }
      source = parseSourceFlagValue(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--source=')) {
      const val = arg.slice('--source='.length);
      if (val.length === 0) {
        throw new Error('Missing value after --source=');
      }
      source = parseSourceFlagValue(val);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown snapshot option: ${arg}`);
    }

    const key = arg.toLowerCase();
    const mapped = Object.hasOwn(FILTER_ALIASES, key) ? FILTER_ALIASES[key] : undefined;
    if (mapped === undefined) {
      throw new Error(`Unknown snapshot filter "${arg}" (expected: all | tools | skills | mcps | agents | swarm)`);
    }
    if (mapped === 'all') {
      explicitAll = true;
    } else if (!seenSections.has(mapped)) {
      seenSections.add(mapped);
      sections.push(mapped);
    }
  }

  return {
    help,
    listSessions,
    popup,
    keybindings,
    json,
    noColor,
    source,
    session,
    sections: explicitAll ? [] : sections,
  };
}

function formatSessionStateColumn(session: SessionRecord): string {
  if (session.livePid !== null) return `live:${session.livePid}`;
  if (session.running) return 'running';
  return session.ageLabel;
}

export function formatSessionsTable(sessions: readonly SessionRecord[], source: SessionSourceFilter): string {
  if (sessions.length === 0) {
    return `No Antigravity sessions found (source: ${source}).\n`;
  }
  const rows = sessions.map((s) => {
    const rawWs = s.workspace.length > 0 ? (nonEmptyStr(path.basename(s.workspace)) ?? s.workspace) : '-';
    const workspace = nonEmptyStr(sanitizeTerminalText(rawWs)) ?? '-';
    return {
      badge: `[${formatSurfaceBadge(s.surface)}]`,
      id: sanitizeTerminalText(s.shortId),
      state: formatSessionStateColumn(s),
      workspace,
      title: sanitizeTerminalLabel(s.title),
    };
  });
  const stateWidth = Math.max(8, ...rows.map((r) => r.state.length));
  const wsWidth = Math.max(9, Math.min(24, ...rows.map((r) => r.workspace.length)));
  const lines = rows.map((r) => {
    const ws = r.workspace.length > wsWidth ? `${r.workspace.slice(0, wsWidth - 1)}…` : r.workspace.padEnd(wsWidth);
    return `${r.badge.padEnd(5)}  ${r.id}  ${r.state.padEnd(stateWidth)}  ${ws}  ${r.title}`;
  });
  return `${lines.join('\n')}\n`;
}

export function formatSnapshotText(
  snapshot: ActivitySnapshot,
  sections: readonly SnapshotSection[] = [],
  options: Omit<StructuredInspectorOptions, 'sections'> = {},
): string {
  return renderStructuredInspector(snapshot, { ...options, sections });
}

function loadSnapshotForParsedArgs(
  parsed: SnapshotCliArgs,
  options: SnapshotRunOptions,
): { snapshot: ActivitySnapshot; sessions: SessionRecord[] } {
  const env = options.env ?? process.env;
  const { cliHome, geminiRoot } = resolveProfileRoots(options.cliHome, options.geminiRoot, env);
  const resolved = resolveSession({
    ...options,
    cliHome,
    geminiRoot,
    env,
    session: parsed.session,
    source: parsed.source,
  });
  const snapshot = loadActivitySnapshot(resolved.session, {
    cacheCliHome: cliHome,
    resolutionTier: resolved.tier,
    siblings: resolved.siblings,
    nowMs: options.nowMs,
  });
  return { snapshot, sessions: resolved.sessions };
}

export function executeParsedSnapshotCommand(
  parsed: SnapshotCliArgs,
  options: SnapshotRunOptions = {},
): SnapshotRunResult {
  if (parsed.help) {
    return { output: SNAPSHOT_HELP_TEXT };
  }

  const env = options.env ?? process.env;
  if (parsed.keybindings !== undefined) {
    return {
      output: renderKeybindings({
        target: parsed.keybindings,
        env,
        color: shouldUseSnapshotColor(parsed.noColor, env),
        binDir: options.binDir,
        pluginRoot: options.pluginRoot,
        platform: options.platform,
      }),
    };
  }

  const { cliHome, geminiRoot } = resolveProfileRoots(options.cliHome, options.geminiRoot, env);
  if (parsed.listSessions) {
    const all = discoverSessions({ ...options, cliHome, geminiRoot, env });
    const filtered = all.filter((s) => matchesSourceFilter(s.surface, parsed.source));
    if (parsed.json) {
      return {
        output: `${JSON.stringify({ source: parsed.source, sessions: filtered }, null, 2)}\n`,
        sessions: filtered,
      };
    }
    return { output: formatSessionsTable(filtered, parsed.source), sessions: filtered };
  }

  const { snapshot, sessions } = loadSnapshotForParsedArgs(parsed, options);
  if (parsed.json) {
    return { output: `${JSON.stringify(snapshot, null, 2)}\n`, snapshot, sessions };
  }
  return {
    output: formatSnapshotText(snapshot, parsed.sections, {
      width: options.width,
      color: shouldUseSnapshotColor(parsed.noColor, env),
      env,
    }),
    snapshot,
    sessions,
  };
}

export function runSnapshotCommand(argv: readonly string[], options: SnapshotRunOptions = {}): SnapshotRunResult {
  return executeParsedSnapshotCommand(parseSnapshotArgs(argv), options);
}

export async function executeParsedSnapshotPopupCommand(
  parsed: SnapshotCliArgs,
  options: SnapshotPopupCommandOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  return await runSnapshotPopup({
    loadSnapshot: () => loadSnapshotForParsedArgs(parsed, options).snapshot,
    initialSections: parsed.sections,
    color: shouldUseSnapshotColor(parsed.noColor, env),
    noColor: parsed.noColor,
    env,
    stdin: options.stdin,
    stdout: options.stdout,
    escTimeoutMs: options.escTimeoutMs,
  });
}

export async function runSnapshotPopupCommand(
  argv: readonly string[],
  options: SnapshotPopupCommandOptions = {},
): Promise<number> {
  return await executeParsedSnapshotPopupCommand(parseSnapshotArgs(argv), options);
}
