import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { collectArchitectureErrors, findDuplicateFunctionErrors } from '../scripts/validate-architecture.ts';
import { findEmojiViolations } from '../scripts/validate-no-emoji.mts';
import { validateSourceMaintainability } from '../scripts/validate-source-maintainability.mts';
import { findMisplacedTests } from '../scripts/validate-test-layout.mts';
import {
  findIdeOrphanedTypedSourceFiles,
  findUncoveredTypedSourceFiles,
} from '../scripts/validate-tsconfig-coverage.mts';
import { detectStepWarning, resolvePnpmSpawnSpec, runVerify, type StepOutcome } from '../scripts/verify.mts';

const ROOT = process.cwd();

function writeFixtureFiles(baseDir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(baseDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
}

void test('commitlint 放行合法提交头', () => {
  const bin = path.join(ROOT, 'node_modules/.bin/commitlint');
  const check = (msg: string): number | null =>
    spawnSync(bin, ['--config', path.join(ROOT, '.commitlintrc.cjs')], {
      cwd: ROOT,
      input: `${msg}\n`,
      encoding: 'utf8',
    }).status;

  assert.equal(check('feat(root): 补齐工程化门禁'), 0);
  assert.equal(check('fix(collectors): 修复遥测增量读取边界'), 0);
});

void test('commitlint 拦截缺失或非法 scope', () => {
  const bin = path.join(ROOT, 'node_modules/.bin/commitlint');
  const check = (msg: string): number | null =>
    spawnSync(bin, ['--config', path.join(ROOT, '.commitlintrc.cjs')], {
      cwd: ROOT,
      input: `${msg}\n`,
      encoding: 'utf8',
    }).status;

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

void test('tsconfig 覆盖校验拦截 CLI 漏收陷阱', (t) => {
  assert.deepEqual(findUncoveredTypedSourceFiles(ROOT), []);

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-cli-parity-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');

  writeFixtureFiles(tmp, {
    'tsconfig.json':
      '{"include":["scripts/**/*.mts"],"exclude":["scripts/**/__tests__"],"compilerOptions":{"types":[]}}',
    'scripts/main.mts': 'export {};',
    'scripts/lib/__tests__/demo.test.mts': 'export {};',
    'tests/ok.test.mts': 'export {};',
  });

  assert.deepEqual(findUncoveredTypedSourceFiles(tmp), ['scripts/lib/__tests__/demo.test.mts', 'tests/ok.test.mts']);
});

void test('tsconfig 覆盖校验拦截 IDE 最近祖先排除陷阱', (t) => {
  assert.deepEqual(findIdeOrphanedTypedSourceFiles(ROOT), []);

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'ide-orphan-parity-')));
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

  const dualProjects = [
    { config: 'tsconfig.json', compiler: 'typescript/lib/tsc.js' },
    { config: 'tests/tsconfig.json', compiler: 'typescript/lib/tsc.js' },
  ] as const;
  assert.deepEqual(findUncoveredTypedSourceFiles(tmp, dualProjects), []);
  assert.deepEqual(findIdeOrphanedTypedSourceFiles(tmp), [
    { file: 'scripts/lib/__tests__/demo.test.mts', nearestConfig: 'tsconfig.json' },
  ]);
});

void test('测试布局守卫拦截散落的测试文件', (t) => {
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

void test('源码可维护性守卫拦截超长文件', (t) => {
  assert.deepEqual(validateSourceMaintainability(ROOT), []);

  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'maintainability-lines-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const longLines = `${Array.from({ length: 501 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;
  writeFixtureFiles(tmp, { 'src/too-long.ts': longLines });

  const issues = validateSourceMaintainability(tmp);
  assert.ok(issues.some((i) => i.file === 'src/too-long.ts' && i.reason.includes('500')));
});

void test('源码可维护性守卫拦截长连续注释块', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'maintainability-run-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const longCommentBlock = `${Array.from({ length: 13 }, (_, i) => `// comment ${i}`).join('\n')}\nexport const a = 1;\n`;
  writeFixtureFiles(tmp, { 'src/long-run.ts': longCommentBlock });

  const issues = validateSourceMaintainability(tmp);
  assert.ok(issues.some((i) => i.file === 'src/long-run.ts' && i.reason.includes('12')));
});

void test('源码可维护性守卫拦截高注释占比文件', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'maintainability-dense-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const denseComments = [
    ...Array.from({ length: 15 }, (_, i) => `// note ${i}\nexport const c${i} = ${i};`),
    'export const tail = 0;',
  ].join('\n');
  writeFixtureFiles(tmp, { 'src/dense-comments.ts': denseComments });

  const issues = validateSourceMaintainability(tmp);
  assert.ok(issues.some((i) => i.file === 'src/dense-comments.ts' && i.reason.includes('25%')));
});

