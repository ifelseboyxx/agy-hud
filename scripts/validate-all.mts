import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VALIDATORS = [
  'scripts/check-env.mts',
  'scripts/validate-test-layout.mts',
  'scripts/validate-tsconfig-coverage.mts',
  'scripts/validate-source-maintainability.mts',
  'scripts/validate-no-emoji.mts',
  'scripts/validate-architecture.ts',
] as const;

for (const script of VALIDATORS) {
  const result = spawnSync(process.execPath, [path.join(root, script)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`[FAIL] ${script} exited with code ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
}

console.log('[OK] 全部结构守卫校验通过');
