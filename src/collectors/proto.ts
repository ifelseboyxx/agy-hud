/* @host-contract
 * Raw protobuf wire decoder for SQLite `gen_metadata.data` blobs (docs/host-contracts.md §1):
 * - Wire-skips heavy prompt/tool schema blobs (`1.1`, `1.2`, `1.8`, `1.10`, `1.16`) up to 16 MiB (`MAX_PROTO_BLOB_BYTES`).
 * - Decodes ChatModel usage (`in`/`out`/`cw`/`cr`/`think`/`resp`), ContextWindowMetadata (`ctxUsed`, `ctxMax`, `truncation_reason`,
 *   6-category `TokenBreakdown` on `max_idx`), Duration (`ttft`/`stream`), `retries`/`retry_infos`, model identity, `step_indices`,
 *   Orchestrator `3.1`/`3.60.1`, and outer `error`.
 */
import { resolveGenModelDisplayName } from '../core/model-names.ts';
import { classifyModelErrorReason, isCanceledErrorText } from '../core/telemetry-error.ts';
import type { ModelErrorReason } from '../types.ts';
import { parseTokenBreakdownProto } from './proto-steps.ts';
import {
  type ContextBreakdownCounts,
  type GenMetadataRow,
  MAX_PROTO_BLOB_BYTES,
  parseDurationProto,
  readLengthDelimited,
  readProtoTag,
  readSafeVarint,
  skipWireValue,
  type TailGenExtras,
  UTF8_DECODER,
} from './proto-wire.ts';

export { MAX_PROTO_BLOB_BYTES, type ContextBreakdownCounts, type GenMetadataRow, type TailGenExtras };

const INT_STR_RE = /^-?\d+$/;

export interface ParsedGenMetadataWithTail {
  readonly row: GenMetadataRow;
  readonly tail: TailGenExtras;
}

function parseKvPair(buf: Uint8Array): readonly [string, string] {
  let pos = 0;
  let key = '';
  let val = '';
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && (fnum === 1 || fnum === 2)) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      const text = UTF8_DECODER.decode(slice[0]);
      pos = slice[1];
      if (fnum === 1) key = text;
      else val = text;
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return [key, val];
}

export function parseKvStepIdx(buf: Uint8Array): number | null {
  if (buf.length === 0 || buf.length > MAX_PROTO_BLOB_BYTES) return null;
  const [key, val] = parseKvPair(buf);
  if (key !== 'last_step_index') return null;
  const trimmed = val.trim();
  return INT_STR_RE.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

interface ParsedUsage {
  in: number;
  out: number;
  cw: number;
  cr: number;
  think: number;
  resp: number;
}

function parseUsageProto(buf: Uint8Array): ParsedUsage {
  let pos = 0;
  const usage: ParsedUsage = { in: 0, out: 0, cw: 0, cr: 0, think: 0, resp: 0 };
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 0 && ((fnum >= 2 && fnum <= 5) || fnum === 9 || fnum === 10)) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      pos = valRes[1];
      if (fnum === 2) usage.in = valRes[0];
      else if (fnum === 3) usage.out = valRes[0];
      else if (fnum === 4) usage.cw = valRes[0];
      else if (fnum === 5) usage.cr = valRes[0];
      else if (fnum === 9) usage.think = valRes[0];
      else usage.resp = valRes[0];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return usage;
}

interface ParsedCtxWindow {
  used: number;
  limit: number;
  truncationReason: number;
  breakdown: ContextBreakdownCounts | null;
}

function parseCtxWindowProto(buf: Uint8Array, decodeBreakdown: boolean): ParsedCtxWindow {
  let pos = 0;
  let used = 0;
  let limit = 0;
  let truncationReason = 0;
  let breakdown: ContextBreakdownCounts | null = null;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 0 && (fnum === 1 || fnum === 2 || fnum === 4)) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      pos = valRes[1];
      if (fnum === 1) used = valRes[0];
      else if (fnum === 2) truncationReason = valRes[0];
      else limit = valRes[0];
      continue;
    }
    if (wtype === 2 && fnum === 3 && decodeBreakdown) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      breakdown = parseTokenBreakdownProto(slice[0]);
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return { used, limit, truncationReason, breakdown };
}

function parseChatStartProto(buf: Uint8Array, decodeBreakdown: boolean): ParsedCtxWindow {
  let pos = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 10) {
      const slice = readLengthDelimited(buf, pos);
      return slice !== null
        ? parseCtxWindowProto(slice[0], decodeBreakdown)
        : { used: 0, limit: 0, truncationReason: 0, breakdown: null };
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return { used: 0, limit: 0, truncationReason: 0, breakdown: null };
}

interface ParsedRetryInfo {
  readonly outputTokens: number;
  readonly errorText: string;
  readonly waitSec: number;
}

