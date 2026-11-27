import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { StatusLineData } from '../types.ts';
import { nonEmptyStr, UNSAFE_OBJECT_KEYS } from './guards.ts';
import { expandHome, isStrictDescendantPath } from './paths.ts';

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type LstatOutcome = { kind: 'ok'; stat: Stats } | { kind: 'missing' } | { kind: 'error' };

interface TrustedRoot {
  logical: string;
  real: string;
}

export function sanitizeSessionId(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.includes('..') || UNSAFE_OBJECT_KEYS.has(trimmed)) {
    return null;
  }
  return SAFE_SESSION_ID_RE.test(trimmed) ? trimmed : null;
}

export function resolveConversationId(data: StatusLineData): string | null {
  return sanitizeSessionId(nonEmptyStr(data.conversation_id) ?? nonEmptyStr(data.session_id));
}

function lstatOutcome(p: string): LstatOutcome {
  try {
    return { kind: 'ok', stat: lstatSync(p) };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { kind: 'missing' };
    }
    return { kind: 'error' };
  }
}

function realpathIfExists(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isDirectoryAt(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFileAt(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function checkExistingSegment(stat: Stats, curPath: string, realRoot: string, isLast: boolean): boolean {
  if (stat.isSymbolicLink()) {
    const realCur = realpathIfExists(curPath);
    if (realCur === null || !isStrictDescendantPath(realRoot, realCur)) {
      return false;
    }
    return isLast ? isRegularFileAt(realCur) : isDirectoryAt(realCur);
  }
  return isLast ? stat.isFile() : stat.isDirectory();
}

function verifySegmentsInsideRealRoot(resolvedRoot: string, realRoot: string, resolvedCandidate: string): boolean {
  if (!isStrictDescendantPath(resolvedRoot, resolvedCandidate)) {
    return false;
  }

  const rel = path.relative(resolvedRoot, resolvedCandidate);
  const segments = rel.split(path.sep);
  let cur = resolvedRoot;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === undefined) return false;
    cur = path.join(cur, seg);
    const outcome = lstatOutcome(cur);
    if (outcome.kind === 'error') return false;
    if (outcome.kind === 'missing') return true;
    if (!checkExistingSegment(outcome.stat, cur, realRoot, i === segments.length - 1)) {
      return false;
    }
  }

  const finalReal = realpathIfExists(resolvedCandidate);
  return finalReal !== null && isStrictDescendantPath(realRoot, finalReal) && isRegularFileAt(finalReal);
}

function resolveCanonicalParent(parentDir: string): TrustedRoot | null {
  const resolvedParent = path.resolve(parentDir);
  const missingSegments: string[] = [];
  let cur = resolvedParent;

  while (true) {
    const outcome = lstatOutcome(cur);
    if (outcome.kind === 'error') {
      return null;
    }
    if (outcome.kind === 'ok') {
      const realBase = realpathIfExists(cur);
      if (realBase === null || !isDirectoryAt(realBase)) {
        return null;
      }
      return { logical: resolvedParent, real: path.join(realBase, ...missingSegments) };
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return null;
    }
    missingSegments.unshift(path.basename(cur));
    cur = parent;
  }
}

function resolveTrustedSubdir(parentDir: string, subSegments: readonly string[]): TrustedRoot | null {
  const base = resolveCanonicalParent(parentDir);
  if (base === null) {
    return null;
  }

  let logicalCur = base.logical;
  let expectedRealCur = base.real;
  for (const seg of subSegments) {
    logicalCur = path.resolve(logicalCur, seg);
    expectedRealCur = path.join(expectedRealCur, seg);
    if (!isStrictDescendantPath(base.logical, logicalCur)) {
      return null;
    }
    const outcome = lstatOutcome(logicalCur);
    if (outcome.kind === 'error') {
      return null;
    }
    if (outcome.kind === 'ok') {
      if (outcome.stat.isSymbolicLink() || !outcome.stat.isDirectory()) {
        return null;
      }
      const actualReal = realpathIfExists(logicalCur);
      if (actualReal === null || actualReal !== expectedRealCur) {
        return null;
      }
    }
  }

  return { logical: logicalCur, real: expectedRealCur };
}

export function resolveTrustedCliDir(cliHome: string, subDir: string): string | null {
  const trusted = resolveTrustedSubdir(cliHome, [subDir]);
  if (trusted === null || !existsSync(trusted.logical)) {
    return null;
  }
  return trusted.logical;
}

export function resolveCliSubdirFile(cliHome: string, subDir: string, ...segments: string[]): string | null {
  const trusted = resolveTrustedSubdir(cliHome, [subDir]);
  if (trusted === null) {
    return null;
  }
  const candidate = path.resolve(trusted.logical, ...segments);
  return verifySegmentsInsideRealRoot(trusted.logical, trusted.real, candidate) ? candidate : null;
}

export function resolveSafeSkillFile(cliHome: string, rawSkillFile: string, workspaceDir?: string): string | null {
  if (!existsSync(rawSkillFile)) {
    return null;
  }
  const resolvedCandidate = path.resolve(rawSkillFile);
  const rootInputs = [cliHome, path.dirname(cliHome)];
  const ws = nonEmptyStr(workspaceDir);
  if (ws !== undefined) {
    rootInputs.push(ws);
  }

  for (const rawRoot of rootInputs) {
    if (!existsSync(rawRoot)) continue;
    const root = resolveCanonicalParent(rawRoot);
    if (root === null) continue;
    if (
      verifySegmentsInsideRealRoot(root.logical, root.real, resolvedCandidate) ||
      verifySegmentsInsideRealRoot(root.real, root.real, resolvedCandidate)
    ) {
      return resolvedCandidate;
    }
  }
  return null;
}

export function resolveSafeTranscriptFile(
  cliHome: string,
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return null;
  const expanded = expandHome(trimmed, env);
  const candidates = [expanded];
  const rewritten = expanded.replace('/.gemini/antigravity/brain/', '/.gemini/antigravity-cli/brain/');
  if (rewritten !== expanded) {
    candidates.push(rewritten);
  }

  const trustedRoots: TrustedRoot[] = [];
  const cliBrain = resolveTrustedSubdir(cliHome, ['brain']);
  if (cliBrain !== null && existsSync(cliBrain.logical)) {
    trustedRoots.push(cliBrain);
  }
  const ideBrain = resolveTrustedSubdir(path.dirname(cliHome), ['antigravity', 'brain']);
  if (ideBrain !== null && existsSync(ideBrain.logical)) {
    trustedRoots.push(ideBrain);
  }

  for (const candidate of candidates) {
    if (!candidate.endsWith('.jsonl') || !existsSync(candidate)) {
      continue;
    }
    const resolvedCandidate = path.resolve(candidate);
    const matched = trustedRoots.some(
      (root) =>
        verifySegmentsInsideRealRoot(root.logical, root.real, resolvedCandidate) ||
        verifySegmentsInsideRealRoot(root.real, root.real, resolvedCandidate),
    );
    if (matched) {
      return resolvedCandidate;
    }
  }
  return null;
}
