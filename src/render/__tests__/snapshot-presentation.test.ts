import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderSnapshotMarkdownWithDigest } from '../osc8-markdown.ts';
import {
  buildContextSectionModel,
  formatAgentsSectionHeading,
  formatSubagentRollupParts,
  formatSubagentTelemetryParts,
  formatToolsSectionHeading,
} from '../snapshot-presentation.ts';

void describe('shared Activity Snapshot presentation model and digest seam', () => {
  void it('builds canonical Context Budget, Breakdown rows, and model roles with consistent Title Case notes', () => {
    const model = buildContextSectionModel(
      {
        genCount: 5,
        tps: 90,
        ttft: 1.2,
        cachePct: 92,
        ctxUsed: 256_000,
        ctxMax: 512_000,
        providerInputTokens: 260_000,
        truncationReason: 'max-token-limit',
        compaction: { count: 2, preUsed: 320_000, postUsed: 34_000, active: false },
        contextBreakdown: {
          system: 10_000,
          rules: 0,
          skills: 2_000,
          tools: 8_000,
          mcp: 0,
          messages: 236_000,
          free: 256_000,
          used: 256_000,
          budget: 512_000,
          compacted: false,
          estimatedMessages: false,
        },
        modelRoles: [
          { model: 'Gemini 4 Neon', role: 'planner', genCount: 2, lastCtxUsed: 200_000, lastCtxMax: 512_000 },
          { model: 'Gemini 4 Flash', role: 'executor', genCount: 3, lastCtxUsed: 256_000, lastCtxMax: 512_000 },
        ],
      },
      1_000_000,
    );
    assert.ok(model !== null);
    assert.equal(model.headingSuffix, ' · 256k/512k (50%)');
    assert.deepEqual(model.metaNotes, [
      'Nominal 1M',
      'Provider in: 260k',
      'Truncation: max-token-limit',
      'Compacted ×2 (320k -> 34k)',
    ]);
    assert.equal(model.rows.length, 7);
    assert.equal(model.rows.find((r) => r.key === 'skills')?.shareText, '0.4%');
    assert.equal(model.roles.length, 2);
  });

  void it('formats canonical subagent telemetry, aggregate rollups, and section headings', () => {
    assert.deepEqual(
      formatSubagentTelemetryParts({
        genCount: 2,
        ctxUsed: 24_000,
        ctxMax: 512_000,
        totalInputTokens: 10_000,
        cacheReadTokens: 9_000,
        cachePct: 90,
        totalOutputTokens: 300,
        thinkingTokens: 180,
        tps: 149.6,
        retryCount: 1,
        errorCount: 0,
        resolvedModel: 'Gemini 4 Flash',
      }),
      ['Ctx 24k/512k', '10k/300', 'Cache 90%', '150 tok/s', 'retry ×1'],
    );
    assert.deepEqual(
      formatSubagentRollupParts({
        childCount: 2,
        measuredCount: 1,
        totalGenCount: 2,
        totalInputTokens: 10_000,
        totalCacheReadTokens: 9_000,
        cachePct: 90,
        totalOutputTokens: 300,
        totalThinkingTokens: 180,
        retryCount: 1,
        errorCount: 0,
      }),
      ['1/2 measured', '2 gens', 'In 10k', 'Out 300 (think 180)', 'Cache 90%', 'Retries ×1'],
    );
    assert.equal(formatToolsSectionHeading(1, 3, 7), 'Tools (1 running · 3 types · 7 calls)');
    assert.equal(
      formatAgentsSectionHeading('swarm', [{ state: 'working' }, { state: 'done' }]).heading,
      'Swarm (1 alive · 1 stopped)',
    );
  });

  void it('keeps renderSnapshotMarkdownWithDigest stable across wall-clock ticks while invalidating on subagent telemetry changes', () => {
    const baseOpts = {
      convId: 'conv-digest-1',
      data: { conversation_id: 'conv-digest-1', conversation_title: 'Digest Test', cwd: '/ws' },
      activity: null,
      agentsSummary: {
        kind: 'agents' as const,
        working: 1,
        waiting: 0,
        alive: 1,
        total: 1,
        entries: [{ name: 'scout', type: 'research', model: 'flash', state: 'working' as const, ts: 10 }],
      },
    };
    const r1 = renderSnapshotMarkdownWithDigest({ ...baseOpts, nowMs: 20_000 });
    const r2 = renderSnapshotMarkdownWithDigest({ ...baseOpts, nowMs: 35_000 });
    assert.equal(r1.contentDigest, r2.contentDigest, 'wall-clock ticks alone must not churn contentDigest');

    const r3 = renderSnapshotMarkdownWithDigest({
      ...baseOpts,
      nowMs: 35_000,
      snapshotAgents: [
        {
          name: 'scout',
          type: 'research',
          model: 'Gemini 4 Flash',
          state: 'working',
          ts: 10,
          ageLabel: '25s ago',
          telemetry: {
            genCount: 1,
            ctxUsed: 12_000,
            ctxMax: 512_000,
            totalInputTokens: 5_000,
            cacheReadTokens: 4_000,
            cachePct: 80,
            totalOutputTokens: 200,
            thinkingTokens: 80,
            tps: 100,
            retryCount: 0,
            errorCount: 0,
            resolvedModel: 'Gemini 4 Flash',
          },
        },
      ],
    });
    assert.notEqual(r3.contentDigest, r2.contentDigest, 'subagent telemetry change must invalidate contentDigest');
  });
});
