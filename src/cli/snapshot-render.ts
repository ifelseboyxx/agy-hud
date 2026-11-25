import path from 'node:path';

import { formatSurfaceBadge } from '../collectors/snapshot-envelope.ts';
import { nonEmptyStr } from '../core/guards.ts';
import { computeHudVisibleToolsCap } from '../render/activity-lines.ts';
import {
  BOLD,
  BRIGHT_WHITE,
  colorForUsedPct,
  CYAN,
  fmtTokens,
  GRAY,
  GREEN,
  MAGENTA,
  padEndVisible,
  RESET,
  truncateToWidth,
  visibleLen,
  YELLOW,
} from '../render/ansi.ts';
import type { ActivitySnapshot, SnapshotCompletedTool, SnapshotSection } from '../snapshot-types.ts';

export const DEFAULT_INSPECTOR_WIDTH: number = 100;

const MIN_INSPECTOR_COLS = 20;
const TWO_COL_MIN_WIDTH = 98;
const TWO_COL_MIN_TYPES = 5;

interface InspectorPalette {
  readonly reset: string;
  readonly bold: string;
  readonly dim: string;
  readonly green: string;
  readonly yellow: string;
  readonly cyan: string;
  readonly magenta: string;
  readonly white: string;
}

const ANSI_PALETTE: InspectorPalette = {
  reset: RESET,
  bold: BOLD,
  dim: GRAY,
  green: GREEN,
  yellow: YELLOW,
  cyan: CYAN,
  magenta: MAGENTA,
  white: BRIGHT_WHITE,
};

const PLAIN_PALETTE: InspectorPalette = {
  reset: '',
  bold: '',
  dim: '',
  green: '',
  yellow: '',
  cyan: '',
  magenta: '',
  white: '',
};

export interface StructuredInspectorOptions {
  readonly sections?: readonly SnapshotSection[];
  readonly width?: number;
  readonly color?: boolean;
  readonly noColor?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export function shouldUseSnapshotColor(noColorFlag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined) return false;
  if (env.TERM?.trim().toLowerCase() === 'dumb') return false;
  return true;
}

export function resolveInspectorWidth(explicitWidth?: number, stdoutColumns?: number): number {
  if (explicitWidth !== undefined && Number.isFinite(explicitWidth) && explicitWidth > 0) {
    return Math.floor(explicitWidth);
  }
  if (stdoutColumns !== undefined && Number.isFinite(stdoutColumns) && stdoutColumns > 0) {
    return Math.floor(stdoutColumns);
  }
  return DEFAULT_INSPECTOR_WIDTH;
}

function includesInspectorSection(active: ReadonlySet<SnapshotSection>, section: SnapshotSection): boolean {
  return active.size === 0 || active.has(section);
}

function buildSectionRule(heading: string, maxCols: number, palette: InspectorPalette): string {
  const safeHeading = truncateToWidth(heading, Math.max(4, maxCols - 6));
  const prefixCols = visibleLen(`── ${safeHeading} `);
  const rem = Math.max(2, maxCols - prefixCols);
  return `${palette.dim}──${palette.reset} ${palette.bold}${safeHeading}${palette.reset} ${palette.dim}${'─'.repeat(rem)}${palette.reset}`;
}

function wrapInspectorChips(chips: readonly string[], sep: string, maxCols: number, indent: string): string[] {
  if (chips.length === 0) return [];
  const sepCols = visibleLen(sep);
  const indentCols = visibleLen(indent);
  const lines: string[] = [];
  let cur: string[] = [];
  let curCols = indentCols;

  for (const chip of chips) {
    const w = visibleLen(chip);
    const nextCols = cur.length === 0 ? indentCols + w : curCols + sepCols + w;
    if (cur.length > 0 && nextCols > maxCols) {
      lines.push(`${indent}${cur.join(sep)}`);
      cur = [chip];
      curCols = indentCols + w;
    } else {
      cur.push(chip);
      curCols = nextCols;
    }
  }
  if (cur.length > 0) {
    lines.push(`${indent}${cur.join(sep)}`);
  }
  return lines;
}

