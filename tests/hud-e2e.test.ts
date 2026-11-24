import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createTempDirTracker,
  DIST_CLI,
  DIST_HUD,
  DIST_INDEX,
  DIST_MCP_HUD,
  INSTALL_SCRIPT,
  makeIsolatedEnv,
  readJson,
  REPO_ROOT,
  runNodeScript,
  writeJson,
} from './helpers.ts';

const tracker = createTempDirTracker();
const makeTempDir = (prefix: string): string => tracker.makeTempDir(prefix);

afterEach(() => {
  tracker.cleanup();
});

void describe('agy-hud built artifacts e2e', async () => {
  await it('renders HUD via built dist/hud.mjs and handles malformed/empty stdin safely', () => {
    const root = makeTempDir('agy-hud-e2e-hud-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const env = makeIsolatedEnv(root);

    writeJson(path.join(cliHome, 'settings.json'), {
      orchestrator: {
        planner: 'Gemini 4 Carbon (High)',
        executor: 'Gemini 4 Hydrogen (Medium)',
      },
    });
    writeJson(path.join(cliHome, 'hud-config.json'), { preset: 'full' });

    const payload = JSON.stringify({
      cwd: REPO_ROOT,
      session_id: 'e2e-session-1',
      model: { id: 'orchestrator-neon', display_name: 'Orchestrator (Neon)' },
      workspace: { current_dir: REPO_ROOT },
      context_window: { used_percentage: 42, context_window_size: 1_000_000 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.85, reset_in_seconds: 3600 },
      },
      terminal_width: 120,
    });

    const okRes = runNodeScript(DIST_HUD, [], env, payload);
    assert.equal(okRes.status, 0, okRes.stderr);
    assert.ok(okRes.stdout.trim().length > 0);
    assert.ok(okRes.stdout.includes('Orchestrator (Carbon/Hydrogen)'));
    assert.ok(okRes.stdout.includes('42%'));

    const emptyRes = runNodeScript(DIST_HUD, [], env, '');
    assert.equal(emptyRes.status, 0);
    assert.equal(emptyRes.stdout, '');

    const badJsonRes = runNodeScript(DIST_HUD, [], env, '{broken-json');
    assert.equal(badJsonRes.status, 0);
    assert.equal(badJsonRes.stdout, '');
  });

  await it('configures, exports, and imports profiles via built dist/cli.mjs', () => {
    const srcRoot = makeTempDir('agy-hud-e2e-src-');
    const dstRoot = makeTempDir('agy-hud-e2e-dst-');
    const bundleDir = path.join(makeTempDir('agy-hud-e2e-bundle-'), 'profile');

    const srcGeminiRoot = path.join(srcRoot, '.gemini');
    const srcCliHome = path.join(srcGeminiRoot, 'antigravity-cli');
    const srcEnv = makeIsolatedEnv(srcRoot);

    writeJson(path.join(srcCliHome, 'settings.json'), {
      model: 'Gemini 4 Hydrogen',
      orchestrator: { planner: 'Gemini 4 Carbon' },
      trustedWorkspaces: ['/private/source/workspace'],
    });
    writeJson(path.join(srcGeminiRoot, 'config', 'config.json'), {
      plugins: { 'agy-hud': { enabled: true } },
      sidecars: { 'swarm/swarm_board': { projectId: 'src-project-uuid', schemaVersion: 1 } },
      userSettings: { themeMode: 'THEME_MODE_DARK', remoteControlHostname: 'src-host' },
    });
    writeJson(path.join(srcGeminiRoot, 'config', 'mcp_config.json'), {
      mcpServers: {
        sample: { command: 'npx', env: { API_TOKEN: 'secret-src-token', MODE: 'fast' } },
      },
    });
    writeJson(path.join(srcGeminiRoot, 'config', 'plugins', 'agy-hud', 'plugin.json'), {
      name: 'agy-hud',
      version: '0.1.0',
      repository: 'https://github.com/example/agy-hud',
    });

    const cfgSet = runNodeScript(
      DIST_CLI,
      ['configure', '--preset', 'compact', '--set', 'showCost=false', '--set', 'maxAgentChips=3'],
      srcEnv,
    );
    assert.equal(cfgSet.status, 0, cfgSet.stderr);

    const cfgShow = runNodeScript(DIST_CLI, ['configure', '--show'], srcEnv);
    assert.equal(cfgShow.status, 0, cfgShow.stderr);
    const shown = JSON.parse(cfgShow.stdout) as Record<string, unknown>;
    assert.equal(shown.preset, 'compact');
    assert.equal((shown.segments as Record<string, unknown>).cost, false);
    assert.equal(shown.maxAgentChips, 3);
    assert.deepEqual(shown.lines, ['mode', 'identity', 'usage', 'activity']);

    const zenSet = runNodeScript(
      DIST_CLI,
      ['configure', 'zen', '--enable', 'tools', '--order', 'identity,tools', '--set', 'osc8Links=false', '--json'],
      srcEnv,
    );
    assert.equal(zenSet.status, 0, zenSet.stderr);
    const zenJson = JSON.parse(zenSet.stdout) as Record<string, unknown>;
    assert.equal(zenJson.preset, 'zen');
    assert.equal(zenJson.maxAgentChips, 3);
    assert.equal(zenJson.osc8Links, false);
    assert.deepEqual(zenJson.lines, ['identity', 'tools']);

    const restoreCompact = runNodeScript(
      DIST_CLI,
      ['configure', 'compact', '--set', 'showCost=false', '--set', 'maxAgentChips=3', '--set', 'osc8Links=true'],
      srcEnv,
    );
    assert.equal(restoreCompact.status, 0, restoreCompact.stderr);

    const badCfg = runNodeScript(DIST_CLI, ['configure', '--set', 'badKey=true'], srcEnv);
    assert.notEqual(badCfg.status, 0);
    assert.ok(badCfg.stderr.includes('Unknown configuration key'));

    const expRes = runNodeScript(DIST_CLI, ['export-profile', '--out', bundleDir], srcEnv);
    assert.equal(expRes.status, 0, expRes.stderr);
    assert.equal(readJson(path.join(bundleDir, 'settings.template.json')).trustedWorkspaces, undefined);

    const dstGeminiRoot = path.join(dstRoot, '.gemini');
    const dstCliHome = path.join(dstGeminiRoot, 'antigravity-cli');
    const dstEnv = makeIsolatedEnv(dstRoot);
    const dstConfigPath = path.join(dstGeminiRoot, 'config', 'config.json');
    const dstConfigBefore = { userSettings: { remoteControlHostname: 'dst-host' } };
    writeJson(dstConfigPath, dstConfigBefore);
    writeJson(path.join(dstCliHome, 'settings.json'), { trustedWorkspaces: ['/target/trusted/repo'] });
    writeJson(path.join(dstGeminiRoot, 'config', 'mcp_config.json'), {
      mcpServers: { existing: { command: 'node', env: { SECRET: 'keep-local' } } },
    });

    const impRes = runNodeScript(DIST_CLI, ['import-profile', '--in', bundleDir, '--merge-mcp'], dstEnv);
    assert.equal(impRes.status, 0, impRes.stderr);
    assert.ok(impRes.stdout.includes('customization://agy-hud'));
    assert.ok(impRes.stdout.includes('agy plugin install'));
    assert.deepEqual(readJson(path.join(dstCliHome, 'settings.json')).trustedWorkspaces, ['/target/trusted/repo']);
    assert.deepEqual(readJson(dstConfigPath), dstConfigBefore);
    const mergedMcp = readJson(path.join(dstGeminiRoot, 'config', 'mcp_config.json'));
    const servers = mergedMcp.mcpServers as Record<string, Record<string, Record<string, string>>>;
    assert.equal(servers.existing?.env?.SECRET, 'keep-local');
    assert.equal(servers.sample?.env?.API_TOKEN, '<SET_IN_ENV>');
  });

  await it('installs to --target with --wire-statusline, passes doctor, and restores on uninstall', () => {
    const root = makeTempDir('agy-hud-e2e-inst-');
    const targetDir = path.join(root, 'installed-plugin');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const priorStatusLine = { type: 'command', command: '/prior/statusline.py', enabled: true };
    writeJson(settingsPath, { statusLine: priorStatusLine });
    const env = makeIsolatedEnv(root);

    const installRes = runNodeScript(
      INSTALL_SCRIPT,
      ['install', '--target', targetDir, '--no-enable', '--wire-statusline', '--quiet'],
      env,
    );
    assert.equal(installRes.status, 0, installRes.stderr);
    assert.equal(existsSync(path.join(targetDir, 'dist', 'hud.mjs')), true);
    assert.equal(existsSync(path.join(targetDir, 'dist', 'cli.mjs')), true);
    assert.equal(existsSync(path.join(targetDir, 'dist', 'mcp-hud.mjs')), true);
    assert.equal(existsSync(path.join(targetDir, 'mcp_config.json')), true);
    const stagedMcp = readJson(path.join(targetDir, 'mcp_config.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(stagedMcp.mcpServers.inspector, {
      command: 'node',
      args: ['${PLUGIN_ROOT}/dist/mcp-hud.mjs'],
    });
    const agyProbe = spawnSync('agy', ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    if (!agyProbe.error && agyProbe.status === 0) {
      const validateRes = spawnSync('agy', ['plugin', 'validate', targetDir, '--strict'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(validateRes.status, 0, `${validateRes.stdout}\n${validateRes.stderr}`);
    }
    assert.equal(
      (readJson(settingsPath).statusLine as Record<string, unknown>).command,
      path.join(targetDir, 'dist', 'hud.mjs'),
    );

    const doctorRes = runNodeScript(INSTALL_SCRIPT, ['doctor', '--target', targetDir], env);
    assert.equal(doctorRes.status, 0, doctorRes.stderr);
    assert.ok(doctorRes.stdout.includes('wired to agy-hud'));

    const uninstallRes = runNodeScript(
      INSTALL_SCRIPT,
      ['uninstall', '--target', targetDir, '--no-enable', '--restore-statusline', '--quiet'],
      env,
    );
    assert.equal(uninstallRes.status, 0, uninstallRes.stderr);
    assert.equal(existsSync(targetDir), false);
    assert.deepEqual(readJson(settingsPath).statusLine, priorStatusLine);
  });

  await it('exposes typed library API via built dist/index.mjs', async () => {
    const mod = (await import(pathToFileURL(DIST_INDEX).href)) as {
      renderHudFromData: (data: Record<string, unknown>, options?: Record<string, unknown>) => string;
      configureHud: unknown;
      exportProfile: unknown;
      importProfile: unknown;
      DEFAULT_HUD_CONFIG: Record<string, unknown>;
    };
    assert.equal(typeof mod.renderHudFromData, 'function');
    assert.equal(typeof mod.configureHud, 'function');
    assert.equal(typeof mod.exportProfile, 'function');
    assert.equal(typeof mod.importProfile, 'function');
    assert.equal(mod.DEFAULT_HUD_CONFIG.preset, 'compact');

    const root = makeTempDir('agy-hud-e2e-lib-');
    const rendered = mod.renderHudFromData(
      {
        cwd: REPO_ROOT,
        model: { display_name: 'Gemini 4 Carbon', effort: 'high' },
        context_window: { used_percentage: 15, context_window_size: 1_000_000 },
        terminal_width: 100,
      },
      { cliHome: path.join(root, '.gemini', 'antigravity-cli') },
    );
    assert.ok(rendered.includes('G4 Carbon'));
  });

  await it('runs built dist/mcp-hud.mjs over stdio JSON-RPC with app-only entrypoints, CSP HTML, and ETag polling', () => {
    const root = makeTempDir('agy-hud-e2e-mcp-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');
    const convId = 'e2e-mcp-session-01';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'Gemini 4 Carbon',
        created_at: '2026-06-01T11:58:00Z',
        tool_calls: [{ name: 'read_file', args: { Path: path.join(root, 'README.md') } }],
      })}\n`,
      'utf8',
    );
    const env = makeIsolatedEnv(root);

    const firstPassInput = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'ui://agy-hud/inspector.html' },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'hud_inspector', arguments: {} },
      }),
    ].join('\n');

    const res1 = runNodeScript(DIST_MCP_HUD, [], env, `${firstPassInput}\n`);
    assert.equal(res1.status, 0, res1.stderr);
    assert.equal(res1.stderr, '');
    const replies1 = res1.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    assert.equal(replies1.length, 4);

    const listedTools = replies1[1]?.result.tools as Array<Record<string, unknown>>;
    assert.deepEqual(
      listedTools.map((t) => t.name),
      ['hud_inspector', 'hud_poll_snapshot'],
    );
    const inspectorMeta = listedTools[0]?._meta as Record<string, unknown> | undefined;
    assert.deepEqual(inspectorMeta?.ui, {
      resourceUri: 'ui://agy-hud/inspector.html',
      visibility: ['app'],
    });

    const contents = replies1[2]?.result.contents as Array<{ mimeType: string; text: string }> | undefined;
    const htmlDoc = contents?.[0];
    assert.equal(htmlDoc?.mimeType, 'text/html;profile=mcp-app');
    assert.ok(htmlDoc?.text.startsWith('<!DOCTYPE html>'));
    assert.equal(/https?:\/\//i.test(htmlDoc?.text ?? ''), false);

    const callResult = replies1[3]?.result as {
      content: Array<{ text: string }>;
      structuredContent: { etag: string; snapshot: { convId: string } };
    };
    assert.ok(callResult.content[0]?.text.includes('e2e-mcp-'));
    assert.equal(callResult.structuredContent.snapshot.convId, convId);

    const etag = callResult.structuredContent.etag;
    const pollInput = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'hud_poll_snapshot', arguments: { sessionId: convId, etag } },
    })}\n`;
    const res2 = runNodeScript(DIST_MCP_HUD, [], env, pollInput);
    assert.equal(res2.status, 0, res2.stderr);
    const pollReply = JSON.parse(res2.stdout.trim()) as {
      result: { structuredContent: { unchanged: boolean; etag: string } };
    };
    assert.deepEqual(pollReply.result.structuredContent, { unchanged: true, etag });
  });

  await it('degrades built dist/cli.mjs -p to one-shot Structured Inspector when piped', () => {
    const root = makeTempDir('agy-hud-e2e-snap-');
    const env = makeIsolatedEnv(root);
    const cacheDir = path.join(root, '.gemini', 'antigravity-cli', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeJson(path.join(cacheDir, 'agy_hud_snapshot_e2e-11112222.json'), {
      v: 1,
      convId: 'e2e-11112222',
      conversationTitle: 'Built CLI Inspector',
      agyPid: process.pid,
      cwd: root,
      workspaceCurrentDir: root,
      workspaceProjectDir: root,
      subagents: [],
      taskCount: null,
      mdDigest: null,
      updatedAtMs: Date.now(),
    });

    const popupRes = runNodeScript(DIST_CLI, ['-p', '--no-color'], env);
    assert.equal(popupRes.status, 0, popupRes.stderr);
    assert.equal(popupRes.stdout.includes('\x1b[?1049h'), false);
    assert.ok(popupRes.stdout.includes('[CLI] Activity Snapshot'));
    assert.ok(popupRes.stdout.includes('Built CLI Inspector'));
  });

  await it('prints all five terminal templates from built dist/cli.mjs --keybindings all', () => {
    const root = makeTempDir('agy-hud-e2e-kb-');
    const env = makeIsolatedEnv(root);
    const kbRes = runNodeScript(DIST_CLI, ['--keybindings', 'all', '--no-color'], env);
    assert.equal(kbRes.status, 0, kbRes.stderr);
    assert.ok(kbRes.stdout.includes('display-popup'));
    assert.ok(kbRes.stdout.includes('launch --type=overlay --cwd=current'));
    assert.ok(kbRes.stdout.includes('wezterm.action.SplitPane'));
    assert.ok(kbRes.stdout.includes('text:!agy-hud\\n'));
    assert.ok(kbRes.stdout.includes('Hotkey Window'));
  });
});
