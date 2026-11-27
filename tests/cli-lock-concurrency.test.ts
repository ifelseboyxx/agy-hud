import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, it } from 'node:test';

import { loadInteractiveDraftSession } from '../src/cli/configure.ts';
import { importProfile } from '../src/cli/migrate.ts';
import { detectAgyProcess } from '../src/collectors/proc.ts';
import { getCliHomeLockPath, getMcpConfigLockPath } from '../src/core/file-lock.ts';
import { buildPresetConfig } from '../src/core/hud-config.ts';
import { runHudRender } from '../src/hud-runner.ts';
import { materializeSnapshotMarkdownIfNeeded, resolveSnapshotMarkdownUri } from '../src/hud-snapshot-publish.ts';
import {
  createFakeAgyBin,
  createTempDirTracker,
  DIST_CLI,
  INSTALL_SCRIPT,
  makeIsolatedEnv,
  readJson,
  spawnNodeAsync,
  waitForFile,
  writeJson,
} from './helpers.ts';

const tracker = createTempDirTracker();
const makeTempDir = (prefix: string): string => tracker.makeTempDir(prefix);

afterEach(() => {
  tracker.cleanup();
});

void describe('CLI configure and import-profile cliHomeLock isolation', async () => {
  await it('blocks import-profile on cliHomeLock during failing install --wire-statusline so rolled-back statusLine is never resurrected', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-cli-import-lock-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const inDir = path.join(root, 'profile-in');
    const priorSl = { type: 'command', command: '/prior/user-statusline.py', enabled: true };
    writeJson(settingsPath, { model: 'Old Model', statusLine: priorSl });
    writeJson(path.join(inDir, 'settings.template.json'), { model: 'Imported Model' });
    writeJson(path.join(inDir, 'hud-config.json'), { preset: 'compact', segments: { cost: false } });

    const enteredFlag = path.join(root, 'inst-doc.flag');
    const releaseFlag = path.join(root, 'inst-release.flag');
    const binFail = createFakeAgyBin(
      root,
      'inst-fail-import',
      `  echo "entered" > ${JSON.stringify(enteredFlag)}
  while [ ! -f ${JSON.stringify(releaseFlag)} ]; do sleep 0.02; done
  echo "doctor fail" >&2
  exit 1`,
    );
    const envInstall = makeIsolatedEnv(root, { PATH: `${binFail}${path.delimiter}${process.env.PATH ?? ''}` });
    const envCli = makeIsolatedEnv(root);

    // install --wire-statusline writes temporary statusLine pointing to targetDir, then pauses in failing doctor.
    const procInstall = spawnNodeAsync(
      [INSTALL_SCRIPT, 'install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      envInstall,
    );
    await waitForFile(enteredFlag, procInstall);

    let importSettled = false;
    const procImport = spawnNodeAsync([DIST_CLI, 'import-profile', '--in', inDir], envCli).then((res) => {
      importSettled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(importSettled, false, 'import-profile must wait on cliHomeLock while install holds it');

    writeFileSync(releaseFlag, 'go', 'utf8');
    const [resInstall, resImport] = await Promise.all([procInstall, procImport]);
    assert.notEqual(resInstall.status, 0);
    assert.equal(resImport.status, 0, resImport.stderr);

    const finalSettings = readJson(settingsPath);
    assert.equal(finalSettings.model, 'Imported Model');
    assert.deepEqual(
      finalSettings.statusLine,
      priorSl,
      'import-profile must see rolled-back statusLine and never resurrect failed install statusLine',
    );
  });

  await it('blocks configure write mode on cliHomeLock until concurrent install releases the lock', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-cli-cfg-lock-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const hudConfigPath = path.join(cliHome, 'hud-config.json');
    writeJson(path.join(cliHome, 'settings.json'), { model: 'Gemini 4 Carbon' });

    const enteredFlag = path.join(root, 'cfg-doc.flag');
    const releaseFlag = path.join(root, 'cfg-release.flag');
    const binOk = createFakeAgyBin(
      root,
      'inst-ok-cfg',
      `  echo "entered" > ${JSON.stringify(enteredFlag)}
  while [ ! -f ${JSON.stringify(releaseFlag)} ]; do sleep 0.02; done
  exit 0`,
    );
    const envInstall = makeIsolatedEnv(root, { PATH: `${binOk}${path.delimiter}${process.env.PATH ?? ''}` });
    const envCli = makeIsolatedEnv(root);

    const procInstall = spawnNodeAsync(
      [INSTALL_SCRIPT, 'install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      envInstall,
    );
    await waitForFile(enteredFlag, procInstall);

    let cfgSettled = false;
    const procCfg = spawnNodeAsync(
      [DIST_CLI, 'configure', '--preset', 'compact', '--set', 'segments.cost=false'],
      envCli,
    ).then((res) => {
      cfgSettled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(cfgSettled, false, 'configure must wait on cliHomeLock while install holds it');

    // Causal state barrier: write custom maxAgentChips and osc8Links while cliHomeLock is held, right before releasing install.
    // configure can only preserve them across --preset compact if it read hud-config.json AFTER cliHomeLock was released.
    writeJson(hudConfigPath, { preset: 'minimal', maxAgentChips: 5, osc8Links: false });
    writeFileSync(releaseFlag, 'go', 'utf8');
    const [resInstall, resCfg] = await Promise.all([procInstall, procCfg]);
    assert.equal(resInstall.status, 0, resInstall.stderr);
    assert.equal(resCfg.status, 0, resCfg.stderr);

    const persisted = readJson(hudConfigPath);
    assert.equal(persisted.preset, 'compact');
    assert.equal((persisted.segments as Record<string, unknown>).cost, false);
    assert.equal(persisted.maxAgentChips, 5, 'configure must merge against post-lock hud-config.json state');
    assert.equal(persisted.osc8Links, false, 'configure must preserve post-lock osc8Links across preset switch');
  });

  await it('fails upfront on invalid hud-config preset without creating missing cliHome', () => {
    const root = makeTempDir('agy-hud-imp-precheck-');
    const inDir = path.join(root, 'bad-bundle');
    const cliHome = path.join(root, 'fresh-cli-home');
    const geminiRoot = path.join(root, 'fresh-gemini');
    writeJson(path.join(inDir, 'hud-config.json'), { preset: 'invalid-preset' });

    assert.throws(() => importProfile({ inDir, cliHome, geminiRoot }), /Invalid 'preset'/);
    assert.equal(existsSync(cliHome), false, 'failed upfront validation must not create empty cliHome directory');
  });

  await it('blocks MCP-only import-profile --merge-mcp on MCP lock and preserves concurrent servers', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-mcp-lock-');
    const inDir = path.join(root, 'mcp-bundle');
    const geminiRoot = path.join(root, '.gemini');
    const mcpPath = path.join(geminiRoot, 'config', 'mcp_config.json');
    writeJson(mcpPath, { mcpServers: { initial: { command: 'node' } } });
    writeJson(path.join(inDir, 'mcp_config.template.json'), { mcpServers: { incoming: { command: 'npx' } } });

    const env = makeIsolatedEnv(root);
    const mcpLock = getMcpConfigLockPath(geminiRoot);
    const lockEntered = path.join(root, 'mcp-lock-entered.flag');
    const lockRelease = path.join(root, 'mcp-lock-release.flag');

    const holderCode = `import { existsSync, writeFileSync } from 'node:fs';
import { withFileLocksSync } from './src/core/file-lock.ts';
const cell = new Int32Array(new SharedArrayBuffer(4));
withFileLocksSync([${JSON.stringify(mcpLock)}], () => {
  writeFileSync(${JSON.stringify(lockEntered)}, 'held', 'utf8');
  while (!existsSync(${JSON.stringify(lockRelease)})) Atomics.wait(cell, 0, 0, 20);
  writeFileSync(${JSON.stringify(mcpPath)}, JSON.stringify({ mcpServers: { initial: { command: 'node' }, concurrent: { command: 'uvx' } } }, null, 2) + '\\n', 'utf8');
}, 10_000);
`;
    const procHolder = spawnNodeAsync(['--input-type=module', '-e', holderCode], env);
    await waitForFile(lockEntered, procHolder);

    let mcpImportSettled = false;
    const procImport = spawnNodeAsync([DIST_CLI, 'import-profile', '--in', inDir, '--merge-mcp'], env).then((res) => {
      mcpImportSettled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(mcpImportSettled, false, 'MCP-only import-profile must block on MCP lock');

    writeFileSync(lockRelease, 'go', 'utf8');
    const [holderRes, importRes] = await Promise.all([procHolder, procImport]);
    assert.equal(holderRes.status, 0, holderRes.stderr);
    assert.equal(importRes.status, 0, importRes.stderr);

    const mergedServers = readJson(mcpPath).mcpServers as Record<string, unknown>;
    assert.ok(mergedServers.initial);
    assert.ok(
      mergedServers.concurrent,
      'import-profile --merge-mcp must preserve server written before MCP lock release',
    );
    assert.ok(mergedServers.incoming);
  });

  await it('verifies interactive draft expectedVersion inside cliHomeLock after concurrent holder writes', async () => {
    if (process.platform === 'win32') return;

    const root = makeTempDir('agy-hud-draft-lock-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const hudConfigPath = path.join(cliHome, 'hud-config.json');
    const initial = buildPresetConfig('full', { maxAgentChips: 8 });
    writeJson(hudConfigPath, initial);

    const draft = loadInteractiveDraftSession({ cliHome });
    const env = makeIsolatedEnv(root);
    const cliLock = getCliHomeLockPath(cliHome);
    const enteredFlag = path.join(root, 'draft-lock-entered.flag');
    const releaseFlag = path.join(root, 'draft-lock-release.flag');

    const holderCode = `import { existsSync, writeFileSync } from 'node:fs';
import { withFileLocksSync } from './src/core/file-lock.ts';
const cell = new Int32Array(new SharedArrayBuffer(4));
withFileLocksSync([${JSON.stringify(cliLock)}], () => {
  writeFileSync(${JSON.stringify(enteredFlag)}, 'held', 'utf8');
  while (!existsSync(${JSON.stringify(releaseFlag)})) Atomics.wait(cell, 0, 0, 20);
  writeFileSync(${JSON.stringify(hudConfigPath)}, JSON.stringify(${JSON.stringify({ ...initial, maxAgentChips: 3 })}, null, 2) + '\\n', 'utf8');
}, 10_000);
`;
    const procHolder = spawnNodeAsync(['--input-type=module', '-e', holderCode], env);
    await waitForFile(enteredFlag, procHolder);

    let saverSettled = false;
    const saverCode = `import { HudConfigConflictError, writeHudConfigAtomic } from './src/cli/configure.ts';
try {
  writeHudConfigAtomic(${JSON.stringify({ ...draft.config, preset: 'compact' })}, {
    cliHome: ${JSON.stringify(cliHome)},
    expectedVersion: ${JSON.stringify(draft.version)},
  });
  process.exit(0);
} catch (err) {
  if (err instanceof HudConfigConflictError) {
    process.stderr.write('CONFLICT\\n');
    process.exit(2);
  }
  throw err;
}
`;
    const procSaver = spawnNodeAsync(['--input-type=module', '-e', saverCode], env).then((res) => {
      saverSettled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(saverSettled, false, 'interactive draft save must wait on cliHomeLock');

    writeFileSync(releaseFlag, 'go', 'utf8');
    const [holderRes, saverRes] = await Promise.all([procHolder, procSaver]);
    assert.equal(holderRes.status, 0, holderRes.stderr);
    assert.equal(saverRes.status, 2, `expected conflict exit 2, got ${saverRes.status}: ${saverRes.stderr}`);
    assert.equal(readJson(hudConfigPath).maxAgentChips, 3, 'concurrent write inside lock must be preserved');
  });

  await it('returns promptly from detectAgyProcess when proc cache lock is held by a live PID', () => {
    const root = makeTempDir('agy-hud-proc-lock-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const lockPath = path.join(cacheDir, '.agy_hud_proc.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: 'live-held', lockPath })}\n`, 'utf8');

    const start = performance.now();
    detectAgyProcess(cliHome, {
      startPid: process.pid,
      platform: 'linux',
      isAlive: () => true,
      readProc: () => null,
    });
    const elapsedMs = performance.now() - start;
    const procLimitMs = process.env.CI ? 350 : 100;
    assert.ok(
      elapsedMs < procLimitMs,
      `expected contended detectAgyProcess < ${procLimitMs}ms, got ${elapsedMs.toFixed(1)}ms`,
    );
  });

  await it('returns HUD output promptly when snapshot and PID locks are held by a live PID', () => {
    const root = makeTempDir('agy-hud-hotpath-lock-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const convId = 'hotpath-contended-1111';
    const agyPid = 4242;
    for (const lockName of [`.agy_hud_snapshot_${convId}.lock`, `.agy_hud_pid_${agyPid}.lock`]) {
      const lockPath = path.join(cacheDir, lockName);
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: 'live-held', lockPath })}\n`, 'utf8');
    }

    const start = performance.now();
    const lines = runHudRender(
      cliHome,
      {
        conversation_id: convId,
        conversation_title: 'Contended HUD',
        cwd: root,
        model: { display_name: 'Gemini 4 Carbon' },
      },
      {
        agyPid,
        bypass: false,
        cliMode: '',
        branch: 'main',
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
        activity: {
          tools: [{ name: 'read_file', disp: 'read_file', target: 'a.ts', running: false, isSkillRead: false }],
          skills: [],
          mcps: [],
          agents: [],
        },
        agentsSummary: { kind: 'agents', working: 0, waiting: 0, alive: 0, total: 0, entries: [] },
        todos: null,
        hudConfig: { preset: 'compact', osc8Links: true, lines: ['identity', 'activity'] },
        env: { TERM: 'xterm-256color' },
      },
    );
    const elapsedMs = performance.now() - start;

    assert.ok(lines.length >= 2, 'HUD must still render valid lines under lock contention');
    const hotPathLimitMs = process.env.CI ? 400 : 120;
    assert.ok(
      elapsedMs < hotPathLimitMs,
      `expected contended HUD hot path < ${hotPathLimitMs}ms, got ${elapsedMs.toFixed(1)}ms`,
    );
  });

  await it('flattens snapshot and PID locks so contended PID lock fails fast without partial Markdown write', () => {
    const root = makeTempDir('agy-hud-flat-lock-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });

    const convId = 'flat-lock-2222';
    const agyPid = 5252;
    const pidLockPath = path.join(cacheDir, `.agy_hud_pid_${agyPid}.lock`);
    writeFileSync(
      pidLockPath,
      `${JSON.stringify({ pid: process.pid, token: 'live-held', lockPath: pidLockPath })}\n`,
      'utf8',
    );
    const target = resolveSnapshotMarkdownUri(cliHome, convId);
    assert.ok(target !== null);

    const start = performance.now();
    const res = materializeSnapshotMarkdownIfNeeded({
      cliHome,
      convId,
      target,
      emittedOsc8Count: 1,
      data: { conversation_id: convId, conversation_title: 'Flat Lock', cwd: root },
      agyPid,
      existingEnvelope: null,
      transcriptStat: { ino: 1, mtimeMs: 100, size: 10 },
      activity: null,
      agentsSummary: null,
      nowMs: Date.parse('2026-06-01T12:00:00Z'),
    });
    const elapsedMs = performance.now() - start;

    assert.equal(res.written, false);
    assert.equal(existsSync(target.absPath), false, 'contended PID lock must abort before writing partial .md');
    const flatLockLimitMs = process.env.CI ? 400 : 120;
    assert.ok(
      elapsedMs < flatLockLimitMs,
      `expected flattened lock timeout < ${flatLockLimitMs}ms, got ${elapsedMs.toFixed(1)}ms`,
    );
  });
});