function formatTelemetryStripLine(
  snapshot: ActivitySnapshot,
  maxCols: number,
  palette: InspectorPalette,
  useColor: boolean,
): string {
  const tel = snapshot.telemetry;
  const hasMetadata =
    tel.genCount > 0 || tel.ctxUsed !== null || tel.tps !== null || tel.ttft !== null || tel.cachePct !== null;
  if (!hasMetadata) return '';

  const parts: string[] = [];
  if (snapshot.model.length > 0) {
    parts.push(`${palette.cyan}${snapshot.model}${palette.reset}`);
  }
  if (tel.ctxUsed !== null && tel.ctxMax !== null && tel.ctxMax > 0) {
    const pct = Math.min(100, Math.round((tel.ctxUsed / tel.ctxMax) * 100));
    const ctxCol = useColor ? colorForUsedPct(pct) : '';
    parts.push(`Ctx ${ctxCol}${fmtTokens(tel.ctxUsed)}/${fmtTokens(tel.ctxMax)} (${pct}%)${palette.reset}`);
  }
  if (tel.tps !== null && tel.tps > 0) {
    const tpsText = tel.tps >= 100 ? `${tel.tps.toFixed(0)} t/s` : `${tel.tps.toFixed(1)} t/s`;
    parts.push(`${palette.green}${tpsText}${palette.reset}`);
  }
  if (tel.ttft !== null && tel.ttft > 0) {
    const ttftText = tel.ttft < 10 ? `${tel.ttft.toFixed(2)}s` : `${tel.ttft.toFixed(1)}s`;
    parts.push(`TTFT ${ttftText}`);
  }
  if (tel.cachePct !== null && (tel.genCount > 0 || tel.cachePct > 0)) {
    const pct = Math.round(Math.max(0, Math.min(100, tel.cachePct)));
    parts.push(`Cache ${pct}%`);
  }
  if (parts.length === 0) return '';

  const sep = ` ${palette.dim}·${palette.reset} `;
  const line = `${palette.dim}Telemetry:${palette.reset} ${parts.join(sep)}`;
  return visibleLen(line) <= maxCols ? line : truncateToWidth(line, maxCols);
}

function formatCompletedToolCell(
  item: SnapshotCompletedTool | undefined,
  idx: number,
  hudVisibleCap: number,
  colW: number,
  palette: InspectorPalette,
): string {
  if (!item) return '';
  const tag = idx >= hudVisibleCap ? `${palette.dim}+${palette.reset}` : ' ';
  const nameW = Math.min(22, Math.max(12, colW - 22));
  const cntW = 5;
  const namePart = padEndVisible(truncateToWidth(item.disp, nameW), nameW);
  const cntPart = padEndVisible(`×${item.count}`, cntW);
  const tgtMax = colW - (3 + nameW + 1 + cntW + 1);
  const tgt =
    item.latestTarget.length > 0 && tgtMax >= 4
      ? ` ${palette.dim}${truncateToWidth(item.latestTarget, tgtMax)}${palette.reset}`
      : '';
  return padEndVisible(
    `${tag}${palette.green}✓${palette.reset} ${namePart} ${palette.white}${cntPart}${palette.reset}${tgt}`,
    colW,
  );
}

