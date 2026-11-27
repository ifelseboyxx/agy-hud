import { sanitizeTerminalLabel } from '../../src/core/terminal-text.ts';
import {
  compareSemver,
  findPreviousReleaseTag,
  isPrereleaseVersion,
  isStrictSemverTag,
  parseSemver,
} from './release-version.mts';

export const REPO_HTTPS_URL: string = 'https://github.com/ifelseboyxx/agy-hud';
export const TODO_CHANGELOG_PLACEHOLDER: string = '<!-- TODO: summarize user-visible changes -->';

const EMOJI_CHECK_RE = /\p{Extended_Pictographic}/u;
const CONVENTIONAL_HEADER_RE = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:\s*(.+)$/m;
const MERGE_SUBJECT_RE = /^Merge (?:pull request|branch|remote-tracking branch)\b/i;
const TRAILING_PR_RE = /\(#(\d+)\)$/;
const VERSION_HEADING_RE = /^## \[(v[^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/;
const UNRELEASED_HEADING_RE = /^## \[Unreleased\]\s*$/;
const REF_LINK_RE = /^\[([^\]]+)\]:\s*(\S+)\s*$/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

export type ChangelogCategory = 'Breaking Changes' | 'Added' | 'Changed' | 'Fixed' | 'Performance';

const CATEGORY_ORDER: readonly ChangelogCategory[] = ['Breaking Changes', 'Added', 'Changed', 'Fixed', 'Performance'];

export interface RawGitCommit {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
}

export interface ParsedChangelogEntry {
  readonly category: ChangelogCategory;
  readonly bullet: string;
}

export interface GenerateVersionSectionOptions {
  readonly tag: string;
  readonly dateIso: string;
  readonly commits: readonly RawGitCommit[];
  readonly isInitialRelease: boolean;
  readonly existingHighlights?: string | null;
  readonly migratedUnreleasedBody?: string | null;
}

export interface UpdateChangelogOptions {
  readonly tag: string;
  readonly dateIso: string;
  readonly commits: readonly RawGitCommit[];
  readonly prevTag: string | null;
  readonly regenerate?: boolean;
}

function linkPullRequestSuffix(subject: string): string {
  return subject.replace(TRAILING_PR_RE, (_full, prNum: string) => `([#${prNum}](${REPO_HTTPS_URL}/pull/${prNum}))`);
}

export function parseConventionalCommit(commit: RawGitCommit): ParsedChangelogEntry | null {
  const subject = commit.subject.trim();
  if (subject.length === 0 || MERGE_SUBJECT_RE.test(subject)) {
    return null;
  }
  const match = CONVENTIONAL_HEADER_RE.exec(subject);
  if (!match?.[1] || !match[4]) {
    return null;
  }
  const type = match[1].toLowerCase();
  const rawScope = sanitizeTerminalLabel(match[2]?.trim() ?? '');
  const hasBang = match[3] === '!';
  const rawDesc = sanitizeTerminalLabel(match[4].trim());
  if (rawDesc.length === 0) {
    return null;
  }
  const breakingFooter = BREAKING_FOOTER_RE.exec(commit.body);
  const breakingDetail = breakingFooter?.[1] ? sanitizeTerminalLabel(breakingFooter[1].trim()) : '';
  const isBreaking = hasBang || breakingFooter !== null;

  let category: ChangelogCategory | null = null;
  if (isBreaking) {
    category = 'Breaking Changes';
  } else if (type === 'feat') {
    category = 'Added';
  } else if (type === 'fix' || type === 'revert') {
    category = 'Fixed';
  } else if (type === 'perf') {
    category = 'Performance';
  }

  if (category === null) {
    return null;
  }

  const shortHash = commit.hash.trim().slice(0, 7);
  const commitUrl = `${REPO_HTTPS_URL}/commit/${commit.hash.trim()}`;
  const scopePrefix = rawScope.length > 0 && rawScope !== 'root' ? `**${rawScope}**: ` : '';
  const linkedBase = linkPullRequestSuffix(rawDesc);
  const linkedDesc = isBreaking && breakingDetail.length > 0 ? `${linkedBase} (${breakingDetail})` : linkedBase;
  const hashSuffix = shortHash.length > 0 ? ` ([${shortHash}](${commitUrl}))` : '';
  return {
    category,
    bullet: `- ${scopePrefix}${linkedDesc}${hashSuffix}`,
  };
}

function extractHighlightsBlock(sectionBody: string): string | null {
  const lines = sectionBody.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => line.trim() === '### Highlights');
  if (startIdx < 0) {
    return null;
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^###\s+/.test(lines[i] ?? '')) {
      endIdx = i;
      break;
    }
  }
  const block = lines.slice(startIdx, endIdx).join('\n').trim();
  return block.length > 0 ? block : null;
}

