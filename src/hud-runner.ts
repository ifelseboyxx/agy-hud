import { loadTodos, loadTranscriptActivity, resolveTranscriptPath } from './collectors/activity.ts';
import { collectAgentsSummary } from './collectors/agents.ts';
import { detectGitStatus } from './collectors/git.ts';
import { detectAgyFlags, detectAgyProcess } from './collectors/proc.ts';
import { resolveConversationId } from './collectors/safe-path.ts';
import { getSessionElapsedSeconds, readCliSettings, readHudConfig } from './collectors/settings.ts';
import { readActivePidMarker, readSnapshotEnvelope, type ActivePidMarker } from './collectors/snapshot-envelope.ts';
import { loadSessionTelemetry } from './collectors/telemetry.ts';
import { isFiniteNum, nonEmptyStr } from './core/guards.ts';
import {
  buildPresetConfig,
  cloneHudConfig,
  cloneNarrowOverride,
  PRESET_TEMPLATES,
  resolveEffectiveHudConfig,
} from './core/hud-config.ts';
import { lstatIfPresentSync, statIfPresentSync } from './fs-utils.ts';
import { materializeSnapshotMarkdownIfNeeded, type TranscriptStatFingerprint } from './hud-snapshot-publish.ts';
import { DEFAULT_TERM_WIDTH } from './render/ansi.ts';
import { formatHudLines, normalizeEffectiveStatusData } from './render/format-hud.ts';
import { hasAnyActivityLine } from './render/modules.ts';
import {
  canEmitOsc8Links,
  countEmittedOsc8Links,
  formatActivitySummarySnapshotTail,
  formatOsc8Overflow,
  resolveSnapshotMarkdownUri,
} from './render/osc8.ts';
import type { SnapshotEnvelope } from './snapshot-types.ts';
import type {
  ActivityLineFormatOptions,
  GitStatusInfo,
  HudCollectorOverrides,
  HudConfig,
  HudLineId,
  RenderHudOptions,
  StatusLineData,
} from './types.ts';

export type { HudCollectorOverrides, RenderHudOptions };

