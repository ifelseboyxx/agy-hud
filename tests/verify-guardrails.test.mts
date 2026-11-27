import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { collectArchitectureErrors } from '../scripts/validate-architecture.ts';
import { runVerify, type StepOutcome } from '../scripts/verify.mts';

function writeFixtureFiles(baseDir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(baseDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
}

function makeOkStep(name: string): Promise<StepOutcome> {
  return Promise.resolve({ name, code: 0, durationMs: 5, stdout: 'ok\n', stderr: '', warningReason: null });
}

void test('架构守卫拦截未被任何模块或测试引用的死导出与孤儿重导出', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'arch-unused-export-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFixtureFiles(tmp, {
    'src/shared.ts': 'export type SharedType = string;\nexport function usedHelper(): number { return 1; }\n',
    'src/index.ts': "export { usedHelper } from './shared.ts';\n",
  });
  assert.deepEqual(collectArchitectureErrors(tmp, { checkSkills: false }).errors, []);

  writeFixtureFiles(tmp, {
    'src/shared.ts':
      'export function usedHelper(): number { return 1; }\nexport function orphanHelper(): number { return 2; }\n',
    'src/reexport.ts': "export { usedHelper } from './shared.ts';\n",
  });
  const { errors } = collectArchitectureErrors(tmp, { checkSkills: false });
  assert.ok(errors.some((e) => e.includes('src/shared.ts') && e.includes('orphanHelper')));
  assert.ok(errors.some((e) => e.includes('src/reexport.ts') && e.includes('usedHelper')));

  // `export * from` covers named exports but must still flag an unimported `default` export
  const starTmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'arch-star-default-')));
  t.after(() => rmSync(starTmp, { recursive: true, force: true }));
  writeFixtureFiles(starTmp, {
    'src/lib.ts': 'export const named = 1;\nexport default function unusedDefault(): number { return 2; }\n',
    'src/index.ts': "export * from './lib.ts';\n",
  });
  const starRes = collectArchitectureErrors(starTmp, { checkSkills: false });
  assert.equal(
    starRes.errors.some((e) => e.includes('named')),
    false,
  );
  assert.ok(starRes.errors.some((e) => e.includes('src/lib.ts') && e.includes("unused export 'default'")));
});

void test('verify 门禁在 build 后联动 dist:check 并在 skipBuild 时跳过两者', async () => {
  const ranNormal: string[] = [];
  const normalCode = await runVerify({
    stdout: { write: () => true },
    stderr: { write: () => true },
    stepRunner: (name) => {
      ranNormal.push(name);
      return makeOkStep(name);
    },
  });
  assert.equal(normalCode, 0);
  assert.ok(ranNormal.includes('build'));
  assert.ok(ranNormal.includes('dist:check'));
  assert.ok(ranNormal.includes('test'));

  const ranSkip: string[] = [];
  const skipCode = await runVerify({
    skipBuild: true,
    stdout: { write: () => true },
    stderr: { write: () => true },
    stepRunner: (name) => {
      ranSkip.push(name);
      return makeOkStep(name);
    },
  });
  assert.equal(skipCode, 0);
  assert.equal(ranSkip.includes('build'), false);
  assert.equal(ranSkip.includes('dist:check'), false);
});

void test('verify 门禁在 build 失败时跳过 dist:check 与 test', async () => {
  const ran: string[] = [];
  const failCode = await runVerify({
    stdout: { write: () => true },
    stderr: { write: () => true },
    stepRunner: (name) => {
      ran.push(name);
      return Promise.resolve({
        name,
        code: name === 'build' ? 1 : 0,
        durationMs: 5,
        stdout: '',
        stderr: name === 'build' ? 'build failed' : '',
        warningReason: null,
      });
    },
  });
  assert.equal(failCode, 1);
  assert.equal(ran.includes('dist:check'), false);
  assert.equal(ran.includes('test'), false);
});
