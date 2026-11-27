import { createHash } from 'node:crypto';

import { aggregateActivityTools, mergeActivityAgents } from '../core/activity-aggregate.ts';
import { resolveSessionCost } from '../core/cost-utils.ts';
import { isFiniteNum, nonEmptyStr, selectNewestFirst } from '../core/guards.ts';
import { resolveSnapshotQuotaBuckets } from '../core/quota-pace.ts';
import { normalizeHostAgentState, resolveTurnPhase } from '../core/telemetry-error.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { SnapshotAgent, SubagentAggregateRollup, TurnPhase } from '../snapshot-types.ts';
import type { AgentsSummary, HudCostCurrency, SessionTelemetry, StatusLineData, TranscriptActivity } from '../types.ts';
import { formatSessionCostText, formatSubagentCostText } from './cost.ts';
import { formatSnapshotQuotaLine } from './quota.ts';
import {
  buildContextSectionModel,
  formatAgentsSectionHeading,
  formatSubagentRollupParts,
  formatSubagentTelemetryParts,
  formatToolsSectionHeading,
} from './snapshot-presentation.ts';
import { formatTelemetryDiagnostics, formatTelemetryFields } from './telemetry-format.ts';

const HUD_RUNNING_TOOL_CAP = 2;
const HUD_COMPLETED_TOOL_CAP = 8;

export interface SnapshotMarkdownRenderOptions {
  convId: string;
  data: StatusLineData;
  activity: TranscriptActivity | null;
  agentsSummary: AgentsSummary | null;
  telemetry?: SessionTelemetry | null;
  turnPhase?: TurnPhase;
  snapshotAgents?: readonly SnapshotAgent[];
  subagentRollup?: SubagentAggregateRollup | null;
  resolvedFileLinks?: ReadonlyMap<string, string>;
  costCurrency?: HudCostCurrency;
  usdToCnyRate?: number;
  nowMs?: number;
}

export interface RenderedSnapshotMarkdown {
  readonly markdown: string;
  readonly contentDigest: string;
}

const MARKDOWN_INLINE_ESCAPE_RE = /([\\`*_[\]()!<>|~])/g;

function escapeMarkdownCell(text: string): string {
  return sanitizeTerminalLabel(text).replace(MARKDOWN_INLINE_ESCAPE_RE, '\\$1');
}

function computeCodeFence(text: string): string {
  let maxRun = 0;
  let curRun = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '`') {
      curRun += 1;
      if (curRun > maxRun) maxRun = curRun;
    } else {
      curRun = 0;
    }
  }
  return '`'.repeat(maxRun + 1);
}

function formatCodeCell(text: string, inTable = true): string {
  const sanitized = sanitizeTerminalLabel(text);
  const clean = inTable ? sanitized.replaceAll('|', '\\|') : sanitized;
  if (clean.length === 0) {
    return '-';
  }
  const fence = computeCodeFence(clean);
  const needsPad = clean.startsWith('`') || clean.endsWith('`');
  return needsPad ? `${fence} ${clean} ${fence}` : `${fence}${clean}${fence}`;
}

function formatTelemetrySummaryLine(telemetry: SessionTelemetry | null | undefined): string {
  const fields = formatTelemetryFields(telemetry);
  const parts: string[] = [];
  if (fields.ctx !== null) parts.push(`Ctx ${fields.ctx.text}`);
  if (fields.tpsText !== null) parts.push(fields.tpsText);
  if (fields.ttftText !== null) parts.push(`TTFT ${fields.ttftText}`);
  if (fields.cacheText !== null) parts.push(`Cache ${fields.cacheText}`);
  if (fields.timeText !== null) parts.push(fields.timeText);
  return parts.join(' · ');
}

