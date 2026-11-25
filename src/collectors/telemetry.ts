import { existsSync, readFileSync } from 'node:fs';

import { isFiniteNum, isPlainObject, nonEmptyStr, parseIsoTimestampSec } from '../core/guards.ts';
import { writeBufferAtomicSync } from '../fs-utils.ts';
import type {
  CliSettings,
  GenMetadataRow,
  QuotaBucketItem,
  SessionTelemetry,
  StatusLineContextWindow,
  StatusLineData,
} from '../types.ts';
import {
  computeCompactedUsed,
  fetchLatestCheckpoint,
  isCompactionActive,
  isCompactionCheckpoint,
} from './compaction.ts';
import type { CompactionCheckpoint } from './compaction.ts';
import { parseGenMetadataBlob } from './proto.ts';
import { resolveCliSubdirFile, resolveConversationId, sanitizeSessionId } from './safe-path.ts';
import { readSqliteVersionTag, withReadonlyDb } from './sqlite-readonly.ts';

export { parseGenMetadataBlob } from './proto.ts';
export { withReadonlyDb } from './sqlite-readonly.ts';

const TELEMETRY_CACHE_VERSION = 2;
const MIN_STREAM_WINDOW_SEC = 0.5;
const MAX_BURST_STREAM_TPS = 400.0;

const EFFORT_SUFFIX_RE = /\s*\((low|medium|high|xhigh|max)\)\s*$/i;
const ORCHESTRATOR_PREFIX = 'Orchestrator';
const ORCHESTRATOR_PAREN_RE = /^Orchestrator\s*\(([^)]+)\)\s*$/i;

const MODEL_PREFIX_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['Claude Opus ', 'Opus '],
  ['Claude Sonnet ', 'Sonnet '],
  ['Claude Haiku ', 'Haiku '],
  ['Gemini 4 ', 'G4 '],
  ['Gemini 3.8 ', 'G3.8 '],
];

const ORCH_ROLE_PREFIX_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['Gemini 4 ', ''],
  ['Gemini 3.8 ', 'G3.8 '],
  ['Claude Opus ', 'Opus '],
  ['Claude Sonnet ', 'Sonnet '],
  ['Claude Haiku ', 'Haiku '],
];

export interface ResolvedModelDisplay {
  name: string;
  effort: string;
}

export interface QuotaResetInfo {
  remainingSeconds: number | null;
  windowExpired: boolean;
}

interface DbLoadResult {
  rows: Record<string, GenMetadataRow>;
  ckpt: CompactionCheckpoint | null;
}

function toNumber(val: unknown): number {
  if (typeof val === 'number') {
    return val;
  }
  if (typeof val === 'bigint') {
    return Number(val);
  }
  return 0;
}

function fetchUpdatedRows(dbPath: string, cachedRows: Record<string, GenMetadataRow>): DbLoadResult | null {
  return withReadonlyDb<DbLoadResult>(dbPath, (db) => {
    const ckpt = fetchLatestCheckpoint(db);
    const statsRow = db.prepare('SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS max_idx FROM gen_metadata').get();
    const count = isPlainObject(statsRow) ? toNumber(statsRow.cnt) : 0;
    if (count === 0) {
      return { rows: {}, ckpt };
    }
    let seed = cachedRows;
    if (count < Object.keys(cachedRows).length) {
      seed = {};
    }
    const keys = Object.keys(seed)
      .map((k) => Number.parseInt(k, 10))
      .filter((n) => Number.isFinite(n));
    const startIdx = keys.length > 0 ? Math.max(...keys) : 0;

    const updated: Record<string, GenMetadataRow> = { ...seed };
    const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx').all(startIdx);
    for (const row of rows) {
      if (!isPlainObject(row)) {
        continue;
      }
      const idx = toNumber(row.idx);
      const blob = row.data instanceof Uint8Array ? row.data : null;
      const parsed = parseGenMetadataBlob(blob);
      if (parsed !== null) {
        updated[String(idx)] = parsed;
      }
    }
    return { rows: updated, ckpt };
  });
}

interface CachedTelemetryLookup {
  hit: boolean;
  rows: Record<string, GenMetadataRow>;
  ckpt: CompactionCheckpoint | null;
}

function isGenMetadataRow(value: unknown): value is GenMetadataRow {
  return (
    isPlainObject(value) &&
    isFiniteNum(value.in) &&
    isFiniteNum(value.out) &&
    isFiniteNum(value.cw) &&
    isFiniteNum(value.cr) &&
    isFiniteNum(value.ttft) &&
    isFiniteNum(value.stream) &&
    isFiniteNum(value.ctxUsed) &&
    isFiniteNum(value.ctxMax) &&
    (value.stepIdx === undefined || isFiniteNum(value.stepIdx))
  );
}

function parseCachedRows(value: unknown): Record<string, GenMetadataRow> | null {
  if (!isPlainObject(value)) return null;
  const rows: Record<string, GenMetadataRow> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isGenMetadataRow(entry)) return null;
    rows[key] = entry;
  }
  return rows;
}

