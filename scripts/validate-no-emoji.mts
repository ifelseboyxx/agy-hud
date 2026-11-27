import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/core/paths.ts';
import { walkFiles } from './lib/walk-files.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.cache', '.scratch', '.agents', '.workbench']);
const SKIP_REL_DIRS = new Set(['.husky/_']);
const CHECK_EXTS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.svg',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.sh',
]);
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export interface EmojiViolation {
  file: string;
  line: number;
  codePoint: string;
}

function shouldCheckFile(rel: string, name: string): boolean {
  if (name === 'pnpm-lock.yaml') return false;
  if (rel === 'scripts/validate-no-emoji.mts') return false;
  if (rel.startsWith('.husky/') && !rel.startsWith('.husky/_/')) return true;
  return CHECK_EXTS.has(path.extname(name));
}

export function findEmojiViolations(projectRoot: string = root): EmojiViolation[] {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const files = walkFiles(resolvedRoot, resolvedRoot, {
    skipDirs: SKIP_DIRS,
    skipRelDirs: SKIP_REL_DIRS,
    includeFile: shouldCheckFile,
  }).sort();

  const violations: EmojiViolation[] = [];
  for (const abs of files) {
    const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
    const content = fs.readFileSync(abs, 'utf8');
    if (!EMOJI_RE.test(content)) continue;
    EMOJI_RE.lastIndex = 0;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const matches = [...line.matchAll(EMOJI_RE)];
      for (const match of matches) {
        const cp = match[0].codePointAt(0)?.toString(16).toUpperCase() ?? 'UNKNOWN';
        violations.push({ file: rel, line: i + 1, codePoint: `U+${cp}` });
      }
    }
  }
  return violations;
}

if (isMainEntry(import.meta.url)) {
  const violations = findEmojiViolations(root);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`[FAIL] ${v.file}:${v.line}: 禁止出现 pictographic emoji (${v.codePoint})`);
    }
    process.exit(1);
  }
  console.log('[OK] 零 Emoji 校验通过');
}
