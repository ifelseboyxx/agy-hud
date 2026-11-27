import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveSessionCost } from '../../core/cost-utils.ts';
import { DEFAULT_HUD_CONFIG } from '../../core/hud-config.ts';
import type { GitStatusInfo, StatusLineData } from '../../types.ts';
import { stripAnsi } from '../ansi.ts';
import { formatCostSegment, formatSessionCostText, formatSubagentCostText } from '../cost.ts';
import { formatGitSegment } from '../git-render.ts';
import { buildUsageLine } from '../modules.ts';
import { formatCompactPrimaryQuotaTail, formatQuotaItem, formatRemainingQuotaPct } from '../quota.ts';
import { fmtQuotaReset } from '../telemetry-format.ts';

void describe('Option A quota formatting', () => {
  void it('formats compact day+hour reset durations accurately', () => {
    assert.equal(fmtQuotaReset(30), '<1m');
    assert.equal(fmtQuotaReset(2700), '45m');
    assert.equal(fmtQuotaReset(7200), '2h');
    assert.equal(fmtQuotaReset(8100), '2h15m');
    assert.equal(fmtQuotaReset(345_600), '4d');
    assert.equal(fmtQuotaReset(367_200), '4d6h');
    assert.equal(fmtQuotaReset(-10), '');
  });

  void it('rounds edge remaining quota percentages without premature 0% or 100%', () => {
    assert.deepEqual(formatRemainingQuotaPct(0), { text: '0%', isFull: false });
    assert.deepEqual(formatRemainingQuotaPct(0.4), { text: '<1%', isFull: false });
    assert.deepEqual(formatRemainingQuotaPct(82.4), { text: '82%', isFull: false });
    assert.deepEqual(formatRemainingQuotaPct(99.4), { text: '99%', isFull: false });
    assert.deepEqual(formatRemainingQuotaPct(99.996), { text: '100%', isFull: true });
  });

  void it('renders Gemini and Claude/GPT with left direction and day+hour resets on wide panes', () => {
    const line = stripAnsi(
      buildUsageLine(
        {
          model: { id: 'gemini-4-carbon' },
          context_window: { used_percentage: 38, context_window_size: 200_000 },
          quota: {
            'gemini-5h': { remaining_fraction: 0.824, reset_in_seconds: 8100 },
            'gemini-weekly': { remaining_fraction: 0.912, reset_in_seconds: 367_200 },
            '3p-5h': { remaining_fraction: 1.0 },
          },
          terminal_width: 145,
        },
        DEFAULT_HUD_CONFIG,
        null,
      ),
    );
    assert.ok(line.includes('Gemini 5h: 82% left (2h15m) | 7d: 91% left (4d6h)'));
    assert.ok(line.includes('Claude/GPT 5h: 100% left'));
  });

  void it('uses clear Gemini/Claude/GPT labels without left on narrow panes and matches zen edge rounding', () => {
    const data: StatusLineData = {
      model: { id: 'gemini-4-argon' },
      quota: {
        'gemini-5h': { remaining_fraction: 0.004, reset_in_seconds: 900 },
        'gemini-weekly': { remaining_fraction: 0.994, reset_in_seconds: 86_400 },
        'gemini-argon-wtu-weekly': { remaining_fraction: 0.5, reset_in_seconds: 172_800 },
      },
      terminal_width: 90,
    };
    const narrow = stripAnsi(buildUsageLine(data, DEFAULT_HUD_CONFIG, null));
    assert.ok(narrow.includes('Gemini 5h: <1% (15m) | Base 7d: 99% (1d) | 7d: 50% (2d)'));
    assert.equal(narrow.includes(' left'), false);

    const zenTail = stripAnsi(formatCompactPrimaryQuotaTail(data, 1000));
    assert.equal(zenTail, '5h <1%');
  });

  void it('preserves unknown quota bucket keys sanitized', () => {
    const item = formatQuotaItem('custom-pool', { remaining_fraction: 0.64, reset_in_seconds: 1200 }, false, 1000);
    assert.equal(stripAnsi(item ?? ''), 'custom-pool: 64% left (20m)');
  });

  void it('surfaces depleting Quota Pace ETA on wide panes, bang fallback on narrow/zen, and stays quiet on muted pools', () => {
    const depletingData: StatusLineData = {
      model: { id: 'gemini-4-carbon' },
      context_window: { used_percentage: 38, context_window_size: 512_000 },
      quota: {
        'gemini-5h': { remaining_fraction: 0.42, reset_in_seconds: 11_400 },
        '3p-5h': { remaining_fraction: 0.42, reset_in_seconds: 11_400 },
      },
      terminal_width: 150,
    };
    const wide = stripAnsi(buildUsageLine(depletingData, DEFAULT_HUD_CONFIG, null, 1000));
    assert.ok(wide.includes('Gemini 5h: 42% left (3h10m · ~0% 1h19m)'), wide);
    // Muted secondary Claude/GPT bucket must not show depletion ETA or bang
    assert.ok(wide.includes('Claude/GPT 5h: 42% left (3h10m)'), wide);
    assert.equal(wide.includes('Claude/GPT 5h: 42%!'), false);

    // Width-constrained wide pane degrades ETA cleanly to pct! (reset)
    const constrained = stripAnsi(
      buildUsageLine({ ...depletingData, terminal_width: 102 }, DEFAULT_HUD_CONFIG, null, 1000),
    );
    assert.ok(constrained.includes('5h: 42%') && (constrained.includes('42%! (3h10m)') || constrained.includes('~0%')));

    const narrow = stripAnsi(buildUsageLine({ ...depletingData, terminal_width: 86 }, DEFAULT_HUD_CONFIG, null, 1000));
    assert.ok(narrow.includes('Gemini 5h: 42%! (3h10m)'), narrow);

    const zenTail = stripAnsi(formatCompactPrimaryQuotaTail(depletingData, 1000));
    assert.equal(zenTail, '5h 42%!');
  });
});

