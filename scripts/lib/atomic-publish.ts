import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, utimesSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { parseSync, Visitor } from 'oxc-parser';

import { getTargetLockPath, withFileLocksSync } from '../../src/core/file-lock.ts';
import { getErrCode } from '../../src/core/guards.ts';
import {
  isSameOrDescendantPath,
  realpathExistingPrefixSync,
  toComparePath,
  toPosixPath,
} from '../../src/core/paths.ts';
import {
  captureEntrySnapshotSync,
  lstatIfPresentSync,
  restoreEntrySnapshotSync,
  writeBufferAtomicSync,
  type EntrySnapshotSync,
} from '../../src/fs-utils.ts';
import { EXPECTED_DIST_FILES } from './dist-manifest.mts';

const OWNED_CHUNKS_DIR = 'chunks';
const OWNED_TOP_LEVEL_FILES: ReadonlySet<string> = new Set(EXPECTED_DIST_FILES);
const POSIX_MODE_MASK = 0o777;
export const FS_MAX_RETRIES = 5;
export const FS_RETRY_DELAY_MS = 20;
const RETRYABLE_WIN_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

// Expired chunks are only pruned by the next publish; there is no background timer.
export const DEFAULT_STALE_CHUNK_RETENTION_MS = 60_000;

export type ReplaceStagedFileHandler = (
  srcPath: string,
  dstPath: string,
  defaultReplace: (src: string, dst: string) => void,
) => void;

export interface PublishStagingOptions {
  readonly lockPath?: string;
  readonly nowMs?: number;
  readonly staleChunkRetentionMs?: number;
  readonly replaceFileSync?: ReplaceStagedFileHandler;
}

export interface PublishStagingResult {
  readonly publishedFiles: readonly string[];
  readonly removedFiles: readonly string[];
  readonly pruneWarnings: readonly string[];
}

export function isOverlapComparePath(aCompare: string, bCompare: string): boolean {
  return isSameOrDescendantPath(aCompare, bCompare) || isSameOrDescendantPath(bCompare, aCompare);
}

export function assertValidTargetDir(resolvedTarget: string): void {
  const targetStat = lstatIfPresentSync(resolvedTarget);
  if (targetStat !== null && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
    throw new Error(`Target path must be a regular directory: ${resolvedTarget}`);
  }
}

export function tryRemoveEmptyDirSync(dirPath: string): void {
  try {
    if (readdirSync(dirPath).length === 0) {
      rmdirSync(dirPath);
    }
  } catch {
    // Ignore when missing, busy, or concurrently populated by another build.
  }
}

function statIdentityKey(st: Stats): string {
  return `${st.dev}:${st.ino}`;
}

// Exact owned name, or a case variant that the volume resolves to the same entry.
function matchesOwnedName(dir: string, name: string, ownedName: string): boolean {
  if (name === ownedName) return true;
  if (name.toLowerCase() !== ownedName) return false;
  const variantStat = lstatIfPresentSync(path.join(dir, name));
  const ownedStat = lstatIfPresentSync(path.join(dir, ownedName));
  return variantStat !== null && ownedStat !== null && statIdentityKey(variantStat) === statIdentityKey(ownedStat);
}

function isOwnedTopLevelFile(dir: string, name: string): boolean {
  const lowerName = name.toLowerCase();
  return OWNED_TOP_LEVEL_FILES.has(lowerName) && matchesOwnedName(dir, name, lowerName);
}

function assertDistinctBuildDirs(resolvedStaging: string, resolvedTarget: string): void {
  const stagingStat = lstatIfPresentSync(resolvedStaging);
  if (!stagingStat || !stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
    throw new Error(`Staging path must be an existing directory: ${resolvedStaging}`);
  }
  assertValidTargetDir(resolvedTarget);
  const stagingCompare = toComparePath(realpathSync(resolvedStaging));
  const targetCompare = toComparePath(realpathExistingPrefixSync(resolvedTarget));
  if (isOverlapComparePath(stagingCompare, targetCompare)) {
    throw new Error(`Staging and target directories must not overlap: ${resolvedStaging} vs ${resolvedTarget}`);
  }
}