function formatContextMarkdownLines(
  telemetry: SessionTelemetry | null | undefined,
  nominalWindowSize?: number | null,
): string[] {
  const model = buildContextSectionModel(telemetry, nominalWindowSize);
  if (model === null) return [];

  const out: string[] = ['', '## Context'];
  if (model.metaNotes.length > 0) {
    out.push('', `- ${model.metaNotes.join(' · ')}`);
  }
  if (model.rows.length > 0) {
    out.push('', '| Category | Tokens | Share |', '| --- | ---: | ---: |');
    for (const row of model.rows) {
      out.push(`| ${row.label} | ${row.tokenText} | ${row.shareText} |`);
    }
  }
  if (model.roles.length >= 2) {
    out.push('', '### Models & Roles', '', '| Model | Role | Gens | Context |', '| --- | --- | ---: | ---: |');
    for (const entry of model.roles) {
      out.push(`| ${escapeMarkdownCell(entry.model)} | ${entry.role ?? '-'} | ${entry.genCount} | ${entry.ctxText} |`);
    }
  }
  return out;
}

function formatCostSummaryLine(
  data: StatusLineData | undefined,
  costCurrency?: HudCostCurrency,
  usdToCnyRate?: number,
): string {
  const resolved = resolveSessionCost(data?.cost);
  if (resolved === null) return '';
  const opts = { currency: costCurrency, usdToCnyRate };
  const totalStr = formatSessionCostText(resolved, opts);
  const subStr = formatSubagentCostText(resolved, opts);
  return subStr !== null ? `${totalStr} (subagents: ${subStr})` : totalStr;
}

function resolveOptionalPhase(
  data: StatusLineData | undefined,
  telemetry: SessionTelemetry | null | undefined,
  explicitPhase?: TurnPhase,
): TurnPhase | null {
  if (explicitPhase !== undefined) return explicitPhase;
  const hasHost = data?.tool_confirmation_pending === true || normalizeHostAgentState(data?.agent_state) !== null;
  if (!hasHost && telemetry?.tailStepPhase == null && telemetry?.lastErrorCode == null) {
    return null;
  }
  return resolveTurnPhase({
    hasLiveHostState: hasHost,
    toolConfirmationPending: data?.tool_confirmation_pending,
    agentState: data?.agent_state,
    tailStepPhase: telemetry?.tailStepPhase,
    lastErrorCode: telemetry?.lastErrorCode,
  });
}

function formatTargetCell(
  rawTarget: string,
  linkable: boolean,
  resolvedFileLinks: ReadonlyMap<string, string> | undefined,
): string {
  const codeCell = formatCodeCell(rawTarget);
  if (!linkable || rawTarget.length === 0 || codeCell === '-') return codeCell;
  const uri = resolvedFileLinks?.get(rawTarget) ?? null;
  return uri !== null ? `[${codeCell}](${uri})` : codeCell;
}

