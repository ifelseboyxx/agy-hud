import type {
  HudConfig,
  HudCostCurrency,
  HudLineId,
  HudNarrowOverride,
  HudPreset,
  HudSegmentId,
  HudSegments,
} from '../types.ts';
import { isFiniteNum, isPlainObject, UNSAFE_OBJECT_KEYS } from './guards.ts';

export const DEFAULT_HUD_CONFIG: HudConfig = {
  preset: 'full',
  maxAgentChips: 8,
  osc8Links: true,
  costCurrency: 'usd',
  usdToCnyRate: 7.25,
  lines: ['mode', 'identity', 'usage', 'tools', 'skills', 'mcps', 'agents', 'todos'],
  segments: {
    model: true,
    git: true,
    duration: true,
    badges: true,
    cost: true,
    perf: true,
    context: true,
    quota: true,
  },
};

export const VALID_HUD_PRESETS: readonly HudPreset[] = ['zen', 'minimal', 'compact', 'swarm', 'full'];

export const VALID_COST_CURRENCIES: readonly HudCostCurrency[] = ['usd', 'cny', 'both'];

export const DEFAULT_USD_TO_CNY_RATE: number = DEFAULT_HUD_CONFIG.usdToCnyRate;
export const MIN_USD_TO_CNY_RATE: number = 0.01;
export const MAX_USD_TO_CNY_RATE: number = 1000;
export const NARROW_PANE_WIDTH_THRESHOLD: number = 100;

export const HUD_LINE_IDS: readonly HudLineId[] = [
  'mode',
  'identity',
  'usage',
  'activity',
  'tools',
  'skills',
  'mcps',
  'agents',
  'todos',
];

export const HUD_SEGMENT_IDS: readonly HudSegmentId[] = [
  'model',
  'git',
  'duration',
  'badges',
  'cost',
  'perf',
  'context',
  'quota',
];

export const MAX_AGENT_CHIPS_LIMIT: number = 20;

export interface HudPresetTemplate {
  readonly lines: readonly HudLineId[];
  readonly segments: Readonly<HudSegments>;
}

const FOCUSED_SEGMENTS: Readonly<HudSegments> = {
  model: true,
  git: true,
  duration: false,
  badges: true,
  cost: false,
  perf: false,
  context: true,
  quota: true,
};

const ALL_SEGMENTS: Readonly<HudSegments> = {
  model: true,
  git: true,
  duration: true,
  badges: true,
  cost: true,
  perf: true,
  context: true,
  quota: true,
};

export const PRESET_TEMPLATES: Readonly<Record<HudPreset, HudPresetTemplate>> = {
  zen: {
    lines: ['identity'],
    segments: FOCUSED_SEGMENTS,
  },
  minimal: {
    lines: ['identity', 'usage'],
    segments: FOCUSED_SEGMENTS,
  },
  compact: {
    lines: ['mode', 'identity', 'usage', 'activity'],
    segments: ALL_SEGMENTS,
  },
  swarm: {
    lines: ['mode', 'identity', 'usage', 'agents', 'todos'],
    segments: ALL_SEGMENTS,
  },
  full: {
    lines: ['mode', 'identity', 'usage', 'tools', 'skills', 'mcps', 'agents', 'todos'],
    segments: ALL_SEGMENTS,
  },
};

const HUD_PRESET_SET: ReadonlySet<string> = new Set(VALID_HUD_PRESETS);
const HUD_COST_CURRENCY_SET: ReadonlySet<string> = new Set(VALID_COST_CURRENCIES);
const HUD_LINE_ID_SET: ReadonlySet<string> = new Set(HUD_LINE_IDS);
const HUD_SEGMENT_ID_SET: ReadonlySet<string> = new Set(HUD_SEGMENT_IDS);
const LINE_RANK: ReadonlyMap<HudLineId, number> = new Map(HUD_LINE_IDS.map((id, idx) => [id, idx]));

export function isHudPreset(value: unknown): value is HudPreset {
  return typeof value === 'string' && HUD_PRESET_SET.has(value);
}

export function isHudCostCurrency(value: unknown): value is HudCostCurrency {
  return typeof value === 'string' && HUD_COST_CURRENCY_SET.has(value);
}

export function isValidUsdToCnyRate(value: unknown): value is number {
  return isFiniteNum(value) && value >= MIN_USD_TO_CNY_RATE && value <= MAX_USD_TO_CNY_RATE;
}

export function isHudLineId(value: unknown): value is HudLineId {
  return typeof value === 'string' && HUD_LINE_ID_SET.has(value);
}

export function isHudSegmentId(value: unknown): value is HudSegmentId {
  return typeof value === 'string' && HUD_SEGMENT_ID_SET.has(value);
}

function isValidMaxAgentChips(value: unknown): value is number {
  return isFiniteNum(value) && Number.isInteger(value) && value >= 0 && value <= MAX_AGENT_CHIPS_LIMIT;
}