void test('零 Emoji 守卫拦截源码违规字符', (t) => {
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

void test('重复函数棘轮拦截新增跨模块重复定义', () => {
  const defs = new Map([
    ['fresh', ['src/a.ts', 'scripts/b.mts']],
    ['sameFilePair', ['src/a.ts', 'src/a.ts']],
    ['known', ['src/a.ts', 'src/c.ts']],
  ]);
  const errors = findDuplicateFunctionErrors(defs, new Set(['known']));
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /'fresh' is defined in src\/a\.ts, scripts\/b\.mts/);
});

void test('重复函数棘轮要求清理已消除的基线条目', () => {
  const defs = new Map([['fixed', ['src/a.ts']]]);
  const errors = findDuplicateFunctionErrors(defs, new Set(['fixed']));
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /'fixed' is no longer duplicated/);
});

void test('可维护性守卫放行文件首部单个 @host-contract 协议块注释', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'host-contract-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blockLines = Array.from({ length: 16 }, (_, i) => ` * field #${i + 1}`).join('\n');
  writeFixtureFiles(tmp, {
    'src/proto-doc.ts': `/* @host-contract\n${blockLines}\n */\nexport const OK = 1;\n`,
  });
  assert.deepEqual(validateSourceMaintainability(tmp), []);
});

void test('架构守卫拦截受限目录的网络 API', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'arch-net-fence-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFixtureFiles(tmp, {
    'src/mcp/rogue-fetch.ts':
      "export async function leak(): Promise<unknown> { return fetch('https://example.com'); }\n",
    'src/mcp/rogue-cjs.cjs': "const http = require('node:http'); module.exports = http;\n",
  });
  const { errors } = collectArchitectureErrors(tmp, { checkSkills: false });
  assert.ok(errors.some((e) => e.includes('rogue-fetch.ts') && e.includes('fetch')));
  assert.ok(errors.some((e) => e.includes('rogue-cjs.cjs') && e.includes('node:http')));
});

void test('架构守卫拦截 collectors 导入 render 层', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'arch-layer-fence-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFixtureFiles(tmp, {
    'src/render/ansi.ts': 'export const RESET = "";\n',
    'src/collectors/rogue-collector.ts':
      "import { RESET } from '../render/ansi.ts';\nexport function leakAnsi(): string { return RESET; }\n",
  });
  const { errors } = collectArchitectureErrors(tmp, { checkSkills: false });
  assert.ok(errors.some((e) => e.includes('rogue-collector.ts') && e.includes('src/render/')));
});

void test('零 Emoji 守卫同时覆盖测试文件', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'emoji-test-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const star = String.fromCodePoint(0x1f31f);
  writeFixtureFiles(tmp, {
    'tests/demo.test.ts': `export const label = '${star}';\n`,
  });
  assert.deepEqual(findEmojiViolations(tmp), [{ file: 'tests/demo.test.ts', line: 1, codePoint: 'U+1F31F' }]);
});

