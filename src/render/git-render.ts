import path from 'node:path';

import { isFiniteNum, nonEmptyStr } from '../core/guards.ts';
import { NARROW_PANE_WIDTH_THRESHOLD } from '../core/hud-config.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { GitStatusInfo, StatusLineData } from '../types.ts';
import {
  BOLD,
  BRIGHT_BLUE,
  BRIGHT_CYAN,
  BRIGHT_GREEN,
  BRIGHT_MAGENTA,
  BRIGHT_RED,
  BRIGHT_YELLOW,
  CYAN,
  GRAY,
  GREEN,
  RESET,
} from './ansi.ts';

function posInt(val: number | undefined): number {
  return isFiniteNum(val) && val > 0 ? Math.trunc(val) : 0;
}

function formatWideGitFlags(info: GitStatusInfo): string {
  const flagParts: string[] = [];
  if (posInt(info.conflicted) > 0) flagParts.push(`${BRIGHT_RED}=${RESET}`);
  if (posInt(info.staged) > 0) flagParts.push(`${BRIGHT_GREEN}+${RESET}`);
  if (posInt(info.modified) > 0) flagParts.push(`${BRIGHT_YELLOW}!${RESET}`);
  if (posInt(info.deleted) > 0) flagParts.push(`${BRIGHT_RED}-${RESET}`);
  if (posInt(info.renamed) > 0) flagParts.push(`${BRIGHT_CYAN}>${RESET}`);
  if (posInt(info.untracked) > 0) flagParts.push(`${GRAY}?${RESET}`);
  if (posInt(info.stash) > 0) flagParts.push(`${BRIGHT_MAGENTA}$${RESET}`);
  return flagParts.join('');
}

function formatWideAheadBehind(info: GitStatusInfo): string {
  const ahead = posInt(info.ahead);
  const behind = posInt(info.behind);
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${BRIGHT_CYAN}↑${ahead}${RESET}`);
  if (behind > 0) parts.push(`${BRIGHT_MAGENTA}↓${behind}${RESET}`);
  return parts.join('');
}

function formatWideDiffStats(info: GitStatusInfo): string {
  const added = posInt(info.diffAdded);
  const deleted = posInt(info.diffDeleted);
  if (added === 0 && deleted === 0) return '';
  const parts: string[] = [];
  if (added > 0) parts.push(`${GREEN}+${added}${RESET}`);
  if (deleted > 0) parts.push(`${BRIGHT_RED}-${deleted}${RESET}`);
  return parts.join(' ');
}

function hasDetailedGitFields(info: GitStatusInfo): boolean {
  return (
    posInt(info.conflicted) > 0 ||
    posInt(info.staged) > 0 ||
    posInt(info.modified) > 0 ||
    posInt(info.deleted) > 0 ||
    posInt(info.renamed) > 0 ||
    posInt(info.untracked) > 0 ||
    posInt(info.stash) > 0 ||
    posInt(info.ahead) > 0 ||
    posInt(info.behind) > 0 ||
    posInt(info.diffAdded) > 0 ||
    posInt(info.diffDeleted) > 0
  );
}

export function formatGitSegment(data: StatusLineData, info: GitStatusInfo | undefined, termWidth: number): string {
  const curDir =
    nonEmptyStr(data.workspace?.current_dir) ?? nonEmptyStr(data.workspace?.project_dir) ?? nonEmptyStr(data.cwd) ?? '';
  const dirName = curDir.length > 0 ? sanitizeTerminalLabel(path.basename(curDir.replace(/[\\/]+$/, ''))) : '';
  const branch = sanitizeTerminalLabel(info?.branch ?? nonEmptyStr(data.vcs?.branch) ?? '');
  const dirty = Boolean(info?.dirty ?? data.vcs?.dirty);

  const locItems: string[] = [];
  if (dirName.length > 0) {
    locItems.push(`${BRIGHT_BLUE}${BOLD}${dirName}${RESET}`);
  }
  if (branch.length > 0) {
    const isNarrow = termWidth < NARROW_PANE_WIDTH_THRESHOLD;
    if (isNarrow || info === undefined || !hasDetailedGitFields(info)) {
      const dirtyMark = dirty ? `${BRIGHT_YELLOW}*${RESET}` : '';
      locItems.push(`${CYAN}git:(${GREEN}${branch}${dirtyMark}${CYAN})${RESET}`);
    } else {
      const flags = formatWideGitFlags(info);
      const ab = formatWideAheadBehind(info);
      const suffixParts: string[] = [];
      if (flags.length > 0) suffixParts.push(flags);
      if (ab.length > 0) suffixParts.push(ab);
      const innerSuffix =
        suffixParts.length > 0 ? ` ${suffixParts.join(' ')}` : dirty ? `${BRIGHT_YELLOW}*${RESET}` : '';
      locItems.push(`${CYAN}git:(${GREEN}${branch}${innerSuffix}${CYAN})${RESET}`);
      const diffPart = formatWideDiffStats(info);
      if (diffPart.length > 0) {
        locItems.push(diffPart);
      }
    }
  }
  return locItems.join(' ');
}
