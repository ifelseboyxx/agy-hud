import path from 'node:path';

import { loadTodos, loadTranscriptActivity } from '../collectors/activity.ts';
import {
  collectAgentsSummary,
  formatAgentsBadge,
  formatAgentsSection,
  formatRuntimeBadges,
} from '../collectors/agents.ts';
import {
  detectAgyFlags,
  detectGitBranch,
  getSessionElapsedSeconds,
  readCliSettings,
  readHudConfig,
} from '../collectors/settings.ts';
import {
  formatContextCapacity,
  loadSessionTelemetry,
  parseModelAndEffort,
  resolveQuotaReset,
} from '../collectors/telemetry.ts';
import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import type {
  AgentsSummary,
  CliSettings,
  HudConfig,
  QuotaBucketItem,
  SessionTelemetry,
  StatusLineData,
  TodoSummary,
  TranscriptActivity,
} from '../types.ts';
import { formatNamesLine, formatTodosLine, formatToolsLine } from './activity-lines.ts';
import {
  BOLD,
  BRIGHT_BLUE,
  BRIGHT_CYAN,
  BRIGHT_MAGENTA,
  BRIGHT_RED,
  BRIGHT_WHITE,
  BRIGHT_YELLOW,
  colorForRemainingPct,
  colorForUsedPct,
  CYAN,
  DEFAULT_TERM_WIDTH,
  fitPerfCapsule,
  fmtDuration,
  GRAY,
  GREEN,
  renderBar,
  RESET,
  visibleLen,
  YELLOW,
} from './ansi.ts';

export { formatNamesLine, formatTodosLine, formatToolsLine } from './activity-lines.ts';

const CTX_CAPACITY_MIN_WIDTH = 95;
const SECONDARY_QUOTA_MIN_WIDTH = 120;

const KNOWN_QUOTA_KEYS: ReadonlySet<string> = new Set([
  'gemini-5h',
  'gemini-weekly',
  'gemini-argon-wtu-weekly',
  '3p-5h',
  '3p-weekly',
]);

export interface RenderHudOptions {
  cliHome?: string;
  cliSettings?: CliSettings;
  hudConfig?: Partial<HudConfig>;
  telemetry?: SessionTelemetry;
  activity?: TranscriptActivity | null;
  agentsSummary?: AgentsSummary;
  todos?: TodoSummary | null;
  nowSec?: number;
  bypass?: boolean;
  cliMode?: string;
  branch?: string;
  dirty?: boolean;
  elapsedSeconds?: number | null;
}

export function resolveEffectiveHudConfig(config: HudConfig): HudConfig {
  if (config.preset === 'minimal') {
    return {
      ...config,
      showModeLine: false,
      showSwarmChips: false,
      showToolsLine: false,
      showSkillsMcpLine: false,
      showTodosLine: false,
    };
  }
  if (config.preset === 'compact') {
    return {
      ...config,
      showToolsLine: false,
      showSkillsMcpLine: false,
      showTodosLine: false,
    };
  }
  return config;
}

export function formatQuotaItem(
  label: string,
  entry: QuotaBucketItem | undefined,
  muted: boolean = false,
  nowSec: number = Date.now() / 1000,
): string | null {
  if (!entry || entry.disabled === true) {
    return null;
  }
  const { remainingSeconds, windowExpired } = resolveQuotaReset(entry, nowSec);
  const frac = entry.remaining_fraction;
  const amt = entry.remaining_amount;

  let pctText: string;
  let valColor: string;
  let showReset: boolean;

  if (isFiniteNum(frac)) {
    const pct = windowExpired ? 100 : Math.max(0, Math.min(100, frac * 100));
    const isFull = pct >= 99.995;
    pctText = isFull ? '100%' : `${pct.toFixed(2)}%`;
    valColor = muted ? GRAY : colorForRemainingPct(pct);
    showReset = !isFull && isFiniteNum(remainingSeconds) && remainingSeconds > 0;
  } else if (amt !== undefined && amt !== null) {
    pctText = String(amt);
    valColor = muted ? GRAY : BRIGHT_WHITE;
    showReset = isFiniteNum(remainingSeconds) && remainingSeconds > 0;
  } else {
    return null;
  }

  const rst = showReset ? fmtDuration(remainingSeconds, true, false) : '';
  const labelColor = muted ? GRAY : BRIGHT_WHITE;
  const rstPart = rst.length > 0 ? ` ${GRAY}(${rst})${RESET}` : '';
  return `${labelColor}${label}: ${valColor}${pctText}${RESET}${rstPart}`;
}

