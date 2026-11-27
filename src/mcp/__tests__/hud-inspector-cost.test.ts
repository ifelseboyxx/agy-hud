import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { buildInspectorHtml } from '../hud-inspector-ui.ts';

function renderInspectorHtmlWithSnapshot(snapshot: Record<string, unknown>): string {
  const html = buildInspectorHtml();
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match?.[1] !== undefined);

  const mainEl = { id: 'inspector-main', innerHTML: '', classList: { toggle: () => {} } };
  const sideEl = { id: 'global-sess-mount', innerHTML: '', classList: { toggle: () => {} } };
  const shellEl = { id: 'app-shell', innerHTML: '', classList: { toggle: () => {} } };
  const winListeners = new Map<string, Array<(ev: unknown) => void>>();

  const sandbox = {
    Element: class {},
    HTMLSelectElement: class {},
    HTMLInputElement: class {},
    Map,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    setInterval: () => 1,
    clearInterval: () => {},
    document: {
      visibilityState: 'visible',
      activeElement: null,
      documentElement: { setAttribute: () => {}, style: { colorScheme: '', setProperty: () => {} } },
      getElementById: (id: string) =>
        id === 'inspector-main' ? mainEl : id === 'global-sess-mount' ? sideEl : id === 'app-shell' ? shellEl : null,
      addEventListener: () => {},
    },
    window: {
      parent: { postMessage: () => {} },
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
      },
    },
  };

  vm.runInNewContext(match[1], sandbox);
  for (const fn of winListeners.get('message') ?? []) {
    fn({
      source: sandbox.window.parent,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          structuredContent: {
            unchanged: false,
            etag: 'etag-cost-1',
            source: 'auto',
            sessions: [],
            snapshot,
          },
        },
      },
    });
  }
  return mainEl.innerHTML;
}

function makeBaseSnapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    convId: 'sess-cost-1',
    shortId: 'sess-cos',
    surface: 'cli',
    title: 'Cost Session',
    model: 'Gemini 4 Carbon',
    workspace: '/repo/demo',
    resolutionTier: 'explicit',
    running: true,
    updatedAtMs: 1_700_000_000_000,
    ageLabel: '1s ago',
    livePid: 4242,
    siblingCandidates: [],
    siblingHint: '',
    telemetry: { genCount: 2, tps: 90, ttft: 1.2, cachePct: 85, ctxUsed: 40_000, ctxMax: 200_000, ctxPct: 20 },
    cost: null,
    costCurrency: 'both',
    usdToCnyRate: 7.25,
    runningTools: [],
    completedTools: [],
    totalToolCalls: 0,
    skills: [],
    mcps: [],
    agentsKind: 'agents',
    agents: [],
    todos: null,
    ...overrides,
  };
}

void describe('HUD Inspector Telemetry Ribbon cost visibility', () => {
  void it('renders formatted dual-currency cost with subagent tooltip when CLI cost is present', () => {
    const html = renderInspectorHtmlWithSnapshot(
      makeBaseSnapshot({
        cost: { totalUsd: 0.818, subagentUsd: 0.21, estimated: true },
        costCurrency: 'both',
        usdToCnyRate: 7.25,
      }),
    );
    assert.ok(html.includes('Cost <strong>~$0.818 / ¥5.93</strong>'));
    assert.ok(html.includes('Subagents: $0.210 / ¥1.52'));
    assert.ok(html.includes('Estimated pricing'));
  });

  void it('omits Cost pill cleanly when native App session has no stdin cost', () => {
    const html = renderInspectorHtmlWithSnapshot(
      makeBaseSnapshot({
        surface: 'app',
        livePid: null,
        cost: null,
        costCurrency: 'both',
      }),
    );
    assert.equal(html.includes('Cost <strong>'), false);
    assert.ok(html.includes('TPS <strong>90</strong>'));
  });
});
