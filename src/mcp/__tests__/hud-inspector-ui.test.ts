import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { buildInspectorHtml, INSPECTOR_MIME_TYPE, INSPECTOR_RESOURCE_URI } from '../hud-inspector-ui.ts';

const EMOJI_RE = /\p{Extended_Pictographic}/u;

class FakeElement {
  private readonly matchMap: Record<string, { getAttribute: (name: string) => string | null }>;
  constructor(matchMap: Record<string, { getAttribute: (name: string) => string | null }>) {
    this.matchMap = matchMap;
  }
  closest(selector: string): { getAttribute: (name: string) => string | null } | null {
    return this.matchMap[selector] ?? null;
  }
}

class FakeSelectElement {
  id: string;
  value: string;
  constructor(id: string, value: string) {
    this.id = id;
    this.value = value;
  }
}

class FakeInputElement {
  id: string;
  value: string;
  constructor(id: string, value: string) {
    this.id = id;
    this.value = value;
  }
}

interface MountedInspector {
  posted: Array<Record<string, unknown>>;
  cssVars: Map<string, string>;
  attrs: Map<string, string>;
  shellClasses: Set<string>;
  getHtml: (id: 'global-sess-mount' | 'inspector-main') => string;
  emitHost: (data: Record<string, unknown>) => void;
  click: (matchMap: Record<string, { getAttribute: (name: string) => string | null }>) => void;
  changeSelect: (value: string) => void;
  setVisibility: (state: 'visible' | 'hidden') => void;
  triggerPollTick: () => void;
  isTimerCleared: () => boolean;
}

function mountInspectorSandbox(): MountedInspector {
  const html = buildInspectorHtml();
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match?.[1] !== undefined);

  const posted: Array<Record<string, unknown>> = [];
  const docListeners = new Map<string, Array<(ev: unknown) => void>>();
  const winListeners = new Map<string, Array<(ev: unknown) => void>>();
  const cssVars = new Map<string, string>();
  const attrs = new Map<string, string>();
  const shellClasses = new Set<string>();
  let intervalFn: (() => void) | null = null;
  let timerCleared = false;

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
    setInterval: (fn: () => void, ms: number): number => {
      assert.equal(ms, 2000);
      intervalFn = fn;
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

  vm.runInNewContext(match[1], sandbox);

  return {
    posted,
    cssVars,
    attrs,
    shellClasses,
    getHtml: (id) => elements.get(id)?.innerHTML ?? '',
    emitHost: (data) => {
      for (const fn of winListeners.get('message') ?? []) {
        fn({ data });
      }
    },
    click: (matchMap) => {
      const ev = { target: new FakeElement(matchMap) };
      for (const fn of docListeners.get('click') ?? []) fn(ev);
    },
    changeSelect: (value) => {
      const ev = { target: new FakeSelectElement('va-sess-select', value) };
      for (const fn of docListeners.get('change') ?? []) fn(ev);
    },
    setVisibility: (next) => {
      sandbox.document.visibilityState = next;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
    },
    triggerPollTick: () => {
      intervalFn?.();
    },
    isTimerCleared: () => timerCleared,
  };
}

