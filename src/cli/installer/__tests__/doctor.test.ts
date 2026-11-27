import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runAgyPluginValidate, runDoctor, runHudStdinSmoke } from '../doctor.ts';
import { runInstallerCli } from '../index.ts';
import { installCliShim } from '../shim.ts';

function captureDoctorStdout(run: () => { ok: boolean }): { ok: boolean; stdout: string } {
  let stdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const res = run();
    return { ok: res.ok, stdout };
  } finally {
    process.stdout.write = origWrite;
  }
}

function seedMockPlugin(dir: string): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), '{"name":"agy-hud"}\n', 'utf8');
  writeFileSync(path.join(dir, 'mcp_config.json'), '{"mcpServers":{}}\n', 'utf8');
  writeFileSync(path.join(dir, 'dist', 'hud.mjs'), "process.stdout.write('ok\\n');\n", 'utf8');
  writeFileSync(path.join(dir, 'dist', 'cli.mjs'), "process.stdout.write('help\\n');\n", 'utf8');
  writeFileSync(path.join(dir, 'dist', 'mcp-hud.mjs'), 'process.exit(0);\n', 'utf8');
}

void describe('doctor malformed CLI shim handling', () => {
  let tmpRoot = '';
  let prevCliHome: string | undefined;
  let prevGeminiHome: string | undefined;
  let prevPath: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-doc-unit-'));
    prevCliHome = process.env.GEMINI_CLI_HOME;
    prevGeminiHome = process.env.GEMINI_HOME;
    prevPath = process.env.PATH;
    process.env.GEMINI_CLI_HOME = tmpRoot;
    delete process.env.GEMINI_HOME;
    if (process.platform !== 'win32') {
      process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
    }
  });

  afterEach(() => {
    if (prevCliHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = prevCliHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('keeps standalone doctor passing when an unowned malformed shim is present', () => {
    if (process.platform === 'win32') return;
    const targetDir = path.join(tmpRoot, 'plugin');
    const binDir = path.join(tmpRoot, 'bin');
    seedMockPlugin(targetDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'agy-hud'), '#!/bin/sh\n# agy-hud-shim:v1 target=\n', 'utf8');

    // Isolate PATH so `hasAgyCli()` does not spawn external `agy` during unit test
    process.env.PATH = path.dirname(process.execPath);
    const code = runInstallerCli(['doctor', '--target', targetDir, '--bin-dir', binDir, '--quiet']);
    assert.equal(code, 0);
  });

  void it('fails standalone doctor when a malformed shim claims the resolved pluginBase', () => {
    if (process.platform === 'win32') return;
    const missingTarget = path.join(tmpRoot, 'not-installed');
    const fallbackRepo = path.join(tmpRoot, 'repo-fallback');
    const binDir = path.join(tmpRoot, 'bin');
    seedMockPlugin(fallbackRepo);
    mkdirSync(binDir, { recursive: true });
    const fallbackCli = path.join(fallbackRepo, 'dist', 'cli.mjs');
    // Invalid line 1 (not #!/bin/sh) while line 2 claims fallbackRepo (pluginBase)
    writeFileSync(path.join(binDir, 'agy-hud'), `#!/usr/bin/env sh\n# agy-hud-shim:v1 target=${fallbackCli}\n`, 'utf8');

    const res = runDoctor({
      targetDir: missingTarget,
      quiet: true,
      packageRoot: fallbackRepo,
      binDir,
      requireShim: false,
      noShim: false,
      checkMalformedShim: false,
      agyAvailable: false,
    });
    assert.equal(res.ok, false);
  });

  void it('blocks wire when an unowned malformed shim occupies the target binDir', () => {
    if (process.platform === 'win32') return;
    const targetDir = path.join(tmpRoot, 'plugin');
    const binDir = path.join(tmpRoot, 'bin');
    seedMockPlugin(targetDir);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'agy-hud'), '#!/bin/sh\n# agy-hud-shim:v1 target=\n', 'utf8');

    assert.throws(
      () => runInstallerCli(['wire', '--target', targetDir, '--bin-dir', binDir, '--no-enable', '--quiet']),
      /malformed/i,
    );
  });

  void it('fails wire preflight when mcp_config.json is missing', () => {
    const targetDir = path.join(tmpRoot, 'plugin-no-mcp-cfg');
    seedMockPlugin(targetDir);
    rmSync(path.join(targetDir, 'mcp_config.json'));

    assert.throws(
      () => runInstallerCli(['wire', '--target', targetDir, '--no-shim', '--no-enable', '--quiet']),
      /Missing required file.*mcp_config\.json/,
    );
  });

  void it('fails wire preflight when dist/mcp-hud.mjs is missing', () => {
    const targetDir = path.join(tmpRoot, 'plugin-no-mcp-bin');
    seedMockPlugin(targetDir);
    rmSync(path.join(targetDir, 'dist', 'mcp-hud.mjs'));

    assert.throws(
      () => runInstallerCli(['wire', '--target', targetDir, '--no-shim', '--no-enable', '--quiet']),
      /Missing required file.*dist\/mcp-hud\.mjs/,
    );
  });

  function assertWirePreflightRejectsWithoutMutation(
    tag: string,
    mutatePlugin: (targetDir: string) => void,
    expectedError: RegExp,
  ): void {
    const targetDir = path.join(tmpRoot, `plugin-${tag}`);
    const binDir = path.join(tmpRoot, `bin-${tag}`);
    const cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    const settingsPath = path.join(cliHome, 'settings.json');
    const backupPath = path.join(cliHome, 'cache', 'agy-hud-statusline-backup.json');
    const originalSettings = '{"statusLine":{"type":"command","command":"/prior/hud.sh","enabled":true}}\n';
    seedMockPlugin(targetDir);
    mutatePlugin(targetDir);
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(settingsPath, originalSettings, 'utf8');
    process.env.PATH = path.dirname(process.execPath);

    assert.throws(
      () => runInstallerCli(['wire', '--target', targetDir, '--bin-dir', binDir, '--no-enable', '--quiet']),
      expectedError,
    );
    assert.equal(readFileSync(settingsPath, 'utf8'), originalSettings);
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(path.join(binDir, 'agy-hud')), false);
  }

  void it('fails wire preflight without mutating host files when mcp_config.json is a directory', () => {
    if (process.platform === 'win32') return;
    assertWirePreflightRejectsWithoutMutation(
      'dir-mcp-cfg',
      (targetDir) => {
        rmSync(path.join(targetDir, 'mcp_config.json'));
        mkdirSync(path.join(targetDir, 'mcp_config.json'));
      },
      /Missing required file.*mcp_config\.json/,
    );
  });

  void it('fails wire preflight without mutating host files when mcp_config.json is a dangling symlink', () => {
    if (process.platform === 'win32') return;
    assertWirePreflightRejectsWithoutMutation(
      'dangling-mcp-cfg',
      (targetDir) => {
        rmSync(path.join(targetDir, 'mcp_config.json'));
        symlinkSync(path.join(tmpRoot, 'nonexistent-mcp-config.json'), path.join(targetDir, 'mcp_config.json'));
      },
      /Missing required file.*mcp_config\.json/,
    );
  });

  void it('fails wire preflight without mutating host files when dist/mcp-hud.mjs is a directory', () => {
    if (process.platform === 'win32') return;
    assertWirePreflightRejectsWithoutMutation(
      'dir-mcp-bin',
      (targetDir) => {
        rmSync(path.join(targetDir, 'dist', 'mcp-hud.mjs'));
        mkdirSync(path.join(targetDir, 'dist', 'mcp-hud.mjs'));
      },
      /Missing required file.*dist\/mcp-hud\.mjs/,
    );
  });

  void it('fails wire preflight without mutating host files when dist/mcp-hud.mjs is a dangling symlink', () => {
    if (process.platform === 'win32') return;
    assertWirePreflightRejectsWithoutMutation(
      'dangling-mcp-bin',
      (targetDir) => {
        rmSync(path.join(targetDir, 'dist', 'mcp-hud.mjs'));
        symlinkSync(path.join(tmpRoot, 'nonexistent-mcp-hud.mjs'), path.join(targetDir, 'dist', 'mcp-hud.mjs'));
      },
      /Missing required file.*dist\/mcp-hud\.mjs/,
    );
  });

  void it('allows wire preflight to pass for a Link Install symlinked plugin directory', () => {
    if (process.platform === 'win32') return;
    const realPluginDir = path.join(tmpRoot, 'repo-plugin');
    const linkTargetDir = path.join(tmpRoot, 'linked-plugin');
    const binDir = path.join(tmpRoot, 'bin-link-ok');
    seedMockPlugin(realPluginDir);
    symlinkSync(realPluginDir, linkTargetDir, 'dir');
    process.env.PATH = path.dirname(process.execPath);

    const code = runInstallerCli(['wire', '--target', linkTargetDir, '--bin-dir', binDir, '--no-enable', '--quiet']);
    assert.equal(code, 0);
    assert.equal(existsSync(path.join(binDir, 'agy-hud')), true);
  });

  void it('isolates doctor HUD stdin smoke check from the user CLI Home', () => {
    const mockHudPath = path.join(tmpRoot, 'mock-hud.mjs');
    writeFileSync(
      mockHudPath,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const base = process.env.GEMINI_CLI_HOME || '';",
        "const cacheDir = path.join(base, '.gemini', 'antigravity-cli', 'cache');",
        'mkdirSync(cacheDir, { recursive: true });',
        "writeFileSync(path.join(cacheDir, 'agy_hud_snapshot_doctor-smoke.json'), '{\"v\":1}\\n', 'utf8');",
        "process.stdout.write(base + '\\n');",
      ].join('\n'),
      'utf8',
    );

    const userCliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(userCliHome, { recursive: true });

    const smoke = runHudStdinSmoke(mockHudPath, tmpRoot);
    assert.equal(smoke.ok, true);
    assert.equal(existsSync(path.join(userCliHome, 'cache', 'agy_hud_snapshot_doctor-smoke.json')), false);
    assert.deepEqual(readdirSync(userCliHome), []);
  });
});

