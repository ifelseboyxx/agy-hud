export interface StatusLineModel {
  id?: string;
  display_name?: string;
  effort?: string;
}

export interface StatusLineWorkspace {
  current_dir?: string;
  project_dir?: string;
}

export interface StatusLineContextUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface StatusLineContextWindow {
  used_percentage?: number;
  remaining_percentage?: number;
  context_window_size?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  current_usage?: StatusLineContextUsage;
}

export interface StatusLineAgent {
  name?: string;
  display_name?: string;
}

export interface StatusLineProduct {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface QuotaBucketItem {
  remaining_fraction?: number;
  remaining_amount?: number | string;
  reset_time?: string;
  reset_in_seconds?: number;
  disabled?: boolean;
  used_fraction?: number;
  limit?: number;
  label?: string;
}

export interface QuotaBucketGroup {
  'gemini-5h'?: QuotaBucketItem;
  'gemini-weekly'?: QuotaBucketItem;
  'gemini-argon-wtu-weekly'?: QuotaBucketItem;
  '3p-5h'?: QuotaBucketItem;
  '3p-weekly'?: QuotaBucketItem;
  [bucketKey: string]: QuotaBucketItem | undefined;
}

export interface StatusLineVcs {
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  repo_root?: string;
}

export interface StatusLineSandbox {
  enabled?: boolean;
  mode?: string;
  [key: string]: unknown;
}

export interface SubagentStdinItem {
  id?: string;
  name?: string;
  role?: string;
  type_name?: string;
  model?: string;
  status?: string;
  state?: string;
}

export interface StatusLineBattle {
  status?: string;
  focused_arm?: string;
  [key: string]: unknown;
}

export interface StatusLineVim {
  mode?: string;
}

export interface StatusLineCost {
  total_usd?: number;
  subagent_usd?: number;
  estimated?: boolean;
  total_cost_usd?: number;
  total_duration_ms?: number;
  total_api_duration_ms?: number;
  total_lines_added?: number;
  total_lines_removed?: number;
}

export interface StatusLineData {
  cwd?: string;
  session_id?: string;
  conversation_id?: string;
  conversation_title?: string;
  transcript_path?: string;
  model?: StatusLineModel;
  workspace?: StatusLineWorkspace;
  version?: string;
  context_window?: StatusLineContextWindow;
  exceeds_200k_tokens?: boolean;
  agent?: StatusLineAgent;
  product?: string | StatusLineProduct;
  quota?: QuotaBucketGroup;
  agent_state?: string | Record<string, unknown>;
  vcs?: StatusLineVcs;
  cycle_mode?: string;
  sandbox?: boolean | string | StatusLineSandbox;
  subagents?: SubagentStdinItem[];
  artifact_count?: number;
  plan_tier?: string;
  email?: string;
  pending_input_count?: number;
  tool_confirmation_pending?: boolean;
  task_count?: number;
  terminal_width?: number;
  battle?: StatusLineBattle;
  vim?: StatusLineVim;
  cost?: StatusLineCost;
  duration_ms?: number;
  total_duration_ms?: number;
  elapsed_seconds?: number;
  permission_mode?: string;
  mode?: string;
  agent_mode?: string;
  agentMode?: string;
  dangerously_skip_permissions?: boolean;
  output_style?: string | { name?: string };
}

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

export interface GitStatusInfo {
  branch: string;
  dirty: boolean;
  staged?: number;
  modified?: number;
  deleted?: number;
  renamed?: number;
  untracked?: number;
  conflicted?: number;
  stash?: number;
  ahead?: number;
  behind?: number;
  diffAdded?: number;
  diffDeleted?: number;
}

export type ModelErrorReason =
  | 'rate-limit'
  | 'unavailable'
  | 'timeout'
  | 'eof'
  | 'connection'
  | 'auth'
  | 'region'
  | 'bad-request'
  | 'internal'
  | 'other';

export type CacheAnomalyKind = 'cleared' | 'dropped' | 'missed';
export type TailStepPhase = 'working' | 'tool_use' | 'error';

export interface ContextBreakdownSummary {
  system: number;
  rules: number;
  skills: number;
  tools: number;
  mcp: number;
  messages: number;
  free: number;
  budget: number;
  used: number;
  compacted: boolean;
  estimatedMessages: boolean;
}

export interface CompactionSummary {
  count: number;
  active: boolean;
  preUsed: number | null;
  postUsed: number | null;
}

export interface ModelRoleContextEntry {
  model: string;
  role?: 'planner' | 'executor';
  genCount: number;
  lastCtxUsed: number;
  lastCtxMax: number;
}

export interface CacheAnomalyEvent {
  kind: CacheAnomalyKind;
  prevPct: number;
  curPct: number;
  gapSec: number;
}

export interface SessionTelemetry {
  genCount: number;
  tps: number | null;
  ttft: number | null;
  cachePct: number | null;
  ctxUsed: number | null;
  ctxMax: number | null;
  compacted?: boolean;
  avgTps?: number | null;
  peakTps?: number | null;
  totalInputTokens?: number;
  totalCacheReadTokens?: number;
  totalOutputTokens?: number;
  totalThinkingTokens?: number;
  totalResponseTokens?: number;
  lastThinkingTokens?: number;
  lastResponseTokens?: number;
  latestCacheAnomaly?: CacheAnomalyEvent | null;
  cacheAnomalyCount?: number;
  contextBreakdown?: ContextBreakdownSummary | null;
  compaction?: CompactionSummary | null;
  modelRoles?: ModelRoleContextEntry[] | null;
  providerInputTokens?: number | null;
  truncationReason?: 'cache-ttl-expired' | 'max-token-limit' | null;
  retryCount?: number;
  retryWaitSec?: number;
  retryReasons?: Partial<Record<ModelErrorReason, number>>;
  errorCount?: number;
  errorReasons?: Partial<Record<ModelErrorReason, number>>;
  lastRetries?: number;
  lastRetryReason?: ModelErrorReason | null;
  lastErrorCode?: ModelErrorReason | null;
  modelTimeSec?: number;
  toolTimeSec?: number;
  tailStepPhase?: TailStepPhase | null;
  lastModelName?: string | null;
}

export type AgentState = 'working' | 'waiting' | 'done';

export type AgentsKind = 'swarm' | 'agents';

export interface AgentEntry {
  name: string;
  type: string;
  model: string;
  state: AgentState;
  ts: number | null;
}

export interface AgentsSummary {
  kind: AgentsKind;
  working: number;
  waiting: number;
  alive: number;
  total: number;
  entries: AgentEntry[];
}

export interface TranscriptToolEntry {
  name: string;
  disp: string;
  target: string;
  fullTarget?: string;
  running: boolean;
  isSkillRead: boolean;
}

export interface CompletedToolAggregate {
  disp: string;
  count: number;
  latestTarget: string;
  fullTarget: string;
  recentTargets: string[];
}

export interface ActivityAgentEntry {
  name: string;
  type: string;
  model: string;
  running: boolean;
  ts: number | null;
}

export interface TranscriptActivity {
  tools: TranscriptToolEntry[];
  skills: string[];
  mcps: string[];
  agents: ActivityAgentEntry[];
  completedTools?: CompletedToolAggregate[];
}

export interface TodoSummary {
  total?: number;
  completed?: number;
  current?: string;
  taskCount?: number;
}

export interface OrchestratorSettings {
  planner?: string;
  executor?: string;
  [key: string]: unknown;
}

export interface StatusLineSetting {
  type?: string;
  command?: string;
  enabled?: boolean;
  stack_with_default?: boolean;
  [key: string]: unknown;
}

export interface CliSettings {
  agentMode?: string;
  model?: string;
  notifications?: boolean;
  orchestrator?: OrchestratorSettings;
  statusLine?: StatusLineSetting;
  trustedWorkspaces?: string[];
  [key: string]: unknown;
}

export interface ActivityLineFormatOptions {
  formatOverflow?: (hiddenCount: number) => string;
}

export interface GitBranchInfo {
  branch: string;
  dirty: boolean;
}

export interface HudCollectorOverrides {
  detectGitBranch?: (cwd: string | undefined, stdinVcs?: StatusLineVcs) => GitBranchInfo;
  detectGitStatus?: (cliHome: string, cwd: string | undefined, stdinVcs?: StatusLineVcs) => GitStatusInfo;
  loadTodos?: (cliHome: string, data: StatusLineData) => TodoSummary | null;
  loadSessionTelemetry?: (cliHome: string, data: StatusLineData) => SessionTelemetry;
  loadTranscriptActivity?: (cliHome: string, data: StatusLineData) => TranscriptActivity | null;
  collectAgentsSummary?: (
    cliHome: string,
    data: StatusLineData,
    activityAgents?: readonly ActivityAgentEntry[],
  ) => AgentsSummary;
}

export interface RenderHudOptions {
  cliHome?: string;
  cliSettings?: CliSettings;
  hudConfig?: Partial<HudConfig>;
  telemetry?: SessionTelemetry;
  activity?: TranscriptActivity | null;
  agentsSummary?: AgentsSummary;
  todos?: TodoSummary | null;
  nowSec?: number;
  agyPid?: number | null;
  bypass?: boolean;
  cliMode?: string;
  branch?: string;
  dirty?: boolean;
  gitInfo?: GitStatusInfo;
  elapsedSeconds?: number | null;
  activityLineOptions?: ActivityLineFormatOptions;
  formatActivitySummaryTail?: (remainingCols: number) => string;
  collectors?: HudCollectorOverrides;
  env?: NodeJS.ProcessEnv;
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
