import type { SnapshotCost } from '../snapshot-types.ts';
import type { StatusLineCost } from '../types.ts';
import { isFiniteNum, isPlainObject } from './guards.ts';

export function resolveSessionCost(cost: StatusLineCost | null | undefined): SnapshotCost | null {
  if (!cost) return null;
  const rawUsd = isFiniteNum(cost.total_usd) ? cost.total_usd : cost.total_cost_usd;
  if (!isFiniteNum(rawUsd) || rawUsd < 0) return null;
  const rawSub = cost.subagent_usd;
  const subagentUsd = isFiniteNum(rawSub) && rawSub >= 0 ? rawSub : null;
  return {
    totalUsd: rawUsd,
    subagentUsd,
    estimated: cost.estimated === true,
  };
}

export function parseSnapshotCostRecord(raw: unknown): SnapshotCost | null {
  if (!isPlainObject(raw)) return null;
  if (!isFiniteNum(raw.totalUsd) || raw.totalUsd < 0) return null;
  const subagentUsd =
    raw.subagentUsd === null || raw.subagentUsd === undefined
      ? null
      : isFiniteNum(raw.subagentUsd) && raw.subagentUsd >= 0
        ? raw.subagentUsd
        : null;
  return {
    totalUsd: raw.totalUsd,
    subagentUsd,
    estimated: raw.estimated === true,
  };
}
