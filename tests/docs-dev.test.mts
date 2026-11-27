import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  parseDocsDevArgs,
  renderMarkdownDocument,
  resolveDocsAssetPath,
  slugifyGithubHeading,
  startDocsDevServer,
} from '../scripts/dev.mts';
import { createTempDirTracker, REPO_ROOT } from './helpers.ts';

const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

function httpGetText(url: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      })
      .on('error', reject);
  });
}

void describe('docs preview helpers', () => {
  void it('generates GitHub-style ASCII and CJK heading slugs with deduplication', () => {
    const seen = new Map<string, number>();
    assert.equal(slugifyGithubHeading('Quick start', seen), 'quick-start');
    assert.equal(slugifyGithubHeading('快速开始', seen), '快速开始');
    assert.equal(slugifyGithubHeading('配置与自定义', seen), '配置与自定义');
    assert.equal(slugifyGithubHeading('Quick start', seen), 'quick-start-1');
  });

  void it('parses port, host, and open flags with env fallback', () => {
    assert.deepEqual(parseDocsDevArgs([], {}), {
      help: false,
      host: '127.0.0.1',
      port: 4173,
      explicitPort: false,
      open: false,
    });
    assert.deepEqual(parseDocsDevArgs(['--port', '4200', '--open'], { HOST: '0.0.0.0' }), {
      help: false,
      host: '0.0.0.0',
      port: 4200,
      explicitPort: true,
      open: true,
    });
  });

  void it('blocks traversal, dotfiles, and source code paths in resolveDocsAssetPath', () => {
    assert.equal(resolveDocsAssetPath(REPO_ROOT, '/').kind, 'ok');
    assert.equal(resolveDocsAssetPath(REPO_ROOT, '/assets/logo.svg').kind, 'ok');
    assert.equal(resolveDocsAssetPath(REPO_ROOT, '/docs/architecture.md').kind, 'ok');
    assert.equal(resolveDocsAssetPath(REPO_ROOT, '/../package.json').kind, 'forbidden');
    assert.equal(resolveDocsAssetPath(REPO_ROOT, '/.git/HEAD').kind, 'forbidden');
    assert.equal(resolveDocsAssetPath(REPO_ROOT, '/package.json').kind, 'forbidden');
    assert.equal(resolveDocsAssetPath(REPO_ROOT, '/src/hud-entry.ts').kind, 'forbidden');
  });

  void it('renders GitHub hero alignment, details blocks, and heading anchors', () => {
    const html = renderMarkdownDocument('# Title\n\n## Quick start\n\n| A | B |\n| :--- | :--- |\n| 1 | 2 |\n', {
      currentPath: 'README.md',
      navDocs: ['README.md', 'README.zh-CN.md'],
    });
    assert.ok(html.includes('<h2 id="quick-start">Quick start</h2>'));
    assert.ok(html.includes('href="/README.zh-CN.md"'));
    assert.ok(html.includes('<table>'));
  });
});

void describe('startDocsDevServer', async () => {
  await it('serves README.md, README.zh-CN.md, assets, CSS, and blocks forbidden routes', async () => {
    const server = await startDocsDevServer({ rootDir: REPO_ROOT, port: 0, watchFiles: false });
    try {
      const home = await httpGetText(server.url);
      assert.equal(home.status, 200);
      assert.match(home.contentType, /^text\/html/);
      assert.ok(home.body.includes('<h1 id="agy-hud">agy-hud</h1>'));
      assert.ok(home.body.includes('<h2 id="install">Install</h2>'));
      assert.ok(home.body.includes('src="assets/logo.svg"'));

      const zh = await httpGetText(`${server.url}README.zh-CN.md`);
      assert.equal(zh.status, 200);
      assert.ok(zh.body.includes('<h2 id="安装">安装</h2>'));

      const logo = await httpGetText(`${server.url}assets/logo.svg`);
      assert.equal(logo.status, 200);
      assert.match(logo.contentType, /^image\/svg\+xml/);

      const css = await httpGetText(`${server.url}__dev/github-markdown.css`);
      assert.equal(css.status, 200);
      assert.ok(css.body.includes('.markdown-body'));

      const blocked = await httpGetText(`${server.url}package.json`);
      assert.equal(blocked.status, 403);
    } finally {
      await server.close();
    }
  });

  await it('emits SSE reload events when a watched markdown file changes', async () => {
    const root = tracker.makeTempDir('agy-hud-docs-sse-');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), '# Initial\n', 'utf8');

    const controller = new AbortController();
    const server = await startDocsDevServer({
      rootDir: root,
      port: 0,
      debounceMs: 20,
      signal: controller.signal,
    });

    try {
      const reloadReceived = await new Promise<string>((resolve, reject) => {
        let writeCount = 0;
        let retryTimer: ReturnType<typeof setInterval> | null = null;
        const stopTimers = (): void => {
          clearTimeout(timeout);
          if (retryTimer !== null) {
            clearInterval(retryTimer);
            retryTimer = null;
          }
        };
        const bumpFile = (): void => {
          writeCount += 1;
          writeFileSync(path.join(root, 'README.md'), `# Updated ${writeCount}\n`, 'utf8');
        };
        const timeout = setTimeout(() => {
          stopTimers();
          reject(new Error('Timed out waiting for SSE reload'));
        }, 5000);
        const req = http.get(`${server.url}__dev/events`, (res) => {
          let buf = '';
          let triggered = false;
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            if (!triggered && buf.includes(': connected')) {
              triggered = true;
              bumpFile();
              retryTimer = setInterval(bumpFile, 250);
            }
            if (buf.includes('event: reload')) {
              stopTimers();
              res.destroy();
              resolve(buf);
            }
          });
        });
        req.on('error', (err) => {
          stopTimers();
          reject(err);
        });
      });
      assert.ok(reloadReceived.includes('event: reload'));
    } finally {
      controller.abort();
      await server.close();
    }
  });
});
