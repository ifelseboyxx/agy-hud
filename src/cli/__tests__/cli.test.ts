import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCliEntry } from '../../cli-entry.ts';
import { DEFAULT_HUD_CONFIG } from '../../types.ts';
import { configureHud, parseConfigureArgs } from '../configure.ts';
import { exportProfile, importProfile } from '../migrate.ts';

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

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

void describe('configureHud', async () => {
  await it('returns defaults on --show when hud-config.json does not exist', () => {
    const root = makeTempDir('agy-hud-cfg-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');

    const result = configureHud({ cliHome, show: true });
    assert.equal(result.action, 'show');
    assert.equal(result.changed, false);
    assert.deepEqual(result.config, DEFAULT_HUD_CONFIG);
    assert.equal(existsSync(result.configPath), false);
  });

  await it('applies preset, valid --set keys, and --reset strictly', () => {
    const root = makeTempDir('agy-hud-cfg-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');

    const updated = configureHud({
      cliHome,
      preset: 'compact',
      sets: ['showCost=false', 'showQuota=false', 'maxAgentChips=8'],
    });
    assert.equal(updated.changed, true);
    assert.equal(updated.config.preset, 'compact');
    assert.equal(updated.config.segments.cost, false);
    assert.equal(updated.config.segments.quota, false);
    assert.equal(updated.config.maxAgentChips, 8);

    const persisted = readJson(path.join(cliHome, 'hud-config.json'));
    assert.equal(persisted.preset, 'compact');
    assert.equal(persisted.maxAgentChips, 8);

    const reset = configureHud({ cliHome, reset: true });
    assert.equal(reset.action, 'reset');
    assert.deepEqual(reset.config, DEFAULT_HUD_CONFIG);
  });

  await it('rejects invalid keys, booleans, numbers, presets, and unknown CLI flags', () => {
    const root = makeTempDir('agy-hud-cfg-');
    const cliHome = path.join(root, '.gemini', 'antigravity-cli');

    assert.throws(() => configureHud({ cliHome, sets: ['unknownKey=true'] }), /Unknown configuration key/);
    assert.throws(() => configureHud({ cliHome, sets: ['showCost=yes'] }), /Invalid boolean value/);
    assert.throws(() => configureHud({ cliHome, sets: ['maxAgentChips=-1'] }), /Invalid integer value/);
    assert.throws(() => configureHud({ cliHome, sets: ['maxAgentChips=99'] }), /Out-of-range value/);
    assert.throws(() => configureHud({ cliHome, sets: ['preset=ultra'] }), /Invalid preset/);
    assert.throws(() => configureHud({ cliHome, sets: ['__proto__=true'] }), /Unknown configuration key/);
    assert.throws(() => parseConfigureArgs(['--bogus']), /Unknown configure option/);
  });
});

