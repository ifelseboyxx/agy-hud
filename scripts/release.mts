import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureEntrySnapshotSync,
  type EntrySnapshotSync,
  isMainEntry,
  lstatIfPresentSync,
  writeBufferAtomicSync,
} from '../src/core/fs-utils.ts';
import { extractReleaseNotes, updateChangelogContent } from './lib/release-changelog.mts';
import {
  assertSafeRepoDistDir,
  assertSafeRepoWriteTarget,
  captureDistSnapshots,
  rollbackCapturedFilesAndDist,
} from './lib/release-fs.mts';
import {
  assertCleanWorkingTree,
  collectGitCommitsSince,
  listLocalSemverTags,
  listRemoteSemverTags,
  readPackageAndPluginVersions,
  rollbackBranchIfCreated,
  runGitOrThrow,
  runPnpmCommand,
  updateJsonVersionPreservingFormat,
} from './lib/release-git.mts';
import {
  findPreviousReleaseTag,
  formatVersionTag,
  isPrereleaseVersion,
  type ReleasePreid,
  resolveNextVersion,
} from './lib/release-version.mts';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface ReleaseCliOptions {
  readonly rootDir?: string;
  readonly todayIso?: string;
  readonly skipBuildAndDistCheck?: boolean;
  readonly skipVerifyInTag?: boolean;
  readonly pnpmRunner?: (rootDir: string, args: readonly string[]) => void;
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
}

function currentUtcDateIso(override?: string): string {
  return override ?? new Date().toISOString().slice(0, 10);
}

function printReleaseHelp(out: { write(chunk: string): boolean }): void {
  out.write(
    `Usage: pnpm release <command> [options]

Commands:
  prepare <target>   Prepare version bump, CHANGELOG.md, and dist/ on release/vX.Y.Z
                     <target>: patch | minor | major | prerelease | current | X.Y.Z[-pre.N]
                     Flags: --preid rc|beta, --dry-run, --no-branch, --regenerate-changelog
  tag                Run release gates on synced main and create local annotated tag vX.Y.Z
                     Flags: --dry-run, --skip-remote-check
  notes [vX.Y.Z]     Extract validated GitHub Release Notes from CHANGELOG.md
                     Flags: --out <file>, --prev-tag <tag>, --with-install-header
`,
  );
}