export function generateVersionSectionBody(options: GenerateVersionSectionOptions): string {
  const blocks: string[] = [];
  const highlights = options.existingHighlights?.trim() ?? '';
  if (highlights.length > 0) {
    blocks.push(highlights);
  }

  const migrated = options.migratedUnreleasedBody?.trim() ?? '';
  if (options.isInitialRelease) {
    if (highlights.length === 0) {
      blocks.push(
        [
          '### Highlights',
          '',
          '- Initial public release of `agy-hud`: a zero-build, zero-runtime-dependency ANSI terminal HUD, clickable OSC 8 snapshot viewer, terminal popup inspector, and profile portability toolkit for Antigravity CLI.',
        ].join('\n'),
      );
    }
    if (migrated.length > 0) {
      blocks.push(migrated);
    } else {
      blocks.push(
        [
          '### Added',
          '',
          `- Live terminal status line (\`dist/hud.mjs\`) with 5 presets (\`full\`, \`compact\`, \`swarm\`, \`minimal\`, \`zen\`), narrow-pane overrides, 5-tier thinking effort styling, Context Budget & compaction estimates, Quota Pace forecasting, throughput/TTFT/cache anomaly telemetry, offline USD/CNY cost, and enhanced Git status.`,
          `- Out-of-band Activity Snapshot across OSC 8 Markdown, \`agy-hud\` CLI, and \`-p\` interactive popup with Context Breakdown, Turn Phase, Diagnostics, and bounded subagent telemetry rollups.`,
          `- Interactive \`configure -i\` TUI, offline \`preview\`, sanitized \`export-profile\` / \`import-profile\`, and ownership-gated installer (\`wire\`, \`unwire\`, \`doctor\`, \`--purge\`).`,
        ].join('\n'),
      );
    }
    return blocks.join('\n\n');
  }

  const buckets = new Map<ChangelogCategory, string[]>();
  for (const cat of CATEGORY_ORDER) {
    buckets.set(cat, []);
  }
  for (const commit of options.commits) {
    const entry = parseConventionalCommit(commit);
    if (entry === null) continue;
    buckets.get(entry.category)?.push(entry.bullet);
  }

  if (migrated.length > 0) {
    blocks.push(migrated);
  }

  let hasGeneratedBullets = false;
  for (const cat of CATEGORY_ORDER) {
    const items = buckets.get(cat) ?? [];
    if (items.length === 0) continue;
    hasGeneratedBullets = true;
    blocks.push(`### ${cat}\n\n${items.join('\n')}`);
  }

  if (!hasGeneratedBullets && migrated.length === 0) {
    blocks.push(`### Changed\n\n${TODO_CHANGELOG_PLACEHOLDER}`);
  }
  return blocks.join('\n\n');
}

interface ParsedChangelogSection {
  readonly tag: string;
  readonly dateIso: string;
  readonly body: string;
}

interface ParsedChangelogDoc {
  readonly preamble: string;
  readonly unreleasedBody: string;
  readonly sections: ParsedChangelogSection[];
  readonly otherHeadings: readonly string[];
  readonly existingLinks: ReadonlyMap<string, string>;
}

function splitReferenceLinks(content: string): {
  readonly mainText: string;
  readonly existingLinks: Map<string, string>;
} {
  const lines = content.split(/\r?\n/);
  const existingLinks = new Map<string, string>();
  let cutIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    const match = REF_LINK_RE.exec(line);
    if (match?.[1] && match[2]) {
      existingLinks.set(match[1], match[2]);
      cutIdx = i;
      continue;
    }
    break;
  }
  return { mainText: lines.slice(0, cutIdx).join('\n').trimEnd(), existingLinks };
}

