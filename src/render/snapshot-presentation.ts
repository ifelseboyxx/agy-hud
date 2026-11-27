import { isFiniteNum } from '../core/guards.ts';
import type { SnapshotAgent, SubagentAggregateRollup, SubagentTelemetryRollup } from '../snapshot-types.ts';
import type { AgentsKind, ContextBreakdownSummary, SessionTelemetry } from '../types.ts';
import { fmtTokens } from './ansi.ts';

export type ContextCategoryKey = 'system' | 'rules' | 'skills' | 'tools' | 'mcp' | 'messages' | 'free';

export interface ContextBreakdownRowModel {
  readonly key: ContextCategoryKey;
  readonly label: string;
  readonly tokens: number;
  readonly tokenText: string;
  readonly shareText: string;
  readonly optional: boolean;
  readonly estimated: boolean;
}

export interface ContextRoleRowModel {
  readonly model: string;
  readonly role: string | null;
  readonly genCount: number;
  readonly ctxText: string;
}

export interface ContextSectionModel {
  readonly used: number | null;
  readonly budget: number | null;
  readonly headingSuffix: string;
  readonly metaNotes: readonly string[];
  readonly breakdown: ContextBreakdownSummary | null;
  readonly rows: readonly ContextBreakdownRowModel[];
  readonly roles: readonly ContextRoleRowModel[];
}

export interface AgentsHeadingSummary {
  readonly heading: string;
  readonly aliveCount: number;
  readonly doneCount: number;
}

