import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { toComparePath } from '../../core/paths.ts';
import { lstatIfPresentSync, readJsonObjectSync } from '../../fs-utils.ts';

const EXECUTABLE_FILE_MODE = 0o755;
const RM_MAX_RETRIES = 3;
const RM_RETRY_DELAY_MS = 100;

export type RollbackStep = readonly [label: string, action: () => void];

export interface TargetRelationship {
  sameDirectory: boolean;
}

export function makeRollbackError(primaryErr: unknown, rollbackErrors: readonly string[]): unknown {
  if (rollbackErrors.length === 0) return primaryErr;
  const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
  return new Error(`${primaryMsg} (rollback also failed: ${rollbackErrors.join('; ')})`);
}

export function runRollbackSteps(steps: readonly RollbackStep[]): string[] {
  const errors: string[] = [];
  for (const [label, fn] of steps) {
    try {
      fn();
    } catch (rbErr) {
      errors.push(`${label}: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
    }
  }
  return errors;
}

function isStrictAncestorPath(ancestorPath: string, descendantPath: string): boolean {
  const rel = path.relative(ancestorPath, descendantPath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function assertRuntimeFilesPresent(srcRoot: string, runtimeFiles: readonly string[]): void {
  for (const rel of runtimeFiles) {
    if (lstatIfPresentSync(path.join(srcRoot, rel)) === null) {
      throw new Error(`Missing required file: ${rel}. Run 'pnpm build' first.`);
    }
  }
}

export function inspectTargetRelationship(
  resolvedSrc: string,
  resolvedDst: string,
  dstStat: Stats | null,
): TargetRelationship {
  if (!dstStat || dstStat.isSymbolicLink()) return { sameDirectory: false };
  const srcCompare = toComparePath(resolvedSrc);
  const dstCompare = toComparePath(realpathSync(resolvedDst));
  if (isStrictAncestorPath(dstCompare, srcCompare)) {
    throw new Error(`Refusing to modify ${resolvedDst}: ancestor directory of ${resolvedSrc}.`);
  }
  return { sameDirectory: srcCompare === dstCompare };
}

export function assertNotActiveSourceRepo(resolvedSrc: string, resolvedDst: string, dstStat: Stats | null): void {
  if (!dstStat) return;
  const { sameDirectory } = inspectTargetRelationship(resolvedSrc, resolvedDst, dstStat);
  if (sameDirectory && lstatIfPresentSync(path.join(resolvedSrc, 'src')) !== null) {
    throw new Error(`Refusing to delete active source repository at ${resolvedDst}.`);
  }
}

export function assertRemovableTarget(targetPath: string, stat: Stats | null, pluginName: string): void {
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) throw new Error(`Refusing to delete ${targetPath}: not a plugin directory or symlink.`);
  if (readdirSync(targetPath).length === 0) return;
  const manifest = readJsonObjectSync(path.join(targetPath, 'plugin.json'), false);
  if (manifest?.name !== pluginName) {
    throw new Error(`Refusing to delete ${targetPath}: missing plugin.json with name "${pluginName}".`);
  }
}

export function assertDirectoryTreeRemovable(dirPath: string): void {
  accessSync(dirPath, fsConstants.W_OK | fsConstants.X_OK);
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      assertDirectoryTreeRemovable(path.join(dirPath, entry.name));
    }
  }
}

export function isSameStatIdentity(a: Stats | null, b: Stats | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.isSymbolicLink() === b.isSymbolicLink() &&
    a.isDirectory() === b.isDirectory()
  );
}

export function moveVerifiedTarget(targetPath: string, expectedStat: Stats, stagedPath: string): void {
  const beforeStat = lstatIfPresentSync(targetPath);
  if (!isSameStatIdentity(beforeStat, expectedStat)) {
    throw new Error(`Target changed before staging: ${targetPath}`);
  }
  renameSync(targetPath, stagedPath);
  const movedStat = lstatIfPresentSync(stagedPath);
  if (!isSameStatIdentity(movedStat, expectedStat)) {
    if (movedStat !== null && lstatIfPresentSync(targetPath) === null) {
      try {
        renameSync(stagedPath, targetPath);
      } catch {
        // Ignore rollback rename failure.
      }
    }
    throw new Error(`Target changed while staging ${targetPath}; aborted without deleting ${stagedPath}`);
  }
}

export function removeVerifiedStagedPath(stagedPath: string, expectedStat: Stats): void {
  const curStat = lstatIfPresentSync(stagedPath);
  if (!curStat) return;
  if (!isSameStatIdentity(curStat, expectedStat)) {
    throw new Error(`Refusing to delete modified staged entry: ${stagedPath}`);
  }
  removeTargetPath(stagedPath, curStat);
}

export function removeTargetPath(targetPath: string, stat: Stats | null): void {
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    unlinkSync(targetPath);
    return;
  }
  rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: RM_MAX_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS,
  });
}

export function copyRuntimeFiles(srcRoot: string, dstRoot: string, runtimeFiles: readonly string[]): void {
  mkdirSync(dstRoot, { recursive: true });
  for (const rel of [...runtimeFiles, 'README.md', 'package.json']) {
    const src = path.join(srcRoot, rel);
    if (lstatIfPresentSync(src) === null) continue;
    const dst = path.join(dstRoot, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  for (const dirRel of ['skills', 'dist/chunks']) {
    const srcDir = path.join(srcRoot, dirRel);
    if (lstatIfPresentSync(srcDir) !== null) {
      cpSync(srcDir, path.join(dstRoot, dirRel), { recursive: true });
    }
  }
  for (const rel of ['dist/hud.mjs', 'dist/cli.mjs', 'dist/mcp-hud.mjs']) {
    try {
      chmodSync(path.join(dstRoot, rel), EXECUTABLE_FILE_MODE);
    } catch {
      // Ignore chmod errors on platforms without POSIX mode bits.
    }
  }
}
