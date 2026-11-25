import { aggregateActivityTools, mergeActivityAgents } from '../collectors/activity-aggregate.ts';
import { formatSurfaceBadge } from '../collectors/snapshot-envelope.ts';
import { isFiniteNum, nonEmptyStr, selectNewestFirst } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { SessionSurface } from '../snapshot-types.ts';
import type { AgentsSummary, SessionTelemetry, StatusLineData, TranscriptActivity } from '../types.ts';
import { fmtTokens } from './ansi.ts';

const HUD_RUNNING_TOOL_CAP = 2;
const HUD_COMPLETED_TOOL_CAP = 8;

export interface SnapshotMarkdownRenderOptions {
  convId: string;
  data: StatusLineData;
  activity: TranscriptActivity | null;
  agentsSummary: AgentsSummary | null;
  telemetry?: SessionTelemetry | null;
  surface?: SessionSurface;
  nowMs?: number;
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

export function formatMarkdownTelemetry(telemetry: SessionTelemetry | null | undefined): string {
  if (!telemetry) {
    return '';
  }
  const parts: string[] = [];
  if (isFiniteNum(telemetry.ctxUsed) && isFiniteNum(telemetry.ctxMax) && telemetry.ctxMax > 0) {
    const pct = Math.min(100, Math.round((telemetry.ctxUsed / telemetry.ctxMax) * 100));
    parts.push(`Ctx ${fmtTokens(telemetry.ctxUsed)}/${fmtTokens(telemetry.ctxMax)} (${pct}%)`);
  }
  if (isFiniteNum(telemetry.tps) && telemetry.tps > 0) {
    parts.push(telemetry.tps >= 100 ? `${telemetry.tps.toFixed(0)} t/s` : `${telemetry.tps.toFixed(1)} t/s`);
  }
  if (isFiniteNum(telemetry.ttft) && telemetry.ttft > 0) {
    parts.push(`TTFT ${telemetry.ttft < 10 ? `${telemetry.ttft.toFixed(2)}s` : `${telemetry.ttft.toFixed(1)}s`}`);
  }
  if (isFiniteNum(telemetry.cachePct) && (telemetry.genCount > 0 || telemetry.cachePct > 0)) {
    parts.push(`Cache ${Math.round(Math.max(0, Math.min(100, telemetry.cachePct)))}%`);
  }
  return parts.join(' · ');
}

export function renderSnapshotMarkdown(options: SnapshotMarkdownRenderOptions): string {
  const { convId, data, activity, agentsSummary, telemetry } = options;
  const nowMs = options.nowMs ?? Date.now();
  const badge = formatSurfaceBadge(options.surface ?? 'cli');
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

  const lines: string[] = [`# [${badge}] Activity Snapshot — ${escapeMarkdownCell(shortId)}`, ''];
  lines.push(`- **Session**: ${formatCodeCell(convId, false)}`);
  if (title !== undefined) {
    lines.push(`- **Title**: ${escapeMarkdownCell(title)}`);
  }
  if (workspace !== undefined) {
    lines.push(`- **Workspace**: ${formatCodeCell(workspace, false)}`);
  }
  if (model !== undefined) {
    lines.push(`- **Model**: ${formatCodeCell(model, false)}`);
  }
  lines.push(`- **Updated**: ${new Date(nowMs).toISOString()}`);
  const telLine = formatMarkdownTelemetry(telemetry);
  if (telLine.length > 0) {
    lines.push(`- **Telemetry**: ${telLine}`);
  }

  lines.push(
    '',
    `## Tools (${runningTools.length} running · ${completedTools.length} types · ${aggregatedTools.totalToolCalls} calls)`,
  );
  if (runningTools.length === 0 && completedTools.length === 0) {
    lines.push('', '_No tool activity recorded._');
  } else {
    if (runningTools.length > 0) {
      lines.push(
        '',
        `### Running (${runningTools.length})`,
        '',
        '| # | Status | Tool | Target |',
        '| --- | --- | --- | --- |',
      );
      for (let i = 0; i < runningTools.length; i += 1) {
        const rt = runningTools[i];
        if (!rt) continue;
        const disp = rt.disp.length > 0 ? rt.disp : rt.name;
        const rawTarget = nonEmptyStr(rt.fullTarget) ?? rt.target;
        const status = i >= HUD_RUNNING_TOOL_CAP ? 'running (+more)' : 'running';
        lines.push(`| ${i + 1} | ${status} | ${formatCodeCell(disp)} | ${formatCodeCell(rawTarget)} |`);
      }
    }
    if (completedTools.length > 0) {
      lines.push(
        '',
        `### Completed (${completedTools.length} types)`,
        '',
        '| # | Tool | Calls | Latest Target |',
        '| --- | --- | ---: | --- |',
      );
      for (let i = 0; i < completedTools.length; i += 1) {
        const ct = completedTools[i];
        if (!ct) continue;
        const idxLabel = i >= HUD_COMPLETED_TOOL_CAP ? `${i + 1} (+more)` : String(i + 1);
        const latest = ct.fullTarget.length > 0 ? ct.fullTarget : ct.latestTarget;
        lines.push(`| ${idxLabel} | ${formatCodeCell(ct.disp)} | ×${ct.count} | ${formatCodeCell(latest)} |`);
      }
    }
  }

  lines.push('', `## Skills (${skills.length} chronological)`);
  if (skills.length === 0) {
    lines.push('', '_No skills invoked._');
  } else {
    lines.push('');
    for (let i = 0; i < skills.length; i += 1) {
      const sk = skills[i];
      if (sk !== undefined) {
        lines.push(`${i + 1}. ${formatCodeCell(sk, false)}`);
      }
    }
  }

  lines.push('', `## MCP Servers (${mcps.length})`);
  if (mcps.length === 0) {
    lines.push('', '_No MCP tool calls recorded._');
  } else {
    lines.push('', '| Server | Calls | Subtools |', '| --- | ---: | --- |');
    for (const srv of mcps) {
      const subSummary =
        srv.subtools.length > 0 ? srv.subtools.map((st) => `${formatCodeCell(st.name)} ×${st.count}`).join(', ') : '-';
      lines.push(`| ${formatCodeCell(srv.server)} | ${srv.totalCalls} | ${subSummary} |`);
    }
  }

  const aliveCount = mergedAgents.entries.filter((a) => a.state !== 'done').length;
  const doneCount = mergedAgents.entries.length - aliveCount;
  const agentHeading =
    mergedAgents.kind === 'swarm'
      ? `Swarm (${aliveCount} alive · ${doneCount} stopped)`
      : `Agents (${aliveCount} alive · ${doneCount} done)`;
  lines.push('', `## ${agentHeading}`);
  if (mergedAgents.entries.length === 0) {
    lines.push('', '_No subagents or swarm workers recorded._');
  } else {
    lines.push('', '| Name | Type | Model | State | Updated |', '| --- | --- | --- | --- | --- |');
    for (const agent of mergedAgents.entries) {
      lines.push(
        `| ${formatCodeCell(agent.name)} | ${escapeMarkdownCell(agent.type)} | ${escapeMarkdownCell(agent.model)} | ${agent.state} | ${agent.ageLabel} |`,
      );
    }
  }

  lines.push(
    '',
    '---',
    '',
    '_Inspect live in terminal: `!agy-hud` (in-prompt) · `agy-hud -p` (interactive popup) · `agy-hud snapshot --keybindings` (terminal shortcuts)._',
  );
  return `${lines.join('\n')}\n`;
}
