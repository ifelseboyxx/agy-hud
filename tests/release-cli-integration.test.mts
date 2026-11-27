import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { parseSync } from 'oxc-parser';

import { EXECUTABLE_DIST_FILES, EXECUTABLE_REPO_PATHS, EXPECTED_DIST_FILES } from '../scripts/lib/dist-manifest.mts';
import { resolvePnpmSpawnSpec } from '../scripts/lib/pnpm-spawn.mts';
import { runReleaseCli } from '../scripts/release.mts';
import { createTempDirTracker, REPO_ROOT, writeJson } from './helpers.ts';

const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

function gitIn(dir: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release Test',
      GIT_AUTHOR_EMAIL: 'release-test@example.com',
      GIT_COMMITTER_NAME: 'Release Test',
      GIT_COMMITTER_EMAIL: 'release-test@example.com',
    },
  }).trim();
}

function createIsolatedGitRepo(version = '0.1.0'): string {
  const dir = tracker.makeTempDir('agy-hud-release-repo-');
  gitIn(dir, ['init', '-b', 'main']);
  gitIn(dir, ['config', 'user.name', 'Release Test']);
  gitIn(dir, ['config', 'user.email', 'release-test@example.com']);
  writeJson(path.join(dir, 'package.json'), { name: 'agy-hud', version });
  writeJson(path.join(dir, 'plugin.json'), { name: 'agy-hud', version });
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'dist', 'hud.mjs'), '#!/usr/bin/env node\n', 'utf8');
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-m', 'init(root): bootstrap fixture']);
  return dir;
}

function runReleaseCapture(
  argv: readonly string[],
  opts: Parameters<typeof runReleaseCli>[1],
): {
  code: number;
  stdout: string;
  stderr: string;
} {
  let stdout = '';
  let stderr = '';
  const code = runReleaseCli(argv, {
    ...opts,
    stdout: {
      write(chunk: string): boolean {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string): boolean {
        stderr += chunk;
        return true;
      },
    },
  });
  return { code, stdout, stderr };
}

