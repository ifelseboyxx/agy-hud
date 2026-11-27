import { resolveSessionCost } from '../core/cost-utils.ts';
import { isFiniteNum } from '../core/guards.ts';
import { DEFAULT_USD_TO_CNY_RATE, NARROW_PANE_WIDTH_THRESHOLD } from '../core/hud-config.ts';
import type { SnapshotCost } from '../snapshot-types.ts';
import type { HudCostCurrency, StatusLineCost } from '../types.ts';
import { BRIGHT_YELLOW, GRAY, RESET } from './ansi.ts';

export interface CostFormatOptions {
  readonly currency?: HudCostCurrency;
  readonly usdToCnyRate?: number;
  readonly compact?: boolean;
  readonly termWidth?: number;
}

function formatUsdAmount(usd: number, compact = false): string {
  if (compact || usd >= 10) {
    return `$${usd.toFixed(2)}`;
  }
  return `$${usd.toFixed(3)}`;
}

function formatCnyAmount(usd: number, rate: number = DEFAULT_USD_TO_CNY_RATE): string {
  const rounded = Math.round((usd * rate + 1e-12) * 100) / 100;
  return `¥${rounded.toFixed(2)}`;
}

function formatCostAmount(usd: number, options: CostFormatOptions = {}): string {
  const currency = options.currency ?? 'usd';
  const rate =
    isFiniteNum(options.usdToCnyRate) && options.usdToCnyRate > 0 ? options.usdToCnyRate : DEFAULT_USD_TO_CNY_RATE;
  const compact =
    options.compact === true || (isFiniteNum(options.termWidth) && options.termWidth < NARROW_PANE_WIDTH_THRESHOLD);

  if (currency === 'cny') {
    return formatCnyAmount(usd, rate);
  }
  if (currency === 'both') {
    const usdStr = formatUsdAmount(usd, compact);
    const cnyStr = formatCnyAmount(usd, rate);
    return compact ? `${usdStr}/${cnyStr}` : `${usdStr} / ${cnyStr}`;
  }
  return formatUsdAmount(usd, false);
}

export function formatSessionCostText(cost: SnapshotCost, options: CostFormatOptions = {}): string {
  const prefix = cost.estimated ? '~' : '';
  return `${prefix}${formatCostAmount(cost.totalUsd, options)}`;
}

export function formatSubagentCostText(cost: SnapshotCost, options: CostFormatOptions = {}): string | null {
  if (cost.subagentUsd === null || cost.subagentUsd <= 0) {
    return null;
  }
  return formatCostAmount(cost.subagentUsd, options);
}

export function formatCostBreakdown(cost: SnapshotCost, options: CostFormatOptions = {}): string {
  const total = formatSessionCostText(cost, options);
  const sub = formatSubagentCostText(cost, options);
  return sub !== null ? `${total} (subagents ${sub})` : total;
}

export function formatCostSegment(cost: StatusLineCost | null | undefined, options: CostFormatOptions = {}): string {
  const resolved = resolveSessionCost(cost);
  if (resolved === null) return '';
  return `${GRAY}Cost ${BRIGHT_YELLOW}${formatSessionCostText(resolved, options)}${RESET}`;
}
