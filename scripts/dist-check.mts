import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSync } from 'oxc-parser';
import ts from 'typescript';

import { isMainEntry } from '../src/core/fs-utils.ts';
import { toPosixPath } from '../src/core/paths.ts';
import { runAtomicBuild } from './build.mts';
import { EXECUTABLE_REPO_PATHS, EXPECTED_DIST_FILES } from './lib/dist-manifest.mts';

export { EXECUTABLE_REPO_PATHS, EXPECTED_DIST_FILES };

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

interface DistScanResult {
  readonly files: string[];
  readonly unexpectedEntries: string[];
}

function scanDistDirectory(dirPath: string): DistScanResult {
  const files: string[] = [];
  const unexpectedEntries: string[] = [];
  if (!existsSync(dirPath)) return { files, unexpectedEntries };
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      const rel = toPosixPath(path.relative(dirPath, abs));
      if (entry.isSymbolicLink()) {
        unexpectedEntries.push(`symlink dist/${rel}`);
      } else if (entry.isDirectory()) {
        unexpectedEntries.push(`directory dist/${rel}`);
        walk(abs);
      } else if (entry.isFile()) {
        files.push(rel);
      } else {
        unexpectedEntries.push(`non-regular entry dist/${rel}`);
      }
    }
  };
  walk(dirPath);
  files.sort();
  unexpectedEntries.sort();
  return { files, unexpectedEntries };
}

export function compareDistTrees(actualDistDir: string, expectedDistDir: string): string[] {
  const errors: string[] = [];
  if (!existsSync(actualDistDir)) {
    return [`missing dist directory: ${actualDistDir} (run 'pnpm build')`];
  }

  const actualScan = scanDistDirectory(actualDistDir);
  const expectedScan = scanDistDirectory(expectedDistDir);
  for (const item of actualScan.unexpectedEntries) {
    errors.push(`tracked dist/ contains unexpected ${item} (must contain strictly 5 regular files)`);
  }
  for (const item of expectedScan.unexpectedEntries) {
    errors.push(`fresh build produced unexpected ${item} (must emit strictly 5 regular files)`);
  }
  const actualFiles = actualScan.files;
  const expectedFiles = expectedScan.files;
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);

  const expectedAllowed = new Set(EXPECTED_DIST_FILES);
  for (const rel of EXPECTED_DIST_FILES) {
    if (!expectedSet.has(rel)) {
      errors.push(`fresh build did not produce expected file dist/${rel}`);
    }
  }
  for (const rel of expectedFiles) {
    if (!expectedAllowed.has(rel)) {
      errors.push(`fresh build produced unexpected extra file dist/${rel} (must emit strictly 5 standalone files)`);
    }
  }
  for (const rel of expectedFiles) {
    if (!actualSet.has(rel)) {
      errors.push(`tracked dist/ is missing dist/${rel} (run 'pnpm build')`);
    }
  }
  for (const rel of actualFiles) {
    if (!expectedSet.has(rel)) {
      errors.push(`tracked dist/ contains unexpected or stale file dist/${rel} (remove stale artifact or rebuild)`);
    }
  }
  for (const rel of expectedFiles) {
    if (!actualSet.has(rel)) continue;
    const actualHash = sha256File(path.join(actualDistDir, rel));
    const expectedHash = sha256File(path.join(expectedDistDir, rel));
    if (actualHash !== expectedHash) {
      errors.push(`dist/${rel} is out of date with src/ (run 'pnpm build' and commit updated dist/)`);
    }
  }
  return errors;
}

export function parseGitLsFilesModes(stdout: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const tabIdx = line.indexOf('\t');
    if (tabIdx <= 0) continue;
    const mode = line.slice(0, tabIdx).trim().split(/\s+/)[0] ?? '';
    const filePath = line.slice(tabIdx + 1).trim();
    if (mode.length > 0 && filePath.length > 0) {
      modes.set(filePath, mode);
    }
  }
  return modes;
}

export interface CheckExecutableModesOptions {
  readonly requireTrackedInGit?: boolean;
}