export function renderSnapshotMarkdownWithDigest(options: SnapshotMarkdownRenderOptions): RenderedSnapshotMarkdown {
  const { convId, data, activity, agentsSummary, telemetry } = options;
  const nowMs = options.nowMs ?? Date.now();
  const shortId = convId.slice(0, 8);
  const title = nonEmptyStr(data.conversation_title);
  const workspace =
    nonEmptyStr(data.workspace?.current_dir) ?? nonEmptyStr(data.workspace?.project_dir) ?? nonEmptyStr(data.cwd);
  const model = nonEmptyStr(data.model?.display_name) ?? nonEmptyStr(data.model?.id);

  const skills = activity?.skills ?? [];
  const aggregatedTools = aggregateActivityTools(activity?.tools ?? [], {
    knownMcpServers: activity?.mcps ?? [],
    hideSkillReads: skills.length > 0,
  });
  const runningTools = selectNewestFirst(aggregatedTools.runningTools);
  const completedTools = aggregatedTools.completedTools;
  const mcps = aggregatedTools.mcps;
  const mergedAgents = mergeActivityAgents(agentsSummary, activity?.agents ?? [], nowMs);

  const lines: string[] = [];
  const digestLines: string[] = [];
  const pushBoth = (line: string): void => {
    lines.push(line);
    digestLines.push(line);
  };

  pushBoth(`# Activity Snapshot — ${escapeMarkdownCell(shortId)}`);
  pushBoth('');
  pushBoth(`- **Session**: ${formatCodeCell(convId, false)}`);
  if (title !== undefined) pushBoth(`- **Title**: ${escapeMarkdownCell(title)}`);
  if (workspace !== undefined) pushBoth(`- **Workspace**: ${formatCodeCell(workspace, false)}`);
  if (model !== undefined) pushBoth(`- **Model**: ${formatCodeCell(model, false)}`);
  const phase = resolveOptionalPhase(data, telemetry, options.turnPhase);
  if (phase !== null) pushBoth(`- **Phase**: ${formatCodeCell(phase, false)}`);

  // Updated timestamp is excluded from contentDigest so wall-clock ticks alone do not rewrite .md on disk.
  lines.push(`- **Updated**: ${new Date(nowMs).toISOString()}`);

  const telLine = formatTelemetrySummaryLine(telemetry);
  if (telLine.length > 0) pushBoth(`- **Telemetry**: ${telLine}`);
  const diagLine = formatTelemetryDiagnostics(telemetry);
  if (diagLine.length > 0) pushBoth(`- **Diagnostics**: ${escapeMarkdownCell(diagLine)}`);
  const outLine = formatTelemetryFields(telemetry).outputText ?? '';
  if (outLine.length > 0) pushBoth(`- **Output**: ${outLine}`);
  const costLine = formatCostSummaryLine(data, options.costCurrency, options.usdToCnyRate);
  if (costLine.length > 0) pushBoth(`- **Cost**: ${costLine}`);
  const quotaLine = formatSnapshotQuotaLine(resolveSnapshotQuotaBuckets(data.quota, nowMs / 1000), {
    color: false,
    escapeText: escapeMarkdownCell,
  });
  if (quotaLine.length > 0) pushBoth(`- **Quota**: ${quotaLine}`);

  const nominalWinSize =
    isFiniteNum(data.context_window?.context_window_size) && data.context_window.context_window_size > 0
      ? Math.trunc(data.context_window.context_window_size)
      : null;
  for (const ctxLine of formatContextMarkdownLines(telemetry, nominalWinSize)) {
    pushBoth(ctxLine);
  }

  pushBoth('');
  pushBoth(
    `## ${formatToolsSectionHeading(runningTools.length, completedTools.length, aggregatedTools.totalToolCalls)}`,
  );
  if (runningTools.length === 0 && completedTools.length === 0) {
    pushBoth('');
    pushBoth('_No tool activity recorded._');
  } else {
    if (runningTools.length > 0) {
      pushBoth('');
      pushBoth(`### Running (${runningTools.length})`);
      pushBoth('');
      pushBoth('| # | Status | Tool | Target |');
      pushBoth('| --- | --- | --- | --- |');
      for (let i = 0; i < runningTools.length; i += 1) {
        const rt = runningTools[i];
        if (!rt) continue;
        const disp = rt.disp.length > 0 ? rt.disp : rt.name;
        const rawTarget = nonEmptyStr(rt.fullTarget) ?? rt.target;
        const status = i >= HUD_RUNNING_TOOL_CAP ? 'running (+more)' : 'running';
        const targetCell = formatTargetCell(rawTarget, rt.targetLinkable !== false, options.resolvedFileLinks);
        pushBoth(`| ${i + 1} | ${status} | ${formatCodeCell(disp)} | ${targetCell} |`);
      }
    }
    if (completedTools.length > 0) {
      pushBoth('');
      pushBoth(`### Completed (${completedTools.length} types)`);
      pushBoth('');
      pushBoth('| # | Tool | Calls | Latest Target |');
      pushBoth('| --- | --- | ---: | --- |');
      for (let i = 0; i < completedTools.length; i += 1) {
        const ct = completedTools[i];
        if (!ct) continue;
        const idxLabel = i >= HUD_COMPLETED_TOOL_CAP ? `${i + 1} (+more)` : String(i + 1);
        const latest = ct.fullTarget.length > 0 ? ct.fullTarget : ct.latestTarget;
        const isUnlinked = ct.unlinkedTargets?.includes(latest) === true;
        const targetCell = formatTargetCell(latest, !isUnlinked, options.resolvedFileLinks);
        pushBoth(`| ${idxLabel} | ${formatCodeCell(ct.disp)} | ×${ct.count} | ${targetCell} |`);
      }
    }
  }

  pushBoth('');
  pushBoth(`## Skills (${skills.length} chronological)`);
  if (skills.length === 0) {
    pushBoth('');
    pushBoth('_No skills invoked._');
  } else {
    pushBoth('');
    for (let i = 0; i < skills.length; i += 1) {
      const sk = skills[i];
      if (sk !== undefined) pushBoth(`${i + 1}. ${formatCodeCell(sk, false)}`);
    }
  }

  pushBoth('');
  pushBoth(`## MCP Servers (${mcps.length})`);
  if (mcps.length === 0) {
    pushBoth('');
    pushBoth('_No MCP tool calls recorded._');
  } else {
    pushBoth('');
    pushBoth('| Server | Calls | Subtools |');
    pushBoth('| --- | ---: | --- |');
    for (const srv of mcps) {
      const subSummary =
        srv.subtools.length > 0 ? srv.subtools.map((st) => `${formatCodeCell(st.name)} ×${st.count}`).join(', ') : '-';
      pushBoth(`| ${formatCodeCell(srv.server)} | ${srv.totalCalls} | ${subSummary} |`);
    }
  }

  const agentRows = options.snapshotAgents ?? mergedAgents.entries;
  const { heading: agentHeading } = formatAgentsSectionHeading(mergedAgents.kind, agentRows);
  pushBoth('');
  pushBoth(`## ${agentHeading}`);
  const rollupText = formatSubagentRollupParts(options.subagentRollup).join(' · ');
  if (rollupText.length > 0) {
    pushBoth('');
    pushBoth(`- **Subagent Rollup**: ${rollupText}`);
  }
  if (agentRows.length === 0) {
    pushBoth('');
    pushBoth('_No subagents or swarm workers recorded._');
  } else {
    const hasAgentTelemetry = agentRows.some((a) => a.telemetry != null);
    pushBoth('');
    if (hasAgentTelemetry) {
      pushBoth('| Name | Type | Model | State | Updated | Telemetry |');
      pushBoth('| --- | --- | --- | --- | --- | --- |');
      for (const agent of agentRows) {
        const telParts = formatSubagentTelemetryParts(agent.telemetry);
        const telCell = telParts.length > 0 ? telParts.join(' · ') : '-';
        const prefix = `| ${formatCodeCell(agent.name)} | ${escapeMarkdownCell(agent.type)} | ${escapeMarkdownCell(agent.model)} | ${escapeMarkdownCell(agent.state)} |`;
        lines.push(`${prefix} ${agent.ageLabel} | ${telCell} |`);
        // Host contract §4: omit relative ageLabel from contentDigest so wall-clock ticks alone do not rewrite .md.
        digestLines.push(`${prefix} <age> | ${telCell} |`);
      }
    } else {
      pushBoth('| Name | Type | Model | State | Updated |');
      pushBoth('| --- | --- | --- | --- | --- |');
      for (const agent of agentRows) {
        const prefix = `| ${formatCodeCell(agent.name)} | ${escapeMarkdownCell(agent.type)} | ${escapeMarkdownCell(agent.model)} | ${escapeMarkdownCell(agent.state)} |`;
        lines.push(`${prefix} ${agent.ageLabel} |`);
        // Host contract §4: omit relative ageLabel from contentDigest so wall-clock ticks alone do not rewrite .md.
        digestLines.push(`${prefix} <age> |`);
      }
    }
  }

  pushBoth('');
  pushBoth('---');
  pushBoth('');
  pushBoth(
    '_Inspect live in terminal: `!agy-hud` (in-prompt) · `agy-hud -p` (interactive popup) · `agy-hud snapshot --keybindings` (terminal shortcuts)._',
  );

  const contentDigest = createHash('sha256').update(digestLines.join('\n')).digest('hex').slice(0, 16);
  return { markdown: `${lines.join('\n')}\n`, contentDigest };
}

export function renderSnapshotMarkdown(options: SnapshotMarkdownRenderOptions): string {
  return renderSnapshotMarkdownWithDigest(options).markdown;
}
