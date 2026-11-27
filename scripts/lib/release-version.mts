export const STRICT_SEMVER_RE: RegExp =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export type ReleasePreid = 'rc' | 'beta';

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly raw: string;
}

const DIGITS_ONLY_RE = /^\d+$/;

export function parseSemver(input: string): ParsedSemver | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.includes('/') || trimmed.includes('+')) {
    return null;
  }
  const normalized = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  const match = STRICT_SEMVER_RE.exec(normalized);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const prerelease = match[4] !== undefined && match[4].length > 0 ? match[4].split('.') : [];
  return { major, minor, patch, prerelease, raw: normalized };
}

export function isStrictSemverTag(tag: string): boolean {
  if (!tag.startsWith('v') || tag.includes('/') || tag.includes('+')) {
    return false;
  }
  return parseSemver(tag) !== null;
}

export function isPrereleaseVersion(versionOrTag: string): boolean {
  const parsed = parseSemver(versionOrTag);
  return parsed !== null && parsed.prerelease.length > 0;
}

export function formatVersionTag(versionOrTag: string): string {
  const parsed = parseSemver(versionOrTag);
  if (parsed === null) {
    throw new Error(`Invalid single-segment SemVer version: '${versionOrTag}'`);
  }
  return `v${parsed.raw}`;
}

export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const idA = aPre[i];
    const idB = bPre[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    if (idA === idB) continue;
    const numA = DIGITS_ONLY_RE.test(idA);
    const numB = DIGITS_ONLY_RE.test(idB);
    if (numA && numB) {
      const biA = BigInt(idA);
      const biB = BigInt(idB);
      return biA < biB ? -1 : biA > biB ? 1 : 0;
    }
    if (numA) return -1;
    if (numB) return 1;
    return idA < idB ? -1 : 1;
  }
  return 0;
}

export function resolveNextVersion(currentRaw: string, targetRaw: string, explicitPreid?: ReleasePreid): string {
  const cur = parseSemver(currentRaw);
  if (cur === null) {
    throw new Error(`Current package version is not valid SemVer: '${currentRaw}'`);
  }
  const target = targetRaw.trim();
  if (target === 'current') {
    return cur.raw;
  }
  if (target === 'patch') {
    if (cur.prerelease.length > 0) {
      return `${cur.major}.${cur.minor}.${cur.patch}`;
    }
    return `${cur.major}.${cur.minor}.${cur.patch + 1}`;
  }
  if (target === 'minor') {
    if (cur.prerelease.length > 0 && cur.patch === 0) {
      return `${cur.major}.${cur.minor}.0`;
    }
    return `${cur.major}.${cur.minor + 1}.0`;
  }
  if (target === 'major') {
    if (cur.prerelease.length > 0 && cur.minor === 0 && cur.patch === 0) {
      return `${cur.major}.0.0`;
    }
    return `${cur.major + 1}.0.0`;
  }
  if (target === 'prerelease') {
    const preid: ReleasePreid = explicitPreid ?? 'rc';
    if (cur.prerelease.length > 0) {
      const curPreId = cur.prerelease[0];
      const curNumRaw = cur.prerelease[1];
      if (
        (explicitPreid === undefined || curPreId === explicitPreid) &&
        curPreId !== undefined &&
        curNumRaw !== undefined &&
        DIGITS_ONLY_RE.test(curNumRaw) &&
        cur.prerelease.length === 2
      ) {
        const nextNum = BigInt(curNumRaw) + 1n;
        return `${cur.major}.${cur.minor}.${cur.patch}-${curPreId}.${nextNum.toString()}`;
      }
      return `${cur.major}.${cur.minor}.${cur.patch}-${preid}.1`;
    }
    return `${cur.major}.${cur.minor}.${cur.patch + 1}-${preid}.1`;
  }

  const explicit = parseSemver(target);
  if (explicit === null) {
    throw new Error(
      `Invalid release target '${target}'. Use patch, minor, major, prerelease, current, or single-segment SemVer X.Y.Z[-pre.N].`,
    );
  }
  return explicit.raw;
}

export function findPreviousReleaseTag(targetTag: string, existingTags: readonly string[]): string | null {
  const target = parseSemver(targetTag);
  if (target === null) {
    return null;
  }
  const targetIsPrerelease = target.prerelease.length > 0;
  const candidates: Array<{ tag: string; parsed: ParsedSemver }> = [];

  for (const tag of existingTags) {
    if (!isStrictSemverTag(tag) || tag === `v${target.raw}`) continue;
    const parsed = parseSemver(tag);
    if (parsed === null) continue;
    if (!targetIsPrerelease && parsed.prerelease.length > 0) continue;
    if (compareSemver(parsed, target) < 0) {
      candidates.push({ tag, parsed });
    }
  }
  candidates.sort((a, b) => compareSemver(b.parsed, a.parsed));
  return candidates[0]?.tag ?? null;
}

export function isHighestStableTag(targetTag: string, existingTags: readonly string[]): boolean {
  const target = parseSemver(targetTag);
  if (target === null || target.prerelease.length > 0) {
    return false;
  }
  for (const tag of existingTags) {
    if (!isStrictSemverTag(tag)) continue;
    const parsed = parseSemver(tag);
    if (parsed === null || parsed.prerelease.length > 0) continue;
    if (compareSemver(parsed, target) > 0) {
      return false;
    }
  }
  return true;
}

function scanJsonStringEnd(text: string, openQuoteIdx: number): number {
  let i = openQuoteIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i;
    i += 1;
  }
  return -1;
}

function skipJsonWhitespace(text: string, idx: number): number {
  let i = idx;
  while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
  return i;
}

export function replaceTopLevelJsonVersion(rawJson: string, nextVersion: string): string {
  let braceDepth = 0;
  let bracketDepth = 0;
  let expectingTopKey = false;
  let i = 0;

  while (i < rawJson.length) {
    const ch = rawJson[i] ?? '';
    if (ch === '"') {
      const end = scanJsonStringEnd(rawJson, i);
      if (end < 0) break;
      if (braceDepth === 1 && bracketDepth === 0 && expectingTopKey) {
        const key = JSON.parse(rawJson.slice(i, end + 1)) as unknown;
        const colonIdx = skipJsonWhitespace(rawJson, end + 1);
        if (key === 'version' && rawJson[colonIdx] === ':') {
          const valStart = skipJsonWhitespace(rawJson, colonIdx + 1);
          if (rawJson[valStart] === '"') {
            const valEnd = scanJsonStringEnd(rawJson, valStart);
            if (valEnd >= 0) {
              const updated = `${rawJson.slice(0, valStart)}${JSON.stringify(nextVersion)}${rawJson.slice(valEnd + 1)}`;
              const parsed = JSON.parse(updated) as { version?: unknown };
              if (parsed.version === nextVersion) {
                return updated;
              }
            }
          }
          break;
        }
        expectingTopKey = false;
      }
      i = end + 1;
      continue;
    }
    if (ch === '{') {
      braceDepth += 1;
      if (braceDepth === 1 && bracketDepth === 0) expectingTopKey = true;
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      expectingTopKey = false;
    } else if (ch === '[') {
      bracketDepth += 1;
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (ch === ',' && braceDepth === 1 && bracketDepth === 0) {
      expectingTopKey = true;
    }
    i += 1;
  }

  throw new Error('Failed to locate top-level string "version" field in JSON document.');
}
