import { createHash, type Hash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { readFdRange } from '../fs-utils.ts';

const HASH_CHUNK_BYTES = 65_536;
export const FULL_HASH_MAX_BYTES: number = 512 * 1024;
const SAMPLE_WINDOW_BYTES = 8 * 1024;

function hashSampledSlices(endOffset: number, readSlice: (offset: number, len: number) => Buffer): string {
  const hash = createHash('sha256');
  hash.update(`len:${endOffset}|`);
  const midStart = Math.max(0, Math.floor((endOffset - SAMPLE_WINDOW_BYTES) / 2));
  const tailStart = Math.max(0, endOffset - SAMPLE_WINDOW_BYTES);
  hash.update(readSlice(0, Math.min(SAMPLE_WINDOW_BYTES, endOffset)));
  hash.update('|');
  hash.update(readSlice(midStart, Math.min(SAMPLE_WINDOW_BYTES, endOffset - midStart)));
  hash.update('|');
  hash.update(readSlice(tailStart, Math.min(SAMPLE_WINDOW_BYTES, endOffset - tailStart)));
  return `sample:${hash.digest('hex').slice(0, 24)}`;
}

export function computeFullFdRangeHash(fd: number, endOffset: number): { digest: string; fullHash: Hash | null } {
  if (endOffset <= 0) return { digest: 'empty', fullHash: null };
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(Math.min(endOffset, HASH_CHUNK_BYTES));
  let pos = 0;
  while (pos < endOffset) {
    const toRead = Math.min(buf.length, endOffset - pos);
    const bytesRead = readSync(fd, buf, 0, toRead, pos);
    if (bytesRead <= 0) break;
    hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return { digest: `full:${hash.copy().digest('hex').slice(0, 24)}`, fullHash: hash };
}

export function computeFdRangeFingerprint(fd: number, endOffset: number): { digest: string; fullHash: Hash | null } {
  if (endOffset <= 0) return { digest: 'empty', fullHash: null };
  if (endOffset > FULL_HASH_MAX_BYTES) {
    return { digest: hashSampledSlices(endOffset, (off, len) => readFdRange(fd, off, len)), fullHash: null };
  }
  return computeFullFdRangeHash(fd, endOffset);
}

function readCombinedRange(fd: number, startOffset: number, chunkBuf: Buffer, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  if (offset >= startOffset) {
    const rel = offset - startOffset;
    return chunkBuf.subarray(rel, Math.min(chunkBuf.length, rel + length));
  }
  const end = offset + length;
  if (end <= startOffset) {
    return readFdRange(fd, offset, length);
  }
  const headPart = readFdRange(fd, offset, startOffset - offset);
  const tailPart = chunkBuf.subarray(0, Math.min(chunkBuf.length, end - startOffset));
  return Buffer.concat([headPart, tailPart]);
}

export function computeFullParsedRangeHash(
  fd: number,
  startOffset: number,
  chunkBuf: Buffer,
  endOffset: number,
  prefixHash: Hash | null,
): string {
  if (endOffset <= 0) return 'empty';
  if (startOffset === 0) {
    const hash = createHash('sha256').update(chunkBuf.subarray(0, endOffset));
    return `full:${hash.digest('hex').slice(0, 24)}`;
  }
  if (prefixHash !== null) {
    const hash = prefixHash.copy().update(chunkBuf.subarray(0, Math.max(0, endOffset - startOffset)));
    return `full:${hash.digest('hex').slice(0, 24)}`;
  }
  const base = computeFullFdRangeHash(fd, startOffset).fullHash ?? createHash('sha256');
  base.update(chunkBuf.subarray(0, Math.max(0, endOffset - startOffset)));
  return `full:${base.digest('hex').slice(0, 24)}`;
}

export function computeParsedRangeFingerprint(
  fd: number,
  startOffset: number,
  chunkBuf: Buffer,
  endOffset: number,
  prefixHash: Hash | null,
): string {
  if (endOffset <= 0) return 'empty';
  if (endOffset > FULL_HASH_MAX_BYTES) {
    return hashSampledSlices(endOffset, (off, len) => readCombinedRange(fd, startOffset, chunkBuf, off, len));
  }
  return computeFullParsedRangeHash(fd, startOffset, chunkBuf, endOffset, prefixHash);
}

export function computeFileContentHash(filePath: string): string {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return '';
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return '';
    const size = Number(st.size);
    const { digest } = computeFdRangeFingerprint(fd, size);
    return size <= FULL_HASH_MAX_BYTES ? digest : `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${digest}`;
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}
