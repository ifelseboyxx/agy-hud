import type { GenMetadataRow } from '../types.ts';

const UTF8_DECODER = new TextDecoder('utf-8');
const INT_STR_RE = /^-?\d+$/;

function readVarint(buf: Uint8Array, start: number): readonly [number, number] {
  let val = 0n;
  let shift = 0n;
  let pos = start;
  while (pos < buf.length) {
    const byte = buf[pos];
    if (byte === undefined) {
      break;
    }
    pos += 1;
    val |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [Number(val), pos];
    }
    shift += 7n;
  }
  return [Number(val), pos];
}

function skipWireValue(buf: Uint8Array, pos: number, wireType: number): number {
  if (wireType === 0) {
    const [, next] = readVarint(buf, pos);
    return next;
  }
  if (wireType === 1) {
    return pos + 8 <= buf.length ? pos + 8 : -1;
  }
  if (wireType === 2) {
    const [len, next] = readVarint(buf, pos);
    return len >= 0 && next + len <= buf.length ? next + len : -1;
  }
  if (wireType === 5) {
    return pos + 4 <= buf.length ? pos + 4 : -1;
  }
  return -1;
}

export function parseKvStepIdx(buf: Uint8Array): number | null {
  let pos = 0;
  let key = '';
  let val = '';
  while (pos < buf.length) {
    const [tag, tagEnd] = readVarint(buf, pos);
    pos = tagEnd;
    const fnum = tag >>> 3;
    const wtype = tag & 7;
    if (wtype === 2 && (fnum === 1 || fnum === 2)) {
      const [len, next] = readVarint(buf, pos);
      if (len < 0 || next + len > buf.length) {
        break;
      }
      const text = UTF8_DECODER.decode(buf.subarray(next, next + len));
      pos = next + len;
      if (fnum === 1) {
        key = text;
      } else {
        val = text;
      }
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) {
      break;
    }
  }
  if (key !== 'last_step_index') {
    return null;
  }
  const trimmed = val.trim();
  return INT_STR_RE.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function parseDurationProto(buf: Uint8Array): number {
  let pos = 0;
  let sec = 0;
  let nanos = 0;
  while (pos < buf.length) {
    const [tag, tagEnd] = readVarint(buf, pos);
    pos = tagEnd;
    const fnum = tag >>> 3;
    const wtype = tag & 7;
    if (wtype === 0 && (fnum === 1 || fnum === 2)) {
      const [val, next] = readVarint(buf, pos);
      pos = next;
      if (fnum === 1) {
        sec = val;
      } else {
        nanos = val;
      }
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) {
      break;
    }
  }
  return sec + nanos / 1_000_000_000;
}

function parseUsageProto(buf: Uint8Array): Pick<GenMetadataRow, 'in' | 'out' | 'cw' | 'cr'> {
  let pos = 0;
  const usage = { in: 0, out: 0, cw: 0, cr: 0 };
  while (pos < buf.length) {
    const [tag, tagEnd] = readVarint(buf, pos);
    pos = tagEnd;
    const fnum = tag >>> 3;
    const wtype = tag & 7;
    if (wtype === 0 && fnum >= 2 && fnum <= 5) {
      const [val, next] = readVarint(buf, pos);
      pos = next;
      if (fnum === 2) {
        usage.in = val;
      } else if (fnum === 3) {
        usage.out = val;
      } else if (fnum === 4) {
        usage.cw = val;
      } else {
        usage.cr = val;
      }
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) {
      break;
    }
  }
  return usage;
}

function parseCtxWindowProto(buf: Uint8Array): readonly [number, number] {
  let pos = 0;
  let used = 0;
  let limit = 0;
  while (pos < buf.length) {
    const [tag, tagEnd] = readVarint(buf, pos);
    pos = tagEnd;
    const fnum = tag >>> 3;
    const wtype = tag & 7;
    if (wtype === 0 && (fnum === 1 || fnum === 4)) {
      const [val, next] = readVarint(buf, pos);
      pos = next;
      if (fnum === 1) {
        used = val;
      } else {
        limit = val;
      }
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) {
      break;
    }
  }
  return [used, limit];
}

function parseChatStartProto(buf: Uint8Array): readonly [number, number] {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, tagEnd] = readVarint(buf, pos);
    pos = tagEnd;
    const fnum = tag >>> 3;
    const wtype = tag & 7;
    if (wtype === 2 && fnum === 10) {
      const [len, next] = readVarint(buf, pos);
      if (len < 0 || next + len > buf.length) {
        return [0, 0];
      }
      return parseCtxWindowProto(buf.subarray(next, next + len));
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) {
      break;
    }
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
    const [tag, tagEnd] = readVarint(buf, pos);
    pos = tagEnd;
    const fnum = tag >>> 3;
    const wtype = tag & 7;
    if (wtype === 2 && (fnum === 4 || fnum === 9 || fnum === 11 || fnum === 12 || fnum === 20)) {
      const [len, next] = readVarint(buf, pos);
      if (len < 0 || next + len > buf.length) {
        break;
      }
      const sub = buf.subarray(next, next + len);
      pos = next + len;
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
        if (parsedStepIdx !== null) {
          row.stepIdx = parsedStepIdx;
        }
      }
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) {
      break;
    }
  }
  return row;
}

export function parseGenMetadataBlob(blob: Uint8Array | null | undefined): GenMetadataRow | null {
  if (!blob || blob.length === 0) {
    return null;
  }
  let pos = 0;
  while (pos < blob.length) {
    const [tag, tagEnd] = readVarint(blob, pos);
    pos = tagEnd;
    const fnum = tag >>> 3;
    const wtype = tag & 7;
    if (wtype === 2 && fnum === 1) {
      const [len, next] = readVarint(blob, pos);
      if (len <= 0 || next + len > blob.length) {
        return null;
      }
      return parseChatModelProto(blob.subarray(next, next + len));
    }
    pos = skipWireValue(blob, pos, wtype);
    if (pos < 0) {
      break;
    }
  }
  return null;
}
