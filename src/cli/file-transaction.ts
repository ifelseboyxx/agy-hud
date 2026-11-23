import { rmSync } from 'node:fs';

import { realpathExistingPrefixSync, toComparePath } from '../core/paths.ts';
import {
  captureEntrySnapshotSync,
  type EntrySnapshotSync,
  restoreOwnedEntrySnapshotSync,
  serializeJsonBuffer,
  statIfPresentSync,
  writeBufferAtomicSync,
} from '../fs-utils.ts';

export type PlannedOp = { kind: 'write'; filePath: string; payload: unknown } | { kind: 'delete'; filePath: string };

function isSamePhysicalFile(pathA: string, pathB: string): boolean {
  if (toComparePath(realpathExistingPrefixSync(pathA)) === toComparePath(realpathExistingPrefixSync(pathB))) {
    return true;
  }
  const stA = statIfPresentSync(pathA);
  const stB = statIfPresentSync(pathB);
  return stA !== null && stB !== null && stA.dev === stB.dev && stA.ino === stB.ino;
}

export function assertNoExportPathOverlap(sourcePaths: readonly string[], outputPaths: readonly string[]): void {
  for (const outPath of outputPaths) {
    for (const srcPath of sourcePaths) {
      if (isSamePhysicalFile(srcPath, outPath)) {
        throw new Error(`Refusing to export into active source path: ${outPath} overlaps with ${srcPath}`);
      }
    }
  }
}

interface CommittedOpRecord {
  snap: EntrySnapshotSync;
  expectedWritten: Buffer | null;
}

function rollbackCommittedOps(committed: readonly CommittedOpRecord[]): string[] {
  const rollbackErrors: string[] = [];
  for (let i = committed.length - 1; i >= 0; i -= 1) {
    const rec = committed[i];
    if (!rec) continue;
    try {
      restoreOwnedEntrySnapshotSync(rec.snap, rec.expectedWritten);
    } catch (rbErr) {
      rollbackErrors.push(`${rec.snap.filePath}: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
    }
  }
  return rollbackErrors;
}

export function commitPlannedOps(planned: readonly PlannedOp[]): string[] {
  const snapshots = planned.map(({ filePath }) => captureEntrySnapshotSync(filePath));
  const written: string[] = [];
  const committed: CommittedOpRecord[] = [];
  try {
    for (let i = 0; i < planned.length; i += 1) {
      const item = planned[i];
      const snap = snapshots[i];
      if (!item || !snap) continue;
      if (item.kind === 'write') {
        const content = serializeJsonBuffer(item.payload);
        writeBufferAtomicSync(item.filePath, content);
        committed.push({ snap, expectedWritten: content });
        written.push(item.filePath);
      } else {
        rmSync(item.filePath, { force: true });
        committed.push({ snap, expectedWritten: null });
      }
    }
  } catch (err) {
    const rollbackErrors = rollbackCommittedOps(committed);
    if (rollbackErrors.length > 0) {
      const primaryMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`${primaryMsg} (rollback failed: ${rollbackErrors.join('; ')})`);
    }
    throw err;
  }
  return written;
}