function appendToolsSection(
  lines: string[],
  snapshot: ActivitySnapshot,
  cols: number,
  maxCols: number,
  palette: InspectorPalette,
): void {
  lines.push('');
  lines.push(
    buildSectionRule(
      `Tools (${snapshot.runningTools.length} running · ${snapshot.completedTools.length} types · ${snapshot.totalToolCalls} calls)`,
      maxCols,
      palette,
    ),
  );
  if (snapshot.runningTools.length === 0 && snapshot.completedTools.length === 0) {
    lines.push(`  ${palette.dim}(no tool activity recorded)${palette.reset}`);
    return;
  }

  const hudCaps = computeHudVisibleToolsCap(snapshot.runningTools, snapshot.completedTools, maxCols);
  const orderedRunning = [...snapshot.runningTools].reverse();
  for (let i = 0; i < orderedRunning.length; i += 1) {
    const rt = orderedRunning[i];
    if (!rt) continue;
    const overflowTag = i >= hudCaps.shownRunning ? `  ${palette.yellow}[+more]${palette.reset}` : '';
    const dispColW = Math.min(30, Math.max(12, maxCols - 30));
    const rawTarget = rt.target.length > 0 ? rt.target : rt.fullTarget;
    const usedCols = 2 + 2 + dispColW + 1 + 7 + (overflowTag.length > 0 ? 9 : 0);
    const tgtMax = Math.max(8, maxCols - usedCols - 3);
    const tgt = rawTarget.length > 0 ? `   ${truncateToWidth(rawTarget, tgtMax)}` : '';
    lines.push(
      `  ${palette.yellow}◐${palette.reset} ${padEndVisible(`${palette.cyan}${truncateToWidth(rt.disp, dispColW)}${palette.reset}`, dispColW)} ${palette.dim}running${palette.reset}${tgt}${overflowTag}`,
    );
  }

  const hudVisibleCap = hudCaps.shownCompleted;
  const useTwoCol = cols >= TWO_COL_MIN_WIDTH && snapshot.completedTools.length >= TWO_COL_MIN_TYPES;
  if (useTwoCol) {
    const colW = Math.floor((maxCols - 4) / 2);
    const half = Math.ceil(snapshot.completedTools.length / 2);
    for (let i = 0; i < half; i += 1) {
      const left = formatCompletedToolCell(snapshot.completedTools[i], i, hudVisibleCap, colW, palette);
      const right = formatCompletedToolCell(snapshot.completedTools[i + half], i + half, hudVisibleCap, colW, palette);
      lines.push(`  ${left}  ${right}`.trimEnd());
    }
    return;
  }

  const nameW = Math.min(28, Math.max(12, maxCols - 26));
  const cntW = 5;
  for (let i = 0; i < snapshot.completedTools.length; i += 1) {
    const ct = snapshot.completedTools[i];
    if (!ct) continue;
    const tag = i >= hudVisibleCap ? `${palette.dim}+${palette.reset}` : ' ';
    const tgtMax = maxCols - (2 + 3 + nameW + 1 + cntW + 9);
    const tgt =
      ct.latestTarget.length > 0 && tgtMax >= 4
        ? ` ${palette.dim}latest: ${truncateToWidth(ct.latestTarget, tgtMax)}${palette.reset}`
        : '';
    lines.push(
      `  ${tag}${palette.green}✓${palette.reset} ${padEndVisible(truncateToWidth(ct.disp, nameW), nameW)} ${palette.white}${padEndVisible(`×${ct.count}`, cntW)}${palette.reset}${tgt}`,
    );
  }
}

function appendMcpSection(
  lines: string[],
  snapshot: ActivitySnapshot,
  maxCols: number,
  palette: InspectorPalette,
): void {
  lines.push('');
  lines.push(buildSectionRule(`MCP Servers (${snapshot.mcps.length})`, maxCols, palette));
  if (snapshot.mcps.length === 0) {
    lines.push(`  ${palette.dim}(no MCP tool calls)${palette.reset}`);
    return;
  }
  const serverW = Math.min(18, Math.max(10, maxCols - 30));
  const totalW = 6;
  const contIndent = ' '.repeat(2 + 2 + serverW + 1 + totalW + 1);
  for (const srv of snapshot.mcps) {
    const head = `  ${palette.green}✓${palette.reset} ${padEndVisible(`${palette.cyan}${truncateToWidth(srv.server, serverW)}${palette.reset}`, serverW)} ${padEndVisible(`${palette.dim}(${srv.totalCalls})${palette.reset}`, totalW)} `;
    const subChips = srv.subtools.map((st) => `${st.name} ${palette.dim}×${st.count}${palette.reset}`);
    if (subChips.length === 0) {
      lines.push(head.trimEnd());
      continue;
    }
    const singleLine = `${head}${subChips.join(', ')}`;
    if (visibleLen(singleLine) <= maxCols) {
      lines.push(singleLine);
      continue;
    }
    const wrapped = wrapInspectorChips(subChips, ', ', maxCols, contIndent);
    const first = wrapped[0];
    if (first !== undefined) {
      lines.push(`${head}${first.slice(contIndent.length)}`);
      lines.push(...wrapped.slice(1));
    }
  }
}