export function checkExecutableModes(
  rootDir: string,
  relPaths: readonly string[] = EXECUTABLE_REPO_PATHS,
  platform: NodeJS.Platform = process.platform,
  options: CheckExecutableModesOptions = {},
): string[] {
  const errors: string[] = [];
  for (const rel of relPaths) {
    const abs = path.join(rootDir, rel);
    if (!existsSync(abs)) {
      errors.push(`missing executable entrypoint: ${rel}`);
      continue;
    }
    if (platform !== 'win32') {
      const mode = statSync(abs).mode & 0o777;
      if ((mode & 0o111) === 0) {
        errors.push(`${rel} is missing POSIX execute bits (mode 0o${mode.toString(8)}, expected 0o755)`);
      }
    }
  }

  if (existsSync(path.join(rootDir, '.git'))) {
    const res = spawnSync('git', ['ls-files', '--stage', '--', ...relPaths], {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.error || res.status !== 0) {
      const detail = res.error ? res.error.message : (res.stderr ?? '').trim() || `exit ${String(res.status)}`;
      errors.push(`git ls-files --stage failed while verifying executable modes: ${detail}`);
      return errors;
    }
    const trackedModes = parseGitLsFilesModes(res.stdout ?? '');
    const requireTracked = options.requireTrackedInGit ?? process.env.CI === 'true';
    for (const rel of relPaths) {
      const mode = trackedModes.get(rel);
      if (mode === undefined) {
        if (requireTracked) {
          errors.push(`${rel} is not tracked in the Git index (expected tracked mode 100755)`);
        }
        continue;
      }
      if (mode !== '100755') {
        errors.push(`${rel} has Git index mode ${mode} (expected 100755; run 'git update-index --chmod=+x ${rel}')`);
      }
    }
  }
  return errors;
}

function verifyDtsRelativeSpecifiers(distDir: string, dtsFile: string): string[] {
  const errors: string[] = [];
  const fullPath = path.join(distDir, dtsFile);
  const parsed = parseSync(fullPath, readFileSync(fullPath, 'utf8'));
  for (const err of parsed.errors) {
    errors.push(`dist declaration syntax error (${dtsFile}): ${err.message}`);
  }
  const specs = new Set<string>();
  for (const imp of parsed.module.staticImports) specs.add(imp.moduleRequest.value);
  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest?.value) specs.add(entry.moduleRequest.value);
    }
  }
  for (const spec of specs) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    if (!spec.endsWith('.mjs')) {
      errors.push(`dist declaration (${dtsFile}) contains non-.mjs relative specifier '${spec}'`);
      continue;
    }
    const expectedDts = path.resolve(distDir, spec.replace(/\.mjs$/, '.d.mts'));
    if (!expectedDts.startsWith(distDir) || !existsSync(expectedDts)) {
      errors.push(`dist declaration (${dtsFile}) references missing target for '${spec}'`);
    }
  }
  return errors;
}

export function verifyDistDeclarations(distDir: string): string[] {
  const indexDts = path.join(distDir, 'index.d.mts');
  const typesDts = path.join(distDir, 'types.d.mts');
  if (!existsSync(indexDts) || !existsSync(typesDts)) {
    return [];
  }

  const specifierErrors = [
    ...verifyDtsRelativeSpecifiers(distDir, 'index.d.mts'),
    ...verifyDtsRelativeSpecifiers(distDir, 'types.d.mts'),
  ];
  if (specifierErrors.length > 0) {
    return specifierErrors;
  }

  const consumerPath = path.join(distDir, '__dist_check_consumer__.mts');
  const consumerSource = [
    'import { configureHud, exportProfile, importProfile, renderHudFromData, type HudConfig } from "./index.mjs";',
    'export const sdkFns = [configureHud, exportProfile, importProfile, renderHudFromData] as const;',
    'export type SdkConfig = HudConfig;',
    '',
  ].join('\n');
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    skipDefaultLibCheck: true,
    types: ['node'],
  };

  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const origGetSourceFile = baseHost.getSourceFile.bind(baseHost);
  const origFileExists = baseHost.fileExists.bind(baseHost);
  const origReadFile = baseHost.readFile.bind(baseHost);

  baseHost.fileExists = (fileName: string): boolean => {
    if (path.resolve(fileName) === consumerPath) return true;
    return origFileExists(fileName);
  };
  baseHost.readFile = (fileName: string): string | undefined => {
    if (path.resolve(fileName) === consumerPath) return consumerSource;
    return origReadFile(fileName);
  };
  baseHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (path.resolve(fileName) === consumerPath) {
      return ts.createSourceFile(fileName, consumerSource, languageVersion, true);
    }
    return origGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram([consumerPath, indexDts, typesDts], compilerOptions, baseHost);
  const diagnostics: ts.Diagnostic[] = [...program.getOptionsDiagnostics()];
  for (const targetFile of [consumerPath, indexDts, typesDts]) {
    const sf = program.getSourceFile(targetFile);
    if (!sf) continue;
    diagnostics.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
  }

  return diagnostics.map((diag) => {
    const msg = ts.flattenDiagnosticMessageText(diag.messageText, ' ');
    if (diag.file && diag.start !== undefined) {
      const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
      const rel = path.basename(diag.file.fileName);
      return `dist declaration error (${rel}:${pos.line + 1}:${pos.character + 1}): ${msg}`;
    }
    return `dist declaration error: ${msg}`;
  });
}