function collectStagedRelFiles(rootDir: string, curDir: string = rootDir, out: string[] = []): string[] {
  for (const entry of readdirSync(curDir, { withFileTypes: true })) {
    const abs = path.join(curDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to publish symbolic link from staging directory: ${abs}`);
    }
    if (entry.isDirectory()) {
      collectStagedRelFiles(rootDir, abs, out);
    } else if (entry.isFile()) {
      out.push(toPosixPath(path.relative(rootDir, abs)));
    }
  }
  return out;
}

function prevalidateTargetPathsSync(resolvedTarget: string, relFiles: readonly string[]): void {
  const checkedDirs = new Set<string>();
  for (const rel of relFiles) {
    const segments = rel.split('/');
    let cur = resolvedTarget;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (seg === undefined) continue;
      cur = path.join(cur, seg);
      if (checkedDirs.has(cur)) continue;
      checkedDirs.add(cur);
      const st = lstatIfPresentSync(cur);
      if (st !== null && (st.isSymbolicLink() || !st.isDirectory())) {
        throw new Error(`Refusing to publish through non-directory or symbolic link path: ${cur}`);
      }
    }
    const dstPath = path.join(resolvedTarget, ...segments);
    const dstStat = lstatIfPresentSync(dstPath);
    if (dstStat !== null && (dstStat.isDirectory() || dstStat.isSymbolicLink())) {
      throw new Error(`Refusing to overwrite directory or symbolic link with staged file: ${dstPath}`);
    }
  }
}

function retryOnWinFsLockSync(action: () => void): void {
  for (let attempt = 0; attempt <= FS_MAX_RETRIES; attempt += 1) {
    try {
      action();
      return;
    } catch (err) {
      const code = getErrCode(err);
      if (
        process.platform === 'win32' &&
        code !== undefined &&
        RETRYABLE_WIN_FS_CODES.has(code) &&
        attempt < FS_MAX_RETRIES
      ) {
        Atomics.wait(RETRY_SLEEP_CELL, 0, 0, FS_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}

function renameStagedFileSync(srcPath: string, dstPath: string): void {
  mkdirSync(path.dirname(dstPath), { recursive: true });
  try {
    retryOnWinFsLockSync(() => {
      renameSync(srcPath, dstPath);
    });
  } catch (err) {
    if (getErrCode(err) !== 'EXDEV') throw err;
    const srcStat = lstatIfPresentSync(srcPath);
    const mode = srcStat ? srcStat.mode & POSIX_MODE_MASK : undefined;
    writeBufferAtomicSync(dstPath, readFileSync(srcPath), mode);
    rmSync(srcPath, { force: true, maxRetries: FS_MAX_RETRIES, retryDelay: FS_RETRY_DELAY_MS });
  }
}

function extractRelativeModuleSpecs(filePath: string, source: string): string[] {
  const parsed = parseSync(filePath, source);
  if (parsed.errors.length > 0) return [];
  const specs = new Set<string>();
  const addIfRelative = (val: string | undefined): void => {
    if (val && (val.startsWith('./') || val.startsWith('../'))) specs.add(val);
  };
  for (const imp of parsed.module.staticImports) addIfRelative(imp.moduleRequest.value);
  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) addIfRelative(entry.moduleRequest?.value);
  }
  const visitor = new Visitor({
    ImportExpression(node): void {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') addIfRelative(node.source.value);
    },
  });
  visitor.visit(parsed.program);
  return [...specs];
}

function collectPriorReferencedChunksSync(resolvedTarget: string): Set<string> {
  const referenced = new Set<string>();
  const targetStat = lstatIfPresentSync(resolvedTarget);
  if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) return referenced;

  const chunksRootCompare = toComparePath(path.join(resolvedTarget, OWNED_CHUNKS_DIR));
  const queue: string[] = [];
  const visited = new Set<string>();

  for (const entry of readdirSync(resolvedTarget, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!entry.name.toLowerCase().endsWith('.mjs') || !isOwnedTopLevelFile(resolvedTarget, entry.name)) continue;
    const abs = path.join(resolvedTarget, entry.name);
    queue.push(abs);
    visited.add(toComparePath(abs));
  }

  while (queue.length > 0) {
    const curFile = queue.shift();
    if (!curFile) continue;
    let source: string;
    try {
      source = readFileSync(curFile, 'utf8');
    } catch {
      continue;
    }
    const curDir = path.dirname(curFile);
    for (const spec of extractRelativeModuleSpecs(curFile, source)) {
      const candidate = path.resolve(curDir, spec);
      const st = lstatIfPresentSync(candidate);
      if (!st?.isFile() || st.isSymbolicLink()) continue;
      const comparePath = toComparePath(candidate);
      if (isSameOrDescendantPath(chunksRootCompare, comparePath)) referenced.add(comparePath);
      if (!visited.has(comparePath)) {
        visited.add(comparePath);
        queue.push(candidate);
      }
    }
  }
  return referenced;
}

function recordPublishedArtifact(
  dstPath: string,
  publishedComparePaths: Set<string>,
  publishedIdentities: Set<string>,
): void {
  publishedComparePaths.add(toComparePath(dstPath));
  try {
    publishedComparePaths.add(toComparePath(realpathSync(dstPath)));
  } catch {
    // Fall back to resolved path if realpath is transiently unavailable.
  }
  const st = lstatIfPresentSync(dstPath);
  if (st !== null) publishedIdentities.add(statIdentityKey(st));
}

function isPublishedArtifact(
  absPath: string,
  stat: Stats | null,
  publishedComparePaths: ReadonlySet<string>,
  publishedIdentities: ReadonlySet<string>,
): boolean {
  if (publishedComparePaths.has(toComparePath(absPath))) return true;
  return stat !== null && publishedIdentities.has(statIdentityKey(stat));
}

function rollbackPublishedEntriesSync(
  touchedSnapshots: readonly EntrySnapshotSync[],
  createdDirs: readonly string[],
): string[] {
  const errors: string[] = [];
  for (let i = touchedSnapshots.length - 1; i >= 0; i -= 1) {
    const snap = touchedSnapshots[i];
    if (!snap) continue;
    try {
      restoreEntrySnapshotSync(snap);
    } catch (rbErr) {
      errors.push(`${snap.filePath}: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
    }
  }
  for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
    const dirPath = createdDirs[i];
    if (dirPath) tryRemoveEmptyDirSync(dirPath);
  }
  return errors;
}

