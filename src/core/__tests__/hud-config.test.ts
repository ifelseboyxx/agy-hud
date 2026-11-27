import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HudConfig, HudPreset } from '../../types.ts';
import {
  buildPresetConfig,
  DEFAULT_HUD_CONFIG,
  HUD_LINE_IDS,
  HUD_SEGMENT_IDS,
  hydrateHudConfig,
  mergeHudConfig,
  PRESET_TEMPLATES,
  VALID_HUD_PRESETS,
} from '../hud-config.ts';

void describe('HudConfig schema and presets', async () => {
  await it('defaults DEFAULT_HUD_CONFIG to the full preset with osc8Links enabled', () => {
    assert.deepEqual(DEFAULT_HUD_CONFIG, {
      preset: 'full',
      maxAgentChips: 8,
      osc8Links: true,
      costCurrency: 'usd',
      usdToCnyRate: 7.25,
      lines: ['mode', 'identity', 'usage', 'tools', 'skills', 'mcps', 'agents', 'todos'],
      segments: {
        model: true,
        git: true,
        duration: true,
        badges: true,
        cost: true,
        perf: true,
        context: true,
        quota: true,
      },
    });
  });

  await it('exposes all five persona presets in VALID_HUD_PRESETS', () => {
    assert.deepEqual(VALID_HUD_PRESETS, ['zen', 'minimal', 'compact', 'swarm', 'full']);
    assert.deepEqual(HUD_LINE_IDS, [
      'mode',
      'identity',
      'usage',
      'activity',
      'tools',
      'skills',
      'mcps',
      'agents',
      'todos',
    ]);
    assert.deepEqual(HUD_SEGMENT_IDS, ['model', 'git', 'duration', 'badges', 'cost', 'perf', 'context', 'quota']);
  });

  await it('seeds exact lines and segments for each persona preset template', () => {
    const expectedLines: Record<HudPreset, string[]> = {
      zen: ['identity'],
      minimal: ['identity', 'usage'],
      compact: ['mode', 'identity', 'usage', 'activity'],
      swarm: ['mode', 'identity', 'usage', 'agents', 'todos'],
      full: ['mode', 'identity', 'usage', 'tools', 'skills', 'mcps', 'agents', 'todos'],
    };

    for (const preset of VALID_HUD_PRESETS) {
      const built = buildPresetConfig(preset);
      assert.equal(built.preset, preset);
      assert.deepEqual(built.lines, expectedLines[preset]);
      assert.deepEqual(PRESET_TEMPLATES[preset].lines, expectedLines[preset]);
    }

    const zen = buildPresetConfig('zen');
    assert.deepEqual(zen.segments, {
      model: true,
      git: true,
      duration: false,
      badges: true,
      cost: false,
      perf: false,
      context: true,
      quota: true,
    });

    const minimal = buildPresetConfig('minimal');
    assert.deepEqual(minimal.segments, zen.segments);

    for (const richPreset of ['compact', 'swarm', 'full'] as const) {
      const cfg = buildPresetConfig(richPreset);
      for (const seg of HUD_SEGMENT_IDS) {
        assert.equal(cfg.segments[seg], true, `${richPreset} should enable segment ${seg}`);
      }
    }
  });

  await it('deduplicates explicit lines preserving first-seen order', () => {
    const hydrated = hydrateHudConfig({
      preset: 'zen',
      lines: ['usage', 'identity', 'usage', 'tools', 'identity'],
    });
    assert.deepEqual(hydrated.lines, ['usage', 'identity', 'tools']);
  });

  await it('rejects invalid lines, segments, and osc8Links in strict hydrateHudConfig', () => {
    assert.throws(() => hydrateHudConfig({ lines: 'identity' }), /Invalid 'lines'/);
    assert.throws(() => hydrateHudConfig({ lines: ['identity', 'shell'] }), /Invalid line ID/);
    assert.throws(() => hydrateHudConfig({ segments: 'all' }), /Invalid 'segments'/);
    assert.throws(() => hydrateHudConfig({ segments: { bogus: true } }), /Unknown segment ID/);
    assert.throws(() => hydrateHudConfig({ segments: { cost: 'no' } }), /Invalid boolean 'segments\.cost'/);
    assert.throws(() => hydrateHudConfig({ osc8Links: 'yes' }), /Invalid boolean 'osc8Links'/);
  });

  await it('ignores invalid fields leniently in mergeHudConfig', () => {
    const merged: HudConfig = mergeHudConfig({
      preset: 'minimal',
      osc8Links: 'bad',
      maxAgentChips: 99,
      lines: ['identity', 'bogus', 'identity'],
      segments: { cost: false, bogus: true, perf: 'bad' },
    });
    assert.equal(merged.preset, 'minimal');
    assert.equal(merged.osc8Links, true);
    assert.equal(merged.maxAgentChips, 8);
    assert.deepEqual(merged.lines, ['identity']);
    assert.equal(merged.segments.cost, false);
    assert.equal(merged.segments.perf, false);
  });

  await it('ignores unknown keys such as autoWireStatusLine in HudConfig', () => {
    const expected: HudConfig = {
      ...buildPresetConfig('full'),
      segments: { ...buildPresetConfig('full').segments, cost: false },
    };
    assert.deepEqual(mergeHudConfig({ autoWireStatusLine: true, segments: { cost: false } }), expected);
    assert.deepEqual(hydrateHudConfig({ autoWireStatusLine: true, segments: { cost: false } }), expected);
    assert.equal('autoWireStatusLine' in hydrateHudConfig({ autoWireStatusLine: true }), false);
  });

  await it('ignores removed unpublished show* keys in HudConfig', () => {
    const expected: HudConfig = {
      ...buildPresetConfig('full'),
      segments: { ...buildPresetConfig('full').segments, cost: false },
    };
    assert.deepEqual(mergeHudConfig({ showModeLine: false, segments: { cost: false } }), expected);
    assert.deepEqual(hydrateHudConfig({ showModeLine: false, segments: { cost: false } }), expected);
  });
});
