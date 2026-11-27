import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { isFiniteNum, isPlainObject, nonEmptyStr } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import { lstatIfPresentSync, readRegularJsonObjectSync, writeBoundedPrivateJsonCache } from '../fs-utils.ts';
import type { SnapshotAgent, SubagentAggregateRollup, SubagentTelemetryRollup } from '../snapshot-types.ts';
import type { SessionTelemetry } from '../types.ts';
import { resolveCliSubdirFile, sanitizeSessionId } from './safe-path.ts';
import { withReadonlyDb } from './sqlite-readonly.ts';
import { loadSessionTelemetryFromRoot } from './telemetry.ts';

export const MAX_COLD_CHILD_DB_READS_PER_SNAPSHOT: number = 8;
const MAX_SUBAGENT_DEPTH = 4;
const MAX_SUMMARY_CHILD_NODES = 128;
const SUMMARY_FRONTIER_BATCH_SIZE = 64;
const MAX_SWARM_ROSTER_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 4 * 1024 * 1024;
const SUBAGENT_LINKS_CACHE_VERSION = 1;
const MAX_SUBAGENT_LINKS_CACHE_BYTES = 256 * 1024;

interface ChildLinkCandidate {
  convId: string;
  nameKey: string;
  killed: boolean;
  authoritative: boolean;
}

export interface SubagentRollupOptions {
  readonly parentConvId: string;
  readonly dataRoot: string;
  readonly cacheCliHome: string;
  readonly agents: readonly SnapshotAgent[];
  readonly maxColdDbReads?: number;
}

export interface SubagentRollupResult {
  readonly agents: SnapshotAgent[];
  readonly rollup: SubagentAggregateRollup | null;
}

function readSwarmChildLinks(dataRoot: string, parentConvId: string): ChildLinkCandidate[] {
  const safeParent = sanitizeSessionId(parentConvId);
  if (safeParent === null) return [];
  const rosterPath = resolveCliSubdirFile(dataRoot, 'brain', safeParent, '.system_generated', 'swarm', 'members.json');
  if (rosterPath === null) return [];
  const parsed = readRegularJsonObjectSync(rosterPath, MAX_SWARM_ROSTER_BYTES);
  if (parsed === null || !isPlainObject(parsed.members)) return [];
  const out: ChildLinkCandidate[] = [];
  for (const [name, member] of Object.entries(parsed.members)) {
    if (!isPlainObject(member)) continue;
    const role = typeof member.role === 'string' ? member.role.trim().toLowerCase() : '';
    if (name === 'coordinator' || role === 'coordinator') continue;
    const cid = sanitizeSessionId(nonEmptyStr(member.conversation_id));
    if (cid === null || cid === safeParent) continue;
    out.push({
      convId: cid,
      nameKey: sanitizeTerminalLabel(name).toLowerCase(),
      killed: member.killed === true,
      authoritative: true,
    });
  }
  return out;
}

function extractSubagentCallIdAndName(obj: Record<string, unknown>, safeParent: string): ChildLinkCandidate | null {
  const rawCid =
    nonEmptyStr(obj.conversation_id) ??
    nonEmptyStr(obj.conversationId) ??
    (isPlainObject(obj.result)
      ? (nonEmptyStr(obj.result.conversation_id) ?? nonEmptyStr(obj.result.conversationId))
      : undefined);
  const cid = sanitizeSessionId(rawCid);
  if (cid === null || cid === safeParent) return null;

  const args = isPlainObject(obj.args) ? obj.args : null;
  const rawName =
    nonEmptyStr(obj.agent_name) ??
    nonEmptyStr(obj.role) ??
    nonEmptyStr(obj.Role) ??
    nonEmptyStr(args?.Role) ??
    nonEmptyStr(args?.name) ??
    nonEmptyStr(args?.TypeName) ??
    '';
  const nameKey = rawName.length > 0 ? sanitizeTerminalLabel(rawName).toLowerCase() : '';
  return { convId: cid, nameKey, killed: false, authoritative: false };
}

function readTranscriptChildLinks(dataRoot: string, parentConvId: string): ChildLinkCandidate[] {
  const safeParent = sanitizeSessionId(parentConvId);
  if (safeParent === null) return [];
  const tPath = resolveCliSubdirFile(dataRoot, 'brain', safeParent, '.system_generated', 'logs', 'transcript.jsonl');
  if (tPath === null) return [];
  const st = lstatIfPresentSync(tPath);
  if (st === null || st.isSymbolicLink() || !st.isFile() || st.size > MAX_TRANSCRIPT_SCAN_BYTES) return [];
  let content: string;
  try {
    content = readFileSync(tPath, 'utf8');
  } catch {
    return [];
  }

  const out: ChildLinkCandidate[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.includes('invoke_subagent') && !rawLine.includes('subagent')) continue;
    if (!rawLine.includes('conversation_id') && !rawLine.includes('conversationId')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    for (const tc of toolCalls) {
      if (!isPlainObject(tc)) continue;
      const toolName = typeof tc.name === 'string' ? tc.name.toLowerCase() : '';
      if (toolName !== 'invoke_subagent' && !toolName.includes('subagent')) continue;
      const cand = extractSubagentCallIdAndName(tc, safeParent);
      if (cand !== null) out.push(cand);
    }
    const directType = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';
    if (directType.includes('subagent')) {
      const cand = extractSubagentCallIdAndName(parsed, safeParent);
      if (cand !== null) out.push(cand);
    }
  }
  return out;
}

