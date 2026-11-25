import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import { buildInspectorHtml } from '../hud-inspector-ui.ts';

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

interface MountedPollingSandbox {
  posted: Array<Record<string, unknown>>;
  getHtml: (id: 'global-sess-mount' | 'inspector-main') => string;
  emitHost: (data: Record<string, unknown>) => void;
  emitWindow: (type: string) => void;
  click: (matchMap: Record<string, { getAttribute: (name: string) => string | null }>) => void;
  selectSession: (value: string) => void;
  triggerPollTick: () => void;
  fireLatestTimeout: () => void;
  activeTimeoutCount: () => number;
  hasActiveInterval: () => boolean;
  totalListenerCount: () => number;
}

function mountPollingSandbox(): MountedPollingSandbox {
  const html = buildInspectorHtml();
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match?.[1] !== undefined);

  const posted: Array<Record<string, unknown>> = [];
  const docListeners = new Map<string, Array<(ev: unknown) => void>>();
  const winListeners = new Map<string, Array<(ev: unknown) => void>>();
  const timeouts = new Map<number, () => void>();
  let nextTimerId = 1;
  let intervalFn: (() => void) | null = null;

  const elements = new Map<string, { id: string; innerHTML: string; classList: { toggle: () => void } }>([
    ['app-shell', { id: 'app-shell', innerHTML: '', classList: { toggle: () => {} } }],
    ['global-sess-mount', { id: 'global-sess-mount', innerHTML: '', classList: { toggle: () => {} } }],
    ['inspector-main', { id: 'inspector-main', innerHTML: '', classList: { toggle: () => {} } }],
  ]);

  const sandbox = {
    Element: FakeElement,
    HTMLSelectElement: FakeSelectElement,
    HTMLInputElement: FakeInputElement,
    Error,
    Map,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    setTimeout: (fn: () => void): number => {
      const id = nextTimerId++;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (id: number): void => {
      timeouts.delete(id);
    },
    setInterval: (fn: () => void): number => {
      intervalFn = fn;
      return 1000;
    },
    clearInterval: (): void => {
      intervalFn = null;
    },
    document: {
      visibilityState: 'visible',
      activeElement: null,
      documentElement: {
        setAttribute: (): void => {},
        style: { colorScheme: '', setProperty: (): void => {} },
      },
      getElementById: (id: string) => elements.get(id) ?? null,
      addEventListener: (type: string, fn: (ev: unknown) => void): void => {
        docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
      },
      removeEventListener: (type: string, fn: (ev: unknown) => void): void => {
        docListeners.set(
          type,
          (docListeners.get(type) ?? []).filter((entry) => entry !== fn),
        );
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
      removeEventListener: (type: string, fn: (ev: unknown) => void): void => {
        winListeners.set(
          type,
          (winListeners.get(type) ?? []).filter((entry) => entry !== fn),
        );
      },
    },
  };

  vm.runInNewContext(match[1], sandbox);

  return {
    posted,
    getHtml: (id) => elements.get(id)?.innerHTML ?? '',
    emitHost: (data) => {
      for (const fn of winListeners.get('message') ?? []) fn({ data });
    },
    emitWindow: (type) => {
      for (const fn of winListeners.get(type) ?? []) fn({});
    },
    click: (matchMap) => {
      const ev = { target: new FakeElement(matchMap) };
      for (const fn of docListeners.get('click') ?? []) fn(ev);
    },
    selectSession: (value) => {
      const ev = { target: new FakeSelectElement('va-sess-select', value) };
      for (const fn of docListeners.get('change') ?? []) fn(ev);
    },
    triggerPollTick: () => {
      intervalFn?.();
    },
    fireLatestTimeout: () => {
      const ids = [...timeouts.keys()];
      const lastId = ids[ids.length - 1];
      assert.ok(lastId !== undefined, 'expected an active request timeout');
      const fn = timeouts.get(lastId);
      timeouts.delete(lastId);
      fn?.();
    },
    activeTimeoutCount: () => timeouts.size,
    hasActiveInterval: () => intervalFn !== null,
    totalListenerCount: () => {
      let total = 0;
      for (const list of docListeners.values()) total += list.length;
      for (const list of winListeners.values()) total += list.length;
      return total;
    },
  };
}

function makePayload(opts: { convId: string; title: string; etag: string; source?: string }): Record<string, unknown> {
  return {
    unchanged: false,
    etag: opts.etag,
    source: opts.source ?? 'auto',
    sessions: [
      {
        convId: opts.convId,
        shortId: opts.convId,
        surface: opts.source === 'cli' ? 'cli' : 'app',
        title: opts.title,
        workspace: '/repo/demo',
        running: true,
        livePid: null,
        updatedAtMs: 1_700_000_000_000,
        ageLabel: '1s ago',
      },
    ],
    snapshot: {
      convId: opts.convId,
      shortId: opts.convId,
      surface: opts.source === 'cli' ? 'cli' : 'app',
      title: opts.title,
      model: 'Gemini 4 Carbon',
      workspace: '/repo/demo',
      resolutionTier: 'explicit',
      running: true,
      updatedAtMs: 1_700_000_000_000,
      ageLabel: '1s ago',
      livePid: null,
      siblingCandidates: [],
      siblingHint: '',
      telemetry: { genCount: 1, tps: 90, ttft: 1.0, cachePct: 90, ctxUsed: 10_000, ctxMax: 1_000_000, ctxPct: 1 },
      runningTools: [],
      completedTools: [],
      totalToolCalls: 0,
      skills: [],
      mcps: [],
      agentsKind: 'agents',
      agents: [],
      todos: null,
    },
  };
}

function pollCalls(mounted: MountedPollingSandbox): Array<Record<string, unknown>> {
  return mounted.posted.filter(
    (m) => m.method === 'tools/call' && (m.params as Record<string, unknown>).name === 'hud_poll_snapshot',
  );
}

function pollArgs(msg: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(msg !== undefined);
  return (msg.params as { arguments: Record<string, unknown> }).arguments;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function finishInit(mounted: MountedPollingSandbox): Promise<void> {
  const initId = mounted.posted[0]?.id as number;
  mounted.emitHost({
    jsonrpc: '2.0',
    id: initId,
    result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostContext: {} },
  });
  await flushMicrotasks();
}

void describe('hud-inspector interleaved polling recovery', () => {
  void it('drops stale session response when user switches session mid-flight', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);

    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);

    // User switches to sess-2 while firstPoll is still in flight.
    mounted.click({ '[data-pick-session]': { getAttribute: () => 'sess-2' } });
    assert.equal(pollCalls(mounted).length, 1);

    // Stale firstPoll resolves with sess-1 and etag-stale.
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: { structuredContent: makePayload({ convId: 'sess-1', title: 'Stale Session', etag: 'etag-stale' }) },
    });
    await flushMicrotasks();

    // Stale response must not render, and queued poll for sess-2 must fire without stale etag.
    assert.equal(mounted.getHtml('inspector-main').includes('Stale Session'), false);
    const polls = pollCalls(mounted);
    assert.equal(polls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(pollArgs(polls[1]))), { sessionId: 'sess-2' });

    mounted.emitHost({
      jsonrpc: '2.0',
      id: polls[1]?.id,
      result: { structuredContent: makePayload({ convId: 'sess-2', title: 'Target Session', etag: 'etag-2' }) },
    });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Target Session'));
  });

  void it('drops stale response when source filter changes while poll is in flight', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);

    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);

    // Switch source filter from auto -> app while firstPoll (auto) is still in flight.
    mounted.click({ '[data-src-filter]': { getAttribute: () => 'app' } });

    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: {
        structuredContent: makePayload({
          convId: 'cli-1',
          title: 'Old Auto Result',
          etag: 'etag-auto',
          source: 'auto',
        }),
      },
    });
    await flushMicrotasks();

    assert.equal(mounted.getHtml('inspector-main').includes('Old Auto Result'), false);
    const polls = pollCalls(mounted);
    assert.equal(polls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(pollArgs(polls[1]))), { source: 'app' });
  });

  void it('discards pushed tool-result notification that does not match selected session', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);

    mounted.click({ '[data-pick-session]': { getAttribute: () => 'sess-2' } });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makePayload({ convId: 'sess-1', title: 'Wrong Pushed Session', etag: 'etag-wrong' }),
      },
    });
    await flushMicrotasks();

    assert.equal(mounted.getHtml('inspector-main').includes('Wrong Pushed Session'), false);
  });

  void it('allows subsequent poll retry after a timed-out request', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);

    const hungPoll = pollCalls(mounted)[0];
    assert.ok(hungPoll !== undefined);
    assert.equal(mounted.activeTimeoutCount(), 1);

    // Host drops response; timeout fires.
    mounted.fireLatestTimeout();
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Request timed out'));

    // Next interval poll must be allowed now that inFlight cleared.
    mounted.triggerPollTick();
    const polls = pollCalls(mounted);
    assert.equal(polls.length, 2);

    // Late response for hungPoll must be ignored.
    mounted.emitHost({
      jsonrpc: '2.0',
      id: hungPoll.id,
      result: {
        structuredContent: makePayload({ convId: 'sess-old', title: 'Late Hung Response', etag: 'etag-late' }),
      },
    });
    await flushMicrotasks();
    assert.equal(mounted.getHtml('inspector-main').includes('Late Hung Response'), false);

    // Retry response succeeds and renders cleanly.
    mounted.emitHost({
      jsonrpc: '2.0',
      id: polls[1]?.id,
      result: { structuredContent: makePayload({ convId: 'sess-ok', title: 'Recovered Session', etag: 'etag-ok' }) },
    });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Recovered Session'));
  });

  void it('clears timeout error banner when subsequent poll recovers with unchanged true', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);

    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: {
        structuredContent: makePayload({ convId: 'sess-steady', title: 'Steady Session', etag: 'etag-steady' }),
      },
    });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Steady Session'));

    // Next conditional poll sends etag-steady and times out.
    mounted.triggerPollTick();
    const secondPoll = pollCalls(mounted)[1];
    assert.equal(pollArgs(secondPoll).etag, 'etag-steady');
    mounted.fireLatestTimeout();
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Request timed out'));

    // Recovery poll succeeds with unchanged: true; stale timeout banner must disappear.
    mounted.triggerPollTick();
    const thirdPoll = pollCalls(mounted)[2];
    assert.ok(thirdPoll !== undefined);
    mounted.emitHost({
      jsonrpc: '2.0',
      id: thirdPoll.id,
      result: { structuredContent: { unchanged: true, etag: 'etag-steady' } },
    });
    await flushMicrotasks();
    assert.equal(mounted.getHtml('inspector-main').includes('Request timed out'), false);
    assert.ok(mounted.getHtml('inspector-main').includes('Steady Session'));
  });

  void it('drops late pushed tool-result after switching from a pinned session back to Auto', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);

    mounted.click({ '[data-pick-session]': { getAttribute: () => 'sess-2' } });
    mounted.selectSession('');
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makePayload({ convId: 'sess-2', title: 'Stale Pinned Push', etag: 'etag-stale-push' }),
      },
    });
    await flushMicrotasks();

    assert.equal(mounted.getHtml('inspector-main').includes('Stale Pinned Push'), false);
  });

  void it('queues poll when tool-input arrives before ui/initialize settles', async () => {
    const mounted = mountPollingSandbox();
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: makePayload({ convId: 'sess-initial', title: 'Initial Push', etag: 'etag-init' }) },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { sessionId: 'sess-target', source: 'cli' } },
    });
    await finishInit(mounted);

    const polls = pollCalls(mounted);
    assert.equal(polls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(pollArgs(polls[0]))), { sessionId: 'sess-target', source: 'cli' });
  });

  void it('dispatches initial poll when ui/initialize rejects', async () => {
    const mounted = mountPollingSandbox();
    const initId = mounted.posted[0]?.id as number;
    mounted.emitHost({
      jsonrpc: '2.0',
      id: initId,
      error: { code: -32601, message: 'Method not found' },
    });
    await flushMicrotasks();

    assert.equal(pollCalls(mounted).length, 1);
  });

  void it('tears down timers and event listeners on pagehide', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);

    assert.equal(mounted.hasActiveInterval(), true);
    assert.equal(mounted.activeTimeoutCount(), 1);
    assert.equal(mounted.totalListenerCount(), 7);
    mounted.emitWindow('pagehide');
    assert.equal(mounted.hasActiveInterval(), false);
    assert.equal(mounted.activeTimeoutCount(), 0);
    assert.equal(mounted.totalListenerCount(), 0);
  });
});
