import { isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { LEGACY_ORCHESTRATOR_ENUMS } from '../core/model-names.ts';
import type {
  CliSettings,
  CompactionSummary,
  ContextBreakdownSummary,
  ModelRoleContextEntry,
  StatusLineData,
} from '../types.ts';
import { computeCompactedUsed, type CompactionCheckpoint } from './compaction.ts';
import type { GenMetadataRow, TailGenExtras } from './proto.ts';

interface ModelGroupAcc {
  model: string;
  enums: Set<number>;
  genCount: number;
  lastCtxUsed: number;
  lastCtxMax: number;
}

export interface ContextAndRoleEvaluation {
  readonly ctxUsed: number | null;
  readonly ctxMax: number | null;
  readonly contextBreakdown: ContextBreakdownSummary | null;
  readonly compaction: CompactionSummary | null;
  readonly modelRoles: ModelRoleContextEntry[] | null;
  readonly truncationReason: 'cache-ttl-expired' | 'max-token-limit' | null;
}

function isOrchestratorSession(
  valid: readonly GenMetadataRow[],
  tail: TailGenExtras | null,
  cliSettings: CliSettings | undefined,
  data: StatusLineData,
): boolean {
  if (tail !== null && tail.execModelEnum > 0) return true;
  const last = valid[valid.length - 1];
  if (last?.modelEnum !== undefined && LEGACY_ORCHESTRATOR_ENUMS.has(last.modelEnum)) return true;
  const displayName = nonEmptyStr(data.model?.display_name) ?? nonEmptyStr(data.model?.id) ?? '';
  return isPlainObject(cliSettings?.orchestrator) && displayName.startsWith('Orchestrator');
}

function resolveRoleTag(
  modelKey: string,
  modelEnums: ReadonlySet<number>,
  tail: TailGenExtras | null,
  cliSettings: CliSettings | undefined,
): 'planner' | 'executor' | undefined {
  if (tail !== null && tail.execModelEnum > 0) {
    if (modelEnums.has(tail.execModelEnum)) return 'executor';
    if (tail.planModelEnum > 0 && modelEnums.has(tail.planModelEnum)) return 'planner';
    return undefined;
  }
  if (modelEnums.has(1667)) return 'planner';
  if (modelEnums.has(1669)) return 'executor';
  const orch = cliSettings?.orchestrator;
  if (isPlainObject(orch)) {
    const planner = nonEmptyStr(orch.planner)?.toLowerCase() ?? '';
    const executor = nonEmptyStr(orch.executor)?.toLowerCase() ?? '';
    const lower = modelKey.toLowerCase();
    if (planner.length > 0 && lower === planner) return 'planner';
    if (executor.length > 0 && lower === executor) return 'executor';
    const plannerBase = planner.split('(')[0]?.trim() ?? '';
    const executorBase = executor.split('(')[0]?.trim() ?? '';
    const sameBase = plannerBase.length > 0 && plannerBase === executorBase;
    if (!sameBase) {
      if (plannerBase.length > 0 && lower.includes(plannerBase)) return 'planner';
      if (executorBase.length > 0 && lower.includes(executorBase)) return 'executor';
    }
  }
  return undefined;
}

function computeCompactionSummary(
  valid: readonly GenMetadataRow[],
  ckpt: CompactionCheckpoint | null,
  compacted: boolean,
  effectiveCtxUsed: number | null,
): CompactionSummary | null {
  if (ckpt === null || ckpt.compactionCount < 1) return null;
  let preUsed: number | null = null;
  let postUsed: number | null = compacted ? effectiveCtxUsed : null;

  for (const row of valid) {
    const stepPos = row.stepIdx ?? -1;
    const producedPos = row.minStepIdx ?? (stepPos >= 0 ? stepPos + 1 : -1);
    if (stepPos >= 0 && stepPos < ckpt.idx && row.ctxUsed > 0) {
      preUsed = row.ctxUsed;
    } else if (!compacted && postUsed === null && producedPos > ckpt.idx && row.ctxUsed > 0) {
      postUsed = row.ctxUsed;
    }
  }
  if (preUsed === null && valid.length > 0) {
    const last = valid[valid.length - 1];
    if (last && last.ctxUsed > 0) preUsed = last.ctxUsed;
  }
  return { count: ckpt.compactionCount, active: compacted, preUsed, postUsed };
}

export function evaluateContextAndRoles(
  valid: readonly GenMetadataRow[],
  tail: TailGenExtras | null,
  ckpt: CompactionCheckpoint | null,
  compacted: boolean,
  cliSettings: CliSettings | undefined,
  data: StatusLineData,
): ContextAndRoleEvaluation {
  const modelMap = new Map<string, ModelGroupAcc>();
  for (const row of valid) {
    const key = row.modelKey ?? (row.modelEnum !== undefined ? String(row.modelEnum) : '');
    if (key.length === 0) continue;
    let group = modelMap.get(key);
    if (!group) {
      group = { model: key, enums: new Set(), genCount: 0, lastCtxUsed: 0, lastCtxMax: 0 };
      modelMap.set(key, group);
    }
    if (row.modelEnum !== undefined) group.enums.add(row.modelEnum);
    group.genCount += 1;
    if (row.ctxUsed > 0) group.lastCtxUsed = row.ctxUsed;
    if (row.ctxMax > 0) group.lastCtxMax = row.ctxMax;
  }

  const orchestrator = isOrchestratorSession(valid, tail, cliSettings, data);
  const modelRoleEntries: ModelRoleContextEntry[] = [...modelMap.values()].map((g) => {
    const role = orchestrator ? resolveRoleTag(g.model, g.enums, tail, cliSettings) : undefined;
    return {
      model: g.model,
      ...(role !== undefined ? { role } : {}),
      genCount: g.genCount,
      lastCtxUsed: g.lastCtxUsed,
      lastCtxMax: g.lastCtxMax,
    };
  });

  let ctxMax: number | null = null;
  if (orchestrator && modelRoleEntries.length >= 2) {
    const plannerMaxes = modelRoleEntries
      .filter((e) => e.role === 'planner' && e.lastCtxMax > 0)
      .map((e) => e.lastCtxMax);
    const executorMaxes = modelRoleEntries
      .filter((e) => e.role === 'executor' && e.lastCtxMax > 0)
      .map((e) => e.lastCtxMax);
    if (plannerMaxes.length > 0 && executorMaxes.length > 0) {
      ctxMax = Math.min(...plannerMaxes, ...executorMaxes);
    }
  }
  if (ctxMax === null) {
    for (let i = valid.length - 1; i >= 0; i -= 1) {
      const candidate = valid[i];
      if (candidate && candidate.ctxMax > 0) {
        ctxMax = candidate.ctxMax;
        break;
      }
    }
  }

  const last = valid[valid.length - 1];
  const tailBreakdown = tail?.breakdown ?? null;
  const ctxUsed =
    compacted && ckpt !== null
      ? computeCompactedUsed(valid, ckpt, tailBreakdown)
      : last && last.ctxUsed > 0
        ? last.ctxUsed
        : null;

  let contextBreakdown: ContextBreakdownSummary | null = null;
  if (tailBreakdown !== null && ctxMax !== null && ctxUsed !== null) {
    const messages = compacted && ckpt !== null ? ckpt.msgTokensEstimate : tailBreakdown.messages;
    contextBreakdown = {
      system: tailBreakdown.system,
      rules: tailBreakdown.rules,
      skills: tailBreakdown.skills,
      tools: tailBreakdown.tools,
      mcp: tailBreakdown.mcp,
      messages,
      free: Math.max(0, ctxMax - ctxUsed),
      budget: ctxMax,
      used: ctxUsed,
      compacted,
      estimatedMessages: compacted,
    };
  }

  const modelRoles: ModelRoleContextEntry[] | null = modelRoleEntries.length >= 2 ? modelRoleEntries : null;

  const truncationCode = tail?.truncationReason ?? 0;
  const truncationReason = truncationCode === 1 ? 'cache-ttl-expired' : truncationCode === 2 ? 'max-token-limit' : null;
  const compaction = computeCompactionSummary(valid, ckpt, compacted, ctxUsed);

  return { ctxUsed, ctxMax, contextBreakdown, compaction, modelRoles, truncationReason };
}