function resolveRenderHudConfig(baseConfig: HudConfig, override?: Partial<HudConfig>): HudConfig {
  if (!override) {
    return cloneHudConfig(baseConfig);
  }
  const maxAgentChips = override.maxAgentChips ?? baseConfig.maxAgentChips;
  const osc8Links = override.osc8Links ?? baseConfig.osc8Links;
  const costCurrency = override.costCurrency ?? baseConfig.costCurrency;
  const usdToCnyRate = override.usdToCnyRate ?? baseConfig.usdToCnyRate;
  const narrow = cloneNarrowOverride(override.narrow !== undefined ? override.narrow : baseConfig.narrow);
  if (override.preset !== undefined && override.lines === undefined && override.segments === undefined) {
    return buildPresetConfig(override.preset, { maxAgentChips, osc8Links, costCurrency, usdToCnyRate, narrow });
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
  return {
    preset,
    maxAgentChips,
    osc8Links,
    costCurrency,
    usdToCnyRate,
    lines,
    segments,
    ...(narrow !== undefined ? { narrow } : {}),
  };
}

function resolveHudGitInfo(
  cliHome: string,
  data: StatusLineData,
  options: RenderHudOptions | undefined,
  collectors: HudCollectorOverrides | undefined,
  nowMs: number,
): GitStatusInfo {
  if (options?.gitInfo !== undefined) {
    return options.gitInfo;
  }
  if (options?.branch !== undefined) {
    return { branch: options.branch, dirty: Boolean(options.dirty ?? data.vcs?.dirty) };
  }
  const curDir =
    nonEmptyStr(data.workspace?.current_dir) ?? nonEmptyStr(data.workspace?.project_dir) ?? nonEmptyStr(data.cwd) ?? '';
  if (collectors?.detectGitStatus !== undefined) {
    return collectors.detectGitStatus(cliHome, curDir, data.vcs);
  }
  if (collectors?.detectGitBranch !== undefined) {
    return collectors.detectGitBranch(curDir, data.vcs);
  }
  return detectGitStatus(cliHome, curDir, data.vcs, { nowMs });
}

export function runHudRender(cliHome: string, data: StatusLineData, options?: RenderHudOptions): string[] {
  const baseConfig = readHudConfig(cliHome);
  const rawConfig = resolveRenderHudConfig(baseConfig, options?.hudConfig);
  const termWidth =
    isFiniteNum(data.terminal_width) && data.terminal_width > 0 ? data.terminal_width : DEFAULT_TERM_WIDTH;
  const config = resolveEffectiveHudConfig(rawConfig, termWidth);
  const enabledLines = new Set<HudLineId>(config.lines);
  const collectors = options?.collectors;

  const nowSec = options?.nowSec ?? Date.now() / 1000;
  const nowMs = Math.round(nowSec * 1000);
  const convId = resolveConversationId(data);
  const existingEnvelope: SnapshotEnvelope | null = convId !== null ? readSnapshotEnvelope(cliHome, convId) : null;
  let agyPid = options?.agyPid ?? null;
  let resolvedBypass = options?.bypass;
  let resolvedCliMode = options?.cliMode;
  if (convId !== null && options?.agyPid === undefined) {
    const procInfo = detectAgyProcess(cliHome, { knownLiveAgyPid: existingEnvelope?.agyPid ?? null });
    agyPid = procInfo.agyPid;
    resolvedBypass ??= procInfo.bypass;
    resolvedCliMode ??= procInfo.cliMode;
  }
  const baselinePidMarker: ActivePidMarker | null =
    convId !== null && agyPid !== null ? readActivePidMarker(cliHome, agyPid, nowMs) : null;

  const hasIdentity = enabledLines.has('identity');
  const hasUsage = enabledLines.has('usage');
  const needCliSettings = enabledLines.has('mode') || (hasIdentity && config.segments.model);
  const cliSettings =
    options?.cliSettings !== undefined ? options.cliSettings : needCliSettings ? readCliSettings(cliHome) : {};

  const needTelemetry =
    (hasIdentity && config.segments.perf) ||
    ((hasUsage || hasIdentity) && config.segments.context) ||
    data.exceeds_200k_tokens === true;
  const telemetry =
    options?.telemetry !== undefined
      ? options.telemetry
      : needTelemetry
        ? (collectors?.loadSessionTelemetry ?? loadSessionTelemetry)(cliHome, data)
        : null;

  const effectiveData = normalizeEffectiveStatusData(data, telemetry);

  const needBadges = hasIdentity && config.segments.badges;
  const needActivity = needBadges || hasAnyActivityLine(config.lines);
  const activity =
    options?.activity !== undefined
      ? options.activity
      : needActivity
        ? (collectors?.loadTranscriptActivity ?? loadTranscriptActivity)(cliHome, effectiveData)
        : null;

  const needAgents = needBadges || enabledLines.has('activity') || enabledLines.has('agents');
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

  const env = options?.env ?? process.env;
  const osc8Target =
    convId !== null && canEmitOsc8Links(config, convId, env) ? resolveSnapshotMarkdownUri(cliHome, convId) : null;
  if (enabledLines.has('mode') && (resolvedBypass === undefined || resolvedCliMode === undefined)) {
    const procFlags = detectAgyFlags(cliHome);
    resolvedBypass ??= procFlags.bypass;
    resolvedCliMode ??= procFlags.cliMode;
  }

  const gitInfo =
    enabledLines.has('identity') && config.segments.git
      ? resolveHudGitInfo(cliHome, effectiveData, options, collectors, nowMs)
      : null;
  const rawConvId = nonEmptyStr(effectiveData.conversation_id) ?? nonEmptyStr(effectiveData.session_id);
  const elapsedSeconds =
    options?.elapsedSeconds !== undefined
      ? options.elapsedSeconds
      : enabledLines.has('identity') && config.segments.duration
        ? getSessionElapsedSeconds(cliHome, rawConvId, effectiveData)
        : null;

  const renderFrame = (allowOsc8: boolean): string[] => {
    const activeTarget = allowOsc8 ? osc8Target : null;
    const activityLineOptions: ActivityLineFormatOptions | undefined =
      options?.activityLineOptions?.formatOverflow !== undefined
        ? options.activityLineOptions
        : activeTarget !== null
          ? {
              ...options?.activityLineOptions,
              formatOverflow: (hiddenCount) => formatOsc8Overflow(hiddenCount, activeTarget.uri),
            }
          : options?.activityLineOptions;

    const formatActivitySummaryTail: ((remainingCols: number) => string) | undefined =
      options?.formatActivitySummaryTail !== undefined
        ? options.formatActivitySummaryTail
        : activeTarget !== null
          ? (remainingCols) => formatActivitySummarySnapshotTail(remainingCols, activeTarget.uri)
          : undefined;

    return formatHudLines({
      data: effectiveData,
      config,
      cliSettings,
      telemetry,
      activity,
      agentsSummary,
      todos,
      termWidth,
      nowSec,
      modeOptions: { bypass: resolvedBypass, cliMode: resolvedCliMode },
      identityOptions: {
        gitInfo: gitInfo ?? undefined,
        branch: gitInfo?.branch,
        dirty: gitInfo?.dirty,
        elapsedSeconds,
        nowSec,
      },
      activityLineOptions,
      formatActivitySummaryTail,
    });
  };

  let rendered = renderFrame(true);

  // Always write the lightweight session metadata envelope; materialize .md only under Gate 1 + Gate 2.
  if (convId !== null) {
    const emittedOsc8Count = osc8Target !== null ? countEmittedOsc8Links(rendered, osc8Target.uri) : 0;
    let transcriptStat: TranscriptStatFingerprint | null = null;
    if (osc8Target !== null && emittedOsc8Count >= 1) {
      const transcriptPath = resolveTranscriptPath(cliHome, effectiveData);
      let st: ReturnType<typeof statIfPresentSync> = null;
      if (transcriptPath !== null) {
        try {
          st = statIfPresentSync(transcriptPath);
        } catch {
          st = null;
        }
      }
      if (st !== null && st.isFile()) {
        transcriptStat = { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    // When an OSC 8 overflow link is actually emitted on narrow layouts that hid identity/usage,
    // lazily backfill telemetry/agents so the materialized Markdown snapshot stays complete.
    const snapshotTelemetry =
      osc8Target !== null && emittedOsc8Count >= 1 && telemetry === null && options?.telemetry === undefined
        ? (collectors?.loadSessionTelemetry ?? loadSessionTelemetry)(cliHome, effectiveData)
        : telemetry;
    const snapshotAgents =
      osc8Target !== null && emittedOsc8Count >= 1 && agentsSummary === null && options?.agentsSummary === undefined
        ? (collectors?.collectAgentsSummary ?? collectAgentsSummary)(cliHome, effectiveData, activity?.agents)
        : agentsSummary;
    const matResult = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target: osc8Target,
      emittedOsc8Count,
      data: effectiveData,
      agyPid,
      existingEnvelope,
      baselinePidMarker,
      transcriptStat,
      activity,
      agentsSummary: snapshotAgents,
      telemetry: snapshotTelemetry,
      costCurrency: config.costCurrency,
      usdToCnyRate: config.usdToCnyRate,
      nowMs,
    });
    if (osc8Target !== null && emittedOsc8Count >= 1 && !matResult.written) {
      let hasRegularMd = false;
      try {
        const mdStat = lstatIfPresentSync(osc8Target.absPath);
        hasRegularMd = mdStat !== null && !mdStat.isSymbolicLink() && mdStat.isFile();
      } catch {
        hasRegularMd = false;
      }
      if (!hasRegularMd) {
        rendered = renderFrame(false);
      }
    }
  }
  return rendered;
}
