import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  disableCliStatusLine,
  inspectStatusLineState,
  restoreCliStatusLine,
  wireCliStatusLine,
} from '../../cli/installer/settings.ts';
import { parseStatusLineData } from '../../hud-entry.ts';
import { DEFAULT_HUD_CONFIG, hydrateHudConfig, mergeHudConfig } from '../hud-config.ts';
import { getHomeDir, resolveCliHome } from '../paths.ts';
import { formatStatusLineCommand, isSameCommandPath, isValidBackupRecord } from '../statusline-ownership.ts';

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

  await it('recognizes tilde home paths in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath('~/.gemini/config/plugins/agy-hud/dist/hud.mjs', absHud, env), true);
  });

  await it('does not expand tilde inside quoted shell tokens in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath("'~/.gemini/config/plugins/agy-hud/dist/hud.mjs'", absHud, env, 'darwin'), false);
    assert.equal(isSameCommandPath('"~/.gemini/config/plugins/agy-hud/dist/hud.mjs"', absHud, env, 'darwin'), false);
    assert.equal(
      isSameCommandPath("node '~/.gemini/config/plugins/agy-hud/dist/hud.mjs'", absHud, env, 'darwin'),
      false,
    );
    assert.equal(
      isSameCommandPath('node "~/.gemini/config/plugins/agy-hud/dist/hud.mjs"', absHud, env, 'darwin'),
      false,
    );
  });

  await it('recognizes node launcher prefixes in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath('node ~/.gemini/config/plugins/agy-hud/dist/hud.mjs', absHud, env), true);
    assert.equal(isSameCommandPath(`"node" "${absHud}"`, absHud, env), true);
    assert.equal(isSameCommandPath('node.exe ~/.gemini/config/plugins/agy-hud/dist/hud.mjs', absHud, env), true);
    assert.equal(isSameCommandPath('node ~/.gemini/config/plugins/other/dist/hud.mjs', absHud, env), false);
  });

  await it('rejects compound shell commands in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath(`node ${absHud} && echo extra`, absHud, env), false);
    assert.equal(isSameCommandPath(`node "${absHud}" && custom-cmd`, absHud, env), false);
    assert.equal(isSameCommandPath(`"${absHud}" && custom-cmd`, absHud, env), false);
    assert.equal(isSameCommandPath(`${absHud} && custom-cmd`, absHud, env), false);
    assert.equal(isSameCommandPath(`node ${absHud}; echo done`, absHud, env), false);
  });

  await it('rejects trailing arguments in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
    assert.equal(isSameCommandPath(`node ${absHud} --extra-flag`, absHud, env), false);
  });

  await it('rejects node launcher flags in isSameCommandPath', () => {
    const fakeHome = path.resolve('/tmp/fake-home-ownership');
    const env = { HOME: fakeHome, USERPROFILE: fakeHome };
    const absHud = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-hud', 'dist', 'hud.mjs');
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

  await it('round-trips ownership for special-character target paths across wire, off, and restore', () => {
    if (process.platform === 'win32') return;
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-own-special-'));
    try {
      const cliHome = path.join(tmpDir, 'cli-home');
      const targetDir = path.join(tmpDir, "dir with spaces;id;#'q");
      mkdirSync(path.join(targetDir, 'dist'), { recursive: true });
      const hudPath = path.join(targetDir, 'dist', 'hud.mjs');
      writeFileSync(hudPath, '#!/usr/bin/env node\n', 'utf8');
      chmodSync(hudPath, 0o755);

      const wired = wireCliStatusLine(cliHome, targetDir);
      assert.ok(wired.writtenStatusLine.command.startsWith("'"), 'special POSIX target path must be single-quoted');
      assert.equal(inspectStatusLineState(cliHome, targetDir).state, 'wired to agy-hud');

      const disabled = disableCliStatusLine(cliHome, targetDir);
      assert.equal(disabled.changed, true);
      assert.equal(inspectStatusLineState(cliHome, targetDir).state, 'disabled (wired to agy-hud, enabled=false)');

      const restored = restoreCliStatusLine(cliHome, targetDir);
      assert.equal(restored.changed, true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await it('rejects control characters in targetDir when wiring statusLine', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-own-ctrl-'));
    try {
      assert.throws(() => wireCliStatusLine(path.join(tmpDir, 'cli'), '/tmp/bad\npath'), /control|newline/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await it('rejects unquoted multi-token paths containing whitespace in isSameCommandPath', () => {
    const env = { HOME: '/tmp/home', USERPROFILE: '/tmp/home' };
    assert.equal(isSameCommandPath('/tmp/a b/dist/hud.mjs', "'/tmp/a b/dist/hud.mjs'", env), false);
  });

  await it('leaves unquoted foreign multi-token statusLine untouched during disable', () => {
    if (process.platform === 'win32') return;
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-own-unquoted-dis-'));
    try {
      const cliHome = path.join(tmpDir, 'cli-home');
      const targetDir = path.join(tmpDir, 'dir with space');
      mkdirSync(cliHome, { recursive: true });
      mkdirSync(path.join(targetDir, 'dist'), { recursive: true });
      const hudPath = path.join(targetDir, 'dist', 'hud.mjs');
      writeFileSync(hudPath, '#!/usr/bin/env node\n', 'utf8');
      const foreignStatusLine = { type: 'command', command: hudPath, enabled: true };
      const settingsPath = path.join(cliHome, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ statusLine: foreignStatusLine }), 'utf8');

      assert.equal(disableCliStatusLine(cliHome, targetDir).skippedReason, 'not-owned');
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: unknown };
      assert.deepEqual(after.statusLine, foreignStatusLine);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await it('leaves unquoted foreign multi-token statusLine untouched during restore', () => {
    if (process.platform === 'win32') return;
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-own-unquoted-res-'));
    try {
      const cliHome = path.join(tmpDir, 'cli-home');
      const targetDir = path.join(tmpDir, 'dir with space');
      mkdirSync(cliHome, { recursive: true });
      mkdirSync(path.join(targetDir, 'dist'), { recursive: true });
      const hudPath = path.join(targetDir, 'dist', 'hud.mjs');
      writeFileSync(hudPath, '#!/usr/bin/env node\n', 'utf8');
      const foreignStatusLine = { type: 'command', command: hudPath, enabled: true };
      const settingsPath = path.join(cliHome, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ statusLine: foreignStatusLine }), 'utf8');

      assert.equal(restoreCliStatusLine(cliHome, targetDir).skippedReason, 'not-owned');
      const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine?: unknown };
      assert.deepEqual(after.statusLine, foreignStatusLine);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await it('rejects POSIX double-quoted shell expansion and backslash tokens in isSameCommandPath', () => {
    const env = { HOME: '/tmp/home', USERPROFILE: '/tmp/home' };
    assert.equal(isSameCommandPath('"/tmp/$(id)/dist/hud.mjs"', "'/tmp/$(id)/dist/hud.mjs'", env, 'darwin'), false);
    assert.equal(isSameCommandPath('"/tmp/`id`/dist/hud.mjs"', "'/tmp/`id`/dist/hud.mjs'", env, 'darwin'), false);
    assert.equal(isSameCommandPath('"/tmp/$HOME/dist/hud.mjs"', "'/tmp/$HOME/dist/hud.mjs'", env, 'darwin'), false);
    assert.equal(isSameCommandPath('"/tmp/a\\b/dist/hud.mjs"', "'/tmp/a\\b/dist/hud.mjs'", env, 'darwin'), false);
  });

  await it('rejects exclamation marks in Windows formatStatusLineCommand', () => {
    assert.throws(() => formatStatusLineCommand('C:\\dir !var!\\dist\\hud.mjs', 'win32'), /exclamation/i);
  });

  await it('rejects Windows double-quoted variable expansion tokens in isSameCommandPath', () => {
    const env = { HOME: 'C:\\Users\\u', USERPROFILE: 'C:\\Users\\u' };
    assert.equal(isSameCommandPath('"C:\\%TEMP%\\dist\\hud.mjs"', '"C:\\%TEMP%\\dist\\hud.mjs"', env, 'win32'), false);
    assert.equal(isSameCommandPath('"C:\\!VAR!\\dist\\hud.mjs"', '"C:\\!VAR!\\dist\\hud.mjs"', env, 'win32'), false);
  });

  await it('round-trips Windows double-quoted literal paths with backslashes and dollar signs', () => {
    const env = { HOME: 'C:\\Users\\u', USERPROFILE: 'C:\\Users\\u' };
    const formatted = formatStatusLineCommand('C:\\Program Files\\dev$1\\dist\\hud.mjs', 'win32');
    assert.equal(isSameCommandPath(formatted, formatted, env, 'win32'), true);
  });

  await it('rejects POSIX single-quoted commands in win32 isSameCommandPath', () => {
    const env = { HOME: 'C:\\Users\\u', USERPROFILE: 'C:\\Users\\u' };
    assert.equal(
      isSameCommandPath("'C:\\Users\\u\\plugin\\dist\\hud.mjs'", '"C:\\Users\\u\\plugin\\dist\\hud.mjs"', env, 'win32'),
      false,
    );
    assert.equal(
      isSameCommandPath(
        "node 'C:\\Users\\u\\plugin\\dist\\hud.mjs'",
        '"C:\\Users\\u\\plugin\\dist\\hud.mjs"',
        env,
        'win32',
      ),
      false,
    );
  });

  await it('preserves settings.json and backup when win32 disableCliStatusLine sees a single-quoted command', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-win32-off-'));
    try {
      const cliHome = path.join(tmpDir, 'cli');
      const targetDir = path.join(tmpDir, 'my plugin');
      mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
      const hudScript = path.join(targetDir, 'dist', 'hud.mjs');
      const settingsPath = path.join(cliHome, 'settings.json');
      const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
      const settingsRaw = `${JSON.stringify({ statusLine: { type: 'command', command: `'${hudScript}'`, enabled: true } }, null, 2)}\n`;
      const backupRaw = `${JSON.stringify({ wiredCommand: formatStatusLineCommand(hudScript, 'win32'), hadStatusLine: false, previousStatusLine: null, savedAt: '2026-06-01T00:00:00Z' }, null, 2)}\n`;
      writeFileSync(settingsPath, settingsRaw, 'utf8');
      writeFileSync(backupPath, backupRaw, 'utf8');

      assert.equal(disableCliStatusLine(cliHome, targetDir, 'win32').skippedReason, 'not-owned');
      assert.equal(readFileSync(settingsPath, 'utf8'), settingsRaw);
      assert.equal(readFileSync(backupPath, 'utf8'), backupRaw);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await it('preserves settings.json and backup when win32 restoreCliStatusLine sees a single-quoted command', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-win32-rst-'));
    try {
      const cliHome = path.join(tmpDir, 'cli');
      const targetDir = path.join(tmpDir, 'my plugin');
      mkdirSync(path.join(cliHome, 'cache'), { recursive: true });
      const hudScript = path.join(targetDir, 'dist', 'hud.mjs');
      const settingsPath = path.join(cliHome, 'settings.json');
      const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
      const settingsRaw = `${JSON.stringify({ statusLine: { type: 'command', command: `'${hudScript}'`, enabled: true } }, null, 2)}\n`;
      const backupRaw = `${JSON.stringify({ wiredCommand: formatStatusLineCommand(hudScript, 'win32'), hadStatusLine: false, previousStatusLine: null, savedAt: '2026-06-01T00:00:00Z' }, null, 2)}\n`;
      writeFileSync(settingsPath, settingsRaw, 'utf8');
      writeFileSync(backupPath, backupRaw, 'utf8');

      assert.equal(restoreCliStatusLine(cliHome, targetDir, 'win32').skippedReason, 'not-owned');
      assert.equal(readFileSync(settingsPath, 'utf8'), settingsRaw);
      assert.equal(readFileSync(backupPath, 'utf8'), backupRaw);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await it('rejects unquoted POSIX glob and backslash metacharacters in isSameCommandPath', () => {
    const env = { HOME: '/tmp/home', USERPROFILE: '/tmp/home' };
    assert.equal(isSameCommandPath('/tmp/a*b/dist/hud.mjs', "'/tmp/a*b/dist/hud.mjs'", env, 'darwin'), false);
    assert.equal(isSameCommandPath('/tmp/a?b/dist/hud.mjs', "'/tmp/a?b/dist/hud.mjs'", env, 'darwin'), false);
    assert.equal(isSameCommandPath('/tmp/a[0]/dist/hud.mjs', "'/tmp/a[0]/dist/hud.mjs'", env, 'darwin'), false);
    assert.equal(isSameCommandPath('/tmp/a\\b/dist/hud.mjs', "'/tmp/a\\b/dist/hud.mjs'", env, 'darwin'), false);
    assert.equal(isSameCommandPath('node /tmp/a*b/dist/hud.mjs', "'/tmp/a*b/dist/hud.mjs'", env, 'darwin'), false);
  });

  await it('allows unquoted Windows backslash paths in isSameCommandPath', () => {
    const env = { HOME: 'C:\\Users\\u', USERPROFILE: 'C:\\Users\\u' };
    assert.equal(
      isSameCommandPath('C:\\Users\\u\\plugin\\dist\\hud.mjs', 'C:\\Users\\u\\plugin\\dist\\hud.mjs', env, 'win32'),
      true,
    );
  });

  await it('rejects unquoted Windows glob metacharacters in isSameCommandPath', () => {
    const env = { HOME: 'C:\\Users\\u', USERPROFILE: 'C:\\Users\\u' };
    assert.equal(
      isSameCommandPath('C:\\Users\\a*b\\dist\\hud.mjs', '"C:\\Users\\a*b\\dist\\hud.mjs"', env, 'win32'),
      false,
    );
    assert.equal(
      isSameCommandPath('C:\\Users\\a?b\\dist\\hud.mjs', '"C:\\Users\\a?b\\dist\\hud.mjs"', env, 'win32'),
      false,
    );
    assert.equal(
      isSameCommandPath('node C:\\Users\\a[0]\\dist\\hud.mjs', '"C:\\Users\\a[0]\\dist\\hud.mjs"', env, 'win32'),
      false,
    );
  });
});
