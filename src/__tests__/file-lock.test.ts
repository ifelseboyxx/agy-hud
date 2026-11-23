import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FileLockTimeoutError, withFileLocksSync } from '../core/file-lock.ts';

const FILE_LOCK_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'file-lock.ts');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function spawnWorker(code: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

void describe('sync file-lock stale reclamation, mutual exclusion, and shared deadline', async () => {
  await it('recovers from a crashed stale reclaimer across concurrent processes with strict mutual exclusion', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = makeTempDir('agy-hud-sync-reclaim-');
    const lockPath = path.join(root, '.resource.lock');
    const logPath = path.join(root, 'events.log');
    writeJson(lockPath, { pid: 999_999_999, token: 'dead-main-token', lockPath });
    const lockStat = lstatSync(lockPath);
    const oldDate = new Date(Date.now() - 10_000);
    utimesSync(lockPath, oldDate, oldDate);

    // Simulate a previous crashed reclaimer leaving stale attempt-0 marker.
    const staleReclaim0 = `${lockPath}.reclaim.${lockStat.dev}.${lockStat.ino}.0`;
    writeJson(staleReclaim0, { pid: 999_999_998, startedAt: Date.now() - 10_000 });
    utimesSync(staleReclaim0, oldDate, oldDate);

    const makeWorkerCode = (id: number): string => `
import { appendFileSync } from 'node:fs';
import { withFileLocksSync } from ${JSON.stringify(pathToFileURL(FILE_LOCK_MODULE).href)};
const cell = new Int32Array(new SharedArrayBuffer(4));
withFileLocksSync([${JSON.stringify(lockPath)}], () => {
  appendFileSync(${JSON.stringify(logPath)}, 'enter:${id}\\n', 'utf8');
  Atomics.wait(cell, 0, 0, 50);
  appendFileSync(${JSON.stringify(logPath)}, 'exit:${id}\\n', 'utf8');
}, 5000);
`;

    const results = await Promise.all([
      spawnWorker(makeWorkerCode(1)),
      spawnWorker(makeWorkerCode(2)),
      spawnWorker(makeWorkerCode(3)),
    ]);
    for (const res of results) {
      assert.equal(res.status, 0, res.stderr);
    }

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 6);
    for (let i = 0; i < lines.length; i += 2) {
      const enterId = lines[i]?.split(':')[1];
      const exitId = lines[i + 1]?.split(':')[1];
      assert.equal(lines[i]?.startsWith('enter:'), true, `expected enter event at ${i}: ${lines.join(', ')}`);
      assert.equal(lines[i + 1], `exit:${enterId}`, `overlapping critical section detected: ${lines.join(', ')}`);
      assert.ok(exitId);
    }
    assert.equal(existsSync(lockPath), false, 'main lock must be cleaned up');
    assert.deepEqual(
      readdirSync(root).filter((n) => n.includes('.reclaim')),
      [],
      'stale reclaim markers must be cleaned up after sync takeover',
    );
  });

  await it('throws FileLockTimeoutError within shared deadline across multiple locks and on read-only stale lock', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root1 = makeTempDir('agy-hud-sync-ro-');
    const roLock = path.join(root1, '.resource.lock');
    writeJson(roLock, { pid: 999_999_999, token: 'dead-token', lockPath: roLock });
    const oldDate = new Date(Date.now() - 10_000);
    utimesSync(roLock, oldDate, oldDate);
    chmodSync(root1, 0o555);
    try {
      assert.throws(() => withFileLocksSync([roLock], () => {}, 180), FileLockTimeoutError);
    } finally {
      chmodSync(root1, 0o755);
    }

    // Hold lockA for 220ms in a child worker and hold lockB indefinitely; shared 360ms budget must expire ~360ms (not 580ms).
    const root2 = makeTempDir('agy-hud-sync-deadline-');
    const lockA = path.join(root2, 'a.lock');
    const lockB = path.join(root2, 'b.lock');
    const lockAReady = path.join(root2, 'a.ready');
    writeJson(lockB, { pid: process.pid, token: 'live-holder', lockPath: lockB });
    const holderA = spawnWorker(`
import { writeFileSync } from 'node:fs';
import { withFileLocksSync } from ${JSON.stringify(pathToFileURL(FILE_LOCK_MODULE).href)};
const cell = new Int32Array(new SharedArrayBuffer(4));
withFileLocksSync([${JSON.stringify(lockA)}], () => {
  writeFileSync(${JSON.stringify(lockAReady)}, 'ready', 'utf8');
  Atomics.wait(cell, 0, 0, 220);
}, 5000);
`);
    const waitDeadline = Date.now() + 5000;
    while (!existsSync(lockAReady)) {
      if (Date.now() >= waitDeadline) throw new Error('Timed out waiting for lockA worker');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    const start = Date.now();
    assert.throws(() => withFileLocksSync([lockB, lockA], () => {}, 360), FileLockTimeoutError);
    const elapsed = Date.now() - start;
    const holderRes = await holderA;
    assert.equal(holderRes.status, 0, holderRes.stderr);

    assert.ok(elapsed >= 320 && elapsed < 520, `expected shared deadline ~360ms, got ${elapsed}ms`);
    assert.equal(existsSync(lockA), false, 'lockA must be released when lockB times out');
  });

  await it('cleans up and recovers when all 16 reclaim slots are occupied by crashed stale reclaimers', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = makeTempDir('agy-hud-sync-16-stale-');
    const lockPath = path.join(root, '.resource.lock');
    writeJson(lockPath, { pid: 999_999_999, token: 'dead-main-token', lockPath });
    const st = lstatSync(lockPath);
    const oldDate = new Date(Date.now() - 10_000);
    utimesSync(lockPath, oldDate, oldDate);

    for (let i = 0; i < 16; i += 1) {
      const slot = `${lockPath}.reclaim.${st.dev}.${st.ino}.${i}`;
      writeJson(slot, { pid: 999_999_900 + i, startedAt: Date.now() - 10_000 });
      utimesSync(slot, oldDate, oldDate);
    }

    let entered = false;
    withFileLocksSync(
      [lockPath],
      () => {
        entered = true;
      },
      2000,
    );
    assert.equal(entered, true, 'must recover even when all 16 reclaim slots were left stale');
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(
      readdirSync(root).filter((n) => n.includes('.reclaim')),
      [],
      'all stale reclaim markers must be cleaned up',
    );
  });
});
