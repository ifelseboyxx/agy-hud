import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSync, Visitor } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';

import { isMainEntry, toPosixPath } from '../src/core/paths.ts';
import { createStatusLineFenceTracker, STATUSLINE_SINGLE_WRITER } from './lib/statusline-writer-fence.ts';
import { createUnusedExportsTracker, type UnusedExportsTracker } from './lib/unused-exports-fence.ts';
import { walkFiles } from './lib/walk-files.mts';

const DEFAULT_ARCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DESC_MIN = 24;
const SKILL_DESC_MAX = 240;
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.cache',
  '.scratch',
  '.agents',
  '.workbench',
]);
const AST_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);
const FORBIDDEN_RENDER_CALLS = new Set([
  'writeFileSync',
  'mkdirSync',
  'rmSync',
  'unlinkSync',
  'renameSync',
  'copyFileSync',
  'writeBufferAtomicSync',
  'writeJsonAtomicSync',
  'touchRegularFileTimesSync',
]);
const FORBIDDEN_RENDER_MODULES = new Set(['node:child_process', 'child_process', 'node:sqlite', 'node:fs', 'fs']);
const FORBIDDEN_RENDER_TARGETS = new Set([
  'src/hud-runner.ts',
  'src/hud-snapshot-publish.ts',
  'src/core/file-lock.ts',
  'src/collectors/snapshot-envelope.ts',
  'src/fs-utils.ts',
]);

// 跨模块重复顶层函数的棘轮基线：已清零，禁止新增跨模块重复定义。
export const KNOWN_DUPLICATE_FUNCTIONS: ReadonlySet<string> = new Set();

const NETWORK_MODULES = new Set([
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'http',
  'http2',
  'https',
  'net',
  'tls',
  'dgram',
  'undici',
]);

function isFenceTarget(relPosix: string): boolean {
  return (
    relPosix.startsWith('src/core/') ||
    relPosix.startsWith('src/collectors/') ||
    relPosix.startsWith('src/render/') ||
    relPosix === 'src/hud-entry.ts' ||
    relPosix === 'src/hud-runner.ts' ||
    relPosix === 'src/hud-snapshot-publish.ts'
  );
}

function isResolverTarget(relPosix: string): boolean {
  return (
    relPosix.startsWith('src/') ||
    relPosix.startsWith('scripts/') ||
    relPosix.startsWith('tests/') ||
    relPosix === 'vite.config.ts'
  );
}

function parseFrontmatterField(block: string, key: string): string | null {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match?.[1]) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

function validateSkills(rootDir: string, errors: string[]): number {
  const skillsDir = path.join(rootDir, 'skills');
  if (!existsSync(skillsDir)) {
    errors.push('skills/: missing directory');
    return 0;
  }
  const entries = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length === 0) {
    errors.push('skills/: expected at least one skill directory');
    return 0;
  }

  let checked = 0;
  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    const relPosix = `skills/${entry.name}/SKILL.md`;
    if (!existsSync(skillPath)) {
      errors.push(`${relPosix}: missing SKILL.md`);
      continue;
    }
    checked += 1;
    const content = readFileSync(skillPath, 'utf8');
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!fm?.[1]) {
      errors.push(`${relPosix}: missing valid YAML frontmatter block`);
      continue;
    }
    const name = parseFrontmatterField(fm[1], 'name');
    const description = parseFrontmatterField(fm[1], 'description');
    if (!name || name !== entry.name) {
      errors.push(`${relPosix}: frontmatter 'name' must match directory '${entry.name}'`);
    }
    if (!description) {
      errors.push(`${relPosix}: frontmatter 'description' is missing`);
    } else if (description.length < SKILL_DESC_MIN || description.length > SKILL_DESC_MAX) {
      errors.push(
        `${relPosix}: frontmatter 'description' length ${description.length} must be ${SKILL_DESC_MIN}..${SKILL_DESC_MAX} chars`,
      );
    }
  }
  return checked;
}

function isDuplicateScanTarget(relPosix: string): boolean {
  return (relPosix.startsWith('src/') || relPosix.startsWith('scripts/')) && !relPosix.includes('/__tests__/');
}

function normalizeFunctionKey(name: string): string {
  const stripped = name.replace(/(?:Sync|Async)$/, '');
  return stripped.length > 0 ? stripped : name;
}

