import { loadTodos, loadTranscriptActivity } from '../collectors/activity.ts';
import { collectAgentsSummary } from '../collectors/agents.ts';
import { detectGitBranch, readCliSettings, readHudConfig, type GitBranchInfo } from '../collectors/settings.ts';
import { loadSessionTelemetry } from '../collectors/telemetry.ts';
import { isFiniteNum } from '../core/guards.ts';
import { buildPresetConfig, cloneHudConfig, PRESET_TEMPLATES } from '../core/hud-config.ts';
import type {
  ActivityAgentEntry,
  AgentsSummary,
  CliSettings,
  HudConfig,
  HudLineId,
  SessionTelemetry,
  StatusLineData,
  StatusLineVcs,
  TodoSummary,
  TranscriptActivity,
} from '../types.ts';
import { formatTodosLine } from './activity-lines.ts';
import { DEFAULT_TERM_WIDTH } from './ansi.ts';
import { hasAnyActivityLine, type HudModuleRenderContext, LINE_MODULE_REGISTRY } from './modules.ts';
import type { ActivityLineFormatOptions } from './pack-line.ts';

export { type ActivityLineFormatOptions, formatNamesLine, formatTodosLine, formatToolsLine } from './activity-lines.ts';
export {
  buildLine1,
  buildLine2,
  buildModeLine,
  formatActivitySummaryLine,
  formatQuotaItem,
  hasAnyActivityLine,
  LINE_MODULE_REGISTRY,
  resolveContextPct,
  type ActivitySummaryInput,
  type HudModuleRenderContext,
  type IdentityLineOptions,
  type LineModuleRenderer,
  type ModeLineOptions,
} from './modules.ts';

export interface HudCollectorOverrides {
  detectGitBranch?: (cwd: string | undefined, stdinVcs?: StatusLineVcs) => GitBranchInfo;
  loadTodos?: (cliHome: string, data: StatusLineData) => TodoSummary | null;
  loadSessionTelemetry?: (cliHome: string, data: StatusLineData) => SessionTelemetry;
  loadTranscriptActivity?: (cliHome: string, data: StatusLineData) => TranscriptActivity | null;
  collectAgentsSummary?: (
    cliHome: string,
    data: StatusLineData,
    activityAgents?: readonly ActivityAgentEntry[],
  ) => AgentsSummary;
}

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
  activityLineOptions?: ActivityLineFormatOptions;
  formatActivitySummaryTail?: (remainingCols: number) => string;
  collectors?: HudCollectorOverrides;
}

function resolveRenderHudConfig(baseConfig: HudConfig, override?: Partial<HudConfig>): HudConfig {
  if (!override) {
    return cloneHudConfig(baseConfig);
  }
  const maxAgentChips = override.maxAgentChips ?? baseConfig.maxAgentChips;
  const osc8Links = override.osc8Links ?? baseConfig.osc8Links;
  if (override.preset !== undefined && override.lines === undefined && override.segments === undefined) {
    return buildPresetConfig(override.preset, { maxAgentChips, osc8Links });
  }
  const preset = override.preset ?? baseConfig.preset;
  const seeded = override.preset !== undefined ? PRESET_TEMPLATES[override.preset] : null;
  const lines =
    override.lines !== undefined
      ? [...new Set(override.lines)]
      : seeded !== null
        ? [...seeded.lines]
        : [...baseConfig.lines];
  const segments =
    override.segments !== undefined
      ? { ...(seeded !== null ? seeded.segments : baseConfig.segments), ...override.segments }
      : seeded !== null
        ? { ...seeded.segments }
        : { ...baseConfig.segments };
  return { preset, maxAgentChips, osc8Links, lines, segments };
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
  const config = resolveRenderHudConfig(baseConfig, options?.hudConfig);
  const enabledLines = new Set<HudLineId>(config.lines);
  const collectors = options?.collectors;

  const needCliSettings = enabledLines.has('mode') || (enabledLines.has('identity') && config.segments.model);
  const cliSettings =
    options?.cliSettings !== undefined ? options.cliSettings : needCliSettings ? readCliSettings(cliHome) : {};

  const needTelemetry = config.segments.perf || config.segments.context || data.exceeds_200k_tokens === true;
  const telemetry =
    options?.telemetry !== undefined
      ? options.telemetry
      : needTelemetry
        ? (collectors?.loadSessionTelemetry ?? loadSessionTelemetry)(cliHome, data)
        : null;

  const effectiveData: StatusLineData =
    data.exceeds_200k_tokens === true && !resolveEffectiveExceeds200k(data, telemetry)
      ? { ...data, exceeds_200k_tokens: false }
      : data;

  const needActivity = config.segments.badges || hasAnyActivityLine(config.lines);
  const activity =
    options?.activity !== undefined
      ? options.activity
      : needActivity
        ? (collectors?.loadTranscriptActivity ?? loadTranscriptActivity)(cliHome, effectiveData)
        : null;

  const needAgents = config.segments.badges || enabledLines.has('activity') || enabledLines.has('agents');
  const agentsSummary =
    options?.agentsSummary !== undefined
      ? options.agentsSummary
      : needAgents
        ? (collectors?.collectAgentsSummary ?? collectAgentsSummary)(cliHome, effectiveData, activity?.agents)
        : null;

  const needTodos = enabledLines.has('todos');
  const todos =
    options?.todos !== undefined
      ? options.todos
      : needTodos
        ? (collectors?.loadTodos ?? loadTodos)(cliHome, effectiveData)
        : null;
  const hasTodosLine = needTodos && formatTodosLine(todos).length > 0;

  const termWidth = isFiniteNum(effectiveData.terminal_width) ? effectiveData.terminal_width : DEFAULT_TERM_WIDTH;
  const nowSec = options?.nowSec ?? Date.now() / 1000;

  const ctx: HudModuleRenderContext = {
    cliHome,
    data: effectiveData,
    config,
    enabledLines,
    cliSettings,
    telemetry,
    activity,
    agentsSummary,
    todos,
    hasTodosLine,
    termWidth,
    nowSec,
    modeOptions: { bypass: options?.bypass, cliMode: options?.cliMode },
    identityOptions: {
      branch: options?.branch,
      dirty: options?.dirty,
      elapsedSeconds: options?.elapsedSeconds,
      nowSec,
      detectGitBranch: collectors?.detectGitBranch ?? detectGitBranch,
    },
    activityLineOptions: options?.activityLineOptions,
    formatActivitySummaryTail: options?.formatActivitySummaryTail,
  };

  const rendered: string[] = [];
  for (const lineId of config.lines) {
    const renderer = LINE_MODULE_REGISTRY[lineId];
    const line = renderer(ctx);
    if (line.length > 0) {
      rendered.push(line);
    }
  }
  return rendered;
}
