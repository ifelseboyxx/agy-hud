import {
  DEFAULT_HUD_CONFIG,
  type HudConfig,
  type HudLineId,
  type HudPreset,
  type HudSegmentId,
  type HudSegments,
} from '../types.ts';
import { isFiniteNum, isPlainObject, UNSAFE_OBJECT_KEYS } from './guards.ts';

export const VALID_HUD_PRESETS: readonly HudPreset[] = ['zen', 'minimal', 'compact', 'swarm', 'full'];

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
const HUD_LINE_ID_SET: ReadonlySet<string> = new Set(HUD_LINE_IDS);
const HUD_SEGMENT_ID_SET: ReadonlySet<string> = new Set(HUD_SEGMENT_IDS);
const LINE_RANK: ReadonlyMap<HudLineId, number> = new Map(HUD_LINE_IDS.map((id, idx) => [id, idx]));

export function isHudPreset(value: unknown): value is HudPreset {
  return typeof value === 'string' && HUD_PRESET_SET.has(value);
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

export function cloneHudConfig(config: HudConfig): HudConfig {
  return {
    preset: config.preset,
    maxAgentChips: config.maxAgentChips,
    osc8Links: config.osc8Links,
    lines: [...config.lines],
    segments: { ...config.segments },
  };
}

export function buildPresetConfig(
  preset: HudPreset,
  overrides?: Partial<Pick<HudConfig, 'maxAgentChips' | 'osc8Links'>>,
): HudConfig {
  const tpl = PRESET_TEMPLATES[preset];
  return {
    preset,
    maxAgentChips: overrides?.maxAgentChips ?? DEFAULT_HUD_CONFIG.maxAgentChips,
    osc8Links: overrides?.osc8Links ?? DEFAULT_HUD_CONFIG.osc8Links,
    lines: [...tpl.lines],
    segments: { ...tpl.segments },
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

  if (raw.lines !== undefined) {
    next.lines = parseLinesField(raw.lines, next.lines, strict);
  }

  if (raw.segments !== undefined) {
    applySegmentsField(raw.segments, next.segments, strict);
  }

  return next;
}

export function mergeHudConfig(raw: Record<string, unknown> | null | undefined): HudConfig {
  return parseHudConfig(raw, false);
}

export function hydrateHudConfig(raw: Record<string, unknown> | null): HudConfig {
  return parseHudConfig(raw, true);
}
