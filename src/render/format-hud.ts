import { isFiniteNum } from '../core/guards.ts';
import type {
  AgentsSummary,
  CliSettings,
  HudConfig,
  HudLineId,
  SessionTelemetry,
  StatusLineData,
  TodoSummary,
  TranscriptActivity,
} from '../types.ts';
import { formatTodosLine } from './activity-lines.ts';
import { DEFAULT_TERM_WIDTH } from './ansi.ts';
import {
  type HudModuleRenderContext,
  type IdentityLineOptions,
  LINE_MODULE_REGISTRY,
  type ModeLineOptions,
} from './modules.ts';
import type { ActivityLineFormatOptions } from './pack-line.ts';

export interface FormatHudLinesInput {
  readonly data: StatusLineData;
  readonly config: HudConfig;
  readonly cliSettings: CliSettings;
  readonly telemetry: SessionTelemetry | null;
  readonly activity: TranscriptActivity | null;
  readonly agentsSummary: AgentsSummary | null;
  readonly todos: TodoSummary | null;
  readonly termWidth?: number;
  readonly nowSec: number;
  readonly modeOptions: ModeLineOptions;
  readonly identityOptions: IdentityLineOptions;
  readonly activityLineOptions?: ActivityLineFormatOptions;
  readonly formatActivitySummaryTail?: (remainingCols: number) => string;
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

export function formatHudLines(input: FormatHudLinesInput): string[] {
  const { config, telemetry } = input;
  const enabledLines = new Set<HudLineId>(config.lines);
  const effectiveData: StatusLineData =
    input.data.exceeds_200k_tokens === true && !resolveEffectiveExceeds200k(input.data, telemetry)
      ? { ...input.data, exceeds_200k_tokens: false }
      : input.data;

  const hasTodosLine = enabledLines.has('todos') && formatTodosLine(input.todos).length > 0;
  const termWidth =
    isFiniteNum(input.termWidth) && input.termWidth > 0
      ? input.termWidth
      : isFiniteNum(effectiveData.terminal_width) && effectiveData.terminal_width > 0
        ? effectiveData.terminal_width
        : DEFAULT_TERM_WIDTH;

  const ctx: HudModuleRenderContext = {
    data: effectiveData,
    config,
    enabledLines,
    cliSettings: input.cliSettings,
    telemetry,
    activity: input.activity,
    agentsSummary: input.agentsSummary,
    todos: input.todos,
    hasTodosLine,
    termWidth,
    nowSec: input.nowSec,
    modeOptions: input.modeOptions,
    identityOptions: input.identityOptions,
    activityLineOptions: input.activityLineOptions,
    formatActivitySummaryTail: input.formatActivitySummaryTail,
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
