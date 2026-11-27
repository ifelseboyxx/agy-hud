import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Marked, type Renderer, type Tokens } from 'marked';

import { getErrCode, isFiniteNum, nonEmptyStr } from '../src/core/guards.ts';
import { isMainEntry, isSameOrDescendantPath, toPosixPath } from '../src/core/paths.ts';

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_CSS_REL = path.join('node_modules', 'github-markdown-css', 'github-markdown.css');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const RELOAD_DEBOUNCE_MS = 80;
const HEADER_NAV_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'docs/architecture.md',
  'docs/host-contracts.md',
  'CODING_STANDARDS.md',
  'GLOSSARY.md',
] as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

export interface DocsDevCliOptions {
  readonly help: boolean;
  readonly host: string;
  readonly port: number;
  readonly explicitPort: boolean;
  readonly open: boolean;
}

export interface DocsDevServerOptions {
  readonly rootDir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly explicitPort?: boolean;
  readonly debounceMs?: number;
  readonly watchFiles?: boolean;
  readonly signal?: AbortSignal;
}

export interface DocsDevServerHandle {
  readonly url: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Generate GitHub-compatible anchor slugs with per-document deduplication. */
export function slugifyGithubHeading(text: string, seenCounts?: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!seenCounts) return base;
  const count = seenCounts.get(base) ?? 0;
  seenCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function escapeDocsHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parsePortValue(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid port: ${raw}`);
  const parsed = Number.parseInt(raw, 10);
  if (!isFiniteNum(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Port out of range (0..65535): ${raw}`);
  }
  return parsed;
}

/** Parse CLI arguments and environment overrides for the docs preview server. */
export function parseDocsDevArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): DocsDevCliOptions {
  let help = false;
  let host = nonEmptyStr(env.HOST) ?? DEFAULT_HOST;
  const envPort = nonEmptyStr(env.PORT);
  let port = envPort !== undefined ? parsePortValue(envPort) : DEFAULT_PORT;
  let explicitPort = envPort !== undefined;
  let open = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '--port' || arg === '-p') {
      const next = argv[++i];
      if (!next) throw new Error(`Missing value after ${arg}`);
      port = parsePortValue(next);
      explicitPort = true;
    } else if (arg.startsWith('--port=')) {
      port = parsePortValue(arg.slice('--port='.length));
      explicitPort = true;
    } else if (arg === '--host') {
      const next = argv[++i];
      if (!next) throw new Error('Missing value after --host');
      host = next;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { help, host, port, explicitPort, open };
}

export type ResolvedDocsPath =
  | { readonly kind: 'ok'; readonly relPosix: string; readonly absPath: string }
  | { readonly kind: 'forbidden' | 'not_found' };

/** Resolve a URL pathname to a safe, allowlisted repository doc or asset file. */
export function resolveDocsAssetPath(rootDir: string, urlPathname: string): ResolvedDocsPath {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return { kind: 'not_found' };
  }
  const trimmed = decoded === '/' ? 'README.md' : decoded.replace(/^\/+/, '');
  const segments = trimmed.split('/');
  if (
    trimmed.length === 0 ||
    segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..' || seg.startsWith('.'))
  ) {
    return { kind: 'forbidden' };
  }
  const topDir = segments[0] ?? '';
  if (topDir === 'node_modules' || topDir === 'dist' || topDir === 'coverage') {
    return { kind: 'forbidden' };
  }

  const realRoot = realpathSync(rootDir);
  const candidate = path.resolve(realRoot, ...segments);
  if (!existsSync(candidate)) {
    return { kind: 'not_found' };
  }
  const realTarget = realpathSync(candidate);
  if (!isSameOrDescendantPath(realRoot, realTarget) || !statSync(realTarget).isFile()) {
    return { kind: 'forbidden' };
  }

  const relPosix = toPosixPath(path.relative(realRoot, realTarget));
  const ext = path.extname(relPosix).toLowerCase();
  const isDocOrLicense = ext === '.md' || relPosix === 'LICENSE';
  const isAllowedAsset = (relPosix.startsWith('assets/') || relPosix.startsWith('docs/')) && ext in CONTENT_TYPES;
  if (!isDocOrLicense && !isAllowedAsset) {
    return { kind: 'forbidden' };
  }
  return { kind: 'ok', relPosix, absPath: realTarget };
}