function parseChangelogDoc(rawContent: string): ParsedChangelogDoc {
  const { mainText, existingLinks } = splitReferenceLinks(rawContent);
  const lines = mainText.split(/\r?\n/);
  const headingIndices: Array<{
    idx: number;
    kind: 'unreleased' | 'version' | 'other';
    tag?: string;
    dateIso?: string;
    rawHeading?: string;
  }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (UNRELEASED_HEADING_RE.test(line)) {
      headingIndices.push({ idx: i, kind: 'unreleased' });
      continue;
    }
    const verMatch = VERSION_HEADING_RE.exec(line);
    if (verMatch?.[1] && verMatch[2]) {
      headingIndices.push({ idx: i, kind: 'version', tag: verMatch[1], dateIso: verMatch[2] });
      continue;
    }
    if (line.startsWith('## ')) {
      headingIndices.push({ idx: i, kind: 'other', rawHeading: line.trim() });
    }
  }

  const firstIdx = headingIndices[0]?.idx ?? lines.length;
  const preamble =
    lines.slice(0, firstIdx).join('\n').trim() ||
    [
      '# Changelog',
      '',
      'All notable changes to `agy-hud` are documented in this file.',
      '',
      'The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).',
    ].join('\n');

  let unreleasedCount = 0;
  let unreleasedBody = '';
  const sections: ParsedChangelogSection[] = [];
  const otherHeadings: string[] = [];
  for (let h = 0; h < headingIndices.length; h += 1) {
    const cur = headingIndices[h];
    if (!cur) continue;
    const nextIdx = headingIndices[h + 1]?.idx ?? lines.length;
    const body = lines
      .slice(cur.idx + 1, nextIdx)
      .join('\n')
      .trim();
    if (cur.kind === 'unreleased') {
      unreleasedCount += 1;
      if (unreleasedCount > 1) {
        throw new Error(
          'CHANGELOG.md contains duplicate ## [Unreleased] headings. Merge them manually before releasing.',
        );
      }
      unreleasedBody = body;
    } else if (cur.kind === 'version' && cur.tag && cur.dateIso) {
      sections.push({ tag: cur.tag, dateIso: cur.dateIso, body });
    } else if (cur.kind === 'other' && cur.rawHeading) {
      otherHeadings.push(cur.rawHeading);
    }
  }
  return { preamble, unreleasedBody, sections, otherHeadings, existingLinks };
}

function isSupersededPrerelease(sectionTag: string, stableTag: string): boolean {
  const secParsed = parseSemver(sectionTag);
  const stableParsed = parseSemver(stableTag);
  if (secParsed === null || stableParsed === null) return false;
  if (stableParsed.prerelease.length > 0 || secParsed.prerelease.length === 0) return false;
  return (
    secParsed.major === stableParsed.major &&
    secParsed.minor === stableParsed.minor &&
    secParsed.patch === stableParsed.patch
  );
}

function compareSectionsDesc(a: ParsedChangelogSection, b: ParsedChangelogSection): number {
  const pa = parseSemver(a.tag);
  const pb = parseSemver(b.tag);
  if (pa !== null && pb !== null) return compareSemver(pb, pa);
  return 0;
}

function buildCompareLinks(
  sections: readonly ParsedChangelogSection[],
  updatedTag: string,
  explicitPrevTag: string | null,
  existingLinks: ReadonlyMap<string, string>,
): string {
  if (sections.length === 0) {
    return `[Unreleased]: ${REPO_HTTPS_URL}/commits/main`;
  }
  const sortedBySemver = [...sections].sort(compareSectionsDesc);
  const highestStable = sortedBySemver.find((s) => !isPrereleaseVersion(s.tag));
  const unreleasedBase = highestStable?.tag ?? sortedBySemver[0]?.tag ?? 'main';
  const allTags = sections.map((s) => s.tag);

  const links: string[] = [`[Unreleased]: ${REPO_HTTPS_URL}/compare/${unreleasedBase}...HEAD`];
  for (const cur of sections) {
    if (cur.tag !== updatedTag) {
      const preservedUrl = existingLinks.get(cur.tag);
      if (preservedUrl !== undefined) {
        links.push(`[${cur.tag}]: ${preservedUrl}`);
        continue;
      }
    }
    const prev =
      cur.tag === updatedTag && explicitPrevTag !== null && isStrictSemverTag(explicitPrevTag)
        ? explicitPrevTag
        : findPreviousReleaseTag(cur.tag, allTags);
    if (prev !== null) {
      links.push(`[${cur.tag}]: ${REPO_HTTPS_URL}/compare/${prev}...${cur.tag}`);
    } else {
      links.push(`[${cur.tag}]: ${REPO_HTTPS_URL}/releases/tag/${cur.tag}`);
    }
  }
  return links.join('\n');
}

