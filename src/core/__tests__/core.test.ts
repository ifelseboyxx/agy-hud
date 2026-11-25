import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { restoreCliStatusLine } from '../../cli/installer/settings.ts';
import { parseStatusLineData } from '../../hud-entry.ts';
import { DEFAULT_HUD_CONFIG } from '../../types.ts';
import { hydrateHudConfig, mergeHudConfig } from '../hud-config.ts';
import { getHomeDir, resolveCliHome } from '../paths.ts';
import { isSameCommandPath, isValidBackupRecord } from '../statusline-ownership.ts';

void describe('core paths, config schema, ownership, and stdin boundary', async () => {
  await it('falls back from empty HOME string to USERPROFILE in getHomeDir', () => {
    const home = getHomeDir({ HOME: '   ', USERPROFILE: '/fallback/profile' });
    assert.equal(home, '/fallback/profile');
    assert.equal(
      resolveCliHome(undefined, { HOME: '', USERPROFILE: '/fallback/profile' }),
      path.join('/fallback/profile', '.gemini', 'antigravity-cli'),
    );
  });

  await it('shares one HudConfig schema between lenient mergeHudConfig and strict hydrateHudConfig', () => {
    assert.deepEqual(
      mergeHudConfig({ preset: 'invalid', maxAgentChips: 99, segments: { cost: 'yes' } }),
      DEFAULT_HUD_CONFIG,
    );
    assert.throws(() => hydrateHudConfig({ preset: 'invalid' }), /Invalid 'preset'/);
    assert.throws(() => hydrateHudConfig({ maxAgentChips: 21 }), /Invalid 'maxAgentChips'/);
    assert.throws(() => hydrateHudConfig({ segments: { cost: 'yes' } }), /Invalid boolean 'segments\.cost'/);
  });

  await it('ignores unknown keys such as autoWireStatusLine in hud-config.json', () => {
    const expected = {
      ...DEFAULT_HUD_CONFIG,
      lines: [...DEFAULT_HUD_CONFIG.lines],
      segments: { ...DEFAULT_HUD_CONFIG.segments, cost: false },
    };
    assert.deepEqual(mergeHudConfig({ autoWireStatusLine: true, segments: { cost: false } }), expected);
    assert.deepEqual(hydrateHudConfig({ autoWireStatusLine: true, segments: { cost: false } }), expected);
  });

  await it('requires non-empty wiredCommand in modern statusLine backup records', () => {
    assert.equal(isValidBackupRecord({ hadStatusLine: false, previousStatusLine: null }), false);
    assert.equal(isValidBackupRecord({ wiredCommand: '   ', hadStatusLine: false, previousStatusLine: null }), false);
    assert.equal(
      isValidBackupRecord({ wiredCommand: '/p/dist/hud.mjs', hadStatusLine: false, previousStatusLine: null }),
      true,
    );
  });

  await it('sanitizes malformed nested fields and unsafe keys in parseStatusLineData', () => {
    assert.equal(parseStatusLineData(null), null);
    assert.equal(parseStatusLineData(['not-an-object']), null);
    const parsed = parseStatusLineData({
      model: 'bad-scalar',
      subagents: 'not-array',
      cwd: '/tmp/work',
      context_window: { used_percentage: 42 },
    });
    assert.ok(parsed);
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.subagents, undefined);
    assert.equal(parsed.cwd, '/tmp/work');
    assert.equal(parsed.context_window?.used_percentage, 42);
  });

  await it('recognizes tilde paths and node launcher prefixes in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath('~/.gemini/config/plugins/agy-hud/dist/hud.mjs', absHud, env), true);
    assert.equal(isSameCommandPath('node ~/.gemini/config/plugins/agy-hud/dist/hud.mjs', absHud, env), true);
    assert.equal(isSameCommandPath(`"node" "${absHud}"`, absHud, env), true);
    assert.equal(isSameCommandPath('node.exe ~/.gemini/config/plugins/agy-hud/dist/hud.mjs', absHud, env), true);
    assert.equal(isSameCommandPath('node ~/.gemini/config/plugins/other/dist/hud.mjs', absHud, env), false);
  });

  await it('rejects compound shell commands and trailing arguments in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath(`node ${absHud} && echo extra`, absHud, env), false);
    assert.equal(isSameCommandPath(`node "${absHud}" && custom-cmd`, absHud, env), false);
    assert.equal(isSameCommandPath(`node ${absHud} --extra-flag`, absHud, env), false);
    assert.equal(isSameCommandPath(`"${absHud}" && custom-cmd`, absHud, env), false);
    assert.equal(isSameCommandPath(`${absHud} && custom-cmd`, absHud, env), false);
    assert.equal(isSameCommandPath(`node ${absHud}; echo done`, absHud, env), false);
    assert.equal(isSameCommandPath(`node --no-warnings ${absHud}`, absHud, env), false);
  });

  await it('preserves trailing spaces inside quoted command paths for distinct files', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-own-space-'));
    try {
      const distDir = path.join(tmpDir, 'agy-hud', 'dist');
      mkdirSync(distDir, { recursive: true });
      const ownedFile = path.join(distDir, 'hud.mjs');
      const otherFile = path.join(distDir, 'hud.mjs ');
      writeFileSync(ownedFile, '// owned\n', 'utf8');
      writeFileSync(otherFile, '// other\n', 'utf8');

      assert.equal(isSameCommandPath(`"${otherFile}"`, ownedFile), false);
      assert.equal(isSameCommandPath(`node "${otherFile}"`, ownedFile), false);
      assert.equal(isSameCommandPath(`'${otherFile}'`, ownedFile), false);
      assert.equal(isSameCommandPath(`" ${ownedFile}"`, ownedFile), false);
      assert.equal(isSameCommandPath(`"${ownedFile}"`, ownedFile), true);
      assert.equal(isSameCommandPath(`node "${ownedFile}"`, ownedFile), true);

      const cliHome = path.join(tmpDir, 'cli-home');
      mkdirSync(cliHome, { recursive: true });
      const settingsPath = path.join(cliHome, 'settings.json');
      const userStatusLine = { type: 'command', command: `node "${otherFile}"`, enabled: true };
      writeFileSync(settingsPath, JSON.stringify({ statusLine: userStatusLine }), 'utf8');

      const res = restoreCliStatusLine(cliHome, ownedFile);
      assert.equal(res.changed, false);
      assert.equal(res.skippedReason, 'not-owned');
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: unknown };
      assert.deepEqual(after.statusLine, userStatusLine);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await it('rejects malformed quoted commands in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath(`"${absHud}`, absHud, env), false);
    assert.equal(isSameCommandPath(`node "${absHud}`, absHud, env), false);
    assert.equal(isSameCommandPath(`"node"extra ${absHud}`, absHud, env), false);
    assert.equal(isSameCommandPath(`"${absHud}"extra`, absHud, env), false);
    assert.equal(isSameCommandPath(`evil&&/usr/bin/node ${absHud}`, absHud, env), false);
    assert.equal(isSameCommandPath(`a;/bin/node ${absHud}`, absHud, env), false);
  });
});
