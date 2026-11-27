import { nonEmptyStr } from '../core/guards.ts';
import { isColorDisabledByEnv } from '../core/terminal-text.ts';
import type { HudConfig } from '../types.ts';
import { GRAY, RESET } from './ansi.ts';

const ESC = String.fromCharCode(0x1b);
const ACTIVITY_SUMMARY_SNAPSHOT_TAIL_COLS: number = 11;

export function canEmitOsc8Links(
  config: Pick<HudConfig, 'osc8Links'>,
  convId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!config.osc8Links || convId === null || convId.trim().length === 0) {
    return false;
  }
  if (isColorDisabledByEnv(env)) {
    return false;
  }
  if (
    nonEmptyStr(env.SSH_CONNECTION) !== undefined ||
    nonEmptyStr(env.SSH_CLIENT) !== undefined ||
    nonEmptyStr(env.SSH_TTY) !== undefined
  ) {
    return false;
  }
  return true;
}

export function wrapOsc8Link(text: string, uri: string): string {
  return `${ESC}]8;;${uri}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

export function formatOsc8Overflow(hiddenCount: number, uri: string): string {
  return `${GRAY}${wrapOsc8Link(`+${hiddenCount} more`, uri)}${RESET}`;
}

export function formatActivitySummarySnapshotTail(remainingCols: number, uri: string): string {
  if (remainingCols < ACTIVITY_SUMMARY_SNAPSHOT_TAIL_COLS) {
    return '';
  }
  return ` ${GRAY}· ${wrapOsc8Link('snapshot', uri)}${RESET}`;
}

export function countEmittedOsc8Links(lines: readonly string[], uri: string): number {
  const openSeq = `${ESC}]8;;${uri}${ESC}\\`;
  let count = 0;
  for (const line of lines) {
    let idx = line.indexOf(openSeq);
    while (idx !== -1) {
      count += 1;
      idx = line.indexOf(openSeq, idx + openSeq.length);
    }
  }
  return count;
}
