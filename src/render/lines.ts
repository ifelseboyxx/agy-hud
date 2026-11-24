import { loadTodos, loadTranscriptActivity, resolveTranscriptPath } from '../collectors/activity.ts';
import { collectAgentsSummary } from '../collectors/agents.ts';
import { detectAgyProcess } from '../collectors/proc.ts';
import { resolveConversationId } from '../collectors/safe-path.ts';
import { detectGitBranch, readCliSettings, readHudConfig, type GitBranchInfo } from '../collectors/settings.ts';
import { readSnapshotEnvelope } from '../collectors/snapshot-envelope.ts';
import { loadSessionTelemetry } from '../collectors/telemetry.ts';
import { isFiniteNum } from '../core/guards.ts';
import { buildPresetConfig, cloneHudConfig, PRESET_TEMPLATES } from '../core/hud-config.ts';
import { statIfPresentSync } from '../fs-utils.ts';
import type { SnapshotEnvelope } from '../snapshot-types.ts';
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
import {
  canEmitOsc8Links,
  countEmittedOsc8Links,
  formatActivitySummarySnapshotTail,
  formatOsc8Overflow,
  materializeSnapshotMarkdownIfNeeded,
  resolveSnapshotMarkdownUri,
  type TranscriptStatFingerprint,
} from './osc8.ts';
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
  agyPid?: number | null;
  bypass?: boolean;
  cliMode?: string;
  branch?: string;
  dirty?: boolean;
  elapsedSeconds?: number | null;
  activityLineOptions?: ActivityLineFormatOptions;
  formatActivitySummaryTail?: (remainingCols: number) => string;
  collectors?: HudCollectorOverrides;
  env?: NodeJS.ProcessEnv;
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

  const convId = resolveConversationId(effectiveData);
  const env = options?.env ?? process.env;
  const osc8Target =
    convId !== null && canEmitOsc8Links(config, convId, env) ? resolveSnapshotMarkdownUri(cliHome, convId) : null;
  let existingEnvelope: SnapshotEnvelope | null = null;
  let agyPid = options?.agyPid ?? null;
  let resolvedBypass = options?.bypass;
  let resolvedCliMode = options?.cliMode;
  if (convId !== null) {
    existingEnvelope = readSnapshotEnvelope(cliHome, convId);
    if (options?.agyPid === undefined) {
      const procInfo = detectAgyProcess(cliHome, { knownLiveAgyPid: existingEnvelope?.agyPid ?? null });
      agyPid = procInfo.agyPid;
      resolvedBypass ??= procInfo.bypass;
      resolvedCliMode ??= procInfo.cliMode;
    }
  }

  const activityLineOptions: ActivityLineFormatOptions | undefined =
    options?.activityLineOptions?.formatOverflow !== undefined
      ? options.activityLineOptions
      : osc8Target !== null
        ? {
            ...options?.activityLineOptions,
            formatOverflow: (hiddenCount) => formatOsc8Overflow(hiddenCount, osc8Target.uri),
          }
        : options?.activityLineOptions;

  const formatActivitySummaryTail: ((remainingCols: number) => string) | undefined =
    options?.formatActivitySummaryTail !== undefined
      ? options.formatActivitySummaryTail
      : osc8Target !== null
        ? (remainingCols) => formatActivitySummarySnapshotTail(remainingCols, osc8Target.uri)
        : undefined;

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
    modeOptions: { bypass: resolvedBypass, cliMode: resolvedCliMode },
    identityOptions: {
      branch: options?.branch,
      dirty: options?.dirty,
      elapsedSeconds: options?.elapsedSeconds,
      nowSec,
      detectGitBranch: collectors?.detectGitBranch ?? detectGitBranch,
    },
    activityLineOptions,
    formatActivitySummaryTail,
  };

  const rendered: string[] = [];
  for (const lineId of config.lines) {
    const renderer = LINE_MODULE_REGISTRY[lineId];
    const line = renderer(ctx);
    if (line.length > 0) {
      rendered.push(line);
    }
  }

  // Always write the lightweight session metadata envelope; materialize .md only under Gate 1 + Gate 2.
  if (convId !== null) {
    const nowMs = Math.round(nowSec * 1000);
    const emittedOsc8Count = osc8Target !== null ? countEmittedOsc8Links(rendered, osc8Target.uri) : 0;
    let transcriptStat: TranscriptStatFingerprint | null = null;
    if (osc8Target !== null && emittedOsc8Count >= 1) {
      const transcriptPath = resolveTranscriptPath(cliHome, effectiveData);
      const st = transcriptPath !== null ? statIfPresentSync(transcriptPath) : null;
      if (st !== null && st.isFile()) {
        transcriptStat = { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target: osc8Target,
      emittedOsc8Count,
      data: effectiveData,
      agyPid,
      existingEnvelope,
      transcriptStat,
      activity,
      agentsSummary,
      telemetry,
      nowMs,
    });
  }
  return rendered;
}
