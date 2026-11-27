import type { ModelErrorReason } from '../types.ts';

export const UTF8_DECODER: InstanceType<typeof TextDecoder> = new TextDecoder('utf-8');
export const MAX_PROTO_BLOB_BYTES: number = 16 * 1024 * 1024;

const MAX_VARINT_BYTES = 10;
const MAX_SAFE_VARINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_UINT32_TAG = 0xffff_ffff;

export interface ContextBreakdownCounts {
  system: number;
  rules: number;
  skills: number;
  tools: number;
  mcp: number;
  messages: number;
}

export interface GenMetadataRow {
  in: number;
  out: number;
  cw: number;
  cr: number;
  ttft: number;
  stream: number;
  ctxUsed: number;
  ctxMax: number;
  stepIdx?: number;
  minStepIdx?: number;
  atSec?: number;
  think?: number;
  resp?: number;
  modelEnum?: number;
  modelKey?: string;
  retries?: number;
  retryWaitSec?: number;
  quarantinedRate?: boolean;
  retryReasons?: Partial<Record<ModelErrorReason, number>>;
  errorCode?: ModelErrorReason;
  canceled?: boolean;
}

export interface TailGenExtras {
  readonly breakdown: ContextBreakdownCounts | null;
  readonly truncationReason: number;
  readonly planModelEnum: number;
  readonly execModelEnum: number;
}

export interface StepTimestamps {
  readonly createdAtSec: number | null;
  readonly viewableAtSec: number | null;
  readonly finishedAtSec: number | null;
  readonly completedAtSec: number | null;
  readonly startedAtSec: number | null;
}

function readVarintRaw(buf: Uint8Array, start: number): readonly [bigint, number] | null {
  let val = 0n;
  let shift = 0n;
  let pos = start;
  for (let count = 0; count < MAX_VARINT_BYTES && pos < buf.length; count += 1) {
    const byte = buf[pos];
    if (byte === undefined) return null;
    if (count === MAX_VARINT_BYTES - 1 && byte > 0x01) return null;
    pos += 1;
    val |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [val, pos];
    shift += 7n;
  }
  return null;
}

export function readSafeVarint(buf: Uint8Array, start: number): readonly [number, number] | null {
  const raw = readVarintRaw(buf, start);
  if (raw === null || raw[0] > MAX_SAFE_VARINT) return null;
  return [Number(raw[0]), raw[1]];
}

export function readProtoTag(buf: Uint8Array, pos: number): readonly [number, number, number] | null {
  const tagRes = readSafeVarint(buf, pos);
  if (tagRes === null) return null;
  const [tag, tagEnd] = tagRes;
  if (tag <= 0 || tag > MAX_UINT32_TAG) return null;
  const fnum = tag >>> 3;
  if (fnum === 0) return null;
  return [fnum, tag & 7, tagEnd];
}

export function readLengthDelimited(buf: Uint8Array, pos: number): readonly [Uint8Array, number] | null {
  const lenRes = readSafeVarint(buf, pos);
  if (lenRes === null) return null;
  const [len, next] = lenRes;
  if (len < 0 || next + len > buf.length) return null;
  return [buf.subarray(next, next + len), next + len];
}

export function skipWireValue(buf: Uint8Array, pos: number, wireType: number): number {
  if (wireType === 0) {
    const raw = readVarintRaw(buf, pos);
    return raw !== null ? raw[1] : -1;
  }
  if (wireType === 1) return pos + 8 <= buf.length ? pos + 8 : -1;
  if (wireType === 2) {
    const slice = readLengthDelimited(buf, pos);
    return slice !== null ? slice[1] : -1;
  }
  if (wireType === 5) return pos + 4 <= buf.length ? pos + 4 : -1;
  return -1;
}

export function parseDurationProto(buf: Uint8Array): number {
  let pos = 0;
  let sec = 0;
  let nanos = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 0 && (fnum === 1 || fnum === 2)) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      pos = valRes[1];
      if (fnum === 1) sec = valRes[0];
      else nanos = valRes[0];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return sec + nanos / 1_000_000_000;
}