function parseRetryInfoProto(buf: Uint8Array): ParsedRetryInfo {
  let pos = 0;
  let outputTokens = 0;
  let errorText = '';
  let waitSec = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && (fnum === 2 || fnum === 3 || fnum === 7)) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      if (fnum === 2) outputTokens = parseUsageProto(slice[0]).out;
      else if (fnum === 3) errorText = UTF8_DECODER.decode(slice[0]);
      else waitSec = parseDurationProto(slice[0]);
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return { outputTokens, errorText, waitSec };
}

function parsePlannerConfigProto(buf: Uint8Array): readonly [number, number] {
  let pos = 0;
  let planModel = 0;
  let execModel = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 0 && fnum === 1) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      planModel = valRes[0];
      pos = valRes[1];
      continue;
    }
    if (wtype === 2 && fnum === 60) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      let subPos = 0;
      while (subPos < slice[0].length) {
        const subHeader = readProtoTag(slice[0], subPos);
        if (subHeader === null) break;
        const [sf, sw, stEnd] = subHeader;
        subPos = stEnd;
        if (sw === 0 && sf === 1) {
          const valRes = readSafeVarint(slice[0], subPos);
          if (valRes === null) break;
          execModel = valRes[0];
          subPos = valRes[1];
          continue;
        }
        subPos = skipWireValue(slice[0], subPos, sw);
        if (subPos < 0) break;
      }
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return [planModel, execModel];
}

interface ParsedChatModel {
  readonly row: GenMetadataRow;
  readonly retryInfos: readonly ParsedRetryInfo[];
  readonly retries: number;
  readonly truncationReason: number;
  readonly breakdown: ContextBreakdownCounts | null;
}

function parseChatModelProto(buf: Uint8Array, decodeBreakdown: boolean): ParsedChatModel {
  let pos = 0;
  const row: GenMetadataRow = {
    in: 0,
    out: 0,
    cw: 0,
    cr: 0,
    ttft: 0,
    stream: 0,
    ctxUsed: 0,
    ctxMax: 0,
    stepIdx: -1,
  };
  let modelEnum = 0;
  let modelEnumStr = '';
  let displayName = '';
  let responseModel = '';
  let retries = 0;
  let truncationReason = 0;
  let breakdown: ContextBreakdownCounts | null = null;
  const retryInfos: ParsedRetryInfo[] = [];

  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;

    if (fnum === 1 || fnum === 2 || fnum === 8 || fnum === 10 || fnum === 16) {
      pos = skipWireValue(buf, pos, wtype);
      if (pos < 0) break;
      continue;
    }
    if (wtype === 0 && (fnum === 3 || fnum === 14)) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      pos = valRes[1];
      if (fnum === 3) modelEnum = valRes[0];
      else retries = valRes[0];
      continue;
    }
    if (
      wtype === 2 &&
      (fnum === 4 ||
        fnum === 9 ||
        fnum === 11 ||
        fnum === 12 ||
        fnum === 17 ||
        fnum === 19 ||
        fnum === 20 ||
        fnum === 21)
    ) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      const [sub, nextPos] = slice;
      pos = nextPos;
      if (fnum === 4) {
        const usage = parseUsageProto(sub);
        row.in = usage.in;
        row.out = usage.out;
        row.cw = usage.cw;
        row.cr = usage.cr;
        if (usage.think > 0) row.think = usage.think;
        if (usage.resp > 0) row.resp = usage.resp;
      } else if (fnum === 9) {
        const ctxWin = parseChatStartProto(sub, decodeBreakdown);
        row.ctxUsed = ctxWin.used;
        row.ctxMax = ctxWin.limit;
        truncationReason = ctxWin.truncationReason;
        breakdown = ctxWin.breakdown;
      } else if (fnum === 11) {
        row.ttft = Math.round(parseDurationProto(sub) * 10000) / 10000;
      } else if (fnum === 12) {
        row.stream = Math.round(parseDurationProto(sub) * 10000) / 10000;
      } else if (fnum === 17) {
        retryInfos.push(parseRetryInfoProto(sub));
      } else if (fnum === 19) {
        responseModel = UTF8_DECODER.decode(sub);
      } else if (fnum === 20) {
        const [k, v] = parseKvPair(sub);
        if (k === 'last_step_index' && INT_STR_RE.test(v.trim())) {
          row.stepIdx = Number.parseInt(v.trim(), 10);
        } else if (k === 'model_enum' && v.trim().length > 0) {
          modelEnumStr = v.trim();
        }
      } else if (fnum === 21) {
        displayName = UTF8_DECODER.decode(sub);
      }
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }

  if (modelEnum > 0) row.modelEnum = modelEnum;
  const resolvedModel = resolveGenModelDisplayName({ displayName, modelEnumStr, modelEnum, responseModel });
  if (resolvedModel.length > 0) row.modelKey = resolvedModel;
  return { row, retryInfos, retries, truncationReason, breakdown };
}

