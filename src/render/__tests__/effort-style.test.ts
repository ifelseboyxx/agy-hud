import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPresetConfig } from '../../core/hud-config.ts';
import {
  isPeakEffortForModel,
  parseModelAndEffort,
  resolveEffortPeakFlags,
  resolveModelPeakEffort,
} from '../../core/model-names.ts';
import { stripAnsi, visibleLen } from '../ansi.ts';
import { detectColorLevel, formatModelSegment, isActiveShimmerState } from '../effort-style.ts';
import { renderHudPreviewLines } from '../preview-fixture.ts';

void describe('model peak effort styling and seamless monochrome platinum sheen', () => {
  void it('detects none, ansi16, and truecolor capabilities from terminal environment', () => {
    assert.equal(detectColorLevel({ NO_COLOR: '' }), 'none');
    assert.equal(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 'none');
    assert.equal(detectColorLevel({ TERM: 'dumb', COLORTERM: 'truecolor' }), 'none');
    assert.equal(detectColorLevel({ COLORTERM: 'truecolor' }), 'truecolor');
    assert.equal(detectColorLevel({ COLORTERM: '24bit' }), 'truecolor');
    assert.equal(detectColorLevel({ TERM: 'xterm-direct' }), 'truecolor');
    assert.equal(detectColorLevel({ WT_SESSION: 'guid-123' }), 'truecolor');
    assert.equal(detectColorLevel({ TERM_PROGRAM: 'ghostty' }), 'truecolor');
    assert.equal(detectColorLevel({ TERM: 'xterm-256color' }), 'ansi16');
    assert.equal(detectColorLevel({}), 'ansi16');
  });

  void it('enables active sheen strictly for initializing, working, and tool_use states', () => {
    assert.equal(isActiveShimmerState('initializing'), true);
    assert.equal(isActiveShimmerState('working'), true);
    assert.equal(isActiveShimmerState('tool_use'), true);
    assert.equal(isActiveShimmerState({ state: 'working' }), true);
    assert.equal(isActiveShimmerState('idle'), false);
    assert.equal(isActiveShimmerState('error'), false);
    assert.equal(isActiveShimmerState('reviewing'), false);
    assert.equal(isActiveShimmerState('authenticating'), false);
    assert.equal(isActiveShimmerState(undefined), false);
  });

  void it('identifies peak effort across display names, model ids, placeholders, underscores, and Orchestrator roles', () => {
    assert.equal(resolveModelPeakEffort('G4 Hydrogen'), 'xhigh');
    assert.equal(resolveModelPeakEffort('G4 Neon'), 'xhigh');
    assert.equal(resolveModelPeakEffort('G4 Carbon'), 'high');
    assert.equal(resolveModelPeakEffort('G4 Argon'), 'high');
    assert.equal(resolveModelPeakEffort('G3.8 Flash'), 'high');
    assert.equal(resolveModelPeakEffort('Opus 5.5'), 'high');
    assert.equal(resolveModelPeakEffort('Sonnet 5.5'), 'high');
    assert.equal(resolveModelPeakEffort('gemini_4_carbon'), 'high');
    assert.equal(resolveModelPeakEffort('claude_opus_4_6'), 'high');
    assert.equal(resolveModelPeakEffort('MODEL_PLACEHOLDER_M427'), 'high');
    assert.equal(resolveModelPeakEffort('Custom Unknown'), null);

    // Hydrogen / Neon peak at xhigh, NOT high
    assert.equal(isPeakEffortForModel('G4 Hydrogen', 'high'), false);
    assert.equal(isPeakEffortForModel('G4 Hydrogen', 'xhigh'), true);
    assert.equal(isPeakEffortForModel('G4 Neon', 'high'), false);
    assert.equal(isPeakEffortForModel('G4 Neon', 'xhigh'), true);

    // Carbon / Argon / Flash / Claude peak at high
    assert.equal(isPeakEffortForModel('G4 Carbon', 'medium'), false);
    assert.equal(isPeakEffortForModel('G4 Carbon', 'high'), true);
    assert.equal(isPeakEffortForModel('G4 Argon', 'high'), true);
    assert.equal(isPeakEffortForModel('G3.8 Flash', 'high'), true);
    assert.equal(isPeakEffortForModel('Opus 5.5', 'high'), true);

    // Unknown models still treat xhigh/max as peak
    assert.equal(isPeakEffortForModel('Future Model', 'high'), false);
    assert.equal(isPeakEffortForModel('Future Model', 'xhigh'), true);
    assert.equal(isPeakEffortForModel('Future Model', 'max'), true);

    // Nested parentheses in Orchestrator role names (e.g. Opus 4.6 (Thinking)) preserve accurate per-role peak detection
    assert.deepEqual(resolveEffortPeakFlags('Orchestrator (Opus 4.6 (Thinking)/Hydrogen)', ['high', 'xhigh']), [
      true,
      true,
    ]);
    assert.deepEqual(resolveEffortPeakFlags('Orchestrator (Opus 4.6 (Thinking)/Hydrogen)', ['high', 'high']), [
      true,
      false,
    ]);

    // End-to-end parseModelAndEffort preserves model.id capability, placeholder slugs, and heterogeneous-peak Orchestrator pairs
    const byId = parseModelAndEffort({
      model: { id: 'claude-opus-4-6-thinking', display_name: 'Claude 4.6', effort: 'high' },
    });
    assert.deepEqual(byId.peakFlags, [true]);

    const fromSlug = parseModelAndEffort({
      model: { id: 'gemini-4-carbon-tiered-high', display_name: 'Gemini 4 Carbon' },
    });
    assert.equal(fromSlug.effort, 'high');
    assert.deepEqual(fromSlug.peakFlags, [true]);

    const fromPlaceholder = parseModelAndEffort({
      model: { id: 'MODEL_PLACEHOLDER_M427' },
    });
    assert.equal(fromPlaceholder.name, 'G4 Carbon');
    assert.equal(fromPlaceholder.effort, 'high');
    assert.deepEqual(fromPlaceholder.peakFlags, [true]);

    // Orchestrator same-effort different-peak (Neon high / Carbon high) must NOT collapse to plain yellow `high`
    const orchSplitPeak = parseModelAndEffort(
      { model: { display_name: 'Orchestrator (Neon)' } },
      { orchestrator: { planner: 'Gemini 4 Neon (High)', executor: 'Gemini 4 Carbon (High)' } },
    );
    assert.equal(orchSplitPeak.name, 'Orchestrator (Neon/Carbon)');
    assert.equal(orchSplitPeak.effort, 'high/high');
    assert.deepEqual(orchSplitPeak.peakFlags, [false, true]);

    // Orchestrator single-side effort keeps the right role's peak flag instead of losing the slot
    const orchOneSided = parseModelAndEffort(
      { model: { display_name: 'Orchestrator (Neon)' } },
      { orchestrator: { planner: 'Gemini 4 Neon', executor: 'Gemini 4 Carbon (High)' } },
    );
    assert.equal(orchOneSided.effort, 'high');
    assert.deepEqual(orchOneSided.peakFlags, [true]);

    // Orchestrator same-effort same-peak (Carbon high / Argon high) folds cleanly and marks peak
    const orchBothPeak = parseModelAndEffort(
      { model: { display_name: 'Orchestrator (Carbon)' } },
      { orchestrator: { planner: 'Gemini 4 Carbon (High)', executor: 'Gemini 4 Argon (High)' } },
    );
    assert.equal(orchBothPeak.effort, 'high');
    assert.deepEqual(orchBothPeak.peakFlags, [true]);
  });

  void it('renders progressive glyphs on xhigh-capable models and promotes Carbon/Argon high to calm monochrome platinum', () => {
    const hydrogenExpected: ReadonlyArray<readonly [string, string]> = [
      ['low', '◔'],
      ['medium', '◑'],
      ['high', '◕'],
      ['xhigh', '●'],
      ['max', '✦'],
    ];

    for (const [tier, glyph] of hydrogenExpected) {
      const plain = formatModelSegment('G4 Hydrogen', tier, { colorLevel: 'none', active: false, nowSec: 100 });
      const ansi16 = formatModelSegment('G4 Hydrogen', tier, { colorLevel: 'ansi16', active: false, nowSec: 100 });
      const truecolor = formatModelSegment('G4 Hydrogen', tier, {
        colorLevel: 'truecolor',
        active: false,
        nowSec: 100,
      });

      assert.equal(plain, `[G4 Hydrogen ${glyph} ${tier}]`);
      assert.equal(plain.includes('\x1b'), false);
      assert.equal(stripAnsi(ansi16), plain);
      assert.equal(stripAnsi(truecolor), plain);
      assert.equal(visibleLen(ansi16), visibleLen(plain));
      assert.equal(visibleLen(truecolor), visibleLen(plain));
    }

    const carbonHighPlain = formatModelSegment('G4 Carbon', 'high', { colorLevel: 'none', active: false, nowSec: 100 });
    const carbonHighTrue = formatModelSegment('G4 Carbon', 'high', {
      colorLevel: 'truecolor',
      active: false,
      nowSec: 100,
    });
    const argonHighTrue = formatModelSegment('G4 Argon', 'high', {
      colorLevel: 'truecolor',
      active: false,
      nowSec: 100,
    });
    assert.equal(carbonHighPlain, '[G4 Carbon ● high]');
    assert.ok(carbonHighTrue.includes('\x1b[38;2;172;184;200mhigh'));
    assert.ok(argonHighTrue.includes('\x1b[38;2;172;184;200mhigh'));

    // Hydrogen high stays standard yellow ◕; Hydrogen xhigh uses calm platinum without rainbow pink; uppercase Max normalizes cleanly
    const hydroHighTrue = formatModelSegment('G4 Hydrogen', 'high', {
      colorLevel: 'truecolor',
      active: false,
      nowSec: 100,
    });
    const hydroXhighTrue = formatModelSegment('G4 Hydrogen', 'xhigh', {
      colorLevel: 'truecolor',
      active: false,
      nowSec: 100,
    });
    const hydroXhigh16 = formatModelSegment('G4 Hydrogen', 'xhigh', {
      colorLevel: 'ansi16',
      active: false,
      nowSec: 100,
    });
    const upperMaxTrue = formatModelSegment('G4 Carbon', 'Max', {
      colorLevel: 'truecolor',
      active: false,
      nowSec: 100,
    });
    assert.ok(hydroHighTrue.includes('\x1b[33mhigh'));
    assert.ok(hydroXhighTrue.includes('\x1b[38;2;172;184;200mxhigh'));
    assert.equal(hydroXhighTrue.includes('244;114;182'), false, 'must not emit rainbow pink');
    assert.equal(hydroXhigh16.includes('\x1b[38;2;'), false);
    assert.ok(hydroXhigh16.includes('\x1b[37mxhigh'));
    assert.ok(upperMaxTrue.includes('✦') && upperMaxTrue.includes('\x1b[38;2;198;186;166mmax'));
  });

  void it('styles Orchestrator dual-role efforts per model ceiling without dead sweep frames on single-side peak', () => {
    const dual = formatModelSegment('Orchestrator (Neon/Carbon)', 'high/high', {
      colorLevel: 'truecolor',
      active: false,
      nowSec: 100,
    });
    assert.equal(stripAnsi(dual), '[Orchestrator (Neon/Carbon) ● high/high]');
    assert.ok(dual.includes('\x1b[33mhigh'), 'Neon high stays regular yellow');
    assert.ok(dual.includes('\x1b[38;2;172;184;200mhigh'), 'Carbon high promotes to platinum peak');

    // Single-side peak active sweep starts immediately on glyph (frame 0) and moves straight into Carbon `high` (frame 1)
    const active0 = formatModelSegment('Orchestrator (Neon/Carbon)', 'high/high', {
      colorLevel: 'ansi16',
      active: true,
      nowSec: 0,
    });
    const active1 = formatModelSegment('Orchestrator (Neon/Carbon)', 'high/high', {
      colorLevel: 'ansi16',
      active: true,
      nowSec: 0.35,
    });
    assert.ok(active0.includes('\x1b[1m\x1b[97m●'));
    assert.ok(active1.includes('\x1b[1m\x1b[97mh'));
    assert.notEqual(active0, active1);
  });

  void it('sweeps a seamless monochrome sheen with zero dead ANSI16 frames and calm rest beat across all peak models', () => {
    for (const [model, effort] of [
      ['G4 Hydrogen', 'xhigh'],
      ['G4 Carbon', 'high'],
      ['G4 Argon', 'high'],
    ] as const) {
      const f0 = formatModelSegment(model, effort, { colorLevel: 'truecolor', active: true, nowSec: 0.3 });
      const f1 = formatModelSegment(model, effort, { colorLevel: 'truecolor', active: true, nowSec: 0.9 });
      assert.notEqual(f0, f1, `${model} ${effort} must animate while active`);
      assert.equal(stripAnsi(f0), stripAnsi(f1));
      assert.equal(stripAnsi(f0), `[${model} ● ${effort}]`);

      const idle0 = formatModelSegment(model, effort, { colorLevel: 'truecolor', active: false, nowSec: 0.3 });
      const idle1 = formatModelSegment(model, effort, { colorLevel: 'truecolor', active: false, nowSec: 0.9 });
      assert.equal(idle0, idle1, `${model} ${effort} must freeze when idle`);
    }

    // ANSI16 sweep must light at least one character on every sweep frame (frames 0..4 for `● high`, 5 visible peak chars)
    for (let frame = 0; frame < 5; frame += 1) {
      const rendered = formatModelSegment('G4 Carbon', 'high', {
        colorLevel: 'ansi16',
        active: true,
        nowSec: frame * 0.3 + 0.05,
      });
      assert.ok(rendered.includes('\x1b[1m\x1b[97m'), `ANSI16 sweep frame ${frame} must not be dark dead frame`);
    }
    // Rest beat (frame 5..8 on ANSI16, frame 7..10 on TrueColor for `● high`) matches calm idle tone seamlessly
    const ansiRest = formatModelSegment('G4 Carbon', 'high', { colorLevel: 'ansi16', active: true, nowSec: 1.6 });
    const ansiIdle = formatModelSegment('G4 Carbon', 'high', { colorLevel: 'ansi16', active: false, nowSec: 1.6 });
    assert.equal(ansiRest, ansiIdle);

    const trueRest = formatModelSegment('G4 Carbon', 'high', { colorLevel: 'truecolor', active: true, nowSec: 2.2 });
    const trueIdle = formatModelSegment('G4 Carbon', 'high', { colorLevel: 'truecolor', active: false, nowSec: 2.2 });
    assert.equal(trueRest, trueIdle);

    // Non-peak tiers keep quiet quadrant stepping while active
    const lowActive0 = formatModelSegment('G3.8 Flash', 'low', { colorLevel: 'ansi16', active: true, nowSec: 0 });
    const lowActive1 = formatModelSegment('G3.8 Flash', 'low', { colorLevel: 'ansi16', active: true, nowSec: 0.35 });
    assert.equal(stripAnsi(lowActive0), '[G3.8 Flash ◔ low]');
    assert.equal(stripAnsi(lowActive1), '[G3.8 Flash ◑ low]');
  });

  void it('keeps agy-hud preview byte-for-byte deterministic with 512k Context Budget sample', () => {
    const cfg = buildPresetConfig('full');
    const first = renderHudPreviewLines(cfg, { width: 120, color: false });
    const second = renderHudPreviewLines(cfg, { width: 120, color: false });
    assert.deepEqual(first, second);
    const joined = first.join('\n');
    assert.ok(joined.includes('[G4 Carbon ● high]'));
    assert.ok(joined.includes('(195k/512k)'));
  });
});