function collectTopLevelFunctionNames(program: ReturnType<typeof parseSync>['program']): string[] {
  const seen = new Set<string>();
  for (const stmt of program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'FunctionDeclaration' && decl.id) {
      seen.add(normalizeFunctionKey(decl.id.name));
    } else if (decl?.type === 'VariableDeclaration') {
      for (const item of decl.declarations) {
        if (
          item.id.type === 'Identifier' &&
          (item.init?.type === 'ArrowFunctionExpression' || item.init?.type === 'FunctionExpression')
        ) {
          seen.add(normalizeFunctionKey(item.id.name));
        }
      }
    }
  }
  return [...seen];
}

export function findDuplicateFunctionErrors(
  definitions: ReadonlyMap<string, readonly string[]>,
  known: ReadonlySet<string> = KNOWN_DUPLICATE_FUNCTIONS,
): string[] {
  const errors: string[] = [];
  for (const [name, files] of definitions) {
    const uniqueFiles = [...new Set(files)];
    if (uniqueFiles.length > 1 && !known.has(name)) {
      errors.push(`function '${name}' is defined in ${uniqueFiles.join(', ')}; import a single shared implementation`);
    }
  }
  for (const name of known) {
    const uniqueCount = new Set(definitions.get(name) ?? []).size;
    if (uniqueCount < 2) {
      errors.push(`KNOWN_DUPLICATE_FUNCTIONS entry '${name}' is no longer duplicated; remove it from the baseline`);
    }
  }
  return errors;
}

function inspectTypeScriptAst(
  rootDir: string,
  fullPath: string,
  relPosix: string,
  content: string,
  resolver: ResolverFactory,
  errors: string[],
  functionDefs: Map<string, string[]>,
  unusedExports: UnusedExportsTracker,
): void {
  const parsed = parseSync(fullPath, content);
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      errors.push(`${relPosix}: parse error: ${err.message}`);
    }
    return;
  }
  if (isDuplicateScanTarget(relPosix)) {
    for (const name of collectTopLevelFunctionNames(parsed.program)) {
      functionDefs.set(name, [...(functionDefs.get(name) ?? []), relPosix]);
    }
  }

  const checkConsoleLog = relPosix.startsWith('src/');
  const checkNetworkFence = isFenceTarget(relPosix);
  const checkRelativeImports = isResolverTarget(relPosix);
  const checkStatusLineOwnership = isDuplicateScanTarget(relPosix) && relPosix !== STATUSLINE_SINGLE_WRITER;
  const specifiers = new Set<string>();
  const dynamicRelativeSpecifiers = new Set<string>();

  for (const imp of parsed.module.staticImports) {
    specifiers.add(imp.moduleRequest.value);
  }
  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest?.value) specifiers.add(entry.moduleRequest.value);
    }
  }

  const isRenderModule = relPosix.startsWith('src/render/') && !relPosix.includes('/__tests__/');
  let consoleLogCount = 0;
  const forbiddenGlobalNetworks = new Set<string>();
  const forbiddenRenderCalls = new Set<string>();
  const statusLineFence = createStatusLineFenceTracker(checkStatusLineOwnership);

  const visitor = new Visitor({
    ...statusLineFence.handlers,
    ImportExpression(node): void {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        specifiers.add(node.source.value);
        if (node.source.value.startsWith('./') || node.source.value.startsWith('../')) {
          dynamicRelativeSpecifiers.add(node.source.value);
        }
      }
    },
    NewExpression(node): void {
      if (checkNetworkFence && node.callee.type === 'Identifier' && node.callee.name === 'WebSocket') {
        forbiddenGlobalNetworks.add('WebSocket');
      }
    },
    CallExpression(node): void {
      if (checkNetworkFence && node.callee.type === 'Identifier' && node.callee.name === 'fetch') {
        forbiddenGlobalNetworks.add('fetch');
      }
      if (isRenderModule && node.callee.type === 'Identifier' && FORBIDDEN_RENDER_CALLS.has(node.callee.name)) {
        forbiddenRenderCalls.add(node.callee.name);
      }
      statusLineFence.onCallExpression(node);
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length === 1 &&
        node.arguments[0]?.type === 'Literal' &&
        typeof node.arguments[0].value === 'string'
      ) {
        specifiers.add(node.arguments[0].value);
      }
      if (!checkConsoleLog || node.callee.type !== 'MemberExpression') return;
      if (node.callee.object.type !== 'Identifier' || node.callee.object.name !== 'console') return;
      const isDotLog =
        !node.callee.computed && node.callee.property.type === 'Identifier' && node.callee.property.name === 'log';
      const isBracketLog =
        node.callee.computed && node.callee.property.type === 'Literal' && node.callee.property.value === 'log';
      if (isDotLog || isBracketLog) consoleLogCount += 1;
    },
  });
  visitor.visit(parsed.program);
  unusedExports.recordFile(rootDir, fullPath, relPosix, parsed, dynamicRelativeSpecifiers, resolver);

  if (consoleLogCount > 0) errors.push(`${relPosix}: console.log call found in src/ (${consoleLogCount})`);
  for (const api of forbiddenGlobalNetworks) {
    errors.push(`${relPosix}: global network API '${api}' is forbidden by AST fence`);
  }
  for (const fnName of forbiddenRenderCalls) {
    errors.push(`${relPosix}: pure src/render/ module may not call filesystem mutator '${fnName}'`);
  }
  errors.push(...statusLineFence.collectErrors(relPosix));

  const isCollectorModule = relPosix.startsWith('src/collectors/') && !relPosix.includes('/__tests__/');
  for (const spec of specifiers) {
    if (checkNetworkFence && NETWORK_MODULES.has(spec)) {
      errors.push(`${relPosix}: network import '${spec}' is forbidden by AST import fence`);
    }
    if (isRenderModule && FORBIDDEN_RENDER_MODULES.has(spec)) {
      errors.push(`${relPosix}: pure src/render/ module may not import '${spec}'`);
    }
    if (checkRelativeImports && (spec.startsWith('./') || spec.startsWith('../'))) {
      const resolved = resolver.resolveFileSync(fullPath, spec);
      if (resolved.error || !resolved.path || !resolved.path.startsWith(rootDir)) {
        errors.push(`${relPosix}: unresolved relative import '${spec}' (${resolved.error ?? 'missing target'})`);
      } else {
        const targetRel = toPosixPath(path.relative(rootDir, resolved.path));
        if (isCollectorModule && targetRel.startsWith('src/render/')) {
          errors.push(`${relPosix}: collectors may not import from src/render/ ('${spec}')`);
        }
        if (isRenderModule && FORBIDDEN_RENDER_TARGETS.has(targetRel)) {
          errors.push(`${relPosix}: pure src/render/ module may not import I/O/lock module '${targetRel}' ('${spec}')`);
        }
      }
    }
  }
}

