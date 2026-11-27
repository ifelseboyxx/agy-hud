import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyModelErrorReason, formatErrorReasonShortCode } from '../../core/telemetry-error.ts';
import type { GenMetadataRow } from '../proto.ts';
import { computeEffectiveTps, evaluateSessionTelemetry } from '../telemetry-analysis.ts';

function makeRow(overrides: Partial<GenMetadataRow> = {}): GenMetadataRow {
  return {
    in: 2_000,
    out: 400,
    cw: 0,
    cr: 18_000,
    think: 250,
    resp: 150,
    ttft: 1.5,
    stream: 4.0,
    ctxUsed: 40_000,
    ctxMax: 512_000,
    stepIdx: 1,
    minStepIdx: 2,
    atSec: 1_000,
    modelEnum: 1535,
    modelKey: 'Gemini 4 Neon (XHigh)',
    ...overrides,
  };
}

void describe('telemetry analysis: throughput, thinking tokens, cache anomalies, and Orchestrator Context Budget', () => {
  void it('applies burst + large-output buffered tail-flush fallback and multi-attempt retry quarantine in computeEffectiveTps', () => {
    // Normal sustained turn: 400 / 4.0 = 100 tok/s
    assert.equal(computeEffectiveTps(400, 1.5, 4.0), 100);
    // Existing burst guard: ttft > stream && stream < 0.5 -> whole-turn 300 / 3.2
    assert.ok(Math.abs((computeEffectiveTps(300, 3.0, 0.2) ?? 0) - 300 / 3.2) < 0.01);
    // Large-output buffered tail-flush: stream = 1.4 (< 1.5), total = 30 (ratio 0.046 < 0.06), out = 520 (>= 500)
    // Raw tps = 371 (< 400 burst threshold!), caught specifically by buffered tail-flush guard -> 520 / 30
    const tailFlush = computeEffectiveTps(520, 28.6, 1.4);
    assert.ok(tailFlush !== null && Math.abs(tailFlush - 520 / 30) < 0.01);
    // Multi-attempt retry quarantine forces whole-turn rate
    const quarantined = computeEffectiveTps(400, 6.0, 4.0, true);
    assert.equal(quarantined, 40);
  });

  void it('computes time-weighted avgTps, Tukey-fenced sustained peakTps, and thinking/response output totals', () => {
    const rows: GenMetadataRow[] = [
      makeRow({ out: 300, think: 200, resp: 100, ttft: 1.0, stream: 4.0, atSec: 100 }), // 75
      makeRow({ out: 360, think: 240, resp: 120, ttft: 1.0, stream: 4.0, atSec: 150 }), // 90
      makeRow({ out: 320, think: 200, resp: 120, ttft: 1.0, stream: 4.0, atSec: 200 }), // 80
      makeRow({ out: 340, think: 220, resp: 120, ttft: 1.0, stream: 4.0, atSec: 250 }), // 85
      // Isolated spike (raw 240 tok/s with huge ttft so wholeTurnTps = 24 < 0.5 * 240) -> Tukey-fenced out of peakTps
      makeRow({ out: 720, think: 500, resp: 220, ttft: 27.0, stream: 3.0, atSec: 300 }),
      // Quarantined multi-attempt row -> excluded from avgTps and peakTps
      makeRow({ out: 900, think: 600, resp: 300, ttft: 1.0, stream: 3.0, quarantinedRate: true, atSec: 350 }),
    ];
    const tel = evaluateSessionTelemetry({ rows, tail: null, ckpt: null, data: {}, cliSettings: {} });
    assert.equal(tel.totalOutputTokens, 2_940);
    assert.equal(tel.totalThinkingTokens, 1_960);
    assert.equal(tel.totalResponseTokens, 980);
    assert.ok(tel.avgTps !== undefined && tel.avgTps !== null && tel.avgTps > 80 && tel.avgTps < 115);
    assert.equal(tel.peakTps, 90);
  });

  void it('detects cleared, dropped, and missed Cache Anomalies within 180s and suppresses idle TTL or post-compact drops', () => {
    // Positive control: cleared within 40s on same model
    const clearedRows: GenMetadataRow[] = [
      makeRow({ in: 1_000, cr: 19_000, atSec: 1_000, minStepIdx: 2, stepIdx: 1 }),
      makeRow({ in: 20_000, cr: 0, atSec: 1_040, minStepIdx: 4, stepIdx: 3 }),
    ];
    const clearedTel = evaluateSessionTelemetry({
      rows: clearedRows,
      tail: null,
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(clearedTel.latestCacheAnomaly?.kind, 'cleared');
    assert.equal(clearedTel.latestCacheAnomaly?.gapSec, 40);
    assert.equal(clearedTel.cacheAnomalyCount, 1);

    // Idle TTL (> 180s gap) must NOT flag anomaly
    const idleGapRows: GenMetadataRow[] = [
      makeRow({ in: 1_000, cr: 19_000, atSec: 1_000, minStepIdx: 2, stepIdx: 1 }),
      makeRow({ in: 20_000, cr: 0, atSec: 1_240, minStepIdx: 4, stepIdx: 3 }),
    ];
    const idleTel = evaluateSessionTelemetry({ rows: idleGapRows, tail: null, ckpt: null, data: {}, cliSettings: {} });
    assert.equal(idleTel.latestCacheAnomaly, null);
    assert.equal(idleTel.cacheAnomalyCount, 0);

    // Intervening compaction checkpoint must NOT flag anomaly
    const compactedTel = evaluateSessionTelemetry({
      rows: clearedRows,
      tail: null,
      ckpt: { idx: 3, compactionCount: 1, msgTokensEstimate: 4_000, hasPostPlanner: true, completedIndices: [3] },
      data: {},
      cliSettings: {},
    });
    assert.equal(compactedTel.latestCacheAnomaly, null);

    // Dropped: 90% -> 10% within 60s
    const droppedRows: GenMetadataRow[] = [
      makeRow({ in: 2_000, cr: 18_000, atSec: 1_000 }),
      makeRow({ in: 18_000, cr: 2_000, atSec: 1_060 }),
    ];
    const droppedTel = evaluateSessionTelemetry({
      rows: droppedRows,
      tail: null,
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(droppedTel.latestCacheAnomaly?.kind, 'dropped');

    // Missed: model previously cached, then two consecutive 0-cr turns >= 16k within 60s
    const missedRows: GenMetadataRow[] = [
      makeRow({ in: 2_000, cr: 18_000, atSec: 1_000 }),
      makeRow({ in: 18_000, cr: 0, atSec: 1_300 }), // idle TTL (> 180s) -> not anomaly, but prevTotalIn >= 16k
      makeRow({ in: 19_000, cr: 0, atSec: 1_350 }), // 50s gap, curCr === 0, modelEverCached -> missed!
    ];
    const missedTel = evaluateSessionTelemetry({ rows: missedRows, tail: null, ckpt: null, data: {}, cliSettings: {} });
    assert.equal(missedTel.latestCacheAnomaly?.kind, 'missed');
  });

  void it('locks heterogeneous Orchestrator Context Budget to min(planner, executor) while manual /model switches track latest', () => {
    const orchRows: GenMetadataRow[] = [
      makeRow({ modelEnum: 1427, modelKey: 'Gemini 4 Carbon (High)', ctxUsed: 120_000, ctxMax: 512_000 }),
      makeRow({ modelEnum: 1528, modelKey: 'Gemini 4 Hydrogen (XHigh)', ctxUsed: 135_000, ctxMax: 256_000 }),
      makeRow({ modelEnum: 1427, modelKey: 'Gemini 4 Carbon (High)', ctxUsed: 140_000, ctxMax: 512_000 }),
    ];
    const orchTel = evaluateSessionTelemetry({
      rows: orchRows,
      tail: { breakdown: null, truncationReason: 0, planModelEnum: 1427, execModelEnum: 1528 },
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(orchTel.ctxMax, 256_000);
    assert.equal(orchTel.ctxUsed, 140_000);
    assert.equal(orchTel.modelRoles?.length, 2);
    assert.equal(orchTel.modelRoles?.find((r) => r.model.includes('Carbon'))?.role, 'planner');
    assert.equal(orchTel.modelRoles?.find((r) => r.model.includes('Hydrogen'))?.role, 'executor');

    // Historical manual model (160k) before switching to Orchestrator (512k planner / 256k executor) must NOT pull cap down to 160k
    const mixedOrchRows: GenMetadataRow[] = [
      makeRow({ modelEnum: 1318, modelKey: 'Gemini 3.8 Flash (High)', ctxUsed: 50_000, ctxMax: 160_000 }),
      ...orchRows,
    ];
    const mixedOrchTel = evaluateSessionTelemetry({
      rows: mixedOrchRows,
      tail: { breakdown: null, truncationReason: 0, planModelEnum: 1427, execModelEnum: 1528 },
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(mixedOrchTel.ctxMax, 256_000);
    assert.equal(mixedOrchTel.modelRoles?.find((r) => r.model.includes('3.8 Flash'))?.role, undefined);

    // Manual /model switch (no plan/exec config) tracks latest generation's ctxMax
    const manualTel = evaluateSessionTelemetry({
      rows: orchRows,
      tail: { breakdown: null, truncationReason: 0, planModelEnum: 0, execModelEnum: 0 },
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(manualTel.ctxMax, 512_000);
    assert.equal(manualTel.modelRoles?.length, 2);
    assert.equal(manualTel.modelRoles?.[0]?.role, undefined);
  });

  void it('falls back to stdin context_window when genCount is 0 and suppresses Retry badges on canceled terminal generations', () => {
    const emptyFallback = evaluateSessionTelemetry({
      rows: [],
      tail: null,
      ckpt: null,
      data: { context_window: { context_window_size: 1_048_576, used_percentage: 38 } },
      cliSettings: {},
    });
    assert.equal(emptyFallback.genCount, 0);
    assert.equal(emptyFallback.ctxMax, 1_048_576);
    assert.equal(emptyFallback.ctxUsed, Math.round(0.38 * 1_048_576));

    // Positive control: succeeded turn with 1 retry surfaces lastRetries = 1
    const okRetry = evaluateSessionTelemetry({
      rows: [makeRow({ retries: 1, retryReasons: { 'rate-limit': 1 } })],
      tail: null,
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(okRetry.lastRetries, 1);
    assert.equal(okRetry.retryCount, 1);

    // Same turn ending in user cancellation must suppress both Retry badge and retry/error stats
    const canceledRetry = evaluateSessionTelemetry({
      rows: [makeRow({ retries: 1, retryReasons: { 'rate-limit': 1 }, canceled: true })],
      tail: null,
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(canceledRetry.lastRetries, 0);
    assert.equal(canceledRetry.retryCount, 0);
    assert.equal(canceledRetry.errorCount, 0);
    assert.equal(canceledRetry.lastErrorCode, null);
  });

  void it('classifies model retry/error reasons and excludes user cancellations', () => {
    assert.equal(classifyModelErrorReason('context canceled'), null);
    assert.equal(classifyModelErrorReason('user aborted request'), null);
    assert.equal(classifyModelErrorReason('429 RESOURCE_EXHAUSTED'), 'rate-limit');
    assert.equal(formatErrorReasonShortCode('rate-limit'), '429');
    assert.equal(formatErrorReasonShortCode('unavailable'), '503');
    assert.equal(formatErrorReasonShortCode('eof'), 'EOF');
    assert.equal(formatErrorReasonShortCode('other'), '');
  });

  void it('tracks manual ctxMax after legacy Orchestrator, ignores stale cliSettings under active execModelEnum, and excludes canceled rows from throughput and cache anomalies', () => {
    // Switching off legacy Orchestrator (1667/1669 at 200k) to a manual 512k model must track 512k, not stay locked on 200k
    const leftLegacyOrch = evaluateSessionTelemetry({
      rows: [
        makeRow({ modelEnum: 1667, modelKey: 'Legacy Planner', ctxUsed: 80_000, ctxMax: 200_000 }),
        makeRow({ modelEnum: 1669, modelKey: 'Legacy Executor', ctxUsed: 90_000, ctxMax: 200_000 }),
        makeRow({ modelEnum: 1535, modelKey: 'Gemini 4 Neon (XHigh)', ctxUsed: 100_000, ctxMax: 512_000 }),
      ],
      tail: { breakdown: null, truncationReason: 0, planModelEnum: 0, execModelEnum: 0 },
      ckpt: null,
      data: { model: { display_name: 'Gemini 4 Neon (XHigh)' } },
      cliSettings: {},
    });
    assert.equal(leftLegacyOrch.ctxMax, 512_000);
    assert.equal(
      leftLegacyOrch.modelRoles?.some((r) => r.role !== undefined),
      false,
    );

    // Active tail.execModelEnum > 0 must NOT fall back to cliSettings.orchestrator for an unrelated historical model
    const activeExec = evaluateSessionTelemetry({
      rows: [
        makeRow({ modelEnum: 1318, modelKey: 'Gemini 3.8 Flash (High)', ctxUsed: 50_000, ctxMax: 160_000 }),
        makeRow({ modelEnum: 1427, modelKey: 'Gemini 4 Carbon (High)', ctxUsed: 120_000, ctxMax: 512_000 }),
        makeRow({ modelEnum: 1528, modelKey: 'Gemini 4 Hydrogen (XHigh)', ctxUsed: 130_000, ctxMax: 256_000 }),
      ],
      tail: { breakdown: null, truncationReason: 0, planModelEnum: 1427, execModelEnum: 1528 },
      ckpt: null,
      data: {},
      cliSettings: { orchestrator: { planner: 'Gemini 3.8 Flash (High)', executor: 'Gemini 4 Hydrogen (XHigh)' } },
    });
    assert.equal(activeExec.ctxMax, 256_000);
    assert.equal(activeExec.modelRoles?.find((r) => r.model.includes('3.8 Flash'))?.role, undefined);

    // Canceled row with 0 cache-read and outlier tps must NOT trigger cache anomaly or inflate avgTps/peakTps
    const canceledExcluded = evaluateSessionTelemetry({
      rows: [
        makeRow({ in: 1_000, cr: 19_000, out: 320, ttft: 1.0, stream: 4.0, atSec: 960 }), // 80 tok/s
        makeRow({ in: 1_000, cr: 19_000, out: 320, ttft: 1.0, stream: 4.0, atSec: 1_000 }), // 80 tok/s
        makeRow({ in: 20_000, cr: 0, out: 1_000, ttft: 0.2, stream: 2.0, atSec: 1_030, canceled: true }), // 500 tok/s canceled
      ],
      tail: null,
      ckpt: null,
      data: {},
      cliSettings: {},
    });
    assert.equal(canceledExcluded.latestCacheAnomaly, null);
    assert.equal(canceledExcluded.cacheAnomalyCount, 0);
    assert.equal(canceledExcluded.avgTps, 80);
    assert.equal(canceledExcluded.peakTps, 80);
  });
});
