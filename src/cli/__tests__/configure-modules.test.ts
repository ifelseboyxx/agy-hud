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
  await it('validates 5-preset enum, maxAgentChips, osc8Links, and whitelists/deduplicates lines', () => {
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

  await it('hydrates legacy show* keys into canonical lines and segments during sanitization', () => {
    const sanitized = sanitizeHudConfigTemplate({
      preset: 'full',
      showSkillsMcpLine: false,
      showCost: false,
    });
    assert.equal(sanitized.preset, 'full');
    assert.equal('showCost' in sanitized, false);
    assert.equal('showSkillsMcpLine' in sanitized, false);
    assert.deepEqual(sanitized.lines, ['mode', 'identity', 'usage', 'tools', 'agents', 'todos']);
    assert.equal((sanitized.segments as Record<string, boolean>).cost, false);
  });

  await it('rejects invalid preset, maxAgentChips, osc8Links, lines, and segment value types', () => {
    assert.throws(() => sanitizeHudConfigTemplate({ preset: 'ultra' }), /Invalid 'preset'/);
    assert.throws(() => sanitizeHudConfigTemplate({ maxAgentChips: 25 }), /Invalid 'maxAgentChips'/);
    assert.throws(() => sanitizeHudConfigTemplate({ osc8Links: 'yes' }), /Invalid boolean 'osc8Links'/);
    assert.throws(() => sanitizeHudConfigTemplate({ lines: 'identity' }), /Invalid 'lines'/);
    assert.throws(() => sanitizeHudConfigTemplate({ lines: ['identity', { bad: true }] }), /Invalid line ID/);
    assert.throws(() => sanitizeHudConfigTemplate({ segments: ['cost'] }), /Invalid 'segments'/);
    assert.throws(() => sanitizeHudConfigTemplate({ segments: { cost: 'no' } }), /Invalid boolean 'segments\.cost'/);
    assert.throws(
      () => sanitizeHudConfigTemplate({ showCost: { nestedSecret: 'leak' } }),
      /Invalid boolean 'showCost'/,
    );
  });
});

void describe('pluggable configure CLI parsing and mutations', async () => {
  await it('parses positional preset shorthand, --enable, --disable, --order, --set, and -i flags', () => {
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

    const interactiveParsed = parseConfigureArgs(['-i']);
    assert.equal(interactiveParsed.interactive, true);
    assert.equal(interactiveParsed.options.interactive, true);

    const interactiveLong = parseConfigureArgs(['--interactive']);
    assert.equal(interactiveLong.interactive, true);
    assert.equal(interactiveLong.options.interactive, true);
  });

  await it('seeds lines and segments from preset while preserving maxAgentChips and osc8Links', () => {
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

  await it('applies preset together with --enable, --disable, --order, and --set in one invocation', () => {
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

  await it('supports legacy show* --set aliases including showSkillsMcpLine for both skills and mcps', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-legacy-');
    const enabled = configureHud({
      cliHome,
      preset: 'compact',
      sets: ['showSkillsMcpLine=true', 'showToolsLine=true', 'showPerfCapsule=false', 'showQuota=false'],
    });
    assert.deepEqual(enabled.config.lines, ['mode', 'identity', 'usage', 'activity', 'tools', 'skills', 'mcps']);
    assert.equal(enabled.config.segments.perf, false);
    assert.equal(enabled.config.segments.quota, false);

    const disabled = configureHud({ cliHome, sets: ['showSkillsMcpLine=false', 'showModeLine=false'] });
    assert.deepEqual(disabled.config.lines, ['identity', 'usage', 'activity', 'tools']);
  });

  await it('supports --set segments.<id>=<bool> and --set osc8Links=<bool>', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-seg-');
    const res = configureHud({
      cliHome,
      sets: ['segments.git=false', 'segments.duration=false', 'osc8Links=false'],
    });
    assert.equal(res.config.segments.git, false);
    assert.equal(res.config.segments.duration, false);
    assert.equal(res.config.osc8Links, false);
  });

  await it('rejects invalid --enable, --disable, --order, duplicate presets, and autoWireStatusLine', () => {
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

  await it('throws without overwriting when existing hud-config.json contains corrupted JSON', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-corrupt-');
    mkdirSync(cliHome, { recursive: true });
    const configPath = path.join(cliHome, 'hud-config.json');
    const rawCorrupt = '{broken-json';
    writeFileSync(configPath, rawCorrupt, 'utf8');

    assert.throws(() => configureHud({ cliHome, preset: 'zen' }), /Invalid JSON/);
    assert.equal(readFileSync(configPath, 'utf8'), rawCorrupt);
  });

  await it('resets hud-config.json back to compact default with osc8Links=true and maxAgentChips=8', () => {
    const cliHome = makeTempCliHome('agy-hud-cfg-reset-');
    configureHud({ cliHome, preset: 'zen', sets: ['osc8Links=false', 'maxAgentChips=2'] });
    const reset = configureHud({ cliHome, reset: true });
    assert.equal(reset.action, 'reset');
    assert.deepEqual(reset.config, DEFAULT_HUD_CONFIG);
  });
});
