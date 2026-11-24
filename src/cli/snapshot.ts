import path from 'node:path';

import {
  discoverSessions,
  formatSurfaceBadge,
  loadActivitySnapshot,
  matchesSourceFilter,
  resolveSession,
  type ResolveSessionOptions,
} from '../collectors/session-index.ts';
import { resolveProfileRoots } from '../core/paths.ts';
import { fmtTokens } from '../render/ansi.ts';
import type { ActivitySnapshot, SessionRecord, SessionSourceFilter, SnapshotSection } from '../snapshot-types.ts';

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
  --json                       Emit ANSI-free structured JSON output
  --no-color                   Disable ANSI colors in text output
  -h, --help                   Show this help
`;

export interface SnapshotCliArgs {
  help: boolean;
  listSessions: boolean;
  json: boolean;
  noColor: boolean;
  source: SessionSourceFilter;
  session?: string;
  sections: SnapshotSection[];
}

export interface SnapshotRunOptions extends Omit<ResolveSessionOptions, 'session' | 'source'> {
  env?: NodeJS.ProcessEnv;
}

export interface SnapshotRunResult {
  output: string;
  snapshot?: ActivitySnapshot;
  sessions?: SessionRecord[];
}

export function isSnapshotFlag(arg: string): boolean {
  return (
    arg === '-s' ||
    arg === '--session' ||
    arg.startsWith('--session=') ||
    arg === '--sessions' ||
    arg === '--source' ||
    arg.startsWith('--source=') ||
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

    const mapped = FILTER_ALIASES[arg.toLowerCase()];
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
  const rows = sessions.map((s) => ({
    badge: `[${formatSurfaceBadge(s.surface)}]`,
    id: s.shortId,
    state: formatSessionStateColumn(s),
    workspace: s.workspace.length > 0 ? path.basename(s.workspace) || s.workspace : '-',
    title: s.title,
  }));
  const stateWidth = Math.max(8, ...rows.map((r) => r.state.length));
  const wsWidth = Math.max(9, Math.min(24, ...rows.map((r) => r.workspace.length)));
  const lines = rows.map((r) => {
    const ws = r.workspace.length > wsWidth ? `${r.workspace.slice(0, wsWidth - 1)}…` : r.workspace.padEnd(wsWidth);
    return `${r.badge.padEnd(5)}  ${r.id}  ${r.state.padEnd(stateWidth)}  ${ws}  ${r.title}`;
  });
  return `${lines.join('\n')}\n`;
}

function formatSnapshotTelemetryStrip(snapshot: ActivitySnapshot): string {
  const tel = snapshot.telemetry;
  if (tel.genCount <= 0 && tel.ctxUsed === null && tel.tps === null) return '';
  const parts: string[] = [];
  if (snapshot.model.length > 0) parts.push(snapshot.model);
  if (tel.ctxUsed !== null && tel.ctxMax !== null && tel.ctxMax > 0) {
    const pct = Math.min(100, Math.round((tel.ctxUsed / tel.ctxMax) * 100));
    parts.push(`Ctx ${fmtTokens(tel.ctxUsed)}/${fmtTokens(tel.ctxMax)} (${pct}%)`);
  }
  if (tel.tps !== null) parts.push(`${tel.tps.toFixed(1)} t/s`);
  if (tel.ttft !== null) parts.push(`TTFT ${tel.ttft.toFixed(2)}s`);
  if (tel.cachePct !== null) parts.push(`Cache ${Math.round(tel.cachePct)}%`);
  return parts.join(' | ');
}

function includesSnapshotSection(active: ReadonlySet<SnapshotSection>, section: SnapshotSection): boolean {
  return active.size === 0 || active.has(section);
}

export function formatSnapshotText(snapshot: ActivitySnapshot, sections: readonly SnapshotSection[] = []): string {
  const active = new Set<SnapshotSection>(sections);
  const badge = formatSurfaceBadge(snapshot.surface);
  const wsName = snapshot.workspace.length > 0 ? path.basename(snapshot.workspace) || snapshot.workspace : '-';
  const lines: string[] = [
    `[${badge}] Activity Snapshot  ${snapshot.shortId}  "${snapshot.title}"`,
    `Workspace: ${wsName} | Matched via ${snapshot.resolutionTier} | ${snapshot.totalToolCalls} calls, ${snapshot.skills.length} skills, ${snapshot.mcps.length} MCPs, ${snapshot.agents.length} ${snapshot.agentsKind}`,
  ];

  const telLine = formatSnapshotTelemetryStrip(snapshot);
  if (telLine.length > 0) lines.push(`Telemetry: ${telLine}`);
  if (snapshot.siblingHint.length > 0) lines.push(`Note: ${snapshot.siblingHint}`);

  if (includesSnapshotSection(active, 'tools')) {
    lines.push('');
    lines.push(
      `-- Tools (${snapshot.runningTools.length} running, ${snapshot.completedTools.length} types, ${snapshot.totalToolCalls} calls) --`,
    );
    if (snapshot.runningTools.length === 0 && snapshot.completedTools.length === 0) {
      lines.push('  (none)');
    }
    for (const rt of snapshot.runningTools) {
      const tgt = rt.target.length > 0 ? `  ${rt.target}` : '';
      lines.push(`  ◐ ${rt.disp}  running${tgt}`);
    }
    for (const ct of snapshot.completedTools) {
      const tgt = ct.latestTarget.length > 0 ? `  ${ct.latestTarget}` : '';
      lines.push(`  ✓ ${ct.disp}  x${ct.count}${tgt}`);
    }
  }

  if (includesSnapshotSection(active, 'skills')) {
    lines.push('');
    lines.push(`-- Skills (${snapshot.skills.length}) --`);
    lines.push(
      snapshot.skills.length === 0 ? '  (none)' : `  ${snapshot.skills.map((s, i) => `${i + 1}. ${s}`).join('  ')}`,
    );
  }

  if (includesSnapshotSection(active, 'mcps')) {
    lines.push('');
    lines.push(`-- MCP Servers (${snapshot.mcps.length}) --`);
    if (snapshot.mcps.length === 0) {
      lines.push('  (none)');
    }
    for (const srv of snapshot.mcps) {
      const subs = srv.subtools.map((st) => `${st.name} x${st.count}`).join(', ');
      lines.push(`  ✓ ${srv.server} (${srv.totalCalls})  ${subs}`);
    }
  }

  if (includesSnapshotSection(active, 'agents')) {
    const heading = snapshot.agentsKind === 'swarm' ? 'Swarm' : 'Agents';
    lines.push('');
    lines.push(`-- ${heading} (${snapshot.agents.length}) --`);
    if (snapshot.agents.length === 0) {
      lines.push('  (none)');
    }
    for (const a of snapshot.agents) {
      const icon = a.state === 'working' ? '◐' : a.state === 'waiting' ? '◌' : '✓';
      lines.push(`  ${icon} ${a.name}  ${a.type}  ${a.model}  ${a.state} (${a.ageLabel})`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function runSnapshotCommand(argv: readonly string[], options: SnapshotRunOptions = {}): SnapshotRunResult {
  const parsed = parseSnapshotArgs(argv);
  if (parsed.help) {
    return { output: SNAPSHOT_HELP_TEXT };
  }

  const env = options.env ?? process.env;
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

  if (parsed.json) {
    return { output: `${JSON.stringify(snapshot, null, 2)}\n`, snapshot, sessions: resolved.sessions };
  }
  return { output: formatSnapshotText(snapshot, parsed.sections), snapshot, sessions: resolved.sessions };
}
