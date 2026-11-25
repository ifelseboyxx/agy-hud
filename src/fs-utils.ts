import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { getErrCode, isPlainObject } from './core/guards.ts';

const TEMP_SUFFIX_RANDOM_BYTES = 8;
export const POSIX_MODE_MASK: number = 0o777;
export const DEFAULT_MAX_REGULAR_JSON_BYTES: number = 512 * 1024;
const REGULAR_JSON_CHUNK_BYTES = 65_536;
export const PRIVATE_FILE_MODE: number = 0o600;
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function decodeStrictUtf8(buf: Uint8Array): string {
  return STRICT_UTF8_DECODER.decode(buf);
}

export type EntrySnapshotSync =
  | { readonly filePath: string; readonly kind: 'missing' }
  | { readonly filePath: string; readonly kind: 'symlink'; readonly linkTarget: string }
  | { readonly filePath: string; readonly kind: 'file'; readonly content: Buffer; readonly mode?: number };

export function makeTempSuffix(): string {
  return `${process.pid}.${Date.now()}.${randomBytes(TEMP_SUFFIX_RANDOM_BYTES).toString('hex')}`;
}

export function serializeJsonBuffer(payload: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function readFdRange(fd: number, startOffset: number, length: number): Buffer {
  const safeLen = Math.max(0, length);
  if (safeLen === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(safeLen);
  let readPos = 0;
  while (readPos < safeLen) {
    const bytesRead = readSync(fd, buf, readPos, safeLen - readPos, startOffset + readPos);
    if (bytesRead <= 0) break;
    readPos += bytesRead;
  }
  return readPos < safeLen ? buf.subarray(0, readPos) : buf;
}

export function lstatIfPresentSync(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (err) {
    const code = getErrCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

export function statIfPresentSync(filePath: string): Stats | null {
  try {
    return statSync(filePath);
  } catch (err) {
    const code = getErrCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

export function hasDanglingSymlinkInChainSync(filePath: string): boolean {
  let cur = path.resolve(filePath);
  while (true) {
    try {
      if (lstatSync(cur).isSymbolicLink() && !existsSync(cur)) {
        return true;
      }
    } catch (err) {
      const code = getErrCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export interface JsonObjectWithHash {
  readonly raw: Record<string, unknown>;
  readonly sha256: string;
}

function readJsonObjectEntrySync(
  filePath: string,
  strict: boolean,
): { readonly raw: Record<string, unknown>; readonly buf: Buffer } | null {
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (err) {
    if (getErrCode(err) === 'ENOENT') {
      if (!hasDanglingSymlinkInChainSync(filePath)) return null;
      if (!strict) return null;
      throw new Error(`Failed to read ${filePath}: dangling symbolic link`);
    }
    if (!strict) return null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${filePath}: ${message}`);
  }
  let decoded: string;
  try {
    decoded = decodeStrictUtf8(buf);
  } catch (err) {
    if (!strict) return null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid UTF-8 in ${filePath}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    if (!strict) return null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
  if (!isPlainObject(parsed)) {
    if (!strict) return null;
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return { raw: parsed, buf };
}

export function readJsonObjectSync(filePath: string, strict = true): Record<string, unknown> | null {
  return readJsonObjectEntrySync(filePath, strict)?.raw ?? null;
}

export interface ReadRegularJsonOptions {
  readonly requirePrivateMode?: boolean;
}

function hasExcessivePosixMode(st: Stats): boolean {
  return process.platform !== 'win32' && (st.mode & 0o077) !== 0;
}

function readJsonObjectFromOpenFd(
  fd: number,
  maxBytes: number,
  requirePrivate: boolean,
): Record<string, unknown> | null {
  const fdStat = fstatSync(fd);
  if (!fdStat.isFile() || fdStat.size > maxBytes || (requirePrivate && hasExcessivePosixMode(fdStat))) {
    return null;
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const chunkBuf = Buffer.allocUnsafe(Math.min(Math.max(fdStat.size + 1, 1024), REGULAR_JSON_CHUNK_BYTES));
  while (true) {
    const bytesRead = readSync(fd, chunkBuf, 0, chunkBuf.length, null);
    if (bytesRead <= 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) return null;
    chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
  }
  const parsed: unknown = JSON.parse(decodeStrictUtf8(Buffer.concat(chunks, totalBytes)));
  return isPlainObject(parsed) ? parsed : null;
}

function readBoundedJsonInternal(
  filePath: string,
  maxBytes: number,
  followSymlinks: boolean,
  requirePrivate: boolean,
): Record<string, unknown> | null {
  let preStat: Stats | null;
  try {
    preStat = followSymlinks ? statIfPresentSync(filePath) : lstatIfPresentSync(filePath);
  } catch {
    return null;
  }
  if (
    preStat === null ||
    (!followSymlinks && preStat.isSymbolicLink()) ||
    !preStat.isFile() ||
    preStat.size > maxBytes ||
    (requirePrivate && hasExcessivePosixMode(preStat))
  ) {
    return null;
  }
  let flags = fsConstants.O_RDONLY;
  if (process.platform !== 'win32') {
    if (!followSymlinks && typeof fsConstants.O_NOFOLLOW === 'number') flags |= fsConstants.O_NOFOLLOW;
    if (typeof fsConstants.O_NONBLOCK === 'number') flags |= fsConstants.O_NONBLOCK;
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, flags);
    return readJsonObjectFromOpenFd(fd, maxBytes, requirePrivate);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure.
      }
    }
  }
}

export function readRegularJsonObjectSync(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_REGULAR_JSON_BYTES,
  options?: ReadRegularJsonOptions,
): Record<string, unknown> | null {
  return readBoundedJsonInternal(filePath, maxBytes, false, options?.requirePrivateMode === true);
}

export function readBoundedJsonObjectSync(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_REGULAR_JSON_BYTES,
): Record<string, unknown> | null {
  return readBoundedJsonInternal(filePath, maxBytes, true, false);
}

export function touchRegularFileTimesSync(filePath: string, nowMs: number): void {
  let preStat: Stats | null;
  try {
    preStat = lstatIfPresentSync(filePath);
  } catch {
    return;
  }
  if (preStat === null || preStat.isSymbolicLink() || !preStat.isFile()) return;
  const stamp = new Date(nowMs);
  if (process.platform === 'win32') {
    try {
      utimesSync(filePath, stamp, stamp);
    } catch {
      // Best-effort mtime refresh.
    }
    return;
  }
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NOFOLLOW === 'number') flags |= fsConstants.O_NOFOLLOW;
  if (typeof fsConstants.O_NONBLOCK === 'number') flags |= fsConstants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, flags);
    if (fstatSync(fd).isFile()) {
      futimesSync(fd, stamp, stamp);
    }
  } catch {
    // Best-effort mtime refresh.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure.
      }
    }
  }
}

export function readJsonObjectWithHashSync(filePath: string, strict = true): JsonObjectWithHash | null {
  const entry = readJsonObjectEntrySync(filePath, strict);
  if (entry === null) return null;
  return {
    raw: entry.raw,
    sha256: createHash('sha256').update(entry.buf).digest('hex'),
  };
}

function writeTempAtomicSync(
  filePath: string,
  writer: (tmpPath: string, markCreated: () => void) => void,
  tempSuffix: string = makeTempSuffix(),
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${tempSuffix}`;
  let created = false;
  const markCreated = (): void => {
    created = true;
  };
  try {
    writer(tmpPath, markCreated);
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (created) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Preserve primary write error.
      }
    }
    throw err;
  }
}

export function writeBufferAtomicSync(
  filePath: string,
  content: Buffer | string,
  mode?: number,
  tempSuffix?: string,
): void {
  writeTempAtomicSync(
    filePath,
    (tmpPath, markCreated) => {
      let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
      if (process.platform !== 'win32' && typeof fsConstants.O_NOFOLLOW === 'number') {
        flags |= fsConstants.O_NOFOLLOW;
      }
      let fd: number | undefined;
      try {
        fd = openSync(tmpPath, flags, mode ?? 0o666);
        markCreated();
        writeFileSync(fd, content);
        if (mode !== undefined && process.platform !== 'win32') {
          fchmodSync(fd, mode);
        }
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // Preserve primary write error.
          }
        }
      }
    },
    tempSuffix,
  );
}

export function writeSymlinkAtomicSync(filePath: string, linkTarget: string): void {
  writeTempAtomicSync(filePath, (tmpPath, markCreated) => {
    symlinkSync(linkTarget, tmpPath);
    markCreated();
  });
}

export function writeJsonAtomicSync(filePath: string, payload: unknown, mode?: number): void {
  writeBufferAtomicSync(filePath, serializeJsonBuffer(payload), mode);
}

export function captureEntrySnapshotSync(
  filePath: string,
  nonFileErrorPrefix = 'Refusing to overwrite or remove non-file entry',
): EntrySnapshotSync {
  const st = lstatIfPresentSync(filePath);
  if (!st) return { filePath, kind: 'missing' };
  if (st.isSymbolicLink()) return { filePath, kind: 'symlink', linkTarget: readlinkSync(filePath) };
  if (st.isFile()) return { filePath, kind: 'file', content: readFileSync(filePath), mode: st.mode & POSIX_MODE_MASK };
  throw new Error(`${nonFileErrorPrefix}: ${filePath}`);
}

export function restoreEntrySnapshotSync(snap: EntrySnapshotSync | null): void {
  if (!snap) return;
  if (snap.kind === 'missing') {
    if (lstatIfPresentSync(snap.filePath) !== null) {
      rmSync(snap.filePath, { force: true });
    }
    return;
  }
  if (snap.kind === 'symlink') {
    const cur = lstatIfPresentSync(snap.filePath);
    if (cur?.isSymbolicLink() && readlinkSync(snap.filePath) === snap.linkTarget) return;
    writeSymlinkAtomicSync(snap.filePath, snap.linkTarget);
    return;
  }
  const cur = lstatIfPresentSync(snap.filePath);
  if (cur?.isFile() && readFileSync(snap.filePath).equals(snap.content)) {
    if (snap.mode !== undefined && process.platform !== 'win32' && (cur.mode & POSIX_MODE_MASK) !== snap.mode) {
      chmodSync(snap.filePath, snap.mode);
    }
    return;
  }
  writeBufferAtomicSync(snap.filePath, snap.content, snap.mode);
}

export function restoreOwnedEntrySnapshotSync(snap: EntrySnapshotSync | null, expectedWritten: Buffer | null): void {
  if (!snap) return;
  const cur = lstatIfPresentSync(snap.filePath);
  if (expectedWritten !== null) {
    if (!cur?.isFile() || !readFileSync(snap.filePath).equals(expectedWritten)) {
      return;
    }
  } else if (cur !== null) {
    return;
  }
  restoreEntrySnapshotSync(snap);
}
