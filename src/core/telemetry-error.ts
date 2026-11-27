import type { TurnPhase } from '../snapshot-types.ts';
import type { ModelErrorReason, TailStepPhase } from '../types.ts';
import { normalizeHostAgentState } from './quota-pace.ts';

const CANCELED_RE = /\b(?:context canceled|canceled|cancelled|aborted|user abort(?:ed)?)\b/i;
const RATE_LIMIT_RE = /\b(?:429|resource_exhausted|rate[ _-]?limit|too many requests|quota exceeded|quota)\b/i;
const UNAVAILABLE_RE = /\b(?:502|503|504|unavailable|overloaded|bad gateway|service unavailable|gateway timeout)\b/i;
const TIMEOUT_RE = /\b(?:deadline_exceeded|timed ?out|timeout|etimedout)\b/i;
const EOF_RE = /\b(?:unexpected eof|eof|stream closed|broken pipe|stream terminated)\b/i;
const CONNECTION_RE =
  /\b(?:econnreset|econnrefused|enotfound|ehostunreach|tls|ssl|proxy|dns|connection reset|socket hang up)\b/i;
const AUTH_RE = /\b(?:401|unauthenticated|unauthorized|invalid credentials|token expired)\b/i;
const REGION_RE = /\b(?:403|permission_denied|forbidden|region|geo|not available in your)\b/i;
const BAD_REQUEST_RE = /\b(?:400|invalid_argument|bad request)\b/i;
const INTERNAL_RE = /\b(?:500|internal(?: server)? error|\binternal\b)\b/i;

const SHORT_CODE_MAP: Readonly<Record<ModelErrorReason, string>> = {
  'rate-limit': '429',
  unavailable: '503',
  timeout: 'Timeout',
  eof: 'EOF',
  connection: 'Conn',
  auth: '401',
  region: '403',
  'bad-request': '400',
  internal: '500',
  other: '',
};

export function isCanceledErrorText(text: string): boolean {
  return text.length > 0 && CANCELED_RE.test(text);
}

export function classifyModelErrorReason(errorText: string): ModelErrorReason | null {
  const trimmed = errorText.trim();
  if (trimmed.length === 0 || isCanceledErrorText(trimmed)) {
    return null;
  }
  if (RATE_LIMIT_RE.test(trimmed)) return 'rate-limit';
  if (UNAVAILABLE_RE.test(trimmed)) return 'unavailable';
  if (TIMEOUT_RE.test(trimmed)) return 'timeout';
  if (EOF_RE.test(trimmed)) return 'eof';
  if (CONNECTION_RE.test(trimmed)) return 'connection';
  if (AUTH_RE.test(trimmed)) return 'auth';
  if (REGION_RE.test(trimmed)) return 'region';
  if (BAD_REQUEST_RE.test(trimmed)) return 'bad-request';
  if (INTERNAL_RE.test(trimmed)) return 'internal';
  return 'other';
}

export function formatErrorReasonShortCode(reason: ModelErrorReason): string {
  return SHORT_CODE_MAP[reason];
}

export interface ResolveTurnPhaseInput {
  readonly isExitedCli?: boolean;
  readonly hasLiveHostState?: boolean;
  readonly toolConfirmationPending?: boolean;
  readonly agentState?: unknown;
  readonly tailStepPhase?: TailStepPhase | null;
  readonly lastErrorCode?: ModelErrorReason | null;
}

export function resolveTurnPhase(input: ResolveTurnPhaseInput): TurnPhase {
  if (input.isExitedCli === true) {
    return 'idle';
  }
  if (input.hasLiveHostState === true) {
    if (input.toolConfirmationPending === true) {
      return 'approval';
    }
    const normalized = normalizeHostAgentState(input.agentState);
    if (normalized !== null) {
      return normalized;
    }
  }
  if (input.tailStepPhase === 'working' || input.tailStepPhase === 'tool_use' || input.tailStepPhase === 'error') {
    return input.tailStepPhase;
  }
  if (input.lastErrorCode !== undefined && input.lastErrorCode !== null) {
    return 'error';
  }
  return 'idle';
}
