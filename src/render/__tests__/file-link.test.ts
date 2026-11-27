import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createWorkspaceRegularFileChecker } from '../../core/fs-utils.ts';
import { resolveSnapshotMarkdownUri } from '../../hud-snapshot-publish.ts';
import { resolveMarkdownFileTargetLink, toSafeLocalFileUri } from '../file-link.ts';
import { renderSnapshotMarkdownWithDigest } from '../osc8-markdown.ts';

void describe('hardened OSC 8 and Markdown local file:/// links', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-filelink-'));
  });

  afterEach(() => {
    if (tmpRoot.length > 0) rmSync(tmpRoot, { recursive: true, force: true });
  });

  void it('percent-encodes #, ?, &, parentheses, brackets, and pipes cleanly in pure URI construction', () => {
    // Pure URI construction handles Windows-illegal '?' without touching disk
    const syntheticHome = path.join(tmpRoot, 'dev#1', 'q?dir');
    const target = resolveSnapshotMarkdownUri(syntheticHome, 'conv-hash-1');
    assert.ok(target !== null);
    assert.ok(target.uri.startsWith('file:///'));
    assert.ok(target.uri.includes('dev%231'));
    assert.ok(target.uri.includes('q%3Fdir'));
    assert.equal(target.uri.includes('#'), false);
    assert.equal(target.uri.includes('?'), false);

    // CommonMark entity character '&' must be percent-encoded so href never decodes &amp; to a different file
    const ampPath = path.join(tmpRoot, 'report&amp;log.txt');
    const ampUri = resolveMarkdownFileTargetLink('report&amp;log.txt:9', tmpRoot, (p) => p === ampPath);
    assert.ok(ampUri !== null);
    assert.equal(ampUri.includes('&'), false, ampUri);
    assert.ok(ampUri.includes('report%26amp;log.txt#L9'), ampUri);

    const routeFile = path.join(tmpRoot, 'routes', '#id', 'page.tsx');
    mkdirSync(path.dirname(routeFile), { recursive: true });
    writeFileSync(routeFile, 'export default null;\n', 'utf8');
    const checker = createWorkspaceRegularFileChecker(tmpRoot);
    const mdUri = resolveMarkdownFileTargetLink('routes/#id/page.tsx:12:4', tmpRoot, checker);
    assert.ok(mdUri !== null);
    assert.ok(mdUri.includes('%23id/page.tsx#L12C4'), mdUri);

    const parenFile = path.join(tmpRoot, 'report) [draft](2).ts');
    writeFileSync(parenFile, 'export const p = 1;\n', 'utf8');
    const parenUri = resolveMarkdownFileTargetLink('report) [draft](2).ts:7', tmpRoot, checker);
    assert.ok(parenUri !== null);
    assert.equal(parenUri.includes(')'), false, parenUri);
    assert.equal(parenUri.includes('('), false, parenUri);
    assert.equal(parenUri.includes('['), false, parenUri);
    assert.equal(parenUri.includes(']'), false, parenUri);
    assert.ok(parenUri.includes('%29') && parenUri.includes('%5B') && parenUri.endsWith('#L7'), parenUri);

    // Pure check works on all platforms including Windows for '|'
    const pipePath = path.join(tmpRoot, 'a|b.ts');
    const pipeUri = resolveMarkdownFileTargetLink('a|b.ts:3', tmpRoot, (p) => p === pipePath);
    assert.ok(pipeUri !== null);
    assert.equal(pipeUri.includes('|'), false, pipeUri);
    assert.ok(pipeUri.includes('a%7Cb.ts#L3'), pipeUri);
  });

  void it('preserves literal POSIX foo:12 filenames as foo%3A12 before splitting :line[:col]', () => {
    const literalColon = path.join(tmpRoot, 'foo:12');
    const pureLiteral = resolveMarkdownFileTargetLink('foo:12', tmpRoot, (p) => p === literalColon);
    assert.ok(pureLiteral !== null);
    assert.ok(pureLiteral.endsWith('/foo%3A12'), pureLiteral);
    assert.equal(pureLiteral.includes('#L12'), false);

    const normalFile = path.join(tmpRoot, 'bar.ts');
    writeFileSync(normalFile, 'export const x = 1;\n', 'utf8');
    const checker = createWorkspaceRegularFileChecker(tmpRoot);
    const lineUri = resolveMarkdownFileTargetLink('bar.ts:42', tmpRoot, checker);
    assert.ok(lineUri !== null && lineUri.endsWith('/bar.ts#L42'), String(lineUri));
    assert.equal(resolveMarkdownFileTargetLink('bar.ts:0', tmpRoot, checker), null);

    if (process.platform !== 'win32') {
      writeFileSync(literalColon, 'literal\n', 'utf8');
      const diskChecker = createWorkspaceRegularFileChecker(tmpRoot);
      const diskLiteral = resolveMarkdownFileTargetLink('foo:12', tmpRoot, diskChecker);
      assert.ok(diskLiteral !== null && diskLiteral.endsWith('/foo%3A12'), String(diskLiteral));
    }
  });

  void it('rejects Windows UNC paths, control bytes, missing workspace, workspace escapes, and oversized URIs', () => {
    const okFile = path.join(tmpRoot, 'safe.ts');
    writeFileSync(okFile, 'ok\n', 'utf8');
    const checker = createWorkspaceRegularFileChecker(tmpRoot);
    assert.ok(toSafeLocalFileUri(okFile)?.startsWith('file:///'));
    assert.ok(resolveMarkdownFileTargetLink('safe.ts', tmpRoot, checker)?.startsWith('file:///'));
    assert.ok(resolveMarkdownFileTargetLink(okFile, tmpRoot, checker)?.startsWith('file:///'));

    // Missing workspace must reject even existing absolute paths (keep plain text)
    assert.equal(
      resolveMarkdownFileTargetLink(okFile, undefined, () => true),
      null,
    );
    assert.equal(
      resolveMarkdownFileTargetLink(okFile, '', () => true),
      null,
    );

    // Blocked attack vectors
    assert.equal(toSafeLocalFileUri('\\\\evil-server\\share\\payload.txt'), null);
    assert.equal(toSafeLocalFileUri('//evil-server/share/payload.txt'), null);
    assert.equal(resolveMarkdownFileTargetLink('\\\\evil-server\\share\\a.ts', tmpRoot, checker), null);
    assert.equal(toSafeLocalFileUri(path.join(tmpRoot, 'bad\x1b[31m.ts')), null);
    assert.equal(toSafeLocalFileUri(path.join(tmpRoot, 'bad\x07.ts')), null);
    assert.equal(resolveMarkdownFileTargetLink('../outside.ts', tmpRoot, checker), null);
    assert.equal(toSafeLocalFileUri(path.join(tmpRoot, 'a'.repeat(4200))), null);

    // Symlinked intermediate directory pointing outside workspace must be blocked
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-outside-'));
    try {
      const secretFile = path.join(outsideDir, 'secret.txt');
      writeFileSync(secretFile, 'secret\n', 'utf8');
      symlinkSync(outsideDir, path.join(tmpRoot, 'escape-dir'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(resolveMarkdownFileTargetLink('escape-dir/secret.txt', tmpRoot, checker), null);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  void it('keeps Markdown rendering pure and preserves object-shaped agent_state Phase identically to string form', () => {
    const baseOpts = {
      convId: 'conv-phase-obj-1',
      activity: null,
      agentsSummary: null,
      nowMs: 1_000_000,
    };
    const fromString = renderSnapshotMarkdownWithDigest({
      ...baseOpts,
      data: { conversation_id: 'conv-phase-obj-1', agent_state: 'working' },
    });
    const fromObject = renderSnapshotMarkdownWithDigest({
      ...baseOpts,
      data: { conversation_id: 'conv-phase-obj-1', agent_state: { state: 'working' } },
    });
    assert.ok(fromString.markdown.includes('- **Phase**: `working`'));
    assert.equal(fromObject.markdown, fromString.markdown);
    assert.equal(fromObject.contentDigest, fromString.contentDigest);
  });
});
