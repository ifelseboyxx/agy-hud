import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPresetConfig, VALID_HUD_PRESETS } from '../../core/hud-config.ts';
import { stripAnsi } from '../../render/ansi.ts';
import {
  buildConfigurePreviewLines,
  CONFIGURE_PRESET_DESCRIPTIONS,
  renderConfigureTuiFrame,
} from '../configure-tui-render.ts';
import { applyConfigureTuiKey, createConfigureTuiState, getConfigureTier2Items } from '../configure-tui.ts';

void describe('configure TUI state machine', () => {
  void it('navigates Tier 1 presets with Up/Down while preserving maxAgentChips and osc8Links', () => {
    const initial = buildPresetConfig('compact', { maxAgentChips: 5, osc8Links: false });
    const state = createConfigureTuiState(initial);

    assert.equal(state.tier, 'presets');
    assert.equal(state.presetIndex, 2);
    assert.equal(state.draft.preset, 'compact');

    assert.equal(applyConfigureTuiKey(state, '\x1b[B'), 'redraw');
    assert.equal(state.presetIndex, 3);
    assert.equal(state.draft.preset, 'swarm');
    assert.deepEqual(state.draft.lines, ['mode', 'identity', 'usage', 'agents', 'todos']);
    assert.equal(state.draft.maxAgentChips, 5);
    assert.equal(state.draft.osc8Links, false);

    assert.equal(applyConfigureTuiKey(state, 'j'), 'redraw');
    assert.equal(state.presetIndex, 4);
    assert.equal(state.draft.preset, 'full');

    assert.equal(applyConfigureTuiKey(state, '\x1b[B'), 'noop');
    assert.equal(state.presetIndex, 4);

    assert.equal(applyConfigureTuiKey(state, '\x1b[A'), 'redraw');
    assert.equal(state.presetIndex, 3);
    assert.equal(applyConfigureTuiKey(state, 'k'), 'redraw');
    assert.equal(state.presetIndex, 2);
    assert.equal(applyConfigureTuiKey(state, '\x1bOA'), 'redraw');
    assert.equal(state.presetIndex, 1);
    assert.equal(applyConfigureTuiKey(state, '\x1b[A'), 'redraw');
    assert.equal(state.presetIndex, 0);
    assert.equal(state.draft.preset, 'zen');
    assert.deepEqual(state.draft.lines, ['identity']);
    assert.equal(state.draft.segments.perf, false);
    assert.equal(state.draft.maxAgentChips, 5);
    assert.equal(state.draft.osc8Links, false);

    assert.equal(applyConfigureTuiKey(state, '\x1b[A'), 'noop');
  });

  void it('returns save on Enter and cancel on q, Q, Esc, or Ctrl+C in either tier', () => {
    for (const tier of ['presets', 'modules'] as const) {
      for (const saveKey of ['\r', '\n']) {
        const st = createConfigureTuiState(buildPresetConfig('compact'));
        st.tier = tier;
        assert.equal(applyConfigureTuiKey(st, saveKey), 'save');
      }
      for (const cancelKey of ['q', 'Q', '\x1b', '\x03']) {
        const st = createConfigureTuiState(buildPresetConfig('compact'));
        st.tier = tier;
        assert.equal(applyConfigureTuiKey(st, cancelKey), 'cancel');
      }
    }
  });

  void it('switches between Tier 1 and Tier 2 on Tab while preserving draft state', () => {
    const state = createConfigureTuiState(buildPresetConfig('compact'));
    state.draft.segments.cost = false;

    assert.equal(applyConfigureTuiKey(state, '\t'), 'redraw');
    assert.equal(state.tier, 'modules');
    assert.equal(state.draft.segments.cost, false);

    assert.equal(applyConfigureTuiKey(state, '\t'), 'redraw');
    assert.equal(state.tier, 'presets');
    assert.equal(state.draft.segments.cost, false);

    assert.equal(applyConfigureTuiKey(state, '\x1b[Z'), 'redraw');
    assert.equal(state.tier, 'modules');
  });

  void it('toggles Line Modules, Inline Segments, and osc8Links with Space in Tier 2', () => {
    const state = createConfigureTuiState(buildPresetConfig('compact'));
    applyConfigureTuiKey(state, '\t');

    const initialItems = getConfigureTier2Items(state.draft);
    assert.equal(initialItems.length, 18);
    assert.deepEqual(
      initialItems.slice(0, 4).map((item) => item.id),
      ['mode', 'identity', 'usage', 'activity'],
    );

    for (let i = 0; i < 4; i += 1) {
      assert.equal(applyConfigureTuiKey(state, '\x1b[B'), 'redraw');
    }
    assert.equal(getConfigureTier2Items(state.draft)[state.tier2Cursor]?.id, 'tools');
    assert.equal(applyConfigureTuiKey(state, ' '), 'redraw');
    assert.equal(state.draft.lines.includes('tools'), true);
    assert.equal(getConfigureTier2Items(state.draft)[state.tier2Cursor]?.id, 'tools');

    assert.equal(applyConfigureTuiKey(state, ' '), 'redraw');
    assert.equal(state.draft.lines.includes('tools'), false);
    assert.equal(getConfigureTier2Items(state.draft)[state.tier2Cursor]?.id, 'tools');

    const costIdx = getConfigureTier2Items(state.draft).findIndex(
      (item) => item.kind === 'segment' && item.id === 'cost',
    );
    state.tier2Cursor = costIdx;
    assert.equal(state.draft.segments.cost, true);
    assert.equal(applyConfigureTuiKey(state, ' '), 'redraw');
    assert.equal(state.draft.segments.cost, false);

    const lastIdx = getConfigureTier2Items(state.draft).length - 1;
    state.tier2Cursor = lastIdx;
    assert.equal(getConfigureTier2Items(state.draft)[state.tier2Cursor]?.kind, 'option');
    assert.equal(state.draft.osc8Links, true);
    assert.equal(applyConfigureTuiKey(state, ' '), 'redraw');
    assert.equal(state.draft.osc8Links, false);

    assert.equal(applyConfigureTuiKey(state, 'j'), 'noop');
    assert.equal(state.tier2Cursor, lastIdx);
  });

  void it('reorders enabled Line Modules in config.lines with [/], K/J, and Shift+Up/Down', () => {
    const state = createConfigureTuiState(buildPresetConfig('compact'));
    applyConfigureTuiKey(state, '\t');
    state.tier2Cursor = 2; // 'usage'

    assert.equal(applyConfigureTuiKey(state, '['), 'redraw');
    assert.deepEqual(state.draft.lines, ['mode', 'usage', 'identity', 'activity']);
    assert.equal(state.tier2Cursor, 1);

    assert.equal(applyConfigureTuiKey(state, 'K'), 'redraw');
    assert.deepEqual(state.draft.lines, ['usage', 'mode', 'identity', 'activity']);
    assert.equal(state.tier2Cursor, 0);

    assert.equal(applyConfigureTuiKey(state, '\x1b[1;2A'), 'noop');
    assert.deepEqual(state.draft.lines, ['usage', 'mode', 'identity', 'activity']);

    assert.equal(applyConfigureTuiKey(state, ']'), 'redraw');
    assert.deepEqual(state.draft.lines, ['mode', 'usage', 'identity', 'activity']);
    assert.equal(state.tier2Cursor, 1);

    assert.equal(applyConfigureTuiKey(state, 'J'), 'redraw');
    assert.deepEqual(state.draft.lines, ['mode', 'identity', 'usage', 'activity']);
    assert.equal(state.tier2Cursor, 2);

    assert.equal(applyConfigureTuiKey(state, '\x1b[1;2B'), 'redraw');
    assert.deepEqual(state.draft.lines, ['mode', 'identity', 'activity', 'usage']);
    assert.equal(state.tier2Cursor, 3);

    assert.equal(applyConfigureTuiKey(state, ']'), 'noop');

    state.tier2Cursor = 4; // 'tools' (disabled)
    assert.equal(applyConfigureTuiKey(state, '['), 'noop');
    assert.equal(applyConfigureTuiKey(state, ']'), 'noop');

    state.tier2Cursor = 9; // 'model' (segment)
    assert.equal(applyConfigureTuiKey(state, '['), 'noop');
    assert.equal(applyConfigureTuiKey(state, ']'), 'noop');
  });
});

