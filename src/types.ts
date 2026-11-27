import type { HudConfig } from './profile-types.ts';
import type { SessionTelemetry } from './telemetry-types.ts';

export type * from './profile-types.ts';
export type * from './telemetry-types.ts';

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

export interface HudCollectorOverrides {
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
