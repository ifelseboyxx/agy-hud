import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  buildSafeGitEnv,
  detectGitStatus,
  findGitRepoRoot,
  GIT_CACHE_TTL_MS,
  parseDiffNumstat,
  parsePorcelainV2Status,
  SAFE_GIT_CONFIG_ARGS,
} from '../git.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: readonly string[]): void {
  const res = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

void describe('enhanced cached git status collector', () => {
  void it('parses porcelain v2 branch, ahead/behind, stash, and working-tree counters', () => {
    const sample = [
      '# branch.oid abc1234567890',
      '# branch.head feat/ux',
      '# branch.ab +3 -1',
      '# stash 2',
      '1 M. N... 100644 100644 100644 a b staged.ts',
      '1 .M N... 100644 100644 100644 a b mod.ts',
      '1 .D N... 100644 100644 000000 a b del.ts',
      '2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? untracked.ts',
    ].join('\n');
    const parsed = parsePorcelainV2Status(sample, 'fallback');
    assert.equal(parsed.branch, 'feat/ux');
    assert.equal(parsed.dirty, true);
    assert.equal(parsed.ahead, 3);
    assert.equal(parsed.behind, 1);
    assert.equal(parsed.stash, 2);
    assert.equal(parsed.staged, 1);
    assert.equal(parsed.modified, 1);
    assert.equal(parsed.deleted, 1);
    assert.equal(parsed.renamed, 1);
    assert.equal(parsed.conflicted, 1);
    assert.equal(parsed.untracked, 1);
  });

  void it('sums tracked diff numstat additions and deletions while skipping binary rows', () => {
    const parsed = parseDiffNumstat('12\t4\tsrc/a.ts\n-\t-\tassets/logo.png\n5\t0\tsrc/b.ts\n');
    assert.deepEqual(parsed, { diffAdded: 17, diffDeleted: 4 });
  });

  void it('collects live status and diff counts, hits cache within TTL, and invalidates on index change', () => {
    const root = makeTempDir('agy-hud-git-live-');
    const cliHome = path.join(root, 'cli-home');
    const repo = path.join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    runGit(repo, ['init', '-b', 'main']);
    writeFileSync(path.join(repo, 'app.ts'), 'line1\nline2\n', 'utf8');
    runGit(repo, ['add', 'app.ts']);
    runGit(repo, ['commit', '-m', 'init']);

    writeFileSync(path.join(repo, 'app.ts'), 'line1\nline2-edited\nline3\n', 'utf8');
    writeFileSync(path.join(repo, 'extra.ts'), 'untracked\n', 'utf8');

    const t0 = 1_780_000_000_000;
    const first = detectGitStatus(cliHome, repo, undefined, { nowMs: t0, timeoutMs: 5_000 });
    assert.equal(first.branch, 'main');
    assert.equal(first.dirty, true);
    assert.equal(first.modified, 1);
    assert.equal(first.untracked, 1);
    assert.equal(first.diffAdded, 2);
    assert.equal(first.diffDeleted, 1);

    const cacheDir = path.join(cliHome, 'cache');
    const gitCaches = readdirSync(cacheDir).filter((f) => f.startsWith('agy_hud_git_'));
    assert.equal(gitCaches.length, 1);

    // Within TTL and unchanged HEAD/index -> cache hit returns prior snapshot even if a new untracked file appears.
    writeFileSync(path.join(repo, 'extra2.ts'), 'cached\n', 'utf8');
    const warmHit = detectGitStatus(cliHome, repo, undefined, { nowMs: t0 + 500, timeoutMs: 5_000 });
    assert.equal(warmHit.untracked, 1);

    // Staging mutates .git/index -> invalidates immediately even within TTL.
    runGit(repo, ['add', 'extra.ts']);
    const afterStage = detectGitStatus(cliHome, repo, undefined, { nowMs: t0 + 600, timeoutMs: 5_000 });
    assert.equal(afterStage.staged, 1);
    assert.equal(afterStage.untracked, 1);

    // Advancing past TTL refreshes again.
    writeFileSync(path.join(repo, 'extra3.ts'), 'after-ttl\n', 'utf8');
    const afterTtl = detectGitStatus(cliHome, repo, undefined, {
      nowMs: t0 + 600 + GIT_CACHE_TTL_MS + 100,
      timeoutMs: 5_000,
    });
    assert.equal(afterTtl.untracked, 2);
  });

  void it('returns stdin fallback without writing cache outside git repositories', () => {
    const root = makeTempDir('agy-hud-nogit-');
    const cliHome = path.join(root, 'cli-home');
    const plainDir = path.join(root, 'plain');
    mkdirSync(plainDir, { recursive: true });

    assert.equal(findGitRepoRoot(plainDir), null);
    const info = detectGitStatus(cliHome, plainDir, { branch: 'virtual', dirty: true });
    assert.equal(info.branch, 'virtual');
    assert.equal(info.dirty, true);
    assert.equal(existsSync(path.join(cliHome, 'cache')), false);
  });

  void it('hardens git config/env, counts staged deletions, handles unborn edits & HEAD file disambiguation, and degrades on huge HEAD', () => {
    assert.ok(SAFE_GIT_CONFIG_ARGS.includes('core.fsmonitor=false'));
    assert.ok(SAFE_GIT_CONFIG_ARGS.includes('diff.external='));
    assert.ok(SAFE_GIT_CONFIG_ARGS.includes('core.pager=cat'));

    const safeEnv = buildSafeGitEnv('/tmp/work/repo', {
      PATH: '/usr/bin',
      GIT_EXTERNAL_DIFF: '/evil/diff.sh',
      GIT_SSH_COMMAND: '/evil/ssh',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'",
    });
    assert.equal(safeEnv.GIT_EXTERNAL_DIFF, '');
    assert.equal(safeEnv.GIT_SSH_COMMAND, undefined);
    assert.equal(safeEnv.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(safeEnv.GIT_CONFIG_NOSYSTEM, '1');
    assert.ok(typeof safeEnv.GIT_CONFIG_GLOBAL === 'string' && safeEnv.GIT_CONFIG_GLOBAL.length > 0);
    assert.equal(safeEnv.GIT_CEILING_DIRECTORIES, path.dirname(path.resolve('/tmp/work/repo')));

    // Staged deletion (D.) increments both staged and deleted.
    const stagedDel = parsePorcelainV2Status(
      ['# branch.oid abc1234', '# branch.head main', '1 D. N... 100644 000000 000000 a b gone.ts'].join('\n'),
      'main',
    );
    assert.equal(stagedDel.staged, 1);
    assert.equal(stagedDel.deleted, 1);

    // Unborn HEAD counts both staged additions and subsequent working-tree edits.
    const root = makeTempDir('agy-hud-git-unborn-');
    const cliHome = path.join(root, 'cli-home');
    const repo = path.join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    runGit(repo, ['init', '-b', 'main']);
    writeFileSync(path.join(repo, 'init.ts'), 'a\nb\nc\n', 'utf8');
    runGit(repo, ['add', 'init.ts']);
    writeFileSync(path.join(repo, 'init.ts'), 'a\nb\nc\nd\n', 'utf8');
    const unbornInfo = detectGitStatus(cliHome, repo, undefined, { nowMs: 1_780_000_000_000, timeoutMs: 5_000 });
    assert.equal(unbornInfo.staged, 1);
    assert.equal(unbornInfo.modified, 1);
    assert.equal(unbornInfo.diffAdded, 4);

    // Existing file named HEAD in repo root must not break `git diff --numstat HEAD --`.
    runGit(repo, ['add', 'init.ts']);
    runGit(repo, ['commit', '-m', 'init']);
    writeFileSync(path.join(repo, 'HEAD'), 'not-a-ref\n', 'utf8');
    writeFileSync(path.join(repo, 'init.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
    const headFileInfo = detectGitStatus(cliHome, repo, undefined, { nowMs: 1_780_000_010_000, timeoutMs: 5_000 });
    assert.equal(headFileInfo.diffAdded, 1);

    // Oversized HEAD metadata degrades gracefully without throwing.
    const bigRepo = path.join(root, 'big-head');
    mkdirSync(path.join(bigRepo, '.git'), { recursive: true });
    writeFileSync(path.join(bigRepo, '.git', 'HEAD'), 'x'.repeat(80_000), 'utf8');
    const degraded = detectGitStatus(cliHome, bigRepo, { branch: 'safe-fallback', dirty: false });
    assert.equal(degraded.branch, 'safe-fallback');
  });
});
