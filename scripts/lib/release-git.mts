import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { writeBufferAtomicSync } from '../../src/core/fs-utils.ts';
import { resolvePnpmSpawnSpec } from './pnpm-spawn.mts';
import type { RawGitCommit } from './release-changelog.mts';
import { isStrictSemverTag, replaceTopLevelJsonVersion } from './release-version.mts';

const GIT_LOG_RECORD_SEP = '\x1e';
const GIT_LOG_FIELD_SEP = '\x1f';

interface GitCmdResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGitCommand(rootDir: string, args: readonly string[]): GitCmdResult {
  const res = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8', windowsHide: true });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.error ? res.error.message : (res.stderr ?? ''),
  };
}

export function runGitOrThrow(rootDir: string, args: readonly string[]): string {
  const res = runGitCommand(rootDir, args);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim() || `exit ${res.status}`}`);
  }
  return res.stdout.trim();
}

export function runPnpmCommand(rootDir: string, args: readonly string[]): void {
  const spec = resolvePnpmSpawnSpec(args, process.platform, process.env, process.execPath, false);
  const res = spawnSync(spec.command, spec.args, { cwd: rootDir, stdio: 'inherit', windowsHide: true });
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : `exit ${String(res.status)}`;
    throw new Error(`pnpm ${args.join(' ')} failed: ${detail}`);
  }
}

export function readPackageAndPluginVersions(rootDir: string): { pkgVersion: string; pluginVersion: string } {
  const pkgPath = path.join(rootDir, 'package.json');
  const pluginPath = path.join(rootDir, 'plugin.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || typeof plugin.version !== 'string') {
    throw new Error('package.json and plugin.json must both declare a string version.');
  }
  if (pkg.version !== plugin.version) {
    throw new Error(`Version mismatch: package.json=${pkg.version} vs plugin.json=${plugin.version}`);
  }
  return { pkgVersion: pkg.version, pluginVersion: plugin.version };
}

export function updateJsonVersionPreservingFormat(filePath: string, nextVersion: string): void {
  const raw = readFileSync(filePath, 'utf8');
  const updated = replaceTopLevelJsonVersion(raw, nextVersion);
  writeBufferAtomicSync(filePath, Buffer.from(updated, 'utf8'));
}

export function listLocalSemverTags(rootDir: string): string[] {
  const res = runGitCommand(rootDir, ['tag', '-l', 'v*']);
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((tag) => isStrictSemverTag(tag));
}

export function listRemoteSemverTags(rootDir: string): string[] | null {
  const res = runGitCommand(rootDir, ['ls-remote', '--tags', '--refs', 'origin', 'v*']);
  if (res.status !== 0) return null;
  const tags: string[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const ref = line.trim().split(/\s+/)[1] ?? '';
    if (!ref.startsWith('refs/tags/')) continue;
    const tag = ref.slice('refs/tags/'.length);
    if (isStrictSemverTag(tag)) tags.push(tag);
  }
  return tags;
}

export function rollbackBranchIfCreated(rootDir: string, curBranch: string, releaseBranch: string): string[] {
  const errors: string[] = [];
  const checkoutBack = runGitCommand(rootDir, ['checkout', curBranch]);
  if (checkoutBack.status !== 0) {
    errors.push(`checkout ${curBranch}: ${checkoutBack.stderr.trim() || `exit ${checkoutBack.status}`}`);
  } else {
    const delRes = runGitCommand(rootDir, ['branch', '-D', releaseBranch]);
    if (delRes.status !== 0) {
      errors.push(`delete branch ${releaseBranch}: ${delRes.stderr.trim() || `exit ${delRes.status}`}`);
    }
  }
  return errors;
}

export function collectGitCommitsSince(rootDir: string, prevTag: string | null): RawGitCommit[] {
  const range = prevTag !== null ? `${prevTag}..HEAD` : 'HEAD';
  const format = `%H${GIT_LOG_FIELD_SEP}%s${GIT_LOG_FIELD_SEP}%b${GIT_LOG_RECORD_SEP}`;
  const res = runGitCommand(rootDir, ['log', '--no-merges', `--format=${format}`, range]);
  if (res.status !== 0 || res.stdout.trim().length === 0) return [];
  const commits: RawGitCommit[] = [];
  for (const record of res.stdout.split(GIT_LOG_RECORD_SEP)) {
    const trimmed = record.trim();
    if (trimmed.length === 0) continue;
    const [hash = '', subject = '', body = ''] = trimmed.split(GIT_LOG_FIELD_SEP);
    if (hash.trim().length > 0 && subject.trim().length > 0) {
      commits.push({ hash: hash.trim(), subject: subject.trim(), body: body.trim() });
    }
  }
  return commits;
}

export function assertCleanWorkingTree(rootDir: string): void {
  const status = runGitOrThrow(rootDir, ['status', '--porcelain']);
  if (status.length > 0) {
    throw new Error('Working tree is not clean. Commit or stash pending changes before running release commands.');
  }
}