void describe('doctor symlink-following artifact checks', () => {
  let tmpRoot = '';
  let prevCliHome: string | undefined;
  let prevGeminiHome: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-doc-stat-'));
    prevCliHome = process.env.GEMINI_CLI_HOME;
    prevGeminiHome = process.env.GEMINI_HOME;
    process.env.GEMINI_CLI_HOME = tmpRoot;
    delete process.env.GEMINI_HOME;
  });

  afterEach(() => {
    if (prevCliHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = prevCliHome;
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('short-circuits doctor as missing dist/hud.mjs when hudPath becomes a dangling symlink', () => {
    if (process.platform === 'win32') return;
    const targetDir = path.join(tmpRoot, 'plugin-dangling-hud');
    const binDir = path.join(tmpRoot, 'bin');
    seedMockPlugin(targetDir);

    const baseline = runDoctor({
      targetDir,
      quiet: true,
      packageRoot: targetDir,
      binDir,
      requireShim: false,
      noShim: true,
      checkMalformedShim: false,
      agyAvailable: false,
    });
    assert.equal(baseline.ok, true);

    rmSync(path.join(targetDir, 'dist', 'hud.mjs'));
    symlinkSync(path.join(tmpRoot, 'missing-hud.mjs'), path.join(targetDir, 'dist', 'hud.mjs'));

    const res = captureDoctorStdout(() =>
      runDoctor({
        targetDir,
        quiet: false,
        packageRoot: targetDir,
        binDir,
        requireShim: false,
        noShim: true,
        checkMalformedShim: false,
        agyAvailable: false,
      }),
    );
    assert.equal(res.ok, false);
    assert.ok(res.stdout.includes('FAILED (missing dist/hud.mjs)'), res.stdout);
  });

  void it('short-circuits doctor as missing dist/hud.mjs when hudPath is replaced by a directory', () => {
    const targetDir = path.join(tmpRoot, 'plugin-dir-hud');
    const binDir = path.join(tmpRoot, 'bin');
    seedMockPlugin(targetDir);

    const baseline = runDoctor({
      targetDir,
      quiet: true,
      packageRoot: targetDir,
      binDir,
      requireShim: false,
      noShim: true,
      checkMalformedShim: false,
      agyAvailable: false,
    });
    assert.equal(baseline.ok, true);

    rmSync(path.join(targetDir, 'dist', 'hud.mjs'));
    mkdirSync(path.join(targetDir, 'dist', 'hud.mjs'));

    const res = captureDoctorStdout(() =>
      runDoctor({
        targetDir,
        quiet: false,
        packageRoot: targetDir,
        binDir,
        requireShim: false,
        noShim: true,
        checkMalformedShim: false,
        agyAvailable: false,
      }),
    );
    assert.equal(res.ok, false);
    assert.ok(res.stdout.includes('FAILED (missing dist/hud.mjs)'), res.stdout);
  });

  void it('short-circuits shim doctor as missing dist/cli.mjs when expectedTarget becomes a dangling symlink', () => {
    if (process.platform === 'win32') return;
    const targetDir = path.join(tmpRoot, 'plugin-dangling-cli');
    const binDir = path.join(tmpRoot, 'bin-cli');
    seedMockPlugin(targetDir);
    installCliShim(binDir, targetDir);

    const baseline = runDoctor({
      targetDir,
      quiet: true,
      packageRoot: targetDir,
      binDir,
      requireShim: true,
      noShim: false,
      checkMalformedShim: true,
      agyAvailable: false,
    });
    assert.equal(baseline.ok, true);

    const cliPath = path.join(targetDir, 'dist', 'cli.mjs');
    rmSync(cliPath);
    symlinkSync(path.join(tmpRoot, 'missing-cli.mjs'), cliPath);

    const res = captureDoctorStdout(() =>
      runDoctor({
        targetDir,
        quiet: false,
        packageRoot: targetDir,
        binDir,
        requireShim: true,
        noShim: false,
        checkMalformedShim: true,
        agyAvailable: false,
      }),
    );
    assert.equal(res.ok, false);
    assert.ok(res.stdout.includes(`FAILED (missing ${cliPath})`), res.stdout);
  });

  void it('tolerates copied root AGENTS.md warning on Plugin Install target distinct from repoRoot', () => {
    if (process.platform === 'win32') return;
    const pluginInstallDir = path.join(tmpRoot, 'installed-plugin-copy');
    const separateRepoRoot = path.join(tmpRoot, 'separate-checkout');
    const fakeBin = path.join(tmpRoot, 'fake-agy-bin');
    seedMockPlugin(pluginInstallDir);
    writeFileSync(path.join(pluginInstallDir, 'AGENTS.md'), '# Repo rules copied by agy plugin install\n', 'utf8');
    mkdirSync(separateRepoRoot, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const fakeAgy = path.join(fakeBin, 'agy');
    writeFileSync(
      fakeAgy,
      [
        '#!/bin/sh',
        'if [ "$4" = "--strict" ]; then',
        '  echo "AGENTS.md: never loaded (1 warning)" >&2',
        '  exit 1',
        'fi',
        'exit 0',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeAgy, 0o755);
    process.env.PATH = `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;

    // Positive control: copied AGENTS.md warning falls back to non-strict and passes even when pluginBase !== repoRoot.
    const okRes = runAgyPluginValidate(pluginInstallDir, separateRepoRoot, 5_000);
    assert.equal(okRes.ok, true);

    // Negative control: when AGENTS.md is absent, --strict failure is surfaced without fallback.
    rmSync(path.join(pluginInstallDir, 'AGENTS.md'));
    const failRes = runAgyPluginValidate(pluginInstallDir, separateRepoRoot, 5_000);
    assert.equal(failRes.ok, false);
  });
});
