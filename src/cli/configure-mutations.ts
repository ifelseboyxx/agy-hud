import {
  applyHudLineToggle,
  HUD_LINE_IDS,
  HUD_SEGMENT_IDS,
  isHudCostCurrency,
  isHudLineId,
  isHudPreset,
  isHudSegmentId,
  isValidUsdToCnyRate,
  MAX_AGENT_CHIPS_LIMIT,
  MAX_USD_TO_CNY_RATE,
  MIN_USD_TO_CNY_RATE,
  PRESET_TEMPLATES,
  VALID_COST_CURRENCIES,
  VALID_HUD_PRESETS,
} from '../core/hud-config.ts';
import type { HudConfig, HudLineId, HudNarrowOverride, HudPreset } from '../types.ts';

export interface ConfigureMutationInputs {
  preset?: HudPreset;
  enable?: readonly string[];
  disable?: readonly string[];
  order?: readonly string[];
  narrowEnable?: readonly string[];
  narrowDisable?: readonly string[];
  narrowOrder?: readonly string[];
  narrowReset?: boolean;
  sets?: readonly string[];
}

function parseBooleanValue(key: string, rawVal: string): boolean {
  if (rawVal === 'true') return true;
  if (rawVal === 'false') return false;
  throw new Error(`Invalid boolean value '${rawVal}' for '${key}' (expected: true | false)`);
}

function parseMaxAgentChips(rawVal: string): number {
  if (!/^\d+$/.test(rawVal)) {
    throw new Error(`Invalid integer value '${rawVal}' for 'maxAgentChips' (expected: 0..${MAX_AGENT_CHIPS_LIMIT})`);
  }
  const parsed = Number.parseInt(rawVal, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_AGENT_CHIPS_LIMIT) {
    throw new Error(`Out-of-range value '${rawVal}' for 'maxAgentChips' (expected: 0..${MAX_AGENT_CHIPS_LIMIT})`);
  }
  return parsed;
}

function parseUsdToCnyRate(rawVal: string): number {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(rawVal)) {
    throw new Error(
      `Invalid number '${rawVal}' for 'usdToCnyRate' (expected: ${MIN_USD_TO_CNY_RATE}..${MAX_USD_TO_CNY_RATE})`,
    );
  }
  const parsed = Number.parseFloat(rawVal);
  if (!isValidUsdToCnyRate(parsed)) {
    throw new Error(
      `Out-of-range value '${rawVal}' for 'usdToCnyRate' (expected: ${MIN_USD_TO_CNY_RATE}..${MAX_USD_TO_CNY_RATE})`,
    );
  }
  return parsed;
}

function applyPresetSeed(config: HudConfig, preset: HudPreset): void {
  const tpl = PRESET_TEMPLATES[preset];
  config.preset = preset;
  config.lines = [...tpl.lines];
  config.segments = { ...tpl.segments };
}

