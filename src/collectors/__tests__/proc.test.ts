import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { withFileLocksSync } from '../../core/file-lock.ts';
import { detectAgyProcess, findAncestorAgyPid, parseLinuxProcStat, type AncestorProcSample } from '../proc.ts';

function makeProcReader(
  table: Readonly<Record<number, AncestorProcSample>>,
): (pid: number) => AncestorProcSample | null {
  return (pid: number): AncestorProcSample | null => table[pid] ?? null;
}

void describe('proc ancestor walk and PID-keyed cache', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-proc-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('matches agy and agy.exe case-insensitively up to 8 hops while skipping shell and node wrappers', () => {
    const tree: Record<number, AncestorProcSample> = {
      800: { pid: 800, ppid: 700, comm: 'node', args: 'node /path/to/cli.mjs --dangerously-skip-permissions' },
      700: { pid: 700, ppid: 600, comm: 'sh', args: 'sh -c "agy --dangerously-skip-permissions"' },
      600: { pid: 600, ppid: 500, comm: 'zsh', args: '-zsh -c "agy --mode plan"' },
      500: { pid: 500, ppid: 400, comm: 'bash', args: 'bash -c "node shim.js"' },
      400: { pid: 400, ppid: 300, comm: 'cmd.exe', args: 'cmd.exe /c agy --dangerously-skip-permissions' },
      300: { pid: 300, ppid: 200, comm: 'powershell.exe', args: 'powershell.exe -Command agy' },
      200: { pid: 200, ppid: 100, comm: 'pwsh', args: 'pwsh -Command agy' },
      100: {
        pid: 100,
        ppid: 1,
        comm: 'AGY.EXE',
        args: 'C:\\Users\\dev\\.local\\bin\\AGY.EXE --dangerously-skip-permissions --mode=plan',
      },
    };

    const info = detectAgyProcess(cliHome, {
      platform: 'linux',
      startPid: 800,
      readProc: makeProcReader(tree),
      isAlive: (pid) => pid in tree,
    });

    assert.deepEqual(info, { agyPid: 100, bypass: true, cliMode: 'plan' });
  });

  void it('returns null agyPid when agy sits beyond 8 ancestor hops', () => {
    const tree: Record<number, AncestorProcSample> = {
      900: { pid: 900, ppid: 800, comm: 'node', args: 'node hud.mjs' },
      800: { pid: 800, ppid: 700, comm: 'sh', args: 'sh -c hud' },
      700: { pid: 700, ppid: 600, comm: 'sh', args: 'sh -c hud' },
      600: { pid: 600, ppid: 500, comm: 'sh', args: 'sh -c hud' },
      500: { pid: 500, ppid: 400, comm: 'sh', args: 'sh -c hud' },
      400: { pid: 400, ppid: 300, comm: 'sh', args: 'sh -c hud' },
      300: { pid: 300, ppid: 200, comm: 'sh', args: 'sh -c hud' },
      200: { pid: 200, ppid: 100, comm: 'sh', args: 'sh -c hud' },
      100: { pid: 100, ppid: 1, comm: 'agy', args: '/usr/local/bin/agy --mode auto' },
    };

    const pid = findAncestorAgyPid({
      platform: 'darwin',
      startPid: 900,
      readProc: makeProcReader(tree),
      isAlive: (p) => p in tree,
    });
    assert.equal(pid, null);
  });

  void it('keeps concurrent live agy PIDs in a PID-keyed cache and prunes dead PIDs', () => {
    let calls = 0;
    const alive = new Set<number>([1001, 1002]);
    const tree: Record<number, AncestorProcSample> = {
      1001: { pid: 1001, ppid: 1, comm: 'agy', args: 'agy --dangerously-skip-permissions' },
      1002: { pid: 1002, ppid: 1, comm: 'agy', args: 'agy --mode accept-edits' },
      1003: { pid: 1003, ppid: 1, comm: 'agy', args: 'agy --mode auto' },
    };
    const readProc = (pid: number): AncestorProcSample | null => {
      calls += 1;
      return tree[pid] ?? null;
    };

    const firstA = detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 1001,
      readProc,
      isAlive: (p) => alive.has(p),
    });
    const firstB = detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 1002,
      readProc,
      isAlive: (p) => alive.has(p),
    });
    assert.deepEqual(firstA, { agyPid: 1001, bypass: true, cliMode: '' });
    assert.deepEqual(firstB, { agyPid: 1002, bypass: false, cliMode: 'accept-edits' });
    assert.equal(calls, 2);

    const cachedA = detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 1001,
      readProc,
      isAlive: (p) => alive.has(p),
    });
    const cachedB = detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 1002,
      readProc,
      isAlive: (p) => alive.has(p),
    });
    assert.deepEqual(cachedA, firstA);
    assert.deepEqual(cachedB, firstB);
    assert.equal(calls, 2, 'concurrent sessions must both hit the PID-keyed cache without thrashing');

    alive.delete(1001);
    alive.add(1003);
    detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 1003,
      readProc,
      isAlive: (p) => alive.has(p),
    });

    const rawCache = JSON.parse(readFileSync(path.join(cliHome, 'cache', 'agy_hud_proc.json'), 'utf8')) as {
      v: number;
      byPpid: Record<string, unknown>;
      byAgyPid: Record<string, unknown>;
    };
    assert.equal(rawCache.v, 2);
    assert.equal('1001' in rawCache.byPpid, false, 'dead PID must be pruned from byPpid');
    assert.equal('1001' in rawCache.byAgyPid, false, 'dead PID must be pruned from byAgyPid');
    assert.equal('1002' in rawCache.byAgyPid, true);
    assert.equal('1003' in rawCache.byAgyPid, true);
  });

  void it('runs Windows Win32_Process lookup at most once per live agyPid and degrades cleanly on timeout', () => {
    let psCalls = 0;
    const alive = new Set<number>([5555, 6001, 6002]);
    const readWin32 = (): AncestorProcSample[] => {
      psCalls += 1;
      return [
        { pid: 6001, ppid: 5555, comm: 'cmd.exe', args: 'cmd.exe /c node hud.mjs' },
        { pid: 5555, ppid: 100, comm: 'agy.exe', args: 'agy.exe --mode plan --dangerously-skip-permissions' },
      ];
    };

    const tick1 = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6001,
      readWin32Ancestors: readWin32,
      isAlive: (p) => alive.has(p),
    });
    assert.deepEqual(tick1, { agyPid: 5555, bypass: true, cliMode: 'plan' });
    assert.equal(psCalls, 1);

    const tick2 = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6002,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: readWin32,
      isAlive: (p) => alive.has(p),
    });
    assert.deepEqual(tick2, { agyPid: 5555, bypass: true, cliMode: 'plan' });
    assert.equal(psCalls, 1, 'subsequent Windows ticks with live knownLiveAgyPid must skip PowerShell');

    const degraded = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 7001,
      readWin32Ancestors: () => null,
      isAlive: (p) => p === 7001,
    });
    assert.deepEqual(degraded, { agyPid: null, bypass: false, cliMode: '' });
  });

  void it('parses Linux /proc stat lines containing spaces and closing parentheses in comm', () => {
    const parsed = parseLinuxProcStat('4242 (my (weird) proc) S 1337 4242 4242 0 -1 4194304');
    assert.deepEqual(parsed, { comm: 'my (weird) proc', ppid: 1337 });
    assert.equal(parseLinuxProcStat('malformed'), null);
  });

  void it('re-walks Windows ancestors when knownLiveAgyPid is absent from proc cache', () => {
    let psCalls = 0;
    const alive = new Set<number>([5555, 6003]);
    const readWin32 = (): AncestorProcSample[] => {
      psCalls += 1;
      return [
        { pid: 6003, ppid: 5555, comm: 'cmd.exe', args: 'cmd.exe /c node hud.mjs' },
        { pid: 5555, ppid: 100, comm: 'agy.exe', args: 'agy.exe --mode plan --dangerously-skip-permissions' },
      ];
    };

    const recovered = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6003,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: readWin32,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(psCalls, 1);
    assert.deepEqual(recovered, { agyPid: 5555, bypass: true, cliMode: 'plan' });
  });

  void it('ignores invalid non-v2 proc cache and repopulates v2 entry from ancestor walk', () => {
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    writeFileSync(
      path.join(cliHome, 'cache', 'agy_hud_proc.json'),
      JSON.stringify({ ppid: 999, bypass: true, cliMode: 'plan' }),
      'utf8',
    );
    const alive = new Set<number>([2001, 2000]);
    const info = detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 2001,
      isAlive: (p) => alive.has(p),
      readProc: (pid) => {
        if (pid === 2001) return { pid: 2001, ppid: 2000, comm: 'sh', args: 'sh -c hud.mjs' };
        if (pid === 2000) return { pid: 2000, ppid: 1, comm: 'agy', args: 'agy --mode accept-edits' };
        return null;
      },
    });
    assert.deepEqual(info, { agyPid: 2000, bypass: false, cliMode: 'accept-edits' });
    const persisted = JSON.parse(readFileSync(path.join(cliHome, 'cache', 'agy_hud_proc.json'), 'utf8')) as {
      v: number;
      byAgyPid: Record<string, { cliMode: string }>;
    };
    assert.equal(persisted.v, 2);
    assert.equal(persisted.byAgyPid['2000']?.cliMode, 'accept-edits');
  });

  void it('preserves knownLiveAgyPid when Windows ancestor lookup times out', () => {
    const alive = new Set<number>([5555, 6004]);
    const degraded = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6004,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: () => null,
      isAlive: (p) => alive.has(p),
    });
    assert.deepEqual(degraded, { agyPid: 5555, bypass: false, cliMode: '' });
  });

  void it('skips repeated Windows PowerShell walks on subsequent ticks after timeout fallback', () => {
    let psCalls = 0;
    const alive = new Set<number>([5555, 6005, 6006]);
    const timedOut = (): AncestorProcSample[] | null => {
      psCalls += 1;
      return null;
    };

    const tick1 = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6005,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: timedOut,
      isAlive: (p) => alive.has(p),
    });
    const tick2 = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6006,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: timedOut,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(tick1.agyPid, 5555);
    assert.equal(tick2.agyPid, 5555);
    assert.equal(psCalls, 1);
  });

  void it('skips Windows PowerShell walk when proc cache lock is held for a known live agyPid', () => {
    let psCalls = 0;
    const alive = new Set<number>([5555, 6007, 6008]);
    const lockFile = path.join(cliHome, 'cache', '.agy_hud_proc.lock');
    const reader = (): AncestorProcSample[] => {
      psCalls += 1;
      return [
        { pid: 6007, ppid: 5555, comm: 'cmd.exe', args: 'cmd.exe /c node hud.mjs' },
        { pid: 5555, ppid: 100, comm: 'agy.exe', args: 'agy.exe --mode plan' },
      ];
    };

    withFileLocksSync([lockFile], () => {
      const tick1 = detectAgyProcess(cliHome, {
        platform: 'win32',
        startPid: 6007,
        knownLiveAgyPid: 5555,
        readWin32Ancestors: reader,
        isAlive: (p) => alive.has(p),
      });
      const tick2 = detectAgyProcess(cliHome, {
        platform: 'win32',
        startPid: 6008,
        knownLiveAgyPid: 5555,
        readWin32Ancestors: reader,
        isAlive: (p) => alive.has(p),
      });
      assert.deepEqual(tick1, { agyPid: 5555, bypass: false, cliMode: '' });
      assert.deepEqual(tick2, { agyPid: 5555, bypass: false, cliMode: '' });
    });
    assert.equal(psCalls, 0);
  });

  void it('preserves knownLiveAgyPid when byPpid holds a stale null entry', () => {
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    writeFileSync(
      path.join(cliHome, 'cache', 'agy_hud_proc.json'),
      JSON.stringify({
        v: 2,
        byPpid: { '6009': { agyPid: null, bypass: false, cliMode: '', updatedAtMs: 1_000 } },
        byAgyPid: {},
      }),
      'utf8',
    );
    const alive = new Set<number>([5555, 6009]);
    const info = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6009,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: () => null,
      isAlive: (p) => alive.has(p),
    });
    assert.equal(info.agyPid, 5555);
  });

  void it('skips Windows PowerShell walk when proc lock path is an untrusted symlink', () => {
    if (process.platform === 'win32') return;
    let psCalls = 0;
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const target = path.join(tmpRoot, 'outside.lock');
    writeFileSync(target, 'x', 'utf8');
    symlinkSync(target, path.join(cacheDir, '.agy_hud_proc.lock'));

    const info = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6010,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: () => {
        psCalls += 1;
        return null;
      },
      isAlive: (p) => p === 5555 || p === 6010,
    });
    assert.deepEqual(info, { agyPid: 5555, bypass: false, cliMode: '' });
    assert.equal(psCalls, 0);
  });

  void it('serializes concurrent Windows PowerShell probe so same knownLiveAgyPid walks at most once', () => {
    let psCalls = 0;
    const alive = new Set<number>([5555, 6011, 6012]);
    let concurrentResult: ReturnType<typeof detectAgyProcess> | null = null;

    const readWin32 = (): AncestorProcSample[] => {
      psCalls += 1;
      if (psCalls === 1) {
        concurrentResult = detectAgyProcess(cliHome, {
          platform: 'win32',
          startPid: 6012,
          knownLiveAgyPid: 5555,
          readWin32Ancestors: readWin32,
          isAlive: (p) => alive.has(p),
        });
      }
      return [
        { pid: 6011, ppid: 5555, comm: 'cmd.exe', args: 'cmd.exe /c node hud.mjs' },
        { pid: 5555, ppid: 100, comm: 'agy.exe', args: 'agy.exe --mode plan --dangerously-skip-permissions' },
      ];
    };

    const primary = detectAgyProcess(cliHome, {
      platform: 'win32',
      startPid: 6011,
      knownLiveAgyPid: 5555,
      readWin32Ancestors: readWin32,
      isAlive: (p) => alive.has(p),
    });

    assert.equal(psCalls, 1);
    assert.deepEqual(primary, { agyPid: 5555, bypass: true, cliMode: 'plan' });
    assert.deepEqual(concurrentResult, { agyPid: 5555, bypass: false, cliMode: '' });
  });

  void it('skips persisting proc cache when .agy_hud_proc.lock is replaced by a directory', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(path.join(cacheDir, '.agy_hud_proc.lock'), { recursive: true });
    const alive = new Set<number>([2001, 2000]);
    const info = detectAgyProcess(cliHome, {
      platform: 'darwin',
      startPid: 2001,
      isAlive: (p) => alive.has(p),
      readProc: (pid) => {
        if (pid === 2001) return { pid: 2001, ppid: 2000, comm: 'sh', args: 'sh -c hud.mjs' };
        if (pid === 2000) return { pid: 2000, ppid: 1, comm: 'agy', args: 'agy --mode plan' };
        return null;
      },
    });
    assert.deepEqual(info, { agyPid: 2000, bypass: false, cliMode: 'plan' });
    assert.equal(existsSync(path.join(cacheDir, 'agy_hud_proc.json')), false);
  });
});
