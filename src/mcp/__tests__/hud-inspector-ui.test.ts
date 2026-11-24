import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { buildInspectorHtml, INSPECTOR_MIME_TYPE, INSPECTOR_RESOURCE_URI } from '../hud-inspector-ui.ts';

const EMOJI_RE = /\p{Extended_Pictographic}/u;

void describe('hud-inspector-ui self-contained MCP App HTML', () => {
  void it('exports SEP-1865 resource URI and mcp-app MIME type', () => {
    assert.equal(INSPECTOR_RESOURCE_URI, 'ui://agy-hud/inspector.html');
    assert.equal(INSPECTOR_MIME_TYPE, 'text/html;profile=mcp-app');
  });

  void it('produces a CSP-clean document compliant with default-src none and zero external fetches', () => {
    const html = buildInspectorHtml();
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('<script>'));
    assert.equal(/<link\b/i.test(html), false, 'must not contain external <link> tags');
    assert.equal(/<script\b[^>]*\bsrc=/i.test(html), false, 'must not contain external <script src>');
    assert.equal(/https?:\/\//i.test(html), false, 'must not reference external http(s) URLs');
    assert.equal(/\bfetch\s*\(/i.test(html), false, 'must not call fetch()');
    assert.equal(/\b(?:XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/.test(html), false);
    assert.ok(Buffer.byteLength(html, 'utf8') < 200_000);
  });

  void it('contains zero pictographic emoji characters', () => {
    const html = buildInspectorHtml();
    assert.equal(EMOJI_RE.test(html), false, 'HTML/CSS/JS must not contain pictographic emoji');
  });

  void it('embeds syntactically valid inline JavaScript', () => {
    const html = buildInspectorHtml();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    const scriptCode = match?.[1];
    assert.ok(scriptCode !== undefined && scriptCode.trim().length > 0);
    assert.doesNotThrow(() => new vm.Script(scriptCode));
  });

  void it('wires SEP-1865 theming, 2s visibility-gated polling, Variant A tabs, and toggle-aux-pane', () => {
    const html = buildInspectorHtml();
    assert.ok(html.includes('--color-background-primary'));
    assert.ok(html.includes('--color-text-primary'));
    assert.ok(html.includes('--color-border-primary'));
    assert.ok(html.includes('--font-sans'));
    assert.ok(html.includes('ui/initialize'));
    assert.ok(html.includes('ui/notifications/initialized'));
    assert.ok(html.includes('ui/notifications/host-context-changed'));
    assert.ok(html.includes('ui/notifications/tool-result'));
    assert.ok(html.includes('hud_poll_snapshot'));
    assert.ok(html.includes('2000'));
    assert.ok(html.includes('visibilityState'));
    assert.ok(html.includes('com.google.antigravity/toggle-aux-pane'));
    assert.ok(html.includes('fileView'));
    assert.ok(html.includes('-32601'));
    assert.ok(html.includes('Skills &amp; MCP'));
    assert.ok(html.includes('global-sess-list'));
  });

  void it('executes SEP-1865 handshake, host theme sync, tool-result rendering, and -32601 fileView handling', async () => {
    const html = buildInspectorHtml();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match?.[1] !== undefined);

    const posted: Array<Record<string, unknown>> = [];
    const docListeners = new Map<string, Array<(ev: unknown) => void>>();
    const winListeners = new Map<string, Array<(ev: unknown) => void>>();
    const cssVars = new Map<string, string>();
    const attrs = new Map<string, string>();
    const shellClasses = new Set<string>();

    const elements = new Map<
      string,
      { id: string; innerHTML: string; classList: { toggle: (c: string, on: boolean) => void } }
    >([
      [
        'app-shell',
        {
          id: 'app-shell',
          innerHTML: '',
          classList: {
            toggle: (c: string, on: boolean): void => {
              if (on) shellClasses.add(c);
              else shellClasses.delete(c);
            },
          },
        },
      ],
      ['global-sess-mount', { id: 'global-sess-mount', innerHTML: '', classList: { toggle: () => {} } }],
      ['inspector-main', { id: 'inspector-main', innerHTML: '', classList: { toggle: () => {} } }],
    ]);

    class FakeElement {
      private readonly matchMap: Record<string, { getAttribute: (name: string) => string | null }>;
      constructor(matchMap: Record<string, { getAttribute: (name: string) => string | null }>) {
        this.matchMap = matchMap;
      }
      closest(selector: string): { getAttribute: (name: string) => string | null } | null {
        return this.matchMap[selector] ?? null;
      }
    }
    class FakeSelectElement {}
    class FakeInputElement {}

    let timerCleared = false;
    const sandbox = {
      Element: FakeElement,
      HTMLSelectElement: FakeSelectElement,
      HTMLInputElement: FakeInputElement,
      Map,
      Promise,
      Object,
      Array,
      Number,
      String,
      Boolean,
      Math,
      JSON,
      setInterval: (_fn: () => void, ms: number): number => {
        assert.equal(ms, 2000);
        return 42;
      },
      clearInterval: (id: number): void => {
        if (id === 42) timerCleared = true;
      },
      document: {
        visibilityState: 'visible',
        activeElement: null,
        documentElement: {
          setAttribute: (k: string, v: string): void => {
            attrs.set(k, v);
          },
          style: {
            colorScheme: '',
            setProperty: (k: string, v: string): void => {
              cssVars.set(k, v);
            },
          },
        },
        getElementById: (id: string) => elements.get(id) ?? null,
        addEventListener: (type: string, fn: (ev: unknown) => void): void => {
          docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
        },
      },
      window: {
        parent: {
          postMessage: (msg: Record<string, unknown>): void => {
            posted.push(msg);
          },
        },
        addEventListener: (type: string, fn: (ev: unknown) => void): void => {
          winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
        },
      },
    };

    const emitHost = (data: Record<string, unknown>): void => {
      for (const fn of winListeners.get('message') ?? []) {
        fn({ data });
      }
    };

    vm.runInNewContext(match[1], sandbox);
    assert.equal(posted[0]?.method, 'ui/initialize');
    const initId = posted[0]?.id as number;

    emitHost({
      jsonrpc: '2.0',
      id: initId,
      result: {
        protocolVersion: '2026-01-26',
        hostCapabilities: {},
        hostContext: {
          theme: 'light',
          styles: {
            variables: {
              '--color-background-primary': '#fafafa',
              '--font-sans': 'TestSans',
            },
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(attrs.get('data-theme'), 'light');
    assert.equal(cssVars.get('--color-background-primary'), '#fafafa');
    assert.equal(cssVars.get('--font-sans'), 'TestSans');
    assert.equal(shellClasses.has('mode-global'), true);
    assert.ok(posted.some((m) => m.method === 'ui/notifications/initialized'));
    assert.ok(
      posted.some(
        (m) => m.method === 'tools/call' && (m.params as Record<string, unknown>).name === 'hud_poll_snapshot',
      ),
    );

    emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: {
        theme: 'dark',
        styles: { variables: { '--color-text-primary': '#f0f2f5' } },
      },
    });
    assert.equal(attrs.get('data-theme'), 'dark');
    assert.equal(cssVars.get('--color-text-primary'), '#f0f2f5');

    emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: {
          unchanged: false,
          etag: 'etag-1',
          source: 'auto',
          sessions: [
            {
              convId: 'sess-1',
              shortId: 'sess-1',
              surface: 'app',
              title: 'Live Session',
              workspace: '/repo/demo',
              running: true,
              livePid: null,
              updatedAtMs: 1_700_000_000_000,
              ageLabel: '2s ago',
            },
          ],
          snapshot: {
            convId: 'sess-1',
            shortId: 'sess-1',
            surface: 'app',
            title: 'Live Session',
            model: 'Gemini 4 Carbon',
            workspace: '/repo/demo',
            resolutionTier: 'fallback',
            running: true,
            updatedAtMs: 1_700_000_000_000,
            ageLabel: '2s ago',
            livePid: null,
            siblingCandidates: [],
            siblingHint: '',
            telemetry: {
              genCount: 2,
              tps: 95,
              ttft: 1.25,
              cachePct: 92,
              ctxUsed: 50_000,
              ctxMax: 1_000_000,
              ctxPct: 5,
            },
            runningTools: [],
            completedTools: [
              {
                disp: 'read_file',
                count: 3,
                latestTarget: 'src/app.ts',
                fullTarget: '/repo/demo/src/app.ts',
                recentTargets: ['/repo/demo/src/app.ts'],
                targetUris: { '/repo/demo/src/app.ts': 'file:///repo/demo/src/app.ts' },
                isMcp: false,
              },
            ],
            totalToolCalls: 3,
            skills: ['tdd'],
            mcps: [{ server: 'github', totalCalls: 2, subtools: [{ name: 'get_issue', count: 2 }] }],
            agentsKind: 'swarm',
            agents: [{ name: 'Coder', type: 'coder', model: 'G4', state: 'working', ts: null, ageLabel: 'live' }],
            todos: null,
          },
        },
      },
    });

    const mainHtml = elements.get('inspector-main')?.innerHTML ?? '';
    assert.ok(mainHtml.includes('Live Session'));
    assert.ok(mainHtml.includes('5%'));
    assert.ok(mainHtml.includes('95'));
    assert.ok(mainHtml.includes('1.25s'));
    assert.ok(mainHtml.includes('92%'));
    assert.ok(mainHtml.includes('Swarm'));
    assert.ok(mainHtml.includes('file:///repo/demo/src/app.ts'));

    const clickEv = {
      target: new FakeElement({
        '[data-file-uri]': { getAttribute: () => 'file:///repo/demo/src/app.ts' },
      }),
    };
    for (const fn of docListeners.get('click') ?? []) fn(clickEv);

    const toggleReq = posted.find((m) => m.method === 'com.google.antigravity/toggle-aux-pane');
    assert.ok(toggleReq !== undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(toggleReq.params)), {
      tabType: 'fileView',
      uri: 'file:///repo/demo/src/app.ts',
    });

    // Host replies with -32601 in global mode; app must ignore without throwing.
    emitHost({ jsonrpc: '2.0', id: toggleReq.id, error: { code: -32601, message: 'Method not found' } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    sandbox.document.visibilityState = 'hidden';
    for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
    assert.equal(timerCleared, true);
  });
});
