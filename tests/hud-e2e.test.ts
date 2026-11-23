import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createTempDirTracker,
  DIST_CLI,
  DIST_HUD,
  DIST_INDEX,
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
    assert.equal(shown.showCost, false);
    assert.equal(shown.maxAgentChips, 3);

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
    assert.equal(mod.DEFAULT_HUD_CONFIG.preset, 'full');

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
});
