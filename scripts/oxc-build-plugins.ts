import { chmodSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { minifySync } from 'oxc-minify';
import { parseSync } from 'oxc-parser';
import { isolatedDeclaration } from 'oxc-transform';
import type { Plugin, ResolvedConfig } from 'vite';

import { EXECUTABLE_DIST_FILES } from './lib/dist-manifest.mts';

const SHEBANG_RE = /^(#![^\r\n]*)\r?\n/;
const EXECUTABLE_BINS: ReadonlySet<string> = new Set(EXECUTABLE_DIST_FILES);

function extractShebangFromFile(filePath: string | null | undefined): string {
  if (!filePath || !existsSync(filePath)) return '';
  try {
    const content = readFileSync(filePath, 'utf8');
    const match = content.match(SHEBANG_RE);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

function formatOxcErrors(label: string, errors: Array<{ message: string; codeframe: string | null }>): string {
  return errors.map((err) => `${label}: ${err.codeframe ?? err.message}`).join('\n');
}

async function runIsolatedDeclaration(rootDir: string, relSource: string): Promise<string> {
  const fullPath = path.join(rootDir, relSource);
  const sourceText = readFileSync(fullPath, 'utf8');
  const result = await isolatedDeclaration(relSource, sourceText);
  if (result.errors.length > 0) {
    throw new Error(formatOxcErrors(`isolatedDeclaration(${relSource})`, result.errors));
  }
  return result.code;
}

function collectExportedTypeNames(typesDtsCode: string): Set<string> {
  const names = new Set<string>();
  const parsed = parseSync('types.d.mts', typesDtsCode);
  for (const stmt of parsed.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) continue;
    const decl = stmt.declaration;
    if (
      (decl.type === 'TSInterfaceDeclaration' || decl.type === 'TSTypeAliasDeclaration') &&
      decl.id.type === 'Identifier'
    ) {
      names.add(decl.id.name);
    }
  }
  return names;
}

async function emitBundledIndexDts(rootDir: string, typesDtsCode: string): Promise<string> {
  const indexRel = 'src/index.ts';
  const indexSource = readFileSync(path.join(rootDir, indexRel), 'utf8');
  const parsedIndex = parseSync(indexRel, indexSource);
  if (parsedIndex.errors.length > 0) {
    throw new Error(`parseSync(${indexRel}) failed: ${parsedIndex.errors.map((e) => e.message).join('; ')}`);
  }

  const availableTypes = collectExportedTypeNames(typesDtsCode);
  const declarations: string[] = [];

  for (const exp of parsedIndex.module.staticExports) {
    for (const entry of exp.entries) {
      const req = entry.moduleRequest?.value;
      if (!req || req === './types.ts') continue;
      if (entry.isType) continue;
      const exportedName = entry.exportName.name;
      const localName = entry.localName.name ?? exportedName;
      if (!exportedName || !localName) continue;

      const targetRel = path.posix.normalize(path.posix.join('src', req));
      const targetDts = await runIsolatedDeclaration(rootDir, targetRel);
      const parsedTarget = parseSync(`${targetRel}.d.ts`, targetDts);

      for (const stmt of parsedTarget.program.body) {
        if (stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) continue;
        if (stmt.declaration.type === 'TSDeclareFunction' && stmt.declaration.id?.name === localName) {
          const rawDecl = targetDts.slice(stmt.start, stmt.end).trim();
          const renamed =
            localName === exportedName ? rawDecl : rawDecl.replace(`function ${localName}`, `function ${exportedName}`);
          declarations.push(renamed);
        }
      }
    }
  }

  const usedTypes = [...availableTypes]
    .filter((t) => declarations.some((d) => new RegExp(`\\b${t}\\b`).test(d)))
    .sort();
  const lines: string[] = [];
  if (usedTypes.length > 0) {
    lines.push(`import type { ${usedTypes.join(', ')} } from "./types.mjs";`);
  }
  lines.push(...declarations);
  lines.push('export * from "./types.mjs";', '');
  return lines.join('\n');
}

export interface OxcBuildPluginOptions {
  readonly emitDts?: boolean;
}

export function oxcIsolatedDtsAndMinifyPlugin(options: OxcBuildPluginOptions = {}): Plugin {
  const shouldEmitDts = options.emitDts ?? true;
  let rootDir = process.cwd();
  let outDir = path.resolve(rootDir, 'dist');

  return {
    name: 'oxc-isolated-dts-and-minify',
    apply: 'build',
    configResolved(config: ResolvedConfig): void {
      rootDir = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async generateBundle(_options, bundle): Promise<void> {
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== 'chunk' || !fileName.endsWith('.mjs')) continue;

        const codeShebang = item.code.match(SHEBANG_RE)?.[1] ?? '';
        const sourceShebang = item.isEntry ? extractShebangFromFile(item.facadeModuleId) : '';
        const shebang = codeShebang.length > 0 ? codeShebang : sourceShebang;
        const body = item.code.replace(SHEBANG_RE, '');

        const minified = minifySync(fileName, body, { compress: true, mangle: false });
        if (minified.errors.length > 0) {
          throw new Error(formatOxcErrors(`oxc-minify(${fileName})`, minified.errors));
        }
        const cleaned = minified.code.replace(SHEBANG_RE, '');
        item.code = shebang ? `${shebang}\n${cleaned}` : cleaned;
      }

      if (shouldEmitDts && existsSync(path.join(rootDir, 'src/types.ts'))) {
        const typesDtsCode = await runIsolatedDeclaration(rootDir, 'src/types.ts');
        this.emitFile({
          type: 'asset',
          fileName: 'types.d.mts',
          source: typesDtsCode,
        });
        if (existsSync(path.join(rootDir, 'src/index.ts'))) {
          this.emitFile({
            type: 'asset',
            fileName: 'index.d.mts',
            source: await emitBundledIndexDts(rootDir, typesDtsCode),
          });
        }
      }
    },
    writeBundle(_options, bundle): void {
      if (process.platform === 'win32') return;
      for (const fileName of Object.keys(bundle)) {
        if (!EXECUTABLE_BINS.has(fileName)) continue;
        const fullPath = path.join(outDir, fileName);
        if (!existsSync(fullPath)) continue;
        const head = readFileSync(fullPath, 'utf8').slice(0, 64);
        if (head.startsWith('#!')) {
          chmodSync(fullPath, 0o755);
        }
      }
    },
  };
}
