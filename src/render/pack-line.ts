import { isFiniteNum } from '../core/guards.ts';
import { DEFAULT_TERM_WIDTH, GRAY, RESET, visibleLen } from './ansi.ts';

export interface ActivityLineFormatOptions {
  formatOverflow?: (hiddenCount: number) => string;
}

export interface PackableLineItem {
  render: () => string;
  renderEllipsized: (maxCols: number) => string;
}

export interface PackActivityLineInput {
  prefix: string;
  separator: string;
  items: readonly PackableLineItem[];
  maxItems: number;
  termWidth?: number;
  formatOverflow?: (hiddenCount: number) => string;
  sortSelectedIndices?: (indices: readonly number[]) => number[];
}

export function resolveLineBudget(termWidth?: number): number {
  const width = isFiniteNum(termWidth) && termWidth > 0 ? Math.floor(termWidth) : DEFAULT_TERM_WIDTH;
  return Math.max(1, width - 1);
}

export function formatDefaultOverflow(hiddenCount: number): string {
  return `${GRAY}+${hiddenCount} more${RESET}`;
}

export function packActivityLine(input: PackActivityLineInput): string {
  const { prefix, separator, items, maxItems, termWidth, sortSelectedIndices } = input;
  const total = items.length;
  if (total === 0 || maxItems <= 0) {
    return '';
  }

  const budget = resolveLineBudget(termWidth);
  const formatOverflow = input.formatOverflow ?? formatDefaultOverflow;
  const prefixCols = visibleLen(prefix);
  const sepCols = visibleLen(separator);
  const limit = Math.min(total, maxItems);
  const rendered: string[] = [];
  const widths: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    const item = items[i];
    if (!item) {
      continue;
    }
    const text = item.render();
    rendered.push(text);
    widths.push(visibleLen(text));
  }

  if (total <= maxItems) {
    let fullCols = prefixCols;
    for (let i = 0; i < total; i += 1) {
      fullCols += (i > 0 ? sepCols : 0) + (widths[i] ?? 0);
    }
    if (fullCols <= budget) {
      const indices = Array.from({ length: total }, (_, idx) => idx);
      const ordered = sortSelectedIndices ? sortSelectedIndices(indices) : indices;
      return `${prefix}${ordered.map((idx) => rendered[idx] ?? '').join(separator)}`;
    }
    if (total === 1) {
      const first = items[0];
      if (!first) {
        return '';
      }
      return `${prefix}${first.renderEllipsized(Math.max(1, budget - prefixCols))}`;
    }
  }

  const maxK = Math.min(maxItems, total - 1);
  let bestK = 0;
  let runningCols = prefixCols;
  for (let k = 1; k <= maxK; k += 1) {
    runningCols += (k > 1 ? sepCols : 0) + (widths[k - 1] ?? 0);
    const overflowCols = visibleLen(formatOverflow(total - k));
    if (runningCols + sepCols + overflowCols <= budget) {
      bestK = k;
    } else {
      break;
    }
  }

  if (bestK === 0) {
    const first = items[0];
    if (!first) {
      return '';
    }
    const overflow = formatOverflow(total - 1);
    const avail = Math.max(1, budget - prefixCols - sepCols - visibleLen(overflow));
    return `${prefix}${first.renderEllipsized(avail)}${separator}${overflow}`;
  }

  const selected = Array.from({ length: bestK }, (_, idx) => idx);
  const ordered = sortSelectedIndices ? sortSelectedIndices(selected) : selected;
  const shown = ordered.map((idx) => rendered[idx] ?? '');
  return `${prefix}${shown.join(separator)}${separator}${formatOverflow(total - bestK)}`;
}
