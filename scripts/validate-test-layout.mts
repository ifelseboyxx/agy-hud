import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/core/paths.ts';
import { walkFiles } from './lib/walk-files.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.husky',
  '.cache',
  '.scratch',
  '.agents',
  '.workbench',
]);
const TEST_FILE_RE = /\.test\.(?:mts|ts|mjs|cjs|js)$/;

export function findMisplacedTests(projectRoot: string = root): string[] {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const testFiles = walkFiles(resolvedRoot, resolvedRoot, {
    skipDirs: SKIP_DIRS,
    includeFile: (_rel, name) => TEST_FILE_RE.test(name),
  });
  const misplaced: string[] = [];
  for (const abs of testFiles) {
    const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
    const inTopTests = rel.startsWith('tests/');
    const inNestedTests = rel.split('/').includes('__tests__');
    if (!inTopTests && !inNestedTests) {
      misplaced.push(rel);
    }
  }
  return misplaced.sort();
}

if (isMainEntry(import.meta.url)) {
  const misplaced = findMisplacedTests(root);
  if (misplaced.length > 0) {
    for (const file of misplaced) {
      console.error(`[FAIL] ${file}: 测试文件须位于顶层 tests/ 或同级 __tests__/ 子目录`);
    }
    process.exit(1);
  }
  console.log('[OK] 测试目录布局校验通过');
}
