import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_HUD_CONFIG, type HudConfig, type HudPreset } from '../../types.ts';
import {
  buildPresetConfig,
  HUD_LINE_IDS,
  HUD_SEGMENT_IDS,
  hydrateHudConfig,
  mergeHudConfig,
  PRESET_TEMPLATES,
  VALID_HUD_PRESETS,
} from '../hud-config.ts';

void describe('HudConfig schema, presets, and legacy hydration', async () => {
  await it('defaults DEFAULT_HUD_CONFIG to the compact preset with osc8Links enabled', () => {
    assert.deepEqual(DEFAULT_HUD_CONFIG, {
      preset: 'compact',
      maxAgentChips: 8,
      osc8Links: true,
      lines: ['mode', 'identity', 'usage', 'activity'],
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

  await it('hydrates legacy show* keys from raw.preset losslessly', () => {
    const hydrated = hydrateHudConfig({
      preset: 'full',
      showModeLine: false,
      showSkillsMcpLine: false,
      showTodosLine: false,
      showCost: false,
      showQuota: false,
      maxAgentChips: 5,
    });

    assert.equal(hydrated.preset, 'full');
    assert.equal(hydrated.maxAgentChips, 5);
    assert.equal(hydrated.osc8Links, true);
    assert.deepEqual(hydrated.lines, ['identity', 'usage', 'tools', 'agents']);
    assert.equal(hydrated.segments.cost, false);
    assert.equal(hydrated.segments.quota, false);
    assert.equal(hydrated.segments.perf, true);
  });

  await it('maps legacy showSkillsMcpLine=true to both skills and mcps lines', () => {
    const hydrated = hydrateHudConfig({
      preset: 'compact',
      showSkillsMcpLine: true,
      showToolsLine: true,
      showSwarmChips: true,
      showTodosLine: true,
    });

    assert.deepEqual(hydrated.lines, [
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
  });

  await it('defaults legacy config without preset or lines to compact before applying show* keys', () => {
    const hydrated = hydrateHudConfig({ showPerfCapsule: false, showCost: false });
    assert.equal(hydrated.preset, 'compact');
    assert.deepEqual(hydrated.lines, ['mode', 'identity', 'usage', 'activity']);
    assert.equal(hydrated.segments.perf, false);
    assert.equal(hydrated.segments.cost, false);
  });

  await it('deduplicates explicit lines preserving first-seen order', () => {
    const hydrated = hydrateHudConfig({
      preset: 'zen',
      lines: ['usage', 'identity', 'usage', 'tools', 'identity'],
    });
    assert.deepEqual(hydrated.lines, ['usage', 'identity', 'tools']);
  });

  await it('preserves explicit lines and segments over legacy show* keys', () => {
    const hydrated = hydrateHudConfig({
      preset: 'full',
      lines: ['identity'],
      segments: { cost: false },
      showToolsLine: true,
      showCost: true,
    });
    assert.deepEqual(hydrated.lines, ['identity']);
    assert.equal(hydrated.segments.cost, false);
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

  await it('ignores autoWireStatusLine as an unknown key in both merge and hydrate', () => {
    const expected: HudConfig = {
      ...buildPresetConfig('compact'),
      segments: { ...buildPresetConfig('compact').segments, cost: false },
    };
    assert.deepEqual(mergeHudConfig({ autoWireStatusLine: true, showCost: false }), expected);
    assert.deepEqual(hydrateHudConfig({ autoWireStatusLine: true, showCost: false }), expected);
    assert.equal('autoWireStatusLine' in hydrateHudConfig({ autoWireStatusLine: true }), false);
  });
});
