import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { getErrCode, isPlainObject } from './core/guards.ts';

const RANDOM_HEX_START = 2;
const RANDOM_HEX_END = 8;
const POSIX_MODE_MASK = 0o777;

export type EntrySnapshotSync =
  | { readonly filePath: string; readonly kind: 'missing' }
  | { readonly filePath: string; readonly kind: 'symlink'; readonly linkTarget: string }
  | { readonly filePath: string; readonly kind: 'file'; readonly content: Buffer; readonly mode?: number };

export function makeTempSuffix(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(RANDOM_HEX_START, RANDOM_HEX_END)}`;
}

export function serializeJsonBuffer(payload: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

export function readJsonObjectSync(filePath: string, strict = true): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!strict) return null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
  if (!isPlainObject(parsed)) {
    if (!strict) return null;
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

function writeTempAtomicSync(filePath: string, writer: (tmpPath: string) => void): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${makeTempSuffix()}`;
  try {
    writer(tmpPath);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Preserve primary write error.
    }
    throw err;
  }
}

export function writeBufferAtomicSync(filePath: string, content: Buffer | string, mode?: number): void {
  writeTempAtomicSync(filePath, (tmpPath) => {
    writeFileSync(tmpPath, content, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined && process.platform !== 'win32') {
      chmodSync(tmpPath, mode);
    }
  });
}

export function writeSymlinkAtomicSync(filePath: string, linkTarget: string): void {
  writeTempAtomicSync(filePath, (tmpPath) => {
    symlinkSync(linkTarget, tmpPath);
  });
}

export function writeJsonAtomicSync(filePath: string, payload: unknown): void {
  writeBufferAtomicSync(filePath, serializeJsonBuffer(payload));
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