void describe('multi-currency cost formatting', () => {
  void it('formats usd, cny, and both currencies with narrow compaction and estimated prefix', () => {
    const cost = resolveSessionCost({ total_usd: 0.818, subagent_usd: 0.21, estimated: true });
    assert.ok(cost !== null);
    assert.equal(formatSessionCostText(cost, { currency: 'usd', usdToCnyRate: 7.25, termWidth: 120 }), '~$0.818');
    assert.equal(formatSessionCostText(cost, { currency: 'cny', usdToCnyRate: 7.25, termWidth: 120 }), '~¥5.93');
    assert.equal(
      formatSessionCostText(cost, { currency: 'both', usdToCnyRate: 7.25, termWidth: 120 }),
      '~$0.818 / ¥5.93',
    );
    assert.equal(formatSessionCostText(cost, { currency: 'both', usdToCnyRate: 7.25, termWidth: 80 }), '~$0.82/¥5.93');
    assert.equal(formatSubagentCostText(cost, { currency: 'both', usdToCnyRate: 7.25 }), '$0.210 / ¥1.52');
  });

  void it('ignores negative or non-finite costs while keeping valid zero cost', () => {
    assert.equal(resolveSessionCost({ total_usd: -1 }), null);
    assert.equal(resolveSessionCost({ total_usd: Number.NaN }), null);
    assert.equal(stripAnsi(formatCostSegment({ total_usd: 0 }, { currency: 'usd' })), 'Cost $0.000');
    assert.equal(stripAnsi(formatCostSegment({ total_usd: 12.345 }, { currency: 'usd' })), 'Cost $12.35');
  });
});

void describe('enhanced git segment rendering', () => {
  const sampleData: StatusLineData = { workspace: { current_dir: '/repo/agy-hud' } };
  const richGit: GitStatusInfo = {
    branch: 'feat/ux',
    dirty: true,
    conflicted: 1,
    staged: 2,
    modified: 3,
    deleted: 1,
    renamed: 1,
    untracked: 4,
    stash: 1,
    ahead: 2,
    behind: 1,
    diffAdded: 48,
    diffDeleted: 12,
  };

  void it('renders full status flags, ahead/behind, and diff counts at >= 100 cols', () => {
    const rendered = stripAnsi(formatGitSegment(sampleData, richGit, 120));
    assert.equal(rendered, 'agy-hud git:(feat/ux =+!->?$ ↑2↓1) +48 -12');
  });

  void it('degrades cleanly to git:(branch*) below 100 cols', () => {
    const rendered = stripAnsi(formatGitSegment(sampleData, richGit, 90));
    assert.equal(rendered, 'agy-hud git:(feat/ux*)');
  });

  void it('renders clean repository without status suffix', () => {
    const rendered = stripAnsi(formatGitSegment(sampleData, { branch: 'main', dirty: false }, 120));
    assert.equal(rendered, 'agy-hud git:(main)');
  });
});
