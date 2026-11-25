import path from 'node:path';

import { DEFAULT_CLI_LOCK_TIMEOUT_MS, withCliHomeLockSync } from '../core/file-lock.ts';
import {
  applyHudLineToggle,
  buildPresetConfig,
  cloneHudConfig,
  HUD_LINE_IDS,
  HUD_SEGMENT_IDS,
  hydrateHudConfig,
  isHudLineId,
  isHudPreset,
  isHudSegmentId,
  MAX_AGENT_CHIPS_LIMIT,
  PRESET_TEMPLATES,
  VALID_HUD_PRESETS,
} from '../core/hud-config.ts';
import { resolveCliHome } from '../core/paths.ts';
import { hasDanglingSymlinkInChainSync, readJsonObjectSync, writeJsonAtomicSync } from '../fs-utils.ts';
import { DEFAULT_HUD_CONFIG, type HudConfig, type HudLineId, type HudPreset } from '../types.ts';

export {
  HUD_LINE_IDS,
  HUD_SEGMENT_IDS,
  hydrateHudConfig,
  isHudPreset,
  MAX_AGENT_CHIPS_LIMIT,
  PRESET_TEMPLATES,
  VALID_HUD_PRESETS,
};

export interface ConfigureHudOptions {
  cliHome?: string;
  show?: boolean;
  interactive?: boolean;
  preset?: HudPreset;
  enable?: readonly string[];
  disable?: readonly string[];
  order?: readonly string[];
  sets?: readonly string[];
  reset?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ConfigureHudResult {
  configPath: string;
  config: HudConfig;
  changed: boolean;
  action: 'show' | 'reset' | 'update';
}

export interface ConfigureCliArgs {
  help: boolean;
  json: boolean;
  interactive: boolean;
  options: ConfigureHudOptions;
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

function applyPresetSeed(config: HudConfig, preset: HudPreset): void {
  const tpl = PRESET_TEMPLATES[preset];
  config.preset = preset;
  config.lines = [...tpl.lines];
  config.segments = { ...tpl.segments };
}

function applyOrderList(config: HudConfig, orderIds: readonly string[]): void {
  if (orderIds.length === 0) {
    throw new Error(`Empty --order list (expected line IDs: ${HUD_LINE_IDS.join(', ')})`);
  }
  const nextLines: HudLineId[] = [];
  const seen = new Set<HudLineId>();
  for (const rawId of orderIds) {
    const id = rawId.trim();
    if (!isHudLineId(id)) {
      throw new Error(`Invalid line ID '${id}' for --order (expected: ${HUD_LINE_IDS.join(' | ')})`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      nextLines.push(id);
    }
  }
  config.lines = nextLines;
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

  const validKeys = ['preset', 'maxAgentChips', 'osc8Links', ...HUD_SEGMENT_IDS.map((id) => `segments.${id}`)].join(
    ', ',
  );
  throw new Error(`Unknown configuration key '${key}'. Valid keys: ${validKeys}`);
}

function applyConfigureMutations(config: HudConfig, options: ConfigureHudOptions): void {
  if (options.preset !== undefined) {
    if (!isHudPreset(options.preset)) {
      throw new Error(`Invalid preset '${String(options.preset)}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
    }
    applyPresetSeed(config, options.preset);
  }
  if (options.order !== undefined) {
    applyOrderList(config, options.order);
  }
  for (const id of options.enable ?? []) {
    applyModuleToggle(config, id, true);
  }
  for (const id of options.disable ?? []) {
    applyModuleToggle(config, id, false);
  }
  for (const expr of options.sets ?? []) {
    applySetAssignment(config, expr);
  }
}

export function loadInteractiveDraftConfig(options: ConfigureHudOptions = {}): HudConfig {
  const env = options.env ?? process.env;
  const cliHome = resolveCliHome(options.cliHome, env);
  const configPath = path.join(cliHome, 'hud-config.json');
  const existingRaw = readJsonObjectSync(configPath, true);
  const base = options.reset ? buildPresetConfig(DEFAULT_HUD_CONFIG.preset) : hydrateHudConfig(existingRaw);
  const next = cloneHudConfig(base);
  applyConfigureMutations(next, options);
  return next;
}

export function writeHudConfigAtomic(
  config: HudConfig,
  options: { readonly cliHome?: string; readonly env?: NodeJS.ProcessEnv } = {},
): ConfigureHudResult {
  const env = options.env ?? process.env;
  const cliHome = resolveCliHome(options.cliHome, env);
  const configPath = path.join(cliHome, 'hud-config.json');

  if (hasDanglingSymlinkInChainSync(cliHome)) {
    throw new Error(`Failed to read ${configPath}: dangling symbolic link`);
  }

  return withCliHomeLockSync(
    cliHome,
    () => {
      // Re-validate existing file under the lock so corrupted JSON is never overwritten.
      readJsonObjectSync(configPath, true);
      const next = cloneHudConfig(config);
      writeJsonAtomicSync(configPath, next);
      return {
        configPath,
        config: next,
        changed: true,
        action: 'update',
      };
    },
    DEFAULT_CLI_LOCK_TIMEOUT_MS,
  );
}

export function configureHud(options: ConfigureHudOptions = {}): ConfigureHudResult {
  const env = options.env ?? process.env;
  const cliHome = resolveCliHome(options.cliHome, env);
  const configPath = path.join(cliHome, 'hud-config.json');

  const enable = options.enable ?? [];
  const disable = options.disable ?? [];
  const sets = options.sets ?? [];
  const hasPreset = options.preset !== undefined;
  const hasOrder = options.order !== undefined;
  const hasMutations =
    Boolean(options.reset) || hasPreset || hasOrder || enable.length > 0 || disable.length > 0 || sets.length > 0;

  if (!hasMutations) {
    const current = hydrateHudConfig(readJsonObjectSync(configPath, true));
    return { configPath, config: current, changed: false, action: 'show' };
  }

  // Validate all mutations upfront before creating cliHome or acquiring the lock.
  const scratch = buildPresetConfig(DEFAULT_HUD_CONFIG.preset);
  applyConfigureMutations(scratch, options);

  if (hasDanglingSymlinkInChainSync(cliHome)) {
    throw new Error(`Failed to read ${configPath}: dangling symbolic link`);
  }

  return withCliHomeLockSync(
    cliHome,
    () => {
      const existingRaw = readJsonObjectSync(configPath, true);
      const base = options.reset ? buildPresetConfig(DEFAULT_HUD_CONFIG.preset) : hydrateHudConfig(existingRaw);
      const next = cloneHudConfig(base);
      applyConfigureMutations(next, options);

      writeJsonAtomicSync(configPath, next);
      return {
        configPath,
        config: next,
        changed: true,
        action: options.reset ? 'reset' : 'update',
      };
    },
    DEFAULT_CLI_LOCK_TIMEOUT_MS,
  );
}

function readOptionValue(argv: readonly string[], index: number, flag: string): string {
  const val = argv[index + 1];
  if (val === undefined || val.startsWith('-')) {
    throw new Error(`Missing value after ${flag}`);
  }
  return val;
}

function parseCsvIdList(raw: string, flag: string): string[] {
  if (raw.trim().length === 0) {
    throw new Error(`Empty value after ${flag}`);
  }
  const items = raw.split(',').map((part) => part.trim());
  if (items.some((item) => item.length === 0)) {
    throw new Error(`Empty list entry in ${flag} value '${raw}'`);
  }
  return items;
}

export function parseConfigureArgs(argv: readonly string[]): ConfigureCliArgs {
  let help = false;
  let json = false;
  let interactive = false;
  let show = false;
  let reset = false;
  let preset: HudPreset | undefined;
  const enable: string[] = [];
  const disable: string[] = [];
  let order: string[] | undefined;
  const sets: string[] = [];

  const setPresetValue = (raw: string): void => {
    if (!isHudPreset(raw)) {
      throw new Error(`Invalid preset '${raw}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
    }
    if (preset !== undefined) {
      throw new Error(`Duplicate preset '${raw}' (preset '${preset}' was already specified)`);
    }
    preset = raw;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '-i' || arg === '--interactive') {
      interactive = true;
    } else if (arg === '--show') {
      show = true;
    } else if (arg === '--reset') {
      reset = true;
    } else if (arg === '--preset') {
      setPresetValue(readOptionValue(argv, i, '--preset'));
      i += 1;
    } else if (arg.startsWith('--preset=')) {
      setPresetValue(arg.slice('--preset='.length));
    } else if (arg === '--enable') {
      enable.push(...parseCsvIdList(readOptionValue(argv, i, '--enable'), '--enable'));
      i += 1;
    } else if (arg.startsWith('--enable=')) {
      enable.push(...parseCsvIdList(arg.slice('--enable='.length), '--enable='));
    } else if (arg === '--disable') {
      disable.push(...parseCsvIdList(readOptionValue(argv, i, '--disable'), '--disable'));
      i += 1;
    } else if (arg.startsWith('--disable=')) {
      disable.push(...parseCsvIdList(arg.slice('--disable='.length), '--disable='));
    } else if (arg === '--order') {
      order = parseCsvIdList(readOptionValue(argv, i, '--order'), '--order');
      i += 1;
    } else if (arg.startsWith('--order=')) {
      order = parseCsvIdList(arg.slice('--order='.length), '--order=');
    } else if (arg === '--set') {
      sets.push(readOptionValue(argv, i, '--set'));
      i += 1;
    } else if (arg.startsWith('--set=')) {
      sets.push(arg.slice('--set='.length));
    } else if (!arg.startsWith('-') && isHudPreset(arg)) {
      setPresetValue(arg);
    } else {
      throw new Error(`Unknown configure option: ${arg}`);
    }
  }

  const options: ConfigureHudOptions = { show, reset, sets };
  if (interactive) {
    options.interactive = true;
  }
  if (preset !== undefined) {
    options.preset = preset;
  }
  if (enable.length > 0) {
    options.enable = enable;
  }
  if (disable.length > 0) {
    options.disable = disable;
  }
  if (order !== undefined) {
    options.order = order;
  }
  return { help, json, interactive, options };
}
