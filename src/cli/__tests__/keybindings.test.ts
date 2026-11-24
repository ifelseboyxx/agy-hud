import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { stripAnsi } from '../../render/ansi.ts';
import { installCliShim } from '../installer/shim.ts';
import {
  detectHostTerminal,
  parseKeybindingsTarget,
  renderKeybindings,
  resolveKeybindingCommand,
} from '../keybindings.ts';

void describe('keybindings host detection and snippet generation', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-keybindings-'));
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('detects host terminal from environment variables with tmux taking precedence', () => {
    assert.equal(detectHostTerminal({ TMUX: '/tmp/tmux-501/default,123,0', GHOSTTY_RESOURCES_DIR: '/app' }), 'tmux');
    assert.equal(detectHostTerminal({ KITTY_PID: '4321' }), 'kitty');
    assert.equal(detectHostTerminal({ WEZTERM_PANE: '0' }), 'wezterm');
    assert.equal(
      detectHostTerminal({ GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources' }),
      'ghostty',
    );
    assert.equal(detectHostTerminal({ TERM_PROGRAM: 'ghostty' }), 'ghostty');
    assert.equal(detectHostTerminal({ ITERM_SESSION_ID: 'w0t0p0:ABC' }), 'iterm2');
    assert.equal(detectHostTerminal({ TERM_PROGRAM: 'iTerm.app' }), 'iterm2');
    assert.equal(detectHostTerminal({ TERM_PROGRAM: 'Apple_Terminal' }), null);
  });

  void it('validates explicit --keybindings targets', () => {
    assert.equal(parseKeybindingsTarget('TMUX'), 'tmux');
    assert.equal(parseKeybindingsTarget('all'), 'all');
    assert.throws(() => parseKeybindingsTarget('alacritty'), /Invalid --keybindings target/);
  });

  void it('substitutes installed CLI Shim path via shared shim resolver', () => {
    const homeDir = path.join(tmpRoot, 'home');
    const pluginRoot = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud');
    const binDir = path.join(homeDir, '.local', 'bin');
    mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(pluginRoot, 'dist', 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8');

    const env: NodeJS.ProcessEnv = { HOME: homeDir };
    installCliShim(binDir, pluginRoot, env, 'darwin');

    const resolved = resolveKeybindingCommand({ env, pluginRoot, platform: 'darwin' });
    assert.equal(resolved.source, 'shim');
    assert.equal(resolved.shimPath, path.join(binDir, 'agy-hud'));
    assert.deepEqual(resolved.popupArgs, [path.join(binDir, 'agy-hud'), '-p']);

    const tmuxOut = stripAnsi(
      renderKeybindings({ target: 'auto', env: { ...env, TMUX: '/tmp/tmux' }, pluginRoot, platform: 'darwin' }),
    );
    assert.ok(tmuxOut.includes('Detected host: tmux'));
    assert.ok(tmuxOut.includes('-d "#{pane_current_path}"'));
    assert.ok(tmuxOut.includes(`${path.join(binDir, 'agy-hud')} -p`));
  });

  void it('falls back to node "<pluginRoot>/dist/cli.mjs" when CLI Shim is absent or foreign', () => {
    const homeDir = path.join(tmpRoot, 'home-noshim');
    const pluginRoot = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud');
    const binDir = path.join(homeDir, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'agy-hud'), '#!/bin/sh\necho foreign\n', 'utf8');

    const env: NodeJS.ProcessEnv = { HOME: homeDir };
    const resolved = resolveKeybindingCommand({ env, pluginRoot, platform: 'darwin' });
    const expectedCli = path.join(pluginRoot, 'dist', 'cli.mjs');
    assert.equal(resolved.source, 'node-fallback');
    assert.deepEqual(resolved.popupArgs, ['node', expectedCli, '-p']);

    const kittyOut = stripAnsi(
      renderKeybindings({ target: 'kitty', env, pluginRoot, platform: 'darwin', color: false }),
    );
    assert.ok(kittyOut.includes(`launch --type=overlay --cwd=current node "${expectedCli}" -p`));
  });

  void it('emits cwd-inheriting snippets for all five terminals and leaves user config dirs untouched', () => {
    const homeDir = path.join(tmpRoot, 'home-all');
    const pluginRoot = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud');
    mkdirSync(homeDir, { recursive: true });
    const beforeEntries = readdirSync(homeDir);

    const out = renderKeybindings({
      target: 'all',
      env: { HOME: homeDir },
      pluginRoot,
      platform: 'darwin',
      color: false,
    });
    assert.equal(out, stripAnsi(out));
    assert.ok(out.includes('display-popup -E -w 85% -h 80% -d "#{pane_current_path}"'));
    assert.ok(out.includes('launch --type=overlay --cwd=current'));
    assert.ok(out.includes('wezterm.action.SplitPane'));
    assert.ok(out.includes('CloseOnCleanExit'));
    assert.ok(out.includes('Cmd+Click'));
    assert.ok(out.includes('keybind = super+shift+h=text:!agy-hud\\n'));
    assert.ok(out.includes('Hotkey Window'));
    assert.ok(out.includes('Reuse previous session'));
    assert.deepEqual(readdirSync(homeDir), beforeEntries, 'must never create or edit terminal config files');
  });

  void it('falls back to all five templates when host terminal is unrecognized', () => {
    const homeDir = path.join(tmpRoot, 'home-unknown');
    mkdirSync(homeDir, { recursive: true });
    const out = renderKeybindings({
      target: 'auto',
      env: { HOME: homeDir },
      pluginRoot: path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud'),
      platform: 'darwin',
      color: false,
    });
    assert.ok(out.includes('tmux'));
    assert.ok(out.includes('Kitty'));
    assert.ok(out.includes('WezTerm'));
    assert.ok(out.includes('Ghostty'));
    assert.ok(out.includes('iTerm2'));
  });

  void it('substitutes Windows .cmd CLI Shim path when valid Windows shim pair is installed', () => {
    const homeDir = path.join(tmpRoot, 'win-home');
    const localAppData = path.join(homeDir, 'AppData', 'Local');
    const binDir = path.join(localAppData, 'agy', 'bin');
    const pluginRoot = path.join(homeDir, '.gemini', 'config', 'plugins', 'agy-hud');
    mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(pluginRoot, 'dist', 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8');

    const env: NodeJS.ProcessEnv = { USERPROFILE: homeDir, LOCALAPPDATA: localAppData };
    installCliShim(binDir, pluginRoot, env, 'win32');

    const resolved = resolveKeybindingCommand({ env, pluginRoot, platform: 'win32' });
    assert.equal(resolved.source, 'shim');
    assert.equal(resolved.shimPath, path.join(binDir, 'agy-hud.cmd'));
    assert.deepEqual(resolved.popupArgs, [path.join(binDir, 'agy-hud.cmd'), '-p']);
  });
});
