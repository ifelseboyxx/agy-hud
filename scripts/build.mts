import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as viteBuild, type LogLevel } from 'vite';

import { isMainEntry, makeTempSuffix, realpathExistingPrefixSync } from '../src/core/fs-utils.ts';
import { getErrCode } from '../src/core/guards.ts';
import { isSameOrDescendantPath, toComparePath } from '../src/core/paths.ts';
import { createViteBuildConfig, HUD_ENTRY_INPUT, SHARED_ENTRY_INPUTS } from '../vite.config.ts';
import {
  assertValidTargetDir,
  DEFAULT_STALE_CHUNK_RETENTION_MS,
  FS_MAX_RETRIES,
  FS_RETRY_DELAY_MS,
  isOverlapComparePath,
  publishStagingDirSync,
  tryRemoveEmptyDirSync,
  type PublishStagingOptions,
  type PublishStagingResult,
  type ReplaceStagedFileHandler,
} from './lib/atomic-publish.ts';

export {
  DEFAULT_STALE_CHUNK_RETENTION_MS,
  publishStagingDirSync,
  type PublishStagingOptions,
  type PublishStagingResult,
  type ReplaceStagedFileHandler,
};

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_BUILD_REL_DIR = path.join('.cache', 'agy-hud-build');
const STAGING_MKDIR_RETRIES = 3;

export interface AtomicBuildOptions {
  readonly rootDir?: string;
  readonly outDir?: string;
  readonly logLevel?: LogLevel;
}

export interface AtomicBuildResult extends PublishStagingResult {
  readonly outDir: string;
}

function isWithinDir(parentDir: string, childDir: string): boolean {
  return isSameOrDescendantPath(
    toComparePath(realpathExistingPrefixSync(parentDir)),
    toComparePath(realpathExistingPrefixSync(childDir)),
  );
}

function ensureStagingDirSync(stagingDir: string): void {
  for (let attempt = 0; attempt <= STAGING_MKDIR_RETRIES; attempt += 1) {
    try {
      mkdirSync(stagingDir, { recursive: true });
      return;
    } catch (err) {
      if (getErrCode(err) === 'ENOENT' && attempt < STAGING_MKDIR_RETRIES) {
        continue;
      }
      throw err;
    }
  }
}

function assertSafeBuildOutDir(rootDir: string, outDir: string, stagingBoundary: string): void {
  assertValidTargetDir(outDir);
  const outCompare = toComparePath(realpathExistingPrefixSync(outDir));
  const rootCompare = toComparePath(realpathExistingPrefixSync(rootDir));
  if (isSameOrDescendantPath(outCompare, rootCompare)) {
    throw new Error(`Target directory overlaps project root: ${outDir} vs ${rootDir}`);
  }
  const sourceDirs = new Set<string>([path.join(rootDir, 'src')]);
  for (const relEntry of [...Object.values(HUD_ENTRY_INPUT), ...Object.values(SHARED_ENTRY_INPUTS)]) {
    sourceDirs.add(path.dirname(path.resolve(rootDir, relEntry)));
  }
  for (const srcDir of sourceDirs) {
    const srcCompare = toComparePath(realpathExistingPrefixSync(srcDir));
    if (isOverlapComparePath(outCompare, srcCompare)) {
      throw new Error(`Target directory overlaps source directory: ${outDir} vs ${srcDir}`);
    }
  }
  const stagingBoundaryCompare = toComparePath(realpathExistingPrefixSync(stagingBoundary));
  if (isOverlapComparePath(outCompare, stagingBoundaryCompare)) {
    throw new Error(`Target directory overlaps build staging path: ${outDir} vs ${stagingBoundary}`);
  }
}

export async function runAtomicBuild(options: AtomicBuildOptions = {}): Promise<AtomicBuildResult> {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const outDir = path.resolve(options.outDir ?? path.join(rootDir, 'dist'));

  const useRepoCache = isWithinDir(rootDir, outDir);
  const stagingParent = useRepoCache ? path.join(rootDir, CACHE_BUILD_REL_DIR) : path.dirname(outDir);
  const stagingDir = path.join(stagingParent, `.staging-${makeTempSuffix()}`);
  assertSafeBuildOutDir(rootDir, outDir, useRepoCache ? stagingParent : stagingDir);

  ensureStagingDirSync(stagingDir);
  try {
    const standaloneEntries: ReadonlyArray<readonly [string, string, boolean]> = [
      ...Object.entries(HUD_ENTRY_INPUT).map(([k, v]) => [k, v, false] as const),
      ...Object.entries(SHARED_ENTRY_INPUTS).map(([k, v]) => [k, v, k === 'index'] as const),
    ];
    await Promise.all(
      standaloneEntries.map(([name, entryPath, emitDts]) =>
        viteBuild(
          createViteBuildConfig({
            rootDir,
            outDir: stagingDir,
            input: { [name]: entryPath },
            emitDts,
            codeSplitting: false,
            logLevel: options.logLevel,
          }),
        ),
      ),
    );

    const published = publishStagingDirSync(stagingDir, outDir);
    return { outDir, ...published };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true, maxRetries: FS_MAX_RETRIES, retryDelay: FS_RETRY_DELAY_MS });
    if (useRepoCache) {
      tryRemoveEmptyDirSync(stagingParent);
      tryRemoveEmptyDirSync(path.join(rootDir, '.cache'));
    }
  }
}

if (isMainEntry(import.meta.url)) {
  void runAtomicBuild().then(
    (result) => {
      for (const warning of result.pruneWarnings) process.stderr.write(`Build warning: ${warning}\n`);
    },
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Build failed: ${detail}\n`);
      process.exitCode = 1;
    },
  );
}
