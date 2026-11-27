import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { formatAgentsSection } from '../../render/agents-render.ts';
import { GRAY, RESET, stripAnsi, visibleLen } from '../../render/ansi.ts';
import { type AgentEntry, type AgentsSummary, DEFAULT_HUD_CONFIG } from '../../types.ts';
import { collectAgentsSummary } from '../agents.ts';

const ESC = String.fromCharCode(0x1b);

function makeSummary(kind: 'swarm' | 'agents', entries: AgentEntry[]): AgentsSummary {
  const working = entries.filter((e) => e.state === 'working').length;
  const waiting = entries.filter((e) => e.state === 'waiting').length;
  const alive = working + waiting;
  return {
    kind,
    working,
    waiting,
    alive,
    total: kind === 'swarm' ? alive : entries.length,
    entries,
  };
}

void describe('formatAgentsSection width-aware packing and done window', () => {
  void it('raises DEFAULT_HUD_CONFIG.maxAgentChips to 8 and disables the row when maxAgentChips is 0', () => {
    assert.equal(DEFAULT_HUD_CONFIG.maxAgentChips, 8);
    const summary = makeSummary('swarm', [{ name: 'w1', type: 'worker', model: '', state: 'working', ts: null }]);
    assert.equal(formatAgentsSection(summary, 0, 1000, 120), '');
  });

  void it('orders working ahead of waiting and packs up to 8 chips within termWidth - 1 including CJK names', () => {
    const entries: AgentEntry[] = [
      { name: '等待员甲', type: 'worker', model: '', state: 'waiting', ts: null },
      { name: '开发员一', type: 'worker', model: '', state: 'working', ts: null },
      { name: '开发员二', type: 'worker', model: '', state: 'working', ts: null },
      { name: '测试员三', type: 'worker', model: '', state: 'working', ts: null },
      { name: '审查员四', type: 'worker', model: '', state: 'working', ts: null },
      { name: '等待员乙', type: 'worker', model: '', state: 'waiting', ts: null },
      { name: '等待员丙', type: 'worker', model: '', state: 'waiting', ts: null },
      { name: '等待员丁', type: 'worker', model: '', state: 'waiting', ts: null },
      { name: '等待员戊', type: 'worker', model: '', state: 'waiting', ts: null },
      { name: '等待员己', type: 'worker', model: '', state: 'waiting', ts: null },
    ];
    const summary = makeSummary('swarm', entries);

    for (const width of [80, 120, 160]) {
      const line = formatAgentsSection(summary, undefined, 1000, width);
      const plain = stripAnsi(line);
      assert.ok(visibleLen(line) <= width - 1, `width ${width} overflowed: ${visibleLen(line)} > ${width - 1}`);
      assert.equal(plain.startsWith('  ◐ Swarm (4/10): ◐ 开发员一'), true);
    }

    const widePlain = stripAnsi(formatAgentsSection(summary, undefined, 1000, 160));
    assert.equal(
      widePlain,
      '  ◐ Swarm (4/10): ◐ 开发员一, ◐ 开发员二, ◐ 测试员三, ◐ 审查员四, ◌ 等待员甲, ◌ 等待员乙, ◌ 等待员丙, ◌ 等待员丁, +2 more',
    );
  });

  void it('formats all-waiting Swarm and mixed alive/done Agents headers within termWidth - 1', () => {
    const waitingSwarm = makeSummary('swarm', [
      { name: 'waiter-1', type: 'worker', model: '', state: 'waiting', ts: null },
      { name: 'waiter-2', type: 'worker', model: '', state: 'waiting', ts: null },
    ]);
    assert.equal(
      stripAnsi(formatAgentsSection(waitingSwarm, 8, 1000, 120)),
      '  ◌ Swarm (0/2 waiting): ◌ waiter-1, ◌ waiter-2',
    );

    const mixedAgents = makeSummary('agents', [
      { name: 'live-1', type: 'worker', model: '', state: 'working', ts: null },
      { name: 'done-1', type: 'worker', model: '', state: 'done', ts: 990 },
    ]);
    assert.equal(stripAnsi(formatAgentsSection(mixedAgents, 8, 1000, 120)), '  ◐ Agents (1/2): ◐ live-1');
  });

  void it('tail-ellipsizes item 0 on narrow widths for Swarm without emitting a zero-item row', () => {
    const summary = makeSummary('swarm', [
      {
        name: 'very-long-subagent-role-name-for-narrow-terminal-check',
        type: 'worker',
        model: '',
        state: 'working',
        ts: null,
      },
      { name: 'second-worker', type: 'worker', model: '', state: 'waiting', ts: null },
      { name: 'third-worker', type: 'worker', model: '', state: 'waiting', ts: null },
    ]);
    const line = formatAgentsSection(summary, 8, 1000, 50);
    const plain = stripAnsi(line);

    assert.ok(visibleLen(line) <= 49);
    assert.equal(plain.startsWith('  ◐ Swarm (1/3): ◐ very-long-'), true);
    assert.equal(plain.endsWith('…, +2 more'), true);
    assert.equal(plain.includes('(1/3): +3 more'), false);
  });

  void it('removes the legacy min(3, maxAgentChips) clamp in the 60s done retention window', () => {
    const nowSec = 1000;
    const entries: AgentEntry[] = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((name, idx) => ({
      name,
      type: 'worker',
      model: '',
      state: 'done',
      ts: nowSec - (60 - (idx + 1) * 5),
    }));
    const summary = makeSummary('agents', entries);
    const line = formatAgentsSection(summary, undefined, nowSec, 160);
    const plain = stripAnsi(line);

    assert.equal(plain, '  ✓ Agents (6 done): a1, a2, a3, a4, a5, a6');
    assert.ok(visibleLen(line) <= 159);
  });

  void it('selects the most recently completed K entries in the 60s done window and renders them chronologically', () => {
    const nowSec = 1000;
    const entries: AgentEntry[] = [
      { name: 'oldest-1', type: 'worker', model: '', state: 'done', ts: 970 },
      { name: 'latest-5', type: 'worker', model: '', state: 'done', ts: 995 },
      { name: 'second-2', type: 'worker', model: '', state: 'done', ts: 980 },
      { name: 'fourth-4', type: 'worker', model: '', state: 'done', ts: 990 },
      { name: 'third-3', type: 'worker', model: '', state: 'done', ts: 985 },
    ];
    const summary = makeSummary('agents', entries);

    const capped = formatAgentsSection(summary, 3, nowSec, 160);
    assert.equal(stripAnsi(capped), '  ✓ Agents (5 done): third-3, fourth-4, latest-5, +2 more');

    const narrow = formatAgentsSection(summary, 8, nowSec, 50);
    assert.equal(stripAnsi(narrow), '  ✓ Agents (5 done): fourth-4, latest-5, +3 more');
    assert.ok(visibleLen(narrow) <= 49);
  });

  void it('ellipsizes the most recently completed done agent on narrow widths without zero-item rows', () => {
    const nowSec = 1000;
    const summary = makeSummary('agents', [
      { name: 'older-agent', type: 'worker', model: '', state: 'done', ts: 980 },
      {
        name: 'newest-very-long-completed-subagent-name-for-narrow-width',
        type: 'worker',
        model: '',
        state: 'done',
        ts: 995,
      },
    ]);
    const line = formatAgentsSection(summary, 8, nowSec, 50);
    const plain = stripAnsi(line);

    assert.ok(visibleLen(line) <= 49);
    assert.equal(plain.startsWith('  ✓ Agents (2 done): newest-'), true);
    assert.equal(plain.endsWith('…, +1 more'), true);
  });

  void it('supports formatOverflow OSC 8 decoration on alive and done agent rows with unlinked separators', () => {
    const uri = 'file:///tmp/snap.md';
    const formatOverflow = (hidden: number): string =>
      `${GRAY}${ESC}]8;;${uri}${ESC}\\+${hidden} more${ESC}]8;;${ESC}\\${RESET}`;

    const aliveSummary = makeSummary('agents', [
      { name: 'w1', type: 'worker', model: '', state: 'working', ts: null },
      { name: 'w2', type: 'worker', model: '', state: 'working', ts: null },
      { name: 'w3', type: 'worker', model: '', state: 'waiting', ts: null },
    ]);
    const aliveLine = formatAgentsSection(aliveSummary, 2, 1000, 120, { formatOverflow });
    assert.ok(aliveLine.includes(`, ${GRAY}${ESC}]8;;${uri}${ESC}\\+1 more${ESC}]8;;${ESC}\\${RESET}`));
    assert.equal(stripAnsi(aliveLine), '  ◐ Agents (3): ◐ w1, ◐ w2, +1 more');

    const doneSummary = makeSummary('agents', [
      { name: 'd1', type: 'worker', model: '', state: 'done', ts: 980 },
      { name: 'd2', type: 'worker', model: '', state: 'done', ts: 990 },
      { name: 'd3', type: 'worker', model: '', state: 'done', ts: 995 },
    ]);
    const doneLine = formatAgentsSection(doneSummary, 2, 1000, 120, { formatOverflow });
    assert.ok(doneLine.includes(`, ${GRAY}${ESC}]8;;${uri}${ESC}\\+1 more${ESC}]8;;${ESC}\\${RESET}`));
    assert.equal(stripAnsi(doneLine), '  ✓ Agents (3 done): d2, d3, +1 more');
  });

  void it('reads regular swarm members.json while refusing symlinked and oversized (>1 MiB) rosters', () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-swarm-roster-'));
    try {
      const cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
      const convId = 'swarm-roster-guard-1';
      const swarmDir = path.join(cliHome, 'brain', convId, '.system_generated', 'swarm');
      mkdirSync(swarmDir, { recursive: true });
      const rosterPath = path.join(swarmDir, 'members.json');
      const validPayload = JSON.stringify({
        members: {
          coordinator: { role: 'coordinator' },
          alpha: { role: 'worker', wake_mode: 'mentions' },
        },
      });

      // Positive control: valid regular members.json loads swarm
      writeFileSync(rosterPath, validPayload, 'utf8');
      const ok = collectAgentsSummary(cliHome, { conversation_id: convId });
      assert.equal(ok.kind, 'swarm');
      assert.equal(ok.entries[0]?.name, 'alpha');

      // Oversized (>1 MiB) roster is rejected safely
      writeFileSync(rosterPath, JSON.stringify({ members: { pad: 'x'.repeat(1024 * 1024 + 64) } }), 'utf8');
      const oversized = collectAgentsSummary(cliHome, { conversation_id: convId });
      assert.equal(oversized.kind, 'agents');
      assert.equal(oversized.entries.length, 0);

      // Symlinked roster is rejected safely on POSIX
      if (process.platform !== 'win32') {
        const outside = path.join(tmpRoot, 'outside-members.json');
        writeFileSync(outside, validPayload, 'utf8');
        rmSync(rosterPath, { force: true });
        symlinkSync(outside, rosterPath);
        const sym = collectAgentsSummary(cliHome, { conversation_id: convId });
        assert.equal(sym.kind, 'agents');
        assert.equal(sym.entries.length, 0);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