function parseValidatedLineOrder(orderIds: readonly string[], label: string): HudLineId[] {
  if (orderIds.length === 0) {
    throw new Error(`Empty ${label} list (expected line IDs: ${HUD_LINE_IDS.join(', ')})`);
  }
  const nextLines: HudLineId[] = [];
  const seen = new Set<HudLineId>();
  for (const rawId of orderIds) {
    const id = rawId.trim();
    if (!isHudLineId(id)) {
      throw new Error(`Invalid line ID '${id}' for ${label} (expected: ${HUD_LINE_IDS.join(' | ')})`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      nextLines.push(id);
    }
  }
  return nextLines;
}

function pruneEmptyNarrow(config: HudConfig): void {
  const n = config.narrow;
  if (!n) return;
  if (n.segments !== undefined && Object.keys(n.segments).length === 0) {
    delete n.segments;
  }
  if (n.lines === undefined && n.segments === undefined) {
    delete config.narrow;
  }
}

function ensureNarrow(config: HudConfig): HudNarrowOverride {
  if (config.narrow === undefined) {
    config.narrow = {};
  }
  return config.narrow;
}

function applyModuleToggle(config: HudConfig, rawId: string, enabled: boolean): void {
  const id = rawId.trim();
  if (isHudLineId(id)) {
    config.lines = applyHudLineToggle(config.lines, id, enabled);
    return;
  }
  const segId = id.startsWith('segments.') ? id.slice('segments.'.length) : id;
  if (isHudSegmentId(segId)) {
    config.segments[segId] = enabled;
    return;
  }
  throw new Error(
    `Unknown module or segment '${id}'. Valid lines: ${HUD_LINE_IDS.join(', ')}; valid segments: ${HUD_SEGMENT_IDS.join(', ')}`,
  );
}

function applyNarrowModuleToggle(config: HudConfig, rawId: string, enabled: boolean): void {
  const id = rawId.trim();
  if (isHudLineId(id)) {
    const narrow = ensureNarrow(config);
    const seed = narrow.lines ?? config.lines;
    narrow.lines = applyHudLineToggle(seed, id, enabled);
    return;
  }
  const segId = id.startsWith('segments.') ? id.slice('segments.'.length) : id;
  if (isHudSegmentId(segId)) {
    const narrow = ensureNarrow(config);
    narrow.segments = { ...narrow.segments, [segId]: enabled };
    return;
  }
  throw new Error(
    `Unknown narrow module or segment '${id}'. Valid lines: ${HUD_LINE_IDS.join(', ')}; valid segments: ${HUD_SEGMENT_IDS.join(', ')}`,
  );
}

function applyNarrowSetAssignment(config: HudConfig, key: string, rawVal: string): boolean {
  if (key === 'narrow.lines') {
    if (rawVal === 'inherit') {
      if (config.narrow !== undefined) {
        delete config.narrow.lines;
        pruneEmptyNarrow(config);
      }
      return true;
    }
    const items = rawVal.split(',').map((part) => part.trim());
    if (items.some((item) => item.length === 0)) {
      throw new Error(`Empty list entry in narrow.lines value '${rawVal}'`);
    }
    const narrow = ensureNarrow(config);
    narrow.lines = parseValidatedLineOrder(items, 'narrow.lines');
    return true;
  }
  if (key.startsWith('narrow.segments.')) {
    const segKey = key.slice('narrow.segments.'.length);
    if (!isHudSegmentId(segKey)) {
      throw new Error(`Unknown segment ID '${segKey}' for '${key}' (expected: ${HUD_SEGMENT_IDS.join(' | ')})`);
    }
    if (rawVal === 'inherit') {
      if (config.narrow?.segments !== undefined) {
        delete config.narrow.segments[segKey];
        pruneEmptyNarrow(config);
      }
      return true;
    }
    const narrow = ensureNarrow(config);
    narrow.segments = { ...narrow.segments, [segKey]: parseBooleanValue(key, rawVal) };
    return true;
  }
  return false;
}

function applySetAssignment(config: HudConfig, expr: string): void {
  const eqIdx = expr.indexOf('=');
  if (eqIdx <= 0 || eqIdx === expr.length - 1) {
    throw new Error(`Invalid --set expression '${expr}' (expected <key>=<value>)`);
  }
  const key = expr.slice(0, eqIdx).trim();
  const rawVal = expr.slice(eqIdx + 1).trim();
  if (key.length === 0 || rawVal.length === 0) {
    throw new Error(`Invalid --set expression '${expr}' (expected non-empty <key>=<value>)`);
  }

  if (key === 'preset') {
    if (!isHudPreset(rawVal)) {
      throw new Error(`Invalid preset '${rawVal}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
    }
    applyPresetSeed(config, rawVal);
    return;
  }
  if (key === 'maxAgentChips') {
    config.maxAgentChips = parseMaxAgentChips(rawVal);
    return;
  }
  if (key === 'osc8Links') {
    config.osc8Links = parseBooleanValue(key, rawVal);
    return;
  }
  if (key === 'costCurrency') {
    if (!isHudCostCurrency(rawVal)) {
      throw new Error(`Invalid costCurrency '${rawVal}' (expected: ${VALID_COST_CURRENCIES.join(' | ')})`);
    }
    config.costCurrency = rawVal;
    return;
  }
  if (key === 'usdToCnyRate') {
    config.usdToCnyRate = parseUsdToCnyRate(rawVal);
    return;
  }
  if (applyNarrowSetAssignment(config, key, rawVal)) {
    return;
  }
  if (key.startsWith('segments.')) {
    const segKey = key.slice('segments.'.length);
    if (isHudSegmentId(segKey)) {
      config.segments[segKey] = parseBooleanValue(key, rawVal);
      return;
    }
  }
  if (isHudSegmentId(key)) {
    config.segments[key] = parseBooleanValue(key, rawVal);
    return;
  }

  const validKeys = [
    'preset',
    'maxAgentChips',
    'osc8Links',
    'costCurrency',
    'usdToCnyRate',
    'narrow.lines',
    ...HUD_SEGMENT_IDS.map((id) => `segments.${id}`),
    ...HUD_SEGMENT_IDS.map((id) => `narrow.segments.${id}`),
  ].join(', ');
  throw new Error(`Unknown configuration key '${key}'. Valid keys: ${validKeys}`);
}

export function applyConfigureMutations(config: HudConfig, options: ConfigureMutationInputs): void {
  if (options.preset !== undefined) {
    if (!isHudPreset(options.preset)) {
      throw new Error(`Invalid preset '${String(options.preset)}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
    }
    applyPresetSeed(config, options.preset);
  }
  if (options.order !== undefined) {
    config.lines = parseValidatedLineOrder(options.order, '--order');
  }
  for (const id of options.enable ?? []) {
    applyModuleToggle(config, id, true);
  }
  for (const id of options.disable ?? []) {
    applyModuleToggle(config, id, false);
  }
  if (options.narrowReset) {
    delete config.narrow;
  }
  if (options.narrowOrder !== undefined) {
    const narrow = ensureNarrow(config);
    narrow.lines = parseValidatedLineOrder(options.narrowOrder, '--narrow-order');
  }
  for (const id of options.narrowEnable ?? []) {
    applyNarrowModuleToggle(config, id, true);
  }
  for (const id of options.narrowDisable ?? []) {
    applyNarrowModuleToggle(config, id, false);
  }
  for (const expr of options.sets ?? []) {
    applySetAssignment(config, expr);
  }
  pruneEmptyNarrow(config);
}
