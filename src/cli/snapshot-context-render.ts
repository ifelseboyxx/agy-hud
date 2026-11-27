import { sanitizeTerminalText } from '../core/terminal-text.ts';
import {
  BRIGHT_BLUE,
  BRIGHT_CYAN,
  BRIGHT_GREEN,
  BRIGHT_MAGENTA,
  BRIGHT_YELLOW,
  GRAY,
  padEndVisible,
  RESET,
  truncateToWidth,
  visibleLen,
} from '../render/ansi.ts';
import {
  buildContextSectionModel,
  type ContextBreakdownRowModel,
  type ContextCategoryKey,
  hasContextSectionData,
} from '../render/snapshot-presentation.ts';
import type { ActivitySnapshot } from '../snapshot-types.ts';

export interface ContextSectionPalette {
  readonly reset: string;
  readonly bold: string;
  readonly dim: string;
  readonly green: string;
  readonly yellow: string;
  readonly cyan: string;
  readonly magenta: string;
  readonly white: string;
}

const CATEGORY_COLORS: Readonly<Record<ContextCategoryKey, string>> = {
  system: BRIGHT_CYAN,
  rules: BRIGHT_BLUE,
  skills: BRIGHT_MAGENTA,
  tools: BRIGHT_YELLOW,
  mcp: BRIGHT_GREEN,
  messages: BRIGHT_CYAN,
  free: GRAY,
};

function buildStackedContextBar(
  rows: readonly ContextBreakdownRowModel[],
  freeTokens: number,
  budget: number,
  barWidth: number,
  useColor: boolean,
): string {
  if (budget <= 0 || barWidth <= 0) return '';
  let usedCells = 0;
  const parts: string[] = [];

  for (const row of rows) {
    if (row.key === 'free' || row.tokens <= 0) continue;
    const exact = (row.tokens / budget) * barWidth;
    const cells = Math.min(barWidth - usedCells, Math.max(exact > 0 ? 1 : 0, Math.round(exact)));
    if (cells <= 0) continue;
    usedCells += cells;
    const col = CATEGORY_COLORS[row.key];
    parts.push(useColor ? `${col}${'█'.repeat(cells)}${RESET}` : '█'.repeat(cells));
    if (usedCells >= barWidth) break;
  }

  const freeCells = Math.max(0, barWidth - usedCells);
  if (freeCells > 0 && freeTokens >= 0) {
    parts.push(useColor ? `${GRAY}${'░'.repeat(freeCells)}${RESET}` : '░'.repeat(freeCells));
  }
  return parts.join('');
}

export function hasContextSectionContent(snapshot: ActivitySnapshot): boolean {
  return hasContextSectionData(snapshot.telemetry);
}

export function appendContextSection(
  lines: string[],
  snapshot: ActivitySnapshot,
  maxCols: number,
  palette: ContextSectionPalette,
  useColor: boolean,
  buildRule: (heading: string, width: number) => string,
): void {
  const model = buildContextSectionModel(snapshot.telemetry, snapshot.nominalContextWindowSize);
  lines.push('');
  lines.push(buildRule(`Context${model?.headingSuffix ?? ''}`, maxCols));

  if (model === null) {
    lines.push(`  ${palette.dim}(no context breakdown recorded)${palette.reset}`);
    return;
  }

  if (model.metaNotes.length > 0) {
    const noteLine = `  ${palette.dim}${model.metaNotes.join(' · ')}${palette.reset}`;
    lines.push(visibleLen(noteLine) <= maxCols ? noteLine : truncateToWidth(noteLine, maxCols));
  }

  if (model.breakdown !== null && model.breakdown.budget > 0 && model.rows.length > 0) {
    const barWidth = Math.max(16, Math.min(40, maxCols - 10));
    const bar = buildStackedContextBar(model.rows, model.breakdown.free, model.breakdown.budget, barWidth, useColor);
    lines.push(`  ${bar}`);

    for (const row of model.rows) {
      if (row.optional && row.tokens <= 0) continue;
      const labelPart = padEndVisible(row.label, 10);
      const tokPart = padEndVisible(row.tokenText, 8);
      const line = `  ${palette.cyan}${labelPart}${palette.reset} ${palette.white}${tokPart}${palette.reset} ${palette.dim}${row.shareText}${palette.reset}`;
      lines.push(visibleLen(line) <= maxCols ? line : truncateToWidth(line, maxCols));
    }
  }

  if (model.roles.length >= 2) {
    lines.push(`  ${palette.dim}Roles / Models:${palette.reset}`);
    for (const entry of model.roles) {
      const roleTag = entry.role !== null ? ` [${entry.role}]` : '';
      const row = `    ${palette.cyan}${sanitizeTerminalText(entry.model)}${palette.reset}${palette.yellow}${roleTag}${palette.reset}  ${palette.dim}×${entry.genCount} · ${entry.ctxText}${palette.reset}`;
      lines.push(visibleLen(row) <= maxCols ? row : truncateToWidth(row, maxCols));
    }
  }
}
