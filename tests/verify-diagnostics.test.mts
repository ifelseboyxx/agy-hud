import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { walkFiles } from '../scripts/lib/walk-files.mts';
import { runVerify, type StepOutcome } from '../scripts/verify.mts';

const ROOT = process.cwd();

async function captureFailedTestVerify(testStdout: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runVerify({
    stdout: {
      write: (chunk: string): boolean => {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string): boolean => {
        stderr += chunk;
        return true;
      },
    },
    stepRunner: (name): Promise<StepOutcome> =>
      Promise.resolve({
        name,
        code: name === 'test' ? 1 : 0,
        durationMs: 25,
        stdout: name === 'test' ? testStdout : 'ok\n',
        stderr: '',
        warningReason: null,
      }),
  });
  return { code, stdout, stderr };
}

void test('verify 门禁在 spec 报告失败时仅输出末段 failing tests 摘要并忽略更早的通过日志', async () => {
  const passingSpec = Array.from({ length: 120 }, (_, i) => `  \u2714 passing case ${i} (1.2ms)`).join('\n');
  const specOutput = [
    'failing tests:',
    passingSpec,
    '\u2139 tests 121',
    '\u2139 pass 120',
    '\u2139 fail 1',
    '',
    '\u2716 failing tests:',
    '',
    'test at tests/demo.test.ts:12:3',
    '\u2716 broken behavior (4.5ms)',
    '  AssertionError: expected 1 to equal 2',
  ].join('\n');

  const res = await captureFailedTestVerify(specOutput);
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('broken behavior'));
  assert.ok(res.stderr.includes('AssertionError: expected 1 to equal 2'));
  assert.equal(res.stderr.includes('passing case 50'), false, 'must omit passing noise ahead of final failures');
});

void test('verify 门禁在 TAP 报告失败时仅提取 not ok 失败块并忽略通过用例', async () => {
  const passingTap = Array.from(
    { length: 120 },
    (_, i) => `ok ${i + 1} - passing tap ${i}\n  ---\n  duration_ms: 1\n  ...`,
  ).join('\n');
  const tapOutput = [
    'TAP version 13',
    passingTap,
    '    not ok 1 - broken tap subtest',
    '      ---',
    '      error: "boom"',
    '      ...',
    '1..121',
    '# fail 1',
  ].join('\n');

  const res = await captureFailedTestVerify(tapOutput);
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('not ok 1 - broken tap subtest'));
  assert.ok(res.stderr.includes('error: "boom"'));
  assert.equal(res.stderr.includes('passing tap 50'), false, 'must omit passing TAP subtests');
});

void test('verify 门禁在无结构化失败块时回退输出完整 stdout（含 # fail 0 晚崩溃）', async () => {
  const rawCrash = await captureFailedTestVerify('SyntaxError: unexpected token before runner\n');
  assert.equal(rawCrash.code, 1);
  assert.ok(rawCrash.stderr.includes('SyntaxError: unexpected token before runner'));

  const lateTapCrash = await captureFailedTestVerify(
    [
      'TAP version 13',
      'ok 1 - done',
      '1..1',
      '# tests 1',
      '# pass 1',
      '# fail 0',
      'UnhandledRejection: late boom',
    ].join('\n'),
  );
  assert.equal(lateTapCrash.code, 1);
  assert.ok(
    lateTapCrash.stderr.includes('UnhandledRejection: late boom'),
    'must fall back to full stdout when TAP counts exist without any not ok block',
  );
});

void test('.gitattributes 强制仓库文本文件使用 LF 换行', () => {
  const gitattributes = readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(gitattributes, /^\*\s+text=auto\s+eol=lf$/m);
});

void test('scripts/verify.mts 通过 process.exitCode 退出而不直接调用 process.exit', () => {
  const verifySrc = readFileSync(path.join(ROOT, 'scripts', 'verify.mts'), 'utf8');
  assert.equal(verifySrc.includes('process.exit('), false, 'verify.mts must set process.exitCode so pipes flush');
});

void test('测试及测试辅助模块禁止直接执行 node_modules/.bin 可执行文件', () => {
  const files = [
    ...walkFiles(path.join(ROOT, 'tests'), ROOT, {
      includeFile: (_rel, name) => /\.m?ts$/.test(name),
    }),
    ...walkFiles(path.join(ROOT, 'src'), ROOT, {
      includeFile: (rel, name) => rel.includes('/__tests__/') && /\.m?ts$/.test(name),
    }),
  ];
  const directBinViolations: string[] = [];
  for (const full of files) {
    const content = readFileSync(full, 'utf8');
    if (/node_modules[/\\]\.bin[/\\]/.test(content) || /['"]node_modules['"]\s*,\s*['"]\.bin['"]/.test(content)) {
      directBinViolations.push(path.relative(ROOT, full));
    }
  }
  assert.deepEqual(directBinViolations, []);
});
