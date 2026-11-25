import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DEFAULT_HUD_CONFIG } from '../../types.ts';
import { configureHud, parseConfigureArgs } from '../configure.ts';
import { sanitizeHudConfigTemplate } from '../sanitize.ts';

const tempDirs: string[] = [];

function makeTempCliHome(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return path.join(root, '.gemini', 'antigravity-cli');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

void describe('sanitizeHudConfigTemplate', async () => {
  await it('whitelists canonical fields while dropping unknown keys', () => {
    const sanitized = sanitizeHudConfigTemplate({
      preset: 'swarm',
      maxAgentChips: 6,
      osc8Links: false,
      autoWireStatusLine: true,
      secretNote: 'drop-me',
      lines: ['usage', 'identity', 'unknown_cmd', 'usage', 'agents'],
      segments: {
        cost: false,
        perf: false,
        secretSegment: 'drop-me',
      },
    });

    assert.equal(sanitized.preset, 'swarm');
    assert.equal(sanitized.maxAgentChips, 6);
    assert.equal(sanitized.osc8Links, false);
    assert.equal('autoWireStatusLine' in sanitized, false);
    assert.equal('secretNote' in sanitized, false);
    assert.deepEqual(sanitized.lines, ['usage', 'identity', 'agents']);
    const segments = sanitized.segments as Record<string, unknown>;
    assert.equal(segments.cost, false);
    assert.equal(segments.perf, false);
    assert.equal(segments.model, true);
    assert.equal('secretSegment' in segments, false);
  });

  await it('rejects invalid field types during sanitization', () => {
    assert.throws(() => sanitizeHudConfigTemplate({ preset: 'ultra' }), /Invalid 'preset'/);
    assert.throws(() => sanitizeHudConfigTemplate({ maxAgentChips: 25 }), /Invalid 'maxAgentChips'/);
    assert.throws(() => sanitizeHudConfigTemplate({ osc8Links: 'yes' }), /Invalid boolean 'osc8Links'/);
    assert.throws(() => sanitizeHudConfigTemplate({ lines: 'identity' }), /Invalid 'lines'/);
    assert.throws(() => sanitizeHudConfigTemplate({ lines: ['identity', { bad: true }] }), /Invalid line ID/);
    assert.throws(() => sanitizeHudConfigTemplate({ segments: ['cost'] }), /Invalid 'segments'/);
    assert.throws(() => sanitizeHudConfigTemplate({ segments: { cost: 'no' } }), /Invalid boolean 'segments\.cost'/);
    assert.throws(
      () => sanitizeHudConfigTemplate({ segments: { cost: { nestedSecret: 'leak' } } }),
      /Invalid boolean 'segments\.cost'/,
    );
  });
});

void describe('pluggable configure CLI parsing and mutations', async () => {
  await it('parses positional preset with modular flags', () => {
    const parsed = parseConfigureArgs([
      'swarm',
      '--enable',
      'tools,skills',
      '--disable=cost,perf',
      '--order',
      'identity,usage,agents,tools',
      '--set',
      'osc8Links=false',
      '--json',
    ]);
    assert.equal(parsed.help, false);
    assert.equal(parsed.json, true);
    assert.equal(parsed.interactive, false);
    assert.equal(parsed.options.preset, 'swarm');
    assert.deepEqual(parsed.options.enable, ['tools', 'skills']);
    assert.deepEqual(parsed.options.disable, ['cost', 'perf']);
    assert.deepEqual(parsed.options.order, ['identity', 'usage', 'agents', 'tools']);
    assert.deepEqual(parsed.options.sets, ['osc8Links=false']);
  });

  await it('parses short and long interactive configure flags', () => {
    const shortFlag = parseConfigureArgs(['-i']);
    assert.equal(shortFlag.interactive, true);
    assert.equal(shortFlag.options.interactive, true);

    const longFlag = parseConfigureArgs(['--interactive']);
    assert.equal(longFlag.interactive, true);
    assert.equal(longFlag.options.interactive, true);
  });

  await it('preserves top-level numeric and link options when switching presets', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-seed-');
    configureHud({ cliHome, sets: ['maxAgentChips=5', 'osc8Links=false'] });

    const switched = configureHud({ cliHome, preset: 'zen' });
    assert.equal(switched.config.preset, 'zen');
    assert.equal(switched.config.maxAgentChips, 5);
    assert.equal(switched.config.osc8Links, false);
    assert.deepEqual(switched.config.lines, ['identity']);
    assert.equal(switched.config.segments.perf, false);
    assert.equal(switched.config.segments.cost, false);
    assert.equal(switched.config.segments.context, true);
    assert.equal(switched.config.segments.quota, true);
  });

  await it('applies preset with modular overrides in one invocation', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-combo-');
    const parsed = parseConfigureArgs([
      'compact',
      '--enable',
      'tools,agents',
      '--disable',
      'activity,cost',
      '--order',
      'identity,usage,tools,agents',
      '--set',
      'osc8Links=false',
      '--set',
      'maxAgentChips=6',
    ]);
    const res = configureHud({ ...parsed.options, cliHome });
    assert.equal(res.config.preset, 'compact');
    assert.equal(res.config.osc8Links, false);
    assert.equal(res.config.maxAgentChips, 6);
    assert.deepEqual(res.config.lines, ['identity', 'usage', 'tools', 'agents']);
    assert.equal(res.config.segments.cost, false);
    assert.equal(res.config.segments.perf, true);
  });

  await it('rejects removed unpublished show* keys in --set', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-removed-');
    assert.throws(() => configureHud({ cliHome, sets: ['showCost=false'] }), /Unknown configuration key/);
  });

  await it('updates individual segments via --set segments.<id>', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-seg-');
    const res = configureHud({
      cliHome,
      sets: ['segments.git=false', 'segments.duration=false', 'osc8Links=false'],
    });
    assert.equal(res.config.segments.git, false);
    assert.equal(res.config.segments.duration, false);
    assert.equal(res.config.osc8Links, false);
  });

  await it('rejects invalid configure flags or unknown target identifiers', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-err-');
    assert.throws(() => parseConfigureArgs(['zen', 'full']), /Duplicate preset/);
    assert.throws(() => parseConfigureArgs(['zen', '--preset', 'full']), /Duplicate preset/);
    assert.throws(() => parseConfigureArgs(['bogus-preset']), /Unknown configure option|invalid preset/i);
    assert.throws(() => parseConfigureArgs(['--enable', '']), /Empty|--enable/i);
    assert.throws(() => configureHud({ cliHome, enable: ['bogus'] }), /Unknown module or segment/);
    assert.throws(() => configureHud({ cliHome, disable: ['bogus'] }), /Unknown module or segment/);
    assert.throws(() => configureHud({ cliHome, order: ['cost'] }), /Invalid line ID/);
    assert.throws(() => configureHud({ cliHome, sets: ['autoWireStatusLine=true'] }), /Unknown configuration key/);
  });

  await it('throws without overwriting corrupted hud-config.json', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-corrupt-');
    mkdirSync(cliHome, { recursive: true });
    const configPath = path.join(cliHome, 'hud-config.json');
    const rawCorrupt = '{broken-json';
    writeFileSync(configPath, rawCorrupt, 'utf8');

    assert.throws(() => configureHud({ cliHome, preset: 'zen' }), /Invalid JSON/);
    assert.equal(readFileSync(configPath, 'utf8'), rawCorrupt);
  });

  await it('resets hud-config.json back to the full default preset', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-reset-');
    configureHud({ cliHome, preset: 'zen', sets: ['osc8Links=false', 'maxAgentChips=2'] });
    const reset = configureHud({ cliHome, reset: true });
    assert.equal(reset.action, 'reset');
    assert.deepEqual(reset.config, DEFAULT_HUD_CONFIG);
  });
});