export function buildModeLine(
  cliHome: string,
  data: StatusLineData,
  cliSettings?: CliSettings,
  options?: Pick<RenderHudOptions, 'bypass' | 'cliMode'>,
): string {
  const procFlags =
    options?.bypass !== undefined && options.cliMode !== undefined
      ? { bypass: options.bypass, cliMode: options.cliMode }
      : detectAgyFlags(cliHome);

  let bypass = options?.bypass ?? procFlags.bypass;
  const cliMode = options?.cliMode ?? procFlags.cliMode;

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
    const saved = cliSettings ?? readCliSettings(cliHome);
    const savedMode = nonEmptyStr(saved.agentMode)?.toLowerCase() ?? '';
    mode = nonEmptyStr(cliMode)?.toLowerCase() ?? (savedMode.length > 0 ? savedMode : 'default');
  }

  const vimMode = nonEmptyStr(data.vim?.mode)?.toUpperCase() ?? '';
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
  return ` ${GRAY}▸ ${mode} mode${RESET}${vimTag} ${hint}`;
}

export function buildLine1(
  cliHome: string,
  data: StatusLineData,
  config: HudConfig,
  telemetry: SessionTelemetry | null,
  cliSettings: CliSettings,
  agentsSummary: AgentsSummary | null,
  hasTodosLine: boolean,
  options?: Pick<RenderHudOptions, 'branch' | 'dirty' | 'elapsedSeconds'>,
): string {
  const sep = ` ${GRAY}│${RESET} `;
  const parts: string[] = [];

  const { name: modelName, effort } = parseModelAndEffort(data, cliSettings);
  const effortText = effort.length > 0 ? ` ${GRAY}◑ ${YELLOW}${effort}${RESET}` : '';
  parts.push(`${GRAY}[${BRIGHT_CYAN}${BOLD}${modelName}${RESET}${effortText}${GRAY}]${RESET}`);

  const curDir =
    nonEmptyStr(data.workspace?.current_dir) ?? nonEmptyStr(data.workspace?.project_dir) ?? nonEmptyStr(data.cwd) ?? '';
  const dirName = curDir.length > 0 ? path.basename(curDir.replace(/\/+$/, '')) : '';

  const gitInfo =
    options?.branch !== undefined
      ? { branch: options.branch, dirty: Boolean(options.dirty ?? data.vcs?.dirty) }
      : detectGitBranch(curDir, data.vcs);

  const locItems: string[] = [];
  if (dirName.length > 0) {
    locItems.push(`${BRIGHT_BLUE}${BOLD}${dirName}${RESET}`);
  }
  if (gitInfo.branch.length > 0) {
    const dirtyMark = gitInfo.dirty ? `${BRIGHT_YELLOW}*${RESET}` : '';
    locItems.push(`${CYAN}git:(${GREEN}${gitInfo.branch}${dirtyMark}${CYAN})${RESET}`);
  }
  if (locItems.length > 0) {
    parts.push(locItems.join(' '));
  }

  const convId = nonEmptyStr(data.conversation_id) ?? nonEmptyStr(data.session_id);
  const elapsed =
    options?.elapsedSeconds !== undefined ? options.elapsedSeconds : getSessionElapsedSeconds(cliHome, convId, data);
  if (elapsed !== null) {
    parts.push(`${GRAY}◷ ${BRIGHT_WHITE}${fmtDuration(elapsed, true)}${RESET}`);
  }

  const agentsBadge = formatAgentsBadge(agentsSummary);
  if (agentsBadge.length > 0) {
    parts.push(agentsBadge);
  }
  parts.push(...formatRuntimeBadges(data, { hasTodosLine }));

  if (config.showCost) {
    const rawUsd = data.cost?.total_usd;
    const usd = isFiniteNum(rawUsd) ? rawUsd : data.cost?.total_cost_usd;
    if (isFiniteNum(usd)) {
      const costStr = usd >= 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
      parts.push(`${GRAY}Cost ${BRIGHT_YELLOW}${costStr}${RESET}`);
    }
  }

  const baseLine = ` ${parts.join(sep)}`;
  const termWidth = isFiniteNum(data.terminal_width) ? data.terminal_width : DEFAULT_TERM_WIDTH;
  return config.showPerfCapsule ? fitPerfCapsule(baseLine, telemetry, termWidth) : baseLine;
}

