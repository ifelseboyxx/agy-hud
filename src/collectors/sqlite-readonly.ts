/* @host-contract
 * Zero-mutation SQLite reader across CLI and Antigravity App/IDE roots (docs/host-contracts.md §2):
 * - Opens with `?immutable=1` when no active `-wal` exists; otherwise copies `<db>` + `<db>-wal` into `os.tmpdir()`
 *   (`0o600`) with pre/post header+tail version verification so host directories never gain `-wal`/`-shm` mutations.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, fstatSync, lstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { lstatIfPresentSync, readFdRange } from '../fs-utils.ts';

const SQLITE_TIMEOUT_MS = 50;
const WAL_COPY_MAX_ATTEMPTS = 4;
const TEMP_FILE_MODE = 0o600;
const SQLITE_HEADER_BYTES = 100;
const WAL_HEADER_BYTES = 32;
const WAL_TAIL_BYTES = 32;

export interface ReadonlyDbOptions {
  maxAttempts?: number;
  onAfterMainCopy?: (attempt: number) => void;
}

interface FileVersionSnapshot {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  headHex: string;
  tailHex: string;
}

interface WalPairSnapshot {
  db: FileVersionSnapshot | null;
  wal: FileVersionSnapshot | null;
}

const requireModule = createRequire(import.meta.url);
let cachedSqlite: typeof import('node:sqlite') | null | undefined;

function getSqliteModule(): typeof import('node:sqlite') | null {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    cachedSqlite = requireModule('node:sqlite') as typeof import('node:sqlite');
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

function closeDbQuietly(db: DatabaseSync | null): void {
  if (db === null) return;
  try {
    db.close();
  } catch {
    // Ignore close error on failed probe.
  }
}

function makeTempWritable(filePath: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(filePath, TEMP_FILE_MODE);
  } catch {
    // Best-effort permission normalization on temp snapshot copy.
  }
}

function readExactHex(fd: number, offset: number, length: number): string {
  return readFdRange(fd, offset, length).toString('hex');
}

function captureFileVersion(filePath: string, headBytes: number, tailBytes: number): FileVersionSnapshot | null {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(filePath, { bigint: true });
  } catch {
    return null;
  }
  if (lst.isSymbolicLink() || !lst.isFile()) return null;

  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.ino !== lst.ino) return null;
    const sizeNum = Number(st.size);
    const headLen = Math.min(sizeNum, headBytes);
    const headHex = readExactHex(fd, 0, headLen);
    let tailHex = '';
    if (tailBytes > 0 && sizeNum > 0) {
      const tailLen = Math.min(sizeNum, tailBytes);
      tailHex = readExactHex(fd, Math.max(0, sizeNum - tailLen), tailLen);
    }
    return {
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      ctimeNs: st.ctimeNs,
      headHex,
      tailHex,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function captureWalPairSnapshot(dbPath: string, walPath: string): WalPairSnapshot {
  return {
    db: captureFileVersion(dbPath, SQLITE_HEADER_BYTES, 0),
    wal: captureFileVersion(walPath, WAL_HEADER_BYTES, WAL_TAIL_BYTES),
  };
}

function isFileVersionEqual(a: FileVersionSnapshot | null, b: FileVersionSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.headHex === b.headHex &&
    a.tailHex === b.tailHex
  );
}

function isWalPairSnapshotEqual(a: WalPairSnapshot, b: WalPairSnapshot): boolean {
  return isFileVersionEqual(a.db, b.db) && isFileVersionEqual(a.wal, b.wal);
}

function isRegularNonSymlinkFile(filePath: string): boolean {
  let st: ReturnType<typeof lstatIfPresentSync>;
  try {
    st = lstatIfPresentSync(filePath);
  } catch {
    return false;
  }
  return st !== null && !st.isSymbolicLink() && st.isFile();
}

function hasUnsafeSqliteSidecar(dbPath: string): boolean {
  for (const suffix of ['-wal', '-shm']) {
    let st: ReturnType<typeof lstatIfPresentSync>;
    try {
      st = lstatIfPresentSync(`${dbPath}${suffix}`);
    } catch {
      return true;
    }
    if (st !== null && (st.isSymbolicLink() || !st.isFile())) {
      return true;
    }
  }
  return false;
}

export function readSqliteVersionTag(dbPath: string): string {
  if (!isRegularNonSymlinkFile(dbPath) || hasUnsafeSqliteSidecar(dbPath)) return '';
  const pair = captureWalPairSnapshot(dbPath, `${dbPath}-wal`);
  if (pair.db === null && pair.wal === null) return '';
  const fmt = (snap: FileVersionSnapshot | null): string =>
    snap === null ? 'none' : `${snap.ino}:${snap.size}:${snap.mtimeNs}:${snap.ctimeNs}:${snap.headHex}:${snap.tailHex}`;
  return createHash('sha256')
    .update(`${fmt(pair.db)}|${fmt(pair.wal)}`)
    .digest('hex')
    .slice(0, 24);
}

function openImmutableDb(dbPath: string): DatabaseSync | null {
  const sqlite = getSqliteModule();
  if (sqlite === null) return null;
  const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
  let db: DatabaseSync | null = null;
  try {
    db = new sqlite.DatabaseSync(uri, { readOnly: true, timeout: SQLITE_TIMEOUT_MS });
    db.prepare('PRAGMA schema_version').get();
    return db;
  } catch {
    closeDbQuietly(db);
    return null;
  }
}

function hasActiveWalFile(dbPath: string): boolean {
  try {
    const walStat = lstatIfPresentSync(`${dbPath}-wal`);
    return walStat !== null && !walStat.isSymbolicLink() && walStat.isFile() && walStat.size > 0;
  } catch {
    return false;
  }
}

function readViaTempWalSnapshot<T>(
  dbPath: string,
  reader: (db: DatabaseSync) => T,
  options?: ReadonlyDbOptions,
): { status: 'ok'; value: T } | { status: 'no-wal' } | { status: 'failed' } {
  const sqlite = getSqliteModule();
  if (sqlite === null) return { status: 'failed' };
  const walPath = `${dbPath}-wal`;
  const maxAttempts = Math.max(1, options?.maxAttempts ?? WAL_COPY_MAX_ATTEMPTS);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = captureWalPairSnapshot(dbPath, walPath);
    if (before.db === null) return { status: 'failed' };
    if (before.wal === null || before.wal.size === 0n) {
      return { status: 'no-wal' };
    }

    let tmpDir = '';
    let db: DatabaseSync | null = null;
    try {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-rodb-'));
      const tmpDbPath = path.join(tmpDir, 'snapshot.db');
      const tmpWalPath = `${tmpDbPath}-wal`;
      copyFileSync(dbPath, tmpDbPath);
      makeTempWritable(tmpDbPath);
      options?.onAfterMainCopy?.(attempt);
      copyFileSync(walPath, tmpWalPath);
      makeTempWritable(tmpWalPath);

      const after = captureWalPairSnapshot(dbPath, walPath);
      if (!isWalPairSnapshotEqual(before, after)) {
        continue;
      }
      const tmpDbStat = lstatIfPresentSync(tmpDbPath);
      const tmpWalStat = lstatIfPresentSync(tmpWalPath);
      if (
        tmpDbStat === null ||
        tmpWalStat === null ||
        BigInt(tmpDbStat.size) !== before.db.size ||
        BigInt(tmpWalStat.size) !== before.wal.size
      ) {
        continue;
      }

      db = new sqlite.DatabaseSync(tmpDbPath, { timeout: SQLITE_TIMEOUT_MS });
      db.prepare('PRAGMA schema_version').get();
      const value = reader(db);
      return { status: 'ok', value };
    } catch {
      // Retry if the live writer checkpointed or rotated WAL mid-copy.
    } finally {
      closeDbQuietly(db);
      if (tmpDir.length > 0) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Ignore temp cleanup errors.
        }
      }
    }
  }
  return { status: 'failed' };
}

export function withReadonlyDb<T>(
  dbPath: string,
  reader: (db: DatabaseSync) => T,
  options?: ReadonlyDbOptions,
): T | null {
  if (!isRegularNonSymlinkFile(dbPath) || hasUnsafeSqliteSidecar(dbPath)) return null;
  if (hasActiveWalFile(dbPath)) {
    const snap = readViaTempWalSnapshot(dbPath, reader, options);
    if (snap.status === 'ok') {
      return snap.value;
    }
    if (snap.status === 'failed' && hasActiveWalFile(dbPath)) {
      return null;
    }
  }
  const db = openImmutableDb(dbPath);
  if (db === null) {
    return null;
  }
  try {
    return reader(db);
  } catch {
    return null;
  } finally {
    closeDbQuietly(db);
  }
}
