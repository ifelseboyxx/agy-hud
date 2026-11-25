import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  finishInit,
  flushMicrotasks,
  makePayload,
  mountPollingSandbox,
  pollArgs,
  pollCalls,
} from './hud-inspector-test-helpers.ts';

void describe('hud-inspector message source and HTML escaping hardening', () => {
  void it('ignores inbound window messages whose source is not window.parent', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);

    mounted.emitHost(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          structuredContent: makePayload({ convId: 'spoof-1', title: 'Spoofed Foreign Push', etag: 'etag-x' }),
        },
      },
      { foreignWindow: true },
    );
    await flushMicrotasks();

    assert.equal(mounted.getHtml('inspector-main').includes('Spoofed Foreign Push'), false);
  });

  void it('escapes single quotes as &#39; when rendering inspector HTML', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);

    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: {
        structuredContent: makePayload({
          convId: 'sess-quote',
          title: "Owner's Session",
          etag: 'etag-quote',
        }),
      },
    });
    await flushMicrotasks();

    const html = mounted.getHtml('inspector-main');
    assert.ok(html.includes('Owner&#39;s Session'));
    assert.equal(html.includes("Owner's Session"), false);
  });

  void it('ignores malformed poll payloads without mutating etag or crashing the renderer', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);

    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: {
        structuredContent: makePayload({ convId: 'sess-good', title: 'Valid Baseline', etag: 'etag-good' }),
      },
    });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Valid Baseline'));

    mounted.triggerPollTick();
    const secondPoll = pollCalls(mounted)[1];
    assert.ok(secondPoll !== undefined);
    mounted.emitHost({
      jsonrpc: '2.0',
      id: secondPoll.id,
      result: {
        structuredContent: {
          etag: 'etag-poison',
          snapshot: { convId: 'sess-good', surface: 'cli', title: 'Malformed Missing Arrays' },
        },
      },
    });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Valid Baseline'));
    assert.equal(mounted.getHtml('inspector-main').includes('Malformed Missing Arrays'), false);
    mounted.triggerPollTick();
    assert.equal(pollArgs(pollCalls(mounted)[2]).etag, 'etag-good');
  });

  void it('sanitizes non-numeric count and totalCalls fields before rendering HTML slots', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);

    const xss = '<img src=x onerror=alert(1)>';
    const base = makePayload({ convId: 'sess-xss', title: 'XSS Check', etag: 'etag-xss' });
    const snap = base.snapshot as Record<string, unknown>;
    snap.totalToolCalls = xss;
    snap.completedTools = [
      { disp: 'read_file', count: xss, latestTarget: 'a.ts', fullTarget: '/a.ts', recentTargets: [], targetUris: {} },
    ];
    snap.mcps = [{ server: 'srv', totalCalls: xss, subtools: [{ name: 'op', count: xss }] }];

    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: { structuredContent: base },
    });
    await flushMicrotasks();

    const overviewHtml = mounted.getHtml('inspector-main');
    assert.equal(overviewHtml.includes('<img'), false);
    assert.equal(overviewHtml.includes('onerror='), false);

    mounted.click({ '[data-va-tab]': { getAttribute: () => 'tools' } });
    const toolsHtml = mounted.getHtml('inspector-main');
    assert.equal(toolsHtml.includes('<img'), false);
    assert.equal(toolsHtml.includes('onerror='), false);

    mounted.click({ '[data-va-tab]': { getAttribute: () => 'context' } });
    const ctxHtml = mounted.getHtml('inspector-main');
    assert.equal(ctxHtml.includes('<img'), false);
    assert.equal(ctxHtml.includes('onerror='), false);
  });

  void it('filters session items with non-string workspace fields without crashing the sidebar renderer', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);

    const payload = makePayload({ convId: 'sess-ws', title: 'Workspace Guard', etag: 'etag-ws' });
    payload.sessions = [
      { convId: 'sess-bad', surface: 'cli', title: 'Bad Workspace', workspace: 12345 },
      { convId: 'sess-ws', surface: 'cli', title: 'Workspace Guard', workspace: '/repo/ok' },
    ];

    mounted.emitHost({ jsonrpc: '2.0', id: firstPoll.id, result: { structuredContent: payload } });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Workspace Guard'));
    const sidebarHtml = mounted.getHtml('global-sess-mount');
    assert.ok(sidebarHtml.includes('Workspace Guard'));
    assert.equal(sidebarHtml.includes('Bad Workspace'), false);
  });

  void it('resets hostPushOverflow once all tracked unsettled host pushes drain', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: { structuredContent: makePayload({ convId: 'sess-init', title: 'Initial', etag: 'etag-init' }) },
    });
    await flushMicrotasks();

    for (let i = 0; i < 65; i += 1) {
      mounted.emitHost({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: { arguments: { source: 'cli', sessionId: `sess-burst-${i}` } },
      });
    }
    for (let i = 0; i < 64; i += 1) {
      mounted.emitHost({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          structuredContent: makePayload({
            convId: `sess-burst-${i}`,
            title: `Burst ${i}`,
            etag: `etag-burst-${i}`,
            source: 'cli',
          }),
        },
      });
    }
    await flushMicrotasks();

    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { source: 'cli', sessionId: 'sess-recovered' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makePayload({
          convId: 'sess-recovered',
          title: 'Recovered After Overflow',
          etag: 'etag-recovered',
          source: 'cli',
        }),
      },
    });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Recovered After Overflow'));
  });

  void it('ignores unchanged host push notifications whose source mismatches active sourceFilter', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: { structuredContent: makePayload({ convId: 'sess-init', title: 'Initial', etag: 'etag-init' }) },
    });
    await flushMicrotasks();

    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { source: 'cli', sessionId: 'sess-target' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { unchanged: true, source: 'app', etag: 'etag-other' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makePayload({
          convId: 'sess-target',
          title: 'Matched CLI Target',
          etag: 'etag-target',
          source: 'cli',
        }),
      },
    });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Matched CLI Target'));
  });

  void it('ignores unchanged host push notifications carrying a non-string source field', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: { structuredContent: makePayload({ convId: 'sess-init', title: 'Initial', etag: 'etag-init' }) },
    });
    await flushMicrotasks();

    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { source: 'cli', sessionId: 'sess-target' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { unchanged: true, source: 123, etag: 'etag-bad-src' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makePayload({
          convId: 'sess-target',
          title: 'Accepted After Non-String Source',
          etag: 'etag-ok',
          source: 'cli',
        }),
      },
    });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Accepted After Non-String Source'));
  });

  void it('settles matching unsettled host push when unchanged notification carries matching source and sessionId', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    assert.ok(firstPoll !== undefined);
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll.id,
      result: { structuredContent: makePayload({ convId: 'sess-init', title: 'Initial', etag: 'etag-init' }) },
    });
    await flushMicrotasks();

    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { source: 'cli', sessionId: 'sess-same' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { unchanged: true, source: 'cli', sessionId: 'sess-same', etag: 'etag-init' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { source: 'cli', sessionId: 'sess-same' } },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: makePayload({
          convId: 'sess-same',
          title: 'Settled Unchanged Followup',
          etag: 'etag-settled',
          source: 'cli',
        }),
      },
    });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Settled Unchanged Followup'));
  });
});
