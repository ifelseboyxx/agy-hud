import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runDoctor } from '../doctor.ts';
import { runInstallerCli } from '../index.ts';

function seedMockPlugin(dir: string): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), '{"name":"agy-hud"}\n', 'utf8');
  writeFileSync(path.join(dir, 'dist', 'hud.mjs'), "process.stdout.write('ok\\n');\n", 'utf8');
  writeFileSync(path.join(dir, 'dist', 'cli.mjs'), "process.stdout.write('help\\n');\n", 'utf8');
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
});
