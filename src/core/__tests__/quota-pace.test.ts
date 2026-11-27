import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeQuotaPace,
  parseSnapshotQuotaRecord,
  resolveQuotaReset,
  resolveSnapshotQuotaBuckets,
  sanitizeQuotaGroup,
} from '../quota-pace.ts';
import { normalizeHostAgentState } from '../telemetry-error.ts';

void describe('clean-room Quota Pace forecasting and envelope quota sanitization', () => {
  const NOW = 1_780_000_000;

  void it('returns null for unsupported keys, disabled, amount-only, full, or expired buckets', () => {
    assert.equal(computeQuotaPace('custom-pool', { remaining_fraction: 0.5, reset_in_seconds: 3_600 }, NOW), null);
    assert.equal(
      computeQuotaPace('gemini-5h', { remaining_fraction: 0.5, reset_in_seconds: 3_600, disabled: true }, NOW),
      null,
    );
    assert.equal(computeQuotaPace('gemini-5h', { remaining_amount: '42', reset_in_seconds: 3_600 }, NOW), null);
    assert.equal(computeQuotaPace('gemini-5h', { remaining_fraction: 1.0, reset_in_seconds: 3_600 }, NOW), null);
    assert.equal(
      computeQuotaPace(
        'gemini-5h',
        { remaining_fraction: 0.2, reset_time: new Date((NOW - 10) * 1000).toISOString() },
        NOW,
      ),
      null,
    );
  });

  void it('suppresses early-window false alarms as settling unless >= 50% is already consumed', () => {
    // 5h window: only 10m (600s) elapsed (< 15m gate) and 15% used -> settling
    const early5h = computeQuotaPace('gemini-5h', { remaining_fraction: 0.85, reset_in_seconds: 17_400 }, NOW);
    assert.equal(early5h?.status, 'settling');

    // 5h window: 30m elapsed, only 8% used (< 10% gate) -> settling
    const lowUse5h = computeQuotaPace('gemini-5h', { remaining_fraction: 0.92, reset_in_seconds: 16_200 }, NOW);
    assert.equal(lowUse5h?.status, 'settling');

    // 5h window: only 5m elapsed, but 55% already consumed (>= 50% immediate override) -> depleting
    const spike5h = computeQuotaPace('gemini-5h', { remaining_fraction: 0.45, reset_in_seconds: 17_700 }, NOW);
    assert.equal(spike5h?.status, 'depleting');
    assert.ok(spike5h !== null && spike5h.etaToZeroSec !== null && spike5h.etaToZeroSec > 0);
  });

  void it('classifies on_track, depleting (>= 1.05 projectedEndUsed), and depleted across 5h and 7d windows', () => {
    // 5h: 2h15m remaining (8100s), 9900s elapsed, 18% used -> projectedEndUsed = 0.18 + (0.18/9900)*8100 = 0.327 -> on_track
    const healthy5h = computeQuotaPace('gemini-5h', { remaining_fraction: 0.82, reset_in_seconds: 8_100 }, NOW);
    assert.equal(healthy5h?.status, 'on_track');
    assert.ok(healthy5h !== null && healthy5h.projectedRemainingPct === 67);

    // 5h: 3h10m remaining (11400s), 6600s elapsed, 58% used -> projectedEndUsed = 0.58 + (0.58/6600)*11400 = 1.582 -> depleting
    const depleting5h = computeQuotaPace('gemini-5h', { remaining_fraction: 0.42, reset_in_seconds: 11_400 }, NOW);
    assert.equal(depleting5h?.status, 'depleting');
    assert.ok(depleting5h !== null && depleting5h.projectedEndUsed >= 1.5);
    assert.ok(
      depleting5h !== null && depleting5h.etaToZeroSec !== null && Math.round(depleting5h.etaToZeroSec) === 4779,
    );

    // 7d: 4d remaining (345600s), 3d elapsed (259200s), 60% used -> projectedEndUsed = 1.40 -> depleting
    const depleting7d = computeQuotaPace('gemini-weekly', { remaining_fraction: 0.4, reset_in_seconds: 345_600 }, NOW);
    assert.equal(depleting7d?.status, 'depleting');

    // Already empty active window -> depleted
    const empty5h = computeQuotaPace('3p-5h', { remaining_fraction: 0, reset_in_seconds: 3_600 }, NOW);
    assert.equal(empty5h?.status, 'depleted');
    assert.equal(empty5h?.etaToZeroSec, 0);
  });

  void it('sanitizes persisted quota groups and resets expired buckets against live nowSec', () => {
    const sanitized = sanitizeQuotaGroup(
      {
        'gemini-5h': { remaining_fraction: 0.42, reset_in_seconds: 11_400 },
        'gemini-weekly': { remaining_fraction: 0.9, reset_time: new Date((NOW + 100_000) * 1000).toISOString() },
      },
      NOW,
    );
    assert.ok(sanitized !== null);
    const parsed = parseSnapshotQuotaRecord(JSON.parse(JSON.stringify(sanitized)));
    assert.deepEqual(parsed, sanitized);

    const activeBuckets = resolveSnapshotQuotaBuckets(parsed, NOW);
    assert.equal(activeBuckets[0]?.label, 'Gemini 5h');
    assert.equal(activeBuckets[0]?.pace?.status, 'depleting');

    // After resetTimeSec passes, persisted bucket resets to 100% left with null pace
    const expiredBuckets = resolveSnapshotQuotaBuckets(parsed, NOW + 12_000);
    assert.equal(expiredBuckets[0]?.remainingPct, 100);
    assert.equal(expiredBuckets[0]?.windowExpired, true);
    assert.equal(expiredBuckets[0]?.pace, null);
  });

  void it('normalizes host agent_state values strictly to known TurnPhase states', () => {
    assert.equal(normalizeHostAgentState('working'), 'working');
    assert.equal(normalizeHostAgentState(' TOOL_USE '), 'tool_use');
    assert.equal(normalizeHostAgentState({ state: 'authenticating' }), 'authenticating');
    assert.equal(normalizeHostAgentState('approval'), null);
    assert.equal(normalizeHostAgentState('unknown-state'), null);

    // Negative/zero reset_in_seconds marks windowExpired across both live resolution and sanitized envelopes
    assert.equal(resolveQuotaReset({ remaining_fraction: 0.4, reset_in_seconds: -5 }, NOW).windowExpired, true);
    const expiredSanitized = sanitizeQuotaGroup(
      {
        'gemini-5h': { remaining_fraction: 0.4, reset_in_seconds: 0 },
        '3p-5h': { remaining_fraction: 0.2, reset_in_seconds: -12 },
      },
      NOW,
    );
    assert.ok(expiredSanitized !== null);
    assert.equal(expiredSanitized['gemini-5h']?.resetTimeSec, NOW);
    assert.equal(expiredSanitized['3p-5h']?.resetTimeSec, NOW - 12);
    const expiredResolved = resolveSnapshotQuotaBuckets(expiredSanitized, NOW);
    assert.equal(expiredResolved[0]?.windowExpired, true);
    assert.equal(expiredResolved[0]?.remainingPct, 100);
    assert.equal(expiredResolved[1]?.windowExpired, true);
    assert.equal(expiredResolved[1]?.remainingPct, 100);

    const fracIso = new Date(100_400).toISOString();
    const snapped = sanitizeQuotaGroup({ 'gemini-5h': { remaining_fraction: 0, reset_time: fracIso } }, 100.1);
    assert.equal(resolveQuotaReset(snapped!['gemini-5h']!, 100.1).windowExpired, false);
    assert.equal(resolveQuotaReset(snapped!['gemini-5h']!, 100.5).windowExpired, true);
  });
});