function formatSharePct(tokens: number, budget: number): string {
  if (budget <= 0 || tokens <= 0) return '0%';
  const pct = (tokens / budget) * 100;
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

export function hasContextSectionData(telemetry: SessionTelemetry | null | undefined): boolean {
  if (!telemetry) return false;
  if (telemetry.contextBreakdown !== undefined && telemetry.contextBreakdown !== null) return true;
  if (telemetry.compaction !== undefined && telemetry.compaction !== null) return true;
  return telemetry.modelRoles !== undefined && telemetry.modelRoles !== null && telemetry.modelRoles.length >= 2;
}

export function buildContextSectionModel(
  telemetry: SessionTelemetry | null | undefined,
  nominalWindowSize?: number | null,
): ContextSectionModel | null {
  if (!telemetry || !hasContextSectionData(telemetry)) {
    return null;
  }
  const bd = telemetry.contextBreakdown ?? null;
  const budget = bd?.budget ?? telemetry.ctxMax ?? null;
  const used = bd?.used ?? telemetry.ctxUsed ?? null;
  const tilde = telemetry.compacted === true ? '~' : '';
  const headingSuffix =
    isFiniteNum(used) && isFiniteNum(budget) && budget > 0
      ? ` · ${tilde}${fmtTokens(used)}/${fmtTokens(budget)} (${Math.min(100, Math.round((used / budget) * 100))}%)`
      : '';

  const metaNotes: string[] = [];
  if (isFiniteNum(nominalWindowSize) && nominalWindowSize > 0 && isFiniteNum(budget) && nominalWindowSize !== budget) {
    metaNotes.push(`Nominal ${fmtTokens(nominalWindowSize)}`);
  }
  if (isFiniteNum(telemetry.providerInputTokens) && telemetry.providerInputTokens > 0) {
    metaNotes.push(`Provider in: ${fmtTokens(telemetry.providerInputTokens)}`);
  }
  if (telemetry.truncationReason) {
    metaNotes.push(`Truncation: ${telemetry.truncationReason}`);
  }
  if (telemetry.compaction && telemetry.compaction.count >= 1) {
    const pre = isFiniteNum(telemetry.compaction.preUsed) ? fmtTokens(telemetry.compaction.preUsed) : '?';
    const post = isFiniteNum(telemetry.compaction.postUsed)
      ? `${telemetry.compaction.active ? '~' : ''}${fmtTokens(telemetry.compaction.postUsed)}`
      : '?';
    metaNotes.push(`Compacted ×${telemetry.compaction.count} (${pre} -> ${post})`);
  }

  const rows: ContextBreakdownRowModel[] = [];
  if (bd !== null && bd.budget > 0) {
    const entries: Array<readonly [ContextCategoryKey, string, number, boolean, boolean]> = [
      ['system', 'System', bd.system, false, false],
      ['rules', 'Rules', bd.rules, true, false],
      ['skills', 'Skills', bd.skills, true, false],
      ['tools', 'Tools', bd.tools, true, false],
      ['mcp', 'MCP', bd.mcp, true, false],
      ['messages', 'Messages', bd.messages, false, bd.estimatedMessages],
      ['free', 'Free', bd.free, false, false],
    ];
    for (const [key, label, tokens, optional, estimated] of entries) {
      rows.push({
        key,
        label,
        tokens,
        tokenText: `${estimated ? '~' : ''}${fmtTokens(tokens)}`,
        shareText: formatSharePct(tokens, bd.budget),
        optional,
        estimated,
      });
    }
  }

  const roles: ContextRoleRowModel[] = [];
  if (telemetry.modelRoles && telemetry.modelRoles.length >= 2) {
    for (const entry of telemetry.modelRoles) {
      const ctxText =
        entry.lastCtxMax > 0
          ? `${fmtTokens(entry.lastCtxUsed)}/${fmtTokens(entry.lastCtxMax)}`
          : fmtTokens(entry.lastCtxUsed);
      roles.push({
        model: entry.model,
        role: entry.role ?? null,
        genCount: entry.genCount,
        ctxText,
      });
    }
  }

  return { used, budget, headingSuffix, metaNotes, breakdown: bd, rows, roles };
}

export function formatSubagentTelemetryParts(tel: SubagentTelemetryRollup | null | undefined): string[] {
  if (!tel) return [];
  const parts: string[] = [];
  if (tel.ctxUsed !== null) {
    parts.push(
      tel.ctxMax !== null && tel.ctxMax > 0
        ? `Ctx ${fmtTokens(tel.ctxUsed)}/${fmtTokens(tel.ctxMax)}`
        : `Ctx ${fmtTokens(tel.ctxUsed)}`,
    );
  }
  if (tel.totalInputTokens > 0 || tel.totalOutputTokens > 0) {
    parts.push(`${fmtTokens(tel.totalInputTokens)}/${fmtTokens(tel.totalOutputTokens)}`);
  }
  if (tel.cachePct !== null) parts.push(`Cache ${tel.cachePct}%`);
  if (tel.tps !== null && tel.tps > 0) parts.push(`${Math.round(tel.tps)} tok/s`);
  if (tel.retryCount > 0) parts.push(`retry ×${tel.retryCount}`);
  if (tel.errorCount > 0) parts.push(`err ×${tel.errorCount}`);
  return parts;
}

export function formatSubagentRollupParts(rollup: SubagentAggregateRollup | null | undefined): string[] {
  if (!rollup || rollup.measuredCount <= 0) return [];
  const parts = [
    `${rollup.measuredCount}/${rollup.childCount} measured`,
    `${rollup.totalGenCount} gens`,
    `In ${fmtTokens(rollup.totalInputTokens)}`,
    rollup.totalThinkingTokens > 0
      ? `Out ${fmtTokens(rollup.totalOutputTokens)} (think ${fmtTokens(rollup.totalThinkingTokens)})`
      : `Out ${fmtTokens(rollup.totalOutputTokens)}`,
  ];
  if (rollup.cachePct !== null) parts.push(`Cache ${rollup.cachePct}%`);
  if (rollup.retryCount > 0) parts.push(`Retries ×${rollup.retryCount}`);
  if (rollup.errorCount > 0) parts.push(`Errors ×${rollup.errorCount}`);
  return parts;
}

export function formatToolsSectionHeading(runningCount: number, completedTypes: number, totalCalls: number): string {
  return `Tools (${runningCount} running · ${completedTypes} types · ${totalCalls} calls)`;
}

export function formatAgentsSectionHeading(
  kind: AgentsKind,
  agents: readonly Pick<SnapshotAgent, 'state'>[],
): AgentsHeadingSummary {
  const aliveCount = agents.filter((a) => a.state !== 'done').length;
  const doneCount = agents.length - aliveCount;
  const heading =
    kind === 'swarm'
      ? `Swarm (${aliveCount} alive · ${doneCount} stopped)`
      : `Agents (${aliveCount} alive · ${doneCount} done)`;
  return { heading, aliveCount, doneCount };
}