export function checkGitDistClean(rootDir: string): string[] {
  const errors: string[] = [];
  if (!existsSync(path.join(rootDir, '.git'))) {
    return errors;
  }
  const trackedRes = spawnSync('git', ['ls-files', '--', 'dist/'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (trackedRes.error || trackedRes.status !== 0) {
    const detail = trackedRes.error
      ? trackedRes.error.message
      : (trackedRes.stderr ?? '').trim() || `exit ${String(trackedRes.status)}`;
    return [`git ls-files -- dist/ failed: ${detail}`];
  }
  const trackedSet = new Set(
    (trackedRes.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  for (const rel of EXPECTED_DIST_FILES) {
    const repoRel = `dist/${rel}`;
    if (!trackedSet.has(repoRel)) {
      errors.push(`${repoRel} is not tracked in Git (run 'git add dist/')`);
    }
  }

  const statusRes = spawnSync('git', ['status', '--porcelain', '--', 'dist/'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (statusRes.error || statusRes.status !== 0) {
    const detail = statusRes.error
      ? statusRes.error.message
      : (statusRes.stderr ?? '').trim() || `exit ${String(statusRes.status)}`;
    errors.push(`git status --porcelain -- dist/ failed: ${detail}`);
    return errors;
  }
  const dirty = (statusRes.stdout ?? '').trim();
  if (dirty.length > 0) {
    errors.push(`tracked dist/ has uncommitted or unstaged changes (stage and commit updated dist/):\n${dirty}`);
  }
  return errors;
}

export interface RunDistCheckOptions {
  readonly requireGitClean?: boolean;
}

export async function runDistCheck(
  rootDir: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  options: RunDistCheckOptions = {},
): Promise<string[]> {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-dist-check-'));
  const freshDist = path.join(tempRoot, 'dist');
  const requireGitClean = options.requireGitClean === true;
  try {
    await runAtomicBuild({ rootDir, outDir: freshDist, logLevel: 'silent' });
    return [
      ...compareDistTrees(path.join(rootDir, 'dist'), freshDist),
      ...verifyDistDeclarations(freshDist),
      ...checkExecutableModes(
        rootDir,
        EXECUTABLE_REPO_PATHS,
        process.platform,
        requireGitClean ? { requireTrackedInGit: true } : {},
      ),
      ...(requireGitClean ? checkGitDistClean(rootDir) : []),
    ];
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  const requireGitClean = cliArgs.includes('--git-clean');
  void runDistCheck(undefined, { requireGitClean }).then(
    (errors) => {
      if (errors.length > 0) {
        process.stderr.write(`dist:check failed (${errors.length} issue(s)):\n`);
        for (const err of errors) process.stderr.write(`  - ${err}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`[OK] dist:check passed (${EXPECTED_DIST_FILES.length} standalone files verified)\n`);
    },
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`dist:check failed: ${detail}\n`);
      process.exitCode = 1;
    },
  );
}
