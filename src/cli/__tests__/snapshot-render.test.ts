import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shortenTarget } from '../../collectors/activity-parse.ts';
import { formatToolsLine } from '../../render/activity-lines.ts';
import { stripAnsi, visibleLen } from '../../render/ansi.ts';
import type { ActivitySnapshot, SnapshotCompletedTool, SnapshotRunningTool } from '../../snapshot-types.ts';
import type { TranscriptToolEntry } from '../../types.ts';
import {
  renderStructuredInspector,
  renderStructuredInspectorLines,
  shouldUseSnapshotColor,
} from '../snapshot-render.ts';

function makeSnapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    convId: 'conv-abcdef123456',
    shortId: 'conv-abc',
    surface: 'cli',
    title: 'Inspect overflow layout',
    model: 'Gemini 4 Carbon',
    workspace: '/Users/dev/work/agy-hud',
    dataRoot: '/Users/dev/.gemini/antigravity-cli',
    resolutionTier: 'pid',
    running: false,
    updatedAtMs: Date.parse('2026-06-01T12:00:00Z'),
    ageLabel: '12s ago',
    livePid: 4242,
    siblingCandidates: [],
    siblingHint: '',
    telemetry: {
      genCount: 3,
      tps: 92.4,
      ttft: 1.45,
      cachePct: 86.2,
      ctxUsed: 42_000,
      ctxMax: 200_000,
    },
    runningTools: [],
    completedTools: [
      {
        disp: 'read_file',
        count: 14,
        latestTarget: 'snapshot-render.ts',
        fullTarget: '/Users/dev/work/agy-hud/src/cli/snapshot-render.ts',
        recentTargets: ['/Users/dev/work/agy-hud/src/cli/snapshot-render.ts'],
        isMcp: false,
      },
      {
        disp: 'edit_file',
        count: 8,
        latestTarget: 'cli-entry.ts',
        fullTarget: '/Users/dev/work/agy-hud/src/cli-entry.ts',
        recentTargets: ['/Users/dev/work/agy-hud/src/cli-entry.ts'],
        isMcp: false,
      },
    ],
    totalToolCalls: 22,
    skills: ['tdd', 'codebase-design', 'security-and-hardening'],
    mcps: [
      {
        server: 'agy-fast',
        totalCalls: 7,
        subtools: [
          { name: 'batch_search', count: 4 },
          { name: 'run_checks', count: 3 },
        ],
      },
    ],
    agentsKind: 'agents',
    agents: [
      { name: 'Verifier', type: 'review', model: 'Gemini 4 Flash', state: 'working', ts: null, ageLabel: 'live' },
      { name: 'Scout', type: 'explore', model: 'Gemini 4 Flash', state: 'waiting', ts: null, ageLabel: 'live' },
      { name: 'Planner', type: 'plan', model: 'inherit', state: 'done', ts: 1780314000, ageLabel: '3m ago' },
    ],
    todos: null,
    ...overrides,
  };
}

function makeCompletedTools(count: number): SnapshotCompletedTool[] {
  return Array.from({ length: count }, (_, idx) => ({
    disp: `tool_name_${String(idx + 1).padStart(2, '0')}`,
    count: count - idx,
    latestTarget: `file_${idx + 1}.ts`,
    fullTarget: `/repo/src/file_${idx + 1}.ts`,
    recentTargets: [`/repo/src/file_${idx + 1}.ts`],
    isMcp: false,
  }));
}

