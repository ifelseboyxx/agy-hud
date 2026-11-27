import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractReleaseNotes,
  parseConventionalCommit,
  TODO_CHANGELOG_PLACEHOLDER,
  updateChangelogContent,
} from '../scripts/lib/release-changelog.mts';
import {
  compareSemver,
  findPreviousReleaseTag,
  isHighestStableTag,
  isStrictSemverTag,
  parseSemver,
  replaceTopLevelJsonVersion,
  resolveNextVersion,
} from '../scripts/lib/release-version.mts';

void describe('release SemVer parsing, bumping, and tag ordering', () => {
  void it('validates single-segment SemVer tags and rejects slashes, build metadata, and leading zeros', () => {
    assert.equal(isStrictSemverTag('v0.1.0'), true);
    assert.equal(isStrictSemverTag('v1.2.3-rc.1'), true);
    assert.equal(isStrictSemverTag('v0.2.0-beta.10'), true);

    assert.equal(isStrictSemverTag('0.1.0'), false);
    assert.equal(isStrictSemverTag('v01.0.0'), false);
    assert.equal(isStrictSemverTag('v0.1.0+build.1'), false);
    assert.equal(isStrictSemverTag('releases/v0.1.0'), false);
    assert.equal(isStrictSemverTag('v0.1.0/extra'), false);
  });

  void it('resolves patch, minor, major, prerelease, current, and explicit versions deterministically', () => {
    assert.equal(resolveNextVersion('0.1.0', 'current'), '0.1.0');
    assert.equal(resolveNextVersion('0.1.0', 'patch'), '0.1.1');
    assert.equal(resolveNextVersion('0.1.0', 'minor'), '0.2.0');
    assert.equal(resolveNextVersion('0.1.0', 'major'), '1.0.0');
    assert.equal(resolveNextVersion('0.1.0', 'prerelease', 'rc'), '0.1.1-rc.1');
    assert.equal(resolveNextVersion('0.2.0-rc.1', 'prerelease'), '0.2.0-rc.2');
    assert.equal(resolveNextVersion('0.2.0-rc.2', 'prerelease', 'beta'), '0.2.0-beta.1');
    assert.equal(resolveNextVersion('0.2.0-rc.2', 'patch'), '0.2.0');
    assert.equal(resolveNextVersion('0.1.0', 'v0.3.0-rc.1'), '0.3.0-rc.1');
    assert.equal(resolveNextVersion('0.2.0-rc.9007199254740992', 'prerelease'), '0.2.0-rc.9007199254740993');
    assert.throws(() => resolveNextVersion('0.1.0', 'v0.2.0/bad'), /Invalid release target/);
  });

  void it('orders prerelease and stable versions per SemVer 2.0.0 and detects maintenance patches', () => {
    const a = parseSemver('0.2.0-rc.2')!;
    const b = parseSemver('0.2.0-rc.10')!;
    const stable = parseSemver('0.2.0')!;
    assert.ok(compareSemver(a, b) < 0);
    assert.ok(compareSemver(b, stable) < 0);
    assert.ok(compareSemver(parseSemver('0.2.0-rc.9007199254740992')!, parseSemver('0.2.0-rc.9007199254740993')!) < 0);

    const tags = ['v0.1.0', 'v0.1.1', 'v0.2.0-rc.1', 'v0.2.0-rc.2', 'v0.2.0'];
    assert.equal(findPreviousReleaseTag('v0.2.0-rc.2', tags), 'v0.2.0-rc.1');
    assert.equal(findPreviousReleaseTag('v0.2.0', tags), 'v0.1.1');
    assert.equal(isHighestStableTag('v0.2.0', tags), true);
    assert.equal(isHighestStableTag('v0.1.2', tags), false);
    assert.equal(isHighestStableTag('v0.2.0-rc.2', tags), false);

    // Top-level JSON version replacer must ignore nested "version" keys and preserve formatting
    const nestedJson = '{\n  "metadata": { "version": "9.9.9" },\n  "version": "0.1.0"\n}\n';
    const updatedJson = replaceTopLevelJsonVersion(nestedJson, '0.1.1');
    assert.equal(updatedJson, '{\n  "metadata": { "version": "9.9.9" },\n  "version": "0.1.1"\n}\n');
  });
});