function readTelemetryCache(cacheFile: string, expectedVersionTag: string): CachedTelemetryLookup {
  if (!existsSync(cacheFile)) {
    return { hit: false, rows: {}, ckpt: null };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!isPlainObject(parsed) || parsed.v !== TELEMETRY_CACHE_VERSION) {
      return { hit: false, rows: {}, ckpt: null };
    }
    const versionTag = typeof parsed.versionTag === 'string' && parsed.versionTag.length > 0 ? parsed.versionTag : null;
    const rows = parseCachedRows(parsed.rows);
    if (versionTag === null || rows === null) {
      return { hit: false, rows: {}, ckpt: null };
    }
    const validCkpt = isCompactionCheckpoint(parsed.ckpt) ? parsed.ckpt : null;
    return { hit: versionTag === expectedVersionTag, rows, ckpt: validCkpt };
  } catch {
    return { hit: false, rows: {}, ckpt: null };
  }
}

function loadDbRows(dataRoot: string, cacheCliHome: string, convId: string): DbLoadResult {
  const safeId = sanitizeSessionId(convId);
  if (safeId === null) {
    return { rows: {}, ckpt: null };
  }
  const dbPath = resolveCliSubdirFile(dataRoot, 'conversations', `${safeId}.db`);
  if (dbPath === null || !existsSync(dbPath)) {
    return { rows: {}, ckpt: null };
  }
  const versionTag = readSqliteVersionTag(dbPath);
  if (versionTag.length === 0) {
    return { rows: {}, ckpt: null };
  }
  const cacheFile = resolveCliSubdirFile(cacheCliHome, 'cache', `agy_hud_telemetry_${safeId}.json`);
  if (cacheFile === null) {
    return { rows: {}, ckpt: null };
  }

  const cached = readTelemetryCache(cacheFile, versionTag);
  if (cached.hit) {
    return { rows: cached.rows, ckpt: cached.ckpt };
  }
  const cachedRows = cached.rows;
  const cachedCkpt = cached.ckpt;

  let loaded: DbLoadResult | null;
  try {
    loaded = fetchUpdatedRows(dbPath, cachedRows);
  } catch {
    return { rows: cachedRows, ckpt: cachedCkpt };
  }
  if (loaded === null) {
    return { rows: cachedRows, ckpt: cachedCkpt };
  }

  if (readSqliteVersionTag(dbPath) === versionTag) {
    try {
      writeBufferAtomicSync(
        cacheFile,
        JSON.stringify({ v: TELEMETRY_CACHE_VERSION, versionTag, rows: loaded.rows, ckpt: loaded.ckpt }),
      );
    } catch {
      // Best-effort telemetry cache write.
    }
  }
  return loaded;
}

function hasStepMetrics(row: GenMetadataRow): boolean {
  return row.out > 0 || row.ttft > 0 || row.in + row.cr + row.cw > 0;
}

function fallbackStdinCachePct(ctxObj: StatusLineContextWindow | undefined): number | null {
  const cur = ctxObj?.current_usage;
  if (!cur) {
    return null;
  }
  const inTok = isFiniteNum(cur.input_tokens) ? cur.input_tokens : 0;
  const cwTok = isFiniteNum(cur.cache_creation_input_tokens) ? cur.cache_creation_input_tokens : 0;
  const crTok = isFiniteNum(cur.cache_read_input_tokens) ? cur.cache_read_input_tokens : 0;
  const total = inTok + cwTok + crTok;
  return total > 0 ? (crTok / total) * 100 : null;
}

function computeEffectiveTps(outTok: number, ttftSec: number, streamSec: number): number | null {
  if (outTok <= 0) {
    return null;
  }
  const totalSec = ttftSec + streamSec;
  if (streamSec <= 0) {
    return totalSec > 0 ? outTok / totalSec : null;
  }
  const rawTps = outTok / streamSec;
  const isBufferedBurst = ttftSec > streamSec && (streamSec < MIN_STREAM_WINDOW_SEC || rawTps > MAX_BURST_STREAM_TPS);
  if (isBufferedBurst && totalSec > 0) {
    return outTok / totalSec;
  }
  return rawTps;
}