void describe('Structured Inspector terminal renderer', () => {
  void it('suppresses ANSI SGR on --no-color, NO_COLOR, and TERM=dumb while preserving SGR by default', () => {
    assert.equal(shouldUseSnapshotColor(false, {}), true);
    assert.equal(shouldUseSnapshotColor(true, {}), false);
    assert.equal(shouldUseSnapshotColor(false, { NO_COLOR: '1' }), false);
    assert.equal(shouldUseSnapshotColor(false, { NO_COLOR: '' }), false);
    assert.equal(shouldUseSnapshotColor(false, { TERM: 'dumb' }), false);
    assert.equal(shouldUseSnapshotColor(false, { TERM: 'DUMB' }), false);

    const colored = renderStructuredInspector(makeSnapshot(), { color: true, width: 100 });
    assert.notEqual(colored, stripAnsi(colored), 'default piped render should preserve ANSI SGR');

    const plain = renderStructuredInspector(makeSnapshot(), { color: false, width: 100 });
    assert.equal(plain, stripAnsi(plain), 'no-color render must emit zero ANSI SGR');
  });

  void it('renders banner, workspace/tier/counts, telemetry strip, and optional sibling hint', () => {
    const snap = makeSnapshot({
      surface: 'app',
      siblingHint: '1 other active/recent session in this workspace: --session cli-9999 ([CLI])',
    });
    const lines = renderStructuredInspectorLines(snap, { color: false, width: 110 });
    assert.equal(lines[0], '[APP] Activity Snapshot  conv-abc  "Inspect overflow layout"');
    assert.equal(lines[1], 'Workspace: agy-hud · Matched via pid · 22 calls, 3 skills, 1 MCPs, 3 agents');
    assert.ok(lines[2]?.includes('Gemini 4 Carbon · Ctx 42k/200k (21%) · 92.4 token/s · TTFT 1.45s · Cache 86%'));
    assert.ok(lines[3]?.startsWith('Note: 1 other active/recent session in this workspace:'));
  });

  void it('omits telemetry strip when gen_metadata is absent', () => {
    const snap = makeSnapshot({
      telemetry: {
        genCount: 0,
        tps: null,
        ttft: null,
        cachePct: null,
        ctxUsed: null,
        ctxMax: null,
      },
    });
    const out = renderStructuredInspector(snap, { color: false, width: 100 });
    assert.equal(out.includes('Telemetry:'), false);
    assert.equal(out.includes('Ctx '), false);
  });

  void it('fits CJK/ANSI-width-aware section rules to cols - 1 with 100-col fallback', () => {
    const snap = makeSnapshot({
      title: '中文标题验证溢出检查布局',
      skills: ['中文技能一', 'code-review'],
    });
    const defaultLines = renderStructuredInspectorLines(snap, { color: true });
    const ruleLines = defaultLines.filter((line) => stripAnsi(line).startsWith('── '));
    assert.ok(ruleLines.length >= 4);
    for (const rule of ruleLines) {
      assert.equal(visibleLen(rule), 99, `expected 100-1=99 cols for rule: ${stripAnsi(rule)}`);
    }

    const narrowLines = renderStructuredInspectorLines(snap, { color: false, width: 80 });
    const narrowRules = narrowLines.filter((line) => line.startsWith('── '));
    for (const rule of narrowRules) {
      assert.equal(visibleLen(rule), 79, `expected 80-1=79 cols for rule: ${rule}`);
    }
  });

  void it('orders running tools newest-first with [+more] only on older overflowed calls beyond 2', () => {
    const runningTools: SnapshotRunningTool[] = [
      { name: 'run_command', disp: 'run_command', target: 'pnpm verify', fullTarget: 'pnpm verify', isMcp: false },
      { name: 'read_file', disp: 'read_file', target: 'spec.md', fullTarget: '/repo/spec.md', isMcp: false },
      { name: 'edit_file', disp: 'edit_file', target: 'ansi.ts', fullTarget: '/repo/ansi.ts', isMcp: false },
    ];
    const snap = makeSnapshot({ runningTools });
    const lines = renderStructuredInspectorLines(snap, { sections: ['tools'], color: false, width: 100 });
    const runningLines = lines.filter((line) => line.includes('◐'));
    assert.equal(runningLines.length, 3);
    assert.ok(runningLines[0]?.includes('edit_file'));
    assert.equal(runningLines[0]?.includes('[+more]'), false);
    assert.ok(runningLines[1]?.includes('read_file'));
    assert.equal(runningLines[1]?.includes('[+more]'), false);
    assert.ok(runningLines[2]?.includes('run_command'));
    assert.equal(runningLines[2]?.includes('[+more]'), true);

    const firstRunningIdx = lines.findIndex((line) => line.includes('◐'));
    const firstCompletedIdx = lines.findIndex((line) => line.includes('✓'));
    assert.ok(firstRunningIdx >= 0 && firstCompletedIdx > firstRunningIdx);
  });

  void it('tags the second running tool with [+more] on narrow widths when HUD shrinks shownRunning to 1', () => {
    const runningTools: SnapshotRunningTool[] = [
      {
        name: 'edit_file',
        disp: 'edit_file',
        target: 'older-long-target-module.ts',
        fullTarget: '/repo/older-long-target-module.ts',
        isMcp: false,
      },
      {
        name: 'run_command',
        disp: 'run_command',
        target: 'pnpm verify --filter',
        fullTarget: 'pnpm verify --filter',
        isMcp: false,
      },
    ];
    const snap = makeSnapshot({ runningTools });
    const lines = renderStructuredInspectorLines(snap, { sections: ['tools'], color: false, width: 60 });
    const runningLines = lines.filter((line) => line.includes('◐'));
    assert.equal(runningLines.length, 2);
    assert.ok(runningLines[0]?.includes('run_command'));
    assert.equal(runningLines[0]?.includes('[+more]'), false);
    assert.ok(runningLines[1]?.includes('edit_file'));
    assert.equal(runningLines[1]?.includes('[+more]'), true);
  });

  void it('does not emit spurious [+more] when 21-34 char snapshot running targets fit HUD 20-char shortening', () => {
    const runningTools: SnapshotRunningTool[] = [
      {
        name: 'edit_file',
        disp: 'edit_file',
        target: 'older-long-target-module.ts',
        fullTarget: '/repo/older-long-target-module.ts',
        isMcp: false,
      },
      {
        name: 'run_command',
        disp: 'run_command',
        target: 'pnpm verify --filter',
        fullTarget: 'pnpm verify --filter',
        isMcp: false,
      },
    ];
    const snap = makeSnapshot({ runningTools, completedTools: [], totalToolCalls: 2 });
    const lines = renderStructuredInspectorLines(snap, { sections: ['tools'], color: false, width: 80 });
    const runningLines = lines.filter((line) => line.includes('◐'));
    assert.equal(runningLines.length, 2);
    assert.equal(runningLines[0]?.includes('[+more]'), false);
    assert.equal(runningLines[1]?.includes('[+more]'), false);
  });

  void it('keeps HUD and CLI running-tool parity at 39 cols for filenames with leading whitespace', () => {
    const olderFull = '/repo/b.c';
    const newerFull = '/repo/ a.ts';
    const transcriptTools: TranscriptToolEntry[] = [
      { name: 'edit_file', disp: 'edit_file', target: shortenTarget(olderFull), running: true, isSkillRead: false },
      { name: 'read_file', disp: 'read_file', target: shortenTarget(newerFull), running: true, isSkillRead: false },
    ];
    const hudPlain = stripAnsi(formatToolsLine(transcriptTools, false, 39));
    assert.equal(hudPlain.includes('read_file: a.ts'), true);
    assert.equal(hudPlain.includes('edit_file: b.c'), true);
    assert.equal(hudPlain.includes('more'), false);

    const runningTools: SnapshotRunningTool[] = [
      { name: 'edit_file', disp: 'edit_file', target: shortenTarget(olderFull), fullTarget: olderFull, isMcp: false },
      { name: 'read_file', disp: 'read_file', target: shortenTarget(newerFull), fullTarget: newerFull, isMcp: false },
    ];
    const snap = makeSnapshot({ runningTools, completedTools: [], totalToolCalls: 2 });
    const runningLines = renderStructuredInspectorLines(snap, { sections: ['tools'], color: false, width: 39 }).filter(
      (line) => line.includes('◐'),
    );
    assert.equal(runningLines.length, 2);
    assert.equal(runningLines[0]?.includes('[+more]'), false);
    assert.equal(runningLines[1]?.includes('[+more]'), false);
  });

  void it('renders completed tools in 2 aligned columns at cols >= 98 with > 4 types and collapses to 1 column below 98', () => {
    const snap = makeSnapshot({
      completedTools: makeCompletedTools(8),
      totalToolCalls: 36,
    });
    const wideLines = renderStructuredInspectorLines(snap, { sections: ['tools'], color: false, width: 100 });
    const wideToolRows = wideLines.filter((line) => line.includes('✓'));
    assert.equal(wideToolRows.length, 4, '8 completed tools at 100 cols should pack into 4 two-column rows');
    for (const row of wideToolRows) {
      assert.ok(visibleLen(row) <= 99, `wide row exceeded cols-1: ${row}`);
    }
    assert.ok(wideToolRows[0]?.includes('tool_name_01'));
    assert.ok(wideToolRows[0]?.includes('tool_name_05'));
    assert.ok(wideToolRows[0]?.includes('file_1.ts'));

    const narrowLines = renderStructuredInspectorLines(snap, { sections: ['tools'], color: false, width: 90 });
    const narrowToolRows = narrowLines.filter((line) => line.includes('✓'));
    assert.equal(narrowToolRows.length, 8, '8 completed tools at 90 cols (< 98) should render in 1 column');
    assert.ok(narrowToolRows[0]?.includes('file_1.ts'));
    for (const row of narrowToolRows) {
      assert.ok(visibleLen(row) <= 89, `narrow row exceeded cols-1: ${row}`);
    }
  });

  void it('enforces exact 2-column threshold at cols >= 98 and > 4 completed tool types', () => {
    const fiveSnap = makeSnapshot({ completedTools: makeCompletedTools(5), totalToolCalls: 15 });
    const at98Five = renderStructuredInspectorLines(fiveSnap, { sections: ['tools'], color: false, width: 98 }).filter(
      (l) => l.includes('✓'),
    );
    assert.equal(at98Five.length, 3, '5 types at 98 cols should pack into 3 two-column rows');
    for (const row of at98Five) {
      assert.ok(visibleLen(row) <= 97);
    }

    const at97Five = renderStructuredInspectorLines(fiveSnap, { sections: ['tools'], color: false, width: 97 }).filter(
      (l) => l.includes('✓'),
    );
    assert.equal(at97Five.length, 5, '5 types at 97 cols must collapse to 1 column');

    const fourSnap = makeSnapshot({ completedTools: makeCompletedTools(4), totalToolCalls: 10 });
    const at98Four = renderStructuredInspectorLines(fourSnap, { sections: ['tools'], color: false, width: 98 }).filter(
      (l) => l.includes('✓'),
    );
    assert.equal(at98Four.length, 4, '4 types (<= 4) at 98 cols must stay 1 column');
  });

  void it('marks completed tools hidden behind the HUD Overflow Indicator with a leading + marker', () => {
    const snap = makeSnapshot({
      completedTools: makeCompletedTools(10),
      totalToolCalls: 55,
    });
    const lines = renderStructuredInspectorLines(snap, { sections: ['tools'], color: false, width: 88 });
    const toolRows = lines.filter((line) => line.includes('✓'));
    assert.equal(toolRows.length, 10);
    assert.equal(toolRows[0]?.startsWith('   ✓'), true, 'first tool visible on HUD should not have + marker');
    assert.equal(toolRows[9]?.startsWith('  +✓'), true, 'overflowed 10th tool must carry leading + marker');
  });

  void it('renders numbered wrapped skills, MCP server subtools, and aligned live + historical agents/swarm rows', () => {
    const snap = makeSnapshot({ agentsKind: 'swarm' });
    const lines = renderStructuredInspectorLines(snap, { color: false, width: 92 });
    const joined = lines.join('\n');

    assert.ok(joined.includes('1. tdd'));
    assert.ok(joined.includes('2. codebase-design'));
    assert.ok(joined.includes('3. security-and-hardening'));

    assert.ok(joined.includes('MCP Servers (1)'));
    assert.ok(joined.includes('agy-fast'));
    assert.ok(joined.includes('(7)'));
    assert.ok(joined.includes('batch_search ×4'));
    assert.ok(joined.includes('run_checks ×3'));

    assert.ok(joined.includes('Swarm (2 alive · 1 stopped)'));
    assert.ok(lines.some((l) => l.includes('◐') && l.includes('Verifier') && l.includes('working (live)')));
    assert.ok(lines.some((l) => l.includes('◌') && l.includes('Scout') && l.includes('waiting (live)')));
    assert.ok(lines.some((l) => l.includes('✓') && l.includes('Planner') && l.includes('done (3m ago)')));
  });

  void it('renders explicit empty states when filtered sections have no recorded items', () => {
    const snap = makeSnapshot({
      runningTools: [],
      completedTools: [],
      totalToolCalls: 0,
      skills: [],
      mcps: [],
      agents: [],
    });
    const out = renderStructuredInspector(snap, { color: false, width: 90 });
    assert.ok(out.includes('(no tool activity recorded)'));
    assert.ok(out.includes('(no skills invoked)'));
    assert.ok(out.includes('(no MCP tool calls)'));
    assert.ok(out.includes('(no subagents or swarm workers)'));
  });

  void it('clamps oversized single ASCII and CJK skill or MCP subtool chips to cols - 1', () => {
    const snap = makeSnapshot({
      skills: ['a'.repeat(90), '中文超长技能名称'.repeat(10)],
      mcps: [
        {
          server: 'srv',
          totalCalls: 2,
          subtools: [{ name: 'very_long_subtool_name_'.repeat(5), count: 2 }],
        },
      ],
    });
    const lines = renderStructuredInspectorLines(snap, {
      sections: ['skills', 'mcps'],
      color: false,
      width: 60,
    });
    for (const line of lines) {
      assert.ok(visibleLen(line) <= 59, `line exceeded cols-1 (59): len=${visibleLen(line)} -> ${line}`);
    }
  });

  void it('strips terminal escape sequences and newlines from untrusted session fields', () => {
    const osc52 = '\x1b]52;c;SGVsbG8=\x07';
    const clearScreen = '\x1b[2J';
    const snap = makeSnapshot({
      title: `safe${osc52}${clearScreen}\ninjected`,
      workspace: `/repo/ws${clearScreen}`,
      skills: [`skill${osc52}\r\nnext`],
    });
    const out = renderStructuredInspector(snap, { color: false, width: 100 });
    assert.equal(out.includes('\x1b'), false, 'output must not contain raw ESC sequences from session data');
    assert.equal(out.includes('\x07'), false, 'output must not contain raw BEL characters from session data');
    const lines = renderStructuredInspectorLines(snap, { color: false, width: 100 });
    assert.ok(lines[0]?.includes('"safe injected"'));
  });
});