/** Render GitHub-flavored Markdown into a standalone HTML page using github-markdown-css. */
export function renderMarkdownDocument(
  markdown: string,
  options: { readonly currentPath: string; readonly title?: string; readonly navDocs?: readonly string[] },
): string {
  const seenSlugs = new Map<string, number>();
  const parser = new Marked({
    gfm: true,
    renderer: {
      heading(this: Renderer, { tokens, depth }: Tokens.Heading): string {
        const inner = this.parser.parseInline(tokens);
        const plain = this.parser.parseInline(tokens, this.parser.textRenderer);
        const id = slugifyGithubHeading(plain, seenSlugs);
        return `<h${depth} id="${escapeDocsHtml(id)}">${inner}</h${depth}>\n`;
      },
    },
  });

  const bodyHtml = parser.parse(markdown, { async: false });
  const title = options.title ?? options.currentPath;
  const navDocs = options.navDocs ?? [];
  const navLinks = navDocs
    .map((doc) => {
      const href = doc === 'README.md' ? '/' : `/${doc}`;
      const cls = doc === options.currentPath ? 'nav-link active' : 'nav-link';
      return `<a class="${cls}" href="${escapeDocsHtml(href)}">${escapeDocsHtml(doc)}</a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeDocsHtml(title)} — agy-hud docs</title>
  <link rel="stylesheet" href="/__dev/github-markdown.css">
  <style>
    :root { color-scheme: light dark; --page-bg: #ffffff; --page-fg: #1f2328; --bar-bg: #f6f8fa; --bar-border: #d1d9e0; }
    @media (prefers-color-scheme: dark) {
      :root { --page-bg: #0d1117; --page-fg: #f0f6fc; --bar-bg: #151b23; --bar-border: #3d444d; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--page-bg); color: var(--page-fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .topbar { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 24px; background: var(--bar-bg); border-bottom: 1px solid var(--bar-border); font-size: 13px; }
    .nav-group { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .nav-link { color: inherit; text-decoration: none; opacity: 0.72; padding: 2px 6px; border-radius: 6px; }
    .nav-link:hover { opacity: 1; text-decoration: underline; }
    .nav-link.active { opacity: 1; font-weight: 600; background: rgba(127, 127, 127, 0.14); }
    .live-badge { font-size: 12px; opacity: 0.7; }
    .markdown-body { max-width: 980px; margin: 0 auto; padding: 32px 32px 64px; }
    .markdown-body summary { cursor: pointer; }
    @media (max-width: 767px) { .markdown-body { padding: 16px; } .topbar { padding: 10px 16px; } }
  </style>
</head>
<body>
  <header class="topbar">
    <nav class="nav-group" aria-label="Documentation">${navLinks}</nav>
    <span class="live-badge">Live reload</span>
  </header>
  <main class="markdown-body">${bodyHtml}</main>
  <script>
    (() => {
      const es = new EventSource('/__dev/events');
      es.addEventListener('reload', () => { location.reload(); });
    })();
  </script>
</body>
</html>`;
}

function sendTextResponse(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function listenWithFallback(server: Server, host: string, port: number, explicitPort: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      server.removeListener('error', onError);
      const addr = server.address() as AddressInfo | null;
      resolve(addr?.port ?? port);
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      if (getErrCode(err) === 'EADDRINUSE' && !explicitPort && port !== 0) {
        server.listen(0, host);
        return;
      }
      server.removeListener('listening', onListening);
      reject(err);
    };
    server.once('listening', onListening);
    server.on('error', onError);
    server.listen(port, host);
  });
}

