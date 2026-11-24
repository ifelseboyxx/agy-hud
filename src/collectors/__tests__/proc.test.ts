import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  detectAgyFlags,
  detectAgyProcess,
  findAncestorAgyPid,
  parseLinuxProcStat,
  type AncestorProcSample,
} from '../proc.ts';

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

  void it('upgrades legacy single-slot agy_hud_proc.json safely via detectAgyFlags', () => {
    mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
    writeFileSync(
      path.join(cliHome, 'cache', 'agy_hud_proc.json'),
      JSON.stringify({ ppid: 999, bypass: true, cliMode: 'plan' }),
      'utf8',
    );
    const flags = detectAgyFlags(cliHome);
    assert.equal(typeof flags.bypass, 'boolean');
    assert.equal(typeof flags.cliMode, 'string');
  });
});