export function updateChangelogContent(existingContent: string | null, options: UpdateChangelogOptions): string {
  if (!isStrictSemverTag(options.tag)) {
    throw new Error(`Invalid changelog tag: '${options.tag}'`);
  }
  const doc = parseChangelogDoc(existingContent ?? '');
  if (doc.otherHeadings.length > 0) {
    throw new Error(
      `Unsupported level-2 heading in CHANGELOG.md: '${doc.otherHeadings[0]}'. Use '### ' subheadings inside a release section, or format release headings as '## [vX.Y.Z] - YYYY-MM-DD'.`,
    );
  }
  const existingIdx = doc.sections.findIndex((s) => s.tag === options.tag);
  if (existingIdx >= 0 && options.regenerate !== true) {
    throw new Error(
      `CHANGELOG.md already contains section '${options.tag}'. Pass --regenerate-changelog to refresh automated entries while preserving Highlights.`,
    );
  }

  const targetIsStable = !isPrereleaseVersion(options.tag);
  const remaining = doc.sections.filter((s) => {
    if (s.tag === options.tag) return false;
    if (targetIsStable && isSupersededPrerelease(s.tag, options.tag)) return false;
    return true;
  });

  const targetParsed = parseSemver(options.tag);
  const isMaintenancePatch =
    targetParsed !== null &&
    remaining.some((s) => {
      if (isPrereleaseVersion(s.tag)) return false;
      const parsed = parseSemver(s.tag);
      return parsed !== null && compareSemver(parsed, targetParsed) > 0;
    });

  const existingHighlights = existingIdx >= 0 ? extractHighlightsBlock(doc.sections[existingIdx]?.body ?? '') : null;
  const migratedUnreleasedBody = !isMaintenancePatch && doc.unreleasedBody.length > 0 ? doc.unreleasedBody : null;
  const isInitialRelease = targetIsStable && options.prevTag === null && remaining.length === 0;

  const newBody = generateVersionSectionBody({
    tag: options.tag,
    dateIso: options.dateIso,
    commits: options.commits,
    isInitialRelease,
    existingHighlights,
    migratedUnreleasedBody,
  });

  const updatedSections: ParsedChangelogSection[] = [
    { tag: options.tag, dateIso: options.dateIso, body: newBody },
    ...remaining,
  ].sort(compareSectionsDesc);

  const unreleasedBlock =
    isMaintenancePatch && doc.unreleasedBody.length > 0
      ? `## [Unreleased]\n\n${doc.unreleasedBody}`
      : '## [Unreleased]';
  const sectionBlocks = updatedSections.map((s) => `## [${s.tag}] - ${s.dateIso}\n\n${s.body}`);
  const refLinks = buildCompareLinks(updatedSections, options.tag, options.prevTag, doc.existingLinks);
  return `${[doc.preamble, unreleasedBlock, ...sectionBlocks, refLinks].join('\n\n')}\n`;
}

export function formatInstallHeader(tag: string): string {
  return [
    '## Install or Upgrade (Zero-Build)',
    '',
    '```bash',
    '# Latest release on main',
    `agy plugin install ${REPO_HTTPS_URL}`,
    '',
    `# Pinned to ${tag}`,
    `agy plugin install ${REPO_HTTPS_URL}/tree/${tag}`,
    '```',
    '',
    '> Note: Do not pass GitHub Release `.zip` or `.tar.gz` source archives to `agy plugin install`; Antigravity CLI installs directly from the GitHub repository or tag URL above.',
  ].join('\n');
}

export function extractReleaseNotes(
  changelogContent: string,
  tag: string,
  prevTag: string | null,
  options: { readonly withInstallHeader?: boolean } = {},
): string {
  if (!isStrictSemverTag(tag)) {
    throw new Error(`Invalid release tag: '${tag}'`);
  }
  const doc = parseChangelogDoc(changelogContent);
  const matching = doc.sections.filter((section) => section.tag === tag);
  if (matching.length === 0) {
    throw new Error(`CHANGELOG.md is missing section '## [${tag}] - YYYY-MM-DD'.`);
  }
  if (matching.length > 1) {
    throw new Error(`CHANGELOG.md contains duplicate sections for '${tag}' (${matching.length} found).`);
  }

  const rawBody = matching[0]!.body;
  if (rawBody.includes('<!-- TODO')) {
    throw new Error(`CHANGELOG.md section '${tag}' still contains an unresolved <!-- TODO --> placeholder.`);
  }
  const strippedBody = rawBody.replace(HTML_COMMENT_RE, '').trim();
  if (strippedBody.length === 0) {
    throw new Error(`CHANGELOG.md section '${tag}' has an empty release notes body.`);
  }
  if (EMOJI_CHECK_RE.test(rawBody)) {
    throw new Error(`CHANGELOG.md section '${tag}' contains forbidden pictographic emoji.`);
  }

  const parts: string[] = [];
  if (options.withInstallHeader === true) {
    parts.push(formatInstallHeader(tag));
  }
  parts.push(rawBody);
  if (prevTag !== null && isStrictSemverTag(prevTag)) {
    parts.push(`**Full Changelog**: ${REPO_HTTPS_URL}/compare/${prevTag}...${tag}`);
  }
  return `${parts.join('\n\n')}\n`;
}
