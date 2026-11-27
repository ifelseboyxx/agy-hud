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