function applyRetryAndErrorFields(
  row: GenMetadataRow,
  retries: number,
  retryInfos: readonly ParsedRetryInfo[],
  generationError: string,
): void {
  const canceled = isCanceledErrorText(generationError.trim());
  if (canceled) {
    row.canceled = true;
  } else {
    const terminalReason = classifyModelErrorReason(generationError);
    if (terminalReason !== null) row.errorCode = terminalReason;
  }

  let nonZeroOutAttempts = 0;
  let retryWaitSec = 0;
  let countedRetries = 0;
  const retryReasons: Partial<Record<ModelErrorReason, number>> = {};
  const retrySliceLen =
    generationError.length > 0 && retryInfos.length > 0 ? Math.max(0, retryInfos.length - 1) : retryInfos.length;

  for (let i = 0; i < retryInfos.length; i += 1) {
    const info = retryInfos[i];
    if (!info) continue;
    if (info.outputTokens > 0) nonZeroOutAttempts += 1;
    if (i < retrySliceLen && info.errorText.length > 0) {
      const reason = classifyModelErrorReason(info.errorText);
      if (reason !== null) {
        countedRetries += 1;
        retryReasons[reason] = (retryReasons[reason] ?? 0) + 1;
        if (info.waitSec > 0) retryWaitSec += info.waitSec;
      }
    }
  }

  const effectiveRetries = countedRetries > 0 ? countedRetries : retries > 0 && retryInfos.length === 0 ? retries : 0;
  if (effectiveRetries > 0) row.retries = effectiveRetries;
  if (retryWaitSec > 0) row.retryWaitSec = Math.round(retryWaitSec * 1000) / 1000;
  if (Object.keys(retryReasons).length > 0) row.retryReasons = retryReasons;
  if (nonZeroOutAttempts >= 2) row.quarantinedRate = true;
}

export function parseGenMetadataBlobWithTail(
  blob: Uint8Array | null | undefined,
  decodeTailExtras: boolean = true,
): ParsedGenMetadataWithTail | null {
  if (!blob || blob.length === 0 || blob.length > MAX_PROTO_BLOB_BYTES) return null;
  let pos = 0;
  let parsedChat: ParsedChatModel | null = null;
  let minStepIdx: number | null = null;
  let planModelEnum = 0;
  let execModelEnum = 0;
  let generationError = '';

  while (pos < blob.length) {
    const header = readProtoTag(blob, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;

    if (wtype === 2 && fnum === 1) {
      const slice = readLengthDelimited(blob, pos);
      if (slice === null || slice[0].length === 0) return null;
      parsedChat = parseChatModelProto(slice[0], decodeTailExtras);
      pos = slice[1];
      continue;
    }
    if (fnum === 2 && wtype === 2) {
      const slice = readLengthDelimited(blob, pos);
      if (slice === null) break;
      let p = 0;
      while (p < slice[0].length) {
        const v = readSafeVarint(slice[0], p);
        if (v === null) break;
        if (minStepIdx === null || v[0] < minStepIdx) minStepIdx = v[0];
        p = v[1];
      }
      pos = slice[1];
      continue;
    }
    if (fnum === 2 && wtype === 0) {
      const v = readSafeVarint(blob, pos);
      if (v === null) break;
      if (minStepIdx === null || v[0] < minStepIdx) minStepIdx = v[0];
      pos = v[1];
      continue;
    }
    if (wtype === 2 && fnum === 3 && decodeTailExtras) {
      const slice = readLengthDelimited(blob, pos);
      if (slice === null) break;
      [planModelEnum, execModelEnum] = parsePlannerConfigProto(slice[0]);
      pos = slice[1];
      continue;
    }
    if (wtype === 2 && fnum === 5) {
      const slice = readLengthDelimited(blob, pos);
      if (slice === null) break;
      generationError = UTF8_DECODER.decode(slice[0]);
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(blob, pos, wtype);
    if (pos < 0) break;
  }

  if (parsedChat === null) return null;
  if (minStepIdx !== null) parsedChat.row.minStepIdx = minStepIdx;
  applyRetryAndErrorFields(parsedChat.row, parsedChat.retries, parsedChat.retryInfos, generationError);
  return {
    row: parsedChat.row,
    tail: {
      breakdown: parsedChat.breakdown,
      truncationReason: parsedChat.truncationReason,
      planModelEnum,
      execModelEnum,
    },
  };
}

export function parseGenMetadataBlob(blob: Uint8Array | null | undefined): GenMetadataRow | null {
  return parseGenMetadataBlobWithTail(blob, false)?.row ?? null;
}