export function buildLine2(
  data: StatusLineData,
  config: HudConfig,
  telemetry: SessionTelemetry | null,
  nowSec: number = Date.now() / 1000,
): string {
  const sep = ` ${GRAY}│${RESET} `;
  const subSep = ` ${GRAY}|${RESET} `;
  const items: string[] = [];
  const termWidth = isFiniteNum(data.terminal_width) ? data.terminal_width : DEFAULT_TERM_WIDTH;

  const ctxObj = data.context_window;
  const winSize = ctxObj?.context_window_size;
  const maxTok = isFiniteNum(winSize) && winSize > 0 ? winSize : (telemetry?.ctxMax ?? null);
  let ctxPct = ctxObj?.used_percentage;
  if (telemetry?.compacted === true && isFiniteNum(telemetry.ctxUsed) && isFiniteNum(maxTok) && maxTok > 0) {
    ctxPct = Math.min(100, Math.max(0, (telemetry.ctxUsed / maxTok) * 100));
  }
  if (isFiniteNum(ctxPct)) {
    const pctStr = ctxPct > 0 && ctxPct < 1 ? `${ctxPct.toFixed(1)}%` : `${ctxPct.toFixed(0)}%`;
    const pctColor = colorForUsedPct(ctxPct);
    const capStr = termWidth >= CTX_CAPACITY_MIN_WIDTH ? formatContextCapacity(ctxObj, telemetry) : '';
    const capPart = capStr.length > 0 ? ` ${capStr}` : '';
    items.push(`${GRAY}Context ${renderBar(ctxPct)} ${pctColor}${BOLD}${pctStr}${RESET}${capPart}`);
  }

  if (config.showQuota && data.quota) {
    const quota = data.quota;
    const modelId = (nonEmptyStr(data.model?.id) ?? nonEmptyStr(data.model?.display_name) ?? '').toLowerCase();
    const is3p = ['claude', 'opus', 'sonnet', 'haiku', 'gpt'].some((k) => modelId.includes(k));
    const isArgon = modelId.includes('argon');

    const gItems = [
      formatQuotaItem('5h', quota['gemini-5h'], is3p, nowSec),
      formatQuotaItem(isArgon ? 'G-7d' : '7d', quota['gemini-weekly'], is3p, nowSec),
      formatQuotaItem(isArgon ? '7d' : 'Argon-7d', quota['gemini-argon-wtu-weekly'], is3p, nowSec),
    ].filter((x): x is string => x !== null);

    const p3Items = [
      formatQuotaItem('5h', quota['3p-5h'], !is3p, nowSec),
      formatQuotaItem('7d', quota['3p-weekly'], !is3p, nowSec),
    ].filter((x): x is string => x !== null);

    const primary =
      is3p && p3Items.length > 0
        ? `${BRIGHT_MAGENTA}3P${RESET} ${p3Items.join(subSep)}`
        : !is3p && gItems.length > 0
          ? `${BRIGHT_CYAN}G${RESET} ${gItems.join(subSep)}`
          : '';

    const secondary =
      is3p && gItems.length > 0
        ? `${GRAY}G${RESET} ${gItems.join(subSep)}`
        : !is3p && p3Items.length > 0
          ? `${GRAY}3P${RESET} ${p3Items.join(subSep)}`
          : '';

    if (primary.length > 0) {
      items.push(primary);
    }
    if (secondary.length > 0 && termWidth >= SECONDARY_QUOTA_MIN_WIDTH) {
      const candidate = `  ${[...items, secondary].join(sep)}`;
      if (visibleLen(candidate) <= termWidth - 1) {
        items.push(secondary);
      }
    }

    const extra = Object.entries(quota)
      .filter(([k]) => !KNOWN_QUOTA_KEYS.has(k))
      .map(([k, v]) => formatQuotaItem(k, v, false, nowSec))
      .filter((x): x is string => x !== null);
    if (extra.length > 0) {
      items.push(extra.join(subSep));
    }
  }

  return items.length > 0 ? `  ${items.join(sep)}` : '';
}