function executePrepare(args: readonly string[], opts: ReleaseCliOptions): number {
  const rootDir = opts.rootDir ?? DEFAULT_REPO_ROOT;
  const out = opts.stdout ?? process.stdout;
  let target = '';
  let preid: ReleasePreid | undefined;
  let dryRun = false;
  let noBranch = false;
  let regenerate = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-branch') {
      noBranch = true;
    } else if (arg === '--regenerate-changelog') {
      regenerate = true;
    } else if (arg === '--preid') {
      const val = args[i + 1];
      if (val !== 'rc' && val !== 'beta') {
        throw new Error(`Invalid --preid value '${String(val)}'. Expected 'rc' or 'beta'.`);
      }
      preid = val;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown prepare option: ${arg}`);
    } else if (target.length === 0) {
      target = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }
  if (target.length === 0) {
    throw new Error('Missing <target>. Expected patch, minor, major, prerelease, current, or X.Y.Z[-pre.N].');
  }

  assertCleanWorkingTree(rootDir);
  const { pkgVersion } = readPackageAndPluginVersions(rootDir);
  const nextVersion = resolveNextVersion(pkgVersion, target, preid);
  const nextTag = formatVersionTag(nextVersion);
  const isPrerelease = isPrereleaseVersion(nextVersion);
  const curBranch = runGitOrThrow(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  if (!isPrerelease && curBranch !== 'main' && !(noBranch && curBranch.startsWith('release/v'))) {
    throw new Error(
      `Stable release preparation must start from 'main' (currently on '${curBranch}'). Switch to main, or pass --no-branch on an existing release/v* branch.`,
    );
  }

  const localTags = listLocalSemverTags(rootDir);
  if (localTags.includes(nextTag)) {
    throw new Error(`Tag '${nextTag}' already exists locally.`);
  }
  const remoteTags = listRemoteSemverTags(rootDir);
  if (remoteTags === null) {
    out.write(`[WARN] Could not reach origin to check remote tags for '${nextTag}'; continuing offline.\n`);
  } else {
    if (remoteTags.includes(nextTag)) {
      throw new Error(`Tag '${nextTag}' already exists on origin.`);
    }
    const remotePrev = findPreviousReleaseTag(nextTag, remoteTags);
    if (remotePrev !== null && !localTags.includes(remotePrev)) {
      throw new Error(
        `Remote origin has preceding release tag '${remotePrev}' missing locally. Run 'git fetch --tags origin' before preparing '${nextTag}'.`,
      );
    }
  }

  const prevTag = findPreviousReleaseTag(nextTag, localTags);
  const commits = collectGitCommitsSince(rootDir, prevTag);
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  const hadChangelog = existsSync(changelogPath);
  const origChangelog = hadChangelog ? readFileSync(changelogPath, 'utf8') : null;
  const nextChangelog = updateChangelogContent(origChangelog, {
    tag: nextTag,
    dateIso: currentUtcDateIso(opts.todayIso),
    commits,
    prevTag,
    regenerate,
  });

  if (dryRun) {
    out.write(
      [
        `[DRY RUN] Release prepare preview for ${nextTag} (current: ${pkgVersion}, prevTag: ${prevTag ?? 'none'})`,
        `Branch: ${noBranch ? curBranch : `release/${nextTag}`}`,
        'Files to update: package.json, plugin.json, CHANGELOG.md, dist/*',
        '',
        '--- CHANGELOG.md preview ---',
        nextChangelog,
      ].join('\n'),
    );
    return 0;
  }

  const pkgPath = assertSafeRepoWriteTarget(rootDir, 'package.json');
  const pluginPath = assertSafeRepoWriteTarget(rootDir, 'plugin.json');
  const safeChangelogPath = assertSafeRepoWriteTarget(rootDir, 'CHANGELOG.md', { allowMissing: true });
  assertSafeRepoDistDir(rootDir);

  const fileSnapshots: EntrySnapshotSync[] = [
    captureEntrySnapshotSync(pkgPath),
    captureEntrySnapshotSync(pluginPath),
    captureEntrySnapshotSync(safeChangelogPath),
  ];
  const distState = captureDistSnapshots(rootDir);
  const pnpmExec = opts.pnpmRunner ?? runPnpmCommand;
  const releaseBranch = `release/${nextTag}`;
  let createdBranch = false;

  try {
    if (!noBranch && curBranch !== releaseBranch) {
      runGitOrThrow(rootDir, ['checkout', '-b', releaseBranch]);
      createdBranch = true;
    }
    updateJsonVersionPreservingFormat(pkgPath, nextVersion);
    updateJsonVersionPreservingFormat(pluginPath, nextVersion);
    writeBufferAtomicSync(safeChangelogPath, Buffer.from(nextChangelog, 'utf8'));

    if (opts.skipBuildAndDistCheck !== true) {
      pnpmExec(rootDir, ['run', 'build']);
      pnpmExec(rootDir, ['run', 'dist:check']);
    }
  } catch (err) {
    const rollbackErrors = [
      ...rollbackCapturedFilesAndDist(rootDir, fileSnapshots, distState),
      ...(createdBranch ? rollbackBranchIfCreated(rootDir, curBranch, releaseBranch) : []),
    ];
    if (rollbackErrors.length > 0) {
      const primaryMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`${primaryMsg} (rollback warnings: ${rollbackErrors.join('; ')})`);
    }
    throw err;
  }

  const reminders = [
    `[OK] Prepared release ${nextTag} on branch '${noBranch ? curBranch : releaseBranch}' (no git commit/push performed).`,
    '',
    'Next steps (human polish pause):',
    '  1. Review and polish ### Highlights in CHANGELOG.md (replace any <!-- TODO --> placeholders).',
    ...(!isPrerelease
      ? [
          `  2. Audit README.md / README.zh-CN.md pinned /tree/${nextTag} examples and refresh assets/preview.png if HUD visuals changed.`,
        ]
      : []),
    `  3. Commit changes: git add -A && git commit -m "release(root): ${nextTag}"`,
    `  4. Push branch and open PR to main, wait for all CI checks to pass, then merge.`,
    `  5. Checkout synced main and run: pnpm release tag`,
    '',
  ];
  out.write(reminders.join('\n'));
  return 0;
}

function executeTag(args: readonly string[], opts: ReleaseCliOptions): number {
  const rootDir = opts.rootDir ?? DEFAULT_REPO_ROOT;
  const out = opts.stdout ?? process.stdout;
  let dryRun = false;
  let skipRemoteCheck = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--skip-remote-check') {
      skipRemoteCheck = true;
    } else {
      throw new Error(`Unknown tag option: ${arg}`);
    }
  }

  assertCleanWorkingTree(rootDir);
  const { pkgVersion } = readPackageAndPluginVersions(rootDir);
  const tag = formatVersionTag(pkgVersion);
  const isPrerelease = isPrereleaseVersion(pkgVersion);
  const curBranch = runGitOrThrow(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  if (!isPrerelease) {
    if (curBranch !== 'main') {
      throw new Error(`Stable tags must be created on 'main' (currently on '${curBranch}').`);
    }
    if (!skipRemoteCheck) {
      runGitOrThrow(rootDir, ['fetch', '--no-tags', 'origin', 'main']);
      const headSha = runGitOrThrow(rootDir, ['rev-parse', 'HEAD']);
      const originSha = runGitOrThrow(rootDir, ['rev-parse', 'origin/main']);
      if (headSha !== originSha) {
        throw new Error(
          `Local main (${headSha.slice(0, 7)}) is not synced with origin/main (${originSha.slice(0, 7)}).`,
        );
      }
    }
  } else if (curBranch !== 'main' && !curBranch.startsWith('release/')) {
    throw new Error(`Prerelease tags must be created on 'main' or 'release/*' (currently on '${curBranch}').`);
  }

  const localTags = listLocalSemverTags(rootDir);
  if (localTags.includes(tag)) {
    throw new Error(`Tag '${tag}' already exists locally.`);
  }
  if (!skipRemoteCheck) {
    const remoteTags = listRemoteSemverTags(rootDir);
    if (remoteTags === null) {
      throw new Error(
        `Could not query remote tags on origin for '${tag}'. Check network/remote connectivity, or pass --skip-remote-check to proceed offline.`,
      );
    }
    if (remoteTags.includes(tag)) {
      throw new Error(`Tag '${tag}' already exists on origin.`);
    }
  }

  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    throw new Error('Missing root CHANGELOG.md.');
  }
  const prevTag = findPreviousReleaseTag(tag, localTags);
  extractReleaseNotes(readFileSync(changelogPath, 'utf8'), tag, prevTag);

  const pnpmExec = opts.pnpmRunner ?? runPnpmCommand;
  if (opts.skipVerifyInTag !== true) {
    pnpmExec(rootDir, ['run', 'dist:check', '--', '--git-clean']);
    pnpmExec(rootDir, ['run', 'verify', '--', '--skip-build']);
  }

  if (dryRun) {
    out.write(`[DRY RUN] All release tag gates passed for ${tag} (no tag created).\n`);
    return 0;
  }

  runGitOrThrow(rootDir, ['tag', '-a', tag, '-m', `Release ${tag}`]);
  out.write(
    [
      `[OK] Created local annotated tag ${tag} (not pushed).`,
      '',
      'Manual cutover command:',
      `  git push origin ${tag}`,
      '',
      'Then monitor the GitHub Release workflow and verify the published GitHub Release page.',
      '',
    ].join('\n'),
  );
  return 0;
}

function executeNotes(args: readonly string[], opts: ReleaseCliOptions): number {
  const rootDir = opts.rootDir ?? DEFAULT_REPO_ROOT;
  const out = opts.stdout ?? process.stdout;
  let explicitTag = '';
  let explicitPrevTag: string | null | undefined;
  let outFile = '';
  let withInstallHeader = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--out') {
      const val = args[i + 1];
      if (!val) throw new Error('Missing path after --out.');
      outFile = val;
      i += 1;
    } else if (arg === '--prev-tag') {
      const val = args[i + 1];
      explicitPrevTag = val && val.trim().length > 0 ? val.trim() : null;
      i += 1;
    } else if (arg === '--with-install-header') {
      withInstallHeader = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown notes option: ${arg}`);
    } else if (explicitTag.length === 0) {
      explicitTag = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  const tag =
    explicitTag.length > 0
      ? formatVersionTag(explicitTag)
      : formatVersionTag(readPackageAndPluginVersions(rootDir).pkgVersion);
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    throw new Error(`Missing CHANGELOG.md at ${changelogPath}`);
  }
  const prevTag =
    explicitPrevTag !== undefined ? explicitPrevTag : findPreviousReleaseTag(tag, listLocalSemverTags(rootDir));
  const notes = extractReleaseNotes(readFileSync(changelogPath, 'utf8'), tag, prevTag, { withInstallHeader });

  if (outFile.length > 0) {
    const resolvedOut = path.resolve(rootDir, outFile);
    const outSt = lstatIfPresentSync(resolvedOut);
    if (outSt !== null && (outSt.isSymbolicLink() || !outSt.isFile())) {
      throw new Error(`Refusing to write release notes to symbolic link or non-regular file: ${outFile}`);
    }
    writeBufferAtomicSync(resolvedOut, Buffer.from(notes, 'utf8'));
  } else {
    out.write(notes);
  }
  return 0;
}

export function runReleaseCli(argv: readonly string[], opts: ReleaseCliOptions = {}): number {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const [subcmd, ...rest] = argv;
  if (!subcmd || subcmd === '-h' || subcmd === '--help') {
    printReleaseHelp(out);
    return 0;
  }
  try {
    if (subcmd === 'prepare') return executePrepare(rest, opts);
    if (subcmd === 'tag') return executeTag(rest, opts);
    if (subcmd === 'notes') return executeNotes(rest, opts);
    throw new Error(`Unknown release subcommand '${subcmd}'. Run 'pnpm release --help'.`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err.write(`Error: ${msg}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = runReleaseCli(process.argv.slice(2));
}