function appendAgentsSection(
  lines: string[],
  snapshot: ActivitySnapshot,
  maxCols: number,
  palette: InspectorPalette,
): void {
  const alive = snapshot.agents.filter((a) => a.state !== 'done').length;
  const done = snapshot.agents.length - alive;
  const heading =
    snapshot.agentsKind === 'swarm'
      ? `Swarm (${alive} alive · ${done} stopped)`
      : `Agents (${alive} alive · ${done} done)`;
  lines.push('');
  lines.push(buildSectionRule(heading, maxCols, palette));
  if (snapshot.agents.length === 0) {
    lines.push(`  ${palette.dim}(no subagents or swarm workers)${palette.reset}`);
    return;
  }
  const nameW = Math.min(22, Math.max(10, maxCols - 48));
  const typeW = 10;
  const modelW = 12;
  for (const agent of snapshot.agents) {
    const icon =
      agent.state === 'working'
        ? `${palette.yellow}◐${palette.reset}`
        : agent.state === 'waiting'
          ? `${palette.cyan}◌${palette.reset}`
          : `${palette.green}✓${palette.reset}`;
    const stColor = agent.state === 'working' ? palette.yellow : agent.state === 'waiting' ? palette.cyan : palette.dim;
    const row = `  ${icon} ${padEndVisible(`${palette.magenta}${truncateToWidth(agent.name, nameW)}${palette.reset}`, nameW)}  ${padEndVisible(truncateToWidth(agent.type, typeW), typeW)}  ${padEndVisible(`${palette.dim}${truncateToWidth(agent.model, modelW)}${palette.reset}`, modelW)}  ${stColor}${agent.state}${palette.reset} ${palette.dim}(${agent.ageLabel})${palette.reset}`;
    lines.push(visibleLen(row) <= maxCols ? row : truncateToWidth(row, maxCols));
  }
}

export function renderStructuredInspectorLines(
  snapshot: ActivitySnapshot,
  options: StructuredInspectorOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const useColor = options.color !== undefined ? options.color : shouldUseSnapshotColor(options.noColor ?? false, env);
  const palette = useColor ? ANSI_PALETTE : PLAIN_PALETTE;
  const cols = resolveInspectorWidth(options.width, process.stdout.columns);
  const maxCols = Math.max(MIN_INSPECTOR_COLS, cols - 1);
  const active = new Set<SnapshotSection>(options.sections ?? []);
  const badge = formatSurfaceBadge(snapshot.surface);
  const wsName =
    snapshot.workspace.length > 0 ? (nonEmptyStr(path.basename(snapshot.workspace)) ?? snapshot.workspace) : '-';

  const headerPrefix = `[${badge}] Activity Snapshot  ${snapshot.shortId}  ""`;
  const titleBudget = Math.max(12, maxCols - visibleLen(headerPrefix));
  const lines: string[] = [
    `${palette.bold}${palette.white}[${badge}] Activity Snapshot${palette.reset}  ${palette.cyan}${snapshot.shortId}${palette.reset}  "${truncateToWidth(snapshot.title, titleBudget)}"`,
    `${palette.dim}Workspace: ${wsName} · Matched via ${snapshot.resolutionTier} · ${snapshot.totalToolCalls} calls, ${snapshot.skills.length} skills, ${snapshot.mcps.length} MCPs, ${snapshot.agents.length} ${snapshot.agentsKind}${palette.reset}`,
  ];

  const telemetryLine = formatTelemetryStripLine(snapshot, maxCols, palette, useColor);
  if (telemetryLine.length > 0) {
    lines.push(telemetryLine);
  }
  if (snapshot.siblingHint.length > 0) {
    lines.push(
      `${palette.yellow}Note:${palette.reset} ${palette.dim}${truncateToWidth(snapshot.siblingHint, Math.max(12, maxCols - 6))}${palette.reset}`,
    );
  }

  if (includesInspectorSection(active, 'tools')) {
    appendToolsSection(lines, snapshot, cols, maxCols, palette);
  }

  if (includesInspectorSection(active, 'skills')) {
    lines.push('');
    lines.push(buildSectionRule(`Skills (${snapshot.skills.length} chronological)`, maxCols, palette));
    if (snapshot.skills.length === 0) {
      lines.push(`  ${palette.dim}(no skills invoked)${palette.reset}`);
    } else {
      const chips = snapshot.skills.map(
        (s, idx) => `${palette.dim}${idx + 1}.${palette.reset} ${palette.cyan}${s}${palette.reset}`,
      );
      lines.push(...wrapInspectorChips(chips, '   ', maxCols, '  '));
    }
  }

  if (includesInspectorSection(active, 'mcps')) {
    appendMcpSection(lines, snapshot, maxCols, palette);
  }

  if (includesInspectorSection(active, 'agents')) {
    appendAgentsSection(lines, snapshot, maxCols, palette);
  }

  return lines;
}

export function renderStructuredInspector(
  snapshot: ActivitySnapshot,
  options: StructuredInspectorOptions = {},
): string {
  return `${renderStructuredInspectorLines(snapshot, options).join('\n')}\n`;
}
