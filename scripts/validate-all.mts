import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRuntimeEnvironment } from './check-env.mts';
import { runValidation as runArchitectureValidation } from './validate-architecture.ts';
import { findEmojiViolations } from './validate-no-emoji.mts';
import { validatePluginPackageHygiene } from './validate-plugin-manifest.ts';
import { validateSourceMaintainability } from './validate-source-maintainability.mts';
import { findMisplacedTests } from './validate-test-layout.mts';
import {
  findIdeOrphanedTypedSourceFiles,
  findUncoveredTypedSourceFiles,
  TYPECHECK_PROJECTS,
} from './validate-tsconfig-coverage.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;

const envErrors = checkRuntimeEnvironment();
if (envErrors.length > 0) {
  for (const err of envErrors) console.error(`[FAIL] check-env: ${err}`);
  failed = true;
}

const misplaced = findMisplacedTests(root);
if (misplaced.length > 0) {
  for (const file of misplaced) {
    console.error(`[FAIL] ${file}: 测试文件须位于顶层 tests/ 或同级 __tests__/ 子目录`);
  }
  failed = true;
}

const tsCache = new Map<string, Set<string>>();
const orphans = findUncoveredTypedSourceFiles(root, TYPECHECK_PROJECTS, tsCache);
const ideOrphans = findIdeOrphanedTypedSourceFiles(root, tsCache);
if (orphans.length > 0 || ideOrphans.length > 0) {
  for (const f of orphans) console.error(`[FAIL] ${f}: 未被 CLI typecheck 工程收录`);
  for (const item of ideOrphans) {
    console.error(`[FAIL] ${item.file}: 被最近祖先 IDE tsconfig 排除 (${item.nearestConfig ?? 'none'})`);
  }
  failed = true;
}

const maintIssues = validateSourceMaintainability(root);
if (maintIssues.length > 0) {
  for (const issue of maintIssues) console.error(`[FAIL] ${issue.file}: ${issue.reason}`);
  failed = true;
}

const emojiViolations = findEmojiViolations(root);
if (emojiViolations.length > 0) {
  for (const v of emojiViolations) {
    console.error(`[FAIL] ${v.file}:${v.line}: 禁止出现 pictographic emoji (${v.codePoint})`);
  }
  failed = true;
}

if (runArchitectureValidation(root) !== 0) {
  failed = true;
}

const pluginErrors = validatePluginPackageHygiene(root);
if (pluginErrors.length > 0) {
  for (const err of pluginErrors) console.error(`[FAIL] plugin-hygiene: ${err}`);
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log('[OK] 全部结构守卫校验通过');