export function cloneNarrowOverride(narrow: HudNarrowOverride | undefined): HudNarrowOverride | undefined {
  if (!narrow) return undefined;
  const out: HudNarrowOverride = {};
  if (narrow.lines !== undefined) {
    out.lines = [...narrow.lines];
  }
  if (narrow.segments !== undefined && Object.keys(narrow.segments).length > 0) {
    out.segments = { ...narrow.segments };
  }
  return out.lines !== undefined || out.segments !== undefined ? out : undefined;
}

export function cloneHudConfig(config: HudConfig): HudConfig {
  const narrow = cloneNarrowOverride(config.narrow);
  return {
    preset: config.preset,
    maxAgentChips: config.maxAgentChips,
    osc8Links: config.osc8Links,
    costCurrency: config.costCurrency,
    usdToCnyRate: config.usdToCnyRate,
    lines: [...config.lines],
    segments: { ...config.segments },
    ...(narrow !== undefined ? { narrow } : {}),
  };
}

export type PresetConfigOverrides = Partial<
  Pick<HudConfig, 'maxAgentChips' | 'osc8Links' | 'costCurrency' | 'usdToCnyRate' | 'narrow'>
>;

export function buildPresetConfig(preset: HudPreset, overrides?: PresetConfigOverrides): HudConfig {
  const tpl = PRESET_TEMPLATES[preset];
  const narrow = cloneNarrowOverride(overrides?.narrow);
  return {
    preset,
    maxAgentChips: overrides?.maxAgentChips ?? DEFAULT_HUD_CONFIG.maxAgentChips,
    osc8Links: overrides?.osc8Links ?? DEFAULT_HUD_CONFIG.osc8Links,
    costCurrency: overrides?.costCurrency ?? DEFAULT_HUD_CONFIG.costCurrency,
    usdToCnyRate: overrides?.usdToCnyRate ?? DEFAULT_HUD_CONFIG.usdToCnyRate,
    lines: [...tpl.lines],
    segments: { ...tpl.segments },
    ...(narrow !== undefined ? { narrow } : {}),
  };
}

export function resolveEffectiveHudConfig(config: HudConfig, termWidth: number): HudConfig {
  if (termWidth >= NARROW_PANE_WIDTH_THRESHOLD || config.narrow === undefined) {
    return config;
  }
  const narrow = config.narrow;
  return {
    preset: config.preset,
    maxAgentChips: config.maxAgentChips,
    osc8Links: config.osc8Links,
    costCurrency: config.costCurrency,
    usdToCnyRate: config.usdToCnyRate,
    lines: narrow.lines !== undefined ? [...narrow.lines] : [...config.lines],
    segments: narrow.segments !== undefined ? { ...config.segments, ...narrow.segments } : { ...config.segments },
  };
}

export function applyHudLineToggle(lines: readonly HudLineId[], lineId: HudLineId, enabled: boolean): HudLineId[] {
  if (!enabled) {
    return lines.filter((id) => id !== lineId);
  }
  if (lines.includes(lineId)) {
    return [...lines];
  }
  const targetRank = LINE_RANK.get(lineId) ?? HUD_LINE_IDS.length;
  const next = [...lines];
  const insertAt = next.findIndex((id) => (LINE_RANK.get(id) ?? HUD_LINE_IDS.length) > targetRank);
  if (insertAt === -1) {
    next.push(lineId);
  } else {
    next.splice(insertAt, 0, lineId);
  }
  return next;
}

function parseLinesField(rawLines: unknown, fallback: HudLineId[], strict: boolean): HudLineId[] {
  if (!Array.isArray(rawLines)) {
    if (strict) {
      throw new Error("Invalid 'lines' in hud-config.json (expected array of line IDs)");
    }
    return fallback;
  }
  const deduped: HudLineId[] = [];
  const seen = new Set<HudLineId>();
  for (const item of rawLines) {
    if (!isHudLineId(item)) {
      if (strict) {
        throw new Error(`Invalid line ID '${String(item)}' in hud-config.json (expected: ${HUD_LINE_IDS.join(' | ')})`);
      }
      continue;
    }
    if (!seen.has(item)) {
      seen.add(item);
      deduped.push(item);
    }
  }
  return deduped;
}

function applySegmentsField(rawSegments: unknown, target: HudSegments, strict: boolean): void {
  if (!isPlainObject(rawSegments)) {
    if (strict) {
      throw new Error("Invalid 'segments' in hud-config.json (expected object of segment booleans)");
    }
    return;
  }
  for (const [segKey, segVal] of Object.entries(rawSegments)) {
    if (UNSAFE_OBJECT_KEYS.has(segKey)) continue;
    if (!isHudSegmentId(segKey)) {
      if (strict) {
        throw new Error(`Unknown segment ID '${segKey}' in hud-config.json (expected: ${HUD_SEGMENT_IDS.join(' | ')})`);
      }
      continue;
    }
    if (typeof segVal === 'boolean') {
      target[segKey] = segVal;
    } else if (strict) {
      throw new Error(`Invalid boolean 'segments.${segKey}' in hud-config.json`);
    }
  }
}

