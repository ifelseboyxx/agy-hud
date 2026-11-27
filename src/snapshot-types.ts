import type { AgentsKind, AgentState, SessionTelemetry, SubagentStdinItem, TodoSummary } from './types.ts';

export type SnapshotResolutionTier = 'explicit' | 'pid' | 'workspace' | 'fallback';

export type SnapshotSection = 'context' | 'tools' | 'skills' | 'mcps' | 'agents';

export type TurnPhase =
  | 'idle'
  | 'initializing'
  | 'working'
  | 'tool_use'
  | 'approval'
  | 'reviewing'
  | 'authenticating'
  | 'error';

export type HostAgentState = Exclude<TurnPhase, 'approval'>;

export type QuotaPaceStatus = 'settling' | 'on_track' | 'depleting' | 'depleted';

export interface QuotaPaceForecast {
  readonly status: QuotaPaceStatus;
  readonly windowSec: number;
  readonly elapsedSec: number;
  readonly remainingSec: number;
  readonly usedFraction: number;
  readonly projectedEndUsed: number;
  readonly projectedRemainingPct: number;
  readonly paceRatio: number;
  readonly etaToZeroSec: number | null;
}

export interface SnapshotQuotaBucket {
  readonly remainingFraction: number | null;
  readonly remainingAmount: string | null;
  readonly resetTimeIso: string | null;
  readonly resetTimeSec: number | null;
  readonly disabled: boolean;
}

export interface ResolvedSnapshotQuotaBucket {
  readonly key: string;
  readonly label: string;
  readonly remainingPct: number | null;
  readonly remainingAmount: string | null;
  readonly remainingSeconds: number | null;
  readonly windowExpired: boolean;
  readonly pace: QuotaPaceForecast | null;
}

export interface SnapshotCost {
  totalUsd: number;
  subagentUsd: number | null;
  estimated: boolean;
}

export interface SnapshotEnvelope {
  v: 2;
  convId: string;
  conversationTitle: string;
  agyPid: number | null;
  cwd: string;
  workspaceCurrentDir: string;
  workspaceProjectDir: string;
  subagents: SubagentStdinItem[];
  taskCount: number | null;
  agentState?: HostAgentState | null;
  toolConfirmationPending?: boolean;
  modelDisplayName?: string | null;
  nominalContextWindowSize?: number | null;
  stdinContextUsedPct?: number | null;
  cost?: SnapshotCost | null;
  quota?: Record<string, SnapshotQuotaBucket> | null;
  mdDigest: string | null;
  updatedAtMs: number;
  heartbeatAtMs: number;
  pidSwitchSeq?: number;
}

export interface SessionRecord {
  convId: string;
  shortId: string;
  title: string;
  workspace: string;
  workspaces: string[];
  dataRoot: string;
  running: boolean;
  livePid: number | null;
  hasEnvelope: boolean;
  envelope: SnapshotEnvelope | null;
  updatedAtMs: number;
  ageLabel: string;
  turnPhase?: TurnPhase;
}

export interface SiblingSessionHint {
  convId: string;
  shortId: string;
  title: string;
  livePid: number | null;
  running: boolean;
  ageLabel: string;
}

export interface SnapshotRunningTool {
  name: string;
  disp: string;
  target: string;
  fullTarget: string;
  targetLinkable?: boolean;
  isMcp: boolean;
}

export interface SnapshotCompletedTool {
  disp: string;
  count: number;
  latestTarget: string;
  fullTarget: string;
  recentTargets: string[];
  unlinkedTargets?: string[];
  isMcp: boolean;
}

export interface SnapshotMcpSubtool {
  name: string;
  count: number;
}

export interface SnapshotMcpServer {
  server: string;
  totalCalls: number;
  subtools: SnapshotMcpSubtool[];
}

export interface SubagentTelemetryRollup {
  readonly genCount: number;
  readonly ctxUsed: number | null;
  readonly ctxMax: number | null;
  readonly totalInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cachePct: number | null;
  readonly totalOutputTokens: number;
  readonly thinkingTokens: number;
  readonly tps: number | null;
  readonly retryCount: number;
  readonly errorCount: number;
  readonly resolvedModel: string | null;
}

export interface SubagentAggregateRollup {
  readonly childCount: number;
  readonly measuredCount: number;
  readonly totalGenCount: number;
  readonly totalInputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly cachePct: number | null;
  readonly totalOutputTokens: number;
  readonly totalThinkingTokens: number;
  readonly retryCount: number;
  readonly errorCount: number;
}

export interface SnapshotAgent {
  name: string;
  type: string;
  model: string;
  state: AgentState;
  ts: number | null;
  ageLabel: string;
  convId?: string;
  telemetry?: SubagentTelemetryRollup | null;
}

export interface ActivitySnapshot {
  convId: string;
  shortId: string;
  title: string;
  model: string;
  workspace: string;
  dataRoot: string;
  resolutionTier: SnapshotResolutionTier;
  running: boolean;
  updatedAtMs: number;
  ageLabel: string;
  livePid: number | null;
  turnPhase?: TurnPhase;
  siblingCandidates: SiblingSessionHint[];
  siblingHint: string;
  telemetry: SessionTelemetry;
  nominalContextWindowSize?: number | null;
  cost?: SnapshotCost | null;
  quota?: ResolvedSnapshotQuotaBucket[] | null;
  runningTools: SnapshotRunningTool[];
  completedTools: SnapshotCompletedTool[];
  totalToolCalls: number;
  skills: string[];
  mcps: SnapshotMcpServer[];
  agentsKind: AgentsKind;
  agents: SnapshotAgent[];
  subagentRollup?: SubagentAggregateRollup | null;
  todos: TodoSummary | null;
}
