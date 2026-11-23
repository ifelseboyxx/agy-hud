import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { moveVerifiedTarget, removeVerifiedStagedPath } from '../fs-ops.ts';
import { isSupportedNodeVersion, NODE_RANGE_LABEL } from '../settings.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

void describe('installer staging identity verification', async () => {
  await it('verifies target identity before moving or deleting staged plugin directories', () => {
    const root = makeTempDir('agy-hud-stage-id-');
    const targetDir = path.join(root, 'plugin');
    const stagedDir = path.join(root, 'plugin.prev.test');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'plugin.json'), JSON.stringify({ name: 'agy-hud' }), 'utf8');
    const precheckedStat = lstatSync(targetDir);

    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'important-user-data.txt'), 'keep', 'utf8');

    assert.throws(() => moveVerifiedTarget(targetDir, precheckedStat, stagedDir), /Target changed/i);
    assert.equal(existsSync(path.join(targetDir, 'important-user-data.txt')), true);
    assert.equal(existsSync(stagedDir), false);

    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(path.join(stagedDir, 'unverified.txt'), 'do-not-delete', 'utf8');
    assert.throws(() => removeVerifiedStagedPath(stagedDir, precheckedStat), /modified staged entry/i);
    assert.equal(existsSync(path.join(stagedDir, 'unverified.txt')), true);
  });
});

void describe('installer Node version gate', async () => {
  await it('aligns installer Node version gate with package.json engines (^22.20.0 || >=24.0.0)', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      engines: Record<string, string>;
    };
    assert.equal(NODE_RANGE_LABEL, pkg.engines.node);
    assert.equal(isSupportedNodeVersion('22.18.0'), false);
    assert.equal(isSupportedNodeVersion('22.19.9'), false);
    assert.equal(isSupportedNodeVersion('22.20.0'), true);
    assert.equal(isSupportedNodeVersion('23.0.0'), false);
    assert.equal(isSupportedNodeVersion('23.11.0'), false);
    assert.equal(isSupportedNodeVersion('24.0.0'), true);
    assert.equal(isSupportedNodeVersion('25.2.0'), true);
  });
});
