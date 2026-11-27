import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  checkExecutableModes,
  compareDistTrees,
  EXPECTED_DIST_FILES,
  parseGitLsFilesModes,
  verifyDistDeclarations,
} from '../scripts/dist-check.mts';
import { evaluateAgyPluginValidationReport, isAllowlistedPluginFinding } from '../scripts/validate-plugin-cli.mts';
import { validatePluginPackageHygiene } from '../scripts/validate-plugin-manifest.ts';
import { createTempDirTracker, REPO_ROOT, writeJson } from './helpers.ts';

const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

function writeValidPluginFixture(rootDir: string): void {
  writeJson(path.join(rootDir, 'package.json'), { name: 'agy-hud', version: '0.1.0' });
  writeJson(path.join(rootDir, 'plugin.json'), {
    $schema: 'https://antigravity.google/schemas/v1/plugin.json',
    name: 'agy-hud',
    displayName: 'Agy HUD',
    version: '0.1.0',
    description:
      'Live terminal HUD statusline and Antigravity App HUD Inspector showing model, quotas, throughput, Git diff stats, cost, and swarm activity.',
    logo: 'assets/logo.svg',
    suggestedPrompts: ['/hud setup', '/hud check', '/hud configure'],
    author: { name: 'ifelseboyxx', url: 'https://github.com/ifelseboyxx' },
    homepage: 'https://github.com/ifelseboyxx/agy-hud',
    repository: 'https://github.com/ifelseboyxx/agy-hud',
    license: 'MIT',
    keywords: ['hud', 'statusline', 'telemetry'],
  });
  writeJson(path.join(rootDir, 'mcp_config.json'), {
    mcpServers: {
      inspector: {
        command: 'node',
        args: ['${PLUGIN_ROOT}/dist/mcp-hud.mjs'],
      },
    },
  });
  mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
  writeFileSync(
    path.join(rootDir, 'assets', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128"/></svg>\n',
    'utf8',
  );
  mkdirSync(path.join(rootDir, 'dist'), { recursive: true });
  writeFileSync(path.join(rootDir, 'dist', 'mcp-hud.mjs'), '#!/usr/bin/env node\n', 'utf8');
  writeFileSync(path.join(rootDir, 'README.md'), '# Agy HUD\n\nMarketplace documentation.\n', 'utf8');
}

void describe('dist:check tree and executable mode verification', () => {
  void it('passes on matching 6-file standalone trees and catches missing, stale, or drifted files', () => {
    const root = tracker.makeTempDir('agy-hud-dist-cmp-');
    const actual = path.join(root, 'actual');
    const expected = path.join(root, 'expected');
    mkdirSync(actual, { recursive: true });
    mkdirSync(expected, { recursive: true });

    for (const rel of EXPECTED_DIST_FILES) {
      writeFileSync(path.join(actual, rel), `// ${rel}\n`, 'utf8');
      writeFileSync(path.join(expected, rel), `// ${rel}\n`, 'utf8');
    }

    // Positive control: identical 6-file trees pass.
    assert.deepEqual(compareDistTrees(actual, expected), []);

    // Negative: byte drift on one file.
    writeFileSync(path.join(actual, 'hud.mjs'), '// drifted\n', 'utf8');
    const driftErrors = compareDistTrees(actual, expected);
    assert.ok(driftErrors.some((e) => e.includes('dist/hud.mjs') && e.includes('out of date')));
    writeFileSync(path.join(actual, 'hud.mjs'), '// hud.mjs\n', 'utf8');

    // Negative: stale chunk file left behind.
    mkdirSync(path.join(actual, 'chunks'), { recursive: true });
    writeFileSync(path.join(actual, 'chunks', 'old-abc.mjs'), 'export {};\n', 'utf8');
    const staleErrors = compareDistTrees(actual, expected);
    assert.ok(staleErrors.some((e) => e.includes('chunks/old-abc.mjs') && e.includes('unexpected or stale')));
    rmSync(path.join(actual, 'chunks'), { recursive: true, force: true });

    // Negative: missing tracked file.
    rmSync(path.join(actual, 'cli.mjs'));
    const missingErrors = compareDistTrees(actual, expected);
    assert.ok(missingErrors.some((e) => e.includes('dist/cli.mjs') && e.includes('missing')));
    writeFileSync(path.join(actual, 'cli.mjs'), '// cli.mjs\n', 'utf8');

    // Negative: extra 7th file emitted in both actual and fresh build must still fail.
    writeFileSync(path.join(actual, 'extra.mjs'), 'export {};\n', 'utf8');
    writeFileSync(path.join(expected, 'extra.mjs'), 'export {};\n', 'utf8');
    const seventhErrors = compareDistTrees(actual, expected);
    assert.ok(seventhErrors.some((e) => e.includes('dist/extra.mjs') && e.includes('strictly 6 standalone files')));
    rmSync(path.join(actual, 'extra.mjs'));
    rmSync(path.join(expected, 'extra.mjs'));

    // Negative: stray symlink or empty directory inside dist/ must fail.
    if (process.platform !== 'win32') {
      symlinkSync(path.join(actual, 'hud.mjs'), path.join(actual, 'alias.mjs'));
      const symErrors = compareDistTrees(actual, expected);
      assert.ok(symErrors.some((e) => e.includes('symlink dist/alias.mjs')));
      rmSync(path.join(actual, 'alias.mjs'));
    }
    mkdirSync(path.join(actual, 'empty-dir'), { recursive: true });
    const dirErrors = compareDistTrees(actual, expected);
    assert.ok(dirErrors.some((e) => e.includes('directory dist/empty-dir')));
  });

  void it('verifies POSIX execute bits and parses git ls-files index modes', () => {
    const root = tracker.makeTempDir('agy-hud-dist-mode-');
    const hudRel = 'dist/hud.mjs';
    const hudAbs = path.join(root, hudRel);
    mkdirSync(path.dirname(hudAbs), { recursive: true });
    writeFileSync(hudAbs, '#!/usr/bin/env node\n', 'utf8');
    if (process.platform !== 'win32') {
      chmodSync(hudAbs, 0o755);
      // Positive control: executable bit present.
      assert.deepEqual(checkExecutableModes(root, [hudRel], 'linux'), []);

      // Negative: execute bit stripped.
      chmodSync(hudAbs, 0o644);
      const modeErrors = checkExecutableModes(root, [hudRel], 'linux');
      assert.ok(modeErrors.some((e) => e.includes('missing POSIX execute bits')));
    }

    const parsed = parseGitLsFilesModes(
      [
        '100755 abcdef0123456789012345678901234567890123 0\tdist/hud.mjs',
        '100644 1234567890abcdef1234567890abcdef12345678 0\tdist/cli.mjs',
      ].join('\n'),
    );
    assert.equal(parsed.get('dist/hud.mjs'), '100755');
    assert.equal(parsed.get('dist/cli.mjs'), '100644');
  });

  void it('verifies standalone .d.mts declarations compile cleanly and catches unresolved .ts imports', () => {
    // Positive control: real built dist/ declarations have zero TypeScript diagnostics.
    assert.deepEqual(verifyDistDeclarations(path.join(REPO_ROOT, 'dist')), []);

    // Negative control: broken .ts specifier inside index.d.mts fails closed.
    const brokenDist = tracker.makeTempDir('agy-hud-broken-dts-');
    writeFileSync(path.join(brokenDist, 'types.d.mts'), 'export interface DemoOpts { show?: boolean; }\n', 'utf8');
    writeFileSync(
      path.join(brokenDist, 'index.d.mts'),
      'export { configureHud } from "./cli/configure.ts";\nexport * from "./types.mjs";\n',
      'utf8',
    );
    const dtsErrors = verifyDistDeclarations(brokenDist);
    assert.ok(dtsErrors.some((e) => e.includes('./cli/configure.ts')));

    // Negative control 2: missing type import inside index.d.mts (caught by skipLibCheck: false).
    writeFileSync(
      path.join(brokenDist, 'index.d.mts'),
      'export declare function demo(opts?: UndeclaredMissingType): void;\nexport * from "./types.mjs";\n',
      'utf8',
    );
    const undeclaredErrors = verifyDistDeclarations(brokenDist);
    assert.ok(undeclaredErrors.some((e) => e.includes('UndeclaredMissingType')));
  });
});

void describe('Layer 1 offline plugin package hygiene validator', () => {
  void it('passes on the real repository root', () => {
    assert.deepEqual(validatePluginPackageHygiene(REPO_ROOT), []);
  });

  void it('passes on a valid fixture and rejects schema, brand, version, logo, mcp, and root violations', () => {
    const root = tracker.makeTempDir('agy-hud-manifest-hygiene-');
    writeValidPluginFixture(root);
    // Positive control.
    assert.deepEqual(validatePluginPackageHygiene(root), []);

    // Unknown property, bad schema, brand prefix, version mismatch, object repository.
    writeJson(path.join(root, 'plugin.json'), {
      $schema: 'https://example.com/bad.json',
      name: 'antigravity-hud',
      displayName: 'Agy HUD Plugin',
      version: '9.9.9',
      description: 'too short',
      logo: 'assets/logo.svg',
      suggestedPrompts: [],
      author: { name: 'tester', url: 'http://insecure.example' },
      homepage: 'http://insecure.example',
      repository: { type: 'git', url: 'https://github.com/example/repo' },
      license: '',
      keywords: ['BadTag'],
      extraField: true,
    });
    const manifestErrors = validatePluginPackageHygiene(root);
    assert.ok(manifestErrors.some((e) => e.includes("unknown property 'extraField'")));
    assert.ok(manifestErrors.some((e) => e.includes("'$schema'")));
    assert.ok(manifestErrors.some((e) => e.includes('brand prefix/suffix')));
    assert.ok(manifestErrors.some((e) => e.includes('must match package.json version')));
    assert.ok(manifestErrors.some((e) => e.includes('string https:// URL')));

    // Restore valid fixture, then test logo, mcp env, missing target, and forbidden root paths.
    writeValidPluginFixture(root);
    writeFileSync(path.join(root, 'assets', 'logo.svg'), '<svg viewBox="0 0 64 64" width="64" height="64"/>', 'utf8');
    writeJson(path.join(root, 'mcp_config.json'), {
      mcpServers: {
        inspector: {
          command: 'node',
          args: ['${PLUGIN_ROOT}/dist/missing.mjs'],
          env: { PLUGIN_ROOT: '${PLUGIN_ROOT}' },
        },
      },
    });
    writeFileSync(path.join(root, 'GEMINI.md'), '# forbidden\n', 'utf8');
    mkdirSync(path.join(root, 'rules'), { recursive: true });
    const hygieneErrors = validatePluginPackageHygiene(root);
    assert.ok(hygieneErrors.some((e) => e.includes('viewBox must be 1:1 and >= 128x128')));
    assert.ok(hygieneErrors.some((e) => e.includes("must not duplicate 'PLUGIN_ROOT'")));
    assert.ok(hygieneErrors.some((e) => e.includes("target 'dist/missing.mjs' does not exist")));
    assert.ok(hygieneErrors.some((e) => e.includes('GEMINI.md: forbidden')));
    assert.ok(hygieneErrors.some((e) => e.includes('rules: forbidden')));
    // Negative: leading-zero SemVer rejected even if package.json matches.
    writeValidPluginFixture(root);
    writeJson(path.join(root, 'package.json'), { name: 'agy-hud', version: '01.2.3' });
    writeJson(path.join(root, 'plugin.json'), {
      ...JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8')),
      version: '01.2.3',
    });
    const leadingZeroErrors = validatePluginPackageHygiene(root);
    assert.ok(leadingZeroErrors.some((e) => e.includes('valid semver')));

    // Negative: logo path escaping repo root must be rejected.
    writeValidPluginFixture(root);
    writeJson(path.join(root, 'plugin.json'), {
      ...JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8')),
      logo: '../outside.svg',
    });
    const escapeErrors = validatePluginPackageHygiene(root);
    assert.ok(escapeErrors.some((e) => e.includes('must stay inside repository root')));
  });
});

void describe('Layer 2 agy plugin validate JSON evaluator', () => {
  void it('allowlists only the root AGENTS.md warning and enforces exact component counts', () => {
    assert.equal(isAllowlistedPluginFinding({ severity: 'warning', file: 'AGENTS.md', message: 'never loaded' }), true);
    assert.equal(isAllowlistedPluginFinding({ severity: 'error', file: 'AGENTS.md', message: 'err' }), false);
    assert.equal(isAllowlistedPluginFinding({ severity: 'warning', file: 'README.md', message: 'warn' }), false);

    // Positive control: allowlisted AGENTS.md warning + expected components.
    const passingJson = JSON.stringify({
      name: 'agy-hud',
      components: { skills: 1, mcpServers: 1, hooks: 0, rules: 0 },
      findings: [{ severity: 'warning', file: 'AGENTS.md', message: 'never loaded' }],
    });
    assert.deepEqual(evaluateAgyPluginValidationReport(passingJson), []);

    // Negative: empty or malformed report missing required fields must fail closed.
    const emptyErrors = evaluateAgyPluginValidationReport('{}');
    assert.ok(emptyErrors.some((e) => e.includes('missing non-empty plugin name')));
    assert.ok(emptyErrors.some((e) => e.includes('missing findings array')));
    assert.ok(emptyErrors.some((e) => e.includes('missing components summary')));

    // Negative: mismatched plugin name must fail closed even when component counts match.
    const wrongNameJson = JSON.stringify({
      name: 'other-plugin',
      components: { skills: 1, mcpServers: 1, hooks: 0, rules: 0 },
      findings: [],
    });
    const wrongNameErrors = evaluateAgyPluginValidationReport(wrongNameJson);
    assert.ok(wrongNameErrors.some((e) => e.includes("expected 'agy-hud', got 'other-plugin'")));

    // Negative: extra warning, error, or unexpected component counts.
    const failingJson = JSON.stringify({
      name: 'agy-hud',
      components: { skills: 2, mcpServers: 1, hooks: 1, rules: 1 },
      findings: [
        { severity: 'warning', file: 'AGENTS.md', message: 'never loaded' },
        { severity: 'warning', file: 'skills/hud/SKILL.md', message: 'unexpected warning' },
        { severity: 'error', file: 'plugin.json', message: 'bad field' },
      ],
    });
    const errors = evaluateAgyPluginValidationReport(failingJson);
    assert.ok(errors.some((e) => e.includes('skills/hud/SKILL.md')));
    assert.ok(errors.some((e) => e.includes('plugin.json')));
    assert.ok(errors.some((e) => e.includes('components.skills === 1')));
    assert.ok(errors.some((e) => e.includes('components.hooks === 0')));
    assert.ok(errors.some((e) => e.includes('components.rules === 0')));
  });
});

void describe('CI and Release workflow security and gate contracts', () => {
  void it('enforces dist:check before verify, plugin validation, least-privilege permissions, and safe tag handling', () => {
    const ciYml = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const releaseYml = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

    for (const [label, yml] of [
      ['ci.yml', ciYml],
      ['release.yml', releaseYml],
    ] as const) {
      assert.match(yml, /^permissions:\r?\n\s+contents:\s*read/m, `${label} must set read-only top-level permissions`);
      assert.match(yml, /^concurrency:/m, `${label} must declare concurrency`);
      assert.match(yml, /timeout-minutes:/, `${label} must declare job timeouts`);
      const distCheckIdx = yml.indexOf('pnpm dist:check');
      const verifyIdx = yml.indexOf('pnpm verify');
      assert.ok(distCheckIdx > 0 && verifyIdx > distCheckIdx, `${label} must run pnpm dist:check before pnpm verify`);
      assert.ok(yml.includes('pnpm validate:plugin'), `${label} must run pnpm validate:plugin`);
      assert.ok(yml.includes('agy plugin install .'), `${label} must smoke-test isolated agy plugin install .`);
      assert.ok(
        yml.includes("skills.includes('hud')") && yml.includes("mcps.includes('inspector')"),
        `${label} must assert installed hud skill and inspector MCP in isolated smoke test`,
      );
      assert.ok(
        !yml.includes('echo "${{ github.ref_name }}"'),
        `${label} must not interpolate ref_name directly in shell`,
      );
    }

    assert.ok(ciYml.includes('ubuntu-latest') && ciYml.includes('macos-latest') && ciYml.includes('windows-latest'));
    assert.ok(releaseYml.includes('RELEASE_TAG: ${{ github.ref_name }}'));
    assert.ok(releaseYml.includes('(?:0|[1-9]\\d*)'));
    assert.ok(releaseYml.includes('single-segment semver'));
    assert.ok(releaseYml.includes('.zip') && releaseYml.includes('agy plugin install'));
  });
});
