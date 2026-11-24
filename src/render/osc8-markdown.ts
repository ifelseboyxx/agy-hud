import { aggregateCompletedTools } from '../collectors/activity-parse.ts';
import { cleanAgentLabel } from '../collectors/agents.ts';
import { formatRelativeAge, formatSurfaceBadge } from '../collectors/snapshot-envelope.ts';
import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import type { SessionSurface } from '../snapshot-types.ts';
import type {
  ActivityAgentEntry,
  AgentEntry,
  AgentsKind,
  AgentsSummary,
  SessionTelemetry,
  StatusLineData,
  TranscriptActivity,
  TranscriptToolEntry,
} from '../types.ts';
import { fmtTokens, stripAnsi } from './ansi.ts';

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

interface MarkdownMcpServer {
  server: string;
  totalCalls: number;
  subtools: { name: string; count: number }[];
}

function escapeMarkdownCell(text: string): string {
  return stripAnsi(text)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replaceAll('|', '\\|');
}

function formatCodeCell(text: string): string {
  const clean = escapeMarkdownCell(text);
  if (clean.length === 0) {
    return '-';
  }
  return clean.includes('`') ? `\`\` ${clean} \`\`` : `\`${clean}\``;
}

function extractMcpServerBreakdowns(
  tools: readonly TranscriptToolEntry[],
  knownServers: readonly string[],
): MarkdownMcpServer[] {
  const order: string[] = [];
  const serverMap = new Map<string, Map<string, number>>();
  const ensureServer = (server: string): Map<string, number> => {
    let subMap = serverMap.get(server);
    if (!subMap) {
      order.push(server);
      subMap = new Map<string, number>();
      serverMap.set(server, subMap);
    }
    return subMap;
  };

  for (const srv of knownServers) {
    if (srv.length > 0) {
      ensureServer(srv);
    }
  }

  const knownSet = new Set<string>(knownServers);
  for (const tool of tools) {
    const colonIdx = tool.disp.indexOf(':');
    if (colonIdx <= 0 || colonIdx >= tool.disp.length - 1) {
      continue;
    }
    const prefix = tool.disp.slice(0, colonIdx);
    const subtool = tool.disp.slice(colonIdx + 1);
    const isMcpCall =
      knownSet.has(prefix) ||
      tool.name.startsWith('mcp') ||
      tool.name === 'call_mcp_tool' ||
      tool.name === 'list_resources' ||
      tool.name === 'read_resource';
    if (!isMcpCall) {
      continue;
    }
    const subMap = ensureServer(prefix);
    subMap.set(subtool, (subMap.get(subtool) ?? 0) + 1);
  }

  return order.map((server) => {
    const subtools = [...(serverMap.get(server)?.entries() ?? [])]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)));
    const totalCalls = subtools.reduce((sum, item) => sum + item.count, 0);
    return { server, totalCalls, subtools };
  });
}

function mergeMarkdownAgents(
  agentsSummary: AgentsSummary | null,
  transcriptAgents: readonly ActivityAgentEntry[],
): { kind: AgentsKind; entries: AgentEntry[] } {
  const kind: AgentsKind = agentsSummary?.kind ?? 'agents';
  const combined: AgentEntry[] = agentsSummary ? [...agentsSummary.entries] : [];
  if (transcriptAgents.length === 0) {
    return { kind, entries: combined };
  }
  if (!agentsSummary) {
    for (const ta of transcriptAgents) {
      combined.push({
        name: cleanAgentLabel(ta.name, '', ta.type),
        type: ta.type,
        model: ta.model,
        state: ta.running ? 'working' : 'done',
        ts: ta.ts,
      });
    }
    return { kind, entries: combined };
  }
  const existingDoneNames = new Set<string>(
    combined.filter((entry) => entry.state === 'done').map((entry) => entry.name.toLowerCase()),
  );
  for (const ta of transcriptAgents) {
    if (ta.running) {
      continue;
    }
    const label = cleanAgentLabel(ta.name, '', ta.type);
    if (existingDoneNames.has(label.toLowerCase())) {
      continue;
    }
    existingDoneNames.add(label.toLowerCase());
    combined.push({ name: label, type: ta.type, model: ta.model, state: 'done', ts: ta.ts });
  }
  return { kind, entries: combined };
}

function formatMarkdownTelemetry(telemetry: SessionTelemetry | null | undefined): string {
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
  const rawTools = activity?.tools ?? [];
  const filteredTools = rawTools.filter((t) => !(skills.length > 0 && t.isSkillRead));
  const runningTools = filteredTools.filter((t) => t.running).reverse();
  const completedTools = aggregateCompletedTools(filteredTools, false);
  const mcps = extractMcpServerBreakdowns(rawTools, activity?.mcps ?? []);
  const mergedAgents = mergeMarkdownAgents(agentsSummary, activity?.agents ?? []);

  const lines: string[] = [`# [${badge}] Activity Snapshot — ${escapeMarkdownCell(shortId)}`, ''];
  lines.push(`- **Session**: ${formatCodeCell(convId)}`);
  if (title !== undefined) {
    lines.push(`- **Title**: ${escapeMarkdownCell(title)}`);
  }
  if (workspace !== undefined) {
    lines.push(`- **Workspace**: ${formatCodeCell(workspace)}`);
  }
  if (model !== undefined) {
    lines.push(`- **Model**: ${formatCodeCell(model)}`);
  }
  lines.push(`- **Updated**: ${new Date(nowMs).toISOString()}`);
  const telLine = formatMarkdownTelemetry(telemetry);
  if (telLine.length > 0) {
    lines.push(`- **Telemetry**: ${telLine}`);
  }

  lines.push(
    '',
    `## Tools (${runningTools.length} running · ${completedTools.length} types · ${filteredTools.length} calls)`,
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
        lines.push(`${i + 1}. ${formatCodeCell(sk)}`);
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
      const age =
        agent.ts !== null ? formatRelativeAge(nowMs - agent.ts * 1000) : agent.state === 'done' ? 'recent' : 'live';
      lines.push(
        `| ${formatCodeCell(agent.name)} | ${escapeMarkdownCell(agent.type || 'subagent')} | ${escapeMarkdownCell(agent.model || 'inherit')} | ${agent.state} | ${age} |`,
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