function parseNarrowField(rawNarrow: unknown, strict: boolean): HudNarrowOverride | undefined {
  if (!isPlainObject(rawNarrow)) {
    if (strict) {
      throw new Error("Invalid 'narrow' in hud-config.json (expected object with optional 'lines' and 'segments')");
    }
    return undefined;
  }
  const out: HudNarrowOverride = {};
  for (const key of Object.keys(rawNarrow)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (key !== 'lines' && key !== 'segments' && strict) {
      throw new Error(`Unknown key 'narrow.${key}' in hud-config.json (expected: lines | segments)`);
    }
  }
  if (rawNarrow.lines !== undefined) {
    if (!Array.isArray(rawNarrow.lines)) {
      if (strict) {
        throw new Error("Invalid 'narrow.lines' in hud-config.json (expected array of line IDs)");
      }
    } else {
      const deduped: HudLineId[] = [];
      const seen = new Set<HudLineId>();
      for (const item of rawNarrow.lines) {
        if (!isHudLineId(item)) {
          if (strict) {
            throw new Error(
              `Invalid line ID '${String(item)}' in hud-config.json 'narrow.lines' (expected: ${HUD_LINE_IDS.join(' | ')})`,
            );
          }
          continue;
        }
        if (!seen.has(item)) {
          seen.add(item);
          deduped.push(item);
        }
      }
      out.lines = deduped;
    }
  }
  if (rawNarrow.segments !== undefined) {
    if (!isPlainObject(rawNarrow.segments)) {
      if (strict) {
        throw new Error("Invalid 'narrow.segments' in hud-config.json (expected object of segment booleans)");
      }
    } else {
      const cleanSegs: Partial<HudSegments> = {};
      for (const [segKey, segVal] of Object.entries(rawNarrow.segments)) {
        if (UNSAFE_OBJECT_KEYS.has(segKey)) continue;
        if (!isHudSegmentId(segKey)) {
          if (strict) {
            throw new Error(
              `Unknown segment ID '${segKey}' in hud-config.json 'narrow.segments' (expected: ${HUD_SEGMENT_IDS.join(' | ')})`,
            );
          }
          continue;
        }
        if (typeof segVal === 'boolean') {
          cleanSegs[segKey] = segVal;
        } else if (strict) {
          throw new Error(`Invalid boolean 'narrow.segments.${segKey}' in hud-config.json`);
        }
      }
      if (Object.keys(cleanSegs).length > 0) {
        out.segments = cleanSegs;
      }
    }
  }
  return out.lines !== undefined || out.segments !== undefined ? out : undefined;
}

export function parseHudConfig(raw: Record<string, unknown> | null | undefined, strict: boolean): HudConfig {
  if (!raw) {
    return buildPresetConfig(DEFAULT_HUD_CONFIG.preset);
  }

  let seedPreset: HudPreset = DEFAULT_HUD_CONFIG.preset;
  if (raw.preset !== undefined) {
    if (isHudPreset(raw.preset)) {
      seedPreset = raw.preset;
    } else if (strict) {
      throw new Error(`Invalid 'preset' in hud-config.json (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
    }
  }

  const next = buildPresetConfig(seedPreset);

  if (raw.maxAgentChips !== undefined) {
    if (isValidMaxAgentChips(raw.maxAgentChips)) {
      next.maxAgentChips = raw.maxAgentChips;
    } else if (strict) {
      throw new Error(`Invalid 'maxAgentChips' in hud-config.json (expected integer 0..${MAX_AGENT_CHIPS_LIMIT})`);
    }
  }

  if (raw.osc8Links !== undefined) {
    if (typeof raw.osc8Links === 'boolean') {
      next.osc8Links = raw.osc8Links;
    } else if (strict) {
      throw new Error("Invalid boolean 'osc8Links' in hud-config.json");
    }
  }

  if (raw.costCurrency !== undefined) {
    if (isHudCostCurrency(raw.costCurrency)) {
      next.costCurrency = raw.costCurrency;
    } else if (strict) {
      throw new Error(`Invalid 'costCurrency' in hud-config.json (expected: ${VALID_COST_CURRENCIES.join(' | ')})`);
    }
  }

  if (raw.usdToCnyRate !== undefined) {
    if (isValidUsdToCnyRate(raw.usdToCnyRate)) {
      next.usdToCnyRate = raw.usdToCnyRate;
    } else if (strict) {
      throw new Error(
        `Invalid 'usdToCnyRate' in hud-config.json (expected number ${MIN_USD_TO_CNY_RATE}..${MAX_USD_TO_CNY_RATE})`,
      );
    }
  }

  if (raw.lines !== undefined) {
    next.lines = parseLinesField(raw.lines, next.lines, strict);
  }

  if (raw.segments !== undefined) {
    applySegmentsField(raw.segments, next.segments, strict);
  }

  if (raw.narrow !== undefined) {
    const parsedNarrow = parseNarrowField(raw.narrow, strict);
    if (parsedNarrow !== undefined) {
      next.narrow = parsedNarrow;
    }
  }

  return next;
}

export function mergeHudConfig(raw: Record<string, unknown> | null | undefined): HudConfig {
  return parseHudConfig(raw, false);
}

export function hydrateHudConfig(raw: Record<string, unknown> | null): HudConfig {
  return parseHudConfig(raw, true);
}
