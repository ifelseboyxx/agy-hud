import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { parseModelAndEffort } from '../core/model-names.ts';
import { sanitizeTerminalLabel, sanitizeTerminalText } from '../core/terminal-text.ts';
import type {
  AgentsSummary,
  CliSettings,
  GitStatusInfo,
  HudConfig,
  HudLineId,
  SessionTelemetry,
  StatusLineData,
  TodoSummary,
  TranscriptActivity,
} from '../types.ts';
import { formatNamesLine, formatTodosLine, formatToolsLine } from './activity-lines.ts';
import { formatActivitySummaryLine } from './activity-summary.ts';
import { formatAgentsBadge, formatAgentsSection, formatRuntimeBadges } from './agents-render.ts';
import {
  BOLD,
  BRIGHT_CYAN,
  BRIGHT_MAGENTA,
  BRIGHT_RED,
  BRIGHT_WHITE,
  BRIGHT_YELLOW,
  buildPerfSegments,
  colorForUsedPct,
  DEFAULT_TERM_WIDTH,
  fitPerfCapsule,
  fmtDuration,
  formatContextCapacity,
  GRAY,
  renderBar,
  RESET,
  visibleLen,
} from './ansi.ts';
import { formatCostSegment } from './cost.ts';
import { type ColorLevel, detectColorLevel, formatModelSegment, isActiveShimmerState } from './effort-style.ts';
import { formatGitSegment } from './git-render.ts';
import { type ActivityLineFormatOptions, resolveLineBudget } from './pack-line.ts';
import { appendQuotaUsageItems, formatCompactPrimaryQuotaTail } from './quota.ts';

export { formatActivitySummaryLine, type ActivitySummaryInput } from './activity-summary.ts';
export { type FormatQuotaItemOptions } from './quota.ts';

const CTX_CAPACITY_MIN_WIDTH = 95;
const ACTIVITY_LINE_SET: ReadonlySet<HudLineId> = new Set(['activity', 'tools', 'skills', 'mcps', 'agents']);

export interface ModeLineOptions {
  bypass?: boolean;
  cliMode?: string;
}

export interface IdentityLineOptions {
  branch?: string;
  dirty?: boolean;
  gitInfo?: GitStatusInfo;
  elapsedSeconds?: number | null;
  nowSec?: number;
}

export interface HudModuleRenderContext {
  data: StatusLineData;
  config: HudConfig;
  enabledLines: ReadonlySet<HudLineId>;
  cliSettings: CliSettings;
  telemetry: SessionTelemetry | null;
  activity: TranscriptActivity | null;
  agentsSummary: AgentsSummary | null;
  todos: TodoSummary | null;
  hasTodosLine: boolean;
  termWidth: number;
  nowSec: number;
  colorLevel?: ColorLevel;
  modeOptions?: ModeLineOptions;
  identityOptions?: IdentityLineOptions;
  activityLineOptions?: ActivityLineFormatOptions;
  formatActivitySummaryTail?: (remainingCols: number) => string;
}

export type LineModuleRenderer = (ctx: HudModuleRenderContext) => string;

export function hasAnyActivityLine(lines: readonly HudLineId[]): boolean {
  return lines.some((id) => ACTIVITY_LINE_SET.has(id));
}

function resolveContextPct(data: StatusLineData, telemetry: SessionTelemetry | null): number | null {
  if (
    telemetry !== null &&
    telemetry.genCount > 0 &&
    isFiniteNum(telemetry.ctxUsed) &&
    isFiniteNum(telemetry.ctxMax) &&
    telemetry.ctxMax > 0
  ) {
    return Math.min(100, Math.max(0, (telemetry.ctxUsed / telemetry.ctxMax) * 100));
  }
  const ctxObj = data.context_window;
  const winSize = ctxObj?.context_window_size;
  const maxTok = isFiniteNum(winSize) && winSize > 0 ? winSize : (telemetry?.ctxMax ?? null);
  let ctxPct = ctxObj?.used_percentage;
  if (telemetry?.compacted === true && isFiniteNum(telemetry.ctxUsed) && isFiniteNum(maxTok) && maxTok > 0) {
    ctxPct = Math.min(100, Math.max(0, (telemetry.ctxUsed / maxTok) * 100));
  }
  return isFiniteNum(ctxPct) ? Math.min(100, Math.max(0, ctxPct)) : null;
}

function formatCompactContextTail(data: StatusLineData, telemetry: SessionTelemetry | null): string {
  const ctxPct = resolveContextPct(data, telemetry);
  if (ctxPct === null) {
    return '';
  }
  const pctStr = ctxPct > 0 && ctxPct < 1 ? `${ctxPct.toFixed(1)}%` : `${ctxPct.toFixed(0)}%`;
  return `${GRAY}Ctx ${colorForUsedPct(ctxPct)}${BOLD}${pctStr}${RESET}`;
}

