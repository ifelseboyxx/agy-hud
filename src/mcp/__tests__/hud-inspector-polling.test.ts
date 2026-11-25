import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  finishInit,
  flushMicrotasks,
  makePayload,
  mountPollingSandbox,
  pollArgs,
  pollCalls,
  type MountedPollingSandbox,
} from './hud-inspector-test-helpers.ts';

function emitToolInput(mounted: MountedPollingSandbox, args: Record<string, unknown>): void {
  mounted.emitHost({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: args } });
}

function emitToolResult(mounted: MountedPollingSandbox, params: Record<string, unknown>): void {
  mounted.emitHost({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params });
}

function replyPoll(mounted: MountedPollingSandbox, id: unknown, opts: Parameters<typeof makePayload>[0]): void {
  mounted.emitHost({ jsonrpc: '2.0', id, result: { structuredContent: makePayload(opts) } });
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

  void it('ignores delayed host tool-result push after a newer poll response has rendered', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const firstPoll = pollCalls(mounted)[0];
    mounted.emitHost({
      jsonrpc: '2.0',
      id: firstPoll?.id,
      result: { structuredContent: makePayload({ convId: 'sess-1', title: 'Fresh Polled', etag: 'etag-fresh' }) },
    });
    await flushMicrotasks();
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: makePayload({ convId: 'sess-1', title: 'Delayed Initial Push', etag: 'etag-old' }) },
    });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Fresh Polled'));
    assert.equal(mounted.getHtml('inspector-main').includes('Delayed Initial Push'), false);
  });

  void it('drops an older in-flight poll response that settles after a fresh host push', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const oldPoll = pollCalls(mounted)[0];
    mounted.emitHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: makePayload({ convId: 'sess-1', title: 'Fresh Host Push', etag: 'etag-push' }) },
    });
    mounted.emitHost({
      jsonrpc: '2.0',
      id: oldPoll?.id,
      result: { structuredContent: makePayload({ convId: 'sess-1', title: 'Stale Poll Reply', etag: 'etag-stale' }) },
    });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Fresh Host Push'));
    assert.equal(mounted.getHtml('inspector-main').includes('Stale Poll Reply'), false);
  });

  void it('ignores delayed host error push from session A after switching to session B', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const initialPoll = pollCalls(mounted)[0];
    assert.ok(initialPoll !== undefined);

    emitToolInput(mounted, { sessionId: 'sess-a', source: 'cli' });
    emitToolInput(mounted, { sessionId: 'sess-b', source: 'cli' });

    emitToolResult(mounted, {
      isError: true,
      structuredContent: { error: 'Session not found: sess-a', code: 'not-found', sessionId: 'sess-a', source: 'cli' },
    });
    await flushMicrotasks();

    assert.equal(mounted.getHtml('inspector-main').includes('Session not found: sess-a'), false);

    emitToolResult(mounted, {
      structuredContent: makePayload({ convId: 'sess-b', title: 'Session B Live', etag: 'etag-b', source: 'cli' }),
    });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Session B Live'));
    assert.equal(mounted.getHtml('inspector-main').includes('Session not found: sess-a'), false);
  });

  void it('preserves queued poll for session B when delayed session A error arrives first', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    const initialPoll = pollCalls(mounted)[0];
    assert.ok(initialPoll !== undefined);

    emitToolInput(mounted, { sessionId: 'sess-a', source: 'cli' });
    emitToolInput(mounted, { sessionId: 'sess-b', source: 'cli' });
    emitToolResult(mounted, {
      isError: true,
      structuredContent: { error: 'Session not found: sess-a', code: 'not-found', sessionId: 'sess-a', source: 'cli' },
    });

    replyPoll(mounted, initialPoll.id, { convId: 'sess-init', title: 'Initial', etag: 'etag-0' });
    await flushMicrotasks();

    const polls = pollCalls(mounted);
    assert.equal(polls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(pollArgs(polls[1]))), { sessionId: 'sess-b', source: 'cli' });
  });

  void it('prevents stale push and stale etag from preempting overlapping same-session tool-input calls', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    replyPoll(mounted, pollCalls(mounted)[0]?.id, { convId: 'sess-0', title: 'Initial', etag: 'etag-0' });
    await flushMicrotasks();

    emitToolInput(mounted, { sessionId: 'sess-1', source: 'cli' });
    const pollAfterFirstInput = pollCalls(mounted)[1];
    assert.ok(pollAfterFirstInput !== undefined);

    emitToolInput(mounted, { sessionId: 'sess-1', source: 'cli' });
    emitToolResult(mounted, {
      structuredContent: makePayload({
        convId: 'sess-1',
        title: 'Stale Snapshot V1',
        etag: 'etag-stale-v1',
        source: 'cli',
      }),
    });
    await flushMicrotasks();

    assert.equal(mounted.getHtml('inspector-main').includes('Stale Snapshot V1'), false);

    replyPoll(mounted, pollAfterFirstInput.id, {
      convId: 'sess-1',
      title: 'Stale Poll V1',
      etag: 'etag-stale-poll',
      source: 'cli',
    });
    await flushMicrotasks();

    const polls = pollCalls(mounted);
    assert.equal(polls.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(pollArgs(polls[2]))), { sessionId: 'sess-1', source: 'cli' });

    replyPoll(mounted, polls[2]?.id, {
      convId: 'sess-1',
      title: 'Latest Snapshot V2',
      etag: 'etag-latest-v2',
      source: 'cli',
    });
    await flushMicrotasks();

    assert.ok(mounted.getHtml('inspector-main').includes('Latest Snapshot V2'));
    mounted.triggerPollTick();
    assert.equal(pollArgs(pollCalls(mounted)[3]).etag, 'etag-latest-v2');
  });

  void it('uses active forced poll when unsettled Auto tool-input overlaps with a pinned session tool-input', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    replyPoll(mounted, pollCalls(mounted)[0]?.id, { convId: 'sess-0', title: 'Initial', etag: 'etag-0' });
    await flushMicrotasks();

    emitToolInput(mounted, { source: 'cli' });
    const autoPoll = pollCalls(mounted)[1];
    assert.ok(autoPoll !== undefined);

    emitToolInput(mounted, { sessionId: 'sess-b', source: 'cli' });
    emitToolResult(mounted, {
      structuredContent: makePayload({
        convId: 'sess-b',
        title: 'Stale Auto Push For B',
        etag: 'etag-stale-auto',
        source: 'cli',
      }),
    });
    await flushMicrotasks();

    assert.equal(mounted.getHtml('inspector-main').includes('Stale Auto Push For B'), false);

    replyPoll(mounted, autoPoll.id, { convId: 'sess-a', title: 'Auto Poll', etag: 'etag-auto', source: 'cli' });
    await flushMicrotasks();

    const polls = pollCalls(mounted);
    assert.equal(polls.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(pollArgs(polls[2]))), { sessionId: 'sess-b', source: 'cli' });
  });

  void it('keeps Auto host push unsettled when pinned A settles first so stale Auto push cannot hijack B', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    replyPoll(mounted, pollCalls(mounted)[0]?.id, { convId: 'sess-0', title: 'Initial', etag: 'etag-0' });
    await flushMicrotasks();

    // 1) Pin A -> 2) Switch to Auto -> 3) A's push arrives while Auto is selected.
    emitToolInput(mounted, { sessionId: 'sess-a', source: 'cli' });
    const pollA = pollCalls(mounted)[1];
    assert.ok(pollA !== undefined);
    emitToolInput(mounted, { source: 'cli' });
    emitToolResult(mounted, {
      structuredContent: makePayload({ convId: 'sess-a', title: 'Push A', etag: 'etag-a', source: 'cli' }),
    });
    replyPoll(mounted, pollA.id, { convId: 'sess-a', title: 'Old Poll A', etag: 'etag-old-a', source: 'cli' });
    await flushMicrotasks();
    const pollAuto = pollCalls(mounted)[2];
    assert.ok(pollAuto !== undefined);

    // 4) Pin B while Auto push is still unsettled, then settle pollAuto so pollB starts.
    emitToolInput(mounted, { sessionId: 'sess-b', source: 'cli' });
    replyPoll(mounted, pollAuto.id, { convId: 'sess-a', title: 'Old Poll Auto', etag: 'etag-old-auto', source: 'cli' });
    await flushMicrotasks();
    const pollB = pollCalls(mounted)[3];
    assert.ok(pollB !== undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(pollArgs(pollB))), { sessionId: 'sess-b', source: 'cli' });

    // 5) Delayed stale Auto push resolves to sess-b: must NOT overwrite UI or cancel in-flight pollB.
    emitToolResult(mounted, {
      structuredContent: makePayload({
        convId: 'sess-b',
        title: 'Stale Auto Snapshot For B',
        etag: 'etag-stale-auto-b',
        source: 'cli',
      }),
    });
    await flushMicrotasks();
    assert.equal(mounted.getHtml('inspector-main').includes('Stale Auto Snapshot For B'), false);

    // 6) Authoritative pollB response resolves and renders B with fresh ETag.
    replyPoll(mounted, pollB.id, {
      convId: 'sess-b',
      title: 'Fresh Authoritative B',
      etag: 'etag-fresh-b',
      source: 'cli',
    });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Fresh Authoritative B'));
    mounted.triggerPollTick();
    assert.equal(pollArgs(pollCalls(mounted)[4]).etag, 'etag-fresh-b');
  });

  void it('does not settle an unsettled Auto push when an uncorrelated error omits sessionId', async () => {
    const mounted = mountPollingSandbox();
    await finishInit(mounted);
    replyPoll(mounted, pollCalls(mounted)[0]?.id, { convId: 'sess-0', title: 'Initial', etag: 'etag-0' });
    await flushMicrotasks();

    emitToolInput(mounted, { source: 'cli' });
    const pollAuto = pollCalls(mounted)[1];
    emitToolResult(mounted, {
      isError: true,
      structuredContent: { error: 'Invalid sessionId', code: 'invalid-args', source: 'cli' },
    });
    await flushMicrotasks();
    assert.equal(mounted.getHtml('inspector-main').includes('Invalid sessionId'), false);

    emitToolInput(mounted, { sessionId: 'sess-b', source: 'cli' });
    replyPoll(mounted, pollAuto?.id, { convId: 'sess-a', title: 'Old Auto', etag: 'etag-old', source: 'cli' });
    await flushMicrotasks();
    emitToolResult(mounted, {
      structuredContent: makePayload({ convId: 'sess-b', title: 'Stale Auto Err', etag: 'etag-stale', source: 'cli' }),
    });
    await flushMicrotasks();
    assert.equal(mounted.getHtml('inspector-main').includes('Stale Auto Err'), false);

    replyPoll(mounted, pollCalls(mounted)[2]?.id, { convId: 'sess-b', title: 'Auth B', etag: 'etag-b', source: 'cli' });
    await flushMicrotasks();
    assert.ok(mounted.getHtml('inspector-main').includes('Auth B'));
  });
});