function isSubagentTelemetrySettledInCache(cacheCliHome: string, childConvId: string): boolean {
  const safeChild = sanitizeSessionId(childConvId);
  if (safeChild === null) return false;
  const telCachePath = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_telemetry_${safeChild}.json`);
  if (telCachePath === null) return false;
  const parsed = readRegularJsonObjectSync(telCachePath, 16 * 1024 * 1024, { requirePrivateMode: true });
  return parsed !== null && parsed.v === 3 && parsed.settled === true;
}

function readCachedSubagentLinks(cacheCliHome: string, parentConvId: string): ChildLinkCandidate[] {
  const safeParent = sanitizeSessionId(parentConvId);
  if (safeParent === null) return [];
  const cachePath = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_subagents_${safeParent}.json`);
  if (cachePath === null) return [];
  const parsed = readRegularJsonObjectSync(cachePath, MAX_SUBAGENT_LINKS_CACHE_BYTES, { requirePrivateMode: true });
  if (parsed === null || parsed.v !== SUBAGENT_LINKS_CACHE_VERSION || !Array.isArray(parsed.links)) return [];
  const out: ChildLinkCandidate[] = [];
  for (const raw of parsed.links) {
    if (out.length >= MAX_SUMMARY_CHILD_NODES) break;
    if (!isPlainObject(raw) || typeof raw.convId !== 'string') continue;
    const cid = sanitizeSessionId(raw.convId);
    if (cid === null || cid === safeParent) continue;
    const nameKey = typeof raw.nameKey === 'string' ? sanitizeTerminalLabel(raw.nameKey).toLowerCase() : '';
    const settledTerminal = raw.killed === true || isSubagentTelemetrySettledInCache(cacheCliHome, cid);
    out.push({
      convId: cid,
      nameKey,
      killed: settledTerminal,
      authoritative: raw.authoritative === true,
    });
  }
  return out;
}