export function resolveEffectiveExceeds200k(
  data: StatusLineData,
  telemetry: SessionTelemetry | null | undefined,
): boolean {
  if (telemetry?.compacted === true && isFiniteNum(telemetry.ctxUsed) && telemetry.ctxUsed <= 200_000) {
    return false;
  }
  return data.exceeds_200k_tokens === true;
}

export function renderHudLines(cliHome: string, data: StatusLineData, options?: RenderHudOptions): string[] {
  const baseConfig = readHudConfig(cliHome);
  const mergedConfig: HudConfig = options?.hudConfig ? { ...baseConfig, ...options.hudConfig } : baseConfig;
  const config = resolveEffectiveHudConfig(mergedConfig);

  const cliSettings = options?.cliSettings ?? readCliSettings(cliHome);
  const telemetry = options?.telemetry ?? loadSessionTelemetry(cliHome, data);
  const effectiveData: StatusLineData =
    data.exceeds_200k_tokens === true && !resolveEffectiveExceeds200k(data, telemetry)
      ? { ...data, exceeds_200k_tokens: false }
      : data;
  const activity = options?.activity !== undefined ? options.activity : loadTranscriptActivity(cliHome, effectiveData);
  const agentsSummary = options?.agentsSummary ?? collectAgentsSummary(cliHome, effectiveData, activity?.agents);

  const todos = options?.todos !== undefined ? options.todos : loadTodos(cliHome, effectiveData);
  const todosLine = config.showTodosLine ? formatTodosLine(todos) : '';
  const hasTodosLine = todosLine.length > 0;
  const nowSec = options?.nowSec ?? Date.now() / 1000;

  const lines: string[] = [];
  if (config.showModeLine) {
    const modeLine = buildModeLine(cliHome, effectiveData, cliSettings, options);
    if (modeLine.length > 0) {
      lines.push(modeLine);
    }
  }

  const line1 = buildLine1(
    cliHome,
    effectiveData,
    config,
    telemetry,
    cliSettings,
    agentsSummary,
    hasTodosLine,
    options,
  );
  if (line1.length > 0) {
    lines.push(line1);
  }

  const line2 = buildLine2(effectiveData, config, telemetry, nowSec);
  if (line2.length > 0) {
    lines.push(line2);
  }

  const skills = activity?.skills ?? [];
  const mcps = activity?.mcps ?? [];
  const tools = activity?.tools ?? [];

  if (config.showToolsLine) {
    const toolsLine = formatToolsLine(tools, skills.length > 0);
    if (toolsLine.length > 0) {
      lines.push(toolsLine);
    }
  }
  if (config.showSkillsMcpLine) {
    const skillsLine = formatNamesLine('Skills', skills);
    if (skillsLine.length > 0) {
      lines.push(skillsLine);
    }
    const mcpsLine = formatNamesLine('MCPs', mcps);
    if (mcpsLine.length > 0) {
      lines.push(mcpsLine);
    }
  }
  if (config.showSwarmChips) {
    const agentsLine = formatAgentsSection(agentsSummary, config.maxAgentChips, nowSec);
    if (agentsLine.length > 0) {
      lines.push(agentsLine);
    }
  }
  if (hasTodosLine) {
    lines.push(todosLine);
  }

  return lines;
}