function collectMissingAncestorsSync(resolvedTarget: string, orderedRelFiles: readonly string[]): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  const addIfMissing = (dirPath: string): void => {
    const key = toComparePath(dirPath);
    if (seen.has(key)) return;
    seen.add(key);
    if (lstatIfPresentSync(dirPath) === null) missing.push(dirPath);
  };
  addIfMissing(resolvedTarget);
  for (const rel of orderedRelFiles) {
    const segments = rel.split('/');
    let cur = resolvedTarget;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (seg === undefined) continue;
      cur = path.join(cur, seg);
      addIfMissing(cur);
    }
  }
  return missing;
}

function pruneOwnedChunksDirSync(
  targetRoot: string,
  chunksDir: string,
  publishedComparePaths: ReadonlySet<string>,
  publishedIdentities: ReadonlySet<string>,
  priorReferencedChunks: ReadonlySet<string>,
  nowMs: number,
  retentionMs: number,
  removed: string[],
): void {
  for (const entry of readdirSync(chunksDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.toLowerCase().endsWith('.mjs')) continue;
    const abs = path.join(chunksDir, entry.name);
    const st = lstatIfPresentSync(abs);
    if (isPublishedArtifact(abs, st, publishedComparePaths, publishedIdentities)) continue;

    if (retentionMs > 0 && priorReferencedChunks.has(toComparePath(abs))) {
      const stamp = new Date(nowMs);
      try {
        utimesSync(abs, stamp, stamp);
      } catch {
        // Keep chunk even if timestamp update fails.
      }
      continue;
    }
    if (retentionMs > 0 && st !== null && nowMs - st.mtimeMs < retentionMs) continue;

    rmSync(abs, { force: true, maxRetries: FS_MAX_RETRIES, retryDelay: FS_RETRY_DELAY_MS });
    removed.push(toPosixPath(path.relative(targetRoot, abs)));
  }

  if (readdirSync(chunksDir).length === 0) {
    retryOnWinFsLockSync(() => {
      rmdirSync(chunksDir);
    });
  }
}

