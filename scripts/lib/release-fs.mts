import { readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  captureEntrySnapshotSync,
  type EntrySnapshotSync,
  lstatIfPresentSync,
  restoreEntrySnapshotSync,
} from '../../src/core/fs-utils.ts';
import { isSameOrDescendantPath } from '../../src/core/paths.ts';
import { EXPECTED_DIST_FILES } from './dist-manifest.mts';

export interface DistSnapshotState {
  readonly snapshots: readonly EntrySnapshotSync[];
  readonly existingNames: ReadonlySet<string>;
}

export function assertSafeRepoWriteTarget(
  rootDir: string,
  relPath: string,
  options: { readonly allowMissing?: boolean } = {},
): string {
  const realRoot = realpathSync(rootDir);
  const absTarget = path.resolve(rootDir, relPath);
  const relFromRoot = path.relative(rootDir, absTarget);
  if (relFromRoot.length === 0 || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error(`Refusing to write outside repository root: ${relPath}`);
  }
  const segments = relFromRoot.split(path.sep).filter((s) => s.length > 0);
  let cur = rootDir;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cur = path.join(cur, segments[i]!);
    const dirSt = lstatIfPresentSync(cur);
    if (dirSt === null) {
      throw new Error(`Missing parent directory for release write target: ${relPath}`);
    }
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
      throw new Error(`Refusing to traverse symbolic link or non-directory ancestor for ${relPath}`);
    }
    if (!isSameOrDescendantPath(realRoot, realpathSync(cur))) {
      throw new Error(`Parent directory escapes repository root for ${relPath}`);
    }
  }

  const st = lstatIfPresentSync(absTarget);
  if (st === null) {
    if (options.allowMissing !== true) {
      throw new Error(`Missing required release target file: ${relPath}`);
    }
    const parentReal = realpathSync(path.dirname(absTarget));
    if (!isSameOrDescendantPath(realRoot, parentReal)) {
      throw new Error(`Target parent escapes repository root: ${relPath}`);
    }
    return absTarget;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing to write through symbolic link or non-regular file: ${relPath}`);
  }
  if (!isSameOrDescendantPath(realRoot, realpathSync(absTarget))) {
    throw new Error(`Release target escapes repository root: ${relPath}`);
  }
  return absTarget;
}

export function assertSafeRepoDistDir(rootDir: string): string {
  const realRoot = realpathSync(rootDir);
  const distDir = path.join(rootDir, 'dist');
  const distSt = lstatIfPresentSync(distDir);
  if (distSt === null) {
    return distDir;
  }
  if (distSt.isSymbolicLink() || !distSt.isDirectory()) {
    throw new Error('Refusing to use symbolic link or non-directory dist/ path during release prepare.');
  }
  const realDist = realpathSync(distDir);
  if (!isSameOrDescendantPath(realRoot, realDist)) {
    throw new Error('dist/ resolves outside repository root.');
  }
  for (const name of readdirSync(distDir)) {
    const entrySt = lstatIfPresentSync(path.join(distDir, name));
    if (entrySt !== null && entrySt.isSymbolicLink()) {
      throw new Error(`Refusing to prepare release with symbolic link in dist/: dist/${name}`);
    }
  }
  return distDir;
}

export function captureDistSnapshots(rootDir: string): DistSnapshotState {
  const distDir = assertSafeRepoDistDir(rootDir);
  const names = new Set<string>(EXPECTED_DIST_FILES);
  const existingNames = new Set<string>();
  const distSt = lstatIfPresentSync(distDir);
  if (distSt !== null && !distSt.isSymbolicLink() && distSt.isDirectory()) {
    for (const entry of readdirSync(distDir)) {
      names.add(entry);
      existingNames.add(entry);
    }
  }
  const snapshots: EntrySnapshotSync[] = [];
  for (const name of names) {
    snapshots.push(captureEntrySnapshotSync(path.join(distDir, name)));
  }
  return { snapshots, existingNames };
}

function removeEntryWithoutFollowingSymlink(entryPath: string): void {
  const st = lstatIfPresentSync(entryPath);
  if (st === null) return;
  if (st.isSymbolicLink() || st.isFile()) {
    rmSync(entryPath, { force: true });
    return;
  }
  rmSync(entryPath, { recursive: true, force: true });
}

export function rollbackCapturedFilesAndDist(
  rootDir: string,
  fileSnapshots: readonly EntrySnapshotSync[],
  distState: DistSnapshotState,
): string[] {
  const errors: string[] = [];
  let realRoot = '';
  try {
    realRoot = realpathSync(rootDir);
  } catch (e) {
    return [`resolve rootDir: ${e instanceof Error ? e.message : String(e)}`];
  }

  for (const snap of [...fileSnapshots, ...distState.snapshots]) {
    try {
      const parentReal = realpathSync(path.dirname(snap.filePath));
      if (!isSameOrDescendantPath(realRoot, parentReal)) {
        errors.push(`skip restore outside root: ${path.basename(snap.filePath)}`);
        continue;
      }
      if (snap.kind === 'missing') {
        removeEntryWithoutFollowingSymlink(snap.filePath);
      } else {
        restoreEntrySnapshotSync(snap);
      }
    } catch (e) {
      errors.push(`restore ${path.basename(snap.filePath)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const distDir = path.join(rootDir, 'dist');
  try {
    const distSt = lstatIfPresentSync(distDir);
    if (distSt !== null && !distSt.isSymbolicLink() && distSt.isDirectory()) {
      const realDist = realpathSync(distDir);
      if (isSameOrDescendantPath(realRoot, realDist)) {
        for (const name of readdirSync(distDir)) {
          if (!distState.existingNames.has(name)) {
            try {
              removeEntryWithoutFollowingSymlink(path.join(distDir, name));
            } catch (e) {
              errors.push(`remove dist/${name}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    }
  } catch (e) {
    errors.push(`scan dist/: ${e instanceof Error ? e.message : String(e)}`);
  }
  return errors;
}
