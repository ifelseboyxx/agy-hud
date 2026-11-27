import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { parseSync, Visitor } from 'oxc-parser';

import { runAtomicBuild } from '../scripts/build.mts';
import viteDefaultConfig from '../vite.config.ts';
import { createTempDirTracker, makeIsolatedEnv, REPO_ROOT, spawnNodeAsync, writeJson } from './helpers.ts';

const execFileAsync = promisify(execFile);
const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

function writeTree(baseDir: string, files: Record<string, { content: string; mode?: number; mtimeMs?: number }>): void {
  for (const [rel, spec] of Object.entries(files)) {
    const abs = path.join(baseDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, spec.content, 'utf8');
    if (spec.mode !== undefined && process.platform !== 'win32') {
      chmodSync(abs, spec.mode);
    }
    if (spec.mtimeMs !== undefined) {
      const ts = new Date(spec.mtimeMs);
      utimesSync(abs, ts, ts);
    }
  }
}

function collectModuleSpecifiers(filePath: string, code: string): string[] {
  const parsed = parseSync(filePath, code);
  assert.equal(parsed.errors.length, 0);
  const specifiers = new Set<string>();
  for (const imp of parsed.module.staticImports) {
    specifiers.add(imp.moduleRequest.value);
  }
  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest?.value) specifiers.add(entry.moduleRequest.value);
    }
  }
  const visitor = new Visitor({
    ImportExpression(node): void {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        specifiers.add(node.source.value);
      } else {
        specifiers.add('<dynamic-expression>');
      }
    },
  });
  visitor.visit(parsed.program);
  return [...specifiers];
}