function attachReloadWatchers(
  rootDir: string,
  debounceMs: number,
  onReload: (changed: string) => void,
): {
  watchers: FSWatcher[];
  clearTimer: () => void;
} {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = (label: string): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onReload(label);
    }, debounceMs);
  };

  const watchTargets: Array<{ abs: string; recursive: boolean }> = [{ abs: rootDir, recursive: false }];
  for (const sub of ['docs', 'assets']) {
    const abs = path.join(rootDir, sub);
    if (existsSync(abs)) watchTargets.push({ abs, recursive: true });
  }

  for (const target of watchTargets) {
    const watcher = watch(target.abs, { recursive: target.recursive }, (_ev, rawName) => {
      if (typeof rawName !== 'string' || rawName.length === 0) return;
      const ext = path.extname(rawName).toLowerCase();
      if (ext === '.md' || ext in CONTENT_TYPES || rawName === 'LICENSE') {
        trigger(toPosixPath(rawName));
      }
    });
    watcher.on('error', () => {
      // Ignore transient watcher errors during atomic file replacements.
    });
    watchers.push(watcher);
  }
  return {
    watchers,
    clearTimer: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Start the local README and documentation preview server with SSE live reload. */
export async function startDocsDevServer(options: DocsDevServerOptions = {}): Promise<DocsDevServerHandle> {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const explicitPort = options.explicitPort ?? false;
  const debounceMs = options.debounceMs ?? RELOAD_DEBOUNCE_MS;
  const cssPath = path.join(DEFAULT_ROOT_DIR, GITHUB_CSS_REL);
  const navDocs = HEADER_NAV_DOCS.filter((rel) => existsSync(path.join(rootDir, rel)));
  const sseClients = new Set<ServerResponse>();

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendTextResponse(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/__dev/github-markdown.css') {
      const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
      sendTextResponse(res, 200, css, 'text/css; charset=utf-8');
      return;
    }
    if (pathname === '/__dev/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    const resolved = resolveDocsAssetPath(rootDir, pathname);
    if (resolved.kind !== 'ok') {
      const code = resolved.kind === 'forbidden' ? 403 : 404;
      sendTextResponse(res, code, code === 403 ? 'Forbidden' : 'Not Found', 'text/plain; charset=utf-8');
      return;
    }

    const ext = path.extname(resolved.relPosix).toLowerCase();
    if (ext === '.md') {
      const md = readFileSync(resolved.absPath, 'utf8');
      const html = renderMarkdownDocument(md, { currentPath: resolved.relPosix, navDocs });
      sendTextResponse(res, 200, html, 'text/html; charset=utf-8');
      return;
    }
    const contentType = CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(resolved.absPath));
  };

  const server = createServer(handleRequest);
  const actualPort = await listenWithFallback(server, host, requestedPort, explicitPort);
  const url = `http://${host}:${actualPort}/`;
  const watchState =
    options.watchFiles === false
      ? { watchers: [] as FSWatcher[], clearTimer: (): void => {} }
      : attachReloadWatchers(rootDir, debounceMs, (changed) => {
          for (const client of sseClients) {
            client.write(`event: reload\ndata: ${changed}\n\n`);
          }
        });

  let closed = false;
  let abortListener: (() => void) | null = null;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    watchState.clearTimer();
    for (const watcher of watchState.watchers) watcher.close();
    if (options.signal && abortListener) {
      options.signal.removeEventListener('abort', abortListener);
      abortListener = null;
    }
    for (const client of sseClients) client.end();
    sseClients.clear();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  if (options.signal) {
    if (options.signal.aborted) {
      await close();
      return { url, port: actualPort, close };
    }
    abortListener = () => {
      void close();
    };
    options.signal.addEventListener('abort', abortListener, { once: true });
  }
  return { url, port: actualPort, close };
}

function openBrowserUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
}

async function runDocsDevCli(): Promise<void> {
  const opts = parseDocsDevArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      `agy-hud dev\n\nUsage: pnpm dev [--port <n>] [--host <addr>] [--open]\nPreview README.md, README.zh-CN.md, and docs/ locally in your browser.\n`,
    );
    return;
  }

  const handle = await startDocsDevServer({
    host: opts.host,
    port: opts.port,
    explicitPort: opts.explicitPort,
  });
  process.stdout.write(`[docs] preview server running at ${handle.url}\n`);
  process.stdout.write(`[docs] watching README & docs for live reload (Ctrl+C to stop)\n`);
  if (opts.open) openBrowserUrl(handle.url);

  const shutdown = (): void => {
    void handle.close().then(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isMainEntry(import.meta.url)) {
  void runDocsDevCli().catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${detail}\n`);
    process.exitCode = 1;
  });
}