function makeSamplePayload(overrides?: {
  convId?: string;
  title?: string;
  etag?: string;
  runningTools?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const convId = overrides?.convId ?? 'sess-1';
  const title = overrides?.title ?? 'Live Session';
  return {
    unchanged: false,
    etag: overrides?.etag ?? 'etag-1',
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
      {
        convId: 'sess-2',
        shortId: 'sess-2',
        surface: 'cli',
        title: 'Second Session',
        workspace: '/repo/demo',
        running: true,
        livePid: 4242,
        updatedAtMs: 1_700_000_005_000,
        ageLabel: '1s ago',
      },
    ],
    snapshot: {
      convId,
      shortId: convId,
      surface: convId === 'sess-2' ? 'cli' : 'app',
      title,
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
      runningTools: overrides?.runningTools ?? [],
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
  };
}

function getPollCalls(mounted: MountedInspector): Array<Record<string, unknown>> {
  return mounted.posted.filter(
    (m) => m.method === 'tools/call' && (m.params as Record<string, unknown>).name === 'hud_poll_snapshot',
  );
}

function getPollArgs(msg: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(msg !== undefined);
  return (msg.params as { arguments: Record<string, unknown> }).arguments;
}

async function completeHandshake(mounted: MountedInspector): Promise<void> {
  const initId = mounted.posted[0]?.id as number;
  mounted.emitHost({
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
}

void describe('hud-inspector-ui self-contained MCP App HTML', () => {
  void it('exports the SEP-1865 resource URI constant', () => {
    assert.equal(INSPECTOR_RESOURCE_URI, 'ui://agy-hud/inspector.html');
  });

  void it('exports the mcp-app HTML MIME type constant', () => {
    assert.equal(INSPECTOR_MIME_TYPE, 'text/html;profile=mcp-app');
  });

  void it('produces a CSP-clean document with zero external fetches', () => {
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

  void it('applies initial host theme tokens during SEP-1865 handshake', async () => {
    const mounted = mountInspectorSandbox();
    assert.equal(mounted.posted[0]?.method, 'ui/initialize');
    await completeHandshake(mounted);

    assert.equal(mounted.attrs.get('data-theme'), 'light');
    assert.equal(mounted.cssVars.get('--color-background-primary'), '#fafafa');
    assert.equal(mounted.cssVars.get('--font-sans'), 'TestSans');
    assert.equal(mounted.shellClasses.has('mode-global'), true);
    assert.ok(mounted.posted.some((m) => m.method === 'ui/notifications/initialized'));
  });

  void it('updates theme tokens on host-context-changed notifications', async () => {
    const mounted = mountInspectorSandbox();
    await completeHandshake(mounted);

    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark', styles: { variables: { '--color-text-primary': '#f0f2f5' } } },
    });
    assert.equal(mounted.attrs.get('data-theme'), 'dark');
    assert.equal(mounted.cssVars.get('--color-text-primary'), '#f0f2f5');
  });

  void it('renders clickable running tool file links in Overview', async () => {
    const mounted = mountInspectorSandbox();
    await completeHandshake(mounted);

    const runUri = 'file:///repo/demo/src/live.ts';
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makeSamplePayload({
          runningTools: [
            {
              name: 'edit_file',
              disp: 'edit_file',
              target: 'src/live.ts',
              fullTarget: '/repo/demo/src/live.ts',
              isMcp: false,
              fileUri: runUri,
            },
          ],
        }),
      },
    });

    const overviewHtml = mounted.getHtml('inspector-main');
    assert.ok(overviewHtml.includes('Live Session'));
    assert.ok(overviewHtml.includes(`data-file-uri="${runUri}"`));
    assert.ok(overviewHtml.includes('Tools<span class="va-cnt">2</span>'));
  });

  void it('renders running tools at the top of the Tools tab with toggle-aux-pane links', async () => {
    const mounted = mountInspectorSandbox();
    await completeHandshake(mounted);

    const runUri = 'file:///repo/demo/src/live.ts';
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makeSamplePayload({
          runningTools: [
            {
              name: 'edit_file',
              disp: 'edit_file',
              target: 'src/live.ts',
              fullTarget: '/repo/demo/src/live.ts',
              isMcp: false,
              fileUri: runUri,
            },
          ],
        }),
      },
    });

    mounted.click({ '[data-va-tab]': { getAttribute: () => 'tools' } });
    const toolsHtml = mounted.getHtml('inspector-main');
    assert.ok(toolsHtml.includes('va-run-banner'));
    assert.ok(toolsHtml.includes('edit_file'));
    assert.ok(toolsHtml.includes(`data-file-uri="${runUri}"`));

    mounted.click({ '[data-file-uri]': { getAttribute: () => runUri } });
    const toggleReq = mounted.posted.find((m) => m.method === 'com.google.antigravity/toggle-aux-pane');
    assert.ok(toggleReq !== undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(toggleReq.params)), { tabType: 'fileView', uri: runUri });

    mounted.emitHost({ jsonrpc: '2.0', id: toggleReq.id, error: { code: -32601, message: 'Method not found' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  void it('auto-follows the active session across polls without pinning the first session', async () => {
    const mounted = mountInspectorSandbox();
    await completeHandshake(mounted);

    const firstPoll = getPollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);
    assert.equal('sessionId' in getPollArgs(firstPoll), false);

    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: { structuredContent: makeSamplePayload({ convId: 'sess-1', title: 'Live Session', etag: 'etag-1' }) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(mounted.getHtml('global-sess-mount').includes('global-sess-item on" data-pick-session="sess-1"'));

    mounted.triggerPollTick();
    const polls = getPollCalls(mounted);
    assert.equal(polls.length, 2);
    assert.equal('sessionId' in getPollArgs(polls[1]), false);

    mounted.emitHost({
      jsonrpc: '2.0',
      id: polls[1]?.id,
      result: { structuredContent: makeSamplePayload({ convId: 'sess-2', title: 'Second Session', etag: 'etag-2' }) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(mounted.getHtml('inspector-main').includes('Second Session'));
    assert.ok(mounted.getHtml('global-sess-mount').includes('global-sess-item on" data-pick-session="sess-2"'));
  });

  void it('pins sessionId across subsequent polls after explicit sidebar or dropdown selection', async () => {
    const mounted = mountInspectorSandbox();
    await completeHandshake(mounted);

    const firstPoll = getPollCalls(mounted)[0];
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll?.id,
      result: { structuredContent: makeSamplePayload({ convId: 'sess-2', title: 'Second Session', etag: 'etag-1' }) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    mounted.click({ '[data-pick-session]': { getAttribute: () => 'sess-1' } });
    const pinnedCalls = getPollCalls(mounted);
    assert.equal(getPollArgs(pinnedCalls[1]).sessionId, 'sess-1');

    mounted.emitHost({
      jsonrpc: '2.0',
      id: pinnedCalls[1]?.id,
      result: { structuredContent: makeSamplePayload({ convId: 'sess-1', title: 'Live Session', etag: 'etag-2' }) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    mounted.triggerPollTick();
    const followups = getPollCalls(mounted);
    assert.equal(getPollArgs(followups[2]).sessionId, 'sess-1');

    mounted.emitHost({ jsonrpc: '2.0', id: followups[2]?.id, result: { structuredContent: { unchanged: true } } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    mounted.changeSelect('sess-2');
    assert.equal(getPollArgs(getPollCalls(mounted)[3]).sessionId, 'sess-2');
  });

  void it('pauses periodic polling when document visibility becomes hidden', async () => {
    const mounted = mountInspectorSandbox();
    await completeHandshake(mounted);
    mounted.setVisibility('hidden');
    assert.equal(mounted.isTimerCleared(), true);
  });
});
