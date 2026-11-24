import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { parseSync } from 'oxc-parser';

import { publishStagingDirSync } from '../scripts/build.mts';
import { createTempDirTracker, makeIsolatedEnv, spawnNodeAsync } from './helpers.ts';

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

function isCaseInsensitiveDir(dirPath: string): boolean {
  const probe = path.join(dirPath, 'case-probe');
  writeFileSync(probe, '');
  return existsSync(path.join(dirPath, 'CASE-PROBE'));
}

void describe('publishStagingDirSync', async () => {
  await it('replaces existing entry files with a new inode', () => {
    const root = tracker.makeTempDir('agy-hud-publish-inode-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(targetDir, { 'hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("old");\n', mode: 0o755 } });
    writeTree(stagingDir, { 'hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("new");\n', mode: 0o755 } });

    const beforeIno = statSync(path.join(targetDir, 'hud.mjs')).ino;
    publishStagingDirSync(stagingDir, targetDir);

    const hudPath = path.join(targetDir, 'hud.mjs');
    assert.equal(readFileSync(hudPath, 'utf8'), '#!/usr/bin/env node\nconsole.log("new");\n');
    assert.notEqual(statSync(hudPath).ino, beforeIno);
  });

  await it('preserves executable mode bits on published entry files', () => {
    const root = tracker.makeTempDir('agy-hud-publish-mode-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(stagingDir, { 'hud.mjs': { content: '#!/usr/bin/env node\n', mode: 0o755 } });

    publishStagingDirSync(stagingDir, targetDir);

    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(targetDir, 'hud.mjs')).mode & 0o777, 0o755);
    }
  });

  await it('retains retired chunks while inside the retention grace period', () => {
    const root = tracker.makeTempDir('agy-hud-publish-grace-keep-');
    const targetDir = path.join(root, 'dist');
    const stagingDir1 = path.join(root, 'staging1');
    const stagingDir2 = path.join(root, 'staging2');
    const yesterdayMs = Date.now() - 86_400_000;
    const t0 = Date.now();
    writeTree(targetDir, {
      'cli.mjs': { content: 'import "./chunks/old-aaa.mjs";\n', mtimeMs: yesterdayMs },
      'chunks/old-aaa.mjs': { content: 'export const v = 1;\n', mtimeMs: yesterdayMs },
    });
    writeTree(stagingDir1, {
      'cli.mjs': { content: 'import "./chunks/new-bbb.mjs";\n' },
      'chunks/new-bbb.mjs': { content: 'export const v = 2;\n' },
    });

    publishStagingDirSync(stagingDir1, targetDir, { nowMs: t0, staleChunkRetentionMs: 60_000 });
    assert.equal(existsSync(path.join(targetDir, 'chunks', 'old-aaa.mjs')), true);

    writeTree(stagingDir2, {
      'cli.mjs': { content: 'import "./chunks/new-ccc.mjs";\n' },
      'chunks/new-ccc.mjs': { content: 'export const v = 3;\n' },
    });
    publishStagingDirSync(stagingDir2, targetDir, { nowMs: t0 + 10_000, staleChunkRetentionMs: 60_000 });
    assert.equal(existsSync(path.join(targetDir, 'chunks', 'old-aaa.mjs')), true);
  });

  await it('prunes retired chunks once the retention grace period expires', () => {
    const root = tracker.makeTempDir('agy-hud-publish-grace-prune-');
    const targetDir = path.join(root, 'dist');
    const stagingDir1 = path.join(root, 'staging1');
    const stagingDir2 = path.join(root, 'staging2');
    const t0 = Date.now();
    writeTree(targetDir, {
      'cli.mjs': { content: 'import "./chunks/old-aaa.mjs";\n' },
      'chunks/old-aaa.mjs': { content: 'export const v = 1;\n' },
    });
    writeTree(stagingDir1, {
      'cli.mjs': { content: 'import "./chunks/new-bbb.mjs";\n' },
      'chunks/new-bbb.mjs': { content: 'export const v = 2;\n' },
    });
    publishStagingDirSync(stagingDir1, targetDir, { nowMs: t0, staleChunkRetentionMs: 60_000 });

    writeTree(stagingDir2, {
      'cli.mjs': { content: 'import "./chunks/new-bbb.mjs";\n' },
      'chunks/new-bbb.mjs': { content: 'export const v = 2;\n' },
    });
    const result = publishStagingDirSync(stagingDir2, targetDir, {
      nowMs: t0 + 61_000,
      staleChunkRetentionMs: 60_000,
    });

    assert.equal(existsSync(path.join(targetDir, 'chunks', 'old-aaa.mjs')), false);
    assert.deepEqual(result.removedFiles, ['chunks/old-aaa.mjs']);
  });

  await it('prunes empty chunks directory after all retired chunks expire', () => {
    const root = tracker.makeTempDir('agy-hud-publish-prune-chunks-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    const expiredMs = Date.now() - 120_000;
    writeTree(targetDir, {
      'hud.mjs': { content: 'old hud\n' },
      'chunks/orphan-aaa.mjs': { content: 'export const x = 1;\n', mtimeMs: expiredMs },
    });
    writeTree(stagingDir, { 'hud.mjs': { content: 'new hud\n' } });

    publishStagingDirSync(stagingDir, targetDir, { nowMs: Date.now(), staleChunkRetentionMs: 60_000 });

    assert.equal(existsSync(path.join(targetDir, 'chunks')), false);
    assert.equal(existsSync(targetDir), true);
  });

  await it('preserves non-owned files in target directory during cleanup', () => {
    const root = tracker.makeTempDir('agy-hud-publish-non-owned-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(targetDir, {
      'hud.mjs': { content: 'old hud\n' },
      'custom.ts': { content: 'export const keep = true;\n' },
      'notes/readme.txt': { content: 'do not delete\n' },
    });
    writeTree(stagingDir, { 'hud.mjs': { content: 'new hud\n' } });

    publishStagingDirSync(stagingDir, targetDir, { staleChunkRetentionMs: 0 });

    assert.equal(readFileSync(path.join(targetDir, 'custom.ts'), 'utf8'), 'export const keep = true;\n');
    assert.equal(readFileSync(path.join(targetDir, 'notes', 'readme.txt'), 'utf8'), 'do not delete\n');
  });

  await it('preserves newly published chunks when target already has differently-cased Chunks', (t) => {
    const root = tracker.makeTempDir('agy-hud-publish-case-');
    if (!isCaseInsensitiveDir(root)) {
      t.skip('requires a case-insensitive file system');
      return;
    }
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    const expiredMs = Date.now() - 120_000;
    writeTree(targetDir, {
      'cli.mjs': { content: 'console.log("old");\n' },
      'Chunks/old-aaa.mjs': { content: 'export const oldVal = 1;\n', mtimeMs: expiredMs },
    });
    writeTree(stagingDir, {
      'cli.mjs': { content: 'import "./chunks/new-bbb.mjs";\n' },
      'chunks/new-bbb.mjs': { content: 'export const newVal = 2;\n' },
    });

    publishStagingDirSync(stagingDir, targetDir, { staleChunkRetentionMs: 0 });

    assert.equal(readFileSync(path.join(targetDir, 'chunks', 'new-bbb.mjs'), 'utf8'), 'export const newVal = 2;\n');
    assert.equal(existsSync(path.join(targetDir, 'Chunks', 'old-aaa.mjs')), false);
  });

  await it('preserves a differently-cased foreign top-level file on case-sensitive volumes', (t) => {
    const root = tracker.makeTempDir('agy-hud-publish-cs-file-');
    if (isCaseInsensitiveDir(root)) {
      t.skip('requires a case-sensitive file system');
      return;
    }
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(targetDir, { 'hud.mjs': { content: 'old hud\n' }, 'CLI.mjs': { content: 'foreign\n' } });
    writeTree(stagingDir, { 'hud.mjs': { content: 'new hud\n' } });

    publishStagingDirSync(stagingDir, targetDir, { staleChunkRetentionMs: 0 });

    assert.equal(readFileSync(path.join(targetDir, 'CLI.mjs'), 'utf8'), 'foreign\n');
  });

  await it('preserves a differently-cased foreign Chunks directory on case-sensitive volumes', (t) => {
    const root = tracker.makeTempDir('agy-hud-publish-cs-chunks-');
    if (isCaseInsensitiveDir(root)) {
      t.skip('requires a case-sensitive file system');
      return;
    }
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(targetDir, {
      'hud.mjs': { content: 'old hud\n' },
      'Chunks/foreign-aaa.mjs': { content: 'export const x = 1;\n', mtimeMs: Date.now() - 120_000 },
    });
    writeTree(stagingDir, { 'hud.mjs': { content: 'new hud\n' } });

    publishStagingDirSync(stagingDir, targetDir, { staleChunkRetentionMs: 0 });

    assert.equal(existsSync(path.join(targetDir, 'Chunks', 'foreign-aaa.mjs')), true);
  });

  await it('reports a prune failure as a warning after entries are published', (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('POSIX non-root directory permission test');
      return;
    }
    const root = tracker.makeTempDir('agy-hud-publish-prune-warn-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    const chunksDir = path.join(targetDir, 'chunks');
    writeTree(targetDir, {
      'hud.mjs': { content: 'old hud\n' },
      'chunks/stale-aaa.mjs': { content: 'export const x = 1;\n', mtimeMs: Date.now() - 120_000 },
    });
    writeTree(stagingDir, { 'hud.mjs': { content: 'new hud\n' } });

    chmodSync(chunksDir, 0o555);
    let result: ReturnType<typeof publishStagingDirSync>;
    try {
      result = publishStagingDirSync(stagingDir, targetDir, { staleChunkRetentionMs: 0 });
    } finally {
      chmodSync(chunksDir, 0o755);
    }

    assert.equal(readFileSync(path.join(targetDir, 'hud.mjs'), 'utf8'), 'new hud\n');
    assert.equal(result.pruneWarnings.length, 1);
  });

  await it('publishes nested chunks before replacing top-level entry files', () => {
    const root = tracker.makeTempDir('agy-hud-publish-order-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(stagingDir, {
      'cli.mjs': { content: 'import "./chunks/shared-new.mjs";\n' },
      'chunks/shared-new.mjs': { content: 'export const v = 2;\n' },
    });

    const result = publishStagingDirSync(stagingDir, targetDir);

    assert.deepEqual(result.publishedFiles, ['chunks/shared-new.mjs', 'cli.mjs']);
  });

  await it('rejects staging paths that overlap with target directory', () => {
    const root = tracker.makeTempDir('agy-hud-publish-guard-');
    const targetDir = path.join(root, 'dist');
    const nestedStaging = path.join(targetDir, 'nested');
    mkdirSync(nestedStaging, { recursive: true });

    assert.throws(() => publishStagingDirSync(targetDir, targetDir), /overlap/i);
    assert.throws(() => publishStagingDirSync(nestedStaging, targetDir), /overlap/i);
    assert.throws(() => publishStagingDirSync(root, targetDir), /overlap/i);
  });

  await it('rejects publishing through a symlinked target subdirectory', () => {
    const root = tracker.makeTempDir('agy-hud-publish-symlink-');
    const targetDir = path.join(root, 'dist');
    const outsideDir = path.join(root, 'outside');
    const stagingDir = path.join(root, 'staging');
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, path.join(targetDir, 'chunks'), process.platform === 'win32' ? 'junction' : 'dir');
    writeTree(targetDir, { 'hud.mjs': { content: 'keep-me\n' } });
    writeTree(stagingDir, {
      'hud.mjs': { content: 'new-hud\n' },
      'chunks/shared.mjs': { content: 'export const x = 1;\n' },
    });

    assert.throws(() => publishStagingDirSync(stagingDir, targetDir), /symbolic link|non-directory/i);
    assert.equal(readFileSync(path.join(targetDir, 'hud.mjs'), 'utf8'), 'keep-me\n');
  });

  await it('rejects overwriting a directory entry before modifying target files', () => {
    const root = tracker.makeTempDir('agy-hud-publish-dir-conflict-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    mkdirSync(path.join(targetDir, 'cli.mjs'), { recursive: true });
    writeTree(targetDir, { 'hud.mjs': { content: 'keep-me\n' } });
    writeTree(stagingDir, {
      'chunks/shared.mjs': { content: 'export const x = 1;\n' },
      'cli.mjs': { content: 'console.log("cli");\n' },
      'hud.mjs': { content: 'new-hud\n' },
    });

    assert.throws(() => publishStagingDirSync(stagingDir, targetDir), /directory|symbolic link/i);
    assert.equal(existsSync(path.join(targetDir, 'chunks', 'shared.mjs')), false);
    assert.equal(readFileSync(path.join(targetDir, 'hud.mjs'), 'utf8'), 'keep-me\n');
  });

  await it('rolls back replaced entries when a mid-publish replacement fails with EPERM', () => {
    const root = tracker.makeTempDir('agy-hud-publish-rollback-eperm-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(targetDir, {
      'cli.mjs': { content: '#!/usr/bin/env node\nconsole.log("old-cli");\n', mode: 0o755 },
      'hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("old-hud");\n', mode: 0o755 },
      'mcp-hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("old-mcp");\n', mode: 0o755 },
      'chunks/old-aaa.mjs': { content: 'export const v = 1;\n' },
    });
    writeTree(stagingDir, {
      'cli.mjs': { content: '#!/usr/bin/env node\nconsole.log("new-cli");\n', mode: 0o755 },
      'hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("new-hud");\n', mode: 0o755 },
      'mcp-hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("new-mcp");\n', mode: 0o755 },
      'chunks/new-bbb.mjs': { content: 'export const v = 2;\n' },
    });

    assert.throws(
      () =>
        publishStagingDirSync(stagingDir, targetDir, {
          staleChunkRetentionMs: 0,
          replaceFileSync: (srcPath, dstPath, defaultReplace) => {
            if (path.basename(dstPath) === 'hud.mjs') {
              throw Object.assign(new Error('EPERM: simulated rename failure on hud.mjs'), { code: 'EPERM' });
            }
            defaultReplace(srcPath, dstPath);
          },
        }),
      /EPERM/,
    );

    assert.equal(
      readFileSync(path.join(targetDir, 'cli.mjs'), 'utf8'),
      '#!/usr/bin/env node\nconsole.log("old-cli");\n',
    );
    assert.equal(
      readFileSync(path.join(targetDir, 'hud.mjs'), 'utf8'),
      '#!/usr/bin/env node\nconsole.log("old-hud");\n',
    );
    assert.equal(
      readFileSync(path.join(targetDir, 'mcp-hud.mjs'), 'utf8'),
      '#!/usr/bin/env node\nconsole.log("old-mcp");\n',
    );
    assert.equal(existsSync(path.join(targetDir, 'chunks', 'new-bbb.mjs')), false);
    assert.equal(readFileSync(path.join(targetDir, 'chunks', 'old-aaa.mjs'), 'utf8'), 'export const v = 1;\n');
  });

  await it('rolls back newly published chunks when an OS read-only target directory blocks entry replacement', (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('POSIX non-root directory permission test');
      return;
    }
    const root = tracker.makeTempDir('agy-hud-publish-rollback-os-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    writeTree(targetDir, {
      'hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("old-hud");\n', mode: 0o755 },
      'chunks/old-aaa.mjs': { content: 'export const v = 1;\n' },
    });
    writeTree(stagingDir, {
      'hud.mjs': { content: '#!/usr/bin/env node\nconsole.log("new-hud");\n', mode: 0o755 },
      'chunks/new-bbb.mjs': { content: 'export const v = 2;\n' },
    });

    chmodSync(targetDir, 0o555);
    try {
      assert.throws(() => publishStagingDirSync(stagingDir, targetDir, { staleChunkRetentionMs: 0 }));
    } finally {
      chmodSync(targetDir, 0o755);
    }

    assert.equal(existsSync(path.join(targetDir, 'chunks', 'new-bbb.mjs')), false);
    assert.equal(readFileSync(path.join(targetDir, 'chunks', 'old-aaa.mjs'), 'utf8'), 'export const v = 1;\n');
    assert.equal(
      readFileSync(path.join(targetDir, 'hud.mjs'), 'utf8'),
      '#!/usr/bin/env node\nconsole.log("old-hud");\n',
    );
  });

  await it('keeps prior chunks loadable when a split CLI entry rotates chunk hashes', async () => {
    const root = tracker.makeTempDir('agy-hud-publish-cli-rotate-');
    const targetDir = path.join(root, 'dist');
    const stagingDir = path.join(root, 'staging');
    const yesterdayMs = Date.now() - 86_400_000;
    writeTree(targetDir, {
      'cli.mjs': {
        content: 'import { tag } from "./chunks/cli-old.mjs";\nexport const v = tag;\n',
        mtimeMs: yesterdayMs,
      },
      'chunks/cli-old.mjs': { content: 'export const tag = "legacy-cli";\n', mtimeMs: yesterdayMs },
    });
    const oldCliPath = path.join(targetDir, 'cli.mjs');
    const parsed = parseSync(oldCliPath, readFileSync(oldCliPath, 'utf8'));
    const oldChunkSpec = parsed.module.staticImports[0]?.moduleRequest.value;
    assert.equal(oldChunkSpec, './chunks/cli-old.mjs');

    writeTree(stagingDir, {
      'cli.mjs': { content: 'import { tag } from "./chunks/cli-new.mjs";\nexport const v = tag;\n' },
      'chunks/cli-new.mjs': { content: 'export const tag = "fresh-cli";\n' },
    });
    publishStagingDirSync(stagingDir, targetDir);

    const loaded = (await import(pathToFileURL(path.resolve(targetDir, oldChunkSpec)).href)) as { tag: string };
    assert.equal(loaded.tag, 'legacy-cli');
  });

  await it('serializes concurrent publishes to preserve entry chunk consistency', async () => {
    const root = tracker.makeTempDir('agy-hud-publish-lock-');
    const targetDir = path.join(root, 'dist');
    const env = makeIsolatedEnv(root);

    const makeWorkerScript = (tag: string): string =>
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "import { publishStagingDirSync } from './scripts/build.mts';",
        `const root = ${JSON.stringify(root)};`,
        `const targetDir = ${JSON.stringify(targetDir)};`,
        `for (let i = 0; i < 12; i += 1) {`,
        `  const staging = path.join(root, 'stage-${tag}-' + i);`,
        `  const chunk = 'chunk-${tag}-' + i + '.mjs';`,
        `  mkdirSync(path.join(staging, 'chunks'), { recursive: true });`,
        `  writeFileSync(path.join(staging, 'chunks', chunk), 'export const id = "' + chunk + '";\\n');`,
        `  writeFileSync(path.join(staging, 'cli.mjs'), chunk);`,
        `  publishStagingDirSync(staging, targetDir);`,
        `}`,
      ].join('\n');

    const [resA, resB] = await Promise.all([
      spawnNodeAsync(['--input-type=module', '-e', makeWorkerScript('a')], env),
      spawnNodeAsync(['--input-type=module', '-e', makeWorkerScript('b')], env),
    ]);
    assert.equal(resA.status, 0, resA.stderr);
    assert.equal(resB.status, 0, resB.stderr);

    const referencedChunk = readFileSync(path.join(targetDir, 'cli.mjs'), 'utf8').trim();
    assert.equal(existsSync(path.join(targetDir, 'chunks', referencedChunk)), true);
  });
});