function syncCachedSubagentLinks(
  cacheCliHome: string,
  parentConvId: string,
  links: readonly ChildLinkCandidate[],
): void {
  const safeParent = sanitizeSessionId(parentConvId);
  if (safeParent === null) return;
  const cachePath = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_subagents_${safeParent}.json`);
  if (cachePath === null) return;
  if (links.length === 0) {
    const st = lstatIfPresentSync(cachePath);
    if (st !== null && !st.isSymbolicLink() && st.isFile()) {
      try {
        rmSync(cachePath, { force: true });
      } catch {
        // Ignore best-effort stale link cache removal.
      }
    }
    return;
  }
  writeBoundedPrivateJsonCache(
    cachePath,
    {
      v: SUBAGENT_LINKS_CACHE_VERSION,
      links: links.slice(0, MAX_SUMMARY_CHILD_NODES).map((item) => ({
        convId: item.convId,
        nameKey: item.nameKey,
        killed: item.killed,
        authoritative: item.authoritative,
      })),
    },
    MAX_SUBAGENT_LINKS_CACHE_BYTES,
  );
}

function readSummaryDbChildLinks(dataRoot: string, parentConvId: string): ChildLinkCandidate[] {
  const safeParent = sanitizeSessionId(parentConvId);
  if (safeParent === null) return [];
  const dbPath = path.join(dataRoot, 'conversation_summaries.db');
  const st = lstatIfPresentSync(dbPath);
  if (st === null || st.isSymbolicLink() || !st.isFile()) return [];

  const loaded = withReadonlyDb<ChildLinkCandidate[]>(dbPath, (db) => {
    const visited = new Set<string>([safeParent]);
    let frontier = [safeParent];
    const results: ChildLinkCandidate[] = [];

    for (
      let depth = 1;
      depth <= MAX_SUBAGENT_DEPTH && frontier.length > 0 && results.length < MAX_SUMMARY_CHILD_NODES;
      depth += 1
    ) {
      const nextFrontier: string[] = [];
      for (
        let offset = 0;
        offset < frontier.length && results.length < MAX_SUMMARY_CHILD_NODES;
        offset += SUMMARY_FRONTIER_BATCH_SIZE
      ) {
        const remaining = MAX_SUMMARY_CHILD_NODES - results.length;
        const batch = frontier.slice(offset, offset + SUMMARY_FRONTIER_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        try {
          const stmt = db.prepare(
            `SELECT conversation_id, parent_conversation_id, agent_name, killed
             FROM conversation_summaries
             WHERE parent_conversation_id IN (${placeholders}) AND nesting_depth >= 1
             LIMIT ?`,
          );
          for (const row of stmt.iterate(...batch, remaining)) {
            if (results.length >= MAX_SUMMARY_CHILD_NODES) break;
            if (!isPlainObject(row) || typeof row.conversation_id !== 'string') continue;
            const cid = sanitizeSessionId(row.conversation_id);
            const pid =
              typeof row.parent_conversation_id === 'string' ? sanitizeSessionId(row.parent_conversation_id) : null;
            if (cid === null || pid === null || cid === pid || visited.has(cid) || !visited.has(pid)) continue;
            visited.add(cid);
            nextFrontier.push(cid);
            const agentName =
              typeof row.agent_name === 'string' ? sanitizeTerminalLabel(row.agent_name).toLowerCase() : '';
            results.push({ convId: cid, nameKey: agentName, killed: row.killed === 1, authoritative: true });
          }
        } catch {
          return results;
        }
      }
      frontier = nextFrontier;
    }
    return results;
  });
  return loaded ?? [];
}

function toSubagentRollup(tel: SessionTelemetry): SubagentTelemetryRollup | null {
  if (tel.genCount <= 0 && (tel.retryCount ?? 0) === 0 && (tel.errorCount ?? 0) === 0) return null;
  const totalIn = tel.totalInputTokens ?? 0;
  const cacheRead = tel.totalCacheReadTokens ?? 0;
  return {
    genCount: tel.genCount,
    ctxUsed: tel.ctxUsed,
    ctxMax: tel.ctxMax,
    totalInputTokens: totalIn,
    cacheReadTokens: cacheRead,
    cachePct:
      totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : tel.cachePct !== null ? Math.round(tel.cachePct) : null,
    totalOutputTokens: tel.totalOutputTokens ?? 0,
    thinkingTokens: tel.totalThinkingTokens ?? 0,
    tps: isFiniteNum(tel.tps) ? Math.round(tel.tps * 10) / 10 : null,
    retryCount: tel.retryCount ?? 0,
    errorCount: tel.errorCount ?? 0,
    resolvedModel: nonEmptyStr(tel.lastModelName) ?? null,
  };
}

function agentPriorityRank(agent: SnapshotAgent): number {
  if (agent.state === 'working') return 0;
  if (agent.state === 'waiting') return 1;
  return 2;
}

export function attachSubagentTelemetryRollups(options: SubagentRollupOptions): SubagentRollupResult {
  const { parentConvId, dataRoot, cacheCliHome, agents } = options;
  const maxColdReads = options.maxColdDbReads ?? MAX_COLD_CHILD_DB_READS_PER_SNAPSHOT;
  if (agents.length === 0) {
    return { agents: [], rollup: null };
  }

  // Merge authoritative named sources (swarm roster & summary DB) first, then structured transcript subagent records.
  const linksById = new Map<string, ChildLinkCandidate>();
  const mergeLinks = (items: readonly ChildLinkCandidate[]): void => {
    for (const item of items) {
      if (item.convId === parentConvId) continue;
      const existing = linksById.get(item.convId);
      if (existing === undefined) {
        linksById.set(item.convId, { ...item });
      } else {
        if (existing.nameKey.length === 0 && item.nameKey.length > 0) {
          existing.nameKey = item.nameKey;
        }
        if (item.authoritative) {
          if (!existing.authoritative) {
            existing.authoritative = true;
            existing.killed = item.killed;
          } else if (item.killed) {
            existing.killed = true;
          }
        }
      }
    }
  };
  mergeLinks(readSwarmChildLinks(dataRoot, parentConvId));
  if (maxColdReads > 0) {
    const summaryLinks = readSummaryDbChildLinks(dataRoot, parentConvId);
    const transcriptLinks = readTranscriptChildLinks(dataRoot, parentConvId);
    mergeLinks(summaryLinks);
    mergeLinks(transcriptLinks);
    const persistLinks = new Map<string, ChildLinkCandidate>();
    for (const item of [...summaryLinks, ...transcriptLinks]) {
      if (item.convId === parentConvId) continue;
      if (!persistLinks.has(item.convId)) persistLinks.set(item.convId, item);
    }
    syncCachedSubagentLinks(cacheCliHome, parentConvId, [...persistLinks.values()]);
  } else {
    // statusLine hot path stays strictly cache-only: zero child DB/WAL access and zero multi-MiB transcript rescans.
    mergeLinks(readCachedSubagentLinks(cacheCliHome, parentConvId));
  }
  const orderedLinks = [...linksById.values()];

  const cloned: SnapshotAgent[] = agents.map((a) => ({ ...a }));
  const assignedIds = new Set<string>();
  const agentLinks: Array<{ index: number; convId: string; killed: boolean }> = [];

  const bindByKey = (selectKey: (agent: SnapshotAgent) => string): void => {
    const groups = new Map<string, number[]>();
    for (let i = 0; i < cloned.length; i += 1) {
      const agent = cloned[i];
      if (!agent || agent.convId !== undefined) continue;
      const key = selectKey(agent);
      if (key.length === 0) continue;
      const list = groups.get(key) ?? [];
      list.push(i);
      groups.set(key, list);
    }

    for (const [key, indices] of groups) {
      const matching = orderedLinks.filter((l) => !assignedIds.has(l.convId) && l.nameKey === key);
      if (matching.length === 0) continue;
      const activeIndices = indices.filter((idx) => cloned[idx]?.state !== 'done');
      const doneIndices = indices.filter((idx) => cloned[idx]?.state === 'done');
      const liveCands = matching.filter((l) => !l.killed);
      const killedCands = matching.filter((l) => l.killed);

      if (activeIndices.length === 1 && liveCands.length === 1) {
        const idx = activeIndices[0]!;
        const cand = liveCands[0]!;
        assignedIds.add(cand.convId);
        cloned[idx]!.convId = cand.convId;
        agentLinks.push({ index: idx, convId: cand.convId, killed: cand.killed });
      }

      if (doneIndices.length === 1) {
        const idx = doneIndices[0]!;
        let cand: ChildLinkCandidate | null = null;
        if (killedCands.length === 1) {
          cand = killedCands[0]!;
        } else if (activeIndices.length === 0) {
          const remaining = matching.filter((l) => !assignedIds.has(l.convId));
          if (remaining.length === 1) cand = remaining[0]!;
        }
        if (cand !== null && !assignedIds.has(cand.convId)) {
          assignedIds.add(cand.convId);
          cloned[idx]!.convId = cand.convId;
          agentLinks.push({ index: idx, convId: cand.convId, killed: cand.killed });
        }
      }
    }
  };

  // Pass 1: exact unambiguous name match; Pass 2: exact unambiguous type match (never anonymous or cross-liveness).
  bindByKey((a) => a.name.toLowerCase());
  bindByKey((a) => a.type.toLowerCase());

  // Sort processing order: working -> waiting -> newest done.
  agentLinks.sort((a, b) => {
    const agA = cloned[a.index]!;
    const agB = cloned[b.index]!;
    const rankDiff = agentPriorityRank(agA) - agentPriorityRank(agB);
    if (rankDiff !== 0) return rankDiff;
    return (agB.ts ?? 0) - (agA.ts ?? 0);
  });

  let coldOpens = 0;
  let measuredCount = 0;
  let totalGenCount = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let retryCount = 0;
  let errorCount = 0;

  const cacheOnly = maxColdReads <= 0;
  for (const link of agentLinks) {
    const agent = cloned[link.index];
    if (!agent) continue;
    const isTerminal = agent.state === 'done' || link.killed;
    const tel = loadSessionTelemetryFromRoot(dataRoot, cacheCliHome, link.convId, {}, undefined, {
      settledHint: isTerminal,
      cacheOnly,
      tryConsumeDbOpen: cacheOnly
        ? undefined
        : () => {
            if (coldOpens >= maxColdReads) return false;
            coldOpens += 1;
            return true;
          },
    });
    const rollup = toSubagentRollup(tel);
    if (rollup === null) continue;
    agent.telemetry = rollup;
    if ((agent.model.length === 0 || agent.model.toLowerCase() === 'inherit') && rollup.resolvedModel !== null) {
      agent.model = rollup.resolvedModel;
    }

    measuredCount += 1;
    totalGenCount += rollup.genCount;
    totalInputTokens += rollup.totalInputTokens;
    totalCacheReadTokens += rollup.cacheReadTokens;
    totalOutputTokens += rollup.totalOutputTokens;
    totalThinkingTokens += rollup.thinkingTokens;
    retryCount += rollup.retryCount;
    errorCount += rollup.errorCount;
  }

  const rollup: SubagentAggregateRollup | null =
    measuredCount > 0
      ? {
          childCount: cloned.length,
          measuredCount,
          totalGenCount,
          totalInputTokens,
          totalCacheReadTokens,
          cachePct: totalInputTokens > 0 ? Math.round((totalCacheReadTokens / totalInputTokens) * 100) : null,
          totalOutputTokens,
          totalThinkingTokens,
          retryCount,
          errorCount,
        }
      : null;

  return { agents: cloned, rollup };
}
