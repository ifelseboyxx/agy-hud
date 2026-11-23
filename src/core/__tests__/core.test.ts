import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseStatusLineData } from '../../hud-entry.ts';
import { DEFAULT_HUD_CONFIG } from '../../types.ts';
import { hydrateHudConfig, mergeHudConfig } from '../hud-config.ts';
import { getHomeDir, resolveCliHome } from '../paths.ts';
import { isValidBackupRecord } from '../statusline-ownership.ts';

void describe('core paths, config schema, ownership, and stdin boundary', async () => {
  await it('falls back from empty HOME string to USERPROFILE in getHomeDir', () => {
    const home = getHomeDir({ HOME: '   ', USERPROFILE: '/fallback/profile' });
    assert.equal(home, '/fallback/profile');
    assert.equal(
      resolveCliHome(undefined, { HOME: '', USERPROFILE: '/fallback/profile' }),
      path.join('/fallback/profile', '.gemini', 'antigravity-cli'),
    );
  });

  await it('shares one HudConfig schema between lenient mergeHudConfig and strict hydrateHudConfig', () => {
    assert.deepEqual(mergeHudConfig({ preset: 'invalid', maxAgentChips: 99, showCost: 'yes' }), DEFAULT_HUD_CONFIG);
    assert.throws(() => hydrateHudConfig({ preset: 'invalid' }), /Invalid 'preset'/);
    assert.throws(() => hydrateHudConfig({ maxAgentChips: 21 }), /Invalid 'maxAgentChips'/);
    assert.throws(() => hydrateHudConfig({ showCost: 'yes' }), /Invalid boolean 'showCost'/);
  });

  await it('ignores unknown legacy keys such as autoWireStatusLine in hud-config.json', () => {
    assert.deepEqual(mergeHudConfig({ autoWireStatusLine: true, showCost: false }), {
      ...DEFAULT_HUD_CONFIG,
      showCost: false,
    });
    assert.deepEqual(hydrateHudConfig({ autoWireStatusLine: true, showCost: false }), {
      ...DEFAULT_HUD_CONFIG,
      showCost: false,
    });
  });

  await it('requires non-empty wiredCommand in modern statusLine backup records', () => {
    assert.equal(isValidBackupRecord({ hadStatusLine: false, previousStatusLine: null }), false);
    assert.equal(isValidBackupRecord({ wiredCommand: '   ', hadStatusLine: false, previousStatusLine: null }), false);
    assert.equal(
      isValidBackupRecord({ wiredCommand: '/p/dist/hud.mjs', hadStatusLine: false, previousStatusLine: null }),
      true,
    );
  });

  await it('sanitizes malformed nested fields and unsafe keys in parseStatusLineData', () => {
    assert.equal(parseStatusLineData(null), null);
    assert.equal(parseStatusLineData(['not-an-object']), null);
    const parsed = parseStatusLineData({
      model: 'bad-scalar',
      subagents: 'not-array',
      cwd: '/tmp/work',
      context_window: { used_percentage: 42 },
    });
    assert.ok(parsed);
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.subagents, undefined);
    assert.equal(parsed.cwd, '/tmp/work');
    assert.equal(parsed.context_window?.used_percentage, 42);
  });
});
