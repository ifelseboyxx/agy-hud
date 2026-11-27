import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeResponseModelSlug,
  resolveGenModelDisplayName,
  resolveKnownModelPlaceholder,
} from '../model-names.ts';

void describe('clean-room model placeholder and slug normalization', () => {
  void it('maps verified local Antigravity CLI enums and MODEL_PLACEHOLDER_M* strings', () => {
    assert.equal(resolveKnownModelPlaceholder('MODEL_PLACEHOLDER_M26', 1026), 'Claude Opus 4.6 (Thinking)');
    assert.equal(resolveKnownModelPlaceholder('MODEL_PLACEHOLDER_M35', 1035), 'Claude Sonnet 4.6 (Thinking)');
    assert.equal(resolveKnownModelPlaceholder('MODEL_PLACEHOLDER_M318', 1318), 'Gemini 3.8 Flash (High)');
    assert.equal(resolveKnownModelPlaceholder('MODEL_PLACEHOLDER_M528', 1528), 'Gemini 4 Hydrogen (XHigh)');
    assert.equal(resolveKnownModelPlaceholder('MODEL_PLACEHOLDER_M535', 1535), 'Gemini 4 Neon (XHigh)');
    assert.equal(resolveKnownModelPlaceholder(undefined, 1667), 'Orchestrator (Carbon)');
    assert.equal(resolveKnownModelPlaceholder(undefined, 1669), 'Gemini 4 Hydrogen (Orchestrator)');
    // Unknown future placeholder must never be guessed
    assert.equal(resolveKnownModelPlaceholder('MODEL_PLACEHOLDER_M999', 1999), null);
  });

  void it('formats deterministic provider response_model slugs', () => {
    assert.equal(normalizeResponseModelSlug('gemini-4-neon'), 'Gemini 4 Neon');
    assert.equal(normalizeResponseModelSlug('gemini-4-hydrogen-tiered-xhigh'), 'Gemini 4 Hydrogen (XHigh)');
    assert.equal(normalizeResponseModelSlug('gemini-3.8-flash-n'), 'Gemini 3.8 Flash');
    assert.equal(normalizeResponseModelSlug('claude-opus-4-6-thinking'), 'Claude Opus 4.6 (Thinking)');
    assert.equal(normalizeResponseModelSlug('claude-sonnet-4-6'), 'Claude Sonnet 4.6');
    assert.equal(normalizeResponseModelSlug('gpt-oss-120b-high'), 'GPT-OSS 120B (High)');
    assert.equal(normalizeResponseModelSlug('custom-internal-v1'), null);
  });

  void it('follows exact priority display_name -> verified placeholder -> slug -> raw enum', () => {
    assert.equal(
      resolveGenModelDisplayName({
        displayName: 'Gemini 4 Carbon (High)',
        modelEnumStr: 'MODEL_PLACEHOLDER_M427',
        modelEnum: 1427,
        responseModel: 'gemini-4-carbon',
      }),
      'Gemini 4 Carbon (High)',
    );
    assert.equal(
      resolveGenModelDisplayName({
        modelEnumStr: 'MODEL_PLACEHOLDER_M535',
        modelEnum: 1535,
        responseModel: 'gemini-4-neon',
      }),
      'Gemini 4 Neon (XHigh)',
    );
    assert.equal(
      resolveGenModelDisplayName({
        modelEnumStr: 'MODEL_PLACEHOLDER_M999',
        modelEnum: 1999,
        responseModel: 'gemini-4-carbon-tiered-high',
      }),
      'Gemini 4 Carbon (High)',
    );
    assert.equal(
      resolveGenModelDisplayName({
        modelEnumStr: 'MODEL_PLACEHOLDER_M999',
        modelEnum: 1999,
      }),
      'MODEL_PLACEHOLDER_M999',
    );
  });
});
