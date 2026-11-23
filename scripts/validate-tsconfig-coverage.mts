import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/core/paths.ts';
import { walkFiles } from './lib/walk-files.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['src', 'scripts', 'tests'] as const;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'cache', 'dist', '__pycache__', '.git', 'coverage']);
const SOURCE_EXTENSIONS = new Set(['.mts', '.ts', '.cts', '.tsx', '.vue']);

export interface TypecheckProject {
  readonly config: string;
  readonly compiler: string;
}

export interface IdeOrphanFinding {
  file: string;
  nearestConfig: string | null;
}

export const TYPECHECK_PROJECTS: readonly TypecheckProject[] = [
  { config: 'tsconfig.json', compiler: 'typescript/lib/tsc.js' },
];

interface ParsedTsConfigMeta {
  hasVueCompilerOptions: boolean;
  references: string[];
}

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

function listProjectFiles(configRel: string, compilerRel: string, projectRoot: string): string[] {
  const compiler = path.join(projectRoot, 'node_modules', compilerRel);
  const result = spawnSync(process.execPath, [compiler, '--listFilesOnly', '-p', configRel], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${compilerRel} --listFilesOnly -p ${configRel} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => path.relative(projectRoot, path.resolve(projectRoot, file)).split(path.sep).join('/'));
}

function parseTsConfigMeta(absConfig: string): ParsedTsConfigMeta {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(absConfig, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { hasVueCompilerOptions: false, references: [] };
    }
    const obj = raw as Record<string, unknown>;
    const hasVueCompilerOptions = typeof obj.vueCompilerOptions === 'object' && obj.vueCompilerOptions !== null;
    const references: string[] = [];
    for (const item of Array.isArray(obj.references) ? obj.references : []) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const refPath = (item as Record<string, unknown>).path;
        if (typeof refPath === 'string' && refPath.trim() !== '') references.push(refPath.trim());
      }
    }
    return { hasVueCompilerOptions, references };
  } catch {
    return { hasVueCompilerOptions: false, references: [] };
  }
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

  const meta = parseTsConfigMeta(absConfig);
  const compilerRel = meta.hasVueCompilerOptions ? 'vue-tsc/bin/vue-tsc.js' : 'typescript/lib/tsc.js';
  const covered = new Set<string>(listProjectFiles(configRel, compilerRel, resolvedRoot));

  for (const refPath of meta.references) {
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
): string[] {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const covered = new Set<string>();
  for (const project of projects) {
    for (const file of listProjectFiles(project.config, project.compiler, resolvedRoot)) covered.add(file);
  }
  return collectTypedSourceFiles(resolvedRoot).filter((file) => !covered.has(file));
}

export function findIdeOrphanedTypedSourceFiles(projectRoot: string = root): IdeOrphanFinding[] {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const cache = new Map<string, Set<string>>();
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
  const orphans = findUncoveredTypedSourceFiles(root);
  const ideOrphans = findIdeOrphanedTypedSourceFiles(root);
  if (orphans.length > 0 || ideOrphans.length > 0) {
    for (const f of orphans) console.error(`[FAIL] ${f}: 未被 CLI typecheck 工程收录`);
    for (const item of ideOrphans) {
      console.error(`[FAIL] ${item.file}: 被最近祖先 IDE tsconfig 排除 (${item.nearestConfig ?? 'none'})`);
    }
    process.exit(1);
  }
  console.log('[OK] tsconfig 覆盖校验通过（CLI + IDE）');
}
