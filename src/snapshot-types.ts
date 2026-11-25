import type { AgentsKind, AgentState, SessionTelemetry, SubagentStdinItem, TodoSummary } from './types.ts';

export type SessionSurface = 'cli' | 'app' | 'ide';

export type SessionSourceFilter = 'auto' | 'cli' | 'app' | 'all';

export type SnapshotResolutionTier = 'explicit' | 'pid' | 'workspace' | 'fallback';

export type SnapshotSection = 'tools' | 'skills' | 'mcps' | 'agents';

export interface SnapshotEnvelope {
  v: 1;
  convId: string;
  conversationTitle: string;
  agyPid: number | null;
  cwd: string;
  workspaceCurrentDir: string;
  workspaceProjectDir: string;
  subagents: SubagentStdinItem[];
  taskCount: number | null;
  mdDigest: string | null;
  updatedAtMs: number;
  heartbeatAtMs: number;
  pidSwitchSeq?: number;
}

export interface SessionRecord {
  convId: string;
  shortId: string;
  surface: SessionSurface;
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
}

export interface SiblingSessionHint {
  convId: string;
  shortId: string;
  surface: SessionSurface;
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

export interface SnapshotAgent {
  name: string;
  type: string;
  model: string;
  state: AgentState;
  ts: number | null;
  ageLabel: string;
}

export interface ActivitySnapshot {
  convId: string;
  shortId: string;
  surface: SessionSurface;
  title: string;
  model: string;
  workspace: string;
  dataRoot: string;
  resolutionTier: SnapshotResolutionTier;
  running: boolean;
  updatedAtMs: number;
  ageLabel: string;
  livePid: number | null;
  siblingCandidates: SiblingSessionHint[];
  siblingHint: string;
  telemetry: SessionTelemetry;
  runningTools: SnapshotRunningTool[];
  completedTools: SnapshotCompletedTool[];
  totalToolCalls: number;
  skills: string[];
  mcps: SnapshotMcpServer[];
  agentsKind: AgentsKind;
  agents: SnapshotAgent[];
  todos: TodoSummary | null;
}
