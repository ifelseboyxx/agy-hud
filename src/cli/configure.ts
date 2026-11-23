import path from 'node:path';

import { DEFAULT_CLI_LOCK_TIMEOUT_MS, withCliHomeLockSync } from '../core/file-lock.ts';
import {
  HUD_BOOLEAN_KEYS,
  hydrateHudConfig,
  isHudBooleanKey,
  isHudPreset,
  MAX_AGENT_CHIPS_LIMIT,
  VALID_HUD_PRESETS,
  type HudBooleanKey,
} from '../core/hud-config.ts';
import { resolveCliHome } from '../core/paths.ts';
import { hasDanglingSymlinkInChainSync, readJsonObjectSync, writeJsonAtomicSync } from '../fs-utils.ts';
import { DEFAULT_HUD_CONFIG, type HudConfig, type HudPreset } from '../types.ts';

export {
  HUD_BOOLEAN_KEYS,
  hydrateHudConfig,
  isHudPreset,
  MAX_AGENT_CHIPS_LIMIT,
  VALID_HUD_PRESETS,
  type HudBooleanKey,
};

export interface ConfigureHudOptions {
  cliHome?: string;
  show?: boolean;
  preset?: HudPreset;
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
    config.preset = rawVal;
    return;
  }

  if (key === 'maxAgentChips') {
    config.maxAgentChips = parseMaxAgentChips(rawVal);
    return;
  }

  if (isHudBooleanKey(key)) {
    config[key] = parseBooleanValue(key, rawVal);
    return;
  }

  const validKeys = ['preset', ...HUD_BOOLEAN_KEYS, 'maxAgentChips'].join(', ');
  throw new Error(`Unknown configuration key '${key}'. Valid keys: ${validKeys}`);
}

export function configureHud(options: ConfigureHudOptions = {}): ConfigureHudResult {
  const env = options.env ?? process.env;
  const cliHome = resolveCliHome(options.cliHome, env);
  const configPath = path.join(cliHome, 'hud-config.json');

  const sets = options.sets ?? [];
  const hasPreset = options.preset !== undefined;
  const hasMutations = Boolean(options.reset) || hasPreset || sets.length > 0;

  if (hasPreset && !isHudPreset(options.preset)) {
    throw new Error(`Invalid preset '${String(options.preset)}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
  }

  if (!hasMutations) {
    const current = hydrateHudConfig(readJsonObjectSync(configPath, true));
    return { configPath, config: current, changed: false, action: 'show' };
  }

  // Validate assignments upfront before creating cliHome or acquiring the lock.
  const scratch: HudConfig = { ...DEFAULT_HUD_CONFIG };
  for (const expr of sets) {
    applySetAssignment(scratch, expr);
  }
  if (hasDanglingSymlinkInChainSync(cliHome)) {
    throw new Error(`Failed to read ${configPath}: dangling symbolic link`);
  }

  return withCliHomeLockSync(
    cliHome,
    () => {
      const existingRaw = readJsonObjectSync(configPath, true);
      const base = options.reset ? { ...DEFAULT_HUD_CONFIG } : hydrateHudConfig(existingRaw);
      const next: HudConfig = { ...base };

      if (options.preset !== undefined) {
        next.preset = options.preset;
      }
      for (const expr of sets) {
        applySetAssignment(next, expr);
      }

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
  if (!val || val.startsWith('-')) {
    throw new Error(`Missing value after ${flag}`);
  }
  return val;
}

export function parseConfigureArgs(argv: readonly string[]): ConfigureCliArgs {
  let help = false;
  let json = false;
  let show = false;
  let reset = false;
  let preset: HudPreset | undefined;
  const sets: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--show') {
      show = true;
    } else if (arg === '--reset') {
      reset = true;
    } else if (arg === '--preset') {
      const raw = readOptionValue(argv, i, '--preset');
      if (!isHudPreset(raw)) {
        throw new Error(`Invalid preset '${raw}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
      }
      preset = raw;
      i += 1;
    } else if (arg.startsWith('--preset=')) {
      const raw = arg.slice('--preset='.length);
      if (!isHudPreset(raw)) {
        throw new Error(`Invalid preset '${raw}' (expected: ${VALID_HUD_PRESETS.join(' | ')})`);
      }
      preset = raw;
    } else if (arg === '--set') {
      sets.push(readOptionValue(argv, i, '--set'));
      i += 1;
    } else if (arg.startsWith('--set=')) {
      sets.push(arg.slice('--set='.length));
    } else {
      throw new Error(`Unknown configure option: ${arg}`);
    }
  }

  const options: ConfigureHudOptions = { show, reset, sets };
  if (preset !== undefined) {
    options.preset = preset;
  }
  return { help, json, options };
}