void describe('CHANGELOG.md generation and strict Release Notes extraction', () => {
  void it('maps Conventional Commits, excludes internal types/merges, links PRs, and extracts strict notes', () => {
    const feat = parseConventionalCommit({
      hash: 'abcdef123456',
      subject: 'feat(hud): add prism tiers (#42)',
      body: '',
    });
    assert.equal(feat?.category, 'Added');
    assert.ok(feat?.bullet.includes('**hud**: add prism tiers ([#42]'));
    assert.ok(feat?.bullet.includes('[abcdef1]'));

    const rootFix = parseConventionalCommit({
      hash: '1234567890ab',
      subject: 'fix(root): tighten lock check',
      body: '',
    });
    assert.equal(rootFix?.category, 'Fixed');
    assert.equal(rootFix?.bullet.includes('**root**'), false);

    const breaking = parseConventionalCommit({
      hash: '999999999999',
      subject: 'chore(cli)!: drop legacy flag',
      body: 'BREAKING CHANGE: removed --legacy',
    });
    assert.equal(breaking?.category, 'Breaking Changes');
    assert.ok(breaking?.bullet.includes('removed --legacy'));

    assert.equal(parseConventionalCommit({ hash: 'aaaaaaa', subject: 'chore(root): bump config', body: '' }), null);
    assert.equal(
      parseConventionalCommit({ hash: 'bbbbbbb', subject: 'Merge pull request #9 from foo', body: '' }),
      null,
    );

    // Initial v0.1.0 scaffold + incremental v0.1.1 with prerelease rollup
    const initial = updateChangelogContent(null, { tag: 'v0.1.0', dateIso: '2026-11-27', commits: [], prevTag: null });
    const v010Notes = extractReleaseNotes(initial, 'v0.1.0', null, { withInstallHeader: true });
    assert.ok(v010Notes.includes('agy plugin install https://github.com/ifelseboyxx/agy-hud/tree/v0.1.0'));
    assert.equal(v010Notes.includes('**Full Changelog**'), false);

    const withRc = updateChangelogContent(initial, {
      tag: 'v0.2.0-rc.1',
      dateIso: '2026-12-01',
      commits: [{ hash: '1111111aaaa', subject: 'feat(hud): preview rc', body: '' }],
      prevTag: 'v0.1.0',
    });
    assert.ok(withRc.includes('## [v0.2.0-rc.1] - 2026-12-01'));

    const stable = updateChangelogContent(withRc, {
      tag: 'v0.2.0',
      dateIso: '2026-12-05',
      commits: [{ hash: '2222222bbbb', subject: 'feat(hud): final release', body: '' }],
      prevTag: 'v0.1.0',
    });
    assert.equal(
      stable.includes('## [v0.2.0-rc.1]'),
      false,
      'stable release must roll up and drop superseded rc sections',
    );
    const v020Notes = extractReleaseNotes(stable, 'v0.2.0', 'v0.1.0');
    assert.ok(v020Notes.includes('**Full Changelog**: https://github.com/ifelseboyxx/agy-hud/compare/v0.1.0...v0.2.0'));
  });

  void it('preserves Highlights on --regenerate-changelog and fails closed on TODO, duplicate, empty, or emoji notes', () => {
    const initial = updateChangelogContent(null, { tag: 'v0.1.0', dateIso: '2026-11-27', commits: [], prevTag: null });
    const edited = initial.replace(
      '### Highlights\n\n- Initial public release',
      '### Highlights\n\n- Handcrafted highlight',
    );
    assert.throws(
      () => updateChangelogContent(edited, { tag: 'v0.1.0', dateIso: '2026-11-27', commits: [], prevTag: null }),
      /already contains section/,
    );
    const regen = updateChangelogContent(edited, {
      tag: 'v0.1.0',
      dateIso: '2026-11-27',
      commits: [],
      prevTag: null,
      regenerate: true,
    });
    assert.ok(regen.includes('- Handcrafted highlight'));

    // Zero-match commits produce blocking TODO placeholder
    const todoDoc = updateChangelogContent(initial, {
      tag: 'v0.1.1',
      dateIso: '2026-11-28',
      commits: [{ hash: '3333333', subject: 'chore(docs): internal tweak', body: '' }],
      prevTag: 'v0.1.0',
    });
    assert.ok(todoDoc.includes(TODO_CHANGELOG_PLACEHOLDER));
    assert.throws(() => extractReleaseNotes(todoDoc, 'v0.1.1', 'v0.1.0'), /TODO/);

    // Duplicate heading and emoji must fail closed
    const dupDoc = `${initial}\n## [v0.1.0] - 2026-11-27\n\n### Added\n\n- dup\n`;
    assert.throws(() => extractReleaseNotes(dupDoc, 'v0.1.0', null), /duplicate sections/);

    const rocket = String.fromCodePoint(0x1f680);
    const emojiDoc = `## [v0.1.0] - 2026-11-27\n\n### Added\n\n- launch ${rocket}\n`;
    assert.throws(() => extractReleaseNotes(emojiDoc, 'v0.1.0', null), /forbidden pictographic emoji/);

    // Duplicate ## [Unreleased] headings and unrecognized ## headings must fail closed rather than silently dropping content
    const dupUnreleased = '# Changelog\n\n## [Unreleased]\n\n- first\n\n## [Unreleased]\n\n- second\n';
    assert.throws(
      () => updateChangelogContent(dupUnreleased, { tag: 'v0.1.0', dateIso: '2026-11-27', commits: [], prevTag: null }),
      /duplicate ## \[Unreleased\]/,
    );
    const customHeading = `${initial}\n## Custom Notes\n\nKeep this prose.\n`;
    assert.throws(
      () =>
        updateChangelogContent(customHeading, { tag: 'v0.1.1', dateIso: '2026-11-28', commits: [], prevTag: 'v0.1.0' }),
      /Unsupported level-2 heading/,
    );
    const extracted = extractReleaseNotes(customHeading, 'v0.1.0', null);
    assert.equal(extracted.includes('Keep this prose'), false);
  });

  void it('sanitizes control characters from commits, generates real notes for initial RC, and computes SemVer compare links for maintenance patches', () => {
    // Control sequences in commit scope, subject, and breaking footer must be stripped while keeping links intact
    const dirtyCommit = parseConventionalCommit({
      hash: 'deadbeef1234',
      subject: 'feat(hud\x1b[31m)!: add safe\x07 preview (#88)',
      body: 'BREAKING CHANGE: drop \x1b]52;c;evil\x07old flag',
    });
    assert.ok(dirtyCommit !== null);
    assert.equal(dirtyCommit.category, 'Breaking Changes');
    assert.equal(dirtyCommit.bullet.includes('\x1b'), false);
    assert.equal(dirtyCommit.bullet.includes('\x07'), false);
    assert.ok(
      dirtyCommit.bullet.includes(
        '**hud**: add safe preview ([#88](https://github.com/ifelseboyxx/agy-hud/pull/88)) (drop old flag)',
      ),
      dirtyCommit.bullet,
    );
    assert.ok(dirtyCommit.bullet.includes('[deadbee]'));

    // First-ever prerelease (v0.1.0-rc.1) must generate commit bullets rather than stable initial scaffold
    const firstRc = updateChangelogContent(null, {
      tag: 'v0.1.0-rc.1',
      dateIso: '2026-11-27',
      commits: [{ hash: 'abc1234def56', subject: 'feat(hud): first rc feature', body: '' }],
      prevTag: null,
    });
    assert.ok(firstRc.includes('## [v0.1.0-rc.1] - 2026-11-27'));
    assert.ok(firstRc.includes('**hud**: first rc feature'));
    assert.equal(firstRc.includes('Initial public release of `agy-hud`'), false);

    // Maintenance patch v2.0.1 with existing v2.1.0 and v2.0.0 must compare v2.0.0...v2.0.1 and keep [Unreleased] on v2.1.0
    const v200 = updateChangelogContent(null, {
      tag: 'v2.0.0',
      dateIso: '2026-10-01',
      commits: [],
      prevTag: null,
    });
    const v210 = updateChangelogContent(v200, {
      tag: 'v2.1.0',
      dateIso: '2026-11-01',
      commits: [{ hash: '2100000aaaa', subject: 'feat(cli): minor bump', body: '' }],
      prevTag: 'v2.0.0',
    });
    const withMaint = updateChangelogContent(v210, {
      tag: 'v2.0.1',
      dateIso: '2026-11-15',
      commits: [{ hash: '2010000bbbb', subject: 'fix(cli): backport hotfix', body: '' }],
      prevTag: 'v2.0.0',
    });
    assert.ok(withMaint.includes('[Unreleased]: https://github.com/ifelseboyxx/agy-hud/compare/v2.1.0...HEAD'));
    assert.ok(withMaint.includes('[v2.0.1]: https://github.com/ifelseboyxx/agy-hud/compare/v2.0.0...v2.0.1'));
    assert.equal(withMaint.includes('v2.1.0...v2.0.1'), false);
    const maintNotes = extractReleaseNotes(withMaint, 'v2.0.1', 'v2.0.0');
    assert.ok(
      maintNotes.includes('**Full Changelog**: https://github.com/ifelseboyxx/agy-hud/compare/v2.0.0...v2.0.1'),
    );
  });

  void it('preserves historical compare links and Unreleased notes on maintenance patches and rolls initial RC into initial stable', () => {
    const v200 = updateChangelogContent(null, { tag: 'v2.0.0', dateIso: '2026-10-01', commits: [], prevTag: null });
    const v210 = updateChangelogContent(v200, {
      tag: 'v2.1.0',
      dateIso: '2026-11-01',
      commits: [{ hash: '2100000aaaa', subject: 'feat(cli): minor bump', body: '' }],
      prevTag: 'v2.0.0',
    }).replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n- Upcoming main feature\n');

    const withMaint = updateChangelogContent(v210, {
      tag: 'v2.0.1',
      dateIso: '2026-11-15',
      commits: [{ hash: '2010000bbbb', subject: 'fix(cli): backport hotfix', body: '' }],
      prevTag: 'v2.0.0',
    });
    assert.ok(withMaint.includes('- Upcoming main feature'), 'maintenance patch must keep Unreleased notes');
    assert.ok(withMaint.includes('[v2.1.0]: https://github.com/ifelseboyxx/agy-hud/compare/v2.0.0...v2.1.0'));
    assert.equal(withMaint.includes('[v2.1.0]: https://github.com/ifelseboyxx/agy-hud/compare/v2.0.1...v2.1.0'), false);
    const maintSection = extractReleaseNotes(withMaint, 'v2.0.1', 'v2.0.0');
    assert.equal(maintSection.includes('Upcoming main feature'), false);

    // Promoting initial v0.1.0-rc.1 -> v0.1.0 with prevTag null drops RC and triggers initial stable scaffold
    const firstRc = updateChangelogContent(null, {
      tag: 'v0.1.0-rc.1',
      dateIso: '2026-11-27',
      commits: [{ hash: 'abc1234def56', subject: 'feat(hud): first rc feature', body: '' }],
      prevTag: null,
    });
    const firstStable = updateChangelogContent(firstRc, {
      tag: 'v0.1.0',
      dateIso: '2026-11-28',
      commits: [],
      prevTag: null,
    });
    assert.equal(firstStable.includes('## [v0.1.0-rc.1]'), false);
    assert.ok(firstStable.includes('Initial public release of `agy-hud`'));
  });
});
