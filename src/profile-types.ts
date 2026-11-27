export type HudPreset = 'zen' | 'minimal' | 'compact' | 'swarm' | 'full';

export type HudCostCurrency = 'usd' | 'cny' | 'both';

export type HudLineId = 'mode' | 'identity' | 'usage' | 'activity' | 'tools' | 'skills' | 'mcps' | 'agents' | 'todos';

export type HudSegmentId = 'model' | 'git' | 'duration' | 'badges' | 'cost' | 'perf' | 'context' | 'quota';

export type HudSegments = Record<HudSegmentId, boolean>;

export interface HudNarrowOverride {
  lines?: HudLineId[];
  segments?: Partial<HudSegments>;
}

export interface HudConfig {
  preset: HudPreset;
  maxAgentChips: number;
  osc8Links: boolean;
  costCurrency: HudCostCurrency;
  usdToCnyRate: number;
  lines: HudLineId[];
  segments: HudSegments;
  narrow?: HudNarrowOverride;
}

export interface ConfigureHudOptions {
  cliHome?: string;
  show?: boolean;
  interactive?: boolean;
  preset?: HudPreset;
  enable?: readonly string[];
  disable?: readonly string[];
  order?: readonly string[];
  narrowEnable?: readonly string[];
  narrowDisable?: readonly string[];
  narrowOrder?: readonly string[];
  narrowReset?: boolean;
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
