import assert from 'node:assert/strict';
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

class FakeControlElement {
  id: string;
  value: string;
  constructor(id: string, value: string) {
    this.id = id;
    this.value = value;
  }
}

export interface MountedPollingSandbox {
  posted: Array<Record<string, unknown>>;
  getHtml: (id: 'global-sess-mount' | 'inspector-main') => string;
  emitHost: (data: Record<string, unknown>, source?: unknown) => void;
  emitWindow: (type: string) => void;
  click: (matchMap: Record<string, { getAttribute: (name: string) => string | null }>) => void;
  selectSession: (value: string) => void;
  triggerPollTick: () => void;
  fireLatestTimeout: () => void;
  activeTimeoutCount: () => number;
  hasActiveInterval: () => boolean;
  totalListenerCount: () => number;
}

export function mountPollingSandbox(): MountedPollingSandbox {
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
    HTMLSelectElement: FakeControlElement,
    HTMLInputElement: FakeControlElement,
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
    emitHost: (data, source = sandbox.window.parent) => {
      for (const fn of winListeners.get('message') ?? []) fn({ data, source });
    },
    emitWindow: (type) => {
      for (const fn of winListeners.get(type) ?? []) fn({});
    },
    click: (matchMap) => {
      const ev = { target: new FakeElement(matchMap) };
      for (const fn of docListeners.get('click') ?? []) fn(ev);
    },
    selectSession: (value) => {
      const ev = { target: new FakeControlElement('va-sess-select', value) };
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

export function makePayload(opts: {
  convId: string;
  title: string;
  etag: string;
  source?: string;
}): Record<string, unknown> {
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

export function pollCalls(mounted: MountedPollingSandbox): Array<Record<string, unknown>> {
  return mounted.posted.filter(
    (m) => m.method === 'tools/call' && (m.params as Record<string, unknown>).name === 'hud_poll_snapshot',
  );
}

export function pollArgs(msg: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(msg !== undefined);
  return (msg.params as { arguments: Record<string, unknown> }).arguments;
}

export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

export async function finishInit(mounted: MountedPollingSandbox): Promise<void> {
  const initId = mounted.posted[0]?.id as number;
  mounted.emitHost({
    jsonrpc: '2.0',
    id: initId,
    result: { protocolVersion: '2026-01-26', hostCapabilities: {}, hostContext: {} },
  });
  await flushMicrotasks();
}
