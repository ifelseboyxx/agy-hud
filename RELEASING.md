# Releasing `agy-hud`

This runbook documents the standardized release process, GitHub Repository Rulesets configuration, and recovery policy for `agy-hud`.

## Release Invariants

- **Single-segment SemVer tags only**: `vX.Y.Z` or `vX.Y.Z-rc.N` / `vX.Y.Z-beta.N` (no `/` or `+` build metadata), compatible with `agy plugin install https://github.com/ifelseboyxx/agy-hud/tree/vX.Y.Z`.
- **Single source of truth**: Root `CHANGELOG.md` drives GitHub Release Notes via `pnpm release notes`. Both `CHANGELOG.md` and release notes must contain zero pictographic emoji.
- **Zero-build 5-file `dist/`**: Tracked `dist/` must match `src/` byte-for-byte with strictly 5 standalone files (`cli.mjs`, `hud.mjs`, `index.mjs`, `index.d.mts`, `types.d.mts`) and Git index mode `100755` on `dist/cli.mjs`, `dist/hud.mjs`, and `scripts/install.mjs`.
- **No automatic commits or pushes**: `pnpm release prepare` and `pnpm release tag` never run `git commit` or `git push`.
- **Immutable public tags**: Never delete or force-repoint a published tag. Always fix forward with a new patch version (for example, `v0.1.1`).

## Standard Stable Release Flow

### Phase 1: Prepare the Release PR

1. Ensure local `main` is clean and synced with `origin/main`:
   ```bash
   git checkout main && git pull --ff-only origin main
   ```
2. Preview changes without modifying disk or branches:
   ```bash
   pnpm release prepare patch --dry-run   # or minor | major | current | X.Y.Z
   ```
3. Run preparation (creates `release/vX.Y.Z`, bumps `package.json` and `plugin.json`, updates `CHANGELOG.md`, and runs `pnpm build && pnpm dist:check` with atomic rollback on error):
   ```bash
   pnpm release prepare patch
   ```
4. **Human polish pause**:
   - Review `CHANGELOG.md`, add or refine `### Highlights`, and replace any `<!-- TODO: summarize user-visible changes -->` placeholder.
   - Audit pinned `/tree/vX.Y.Z` examples in `README.md` / `README.zh-CN.md` and refresh `assets/preview.png` via `pnpm preview:screenshot` if HUD visuals changed.
   - Run `pnpm release notes vX.Y.Z` to verify strict extraction passes.
5. Commit, push the release branch, and open a PR into `main`:
   ```bash
   git add -A
   git commit -m "release(root): vX.Y.Z"
   git push -u origin release/vX.Y.Z
   ```
6. Wait for all 5 required CI checks on `.github/workflows/ci.yml` to pass, then merge the PR into `main`.

#### Release PR Rework (if CI catches an issue before merge)

Push fix commits to `release/vX.Y.Z`, then refresh automated changelog entries and `dist/` while preserving hand-edited `### Highlights`:

```bash
pnpm release prepare current --no-branch --regenerate-changelog
```

### Phase 2: Tag Merged `main` and Publish

1. Switch back to `main` and pull the merged release commit:
   ```bash
   git checkout main && git pull --ff-only origin main
   ```
2. Run all local release gates and create the annotated tag `vX.Y.Z` (`--dry-run` checks gates without tagging):
   ```bash
   pnpm release tag --dry-run
   pnpm release tag
   ```
3. Manually push the annotated tag to trigger `.github/workflows/release.yml`:
   ```bash
   git push origin vX.Y.Z
   ```
4. Monitor the `Release` workflow (`gate` -> `publish-release`) and verify the published GitHub Release body and install commands.

## Prerelease Flow (`rc` / `beta`)

```bash
pnpm release prepare prerelease --preid rc   # e.g. 0.2.0-rc.1 -> 0.2.0-rc.2
# Commit on release/v0.2.0-rc.1 (or main), wait for CI, then:
pnpm release tag
git push origin v0.2.0-rc.1
```

- Prereleases are published with `--prerelease=true --latest=false` and diff from the immediately preceding tag.
- When cutting the final stable `v0.2.0`, `pnpm release prepare minor` (or `patch` from `0.2.0-rc.N`) rolls all commits since the previous stable tag into `## [v0.2.0]` and removes superseded `v0.2.0-*` sections from `CHANGELOG.md`.

## Recovery and User Rollback

- **Interrupted `pnpm release prepare` (for example `Ctrl-C` / `SIGKILL` mid-build)**: Reset the partially prepared branch cleanly before retrying:
  ```bash
  git checkout main && git branch -D release/vX.Y.Z && git restore package.json plugin.json CHANGELOG.md dist/
  ```
- **Workflow rerun after transient failure**: Re-run the failed `Release` workflow job in GitHub Actions. `publish-release` checks `GET /repos/{owner}/{repo}/releases/tags/{tag}` (`200` -> `gh release edit`, `404` -> `gh release create --verify-tag`) idempotently without duplicating notes.
- **Bug discovered after publishing `vX.Y.Z`**: Do not delete or move `vX.Y.Z`. Cut a forward patch release (`vX.Y.(Z+1)`).
- **User rollback**: Users can immediately pin a prior release tag:
  ```bash
  agy plugin install https://github.com/ifelseboyxx/agy-hud/tree/v0.1.0
  ```

## GitHub Repository Rulesets Checklist (Public GitHub Free)

Configure under **Repository Settings -> Rules -> Rulesets** (run `.github/workflows/ci.yml` at least once within the last 7 days so all check names appear in the picker):

### 1. `main` Branch Ruleset

- **Target**: Default branch (`main`)
- **Rules**:
  - `Restrict deletions`
  - `Block force pushes`
  - `Require a pull request before merging` (`0` required approvals for a solo maintainer; raise to `>= 1` with collaborators)
  - `Require status checks to pass before merging`, pinned to expected source **GitHub Actions**, with these **5 exact status check names**:
    1. `Verify (ubuntu-latest, Node 22)`
    2. `Verify (ubuntu-latest, Node 24)`
    3. `Verify (macos-latest, Node 22)`
    4. `Verify (windows-latest, Node 22)`
    5. `Official agy plugin validate (ubuntu-latest)`
- **Bypass list**: Empty (strictest) or `Repository admin` with **For pull requests only** mode.

### 2. `v*` Tag Protection (Two-Ruleset Split)

Split creation and immutability into two rulesets so admin creation bypass never permits mutating published tags:

1. **Tag Ruleset 1 — Release Tag Immutability**:
   - Target pattern: `v*` (omit `refs/tags/`)
   - Rules: `Restrict updates`, `Restrict deletions`, `Block force pushes`
   - Bypass list: **Empty**
2. **Tag Ruleset 2 — Release Tag Creation Gate**:
   - Target pattern: `v*`
   - Rules: `Restrict creations`
   - Bypass list: `Repository admin` (and `Maintain` if collaborators exist)

### 3. GitHub Immutable Releases (Defense-in-Depth)

Enable **Repository Settings -> General -> Releases -> Enable release immutability** so published release tags and assets are cryptographically locked while release notes, `--prerelease`, and `--latest` remain editable on idempotent CI reruns.
