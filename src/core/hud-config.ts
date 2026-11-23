import { DEFAULT_HUD_CONFIG, type HudConfig, type HudPreset } from '../types.ts';
import { isFiniteNum } from './guards.ts';

export const VALID_HUD_PRESETS: readonly HudPreset[] = ['full', 'compact', 'minimal'];
export const MAX_AGENT_CHIPS_LIMIT = 20;

export type HudBooleanKey =
  | 'showModeLine'
  | 'showPerfCapsule'
  | 'showQuota'
  | 'showCost'
  | 'showSwarmChips'
  | 'showToolsLine'
  | 'showSkillsMcpLine'
  | 'showTodosLine';

export const HUD_BOOLEAN_KEYS: readonly HudBooleanKey[] = [
  'showModeLine',
  'showPerfCapsule',
  'showQuota',
  'showCost',
  'showSwarmChips',
  'showToolsLine',
  'showSkillsMcpLine',
  'showTodosLine',
];

const HUD_BOOLEAN_KEY_SET: ReadonlySet<string> = new Set(HUD_BOOLEAN_KEYS);
const HUD_PRESET_SET: ReadonlySet<string> = new Set(VALID_HUD_PRESETS);

export function isHudPreset(value: unknown): value is HudPreset {
  return typeof value === 'string' && HUD_PRESET_SET.has(value);
}

export function isHudBooleanKey(key: string): key is HudBooleanKey {
  return HUD_BOOLEAN_KEY_SET.has(key);
}

function isValidMaxAgentChips(value: unknown): value is number {
  return isFiniteNum(value) && Number.isInteger(value) && value >= 0 && value <= MAX_AGENT_CHIPS_LIMIT;
}

export function parseHudConfig(raw: Record<string, unknown> | null | undefined, strict: boolean): HudConfig {
  const next: HudConfig = { ...DEFAULT_HUD_CONFIG };
  if (!raw) return next;

  if (raw.preset !== undefined) {
    if (isHudPreset(raw.preset)) {
      next.preset = raw.preset;
    } else if (strict) {
      throw new Error(`Invalid 'preset' in hud-config.json (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
    }
  }

  for (const key of HUD_BOOLEAN_KEYS) {
    const val = raw[key];
    if (val === undefined) continue;
    if (typeof val === 'boolean') {
      next[key] = val;
    } else if (strict) {
      throw new Error(`Invalid boolean '${key}' in hud-config.json`);
    }
  }

  if (raw.maxAgentChips !== undefined) {
    if (isValidMaxAgentChips(raw.maxAgentChips)) {
      next.maxAgentChips = raw.maxAgentChips;
    } else if (strict) {
      throw new Error(`Invalid 'maxAgentChips' in hud-config.json (expected integer 0..${MAX_AGENT_CHIPS_LIMIT})`);
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
