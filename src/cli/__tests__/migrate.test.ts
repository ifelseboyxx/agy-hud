import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DEFAULT_HUD_CONFIG } from '../../core/hud-config.ts';
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

function seedExportFixture(root: string): { geminiRoot: string; cliHome: string; outDir: string } {
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
    sidecars: { 'swarm/swarm_board': { projectId: 'machine-uuid-123', schemaVersion: 1 } },
    userSettings: { themeMode: 'THEME_MODE_DARK', remoteControlHostname: 'alice-macbook-local' },
  });
  writeJson(path.join(geminiRoot, 'config', 'mcp_config.json'), {
    mcpServers: {
      demo: {
        command: 'npx',
        env: { GITHUB_TOKEN: 'ghp_secret_value', OPENAI_API_KEY: 'sk-secret', LOG_LEVEL: 'info' },
        headers: { Authorization: 'Bearer super-secret-jwt', 'X-Custom-Header': 'plain-value' },
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

  return { geminiRoot, cliHome, outDir };
}

function seedImportFixture(root: string): {
  inDir: string;
  geminiRoot: string;
  cliHome: string;
  targetSettingsPath: string;
  targetMcpPath: string;
  targetConfigPath: string;
  originalConfig: Record<string, unknown>;
} {
  const inDir = path.join(root, 'bundle');
  const geminiRoot = path.join(root, 'target', '.gemini');
  const cliHome = path.join(geminiRoot, 'antigravity-cli');

  writeJson(path.join(inDir, 'settings.template.json'), {
    model: 'Gemini 4 Hydrogen',
    orchestrator: { executor: 'Gemini 4 Hydrogen' },
    trustedWorkspaces: ['/foreign/path'],
  });
  writeJson(path.join(inDir, 'hud-config.json'), { preset: 'minimal', segments: { cost: false } });
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
    mcpServers: { existingSrv: { command: 'local-cmd', env: { API_KEY: 'real-local-secret' } } },
  });
  const originalConfig = { userSettings: { remoteControlHostname: 'local-host' } };
  writeJson(targetConfigPath, originalConfig);

  return { inDir, geminiRoot, cliHome, targetSettingsPath, targetMcpPath, targetConfigPath, originalConfig };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedCredentialAuditFixture(root: string): { geminiRoot: string; cliHome: string; outDir: string } {
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
  return { geminiRoot, cliHome, outDir };
}

void describe('exportProfile', async () => {
  await it('exports settings.template.json without machine-local trustedWorkspaces', () => {
    const { geminiRoot, cliHome, outDir } = seedExportFixture(makeTempDir('agy-hud-exp-settings-'));

    exportProfile({ outDir, cliHome, geminiRoot });

    const settingsTpl = readJson(path.join(outDir, 'settings.template.json'));
    assert.equal(settingsTpl.trustedWorkspaces, undefined);
    assert.equal(settingsTpl.model, 'Gemini 4 Hydrogen');
  });

  await it('exports config.template.json without machine-local hostname or projectId', () => {
    const { geminiRoot, cliHome, outDir } = seedExportFixture(makeTempDir('agy-hud-exp-config-'));

    exportProfile({ outDir, cliHome, geminiRoot });

    const configTpl = readJson(path.join(outDir, 'config.template.json'));
    const userSettings = configTpl.userSettings as Record<string, unknown>;
    const sidecars = configTpl.sidecars as Record<string, Record<string, unknown>>;
    assert.equal(userSettings.remoteControlHostname, undefined);
    assert.equal(userSettings.themeMode, 'THEME_MODE_DARK');
    assert.equal(sidecars['swarm/swarm_board']?.projectId, undefined);
    assert.equal(sidecars['swarm/swarm_board']?.schemaVersion, 1);
  });

  await it('redacts secret env vars and headers in exported mcp_config.template.json', () => {
    const { geminiRoot, cliHome, outDir } = seedExportFixture(makeTempDir('agy-hud-exp-mcp-'));

    exportProfile({ outDir, cliHome, geminiRoot });

    const mcpTpl = readJson(path.join(outDir, 'mcp_config.template.json'));
    const demoServer = (mcpTpl.mcpServers as Record<string, Record<string, Record<string, string>>>).demo;
    assert.equal(demoServer?.env?.GITHUB_TOKEN, '<SET_IN_ENV>');
    assert.equal(demoServer?.env?.OPENAI_API_KEY, '<SET_IN_ENV>');
    assert.equal(demoServer?.env?.LOG_LEVEL, 'info');
    assert.equal(demoServer?.headers?.Authorization, '<SET_IN_ENV>');
    assert.equal(demoServer?.headers?.['X-Custom-Header'], 'plain-value');
  });

  await it('records installed plugin metadata in plugins-manifest.json', () => {
    const { geminiRoot, cliHome, outDir } = seedExportFixture(makeTempDir('agy-hud-exp-plg-'));

    const res = exportProfile({ outDir, cliHome, geminiRoot });

    assert.equal(res.pluginCount, 1);
    const manifest = readJson(path.join(outDir, 'plugins-manifest.json'));
    const plugins = manifest.plugins as Array<Record<string, unknown>>;
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.dir, 'sample-plugin');
    assert.equal(plugins[0]?.version, '0.2.8');
    assert.equal(plugins[0]?.repo, 'https://github.com/example/sample-plugin');
  });

  await it('excludes credentials, account state, conversations, and brain files from exported bundle', () => {
    const { geminiRoot, cliHome, outDir } = seedExportFixture(makeTempDir('agy-hud-exp-sec-'));

    exportProfile({ outDir, cliHome, geminiRoot });

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

  await it('strips synthetic credentials from every exported bundle file', () => {
    const { geminiRoot, cliHome, outDir } = seedCredentialAuditFixture(makeTempDir('agy-hud-exp-audit-cred-'));

    const exported = exportProfile({ outDir, cliHome, geminiRoot });
    for (const filePath of exported.filesWritten) {
      const content = readFileSync(filePath, 'utf8');
      assert.equal(content.includes('SYNTH_'), false, `synthetic credential leaked in ${path.basename(filePath)}`);
    }
  });

  await it('enforces portable allowlist on exported settings.template.json', () => {
    const { geminiRoot, cliHome, outDir } = seedCredentialAuditFixture(makeTempDir('agy-hud-exp-audit-set-'));

    exportProfile({ outDir, cliHome, geminiRoot });
    const settingsTpl = readJson(path.join(outDir, 'settings.template.json'));
    assert.equal(settingsTpl.model, 'Gemini 4 Carbon');
    assert.equal(settingsTpl.corpSecret, undefined);
  });

  await it('enforces portable allowlist on exported hud-config.json', () => {
    const { geminiRoot, cliHome, outDir } = seedCredentialAuditFixture(makeTempDir('agy-hud-exp-audit-hud-'));

    exportProfile({ outDir, cliHome, geminiRoot });
    const hudTpl = readJson(path.join(outDir, 'hud-config.json'));
    assert.equal(hudTpl.preset, 'compact');
    assert.equal(hudTpl.secretNote, undefined);
  });

  await it('strips embedded credentials from exported plugins-manifest.json repo URLs', () => {
    const { geminiRoot, cliHome, outDir } = seedCredentialAuditFixture(makeTempDir('agy-hud-exp-audit-plg-'));

    exportProfile({ outDir, cliHome, geminiRoot });
    const manifest = readJson(path.join(outDir, 'plugins-manifest.json'));
    const plugins = manifest.plugins as Array<Record<string, unknown>>;
    assert.equal(plugins[0]?.repo, 'https://github.com/org/private-plugin.git');
  });

  await it('enforces portable allowlist on exported mcp_config.template.json', () => {
    const { geminiRoot, cliHome, outDir } = seedCredentialAuditFixture(makeTempDir('agy-hud-exp-audit-mcp-'));

    exportProfile({ outDir, cliHome, geminiRoot });
    const mcpTpl = readJson(path.join(outDir, 'mcp_config.template.json'));
    assert.equal(mcpTpl.privateRegistryToken, undefined);
    const remote = (mcpTpl.mcpServers as Record<string, Record<string, unknown>>).remote;
    assert.equal(remote?.rawSecret, undefined);
    assert.equal((remote?.env as Record<string, unknown>)?.LOG_LEVEL, 'info');
  });
});

void describe('importProfile', async () => {
  await it('merges settings template while preserving local trustedWorkspaces', () => {
    const f = seedImportFixture(makeTempDir('agy-hud-imp-settings-'));

    importProfile({ inDir: f.inDir, cliHome: f.cliHome, geminiRoot: f.geminiRoot, mergeMcp: false });
    const mergedSettings = readJson(f.targetSettingsPath);
    assert.deepEqual(mergedSettings.trustedWorkspaces, ['/local/work/repo']);
    assert.deepEqual(mergedSettings.orchestrator, {
      planner: 'Gemini 4 Carbon',
      executor: 'Gemini 4 Hydrogen',
    });
  });

  await it('writes sanitized hud-config.json when importing a profile bundle', () => {
    const f = seedImportFixture(makeTempDir('agy-hud-imp-hud-'));

    importProfile({ inDir: f.inDir, cliHome: f.cliHome, geminiRoot: f.geminiRoot, mergeMcp: false });
    assert.equal(existsSync(path.join(f.cliHome, 'hud-config.json')), true);
    assert.equal(readJson(path.join(f.cliHome, 'hud-config.json')).preset, 'minimal');
  });

  await it('returns plugin install instructions from plugins-manifest.json', () => {
    const f = seedImportFixture(makeTempDir('agy-hud-imp-plugins-'));

    const res = importProfile({ inDir: f.inDir, cliHome: f.cliHome, geminiRoot: f.geminiRoot, mergeMcp: false });
    assert.equal(
      res.pluginInstructions.some(
        (line) => line.includes('customization://sample-plugin') && line.includes('agy plugin install'),
      ),
      true,
    );
  });

  await it('skips existing mcp_config.json when mergeMcp is false', () => {
    const f = seedImportFixture(makeTempDir('agy-hud-imp-nomerge-'));

    const res = importProfile({ inDir: f.inDir, cliHome: f.cliHome, geminiRoot: f.geminiRoot, mergeMcp: false });
    assert.equal(res.mcpAction, 'skipped-exists');
    assert.equal((readJson(f.targetMcpPath).mcpServers as Record<string, unknown>).addedSrv, undefined);
  });

  await it('never mutates target config.json when importProfile runs with mergeMcp false', () => {
    const f = seedImportFixture(makeTempDir('agy-hud-imp-config-nomerge-'));

    importProfile({ inDir: f.inDir, cliHome: f.cliHome, geminiRoot: f.geminiRoot, mergeMcp: false });
    assert.deepEqual(readJson(f.targetConfigPath), f.originalConfig);
  });

  await it('never mutates target config.json when importProfile runs with mergeMcp true', () => {
    const f = seedImportFixture(makeTempDir('agy-hud-imp-config-merge-'));

    importProfile({ inDir: f.inDir, cliHome: f.cliHome, geminiRoot: f.geminiRoot, mergeMcp: true });
    assert.deepEqual(readJson(f.targetConfigPath), f.originalConfig);
  });

  await it('merges only missing MCP servers when mergeMcp is true without overwriting local servers', () => {
    const f = seedImportFixture(makeTempDir('agy-hud-imp-merge-'));

    const res = importProfile({ inDir: f.inDir, cliHome: f.cliHome, geminiRoot: f.geminiRoot, mergeMcp: true });
    assert.equal(res.mcpAction, 'merged');
    const servers = readJson(f.targetMcpPath).mcpServers as Record<string, Record<string, Record<string, string>>>;
    assert.equal(servers.existingSrv?.command, 'local-cmd');
    assert.equal(servers.existingSrv?.env?.API_KEY, 'real-local-secret');
    assert.equal(servers.addedSrv?.command, 'added-cmd');
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

  await it('preserves costCurrency, usdToCnyRate, and narrow overrides during importProfile', () => {
    const root = makeTempDir('agy-hud-imp-full-hud-');
    const inDir = path.join(root, 'bundle');
    const geminiRoot = path.join(root, 'target', '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');

    writeJson(path.join(inDir, 'hud-config.json'), {
      preset: 'compact',
      maxAgentChips: 6,
      osc8Links: false,
      costCurrency: 'both',
      usdToCnyRate: 7.35,
      lines: ['identity', 'usage'],
      segments: { ...DEFAULT_HUD_CONFIG.segments, cost: true },
      narrow: { lines: ['identity'], segments: { perf: false } },
    });

    const result = importProfile({ inDir, cliHome, geminiRoot });
    assert.equal(result.filesUpdated.length, 1);
    const written = readJson(path.join(cliHome, 'hud-config.json'));
    assert.equal(written.costCurrency, 'both');
    assert.equal(written.usdToCnyRate, 7.35);
    assert.deepEqual(written.narrow, { lines: ['identity'], segments: { perf: false } });
  });
});
