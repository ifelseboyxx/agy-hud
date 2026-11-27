import path from 'node:path';

import { DEFAULT_CLI_LOCK_TIMEOUT_MS, withCliHomeLockSync } from '../core/file-lock.ts';
import {
  hasDanglingSymlinkInChainSync,
  readJsonObjectSync,
  readJsonObjectWithHashSync,
  writeJsonAtomicSync,
} from '../core/fs-utils.ts';
import {
  buildPresetConfig,
  cloneHudConfig,
  DEFAULT_HUD_CONFIG,
  hydrateHudConfig,
  isHudPreset,
  VALID_HUD_PRESETS,
} from '../core/hud-config.ts';
import { resolveCliHome } from '../core/paths.ts';
import type { ConfigureHudOptions, ConfigureHudResult, HudConfig, HudPreset } from '../types.ts';
import { applyConfigureMutations } from './configure-mutations.ts';

export interface ConfigureCliArgs {
  help: boolean;
  json: boolean;
  interactive: boolean;
  options: ConfigureHudOptions;
}

const MISSING_HUD_CONFIG_VERSION = 'missing';

export class HudConfigConflictError extends Error {
  readonly configPath: string;

  constructor(configPath: string) {
    super(
      `Configuration file ${configPath} was modified concurrently; existing changes were preserved. Reopen interactive configure to apply updates.`,
    );
    this.name = 'HudConfigConflictError';
    this.configPath = configPath;
  }
}

export interface InteractiveDraftSession {
  readonly configPath: string;
  readonly config: HudConfig;
  readonly version: string;
}

function readConfigWithVersionSync(configPath: string): { raw: Record<string, unknown> | null; version: string } {
  const loaded = readJsonObjectWithHashSync(configPath, true);
  return loaded !== null
    ? { raw: loaded.raw, version: loaded.sha256 }
    : { raw: null, version: MISSING_HUD_CONFIG_VERSION };
}

export function loadInteractiveDraftSession(options: ConfigureHudOptions = {}): InteractiveDraftSession {
  const env = options.env ?? process.env;
  const cliHome = resolveCliHome(options.cliHome, env);
  const configPath = path.join(cliHome, 'hud-config.json');
  const { raw: existingRaw, version } = readConfigWithVersionSync(configPath);
  const base = options.reset ? buildPresetConfig(DEFAULT_HUD_CONFIG.preset) : hydrateHudConfig(existingRaw);
  const next = cloneHudConfig(base);
  applyConfigureMutations(next, options);
  return { configPath, config: next, version };
}

export function writeHudConfigAtomic(
  config: HudConfig,
  options: { readonly cliHome?: string; readonly env?: NodeJS.ProcessEnv; readonly expectedVersion?: string } = {},
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
      // Re-validate existing file and draft version under the lock so corrupted JSON or concurrent writes are preserved.
      const current = readConfigWithVersionSync(configPath);
      if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
        throw new HudConfigConflictError(configPath);
      }
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
  const narrowEnable = options.narrowEnable ?? [];
  const narrowDisable = options.narrowDisable ?? [];
  const sets = options.sets ?? [];
  const hasPreset = options.preset !== undefined;
  const hasOrder = options.order !== undefined;
  const hasNarrowOrder = options.narrowOrder !== undefined;
  const hasMutations =
    Boolean(options.reset) ||
    Boolean(options.narrowReset) ||
    hasPreset ||
    hasOrder ||
    hasNarrowOrder ||
    enable.length > 0 ||
    disable.length > 0 ||
    narrowEnable.length > 0 ||
    narrowDisable.length > 0 ||
    sets.length > 0;

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
  const narrowEnable: string[] = [];
  const narrowDisable: string[] = [];
  let narrowOrder: string[] | undefined;
  let narrowReset = false;
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
    } else if (arg === '--narrow-enable') {
      narrowEnable.push(...parseCsvIdList(readOptionValue(argv, i, '--narrow-enable'), '--narrow-enable'));
      i += 1;
    } else if (arg.startsWith('--narrow-enable=')) {
      narrowEnable.push(...parseCsvIdList(arg.slice('--narrow-enable='.length), '--narrow-enable='));
    } else if (arg === '--narrow-disable') {
      narrowDisable.push(...parseCsvIdList(readOptionValue(argv, i, '--narrow-disable'), '--narrow-disable'));
      i += 1;
    } else if (arg.startsWith('--narrow-disable=')) {
      narrowDisable.push(...parseCsvIdList(arg.slice('--narrow-disable='.length), '--narrow-disable='));
    } else if (arg === '--narrow-order') {
      narrowOrder = parseCsvIdList(readOptionValue(argv, i, '--narrow-order'), '--narrow-order');
      i += 1;
    } else if (arg.startsWith('--narrow-order=')) {
      narrowOrder = parseCsvIdList(arg.slice('--narrow-order='.length), '--narrow-order=');
    } else if (arg === '--narrow-reset') {
      narrowReset = true;
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
  if (narrowEnable.length > 0) {
    options.narrowEnable = narrowEnable;
  }
  if (narrowDisable.length > 0) {
    options.narrowDisable = narrowDisable;
  }
  if (narrowOrder !== undefined) {
    options.narrowOrder = narrowOrder;
  }
  if (narrowReset) {
    options.narrowReset = true;
  }
  return { help, json, interactive, options };
}
