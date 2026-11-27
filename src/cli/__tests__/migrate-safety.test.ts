import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DEFAULT_HUD_CONFIG } from '../../core/hud-config.ts';
import { configureHud } from '../configure.ts';
import { commitPlannedOps } from '../file-transaction.ts';
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

function restoreWritableDirs(dirPath: string): void {
  try {
    chmodSync(dirPath, 0o755);
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        restoreWritableDirs(path.join(dirPath, entry.name));
      }
    }
  } catch {
    // Ignore missing or transient cleanup errors before rmSync.
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      restoreWritableDirs(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

void describe('profile migration safety', async () => {
  await it('removes stale managed templates from outDir when source files disappear on re-export', () => {
    const root = makeTempDir('agy-hud-stale-exp-');
    const geminiRoot = path.join(root, '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    const outDir = path.join(root, 'bundle');

    const settingsSrc = path.join(cliHome, 'settings.json');
    const mcpSrc = path.join(geminiRoot, 'config', 'mcp_config.json');
    writeJson(settingsSrc, { model: 'Gemini 4 Carbon' });
    writeJson(mcpSrc, { mcpServers: { demo: { command: 'npx' } } });
    writeJson(path.join(cliHome, 'hud-config.json'), { ...DEFAULT_HUD_CONFIG, preset: 'compact' });

    exportProfile({ outDir, cliHome, geminiRoot });
    assert.equal(existsSync(path.join(outDir, 'settings.template.json')), true);
    assert.equal(existsSync(path.join(outDir, 'mcp_config.template.json')), true);

    // Simulate an unrelated user note in outDir plus stale legacy content.
    writeFileSync(path.join(outDir, 'notes.txt'), 'keep-me', 'utf8');
    writeJson(path.join(outDir, 'settings.template.json'), { legacySecret: 'OLD_UNSANITIZED_DATA' });
    rmSync(settingsSrc);
    rmSync(mcpSrc);

    const second = exportProfile({ outDir, cliHome, geminiRoot });
    assert.equal(
      existsSync(path.join(outDir, 'settings.template.json')),
      false,
      'stale settings template must be removed',
    );
    assert.equal(
      existsSync(path.join(outDir, 'mcp_config.template.json')),
      false,
      'stale MCP template must be removed',
    );
    assert.equal(existsSync(path.join(outDir, 'hud-config.json')), true);
    assert.equal(existsSync(path.join(outDir, 'plugins-manifest.json')), true);
    assert.equal(readFileSync(path.join(outDir, 'notes.txt'), 'utf8'), 'keep-me');
    assert.equal(second.filesWritten.includes(path.join(outDir, 'settings.template.json')), false);
  });

  await it('rejects non-scalar nested objects in HUD config fields during export without writing partial bundle', () => {
    const root = makeTempDir('agy-hud-hudtype-exp-');
    const geminiRoot = path.join(root, '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    const outDir = path.join(root, 'bundle');

    writeJson(path.join(cliHome, 'settings.json'), { model: 'Gemini 4 Carbon' });
    writeJson(path.join(cliHome, 'hud-config.json'), {
      preset: 'compact',
      segments: { cost: { nestedSecret: 'SYNTH_HUD_OBJECT_LEAK' } },
    });

    assert.throws(() => exportProfile({ outDir, cliHome, geminiRoot }), /Invalid boolean 'segments\.cost'/);
    assert.equal(existsSync(outDir), false, 'failed export must not write partial templates');
  });

  await it('rolls back earlier target writes after a mid-commit write fails during import', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const root = makeTempDir('agy-hud-imp-rollback-');
    const inDir = path.join(root, 'bundle');
    const geminiRoot = path.join(root, 'target', '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    const configDir = path.join(geminiRoot, 'config');

    const targetSettingsPath = path.join(cliHome, 'settings.json');
    const targetHudPath = path.join(cliHome, 'hud-config.json');
    const targetMcpPath = path.join(configDir, 'mcp_config.json');
    const originalSettings = { model: 'Original Local', trustedWorkspaces: ['/keep'] };
    const originalHud = { ...DEFAULT_HUD_CONFIG, preset: 'full' };

    const dotfileSettingsPath = path.join(root, 'dotfiles', 'settings.json');
    writeJson(dotfileSettingsPath, originalSettings);
    mkdirSync(cliHome, { recursive: true });
    symlinkSync(dotfileSettingsPath, targetSettingsPath);
    writeJson(targetHudPath, originalHud);
    writeJson(path.join(inDir, 'settings.template.json'), { model: 'Imported Model' });
    writeJson(path.join(inDir, 'hud-config.json'), { preset: 'minimal' });
    writeJson(path.join(inDir, 'mcp_config.template.json'), { mcpServers: { demo: { command: 'npx' } } });

    // Make configDir readable (passes Phase 1 read + snapshot) but non-writable so the 3rd write fails mid-commit.
    mkdirSync(configDir, { recursive: true });
    chmodSync(configDir, 0o555);
    try {
      assert.throws(
        () => importProfile({ inDir, cliHome, geminiRoot }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /EACCES|EPERM/);
          assert.match(err.message, /mcp_config\.json\.tmp\./, 'failure must occur during atomic write of later file');
          return true;
        },
      );
      assert.equal(lstatSync(targetSettingsPath).isSymbolicLink(), true, 'settings.json symlink must be restored');
      assert.equal(readlinkSync(targetSettingsPath), dotfileSettingsPath);
      assert.deepEqual(readJson(targetSettingsPath), originalSettings, 'settings.json content must be rolled back');
      assert.deepEqual(readJson(targetHudPath), originalHud, 'hud-config.json must be rolled back');
      assert.equal(existsSync(targetMcpPath), false);
      const leftoverTmp = readdirSync(cliHome).filter((f) => f.includes('.tmp.'));
      assert.deepEqual(leftoverTmp, [], 'no leftover temp files should remain after failed commit');
    } finally {
      chmodSync(configDir, 0o755);
    }
  });

  await it('rejects dangling symlinks on configure, export, and import instead of overwriting them as missing', () => {
    const root = makeTempDir('agy-hud-dangling-cfg-');
    const geminiRoot = path.join(root, '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });

    const hudPath = path.join(cliHome, 'hud-config.json');
    symlinkSync(path.join(root, 'unmounted-dotfiles', 'hud-config.json'), hudPath);

    assert.throws(() => configureHud({ cliHome, preset: 'compact' }), /dangling symbolic link/i);
    assert.equal(lstatSync(hudPath).isSymbolicLink(), true, 'dangling hud-config.json symlink must be preserved');

    assert.throws(
      () => exportProfile({ outDir: path.join(root, 'out'), cliHome, geminiRoot }),
      /dangling symbolic link/i,
    );

    const inDir = path.join(root, 'in-bundle');
    mkdirSync(inDir, { recursive: true });
    symlinkSync(path.join(root, 'missing-tpl.json'), path.join(inDir, 'settings.template.json'));
    assert.throws(
      () => importProfile({ inDir, cliHome: path.join(root, 'fresh-cli'), geminiRoot: path.join(root, 'fresh-gem') }),
      /dangling symbolic link/i,
    );

    // configure --reset must not clobber corrupt hud-config.json or dangling symlink.
    assert.throws(() => configureHud({ cliHome, reset: true }), /dangling symbolic link/i);
    assert.equal(lstatSync(hudPath).isSymbolicLink(), true);

    const corruptCliHome = path.join(root, 'corrupt-cli');
    mkdirSync(corruptCliHome, { recursive: true });
    writeFileSync(path.join(corruptCliHome, 'hud-config.json'), '{broken', 'utf8');
    assert.throws(() => configureHud({ cliHome: corruptCliHome, reset: true }), /Invalid JSON/);

    // Dangling cliHome ancestor on exportProfile must throw instead of deleting existing outDir templates.
    const existingOut = path.join(root, 'existing-out');
    writeJson(path.join(existingOut, 'settings.template.json'), { model: 'Keep Me' });
    const danglingCliHome = path.join(root, 'dangling-cli-home');
    symlinkSync(path.join(root, 'unmounted-volume'), danglingCliHome);
    assert.throws(
      () => exportProfile({ outDir: existingOut, cliHome: danglingCliHome, geminiRoot }),
      /dangling symbolic link/i,
    );
    assert.equal(readJson(path.join(existingOut, 'settings.template.json')).model, 'Keep Me');

    // Corrupt plugins-manifest.json in bundle must fail importProfile upfront without modifying settings.json.
    const badManifestBundle = path.join(root, 'bad-manifest-bundle');
    writeJson(path.join(badManifestBundle, 'settings.template.json'), { model: 'Should Not Write' });
    writeFileSync(path.join(badManifestBundle, 'plugins-manifest.json'), '{corrupt-manifest', 'utf8');
    const cleanCli = path.join(root, 'clean-target-cli');
    writeJson(path.join(cleanCli, 'settings.json'), { model: 'Original Safe' });
    assert.throws(
      () => importProfile({ inDir: badManifestBundle, cliHome: cleanCli, geminiRoot: path.join(root, 'clean-gem') }),
      /Invalid JSON/,
    );
    assert.equal(readJson(path.join(cleanCli, 'settings.json')).model, 'Original Safe');
  });

  await it('rejects non-file targets during export snapshot phase and removes stale dangling symlinks once unblocked', () => {
    const root = makeTempDir('agy-hud-dangling-out-');
    const geminiRoot = path.join(root, '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    const outDir = path.join(root, 'bundle');
    mkdirSync(cliHome, { recursive: true });
    mkdirSync(outDir, { recursive: true });

    const staleSymlink = path.join(outDir, 'settings.template.json');
    const brokenTarget = path.join(root, 'gone-settings.json');
    symlinkSync(brokenTarget, staleSymlink);

    // Non-file target at plugins-manifest.json is rejected during pre-commit snapshot without mutating outDir.
    mkdirSync(path.join(outDir, 'plugins-manifest.json'), { recursive: true });

    assert.throws(() => exportProfile({ outDir, cliHome, geminiRoot }), /non-file entry/i);
    assert.equal(lstatSync(staleSymlink).isSymbolicLink(), true);
    assert.equal(readlinkSync(staleSymlink), brokenTarget);

    // Unblock plugins-manifest.json; export should now cleanly remove the stale dangling symlink.
    rmSync(path.join(outDir, 'plugins-manifest.json'), { recursive: true, force: true });
    exportProfile({ outDir, cliHome, geminiRoot });
    assert.equal(lstatSync(staleSymlink, { throwIfNoEntry: false }), undefined);
    assert.equal(existsSync(path.join(outDir, 'plugins-manifest.json')), true);
  });

  await it('rolls back earlier commit operations after the first write succeeds and a later write fails', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    // Cross-platform commitPlannedOps mid-commit rollback: ops #1-#3 succeed in writable dirA, op #4 fails in read-only dirB.
    const root = makeTempDir('agy-hud-commit-rb-');
    const dirA = path.join(root, 'writable-a');
    const dirB = path.join(root, 'readonly-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const existingFile = path.join(dirA, 'first.json');
    const newlyCreatedFile = path.join(dirA, 'second-new.json');
    const staleSymlink = path.join(dirA, 'stale-link.json');
    const brokenTarget = path.join(root, 'gone-target.json');
    const blockedTarget = path.join(dirB, 'later.json');

    writeJson(existingFile, { version: 'before' });
    symlinkSync(brokenTarget, staleSymlink);
    chmodSync(dirB, 0o555);
    try {
      assert.throws(
        () =>
          commitPlannedOps([
            { kind: 'write', filePath: existingFile, payload: { version: 'mutated' } },
            { kind: 'write', filePath: newlyCreatedFile, payload: { created: true } },
            { kind: 'delete', filePath: staleSymlink },
            { kind: 'write', filePath: blockedTarget, payload: { blocked: true } },
          ]),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /EACCES|EPERM/);
          assert.match(err.message, /later\.json\.tmp\./);
          return true;
        },
      );
      assert.deepEqual(readJson(existingFile), { version: 'before' }, 'first write must be restored to prior content');
      assert.equal(existsSync(newlyCreatedFile), false, 'newly created second file must be removed on rollback');
      assert.equal(lstatSync(staleSymlink).isSymbolicLink(), true, 'deleted dangling symlink must be restored');
      assert.equal(readlinkSync(staleSymlink), brokenTarget);
      assert.deepEqual(
        readdirSync(dirA).filter((f) => f.includes('.tmp.')),
        [],
      );
    } finally {
      chmodSync(dirB, 0o755);
    }

    // End-to-end exportProfile mid-commit rollback on macOS using immutable plugins-manifest.json.
    if (process.platform === 'darwin') {
      const expRoot = makeTempDir('agy-hud-exp-rb-');
      const geminiRoot = path.join(expRoot, '.gemini');
      const cliHome = path.join(geminiRoot, 'antigravity-cli');
      const outDir = path.join(expRoot, 'bundle');
      const settingsOut = path.join(outDir, 'settings.template.json');
      const hudOut = path.join(outDir, 'hud-config.json');
      const staleConfigLink = path.join(outDir, 'config.template.json');
      const manifestOut = path.join(outDir, 'plugins-manifest.json');
      const brokenConfigTarget = path.join(expRoot, 'missing-config.json');

      writeJson(path.join(cliHome, 'settings.json'), { model: 'Updated Export Model' });
      writeJson(path.join(cliHome, 'hud-config.json'), { ...DEFAULT_HUD_CONFIG, preset: 'minimal' });
      writeJson(settingsOut, { model: 'Original Export Model' });
      symlinkSync(brokenConfigTarget, staleConfigLink);
      writeJson(manifestOut, { exportedAt: 'prior', plugins: [] });

      const chflagsSet = spawnSync('chflags', ['uchg', manifestOut]);
      if (chflagsSet.status === 0) {
        try {
          assert.throws(
            () => exportProfile({ outDir, cliHome, geminiRoot }),
            (err: unknown) => {
              assert.ok(err instanceof Error);
              assert.match(err.message, /EPERM/);
              assert.match(err.message, /plugins-manifest\.json/);
              return true;
            },
          );
          assert.deepEqual(
            readJson(settingsOut),
            { model: 'Original Export Model' },
            'overwritten settings.template.json must roll back after manifest rename fails',
          );
          assert.equal(existsSync(hudOut), false, 'newly written hud-config.json must be removed on export rollback');
          assert.equal(lstatSync(staleConfigLink).isSymbolicLink(), true, 'deleted stale symlink must be restored');
          assert.equal(readlinkSync(staleConfigLink), brokenConfigTarget);
          assert.deepEqual(
            readdirSync(outDir).filter((f) => f.includes('.tmp.')),
            [],
          );
        } finally {
          spawnSync('chflags', ['nouchg', manifestOut]);
        }
      }
    }
  });

  await it('refuses to export when output paths overlap with active CLI config source files', () => {
    const root = makeTempDir('agy-hud-exp-overlap-');
    const geminiRoot = path.join(root, '.gemini');
    const cliHome = path.join(geminiRoot, 'antigravity-cli');
    const liveHudPath = path.join(cliHome, 'hud-config.json');
    const liveHud = {
      ...DEFAULT_HUD_CONFIG,
      preset: 'compact',
      customExtraNote: 'keep-my-live-field',
    };
    writeJson(path.join(cliHome, 'settings.json'), { model: 'Gemini 4 Carbon' });
    writeJson(liveHudPath, liveHud);

    // 1. Exporting directly into cliHome would overwrite live hud-config.json.
    assert.throws(() => exportProfile({ outDir: cliHome, cliHome, geminiRoot }), /overlaps|source/i);
    assert.deepEqual(readJson(liveHudPath), liveHud, 'live hud-config.json must stay untouched');
    assert.equal(existsSync(path.join(cliHome, 'settings.template.json')), false);
    assert.equal(existsSync(path.join(cliHome, 'plugins-manifest.json')), false);

    // 2. Exporting via a symlinked outDir pointing to cliHome must also be rejected.
    const linkedOut = path.join(root, 'linked-cli-home');
    symlinkSync(cliHome, linkedOut, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => exportProfile({ outDir: linkedOut, cliHome, geminiRoot }), /overlaps|source/i);
    assert.deepEqual(readJson(liveHudPath), liveHud);

    // 3. Exporting into a separate dir whose hud-config.json symlinks to live hud-config.json must be rejected.
    const separateOut = path.join(root, 'separate-out');
    mkdirSync(separateOut, { recursive: true });
    symlinkSync(liveHudPath, path.join(separateOut, 'hud-config.json'));
    assert.throws(() => exportProfile({ outDir: separateOut, cliHome, geminiRoot }), /overlaps|source/i);
    assert.deepEqual(readJson(liveHudPath), liveHud);
    assert.equal(existsSync(path.join(separateOut, 'settings.template.json')), false);
  });

  await it('verifies written content ownership before rolling back an earlier committed file', () => {
    const root = makeTempDir('agy-hud-commit-own-');
    const firstFile = path.join(root, 'first.json');
    const secondFile = path.join(root, 'second.json');
    writeJson(firstFile, { version: 'original' });

    const externalOverride = { version: 'external-update' };
    const failingPayload = {
      toJSON(): unknown {
        // Simulate an external actor modifying firstFile after op #1 committed and before op #2 fails.
        writeJson(firstFile, externalOverride);
        throw new Error('simulated second write failure');
      },
    };

    assert.throws(
      () =>
        commitPlannedOps([
          { kind: 'write', filePath: firstFile, payload: { version: 'planned-write' } },
          { kind: 'write', filePath: secondFile, payload: failingPayload },
        ]),
      /simulated second write failure/,
    );
    assert.deepEqual(
      readJson(firstFile),
      externalOverride,
      'rollback must not clobber an external modification that replaced the committed bytes',
    );
  });
});