export function buildModeLine(data: StatusLineData, cliSettings: CliSettings = {}, options?: ModeLineOptions): string {
  let bypass = options?.bypass ?? false;
  const cliMode = options?.cliMode ?? '';

  const rawPerm =
    nonEmptyStr(data.cycle_mode) ??
    nonEmptyStr(data.permission_mode) ??
    nonEmptyStr(data.mode) ??
    nonEmptyStr(data.agent_mode) ??
    nonEmptyStr(data.agentMode) ??
    '';
  const stdinPerm = rawPerm.toLowerCase();

  if (
    data.dangerously_skip_permissions === true ||
    stdinPerm === 'bypasspermissions' ||
    stdinPerm === 'dangerously-skip-permissions' ||
    stdinPerm === 'bypass'
  ) {
    bypass = true;
  }

  let mode = stdinPerm.length > 0 && stdinPerm !== 'bypasspermissions' && stdinPerm !== 'bypass' ? stdinPerm : '';
  if (mode.length === 0) {
    const savedMode = nonEmptyStr(cliSettings.agentMode)?.toLowerCase() ?? '';
    mode = nonEmptyStr(cliMode)?.toLowerCase() ?? (savedMode.length > 0 ? savedMode : 'default');
  }

  const vimMode = sanitizeTerminalLabel(nonEmptyStr(data.vim?.mode)?.toUpperCase() ?? '');
  const vimTag = vimMode.length > 0 ? ` ${BRIGHT_YELLOW}[${vimMode}]${RESET}` : '';
  const hint = `${GRAY}(shift+tab to cycle)${RESET}`;

  if (bypass) {
    const planTag = mode === 'plan' ? ` ${BRIGHT_CYAN}[plan]${RESET}` : '';
    return ` ${BRIGHT_RED}${BOLD}⏵⏵ bypass permissions on${RESET}${planTag}${vimTag} ${hint}`;
  }

  if (mode === 'accept-edits') {
    return ` ${BRIGHT_MAGENTA}⏵⏵ accept edits on${RESET}${vimTag} ${hint}`;
  }
  if (mode === 'plan') {
    return ` ${BRIGHT_CYAN}‖ plan mode on${RESET}${vimTag} ${hint}`;
  }
  if (mode === 'auto') {
    return ` ${BRIGHT_YELLOW}⏵ auto mode on${RESET}${vimTag} ${hint}`;
  }
  const cleanMode = nonEmptyStr(sanitizeTerminalText(mode)) ?? 'default';
  return ` ${GRAY}▸ ${cleanMode} mode${RESET}${vimTag} ${hint}`;
}

function buildIdentityLine(ctx: HudModuleRenderContext): string {
  const { data, config, telemetry, cliSettings, agentsSummary, hasTodosLine, identityOptions: options } = ctx;
  const sep = ` ${GRAY}│${RESET} `;
  const parts: string[] = [];
  const termWidth =
    isFiniteNum(ctx.termWidth) && ctx.termWidth > 0
      ? ctx.termWidth
      : isFiniteNum(data.terminal_width) && data.terminal_width > 0
        ? data.terminal_width
        : DEFAULT_TERM_WIDTH;
  const budget = resolveLineBudget(termWidth);

  if (config.segments.model) {
    const parsedModel = parseModelAndEffort(data, cliSettings);
    const modelName = sanitizeTerminalLabel(parsedModel.name);
    const effort = sanitizeTerminalLabel(parsedModel.effort);
    const colorLevel = ctx.colorLevel ?? detectColorLevel(process.env);
    parts.push(
      formatModelSegment(modelName, effort, {
        colorLevel,
        active: isActiveShimmerState(data.agent_state),
        nowSec: ctx.nowSec,
        peakFlags: parsedModel.peakFlags,
      }),
    );
  }

  if (config.segments.git) {
    const resolvedGitInfo: GitStatusInfo | undefined =
      options?.gitInfo ??
      (options?.branch !== undefined ? { branch: options.branch, dirty: Boolean(options.dirty) } : undefined);
    const gitPart = formatGitSegment(data, resolvedGitInfo, termWidth);
    if (gitPart.length > 0) {
      parts.push(gitPart);
    }
  }

  if (config.segments.duration) {
    const elapsed = options?.elapsedSeconds ?? null;
    if (elapsed !== null) {
      parts.push(`${GRAY}◷ ${BRIGHT_WHITE}${fmtDuration(elapsed, true)}${RESET}`);
    }
  }

  if (config.segments.badges) {
    const agentsBadge = formatAgentsBadge(agentsSummary);
    if (agentsBadge.length > 0) {
      parts.push(agentsBadge);
    }
    parts.push(...formatRuntimeBadges(data, { hasTodosLine, telemetry }));
  }

  if (config.segments.cost) {
    const costPart = formatCostSegment(data.cost, {
      currency: config.costCurrency,
      usdToCnyRate: config.usdToCnyRate,
      termWidth,
    });
    if (costPart.length > 0) {
      parts.push(costPart);
    }
  }

  if (!config.lines.includes('usage')) {
    const tryAppendTail = (token: string): void => {
      if (token.length === 0) return;
      const candidate = ` ${[...parts, token].join(sep)}`;
      if (visibleLen(candidate) <= budget) {
        parts.push(token);
      }
    };
    if (config.segments.context) {
      tryAppendTail(formatCompactContextTail(data, telemetry));
    }
    if (config.segments.quota) {
      tryAppendTail(formatCompactPrimaryQuotaTail(data, options?.nowSec ?? Date.now() / 1000));
    }
  }

  if (parts.length === 0) {
    if (!config.segments.perf) {
      return '';
    }
    const perfSegs = buildPerfSegments(telemetry);
    const dot = ` ${GRAY}·${RESET} `;
    for (let count = perfSegs.length; count >= 1; count -= 1) {
      const candidate = ` ${perfSegs.slice(0, count).join(dot)}`;
      if (visibleLen(candidate) <= budget) {
        return candidate;
      }
    }
    return '';
  }

  const baseLine = ` ${parts.join(sep)}`;
  return config.segments.perf ? fitPerfCapsule(baseLine, telemetry, termWidth) : baseLine;
}

