import path from 'node:path';

import { buildPresetConfig, isHudPreset, parseHudConfig, VALID_HUD_PRESETS } from '../core/hud-config.ts';
import { resolveCliHome } from '../core/paths.ts';
import { readJsonObjectSync } from '../fs-utils.ts';
import { DEFAULT_TERM_WIDTH, GRAY, RESET } from '../render/ansi.ts';
import { renderHudPreviewLines } from '../render/preview-fixture.ts';
import type { HudPreset } from '../types.ts';
import { shouldUseSnapshotColor } from './snapshot-render.ts';

export const MIN_PREVIEW_COLS: number = 40;
export const MAX_PREVIEW_COLS: number = 400;
export const NARROW_PREVIEW_WIDTH: number = 80;

export interface PreviewCliArgs {
  readonly help: boolean;
  readonly width?: number;
  readonly narrow: boolean;
  readonly preset?: HudPreset;
  readonly allPresets: boolean;
  readonly noColor: boolean;
}

export interface PreviewRunOptions {
  readonly cliHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdoutColumns?: number;
}

export const PREVIEW_HELP_TEXT: string = `agy-hud preview

Usage:
  agy-hud preview [width] [options]

Options:
  [width], --width <cols>  Terminal width in columns (${MIN_PREVIEW_COLS}..${MAX_PREVIEW_COLS}, default: TTY or ${DEFAULT_TERM_WIDTH})
  --narrow                 Preview narrow split-pane width (${NARROW_PREVIEW_WIDTH} cols)
  --preset <preset>        Preview a specific persona preset (${VALID_HUD_PRESETS.join(' | ')})
  --all-presets            Render all 5 persona presets stacked for comparison
  --no-color               Strip ANSI colors and OSC 8 hyperlinks
  -h, --help               Show this help
`;

function parsePreviewWidth(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid preview width '${raw}' (expected integer ${MIN_PREVIEW_COLS}..${MAX_PREVIEW_COLS})`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_PREVIEW_COLS || parsed > MAX_PREVIEW_COLS) {
    throw new Error(`Out-of-range preview width '${raw}' (expected ${MIN_PREVIEW_COLS}..${MAX_PREVIEW_COLS})`);
  }
  return parsed;
}

export function parsePreviewArgs(argv: readonly string[]): PreviewCliArgs {
  let help = false;
  let width: number | undefined;
  let narrow = false;
  let preset: HudPreset | undefined;
  let allPresets = false;
  let noColor = false;

  const setWidth = (raw: string): void => {
    if (width !== undefined) {
      throw new Error(`Duplicate preview width '${raw}' (width '${width}' was already specified)`);
    }
    width = parsePreviewWidth(raw);
  };

  const setPreset = (raw: string): void => {
    if (!isHudPreset(raw)) {
      throw new Error(`Invalid preset '${raw}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
    }
    preset = raw;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--narrow') {
      narrow = true;
    } else if (arg === '--all-presets') {
      allPresets = true;
    } else if (arg === '--no-color') {
      noColor = true;
    } else if (arg === '--width') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('Missing value after --width');
      }
      setWidth(next);
      i += 1;
    } else if (arg.startsWith('--width=')) {
      setWidth(arg.slice('--width='.length));
    } else if (arg === '--preset') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('Missing value after --preset');
      }
      setPreset(next);
      i += 1;
    } else if (arg.startsWith('--preset=')) {
      setPreset(arg.slice('--preset='.length));
    } else if (!arg.startsWith('-') && /^\d+$/.test(arg)) {
      setWidth(arg);
    } else {
      throw new Error(`Unknown preview option: ${arg}`);
    }
  }

  if (!help && narrow && width !== undefined) {
    throw new Error(`Conflicting width options: --narrow cannot be combined with explicit width ${width}`);
  }
  if (!help && allPresets && preset !== undefined) {
    throw new Error('Conflicting preset options: --all-presets cannot be combined with --preset');
  }

  return { help, width, narrow, preset, allPresets, noColor };
}

function formatPreviewHeader(label: string, color: boolean): string {
  const line = `── ${label} ──`;
  return color ? `${GRAY}${line}${RESET}` : line;
}

export function runPreviewCommand(argv: readonly string[], options: PreviewRunOptions = {}): string {
  const parsed = parsePreviewArgs(argv);
  if (parsed.help) {
    return PREVIEW_HELP_TEXT;
  }

  const env = options.env ?? process.env;
  const cliHome = resolveCliHome(options.cliHome, env);
  const configPath = path.join(cliHome, 'hud-config.json');
  const activeConfig = parseHudConfig(readJsonObjectSync(configPath, true), true);
  const useColor = shouldUseSnapshotColor(parsed.noColor, env);

  const fallbackCols =
    options.stdoutColumns !== undefined &&
    Number.isFinite(options.stdoutColumns) &&
    options.stdoutColumns >= MIN_PREVIEW_COLS
      ? Math.min(MAX_PREVIEW_COLS, Math.floor(options.stdoutColumns))
      : DEFAULT_TERM_WIDTH;
  const width = parsed.narrow ? NARROW_PREVIEW_WIDTH : (parsed.width ?? fallbackCols);

  if (parsed.allPresets) {
    const sections: string[] = [];
    for (const presetName of VALID_HUD_PRESETS) {
      const cfg = buildPresetConfig(presetName, {
        maxAgentChips: activeConfig.maxAgentChips,
        osc8Links: activeConfig.osc8Links,
        costCurrency: activeConfig.costCurrency,
        usdToCnyRate: activeConfig.usdToCnyRate,
        narrow: activeConfig.narrow,
      });
      const lines = renderHudPreviewLines(cfg, { width, color: useColor });
      sections.push([formatPreviewHeader(`${presetName} (${width} cols)`, useColor), ...lines].join('\n'));
    }
    return `${sections.join('\n\n')}\n`;
  }

  const targetConfig =
    parsed.preset !== undefined
      ? buildPresetConfig(parsed.preset, {
          maxAgentChips: activeConfig.maxAgentChips,
          osc8Links: activeConfig.osc8Links,
          costCurrency: activeConfig.costCurrency,
          usdToCnyRate: activeConfig.usdToCnyRate,
          narrow: activeConfig.narrow,
        })
      : activeConfig;
  const lines = renderHudPreviewLines(targetConfig, { width, color: useColor });
  if (lines.length === 0) {
    return '(all status line modules disabled)\n';
  }
  return `${lines.join('\n')}\n`;
}