void describe('local pnpm release CLI orchestration, security guards, and workflow contracts', () => {
  void it('supports prepare --dry-run, atomic rollback on failure, and local annotated tag creation without pushing', () => {
    const repo = createIsolatedGitRepo('0.1.0');

    // Dry-run makes zero mutations
    const dryRes = runReleaseCapture(['prepare', 'current', '--dry-run'], {
      rootDir: repo,
      todayIso: '2026-11-27',
      skipBuildAndDistCheck: true,
    });
    assert.equal(dryRes.code, 0, dryRes.stderr);
    assert.ok(dryRes.stdout.includes('[DRY RUN]'));
    assert.equal(existsSync(path.join(repo, 'CHANGELOG.md')), false);

    // Dirty tree is rejected
    writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n', 'utf8');
    const dirtyRes = runReleaseCapture(['prepare', 'patch'], {
      rootDir: repo,
      todayIso: '2026-11-27',
      skipBuildAndDistCheck: true,
    });
    assert.equal(dirtyRes.code, 1);
    assert.ok(dirtyRes.stderr.includes('Working tree is not clean'));
    gitIn(repo, ['clean', '-fd']);

    // Prepare v0.1.0 on release/v0.1.0 without committing
    const prepRes = runReleaseCapture(['prepare', 'current'], {
      rootDir: repo,
      todayIso: '2026-11-27',
      skipBuildAndDistCheck: true,
    });
    assert.equal(prepRes.code, 0, prepRes.stderr);
    assert.equal(gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'release/v0.1.0');
    assert.equal(existsSync(path.join(repo, 'CHANGELOG.md')), true);

    // Commit on release branch, merge to main, and run release tag
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-m', 'release(root): v0.1.0']);
    gitIn(repo, ['checkout', 'main']);
    gitIn(repo, ['merge', '--ff-only', 'release/v0.1.0']);

    const tagRes = runReleaseCapture(['tag', '--skip-remote-check'], {
      rootDir: repo,
      skipVerifyInTag: true,
    });
    assert.equal(tagRes.code, 0, tagRes.stderr);
    assert.ok(tagRes.stdout.includes('git push origin v0.1.0'));
    assert.equal(gitIn(repo, ['cat-file', '-t', 'v0.1.0']), 'tag', 'must create an annotated tag, not lightweight');

    // Atomic rollback: build mutates dist/* then dist:check fails -> restores package.json, plugin.json, CHANGELOG.md, dist/*, and main branch
    const beforePkg = readFileSync(path.join(repo, 'package.json'), 'utf8');
    const beforeChangelog = readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');
    const beforeDistHud = readFileSync(path.join(repo, 'dist', 'hud.mjs'), 'utf8');
    const failRes = runReleaseCapture(['prepare', 'patch'], {
      rootDir: repo,
      todayIso: '2026-11-28',
      pnpmRunner: (cwd, args) => {
        if (args.includes('build')) {
          writeFileSync(path.join(cwd, 'dist', 'hud.mjs'), '// mutated by build\n', 'utf8');
          writeFileSync(path.join(cwd, 'dist', 'stray.mjs'), '// extra\n', 'utf8');
          mkdirSync(path.join(cwd, 'dist', 'index.mjs'), { recursive: true });
          return;
        }
        throw new Error('simulated dist:check failure');
      },
    });
    assert.equal(failRes.code, 1);
    assert.ok(failRes.stderr.includes('simulated dist:check failure'));
    assert.equal(gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(readFileSync(path.join(repo, 'package.json'), 'utf8'), beforePkg);
    assert.equal(readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8'), beforeChangelog);
    assert.equal(readFileSync(path.join(repo, 'dist', 'hud.mjs'), 'utf8'), beforeDistHud);
    assert.equal(existsSync(path.join(repo, 'dist', 'stray.mjs')), false);
    assert.equal(existsSync(path.join(repo, 'dist', 'index.mjs')), false);
    assert.equal(gitIn(repo, ['status', '--porcelain']), '');
    assert.equal(gitIn(repo, ['branch', '--list', 'release/v0.1.1']), '');
  });

  void it('fails closed on unreachable origin in release tag, rejects repo-escaping symlinks in prepare, and shares cross-platform pnpm + dist manifest helpers', () => {
    const repo = createIsolatedGitRepo('0.1.0');
    const prepOk = runReleaseCapture(['prepare', 'current', '--no-branch'], {
      rootDir: repo,
      todayIso: '2026-11-27',
      skipBuildAndDistCheck: true,
    });
    assert.equal(prepOk.code, 0, prepOk.stderr);
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-m', 'release(root): v0.1.0']);

    // Without origin and without --skip-remote-check, tag must fail closed on prerelease branch (no main fetch to mask it)
    gitIn(repo, ['checkout', '-b', 'release/v0.1.1-rc.1']);
    writeJson(path.join(repo, 'package.json'), { name: 'agy-hud', version: '0.1.1-rc.1' });
    writeJson(path.join(repo, 'plugin.json'), { name: 'agy-hud', version: '0.1.1-rc.1' });
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-m', 'release(root): v0.1.1-rc.1']);
    const unreachableRes = runReleaseCapture(['tag'], { rootDir: repo, skipVerifyInTag: true });
    assert.equal(unreachableRes.code, 1);
    assert.ok(unreachableRes.stderr.includes('Could not query remote tags'));
    assert.equal(gitIn(repo, ['tag', '-l', 'v0.1.1-rc.1']), '');

    // Symlink target pointing outside repository must be rejected before mutating external file or switching branch
    if (process.platform !== 'win32') {
      const outsideDir = tracker.makeTempDir('agy-hud-outside-rel-');
      const secretTarget = path.join(outsideDir, 'outside-pkg.json');
      const originalOutside = '{"name":"agy-hud","version":"0.1.1-rc.1"}\n';
      writeFileSync(secretTarget, originalOutside, 'utf8');
      gitIn(repo, ['rm', 'package.json']);
      symlinkSync(secretTarget, path.join(repo, 'package.json'));
      gitIn(repo, ['add', 'package.json']);
      gitIn(repo, ['commit', '-m', 'test(root): symlinked package.json']);

      const symRes = runReleaseCapture(['prepare', 'prerelease'], {
        rootDir: repo,
        todayIso: '2026-11-28',
        skipBuildAndDistCheck: true,
      });
      assert.equal(symRes.code, 1);
      assert.ok(symRes.stderr.includes('symbolic link'), symRes.stderr);
      assert.equal(readFileSync(secretTarget, 'utf8'), originalOutside);
      assert.equal(gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'release/v0.1.1-rc.1');
    }

    // Shared cross-platform pnpm spec and single-source dist manifest invariants
    const winPnpm = resolvePnpmSpawnSpec(['run', 'build'], 'win32', { COMSPEC: 'cmd.exe' }, 'node.exe', false);
    assert.equal(winPnpm.command, 'cmd.exe');
    assert.deepEqual(winPnpm.args, ['/d', '/s', '/c', 'pnpm.cmd', 'run', 'build']);
    assert.equal(EXPECTED_DIST_FILES.length, 5);
    for (const exe of EXECUTABLE_DIST_FILES) {
      assert.ok(EXPECTED_DIST_FILES.includes(exe));
      assert.ok(EXECUTABLE_REPO_PATHS.includes(`dist/${exe}`));
    }
  });

  void it('extracts real root CHANGELOG.md v0.1.0 notes cleanly and enforces hardened release.yml + .github/release.yml contracts', () => {
    const notesRes = runReleaseCapture(['notes', 'v0.1.0', '--with-install-header', '--prev-tag', ''], {
      rootDir: REPO_ROOT,
    });
    assert.equal(notesRes.code, 0, notesRes.stderr);
    assert.ok(notesRes.stdout.includes('agy plugin install https://github.com/ifelseboyxx/agy-hud/tree/v0.1.0'));
    assert.ok(notesRes.stdout.includes('### Highlights'));

    const releaseYml = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.ok(
      releaseYml.includes('git fetch --no-tags --filter=blob:none origin +refs/heads/main:refs/remotes/origin/main'),
    );
    assert.ok(releaseYml.includes('git merge-base --is-ancestor'));
    assert.ok(releaseYml.includes('node scripts/release.mts notes "$RELEASE_TAG"'));
    assert.equal(
      releaseYml.includes('--generate-notes'),
      false,
      'release.yml must not mix --notes-file with --generate-notes',
    );
    assert.ok(releaseYml.includes('--verify-tag'));
    assert.ok(releaseYml.includes('gh api -i "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}"'));
    assert.ok(releaseYml.includes('gh release edit "$RELEASE_TAG"'));
    assert.ok(releaseYml.includes('gh release create "$RELEASE_TAG"'));
    assert.ok(releaseYml.includes('--prerelease="$IS_PRERELEASE"'));
    assert.ok(releaseYml.includes('--latest="$IS_LATEST"'));
    assert.ok(releaseYml.includes('verified_commit: ${{ steps.verify_commit.outputs.sha }}'));
    assert.ok(releaseYml.includes('VERIFIED_COMMIT: ${{ needs.gate.outputs.verified_commit }}'));
    assert.ok(releaseYml.includes('"$REMOTE_TAG_COMMIT" != "$VERIFIED_COMMIT"'));
    assert.ok(releaseYml.includes('group: release-publish-latest'));
    assert.ok(releaseYml.includes('persist-credentials: false'));
    const externalUses = [...releaseYml.matchAll(/uses:\s+([^\s#]+)/g)]
      .map((m) => m[1] ?? '')
      .filter((ref) => !ref.startsWith('./'));
    assert.ok(externalUses.length >= 5, 'release.yml must pin every external action across gate and publish-release');
    for (const ref of externalUses) {
      assert.match(ref, /@[0-9a-f]{40}$/, `release.yml must pin every external action by 40-char commit SHA: ${ref}`);
    }
    assert.equal(releaseYml.includes('@v4'), false, 'release.yml must not reference legacy Node 20 @v4 actions');

    const fallbackYml = readFileSync(path.join(REPO_ROOT, '.github', 'release.yml'), 'utf8');
    assert.ok(fallbackYml.includes('changelog:'));
    assert.ok(fallbackYml.includes('Breaking Changes'));
    assert.ok(fallbackYml.includes("'*'"));
  });

  void it('executes scripts/release.mts notes in an isolated directory with zero node_modules (CI parity)', () => {
    const visited = new Set<string>();
    const bareSpecifiers: string[] = [];
    const queue = [path.join(REPO_ROOT, 'scripts', 'release.mts')];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const src = readFileSync(cur, 'utf8');
      const parsed = parseSync(cur, src);
      for (const imp of parsed.module.staticImports) {
        const spec = imp.moduleRequest.value;
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) {
          queue.push(path.resolve(path.dirname(cur), spec));
        } else {
          bareSpecifiers.push(`${path.relative(REPO_ROOT, cur)} -> ${spec}`);
        }
      }
      for (const exp of parsed.module.staticExports) {
        for (const entry of exp.entries) {
          const spec = entry.moduleRequest?.value;
          if (!spec || spec.startsWith('node:')) continue;
          if (spec.startsWith('.')) {
            queue.push(path.resolve(path.dirname(cur), spec));
          } else {
            bareSpecifiers.push(`${path.relative(REPO_ROOT, cur)} -> ${spec}`);
          }
        }
      }
    }
    assert.deepEqual(
      bareSpecifiers,
      [],
      `scripts/release.mts must not depend on external packages: ${bareSpecifiers.join(', ')}`,
    );

    const cleanRoot = tracker.makeTempDir('agy-hud-clean-release-ci-');
    for (const absFile of visited) {
      const rel = path.relative(REPO_ROOT, absFile);
      const dest = path.join(cleanRoot, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(absFile, dest);
    }
    for (const rootFile of ['package.json', 'plugin.json', 'CHANGELOG.md']) {
      cpSync(path.join(REPO_ROOT, rootFile), path.join(cleanRoot, rootFile));
    }

    const res = spawnSync(
      process.execPath,
      [path.join(cleanRoot, 'scripts', 'release.mts'), 'notes', 'v0.1.0', '--with-install-header', '--prev-tag', ''],
      { cwd: cleanRoot, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } },
    );
    assert.equal(res.status, 0, `clean no-node_modules execution failed: ${res.stderr}`);
    assert.ok(res.stdout.includes('agy plugin install https://github.com/ifelseboyxx/agy-hud/tree/v0.1.0'));
  });
});
