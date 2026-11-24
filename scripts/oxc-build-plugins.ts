import { chmodSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { minifySync } from 'oxc-minify';
import { isolatedDeclaration } from 'oxc-transform';
import type { Plugin, ResolvedConfig } from 'vite';

const SHEBANG_RE = /^(#![^\r\n]*)\r?\n/;
const EXECUTABLE_BINS = new Set(['hud.mjs', 'cli.mjs', 'mcp-hud.mjs']);

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

function rewriteTypesImportExtension(dtsCode: string): string {
  return dtsCode.replace(/(['"])(\.\/types)\.ts\1/g, '$1$2.mjs$1');
}

async function emitIsolatedDts(rootDir: string, relSource: string): Promise<string> {
  const fullPath = path.join(rootDir, relSource);
  const sourceText = readFileSync(fullPath, 'utf8');
  const result = await isolatedDeclaration(relSource, sourceText);
  if (result.errors.length > 0) {
    throw new Error(formatOxcErrors(`isolatedDeclaration(${relSource})`, result.errors));
  }
  return relSource === 'src/index.ts' ? rewriteTypesImportExtension(result.code) : result.code;
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
        this.emitFile({
          type: 'asset',
          fileName: 'types.d.mts',
          source: await emitIsolatedDts(rootDir, 'src/types.ts'),
        });
      }
      if (shouldEmitDts && existsSync(path.join(rootDir, 'src/index.ts'))) {
        this.emitFile({
          type: 'asset',
          fileName: 'index.d.mts',
          source: await emitIsolatedDts(rootDir, 'src/index.ts'),
        });
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