void test('架构守卫拦截经由 getSettingsPaths 解构或别名写入 statusLine 的非单一写入方', (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'arch-getsettings-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFixtureFiles(tmp, {
    'src/core/statusline-ownership.ts':
      'export function getSettingsPaths(_h: string): { settingsPath: string; backupPath: string } { return { settingsPath: "", backupPath: "" }; }\n',
    'src/fs-utils.ts':
      'export function writeJsonAtomicSync(_p: string, _d: unknown): void {}\nexport function writeBufferAtomicSync(_p: string, _b: Buffer): void {}\n',
    'src/cli/rogue-destructured.ts': [
      "import { getSettingsPaths } from '../core/statusline-ownership.ts';",
      "import { writeJsonAtomicSync } from '../fs-utils.ts';",
      'export function hijack(cliHome: string): void {',
      '  const { settingsPath, backupPath } = getSettingsPaths(cliHome);',
      '  writeJsonAtomicSync(settingsPath, { statusLine: { enabled: false } });',
      '  writeJsonAtomicSync(backupPath, { wiredCommand: "/x", hadStatusLine: false, previousStatusLine: null });',
      '}',
    ].join('\n'),
    'src/cli/rogue-alias.ts': [
      "import { renameSync, copyFileSync, rmSync } from 'node:fs';",
      "import { getSettingsPaths as resolvePaths } from '../core/statusline-ownership.ts';",
      "import { writeBufferAtomicSync } from '../fs-utils.ts';",
      'export function overwrite(cliHome: string): void {',
      '  const paths = resolvePaths(cliHome);',
      '  const localSettings = paths.settingsPath as string;',
      '  const localBackup = paths.backupPath;',
      '  writeBufferAtomicSync(localSettings, Buffer.from("{}"));',
      '  renameSync("/tmp/a", localBackup);',
      '  copyFileSync("/tmp/b", localSettings);',
      '  rmSync(localSettings);',
      '}',
    ].join('\n'),
  });
  const { errors } = collectArchitectureErrors(tmp, { checkSkills: false });
  assert.ok(errors.some((e) => e.includes('rogue-destructured.ts') && e.includes('settings.json statusLine')));
  assert.ok(errors.some((e) => e.includes('rogue-destructured.ts') && e.includes('statusLine backup')));
  assert.ok(errors.some((e) => e.includes('rogue-alias.ts') && e.includes('settings.json statusLine')));
  assert.ok(errors.some((e) => e.includes('rogue-alias.ts') && e.includes('statusLine backup')));
});

void test('verify 门禁将向 stderr 输出警告的零退出码步骤判为失败', async () => {
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
    stepRunner: (name): Promise<StepOutcome> => {
      const stepStderr = name === 'test' ? 'Warning: simulated runtime warning on stderr\n' : '';
      return Promise.resolve({
        name,
        code: 0,
        durationMs: 12,
        stdout: 'ok\n',
        stderr: stepStderr,
        warningReason: detectStepWarning(name, 'ok\n', stepStderr),
      });
    },
  });
  assert.equal(code, 1);
  assert.ok(stdout.includes('[FAIL] test (12ms) [stderr warning/diagnostic]'));
  assert.ok(stderr.includes('simulated runtime warning on stderr'));
});

void test('verify 门禁捕获 node --test 写入 stdout 的运行时警告', async () => {
  const testStdout =
    '(node:17264) Warning: simulated emitWarning in test\n(Use `node --trace-warnings ...` to show where the warning was created)\nok 1 - sample test\n';
  assert.equal(detectStepWarning('test', testStdout, ''), 'stdout runtime warning');
  assert.equal(detectStepWarning('test', 'ok 1 - verify 门禁拦截警告 (1ms)\n', ''), null);

  let out = '';
  const code = await runVerify({
    stdout: {
      write: (chunk: string): boolean => {
        out += chunk;
        return true;
      },
    },
    stderr: { write: (): boolean => true },
    stepRunner: (name): Promise<StepOutcome> => {
      const stepStdout = name === 'test' ? testStdout : 'ok\n';
      return Promise.resolve({
        name,
        code: 0,
        durationMs: 10,
        stdout: stepStdout,
        stderr: '',
        warningReason: detectStepWarning(name, stepStdout, ''),
      });
    },
  });
  assert.equal(code, 1);
  assert.ok(out.includes('[FAIL] test (10ms) [stdout runtime warning]'));
});

void test('verify 门禁在 Windows 下通过 cmd.exe 或 pnpm npm_execpath 启动 pnpm', () => {
  const viaCmd = resolvePnpmSpawnSpec(['run', 'lint'], 'win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' });
  assert.deepEqual(viaCmd, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm.cmd', '--silent', 'run', 'lint'],
  });

  const nonPnpmExec = resolvePnpmSpawnSpec(['run', 'lint'], 'win32', {
    npm_execpath: 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
  });
  assert.equal(nonPnpmExec.command, 'cmd.exe');

  const viaNpmExec = resolvePnpmSpawnSpec(
    ['run', 'test'],
    'win32',
    { npm_execpath: 'C:\\pnpm\\dist\\pnpm.cjs' },
    'C:\\Program Files\\nodejs\\node.exe',
  );
  assert.deepEqual(viaNpmExec, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\pnpm\\dist\\pnpm.cjs', '--silent', 'run', 'test'],
  });

  const viaPosix = resolvePnpmSpawnSpec(['run', 'build'], 'darwin', {});
  assert.deepEqual(viaPosix, { command: 'pnpm', args: ['--silent', 'run', 'build'] });
});