void describe('runAtomicBuild', async () => {
  const sharedTracker = createTempDirTracker();
  let sharedOutDir = '';

  before(async () => {
    const sharedRoot = sharedTracker.makeTempDir('agy-hud-atomic-shared-');
    sharedOutDir = path.join(sharedRoot, 'dist');
    await runAtomicBuild({ outDir: sharedOutDir, logLevel: 'silent' });
  });

  after(() => {
    sharedTracker.cleanup();
  });

  await it('isolates default vite config outDir away from dist', () => {
    const defaultOutDir = viteDefaultConfig.build?.outDir ?? '';
    assert.notEqual(path.resolve(REPO_ROOT, defaultOutDir), path.resolve(REPO_ROOT, 'dist'));
  });

  await it('emits hud.mjs without any non-builtin module references', () => {
    const hudPath = path.join(sharedOutDir, 'hud.mjs');
    const hudCode = readFileSync(hudPath, 'utf8');
    const nonBuiltinSpecs = collectModuleSpecifiers(hudPath, hudCode).filter((spec) => !spec.startsWith('node:'));
    assert.deepEqual(nonBuiltinSpecs, []);
  });

  await it('emits hud.mjs as an executable Node script', () => {
    const hudPath = path.join(sharedOutDir, 'hud.mjs');
    assert.ok(readFileSync(hudPath, 'utf8').startsWith('#!/usr/bin/env node\n'));
    if (process.platform !== 'win32') {
      assert.equal(statSync(hudPath).mode & 0o777, 0o755);
    }
  });

  await it('emits all expected distribution files', () => {
    for (const rel of ['hud.mjs', 'cli.mjs', 'mcp-hud.mjs', 'index.mjs', 'index.d.mts', 'types.d.mts']) {
      assert.equal(existsSync(path.join(sharedOutDir, rel)), true, `missing ${rel}`);
    }
  });

  await it('rejects an outDir overlapping staging cache before compiling', async () => {
    const root = tracker.makeTempDir('agy-hud-atomic-overlap-');
    const cacheDir = path.join(root, '.cache');
    mkdirSync(cacheDir, { recursive: true });

    await assert.rejects(() => runAtomicBuild({ rootDir: root, outDir: root, logLevel: 'silent' }), /overlap/i);
    await assert.rejects(() => runAtomicBuild({ rootDir: root, outDir: cacheDir, logLevel: 'silent' }), /overlap/i);
  });

  await it('rejects an outDir overlapping the source directory before compiling', async () => {
    const fakeRepo = tracker.makeTempDir('agy-hud-atomic-src-guard-');
    const srcDir = path.join(fakeRepo, 'src');
    writeTree(srcDir, { 'keep.ts': { content: 'export const keep = 1;\n' } });

    await assert.rejects(
      () => runAtomicBuild({ rootDir: fakeRepo, outDir: srcDir, logLevel: 'silent' }),
      /source|overlap/i,
    );
    assert.equal(readFileSync(path.join(srcDir, 'keep.ts'), 'utf8'), 'export const keep = 1;\n');
  });

  await it('preserves existing dist artifacts when a build fails', async () => {
    const root = tracker.makeTempDir('agy-hud-atomic-fail-keep-');
    const badRoot = path.join(root, 'empty-repo');
    const outDir = path.join(root, 'dist');
    mkdirSync(badRoot, { recursive: true });
    writeTree(outDir, {
      'hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("known-good");\n', mode: 0o755 },
    });

    await assert.rejects(() => runAtomicBuild({ rootDir: badRoot, outDir, logLevel: 'silent' }));

    assert.equal(
      readFileSync(path.join(outDir, 'hud.mjs'), 'utf8'),
      '#!/usr/bin/env node\nconsole.log("known-good");\n',
    );
  });

  await it('cleans up temporary staging directory when a build fails', async () => {
    const root = tracker.makeTempDir('agy-hud-atomic-fail-clean-');
    const badRoot = path.join(root, 'empty-repo');
    const outDir = path.join(root, 'dist');
    mkdirSync(badRoot, { recursive: true });

    await assert.rejects(() => runAtomicBuild({ rootDir: badRoot, outDir, logLevel: 'silent' }));

    const leftovers = readdirSync(root).filter((name) => name.includes('staging'));
    assert.deepEqual(leftovers, []);
  });

  await it('cleans up repo cache staging directory after an in-repo default build', async () => {
    const fakeRepo = tracker.makeTempDir('agy-hud-atomic-inrepo-');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(path.join(REPO_ROOT, 'src'), path.join(fakeRepo, 'src'), linkType);
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(fakeRepo, 'node_modules'), linkType);

    const result = await runAtomicBuild({ rootDir: fakeRepo, logLevel: 'silent' });

    assert.equal(result.outDir, path.join(fakeRepo, 'dist'));
    assert.equal(existsSync(path.join(fakeRepo, 'dist', 'hud.mjs')), true);
    assert.equal(existsSync(path.join(fakeRepo, '.cache')), false);
  });

  await it('keeps prior chunks loadable on first migration from split HUD to single-file HUD', async () => {
    const root = tracker.makeTempDir('agy-hud-atomic-first-migrate-');
    const outDir = path.join(root, 'dist');
    const yesterdayMs = Date.now() - 86_400_000;
    writeTree(outDir, {
      'hud.mjs': {
        content:
          '#!/usr/bin/env node\nimport { renderLegacy } from "./chunks/legacy-hud-aaa.mjs";\nexport { renderLegacy };\n',
        mode: 0o755,
        mtimeMs: yesterdayMs,
      },
      'chunks/legacy-hud-aaa.mjs': {
        content: 'import { helper } from "./legacy-nested-bbb.mjs";\nexport const renderLegacy = () => helper;\n',
        mtimeMs: yesterdayMs,
      },
      'chunks/legacy-nested-bbb.mjs': {
        content: 'export const helper = "legacy-ok";\n',
        mtimeMs: yesterdayMs,
      },
    });

    const oldHudCode = readFileSync(path.join(outDir, 'hud.mjs'), 'utf8');
    const [legacyChunkSpec] = collectModuleSpecifiers(path.join(outDir, 'hud.mjs'), oldHudCode);
    assert.equal(legacyChunkSpec, './chunks/legacy-hud-aaa.mjs');

    await runAtomicBuild({ outDir, logLevel: 'silent' });

    const loaded = (await import(pathToFileURL(path.resolve(outDir, legacyChunkSpec)).href)) as {
      renderLegacy: () => string;
    };
    assert.equal(loaded.renderLegacy(), 'legacy-ok');
  });

  await it('keeps concurrent statusline executions error-free across repeated rebuilds', async () => {
    const root = tracker.makeTempDir('agy-hud-atomic-race-');
    const outDir = path.join(root, 'dist');
    const hudBin = path.join(outDir, 'hud.mjs');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    writeJson(path.join(cliHome, 'hud-config.json'), { preset: 'zen' });
    const payloadPath = path.join(root, 'payload.json');
    const payload = JSON.stringify({
      cwd: root,
      model: { display_name: 'Gemini 4 Carbon', effort: 'high' },
      vcs: { branch: 'main', dirty: false },
      terminal_width: 100,
    });
    writeFileSync(payloadPath, payload, 'utf8');
    const env = makeIsolatedEnv(root);

    cpSync(sharedOutDir, outDir, { recursive: true });

    let done = false;
    let totalRuns = 0;
    let completedRuns = 0;
    const failures: string[] = [];

    const runOnce = async (): Promise<void> => {
      if (process.platform === 'win32') {
        const res = await spawnNodeAsync([hudBin], env, { stdinText: payload });
        if (res.status !== 0) failures.push(`status=${String(res.status)}`);
        if (!res.stdout.includes('G4 Carbon')) failures.push(`unexpected stdout: ${JSON.stringify(res.stdout)}`);
        if (res.stderr.trim().length > 0) failures.push(`unexpected stderr: ${res.stderr.trim()}`);
        return;
      }
      const res = await execFileAsync('sh', ['-c', '"$1" < "$2"', '_', hudBin, payloadPath], {
        env,
        encoding: 'utf8',
      });
      if (!res.stdout.includes('G4 Carbon')) {
        failures.push(`unexpected stdout: ${JSON.stringify(res.stdout)}`);
      }
      if (res.stderr.trim().length > 0) {
        failures.push(`unexpected stderr: ${res.stderr.trim()}`);
      }
    };

    const worker = async (): Promise<void> => {
      while (!done) {
        totalRuns += 1;
        try {
          await runOnce();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          failures.push(detail);
        } finally {
          completedRuns += 1;
        }
      }
    };

    const rebuildScript = [
      "import { runAtomicBuild } from './scripts/build.mts';",
      `for (let i = 0; i < 4; i += 1) await runAtomicBuild({ outDir: ${JSON.stringify(outDir)}, logLevel: 'silent' });`,
    ].join('\n');

    const workers = Array.from({ length: 6 }, () => worker());
    try {
      while (completedRuns < 6 && failures.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const runsAtRebuildStart = totalRuns;
      const rebuildRes = await spawnNodeAsync(['--input-type=module', '-e', rebuildScript], env);
      assert.equal(rebuildRes.status, 0, rebuildRes.stderr);
      assert.ok(
        totalRuns - runsAtRebuildStart >= 12,
        `expected at least 12 concurrent executions during rebuild, got ${totalRuns - runsAtRebuildStart}`,
      );
    } finally {
      done = true;
      await Promise.all(workers);
    }

    assert.deepEqual(failures, []);
  });
});