export function buildUsageLine(
  data: StatusLineData,
  config: HudConfig,
  telemetry: SessionTelemetry | null,
  nowSec: number = Date.now() / 1000,
  explicitTermWidth?: number,
): string {
  const sep = ` ${GRAY}│${RESET} `;
  const subSep = ` ${GRAY}|${RESET} `;
  const items: string[] = [];
  const termWidth =
    isFiniteNum(explicitTermWidth) && explicitTermWidth > 0
      ? explicitTermWidth
      : isFiniteNum(data.terminal_width) && data.terminal_width > 0
        ? data.terminal_width
        : DEFAULT_TERM_WIDTH;

  if (config.segments.context) {
    const ctxPct = resolveContextPct(data, telemetry);
    if (ctxPct !== null) {
      const pctStr = ctxPct > 0 && ctxPct < 1 ? `${ctxPct.toFixed(1)}%` : `${ctxPct.toFixed(0)}%`;
      const pctColor = colorForUsedPct(ctxPct);
      const capStr = termWidth >= CTX_CAPACITY_MIN_WIDTH ? formatContextCapacity(data.context_window, telemetry) : '';
      const capPart = capStr.length > 0 ? ` ${capStr}` : '';
      items.push(`${GRAY}Context ${renderBar(ctxPct)} ${pctColor}${BOLD}${pctStr}${RESET}${capPart}`);
    }
  }

  if (config.segments.quota && data.quota) {
    appendQuotaUsageItems(items, data, nowSec, termWidth, sep, subSep);
  }

  return items.length > 0 ? `  ${items.join(sep)}` : '';
}

export const LINE_MODULE_REGISTRY: Readonly<Record<HudLineId, LineModuleRenderer>> = {
  mode: (ctx) => buildModeLine(ctx.data, ctx.cliSettings, ctx.modeOptions),
  identity: (ctx) => buildIdentityLine(ctx),
  usage: (ctx) => buildUsageLine(ctx.data, ctx.config, ctx.telemetry, ctx.nowSec, ctx.termWidth),
  activity: (ctx) =>
    formatActivitySummaryLine({
      enabledLines: ctx.enabledLines,
      activity: ctx.activity,
      agentsSummary: ctx.agentsSummary,
      termWidth: ctx.termWidth,
      nowSec: ctx.nowSec,
      formatTail: ctx.formatActivitySummaryTail,
    }),
  tools: (ctx) =>
    formatToolsLine(
      ctx.activity?.tools ?? [],
      (ctx.activity?.skills.length ?? 0) > 0,
      ctx.termWidth,
      ctx.activityLineOptions,
    ),
  skills: (ctx) =>
    formatNamesLine('Skills', ctx.activity?.skills ?? [], undefined, ctx.termWidth, ctx.activityLineOptions),
  mcps: (ctx) => formatNamesLine('MCPs', ctx.activity?.mcps ?? [], undefined, ctx.termWidth, ctx.activityLineOptions),
  agents: (ctx) =>
    formatAgentsSection(
      ctx.agentsSummary,
      ctx.config.maxAgentChips,
      ctx.nowSec,
      ctx.termWidth,
      ctx.activityLineOptions,
    ),
  todos: (ctx) => formatTodosLine(ctx.todos),
};
