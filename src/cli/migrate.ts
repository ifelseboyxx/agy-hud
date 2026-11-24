import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CLI_LOCK_TIMEOUT_MS,
  getCliHomeLockPath,
  getMcpConfigLockPath,
  withFileLocksSync,
} from '../core/file-lock.ts';
import { isPlainObject } from '../core/guards.ts';
import { hydrateHudConfig } from '../core/hud-config.ts';
import { expandHome, resolveProfileRoots } from '../core/paths.ts';
import {
  hasDanglingSymlinkInChainSync as hasDanglingSymlinkInChain,
  lstatIfPresentSync as lstatIfPresent,
  readJsonObjectSync as readJsonObject,
} from '../fs-utils.ts';
import { assertNoExportPathOverlap, commitPlannedOps, type PlannedOp } from './file-transaction.ts';
import {
  cloneRecord,
  cloneValue,
  sanitizeConfigTemplate,
  sanitizeHudConfigTemplate,
  sanitizeMcpConfigTemplate,
  sanitizeRepoUrl,
  sanitizeSettingsTemplate,
  sanitizeStringValue,
  UNSAFE_KEYS,
} from './sanitize.ts';

export { commitPlannedOps, type PlannedOp };

export interface ExportProfileOptions {
  outDir: string;
  cliHome?: string;
  geminiRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExportedPluginEntry {
  dir: string;
  name: string;
  version?: string;
  repo?: string;
  enabled?: boolean;
  marketplace?: string;
  pluginId?: string;
}

export interface PluginsManifest {
  exportedAt: string;
  plugins: ExportedPluginEntry[];
}

export interface ExportProfileResult {
  outDir: string;
  filesWritten: string[];
  pluginCount: number;
  skippedMissing: string[];
}

export interface ImportProfileOptions {
  inDir: string;
  cliHome?: string;
  geminiRoot?: string;
  mergeMcp?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type ImportMcpAction = 'none' | 'created' | 'merged' | 'skipped-exists';

export interface ImportProfileResult {
  inDir: string;
  cliHome: string;
  geminiRoot: string;
  filesUpdated: string[];
  mcpAction: ImportMcpAction;
  pluginInstructions: string[];
}

function extractRepoUrl(pluginJson: Record<string, unknown>): string | undefined {
  if (typeof pluginJson.repository === 'string') {
    const sanitized = sanitizeRepoUrl(pluginJson.repository);
    if (sanitized) return sanitized;
  }
  if (isPlainObject(pluginJson.repository) && typeof pluginJson.repository.url === 'string') {
    const sanitized = sanitizeRepoUrl(pluginJson.repository.url);
    if (sanitized) return sanitized;
  }
  if (typeof pluginJson.homepage === 'string') {
    const sanitized = sanitizeRepoUrl(pluginJson.homepage);
    if (sanitized) return sanitized;
  }
  return undefined;
}

function collectPluginsManifest(geminiRoot: string, configObj: Record<string, unknown> | null): PluginsManifest {
  const pluginsDir = path.join(geminiRoot, 'config', 'plugins');
  const plugins: ExportedPluginEntry[] = [];
  if (!existsSync(pluginsDir)) {
    return { exportedAt: new Date().toISOString(), plugins };
  }

  const configPlugins = configObj && isPlainObject(configObj.plugins) ? configObj.plugins : null;
  const entries = readdirSync(pluginsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifestPath = path.join(pluginsDir, entry.name, 'plugin.json');
    const pluginJson = readJsonObject(manifestPath, false);
    if (!pluginJson) continue;

    const rawName = typeof pluginJson.name === 'string' ? pluginJson.name.trim() : '';
    const item: ExportedPluginEntry = {
      dir: entry.name,
      name: rawName.length > 0 ? rawName : entry.name,
    };

    const rawCfgEntry = configPlugins?.[entry.name];
    const cfgEntry = isPlainObject(rawCfgEntry) ? rawCfgEntry : null;
    const rawInstalledFrom = cfgEntry?.installedFrom;
    const installedFrom = isPlainObject(rawInstalledFrom) ? rawInstalledFrom : null;

    if (typeof pluginJson.version === 'string' && pluginJson.version.trim().length > 0) {
      item.version = pluginJson.version.trim();
    } else if (installedFrom && typeof installedFrom.version === 'string' && installedFrom.version.trim().length > 0) {
      item.version = installedFrom.version.trim();
    }

    const repo = extractRepoUrl(pluginJson);
    if (repo) item.repo = repo;
    if (cfgEntry && typeof cfgEntry.enabled === 'boolean') item.enabled = cfgEntry.enabled;
    if (installedFrom && typeof installedFrom.marketplace === 'string' && installedFrom.marketplace.trim().length > 0) {
      item.marketplace = sanitizeStringValue(installedFrom.marketplace.trim());
    }
    if (installedFrom && typeof installedFrom.id === 'string' && installedFrom.id.trim().length > 0) {
      item.pluginId = sanitizeStringValue(installedFrom.id.trim());
    }

    plugins.push(item);
  }

  return { exportedAt: new Date().toISOString(), plugins };
}

export function exportProfile(options: ExportProfileOptions): ExportProfileResult {
  const outDirRaw = options.outDir.trim();
  if (outDirRaw.length === 0) {
    throw new Error('Missing output directory (--out <dir>)');
  }
  const env = options.env ?? process.env;
  const outDir = path.resolve(expandHome(outDirRaw, env));
  const { cliHome, geminiRoot } = resolveProfileRoots(options.cliHome, options.geminiRoot, env);

  const settingsSrc = path.join(cliHome, 'settings.json');
  const configSrc = path.join(geminiRoot, 'config', 'config.json');
  const mcpSrc = path.join(geminiRoot, 'config', 'mcp_config.json');
  const hudSrc = path.join(cliHome, 'hud-config.json');
  const manifestOut = path.join(outDir, 'plugins-manifest.json');
  assertNoExportPathOverlap(
    [settingsSrc, configSrc, mcpSrc, hudSrc],
    [
      path.join(outDir, 'settings.template.json'),
      path.join(outDir, 'config.template.json'),
      path.join(outDir, 'mcp_config.template.json'),
      path.join(outDir, 'hud-config.json'),
      manifestOut,
    ],
  );

  const runExport = (): ExportProfileResult => {
    const planned: PlannedOp[] = [];
    const skippedMissing: string[] = [];

    const planOptional = (
      srcPath: string,
      outFile: string,
      sanitizer: (raw: Record<string, unknown>) => Record<string, unknown>,
    ): Record<string, unknown> | null => {
      const outPath = path.join(outDir, outFile);
      const obj = readJsonObject(srcPath, true);
      if (obj) {
        planned.push({ kind: 'write', filePath: outPath, payload: sanitizer(obj) });
        return obj;
      }
      skippedMissing.push(srcPath);
      if (lstatIfPresent(outPath) !== null) {
        planned.push({ kind: 'delete', filePath: outPath });
      }
      return null;
    };

    planOptional(settingsSrc, 'settings.template.json', sanitizeSettingsTemplate);
    const configObj = planOptional(configSrc, 'config.template.json', sanitizeConfigTemplate);
    planOptional(mcpSrc, 'mcp_config.template.json', sanitizeMcpConfigTemplate);
    planOptional(hudSrc, 'hud-config.json', sanitizeHudConfigTemplate);

    const manifest = collectPluginsManifest(geminiRoot, configObj);
    planned.push({ kind: 'write', filePath: manifestOut, payload: manifest });

    const filesWritten = commitPlannedOps(planned);
    return {
      outDir,
      filesWritten,
      pluginCount: manifest.plugins.length,
      skippedMissing,
    };
  };

  const exportLocks: string[] = [];
  if (!hasDanglingSymlinkInChain(cliHome) && existsSync(cliHome) && statSync(cliHome).isDirectory()) {
    exportLocks.push(getCliHomeLockPath(cliHome));
  }
  if (!hasDanglingSymlinkInChain(geminiRoot) && existsSync(geminiRoot) && statSync(geminiRoot).isDirectory()) {
    exportLocks.push(getMcpConfigLockPath(geminiRoot));
  }
  return exportLocks.length > 0 ? withFileLocksSync(exportLocks, runExport, DEFAULT_CLI_LOCK_TIMEOUT_MS) : runExport();
}

function deepMergeObjects(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const result = cloneRecord(base);
  for (const [key, val] of Object.entries(incoming)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const existingVal = result[key];
    if (isPlainObject(existingVal) && isPlainObject(val)) {
      result[key] = deepMergeObjects(existingVal, val);
    } else {
      result[key] = cloneValue(val);
    }
  }
  return result;
}

function mergeMcpConfigs(
  existing: Record<string, unknown>,
  template: Record<string, unknown>,
): Record<string, unknown> {
  const result = cloneRecord(existing);
  const existingServers = isPlainObject(result.mcpServers) ? cloneRecord(result.mcpServers) : {};
  if (isPlainObject(template.mcpServers)) {
    for (const [name, serverDef] of Object.entries(template.mcpServers)) {
      if (UNSAFE_KEYS.has(name) || Object.hasOwn(existingServers, name)) continue;
      existingServers[name] = cloneValue(serverDef);
    }
    result.mcpServers = existingServers;
  }

  for (const [key, val] of Object.entries(template)) {
    if (key === 'mcpServers' || UNSAFE_KEYS.has(key) || Object.hasOwn(result, key)) continue;
    result[key] = cloneValue(val);
  }
  return result;
}

function formatPluginInstructions(
  inDir: string,
  geminiRoot: string,
  manifestObj: Record<string, unknown> | null,
): string[] {
  const instructions: string[] = [];
  const rawPlugins = manifestObj && Array.isArray(manifestObj.plugins) ? manifestObj.plugins : [];

  for (const rawEntry of rawPlugins) {
    if (!isPlainObject(rawEntry)) continue;
    const dir = typeof rawEntry.dir === 'string' ? rawEntry.dir.trim() : '';
    const name = typeof rawEntry.name === 'string' ? rawEntry.name.trim() : dir;
    if (dir.length === 0 || name.length === 0) continue;

    const version =
      typeof rawEntry.version === 'string' && rawEntry.version.trim().length > 0 ? ` v${rawEntry.version.trim()}` : '';
    const pluginId =
      typeof rawEntry.pluginId === 'string' && rawEntry.pluginId.trim().length > 0
        ? rawEntry.pluginId.trim()
        : undefined;
    const repo =
      typeof rawEntry.repo === 'string' && rawEntry.repo.trim().length > 0 ? rawEntry.repo.trim() : undefined;
    const installArg = pluginId ?? repo ?? name;

    instructions.push(
      `Plugin [${name}](customization://${dir})${version}: run \`agy plugin install ${installArg}\` or manage at customization://${dir}`,
    );
  }

  const configTemplatePath = path.join(inDir, 'config.template.json');
  if (existsSync(configTemplatePath)) {
    const liveConfigPath = path.join(geminiRoot, 'config', 'config.json');
    instructions.push(
      `Note: ${liveConfigPath} was NOT modified automatically; inspect ${configTemplatePath} for manual userSettings reference.`,
    );
  }

  return instructions;
}

export function importProfile(options: ImportProfileOptions): ImportProfileResult {
  const inDirRaw = options.inDir.trim();
  if (inDirRaw.length === 0) {
    throw new Error('Missing input directory (--in <dir>)');
  }
  const env = options.env ?? process.env;
  const inDir = path.resolve(expandHome(inDirRaw, env));
  if (!existsSync(inDir) || !statSync(inDir).isDirectory()) {
    throw new Error(`Profile input directory not found: ${inDir}`);
  }

  const { cliHome, geminiRoot } = resolveProfileRoots(options.cliHome, options.geminiRoot, env);

  // Phase 1: strictly read and validate all input templates before creating any target directory or lock.
  const settingsTemplate = readJsonObject(path.join(inDir, 'settings.template.json'), true);
  const hudTemplate = readJsonObject(path.join(inDir, 'hud-config.json'), true);
  const mcpTemplate = readJsonObject(path.join(inDir, 'mcp_config.template.json'), true);
  const manifestTemplate = readJsonObject(path.join(inDir, 'plugins-manifest.json'), true);
  readJsonObject(path.join(inDir, 'config.template.json'), true);

  const sanitizedSettingsIncoming = settingsTemplate ? sanitizeSettingsTemplate(settingsTemplate) : null;
  const sanitizedHudIncoming = hudTemplate ? sanitizeHudConfigTemplate(hudTemplate) : null;
  if (sanitizedHudIncoming !== null) {
    hydrateHudConfig(sanitizedHudIncoming);
  }
  const targetMcpPath = path.join(geminiRoot, 'config', 'mcp_config.json');
  if (mcpTemplate) {
    readJsonObject(targetMcpPath, true);
  }

  const pluginInstructions = formatPluginInstructions(inDir, geminiRoot, manifestTemplate);

  const executeImport = (): { filesUpdated: string[]; mcpAction: ImportMcpAction } => {
    const planned: PlannedOp[] = [];

    if (sanitizedSettingsIncoming) {
      const targetSettingsPath = path.join(cliHome, 'settings.json');
      const existingSettings = readJsonObject(targetSettingsPath, true) ?? {};
      const mergedSettings = deepMergeObjects(existingSettings, sanitizedSettingsIncoming);
      if (existingSettings.trustedWorkspaces !== undefined) {
        mergedSettings.trustedWorkspaces = cloneValue(existingSettings.trustedWorkspaces);
      } else {
        delete mergedSettings.trustedWorkspaces;
      }
      planned.push({ kind: 'write', filePath: targetSettingsPath, payload: mergedSettings });
    }

    if (sanitizedHudIncoming) {
      const targetHudPath = path.join(cliHome, 'hud-config.json');
      readJsonObject(targetHudPath, true);
      const canonicalHud = hydrateHudConfig(sanitizedHudIncoming);
      planned.push({
        kind: 'write',
        filePath: targetHudPath,
        payload: {
          preset: canonicalHud.preset,
          maxAgentChips: canonicalHud.maxAgentChips,
          osc8Links: canonicalHud.osc8Links,
          lines: [...canonicalHud.lines],
          segments: { ...canonicalHud.segments },
        },
      });
    }

    let mcpAction: ImportMcpAction = 'none';
    if (mcpTemplate) {
      const existingMcp = readJsonObject(targetMcpPath, true);
      if (!existingMcp) {
        planned.push({ kind: 'write', filePath: targetMcpPath, payload: cloneRecord(mcpTemplate) });
        mcpAction = 'created';
      } else if (options.mergeMcp === true) {
        const mergedMcp = mergeMcpConfigs(existingMcp, mcpTemplate);
        planned.push({ kind: 'write', filePath: targetMcpPath, payload: mergedMcp });
        mcpAction = 'merged';
      } else {
        mcpAction = 'skipped-exists';
      }
    }

    const filesUpdated = commitPlannedOps(planned);
    return { filesUpdated, mcpAction };
  };

  const touchesCliHome = settingsTemplate !== null || hudTemplate !== null;
  if (touchesCliHome && hasDanglingSymlinkInChain(cliHome)) {
    const sampleTarget = path.join(cliHome, settingsTemplate ? 'settings.json' : 'hud-config.json');
    throw new Error(`Failed to read ${sampleTarget}: dangling symbolic link`);
  }
  if (mcpTemplate !== null && hasDanglingSymlinkInChain(geminiRoot)) {
    throw new Error(`Failed to read ${targetMcpPath}: dangling symbolic link`);
  }

  const importLocks: string[] = [];
  if (touchesCliHome) importLocks.push(getCliHomeLockPath(cliHome));
  if (mcpTemplate !== null) importLocks.push(getMcpConfigLockPath(geminiRoot));
  const { filesUpdated, mcpAction } =
    importLocks.length > 0
      ? withFileLocksSync(importLocks, executeImport, DEFAULT_CLI_LOCK_TIMEOUT_MS)
      : executeImport();

  return { inDir, cliHome, geminiRoot, filesUpdated, mcpAction, pluginInstructions };
}
