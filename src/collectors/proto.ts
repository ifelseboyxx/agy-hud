import type { GenMetadataRow } from '../types.ts';

const UTF8_DECODER = new TextDecoder('utf-8');
const INT_STR_RE = /^-?\d+$/;
const MAX_VARINT_BYTES = 10;
const MAX_SAFE_VARINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_UINT32_TAG = 0xffff_ffff;
export const MAX_PROTO_BLOB_BYTES: number = 1024 * 1024;

function readVarintRaw(buf: Uint8Array, start: number): readonly [bigint, number] | null {
  let val = 0n;
  let shift = 0n;
  let pos = start;
  for (let count = 0; count < MAX_VARINT_BYTES && pos < buf.length; count += 1) {
    const byte = buf[pos];
    if (byte === undefined) {
      return null;
    }
    if (count === MAX_VARINT_BYTES - 1 && byte > 0x01) {
      return null;
    }
    pos += 1;
    val |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [val, pos];
    }
    shift += 7n;
  }
  return null;
}

function readSafeVarint(buf: Uint8Array, start: number): readonly [number, number] | null {
  const raw = readVarintRaw(buf, start);
  if (raw === null || raw[0] > MAX_SAFE_VARINT) {
    return null;
  }
  return [Number(raw[0]), raw[1]];
}

function readProtoTag(buf: Uint8Array, pos: number): readonly [number, number, number] | null {
  const tagRes = readSafeVarint(buf, pos);
  if (tagRes === null) return null;
  const [tag, tagEnd] = tagRes;
  if (tag <= 0 || tag > MAX_UINT32_TAG) return null;
  const fnum = tag >>> 3;
  if (fnum === 0) return null;
  return [fnum, tag & 7, tagEnd];
}

function readLengthDelimited(buf: Uint8Array, pos: number): readonly [Uint8Array, number] | null {
  const lenRes = readSafeVarint(buf, pos);
  if (lenRes === null) return null;
  const [len, next] = lenRes;
  if (len < 0 || next + len > buf.length) return null;
  return [buf.subarray(next, next + len), next + len];
}

function skipWireValue(buf: Uint8Array, pos: number, wireType: number): number {
  if (wireType === 0) {
    const raw = readVarintRaw(buf, pos);
    return raw !== null ? raw[1] : -1;
  }
  if (wireType === 1) {
    return pos + 8 <= buf.length ? pos + 8 : -1;
  }
  if (wireType === 2) {
    const slice = readLengthDelimited(buf, pos);
    return slice !== null ? slice[1] : -1;
  }
  if (wireType === 5) {
    return pos + 4 <= buf.length ? pos + 4 : -1;
  }
  return -1;
}

export function parseKvStepIdx(buf: Uint8Array): number | null {
  if (buf.length === 0 || buf.length > MAX_PROTO_BLOB_BYTES) return null;
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
  if (key !== 'last_step_index') return null;
  const trimmed = val.trim();
  return INT_STR_RE.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function parseDurationProto(buf: Uint8Array): number {
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

function parseUsageProto(buf: Uint8Array): Pick<GenMetadataRow, 'in' | 'out' | 'cw' | 'cr'> {
  let pos = 0;
  const usage = { in: 0, out: 0, cw: 0, cr: 0 };
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 0 && fnum >= 2 && fnum <= 5) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      pos = valRes[1];
      if (fnum === 2) usage.in = valRes[0];
      else if (fnum === 3) usage.out = valRes[0];
      else if (fnum === 4) usage.cw = valRes[0];
      else usage.cr = valRes[0];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return usage;
}

function parseCtxWindowProto(buf: Uint8Array): readonly [number, number] {
  let pos = 0;
  let used = 0;
  let limit = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 0 && (fnum === 1 || fnum === 4)) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      pos = valRes[1];
      if (fnum === 1) used = valRes[0];
      else limit = valRes[0];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return [used, limit];
}

function parseChatStartProto(buf: Uint8Array): readonly [number, number] {
  let pos = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 10) {
      const slice = readLengthDelimited(buf, pos);
      return slice !== null ? parseCtxWindowProto(slice[0]) : [0, 0];
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return [0, 0];
}

function parseChatModelProto(buf: Uint8Array): GenMetadataRow {
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
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && (fnum === 4 || fnum === 9 || fnum === 11 || fnum === 12 || fnum === 20)) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      const [sub, nextPos] = slice;
      pos = nextPos;
      if (fnum === 4) {
        Object.assign(row, parseUsageProto(sub));
      } else if (fnum === 9) {
        const [used, max] = parseChatStartProto(sub);
        row.ctxUsed = used;
        row.ctxMax = max;
      } else if (fnum === 11) {
        row.ttft = Math.round(parseDurationProto(sub) * 10000) / 10000;
      } else if (fnum === 12) {
        row.stream = Math.round(parseDurationProto(sub) * 10000) / 10000;
      } else {
        const parsedStepIdx = parseKvStepIdx(sub);
        if (parsedStepIdx !== null) row.stepIdx = parsedStepIdx;
      }
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return row;
}

export function parseGenMetadataBlob(blob: Uint8Array | null | undefined): GenMetadataRow | null {
  if (!blob || blob.length === 0 || blob.length > MAX_PROTO_BLOB_BYTES) return null;
  let pos = 0;
  while (pos < blob.length) {
    const header = readProtoTag(blob, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 1) {
      const slice = readLengthDelimited(blob, pos);
      if (slice === null || slice[0].length === 0) return null;
      return parseChatModelProto(slice[0]);
    }
    pos = skipWireValue(blob, pos, wtype);
    if (pos < 0) break;
  }
  return null;
}
