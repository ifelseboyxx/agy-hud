import path from 'node:path';

import { formatSurfaceBadge } from '../collectors/snapshot-envelope.ts';
import { nonEmptyStr, selectNewestFirst } from '../core/guards.ts';
import { sanitizeTerminalText } from '../core/terminal-text.ts';
import { computeHudVisibleToolsCap } from '../render/activity-lines.ts';
import {
  BOLD,
  BRIGHT_WHITE,
  colorForUsedPct,
  CYAN,
  formatTelemetryFields,
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
  const chipMaxCols = Math.max(1, maxCols - indentCols);
  const lines: string[] = [];
  let cur: string[] = [];
  let curCols = indentCols;

  for (const rawChip of chips) {
    const rawW = visibleLen(rawChip);
    const chip = rawW > chipMaxCols ? truncateToWidth(rawChip, chipMaxCols) : rawChip;
    const w = rawW > chipMaxCols ? visibleLen(chip) : rawW;
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
    parts.push(`${palette.cyan}${sanitizeTerminalText(snapshot.model)}${palette.reset}`);
  }
  const fields = formatTelemetryFields(tel);
  if (fields.ctx !== null) {
    const ctxCol = useColor ? colorForUsedPct(fields.ctx.pct) : '';
    parts.push(`Ctx ${ctxCol}${fields.ctx.text}${palette.reset}`);
  }
  if (fields.tpsText !== null) {
    parts.push(`${palette.green}${fields.tpsText}${palette.reset}`);
  }
  if (fields.ttftText !== null) {
    parts.push(`TTFT ${fields.ttftText}`);
  }
  if (fields.cacheText !== null) {
    parts.push(`Cache ${fields.cacheText}`);
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
  const cleanDisp = sanitizeTerminalText(item.disp);
  const cleanTarget = sanitizeTerminalText(item.latestTarget);
  const namePart = padEndVisible(truncateToWidth(cleanDisp, nameW), nameW);
  const cntPart = padEndVisible(`×${item.count}`, cntW);
  const tgtMax = colW - (3 + nameW + 1 + cntW + 1);
  const tgt =
    cleanTarget.length > 0 && tgtMax >= 4
      ? ` ${palette.dim}${truncateToWidth(cleanTarget, tgtMax)}${palette.reset}`
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
  const orderedRunning = selectNewestFirst(snapshot.runningTools);
  for (let i = 0; i < orderedRunning.length; i += 1) {
    const rt = orderedRunning[i];
    if (!rt) continue;
    const overflowTag = i >= hudCaps.shownRunning ? `  ${palette.yellow}[+more]${palette.reset}` : '';
    const dispColW = Math.min(30, Math.max(12, maxCols - 30));
    const cleanDisp = sanitizeTerminalText(rt.disp);
    const rawTarget = sanitizeTerminalText(rt.target.length > 0 ? rt.target : rt.fullTarget);
    const usedCols = 2 + 2 + dispColW + 1 + 7 + (overflowTag.length > 0 ? 9 : 0);
    const tgtMax = Math.max(8, maxCols - usedCols - 3);
    const tgt = rawTarget.length > 0 ? `   ${truncateToWidth(rawTarget, tgtMax)}` : '';
    lines.push(
      `  ${palette.yellow}◐${palette.reset} ${padEndVisible(`${palette.cyan}${truncateToWidth(cleanDisp, dispColW)}${palette.reset}`, dispColW)} ${palette.dim}running${palette.reset}${tgt}${overflowTag}`,
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
    const cleanDisp = sanitizeTerminalText(ct.disp);
    const cleanTarget = sanitizeTerminalText(ct.latestTarget);
    const tgtMax = maxCols - (2 + 3 + nameW + 1 + cntW + 9);
    const tgt =
      cleanTarget.length > 0 && tgtMax >= 4
        ? ` ${palette.dim}latest: ${truncateToWidth(cleanTarget, tgtMax)}${palette.reset}`
        : '';
    lines.push(
      `  ${tag}${palette.green}✓${palette.reset} ${padEndVisible(truncateToWidth(cleanDisp, nameW), nameW)} ${palette.white}${padEndVisible(`×${ct.count}`, cntW)}${palette.reset}${tgt}`,
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
    const cleanServer = sanitizeTerminalText(srv.server);
    const head = `  ${palette.green}✓${palette.reset} ${padEndVisible(`${palette.cyan}${truncateToWidth(cleanServer, serverW)}${palette.reset}`, serverW)} ${padEndVisible(`${palette.dim}(${srv.totalCalls})${palette.reset}`, totalW)} `;
    const subChips = srv.subtools.map(
      (st) => `${sanitizeTerminalText(st.name)} ${palette.dim}×${st.count}${palette.reset}`,
    );
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
    const row = `  ${icon} ${padEndVisible(`${palette.magenta}${truncateToWidth(sanitizeTerminalText(agent.name), nameW)}${palette.reset}`, nameW)}  ${padEndVisible(truncateToWidth(sanitizeTerminalText(agent.type), typeW), typeW)}  ${padEndVisible(`${palette.dim}${truncateToWidth(sanitizeTerminalText(agent.model), modelW)}${palette.reset}`, modelW)}  ${stColor}${agent.state}${palette.reset} ${palette.dim}(${sanitizeTerminalText(agent.ageLabel)})${palette.reset}`;
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
  const wsName = sanitizeTerminalText(
    snapshot.workspace.length > 0 ? (nonEmptyStr(path.basename(snapshot.workspace)) ?? snapshot.workspace) : '-',
  );
  const cleanShortId = sanitizeTerminalText(snapshot.shortId);
  const cleanTitle = sanitizeTerminalText(snapshot.title);

  const headerPrefix = `[${badge}] Activity Snapshot  ${cleanShortId}  ""`;
  const titleBudget = Math.max(1, maxCols - visibleLen(headerPrefix));
  const bannerLine0 = `${palette.bold}${palette.white}[${badge}] Activity Snapshot${palette.reset}  ${palette.cyan}${cleanShortId}${palette.reset}  "${truncateToWidth(cleanTitle, titleBudget)}"`;
  const bannerMeta = `Workspace: ${wsName} · Matched via ${snapshot.resolutionTier} · ${snapshot.totalToolCalls} calls, ${snapshot.skills.length} skills, ${snapshot.mcps.length} MCPs, ${snapshot.agents.length} ${snapshot.agentsKind}`;
  const bannerLine1 = `${palette.dim}${truncateToWidth(bannerMeta, maxCols)}${palette.reset}`;
  const lines: string[] = [
    visibleLen(bannerLine0) <= maxCols ? bannerLine0 : truncateToWidth(bannerLine0, maxCols),
    bannerLine1,
  ];

  const telemetryLine = formatTelemetryStripLine(snapshot, maxCols, palette, useColor);
  if (telemetryLine.length > 0) {
    lines.push(telemetryLine);
  }
  if (snapshot.siblingHint.length > 0) {
    lines.push(
      `${palette.yellow}Note:${palette.reset} ${palette.dim}${truncateToWidth(sanitizeTerminalText(snapshot.siblingHint), Math.max(12, maxCols - 6))}${palette.reset}`,
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
        (s, idx) =>
          `${palette.dim}${idx + 1}.${palette.reset} ${palette.cyan}${sanitizeTerminalText(s)}${palette.reset}`,
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
