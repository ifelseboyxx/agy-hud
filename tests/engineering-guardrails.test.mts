import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { findDuplicateFunctionErrors } from '../scripts/validate-architecture.ts';
import { findEmojiViolations } from '../scripts/validate-no-emoji.mts';
import { validateSourceMaintainability } from '../scripts/validate-source-maintainability.mts';
import { findMisplacedTests } from '../scripts/validate-test-layout.mts';
import {
  findIdeOrphanedTypedSourceFiles,
  findUncoveredTypedSourceFiles,
} from '../scripts/validate-tsconfig-coverage.mts';

const ROOT = process.cwd();

function writeFixtureFiles(baseDir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(baseDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
}

void test('commitlint 放行合法提交头并拦截缺失或非法 scope', () => {
  const bin = path.join(ROOT, 'node_modules/.bin/commitlint');
  const check = (msg: string): number | null =>
    spawnSync(bin, ['--config', path.join(ROOT, '.commitlintrc.cjs')], {
      cwd: ROOT,
      input: `${msg}\n`,
      encoding: 'utf8',
    }).status;

  assert.equal(check('feat(root): 补齐工程化门禁'), 0);
  assert.equal(check('fix(collectors): 修复遥测增量读取边界'), 0);
  assert.notEqual(check('feat: 缺少 scope'), 0);
  assert.notEqual(check('feat(invalid): 非法 scope'), 0);
});

void test('isolate-git-env 预加载清空继承的 GIT_* 变量', () => {
  const res = spawnSync(
    process.execPath,
    [
      '--import',
      './scripts/lib/isolate-git-env.mts',
      '-e',
      'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("GIT_"))))',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, GIT_DIR: '/tmp/fake', GIT_CONFIG_PARAMETERS: "'core.bare=true'" },
      encoding: 'utf8',
    },
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '[]');
});

void test('tsconfig 覆盖校验可拦截 CLI 漏收与 IDE 最近祖先排除陷阱', (t) => {
  assert.deepEqual(findUncoveredTypedSourceFiles(ROOT), []);
  assert.deepEqual(findIdeOrphanedTypedSourceFiles(ROOT), []);

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-parity-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');

  writeFixtureFiles(tmp, {
    'tsconfig.json':
      '{"include":["scripts/**/*.mts"],"exclude":["scripts/**/__tests__"],"compilerOptions":{"types":[]}}',
    'scripts/main.mts': 'export {};',
    'scripts/lib/__tests__/demo.test.mts': 'export {};',
    'tests/tsconfig.json':
      '{"include":["./**/*.mts","../scripts/**/__tests__/**/*.mts"],"compilerOptions":{"types":[]}}',
    'tests/ok.test.mts': 'export {};',
  });

  // 仅用根 tsconfig.json 时，CLI 漏收应变为 red
  assert.deepEqual(findUncoveredTypedSourceFiles(tmp), ['scripts/lib/__tests__/demo.test.mts', 'tests/ok.test.mts']);

  // 当 CLI 合集包含 tests/tsconfig.json 时，CLI 通过但 IDE 最近祖先仍能精准拦截
  const dualProjects = [
    { config: 'tsconfig.json', compiler: 'typescript/lib/tsc.js' },
    { config: 'tests/tsconfig.json', compiler: 'typescript/lib/tsc.js' },
  ] as const;
  assert.deepEqual(findUncoveredTypedSourceFiles(tmp, dualProjects), []);
  assert.deepEqual(findIdeOrphanedTypedSourceFiles(tmp), [
    { file: 'scripts/lib/__tests__/demo.test.mts', nearestConfig: 'tsconfig.json' },
  ]);
});

void test('测试布局守卫拦截散落的测试文件并放行合法位置', (t) => {
  assert.deepEqual(findMisplacedTests(ROOT), []);

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'test-layout-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFixtureFiles(tmp, {
    'src/stray.test.mts': 'export {};\n',
    'scripts/stray.test.ts': 'export {};\n',
    'src/__tests__/ok.test.mts': 'export {};\n',
    'tests/ok.test.mts': 'export {};\n',
  });

  assert.deepEqual(findMisplacedTests(tmp), ['scripts/stray.test.ts', 'src/stray.test.mts']);
});

void test('源码可维护性守卫拦截超长文件、长连续注释与高注释占比', (t) => {
  assert.deepEqual(validateSourceMaintainability(ROOT), []);

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'maintainability-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const longLines = `${Array.from({ length: 501 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;
  const longCommentBlock = `${Array.from({ length: 13 }, (_, i) => `// comment ${i}`).join('\n')}\nexport const a = 1;\n`;
  const denseComments = [
    ...Array.from({ length: 15 }, (_, i) => `// note ${i}\nexport const c${i} = ${i};`),
    'export const tail = 0;',
  ].join('\n');

  writeFixtureFiles(tmp, {
    'src/too-long.ts': longLines,
    'src/long-run.ts': longCommentBlock,
    'src/dense-comments.ts': denseComments,
  });

  const issues = validateSourceMaintainability(tmp);
  assert.ok(issues.some((i) => i.file === 'src/too-long.ts' && i.reason.includes('500')));
  assert.ok(issues.some((i) => i.file === 'src/long-run.ts' && i.reason.includes('12')));
  assert.ok(issues.some((i) => i.file === 'src/dense-comments.ts' && i.reason.includes('25%')));
});

void test('零 Emoji 守卫拦截违规文件且主仓无 Emoji', (t) => {
  assert.deepEqual(findEmojiViolations(ROOT), []);

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'no-emoji-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const rocket = String.fromCodePoint(0x1f680);
  writeFixtureFiles(tmp, {
    'src/bad.ts': `export const msg = 'launch ${rocket}';\n`,
    'README.md': '# clean doc\n',
  });

  assert.deepEqual(findEmojiViolations(tmp), [{ file: 'src/bad.ts', line: 1, codePoint: 'U+1F680' }]);
});

void test('husky 钩子文件具备可执行权限', () => {
  for (const hook of ['.husky/pre-commit', '.husky/pre-push', '.husky/commit-msg']) {
    assert.notEqual(statSync(path.join(ROOT, hook)).mode & 0o111, 0);
  }
});

void test('重复函数棘轮拦截新增跨模块重复、按文件去重并要求清理已消除的基线条目', () => {
  const defs = new Map([
    ['fresh', ['src/a.ts', 'scripts/b.mts']],
    ['sameFilePair', ['src/a.ts', 'src/a.ts']],
    ['known', ['src/a.ts', 'src/c.ts']],
    ['fixed', ['src/a.ts']],
  ]);
  const errors = findDuplicateFunctionErrors(defs, new Set(['known', 'fixed']));
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? '', /'fresh' is defined in src\/a\.ts, scripts\/b\.mts/);
  assert.match(errors[1] ?? '', /'fixed' is no longer duplicated/);
});
