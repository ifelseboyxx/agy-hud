import {
  type ContextBreakdownCounts,
  MAX_PROTO_BLOB_BYTES,
  parseDurationProto,
  readLengthDelimited,
  readProtoTag,
  readSafeVarint,
  skipWireValue,
  type StepTimestamps,
  UTF8_DECODER,
} from './proto-wire.ts';

function parseChildTokenGroup(buf: Uint8Array): readonly [string, number] {
  let pos = 0;
  let name = '';
  let tokens = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 1) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      name = UTF8_DECODER.decode(slice[0]);
      pos = slice[1];
      continue;
    }
    if (wtype === 0 && fnum === 3) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      tokens = valRes[0];
      pos = valRes[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return [name, tokens];
}

function accumulateTopLevelTokenGroup(buf: Uint8Array, counts: ContextBreakdownCounts): boolean {
  let pos = 0;
  let name = '';
  let numTokens = 0;
  let mcpChildTokens = 0;
  let hasGroup = false;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 1) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      name = UTF8_DECODER.decode(slice[0]);
      hasGroup = true;
      pos = slice[1];
      continue;
    }
    if (wtype === 0 && fnum === 4) {
      const valRes = readSafeVarint(buf, pos);
      if (valRes === null) break;
      numTokens = valRes[0];
      hasGroup = true;
      pos = valRes[1];
      continue;
    }
    if (wtype === 2 && fnum === 5) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      const [childName, childTok] = parseChildTokenGroup(slice[0]);
      if (childName.startsWith('mcp_')) mcpChildTokens += childTok;
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  if (!hasGroup) return false;
  if (name === 'Rules') counts.rules += numTokens;
  else if (name === 'Skills') counts.skills += numTokens;
  else if (name === 'Mcp Tools') counts.mcp += numTokens;
  else if (name === 'Chat Messages') counts.messages += numTokens;
  else if (name === 'Tools') {
    const mcpPart = Math.min(numTokens, mcpChildTokens);
    counts.mcp += mcpPart;
    counts.tools += Math.max(0, numTokens - mcpPart);
  } else {
    counts.system += numTokens;
  }
  return true;
}

export function parseTokenBreakdownProto(buf: Uint8Array): ContextBreakdownCounts | null {
  const counts: ContextBreakdownCounts = { system: 0, rules: 0, skills: 0, tools: 0, mcp: 0, messages: 0 };
  let pos = 0;
  let groupCount = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 1) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      if (accumulateTopLevelTokenGroup(slice[0], counts)) groupCount += 1;
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return groupCount > 0 ? counts : null;
}

export function parseStepTimestampsProto(buf: Uint8Array | null | undefined): StepTimestamps {
  const result = {
    createdAtSec: null as number | null,
    viewableAtSec: null as number | null,
    finishedAtSec: null as number | null,
    completedAtSec: null as number | null,
    startedAtSec: null as number | null,
  };
  if (!buf || buf.length === 0 || buf.length > MAX_PROTO_BLOB_BYTES) return result;
  let pos = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && (fnum === 1 || fnum === 6 || fnum === 7 || fnum === 8 || fnum === 32)) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      const ts = parseDurationProto(slice[0]);
      if (ts > 0) {
        if (fnum === 1) result.createdAtSec = ts;
        else if (fnum === 6) result.viewableAtSec = ts;
        else if (fnum === 7) result.finishedAtSec = ts;
        else if (fnum === 8) result.completedAtSec = ts;
        else result.startedAtSec = ts;
      }
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return result;
}

function parseCapturedTextProto(buf: Uint8Array): string {
  let pos = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 1) {
      const slice = readLengthDelimited(buf, pos);
      return slice !== null ? UTF8_DECODER.decode(slice[0]) : '';
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return '';
}

export function parseCheckpointPayloadProto(buf: Uint8Array | null | undefined): string[] {
  if (!buf || buf.length === 0 || buf.length > MAX_PROTO_BLOB_BYTES) return [];
  const texts: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const header = readProtoTag(buf, pos);
    if (header === null) break;
    const [fnum, wtype, tagEnd] = header;
    pos = tagEnd;
    if (wtype === 2 && fnum === 30) {
      const slice = readLengthDelimited(buf, pos);
      if (slice === null) break;
      let subPos = 0;
      const inner = slice[0];
      while (subPos < inner.length) {
        const subHeader = readProtoTag(inner, subPos);
        if (subHeader === null) break;
        const [sf, sw, stEnd] = subHeader;
        subPos = stEnd;
        if (sw === 2 && sf === 5) {
          const s = readLengthDelimited(inner, subPos);
          if (s === null) break;
          const summary = UTF8_DECODER.decode(s[0]);
          if (summary.length > 0) texts.push(summary);
          subPos = s[1];
          continue;
        }
        if (sw === 2 && (sf === 30 || sf === 31)) {
          const s = readLengthDelimited(inner, subPos);
          if (s === null) break;
          const reqText = parseCapturedTextProto(s[0]);
          if (reqText.length > 0) texts.push(reqText);
          subPos = s[1];
          continue;
        }
        subPos = skipWireValue(inner, subPos, sw);
        if (subPos < 0) break;
      }
      pos = slice[1];
      continue;
    }
    pos = skipWireValue(buf, pos, wtype);
    if (pos < 0) break;
  }
  return texts;
}
