import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/core/fs-utils.ts';
import { walkFiles } from './lib/walk-files.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['src', 'scripts', 'tests'] as const;
const SOURCE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

const MAX_LINES = 500;
const MAX_CONSECUTIVE_COMMENTS = 12;
const COMMENT_RATIO_MIN_LINES = 15;
const MAX_COMMENT_RATIO = 0.25;

export interface MaintainabilityIssue {
  file: string;
  reason: string;
}

function collectSourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  for (const rel of SOURCE_ROOTS) {
    walkFiles(
      path.join(projectRoot, rel),
      projectRoot,
      { includeFile: (_rel, name) => SOURCE_EXTS.has(path.extname(name)) },
      files,
    );
  }
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
      files.push(path.join(projectRoot, entry.name));
    }
  }
  return files.sort();
}

function inspectFile(rel: string, content: string, issues: MaintainabilityIssue[]): void {
  const rawLines = content.length === 0 ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/);
  if (rawLines.length > MAX_LINES) {
    issues.push({ file: rel, reason: `行数 ${rawLines.length} 超过上限 ${MAX_LINES}` });
  }

  let inBlockComment = false;
  let inExemptHostContract = false;
  let seenCode = false;
  let usedHostContractExempt = false;
  let commentLines = 0;
  let nonEmptyLines = 0;
  let currentRun = 0;
  let longestRun = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      currentRun = 0;
      continue;
    }
    nonEmptyLines += 1;

    let isCommentLine = false;
    let isExemptLine = false;
    if (inBlockComment) {
      isCommentLine = true;
      isExemptLine = inExemptHostContract;
      if (trimmed.includes('*/')) {
        inBlockComment = false;
        inExemptHostContract = false;
      }
    } else if (trimmed.startsWith('//')) {
      isCommentLine = true;
    } else if (trimmed.startsWith('/*')) {
      isCommentLine = true;
      const startsContract = !seenCode && !usedHostContractExempt && trimmed.includes('@host-contract');
      if (startsContract) {
        usedHostContractExempt = true;
        isExemptLine = true;
      }
      if (!trimmed.includes('*/')) {
        inBlockComment = true;
        inExemptHostContract = startsContract;
      }
    } else {
      seenCode = true;
    }

    if (isCommentLine) {
      if (!isExemptLine) {
        commentLines += 1;
        currentRun += 1;
        if (currentRun > longestRun) longestRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  if (longestRun > MAX_CONSECUTIVE_COMMENTS) {
    issues.push({ file: rel, reason: `连续注释 ${longestRun} 行超过上限 ${MAX_CONSECUTIVE_COMMENTS}` });
  }
  if (commentLines >= COMMENT_RATIO_MIN_LINES && nonEmptyLines > 0) {
    const ratio = commentLines / nonEmptyLines;
    if (ratio >= MAX_COMMENT_RATIO) {
      issues.push({
        file: rel,
        reason: `注释占比 ${(ratio * 100).toFixed(1)}% (${commentLines}/${nonEmptyLines}) 达到或超过 ${MAX_COMMENT_RATIO * 100}%`,
      });
    }
  }
}

export function validateSourceMaintainability(projectRoot: string = root): MaintainabilityIssue[] {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const issues: MaintainabilityIssue[] = [];
  for (const abs of collectSourceFiles(resolvedRoot)) {
    const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
    const content = fs.readFileSync(abs, 'utf8');
    inspectFile(rel, content, issues);
  }
  return issues;
}

if (isMainEntry(import.meta.url)) {
  const issues = validateSourceMaintainability(root);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[FAIL] ${issue.file}: ${issue.reason}`);
    }
    process.exit(1);
  }
  console.log('[OK] 源码可维护性校验通过');
}