export function collectArchitectureErrors(
  rootDir: string = DEFAULT_ARCH_ROOT,
  options: { checkSkills?: boolean; checkUnusedExports?: boolean } = {},
): { errors: string[]; fileCount: number; skillCount: number } {
  const errors: string[] = [];
  const files = walkFiles(rootDir, rootDir, {
    skipDirs: IGNORED_DIRS,
    includeFile: (relPosix, name) => AST_EXTS.has(path.extname(name)) && isResolverTarget(relPosix),
  }).sort();
  const resolver = new ResolverFactory({
    extensions: ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    conditionNames: ['node', 'import', 'default'],
  });

  const functionDefs = new Map<string, string[]>();
  const unusedExports = createUnusedExportsTracker();
  for (const fullPath of files) {
    const relPosix = toPosixPath(path.relative(rootDir, fullPath));
    const content = readFileSync(fullPath, 'utf8');
    inspectTypeScriptAst(rootDir, fullPath, relPosix, content, resolver, errors, functionDefs, unusedExports);
  }
  errors.push(...findDuplicateFunctionErrors(functionDefs));
  if (options.checkUnusedExports !== false) {
    errors.push(...unusedExports.collectErrors());
  }

  const skillCount = options.checkSkills === false ? 0 : validateSkills(rootDir, errors);
  return { errors, fileCount: files.length, skillCount };
}

export function runValidation(rootDir: string = DEFAULT_ARCH_ROOT): number {
  const { errors, fileCount, skillCount } = collectArchitectureErrors(rootDir);
  if (errors.length > 0) {
    console.error(`Architecture validation failed (${errors.length} issue(s)):`);
    for (const err of errors) console.error(`  - ${err}`);
    return 1;
  }
  console.log(`Architecture validation passed: ${fileCount} TS AST checks, ${skillCount} skills.`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exit(runValidation());
}