export function loadSessionTelemetryFromRoot(
  dataRoot: string,
  cacheCliHome: string,
  convId: string | null,
  data: StatusLineData = {},
): SessionTelemetry {
  const ctxObj = data.context_window;
  const { rows, ckpt } = convId !== null ? loadDbRows(dataRoot, cacheCliHome, convId) : { rows: {}, ckpt: null };

  const ordered = Object.keys(rows)
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((k) => rows[k])
    .filter((r): r is GenMetadataRow => r !== undefined);

  const valid = ordered.filter(hasStepMetrics);
  const compacted = isCompactionActive(valid, ckpt);
  const last = valid[valid.length - 1];
  if (!last) {
    return {
      genCount: 0,
      tps: null,
      ttft: null,
      cachePct: fallbackStdinCachePct(ctxObj),
      ctxUsed: compacted && ckpt !== null ? computeCompactedUsed(valid, ckpt) : null,
      ctxMax: null,
      compacted,
    };
  }

  const tps = computeEffectiveTps(last.out, last.ttft, last.stream);
  const stepIn = last.in + last.cw + last.cr;
  const cachePct = stepIn > 0 ? (last.cr / stepIn) * 100 : fallbackStdinCachePct(ctxObj);

  let ctxMax: number | null = null;
  for (let i = valid.length - 1; i >= 0; i -= 1) {
    const candidate = valid[i];
    if (candidate && candidate.ctxMax > 0) {
      ctxMax = candidate.ctxMax;
      break;
    }
  }

  const ctxUsed =
    compacted && ckpt !== null ? computeCompactedUsed(valid, ckpt) : last.ctxUsed > 0 ? last.ctxUsed : null;

  return {
    genCount: valid.length,
    tps,
    ttft: last.ttft > 0 ? last.ttft : null,
    cachePct,
    ctxUsed,
    ctxMax,
    compacted,
  };
}

export function loadSessionTelemetry(cliHome: string, data: StatusLineData): SessionTelemetry {
  return loadSessionTelemetryFromRoot(cliHome, cliHome, resolveConversationId(data), data);
}

export function resolveQuotaReset(entry: QuotaBucketItem, nowSec: number = Date.now() / 1000): QuotaResetInfo {
  const resetTs = parseIsoTimestampSec(entry.reset_time);
  if (isFiniteNum(resetTs)) {
    const remSec = resetTs - nowSec;
    return { remainingSeconds: remSec, windowExpired: remSec <= 0 };
  }
  const rawSec = entry.reset_in_seconds;
  return {
    remainingSeconds: isFiniteNum(rawSec) ? rawSec : null,
    windowExpired: false,
  };
}

function shortenOrchRole(rawRole: unknown): readonly [string, string] {
  let name = typeof rawRole === 'string' ? rawRole.trim() : '';
  if (name.length === 0) {
    return ['', ''];
  }
  let effort = '';
  const match = EFFORT_SUFFIX_RE.exec(name);
  if (match?.[1]) {
    effort = match[1].toLowerCase();
    name = name.replace(EFFORT_SUFFIX_RE, '').trim();
  }
  for (const [prefix, short] of ORCH_ROLE_PREFIX_ALIASES) {
    if (name.startsWith(prefix)) {
      name = short + name.slice(prefix.length);
      break;
    }
  }
  return [name, effort];
}

export function resolveOrchestratorDisplay(
  rawName: string,
  rawEffort: string,
  cliSettings?: CliSettings,
): ResolvedModelDisplay | null {
  if (rawName !== ORCHESTRATOR_PREFIX && !rawName.startsWith(`${ORCHESTRATOR_PREFIX} (`)) {
    return null;
  }
  const orch = cliSettings?.orchestrator;
  if (!isPlainObject(orch)) {
    return null;
  }

  let [plannerName, plannerEff] = shortenOrchRole(orch.planner);
  const [executorName, executorEff] = shortenOrchRole(orch.executor);
  if (plannerName.length === 0 && executorName.length === 0) {
    return null;
  }
  if (plannerName.length === 0) {
    const parenMatch = ORCHESTRATOR_PAREN_RE.exec(rawName);
    plannerName = parenMatch?.[1] ? parenMatch[1].trim() : '';
  }

  const roles = [plannerName, executorName].filter((r) => r.length > 0);
  const name = roles.length > 0 ? `${ORCHESTRATOR_PREFIX} (${roles.join('/')})` : ORCHESTRATOR_PREFIX;

  const trimmedRawEffort = rawEffort.trim().toLowerCase();
  if (trimmedRawEffort.length > 0) {
    return { name, effort: trimmedRawEffort };
  }
  const efforts = [plannerEff, executorEff].filter((e) => e.length > 0);
  const effort = efforts.length === 2 && efforts[0] === efforts[1] ? (efforts[0] ?? '') : efforts.join('/');
  return { name, effort };
}

export function parseModelAndEffort(data: StatusLineData, cliSettings?: CliSettings): ResolvedModelDisplay {
  const modelObj = data.model;
  let rawName = nonEmptyStr(modelObj?.display_name) ?? nonEmptyStr(modelObj?.id) ?? '';
  let effort = nonEmptyStr(modelObj?.effort) ?? '';

  const orch = resolveOrchestratorDisplay(rawName, effort, cliSettings);
  if (orch !== null) {
    return orch;
  }

  const match = EFFORT_SUFFIX_RE.exec(rawName);
  if (match?.[1]) {
    if (effort.length === 0) {
      effort = match[1].toLowerCase();
    }
    rawName = rawName.replace(EFFORT_SUFFIX_RE, '').trim();
  }

  for (const [prefix, short] of MODEL_PREFIX_ALIASES) {
    if (rawName.startsWith(prefix)) {
      rawName = short + rawName.slice(prefix.length);
      break;
    }
  }

  return {
    name: rawName.length > 0 ? rawName : 'agy',
    effort: effort.toLowerCase(),
  };
}