function pruneStaleOwnedArtifactsSync(
  targetRoot: string,
  publishedComparePaths: ReadonlySet<string>,
  publishedIdentities: ReadonlySet<string>,
  priorReferencedChunks: ReadonlySet<string>,
  nowMs: number,
  retentionMs: number,
  removed: string[],
): void {
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    const abs = path.join(targetRoot, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (matchesOwnedName(targetRoot, entry.name, OWNED_CHUNKS_DIR)) {
        pruneOwnedChunksDirSync(
          targetRoot,
          abs,
          publishedComparePaths,
          publishedIdentities,
          priorReferencedChunks,
          nowMs,
          retentionMs,
          removed,
        );
      }
      continue;
    }
    if (!entry.isFile() || !isOwnedTopLevelFile(targetRoot, entry.name)) continue;
    const st = lstatIfPresentSync(abs);
    if (isPublishedArtifact(abs, st, publishedComparePaths, publishedIdentities)) continue;
    rmSync(abs, { force: true, maxRetries: FS_MAX_RETRIES, retryDelay: FS_RETRY_DELAY_MS });
    removed.push(toPosixPath(path.relative(targetRoot, abs)));
  }
}

export function publishStagingDirSync(
  stagingDir: string,
  targetDir: string,
  options: PublishStagingOptions = {},
): PublishStagingResult {
  const resolvedStaging = path.resolve(stagingDir);
  const resolvedTarget = path.resolve(targetDir);
  assertDistinctBuildDirs(resolvedStaging, resolvedTarget);

  const lockPath = options.lockPath ?? getTargetLockPath(resolvedTarget);
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.staleChunkRetentionMs ?? DEFAULT_STALE_CHUNK_RETENTION_MS;
  const replaceFile = (srcPath: string, dstPath: string): void => {
    if (options.replaceFileSync) {
      options.replaceFileSync(srcPath, dstPath, renameStagedFileSync);
    } else {
      renameStagedFileSync(srcPath, dstPath);
    }
  };

  return withFileLocksSync([lockPath], () => {
    assertDistinctBuildDirs(resolvedStaging, resolvedTarget);
    const allRelFiles = collectStagedRelFiles(resolvedStaging).sort();
    const nestedFiles = allRelFiles.filter((rel) => rel.includes('/'));
    const topLevelFiles = allRelFiles.filter((rel) => !rel.includes('/'));
    const ordered = [...nestedFiles, ...topLevelFiles];

    prevalidateTargetPathsSync(resolvedTarget, ordered);
    const priorReferencedChunks = collectPriorReferencedChunksSync(resolvedTarget);
    const createdDirs = collectMissingAncestorsSync(resolvedTarget, ordered);
    const priorSnapshots = new Map<string, EntrySnapshotSync>();
    for (const rel of ordered) {
      const dstPath = path.join(resolvedTarget, ...rel.split('/'));
      priorSnapshots.set(dstPath, captureEntrySnapshotSync(dstPath));
    }

    mkdirSync(resolvedTarget, { recursive: true });

    const publishedComparePaths = new Set<string>();
    const publishedIdentities = new Set<string>();
    const touchedSnapshots: EntrySnapshotSync[] = [];

    try {
      for (const rel of ordered) {
        const relNative = rel.split('/').join(path.sep);
        const srcPath = path.join(resolvedStaging, relNative);
        const dstPath = path.join(resolvedTarget, relNative);
        const snap = priorSnapshots.get(dstPath);
        if (snap) touchedSnapshots.push(snap);
        replaceFile(srcPath, dstPath);
        recordPublishedArtifact(dstPath, publishedComparePaths, publishedIdentities);
      }
    } catch (err) {
      const rollbackErrors = rollbackPublishedEntriesSync(touchedSnapshots, createdDirs);
      if (rollbackErrors.length > 0) {
        const primary = err instanceof Error ? err.message : String(err);
        throw new Error(`${primary} (rollback also failed: ${rollbackErrors.join('; ')})`);
      }
      throw err;
    }

    // Entries are already live here, so cleanup failures must not report the publish as failed.
    const removedFiles: string[] = [];
    const pruneWarnings: string[] = [];
    try {
      pruneStaleOwnedArtifactsSync(
        resolvedTarget,
        publishedComparePaths,
        publishedIdentities,
        priorReferencedChunks,
        nowMs,
        retentionMs,
        removedFiles,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      pruneWarnings.push(`Published successfully, but stale artifact cleanup failed: ${detail}`);
    }
    removedFiles.sort();

    return {
      publishedFiles: ordered,
      removedFiles,
      pruneWarnings,
    };
  });
}