void describe('exportProfile and importProfile', async () => {
  await it('exports sanitized templates, redacts secrets, records plugins, and excludes sensitive state', () => {
    const root = makeTempDir('agy-hud-exp-');
    const geminiRoot = path.join(root, '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    const outDir = path.join(root, 'bundle');

    writeJson(path.join(cliHome, 'settings.json'), {
      model: 'Gemini 4 Hydrogen',
      orchestrator: { planner: 'Gemini 4 Carbon' },
      trustedWorkspaces: ['/Users/alice/secret-repo'],
    });
    writeJson(path.join(cliHome, 'hud-config.json'), {
      ...DEFAULT_HUD_CONFIG,
      preset: 'compact',
      segments: { ...DEFAULT_HUD_CONFIG.segments, cost: false },
    });
    writeJson(path.join(geminiRoot, 'config', 'config.json'), {
      plugins: {
        'sample-plugin': { enabled: true },
        'chrome-devtools-plugin': {
          enabled: true,
          installedFrom: { id: 'antigravity-plugins-official/plugin/chrome-devtools-plugin', version: '1.10.1' },
        },
      },
      sidecars: {
        'swarm/swarm_board': { projectId: 'machine-uuid-123', schemaVersion: 1 },
      },
      userSettings: {
        themeMode: 'THEME_MODE_DARK',
        remoteControlHostname: 'alice-macbook-local',
      },
    });
    writeJson(path.join(geminiRoot, 'config', 'mcp_config.json'), {
      mcpServers: {
        demo: {
          command: 'npx',
          env: {
            GITHUB_TOKEN: 'ghp_secret_value',
            OPENAI_API_KEY: 'sk-secret',
            LOG_LEVEL: 'info',
          },
          headers: {
            Authorization: 'Bearer super-secret-jwt',
            'X-Custom-Header': 'plain-value',
          },
        },
      },
    });
    writeJson(path.join(geminiRoot, 'config', 'plugins', 'sample-plugin', 'plugin.json'), {
      name: 'sample-plugin',
      version: '0.2.8',
      repository: 'https://github.com/example/sample-plugin',
    });

    writeJson(path.join(cliHome, 'oauth_creds.json'), { access_token: 'secret' });
    writeJson(path.join(cliHome, 'google_accounts.json'), { active: 'alice@example.com' });
    writeJson(path.join(cliHome, 'mcp_oauth_tokens.json'), { token: 'secret' });
    writeFileSync(path.join(cliHome, 'installation_id'), 'install-uuid', 'utf8');
    writeJson(path.join(cliHome, 'conversations', 'conv1.json'), { title: 'private' });
    writeJson(path.join(cliHome, 'brain', 'conv1', 'task.md'), { text: 'private' });

    const res = exportProfile({ outDir, cliHome, geminiRoot });
    assert.equal(res.pluginCount, 1);

    const settingsTpl = readJson(path.join(outDir, 'settings.template.json'));
    assert.equal(settingsTpl.trustedWorkspaces, undefined);
    assert.equal(settingsTpl.model, 'Gemini 4 Hydrogen');

    const configTpl = readJson(path.join(outDir, 'config.template.json'));
    const userSettings = configTpl.userSettings as Record<string, unknown>;
    const sidecars = configTpl.sidecars as Record<string, Record<string, unknown>>;
    assert.equal(userSettings.remoteControlHostname, undefined);
    assert.equal(userSettings.themeMode, 'THEME_MODE_DARK');
    assert.equal(sidecars['swarm/swarm_board']?.projectId, undefined);
    assert.equal(sidecars['swarm/swarm_board']?.schemaVersion, 1);

    const mcpTpl = readJson(path.join(outDir, 'mcp_config.template.json'));
    const demoServer = (mcpTpl.mcpServers as Record<string, Record<string, Record<string, string>>>).demo;
    assert.equal(demoServer?.env?.GITHUB_TOKEN, '<SET_IN_ENV>');
    assert.equal(demoServer?.env?.OPENAI_API_KEY, '<SET_IN_ENV>');
    assert.equal(demoServer?.env?.LOG_LEVEL, 'info');
    assert.equal(demoServer?.headers?.Authorization, '<SET_IN_ENV>');
    assert.equal(demoServer?.headers?.['X-Custom-Header'], 'plain-value');

    const manifest = readJson(path.join(outDir, 'plugins-manifest.json'));
    const plugins = manifest.plugins as Array<Record<string, unknown>>;
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.dir, 'sample-plugin');
    assert.equal(plugins[0]?.version, '0.2.8');
    assert.equal(plugins[0]?.repo, 'https://github.com/example/sample-plugin');

    for (const forbidden of [
      'oauth_creds.json',
      'google_accounts.json',
      'mcp_oauth_tokens.json',
      'installation_id',
      'conversations',
      'brain',
    ]) {
      assert.equal(existsSync(path.join(outDir, forbidden)), false, `${forbidden} must not be exported`);
    }
  });

  await it('imports templates preserving target trustedWorkspaces, respecting --merge-mcp, and never writing config.json', () => {
    const root = makeTempDir('agy-hud-imp-');
    const inDir = path.join(root, 'bundle');
    const geminiRoot = path.join(root, 'target', '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');

    writeJson(path.join(inDir, 'settings.template.json'), {
      model: 'Gemini 4 Hydrogen',
      orchestrator: { executor: 'Gemini 4 Hydrogen' },
      trustedWorkspaces: ['/foreign/path'],
    });
    writeJson(path.join(inDir, 'hud-config.json'), { preset: 'minimal', showCost: false });
    writeJson(path.join(inDir, 'config.template.json'), { userSettings: { themeMode: 'THEME_MODE_DARK' } });
    writeJson(path.join(inDir, 'mcp_config.template.json'), {
      mcpServers: {
        existingSrv: { command: 'new-cmd', env: { API_KEY: '<SET_IN_ENV>' } },
        addedSrv: { command: 'added-cmd', env: { TOKEN: '<SET_IN_ENV>' } },
      },
    });
    writeJson(path.join(inDir, 'plugins-manifest.json'), {
      exportedAt: '2026-11-22T00:00:00.000Z',
      plugins: [
        {
          dir: 'sample-plugin',
          name: 'sample-plugin',
          version: '0.2.8',
          repo: 'https://github.com/example/sample-plugin',
        },
      ],
    });

    const targetSettingsPath = path.join(cliHome, 'settings.json');
    const targetMcpPath = path.join(geminiRoot, 'config', 'mcp_config.json');
    const targetConfigPath = path.join(geminiRoot, 'config', 'config.json');

    writeJson(targetSettingsPath, {
      orchestrator: { planner: 'Gemini 4 Carbon' },
      trustedWorkspaces: ['/local/work/repo'],
    });
    writeJson(targetMcpPath, {
      mcpServers: {
        existingSrv: { command: 'local-cmd', env: { API_KEY: 'real-local-secret' } },
      },
    });
    const originalConfig = { userSettings: { remoteControlHostname: 'local-host' } };
    writeJson(targetConfigPath, originalConfig);

    const first = importProfile({ inDir, cliHome, geminiRoot, mergeMcp: false });
    assert.equal(first.mcpAction, 'skipped-exists');
    assert.equal(existsSync(path.join(cliHome, 'hud-config.json')), true);

    const mergedSettings = readJson(targetSettingsPath);
    assert.deepEqual(mergedSettings.trustedWorkspaces, ['/local/work/repo']);
    assert.deepEqual(mergedSettings.orchestrator, {
      planner: 'Gemini 4 Carbon',
      executor: 'Gemini 4 Hydrogen',
    });
    assert.deepEqual(readJson(targetConfigPath), originalConfig);
    assert.equal(
      first.pluginInstructions.some(
        (line) => line.includes('customization://sample-plugin') && line.includes('agy plugin install'),
      ),
      true,
    );

    const mcpBeforeMerge = readJson(targetMcpPath);
    assert.equal((mcpBeforeMerge.mcpServers as Record<string, unknown>).addedSrv, undefined);

    const second = importProfile({ inDir, cliHome, geminiRoot, mergeMcp: true });
    assert.equal(second.mcpAction, 'merged');
    const mcpAfterMerge = readJson(targetMcpPath);
    const servers = mcpAfterMerge.mcpServers as Record<string, Record<string, Record<string, string>>>;
    assert.equal(servers.existingSrv?.command, 'local-cmd');
    assert.equal(servers.existingSrv?.env?.API_KEY, 'real-local-secret');
    assert.equal(servers.addedSrv?.command, 'added-cmd');
    assert.deepEqual(readJson(targetConfigPath), originalConfig);
  });

  await it('writes mcp_config.json on import when missing', () => {
    const root = makeTempDir('agy-hud-imp-fresh-');
    const inDir = path.join(root, 'bundle');
    const geminiRoot = path.join(root, 'target', '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');

    writeJson(path.join(inDir, 'mcp_config.template.json'), {
      mcpServers: {
        freshSrv: { command: 'npx', env: { API_KEY: '<SET_IN_ENV>' } },
      },
    });

    const result = importProfile({ inDir, cliHome, geminiRoot });
    assert.equal(result.mcpAction, 'created');
    const written = readJson(path.join(geminiRoot, 'config', 'mcp_config.json'));
    const servers = written.mcpServers as Record<string, Record<string, unknown>>;
    assert.equal(servers.freshSrv?.command, 'npx');
  });

  await it('enforces portable allowlists and strips synthetic credentials across the entire exported bundle', () => {
    const root = makeTempDir('agy-hud-exp-audit-');
    const geminiRoot = path.join(root, '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    const outDir = path.join(root, 'bundle');

    writeJson(path.join(cliHome, 'settings.json'), {
      model: 'Gemini 4 Carbon',
      orchestrator: { planner: 'Gemini 4 Carbon' },
      corpSecret: 'SYNTH_SETTINGS_UNKNOWN_01',
      tools: {
        customApiKey: 'SYNTH_NESTED_KEY_02',
        proxyUrl: 'https://alice:SYNTH_PROXY_PASS_03@proxy.internal:8080/api',
      },
    });
    writeJson(path.join(cliHome, 'hud-config.json'), {
      ...DEFAULT_HUD_CONFIG,
      preset: 'compact',
      secretNote: 'SYNTH_HUD_EXTRA_06',
    });
    writeJson(path.join(geminiRoot, 'config', 'config.json'), {
      authBlob: 'SYNTH_CONFIG_UNKNOWN_04',
      plugins: {
        'private-plugin': {
          enabled: true,
          apiToken: 'SYNTH_PLUGIN_CFG_05',
          installedFrom: { id: 'org/private-plugin', version: '1.0.0' },
        },
      },
      userSettings: { themeMode: 'THEME_MODE_DARK', remoteControlHostname: 'local-host' },
      sidecars: { 'swarm/swarm_board': { projectId: 'uuid-1', schemaVersion: 1 } },
    });
    writeJson(path.join(geminiRoot, 'config', 'mcp_config.json'), {
      privateRegistryToken: 'SYNTH_MCP_TOP_07',
      mcpServers: {
        remote: {
          command: 'npx',
          rawSecret: 'SYNTH_MCP_FIELD_08',
          args: [
            '--token=SYNTH_ARG_EQ_09',
            '--api-key',
            'SYNTH_ARG_NEXT_10',
            '--github-token',
            'SYNTH_COMPOUND_FLAG_20',
            '--header=Authorization: Bearer SYNTH_HEADER_EQ_21',
            'https://u:SYNTH_ARG_URL_11@mcp.example.com?api_key=SYNTH_ARG_QS_12',
            'git://example.com/repo.git?token=SYNTH_GIT_URL_22',
          ],
          url: 'https://bot:SYNTH_URL_USER_13@api.example.com/sse?token=SYNTH_URL_QS_14&mode=sse',
          env: { LOG_LEVEL: 'info', DB_DSN: 'postgres://admin:SYNTH_DSN_19@db.local/app' },
          headers: { Cookie: 'session=SYNTH_COOKIE_15', 'X-Plain': 'ghp_SYNTH_PATTERN_16' },
        },
      },
    });
    writeJson(path.join(geminiRoot, 'config', 'plugins', 'private-plugin', 'plugin.json'), {
      name: 'private-plugin',
      version: '1.0.0',
      repository: 'https://bot:SYNTH_REPO_PASS_17@github.com/org/private-plugin.git?token=SYNTH_REPO_QS_18',
    });

    const exported = exportProfile({ outDir, cliHome, geminiRoot });
    for (const filePath of exported.filesWritten) {
      const content = readFileSync(filePath, 'utf8');
      assert.equal(content.includes('SYNTH_'), false, `synthetic credential leaked in ${path.basename(filePath)}`);
    }

    const settingsTpl = readJson(path.join(outDir, 'settings.template.json'));
    assert.equal(settingsTpl.model, 'Gemini 4 Carbon');
    assert.equal(settingsTpl.corpSecret, undefined);

    const hudTpl = readJson(path.join(outDir, 'hud-config.json'));
    assert.equal(hudTpl.preset, 'compact');
    assert.equal(hudTpl.secretNote, undefined);

    const manifest = readJson(path.join(outDir, 'plugins-manifest.json'));
    const plugins = manifest.plugins as Array<Record<string, unknown>>;
    assert.equal(plugins[0]?.repo, 'https://github.com/org/private-plugin.git');

    const mcpTpl = readJson(path.join(outDir, 'mcp_config.template.json'));
    assert.equal(mcpTpl.privateRegistryToken, undefined);
    const remote = (mcpTpl.mcpServers as Record<string, Record<string, unknown>>).remote;
    assert.equal(remote?.rawSecret, undefined);
    assert.equal((remote?.env as Record<string, unknown>)?.LOG_LEVEL, 'info');
  });

  await it('validates all templates and targets before writing anything during importProfile', () => {
    const root = makeTempDir('agy-hud-imp-atomic-');
    const inDir = path.join(root, 'bundle');
    const geminiRoot = path.join(root, 'target', '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');

    const targetSettingsPath = path.join(cliHome, 'settings.json');
    const targetHudPath = path.join(cliHome, 'hud-config.json');
    const originalSettings = { model: 'Original Local', trustedWorkspaces: ['/safe'] };
    const originalHud = { ...DEFAULT_HUD_CONFIG, preset: 'full' };
    writeJson(targetSettingsPath, originalSettings);
    writeJson(targetHudPath, originalHud);

    writeJson(path.join(inDir, 'settings.template.json'), { model: 'Imported Model' });
    writeJson(path.join(inDir, 'hud-config.json'), { preset: 'minimal' });
    mkdirSync(inDir, { recursive: true });
    writeFileSync(path.join(inDir, 'mcp_config.template.json'), '{invalid-json', 'utf8');

    assert.throws(() => importProfile({ inDir, cliHome, geminiRoot }), /Invalid JSON/);
    assert.deepEqual(
      readJson(targetSettingsPath),
      originalSettings,
      'settings.json must remain untouched when later MCP template fails validation',
    );
    assert.deepEqual(
      readJson(targetHudPath),
      originalHud,
      'hud-config.json must remain untouched when later MCP template fails validation',
    );
  });
});

void describe('runCliEntry', async () => {
  await it('returns 0 on --help and non-zero on unknown commands or missing flags', () => {
    assert.equal(runCliEntry(['--help']), 0);
    assert.equal(runCliEntry(['configure', '--help']), 0);
    assert.equal(runCliEntry(['install', '--help']), 0);
    assert.equal(runCliEntry(['unknown-cmd']), 1);
    assert.equal(runCliEntry(['export-profile']), 1);
    assert.equal(runCliEntry(['import-profile']), 1);
  });
});