void describe('configure TUI live preview and frame rendering', () => {
  void it('renders authentic live HUD preview lines reflecting presets, toggles, and line order', () => {
    const zenLines = buildConfigurePreviewLines(buildPresetConfig('zen'), 110, false);
    assert.equal(zenLines.length, 1);
    assert.ok(zenLines[0]?.includes('Ctx'));
    assert.ok(zenLines[0]?.includes('5h 82%'));

    const compactLines = buildConfigurePreviewLines(buildPresetConfig('compact'), 110, false);
    assert.equal(compactLines.length, 4);
    assert.ok(compactLines[0]?.includes('plan mode'));
    assert.ok(compactLines[1]?.includes('Cost'));
    assert.ok(compactLines[2]?.includes('Context'));

    const fullLines = buildConfigurePreviewLines(buildPresetConfig('full'), 110, false);
    assert.equal(fullLines.length, 8);

    const reordered = buildPresetConfig('minimal');
    reordered.lines = ['usage', 'identity'];
    reordered.segments.cost = false;
    const reorderedLines = buildConfigurePreviewLines(reordered, 110, false);
    assert.equal(reorderedLines.length, 2);
    assert.ok(reorderedLines[0]?.includes('Context'));
    assert.ok(reorderedLines[1]?.includes('Carbon'));
    assert.ok(reorderedLines[1]?.includes('git:(main*)'));
    assert.equal(reorderedLines[1]?.includes('Cost'), false);
  });

  void it('renders Tier 1 Preset Picker with all 5 presets, descriptions, and live preview', () => {
    const state = createConfigureTuiState(buildPresetConfig('compact'));
    const frame = renderConfigureTuiFrame(state, { cols: 100, rows: 24, color: false });
    const plain = stripAnsi(frame.output);

    for (const preset of VALID_HUD_PRESETS) {
      assert.ok(plain.includes(preset), `Tier 1 frame should list preset ${preset}`);
      assert.ok(plain.includes(CONFIGURE_PRESET_DESCRIPTIONS[preset]), `Tier 1 frame should describe ${preset}`);
    }
    assert.ok(plain.includes('Live Preview'));
    assert.ok(plain.includes('Context'));
    assert.ok(plain.includes('[Tab]'));
    assert.ok(plain.includes('[Enter] Save'));
  });

  void it('renders Tier 2 Module & Order Editor with checkboxes, order badges, osc8Links, and reorder hints', () => {
    const state = createConfigureTuiState(buildPresetConfig('compact'));
    applyConfigureTuiKey(state, '\t');
    state.tier2Cursor = getConfigureTier2Items(state.draft).length - 1;
    const shortFrame = renderConfigureTuiFrame(state, { cols: 100, rows: 16, color: false });
    const shortPlain = stripAnsi(shortFrame.output);
    assert.ok(shortPlain.includes('osc8Links'), 'viewport should scroll to keep focused osc8Links item visible');
    assert.ok(shortPlain.includes('Live Preview'));
    assert.ok(shortPlain.includes('[Space] Toggle'));
    assert.ok(shortPlain.includes('[/]'));

    state.tier2Cursor = 0;
    const fullFrame = renderConfigureTuiFrame(state, { cols: 100, rows: 32, color: false });
    const fullPlain = stripAnsi(fullFrame.output);
    assert.ok(fullPlain.includes('#1'));
    assert.ok(fullPlain.includes('[x]'));
    assert.ok(fullPlain.includes('[ ]'));
    assert.ok(fullPlain.includes('Inline Segments'));
  });
});
