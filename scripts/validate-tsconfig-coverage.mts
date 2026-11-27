import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { isMainEntry } from '../src/core/fs-utils.ts';
import { DEFAULT_SKIP_DIRS, walkFiles } from './lib/walk-files.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['src', 'scripts', 'tests'] as const;
const SKIP_DIRS = new Set([...DEFAULT_SKIP_DIRS, 'vendor', '__pycache__']);
const SOURCE_EXTENSIONS = new Set(['.mts', '.ts', '.cts', '.tsx']);

export interface TypecheckProject {
  readonly config: string;
  readonly compiler?: string;
}

export interface IdeOrphanFinding {
  file: string;
  nearestConfig: string | null;
}

export const TYPECHECK_PROJECTS: readonly TypecheckProject[] = [{ config: 'tsconfig.json' }];

function collectTypedSourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  for (const rel of SOURCE_ROOTS) {
    walkFiles(
      path.join(projectRoot, rel),
      projectRoot,
      { skipDirs: SKIP_DIRS, includeFile: (_rel, name) => SOURCE_EXTENSIONS.has(path.extname(name)) },
      files,
    );
  }
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(projectRoot, entry.name));
    }
  }
  return files.map((file) => path.relative(projectRoot, file).split(path.sep).join('/')).sort();
}

function parseProjectConfig(absConfig: string, projectRoot: string): { files: string[]; references: string[] } {
  const read = ts.readConfigFile(absConfig, (p) => fs.readFileSync(p, 'utf8'));
  if (read.error) {
    throw new Error(`Failed to read ${absConfig}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(absConfig), undefined, absConfig);
  const files = parsed.fileNames.map((file) =>
    path.relative(projectRoot, path.resolve(file)).split(path.sep).join('/'),
  );
  const references = (parsed.projectReferences ?? []).map((ref) => ref.path);
  return { files, references };
}

function findNearestTsConfig(absFile: string, resolvedRoot: string): string | null {
  let dir = path.dirname(absFile);
  while (dir === resolvedRoot || dir.startsWith(resolvedRoot + path.sep)) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    if (dir === resolvedRoot) break;
    dir = path.dirname(dir);
  }
  return null;
}

function collectConfigFilesRecursive(
  absConfig: string,
  resolvedRoot: string,
  cache: Map<string, Set<string>>,
  visiting: Set<string>,
): Set<string> {
  const configRel = path.relative(resolvedRoot, absConfig).split(path.sep).join('/');
  const cached = cache.get(configRel);
  if (cached) return cached;
  if (visiting.has(configRel)) return new Set();
  visiting.add(configRel);

  const { files, references } = parseProjectConfig(absConfig, resolvedRoot);
  const covered = new Set<string>(files);

  for (const refPath of references) {
    const target = path.resolve(path.dirname(absConfig), refPath);
    const refConfig =
      fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'tsconfig.json') : target;
    if (!fs.existsSync(refConfig)) continue;
    for (const file of collectConfigFilesRecursive(refConfig, resolvedRoot, cache, visiting)) covered.add(file);
  }

  visiting.delete(configRel);
  cache.set(configRel, covered);
  return covered;
}

export function findUncoveredTypedSourceFiles(
  projectRoot: string = root,
  projects: readonly TypecheckProject[] = TYPECHECK_PROJECTS,
  cache: Map<string, Set<string>> = new Map(),
): string[] {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const covered = new Set<string>();
  for (const project of projects) {
    const absConfig = path.resolve(resolvedRoot, project.config);
    for (const file of collectConfigFilesRecursive(absConfig, resolvedRoot, cache, new Set())) covered.add(file);
  }
  return collectTypedSourceFiles(resolvedRoot).filter((file) => !covered.has(file));
}

export function findIdeOrphanedTypedSourceFiles(
  projectRoot: string = root,
  cache: Map<string, Set<string>> = new Map(),
): IdeOrphanFinding[] {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const findings: IdeOrphanFinding[] = [];
  for (const relFile of collectTypedSourceFiles(resolvedRoot)) {
    const nearestAbs = findNearestTsConfig(path.join(resolvedRoot, relFile), resolvedRoot);
    if (nearestAbs === null) {
      findings.push({ file: relFile, nearestConfig: null });
      continue;
    }
    const nearestRel = path.relative(resolvedRoot, nearestAbs).split(path.sep).join('/');
    if (!collectConfigFilesRecursive(nearestAbs, resolvedRoot, cache, new Set()).has(relFile)) {
      findings.push({ file: relFile, nearestConfig: nearestRel });
    }
  }
  return findings;
}

if (isMainEntry(import.meta.url)) {
  const sharedCache = new Map<string, Set<string>>();
  const orphans = findUncoveredTypedSourceFiles(root, TYPECHECK_PROJECTS, sharedCache);
  const ideOrphans = findIdeOrphanedTypedSourceFiles(root, sharedCache);
  if (orphans.length > 0 || ideOrphans.length > 0) {
    for (const f of orphans) console.error(`[FAIL] ${f}: 未被 CLI typecheck 工程收录`);
    for (const item of ideOrphans) {
      console.error(`[FAIL] ${item.file}: 被最近祖先 IDE tsconfig 排除 (${item.nearestConfig ?? 'none'})`);
    }
    process.exit(1);
  }
  console.log('[OK] tsconfig 覆盖校验通过（CLI + IDE）');
}
