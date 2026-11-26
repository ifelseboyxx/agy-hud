import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aggregateCompletedTools } from '../../collectors/activity-aggregate.ts';
import { buildPresetConfig } from '../../core/hud-config.ts';
import { type AgentsSummary, type TranscriptActivity, type TranscriptToolEntry } from '../../types.ts';
import { computeHudVisibleToolsCap, formatNamesLine, formatToolsLine } from '../activity-lines.ts';
import {
  BRIGHT_CYAN,
  GRAY,
  isWideCodePoint,
  padEndVisible,
  RESET,
  stripAnsi,
  truncateToWidth,
  visibleLen,
} from '../ansi.ts';
import { renderHudLines } from '../lines.ts';
import { formatOsc8Overflow } from '../osc8.ts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

void describe('ansi width measurement and helpers', () => {
  void it('strips CSI SGR and OSC 8 sequences terminated by BEL or ST', () => {
    const belLink = `${ESC}]8;;file:///tmp/snap.md${BEL}${GRAY}+3 more${RESET}${ESC}]8;;${BEL}`;
    const stLink = `${ESC}]8;id=1;file:///tmp/snap.md${ESC}\\${BRIGHT_CYAN}snapshot${RESET}${ESC}]8;;${ESC}\\`;

    assert.equal(stripAnsi(belLink), '+3 more');
    assert.equal(stripAnsi(stLink), 'snapshot');
    assert.equal(visibleLen(belLink), 7);
    assert.equal(visibleLen(stLink), 8);
  });

  void it('counts CJK ideographs, Hangul, Kana, fullwidth, and SMP wide chars as 2 columns', () => {
    assert.equal(isWideCodePoint('中'.codePointAt(0) ?? 0), true);
    assert.equal(isWideCodePoint('한'.codePointAt(0) ?? 0), true);
    assert.equal(isWideCodePoint('あ'.codePointAt(0) ?? 0), true);
    assert.equal(isWideCodePoint('Ａ'.codePointAt(0) ?? 0), true);
    assert.equal(isWideCodePoint('𠮷'.codePointAt(0) ?? 0), true);
    assert.equal(isWideCodePoint('A'.codePointAt(0) ?? 0), false);
    assert.equal(isWideCodePoint('✓'.codePointAt(0) ?? 0), false);
    assert.equal(isWideCodePoint('◐'.codePointAt(0) ?? 0), false);
    assert.equal(isWideCodePoint('…'.codePointAt(0) ?? 0), false);

    assert.equal(visibleLen('中文测试'), 8);
    assert.equal(visibleLen(`${BRIGHT_CYAN}✓ 中文AB${RESET}`), 8);
    assert.equal(visibleLen('𠮷a'), 3);
  });

  void it('truncates plain and CJK strings to column budget without splitting wide characters', () => {
    assert.equal(truncateToWidth('abcdef', 6), 'abcdef');
    assert.equal(truncateToWidth('abcdef', 5), 'abcd…');
    assert.equal(truncateToWidth('中文测试', 4), '中…');
    assert.equal(truncateToWidth('中文测试', 5), '中文…');
    assert.equal(truncateToWidth('中文测试', 2), '…');
    assert.equal(truncateToWidth('中文测试', 1), '…');
    assert.equal(truncateToWidth('中文测试', 0), '');
    assert.equal(truncateToWidth(`${BRIGHT_CYAN}abcdef${RESET}`, 4), 'abc…');
    assert.equal(truncateToWidth(`${BRIGHT_CYAN}abc${RESET}`, 4), `${BRIGHT_CYAN}abc${RESET}`);
  });

  void it('pads strings using visible column width across ANSI, OSC 8, and CJK text', () => {
    const styled = `${ESC}]8;;file:///tmp/a.md${ESC}\\${BRIGHT_CYAN}中文${RESET}${ESC}]8;;${ESC}\\`;
    const padded = padEndVisible(styled, 8);
    assert.equal(visibleLen(padded), 8);
    assert.equal(padded.endsWith('    '), true);
    assert.equal(padEndVisible('abcdef', 4), 'abcdef');
  });
});

void describe('formatNamesLine width-aware greedy packing', () => {
  void it('preserves first-seen order and caps wide 160-col Skills and MCPs rows at 8 items', () => {
    const skills = [
      'z-first',
      'a-second',
      'm-third',
      'b-fourth',
      'k-fifth',
      'c-sixth',
      'y-seventh',
      'd-eighth',
      'e-ninth',
      'f-tenth',
    ];
    const line = formatNamesLine('Skills', skills, undefined, 160);
    const plain = stripAnsi(line);

    assert.equal(
      plain,
      '  ✓ Skills (10): z-first, a-second, m-third, b-fourth, k-fifth, c-sixth, y-seventh, d-eighth, +2 more',
    );
    assert.ok(visibleLen(line) <= 159);
  });

  void it('packs Skills and MCPs within termWidth - 1 across 80, 120, and 160 columns including CJK names', () => {
    const cjkSkills = [
      '代码审查技能',
      '架构分析助手',
      '性能诊断专家',
      '安全审计清单',
      '部署流水线',
      '测试覆盖工具',
      '接口文档生成',
    ];

    for (const width of [80, 120, 160]) {
      const line = formatNamesLine('Skills', cjkSkills, undefined, width);
      assert.ok(visibleLen(line) <= width - 1, `width ${width} overflowed: ${visibleLen(line)} > ${width - 1}`);
      assert.ok(stripAnsi(line).includes('代码审查技能'));
    }

    const narrowPlain = stripAnsi(formatNamesLine('Skills', cjkSkills, undefined, 80));
    const standardPlain = stripAnsi(formatNamesLine('Skills', cjkSkills, undefined, 120));
    const widePlain = stripAnsi(formatNamesLine('Skills', cjkSkills, undefined, 160));
    assert.ok(narrowPlain.includes('+'));
    assert.ok(standardPlain.includes('性能诊断专家'));
    assert.equal(widePlain.includes('+'), false);
  });

  void it('tail-ellipsizes item 0 on narrow widths so item 0 and +N more fit without emitting a zero-item row', () => {
    const longNames = [
      'super-long-enterprise-workflow-orchestration-skill-name-for-narrow-terminals',
      'second-skill',
      'third-skill',
      'fourth-skill',
    ];
    const line = formatNamesLine('Skills', longNames, undefined, 60);
    const plain = stripAnsi(line);

    assert.ok(visibleLen(line) <= 59);
    assert.equal(plain.startsWith('  ✓ Skills (4): super-long-'), true);
    assert.equal(plain.endsWith('…, +3 more'), true);
    assert.equal(plain.includes('Skills (4): +4 more'), false);
  });

  void it('supports formatOverflow OSC 8 decoration while keeping separators unlinked', () => {
    const names = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
    const uri = 'file:///tmp/snap.md';
    const line = formatNamesLine('MCPs', names, undefined, 160, {
      formatOverflow: (hidden) => `${GRAY}${ESC}]8;;${uri}${ESC}\\+${hidden} more${ESC}]8;;${ESC}\\${RESET}`,
    });

    assert.equal(stripAnsi(line), '  ✓ MCPs (9): s1, s2, s3, s4, s5, s6, s7, s8, +1 more');
    assert.ok(line.includes(`, ${GRAY}${ESC}]8;;${uri}${ESC}\\+1 more${ESC}]8;;${ESC}\\${RESET}`));
    assert.ok(visibleLen(line) <= 159);
  });

  void it('ellipsizes an oversized single item without emitting +0 more and returns empty when maxVisible is 0', () => {
    const single = formatNamesLine(
      'Skills',
      ['extremely-long-single-skill-name-exceeding-fifty-columns'],
      undefined,
      45,
    );
    const plain = stripAnsi(single);

    assert.ok(visibleLen(single) <= 44);
    assert.equal(plain.endsWith('…'), true);
    assert.equal(plain.includes('+0 more'), false);
    assert.equal(formatNamesLine('Skills', ['tdd'], 0, 120), '');
  });

  void it('accounts for overflow digit width transitions without overflowing budget', () => {
    const names = Array.from({ length: 12 }, (_, idx) => `item-${idx + 1}`);
    const exact41 = formatNamesLine('Skills', names, undefined, 42);
    assert.equal(stripAnsi(exact41), '  ✓ Skills (12): item-1, item-2, +10 more');
    assert.equal(visibleLen(exact41), 41);

    const exact40 = formatNamesLine('Skills', names, undefined, 41);
    assert.equal(stripAnsi(exact40), '  ✓ Skills (12): item-1, +11 more');
    assert.ok(visibleLen(exact40) <= 40);
  });
});

function makeTool(
  disp: string,
  opts?: Partial<Pick<TranscriptToolEntry, 'name' | 'target' | 'fullTarget' | 'running' | 'isSkillRead'>>,
): TranscriptToolEntry {
  return {
    name: opts?.name ?? disp,
    disp,
    target: opts?.target ?? '',
    ...(opts?.fullTarget !== undefined ? { fullTarget: opts.fullTarget } : {}),
    running: opts?.running ?? false,
    isSkillRead: opts?.isSkillRead ?? false,
  };
}

void describe('aggregateCompletedTools and formatToolsLine', () => {
  void it('aggregates completed tools by count desc then disp asc with latestTarget and fullTarget', () => {
    const tools: TranscriptToolEntry[] = [
      makeTool('read_file', { target: 'SKILL.md', fullTarget: '/skills/tdd/SKILL.md', isSkillRead: true }),
      makeTool('edit_file', { target: 'a.ts', fullTarget: '/repo/src/a.ts' }),
      makeTool('read_file', { target: 'first.ts', fullTarget: '/repo/src/first.ts' }),
      makeTool('read_file', { target: 'second.ts', fullTarget: '/repo/src/second.ts' }),
      makeTool('read_file', { target: 'first.ts', fullTarget: '/repo/src/first.ts' }),
      makeTool('edit_file', { target: '', fullTarget: '' }),
      makeTool('grep_search', { target: 'needle', fullTarget: 'needle', running: true }),
      makeTool('bash', { target: 'pnpm test', fullTarget: 'pnpm test' }),
    ];

    const aggs = aggregateCompletedTools(tools, true);
    assert.deepEqual(
      aggs.map((a) => ({
        disp: a.disp,
        count: a.count,
        latestTarget: a.latestTarget,
        fullTarget: a.fullTarget,
        recentTargets: a.recentTargets,
      })),
      [
        {
          disp: 'read_file',
          count: 3,
          latestTarget: 'first.ts',
          fullTarget: '/repo/src/first.ts',
          recentTargets: ['/repo/src/first.ts', '/repo/src/second.ts'],
        },
        {
          disp: 'edit_file',
          count: 2,
          latestTarget: 'a.ts',
          fullTarget: '/repo/src/a.ts',
          recentTargets: ['/repo/src/a.ts'],
        },
        {
          disp: 'bash',
          count: 1,
          latestTarget: 'pnpm test',
          fullTarget: 'pnpm test',
          recentTargets: ['pnpm test'],
        },
      ],
    );
  });

  void it('packs up to 8 completed tool types on wide 160-col terminals', () => {
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];
    const tools = names.flatMap((name, idx) => Array.from({ length: names.length - idx }, () => makeTool(name)));
    const line = formatToolsLine(tools, false, 160);
    const plain = stripAnsi(line);

    assert.equal(plain, '  ✓ t1 ×10 | ✓ t2 ×9 | ✓ t3 ×8 | ✓ t4 ×7 | ✓ t5 ×6 | ✓ t6 ×5 | ✓ t7 ×4 | ✓ t8 ×3 | +2 more');
    assert.ok(visibleLen(line) <= 159);
  });

  void it('packs completed tools within termWidth - 1 across 80, 120, and 160 columns', () => {
    const tools = [
      makeTool('agy-fast:batch_search'),
      makeTool('agy-fast:batch_search'),
      makeTool('agy-fast:apply_edits'),
      makeTool('read_file'),
      makeTool('edit_file'),
      makeTool('run_command'),
      makeTool('write_file'),
      makeTool('search_web'),
      makeTool('invoke_subagent'),
    ];
    for (const width of [80, 120, 160]) {
      const line = formatToolsLine(tools, false, width);
      assert.ok(visibleLen(line) <= width - 1, `width ${width} overflowed: ${visibleLen(line)} > ${width - 1}`);
      assert.ok(stripAnsi(line).includes('✓ agy-fast:batch_search ×2'));
    }
  });

  void it('pins latest 2 running calls first and counts excess parallel running calls in +N more', () => {
    const tools = [
      makeTool('run_a', { target: 'a.ts', running: true }),
      makeTool('run_b', { target: 'b.ts', running: true }),
      makeTool('run_c', { target: 'c.ts', running: true }),
      makeTool('read_file'),
      makeTool('edit_file'),
    ];
    const line = formatToolsLine(tools, false, 160);
    const plain = stripAnsi(line);

    // 3 running calls (2 shown -> 1 hidden) + 2 completed types (2 shown -> 0 hidden) => +1 more
    assert.equal(plain, '  ◐ run_c: c.ts | ◐ run_b: b.ts | ✓ edit_file ×1 | ✓ read_file ×1 | +1 more');
    assert.ok(visibleLen(line) <= 159);
  });

  void it('withholds completed tools when narrow width hides a running tool', () => {
    const tools = [
      makeTool('edit_file', { target: 'older-long-target-module.ts', running: true }),
      makeTool('run_command', { target: 'pnpm verify --filter', running: true }),
      makeTool('Read'),
      makeTool('Read'),
      makeTool('Edit'),
      makeTool('Grep'),
    ];
    // 2 running calls (~34 cols + ~41 cols) exceed 80 cols together -> shrink to 1 latest running call;
    // do not let completed tools steal width while a running tool is hidden: hidden = (2 - 1) + 3 = 4.
    const line = formatToolsLine(tools, false, 80);
    const plain = stripAnsi(line);

    assert.ok(visibleLen(line) <= 79);
    assert.equal(plain, '  ◐ run_command: pnpm verify --filter | +4 more');
  });

  void it('ellipsizes item 0 when a single running or completed tool exceeds narrow budget with +N more', () => {
    const runningHeavy = [
      makeTool('mcp-enterprise-server:execute_long_query', {
        target: '非常长的中文查询目标参数名称.ts',
        running: true,
      }),
      makeTool('Read'),
      makeTool('Edit'),
    ];
    const runLine = formatToolsLine(runningHeavy, false, 50);
    const runPlain = stripAnsi(runLine);
    assert.ok(visibleLen(runLine) <= 49);
    assert.equal(runPlain.startsWith('  ◐ '), true);
    assert.equal(runPlain.endsWith('… | +2 more'), true);

    const completedHeavy = [
      makeTool('very-long-mcp-namespace:extremely-long-tool-operation-name'),
      makeTool('very-long-mcp-namespace:extremely-long-tool-operation-name'),
      makeTool('Read'),
    ];
    const compLine = formatToolsLine(completedHeavy, false, 45);
    const compPlain = stripAnsi(compLine);
    assert.ok(visibleLen(compLine) <= 44);
    assert.equal(compPlain.startsWith('  ✓ '), true);
    assert.equal(compPlain.includes('…'), true);
    assert.equal(compPlain.endsWith('| +1 more'), true);
  });

  void it('handles pure-running tool rows for exact fit, shrink 2-to-1, and single-item ellipsizing', () => {
    const twoRunning = [
      makeTool('edit_file', { target: 'a.ts', running: true }),
      makeTool('read_file', { target: 'b.ts', running: true }),
    ];
    assert.equal(stripAnsi(formatToolsLine(twoRunning, false, 120)), '  ◐ read_file: b.ts | ◐ edit_file: a.ts');

    const shrunk = formatToolsLine(twoRunning, false, 35);
    assert.equal(stripAnsi(shrunk), '  ◐ read_file: b.ts | +1 more');
    assert.ok(visibleLen(shrunk) <= 34);

    const singleOversized = formatToolsLine(
      [makeTool('run_command', { target: 'very-long-command-target-exceeding-width', running: true })],
      false,
      36,
    );
    const singlePlain = stripAnsi(singleOversized);
    assert.ok(visibleLen(singleOversized) <= 35);
    assert.equal(singlePlain.endsWith('…'), true);
    assert.equal(singlePlain.includes('+0 more'), false);
  });

  void it('applies formatOverflow strictly to +N more on Tools line with unlinked separators', () => {
    const tools = Array.from({ length: 10 }, (_, idx) => makeTool(`tool_${idx}`));
    const uri = 'file:///tmp/snap.md';
    const line = formatToolsLine(tools, false, 160, {
      formatOverflow: (hidden) => `${GRAY}${ESC}]8;;${uri}${ESC}\\+${hidden} more${ESC}]8;;${ESC}\\${RESET}`,
    });

    assert.ok(line.includes(` ${GRAY}|${RESET} ${GRAY}${ESC}]8;;${uri}${ESC}\\+2 more${ESC}]8;;${ESC}\\${RESET}`));
    assert.ok(visibleLen(line) <= 159);
  });

  void it('wires data.terminal_width into all four Activity Lines during renderHudLines', () => {
    const activity: TranscriptActivity = {
      tools: [
        makeTool('agy-fast:batch_search'),
        makeTool('agy-fast:apply_edits'),
        makeTool('read_file'),
        makeTool('edit_file'),
        makeTool('run_command'),
        makeTool('write_file'),
        makeTool('search_web'),
      ],
      skills: ['代码审查技能', '架构分析助手', '性能诊断专家', '安全审计清单', '部署流水线'],
      mcps: ['agy-fast', 'chrome-devtools', 'magpie-artifacts', 'context7-docs', 'github-enterprise'],
      agents: [],
    };
    const agentsSummary: AgentsSummary = {
      kind: 'swarm',
      working: 2,
      waiting: 3,
      alive: 5,
      total: 5,
      entries: [
        { name: '开发员一', type: 'worker', model: '', state: 'working', ts: null },
        { name: '开发员二', type: 'worker', model: '', state: 'working', ts: null },
        { name: '审查员三', type: 'worker', model: '', state: 'waiting', ts: null },
        { name: '验证员四', type: 'worker', model: '', state: 'waiting', ts: null },
        { name: '文档员五', type: 'worker', model: '', state: 'waiting', ts: null },
      ],
    };

    const lines = renderHudLines(
      '/nonexistent/cli-home',
      {
        terminal_width: 80,
        model: { display_name: 'Gemini 4 Carbon' },
        context_window: { used_percentage: 25, context_window_size: 1_000_000 },
      },
      {
        hudConfig: {
          ...buildPresetConfig('full'),
          lines: ['identity', 'usage', 'tools', 'skills', 'mcps', 'agents', 'todos'],
        },
        cliSettings: {},
        telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
        activity,
        agentsSummary,
        todos: null,
        branch: 'main',
        elapsedSeconds: 60,
        nowSec: 1000,
      },
    );

    const activityLines = lines.slice(2);
    assert.equal(activityLines.length, 4);
    for (const line of activityLines) {
      assert.ok(visibleLen(line) <= 79, `Activity Line exceeded 79 cols (${visibleLen(line)}): ${stripAnsi(line)}`);
    }
  });

  void it('measures combining diacritics as zero-width', () => {
    const accented = 'cafe\u0301';
    assert.equal(visibleLen(accented), 4);
  });

  void it('keeps combining diacritic clusters intact during truncation', () => {
    assert.equal(truncateToWidth('e\u0301abcdef', 4), 'e\u0301ab…');
    assert.equal(visibleLen(truncateToWidth('e\u0301abcdef', 4)), 4);
  });

  void it('preserves Overflow Indicator on an ultra-narrow 20-column Skills line', () => {
    const uri = 'file:///tmp/agy_hud_snapshot_narrow.md';
    const line = formatNamesLine('Skills', ['code-review', 'tdd', 'grilling', 'research'], undefined, 20, {
      formatOverflow: (hidden) => formatOsc8Overflow(hidden, uri),
    });
    const plain = stripAnsi(line);
    assert.ok(visibleLen(line) <= 19, `expected <= 19 cols, got ${visibleLen(line)}: ${plain}`);
    assert.ok(plain.includes('+3 more'), `expected intact +3 more suffix, got: ${plain}`);
    assert.ok(plain.includes('c'), `expected ellipsized first item, got: ${plain}`);
    assert.ok(line.includes(`${ESC}]8;;${uri}${ESC}\\+3 more${ESC}]8;;${ESC}\\`), 'expected intact OSC 8 link');
  });

  void it('preserves item-0 floor in computeHudVisibleToolsCap when no tools are running', () => {
    const cap = computeHudVisibleToolsCap(
      [],
      [{ disp: 'very-long-mcp-namespace:extremely-long-tool-operation-name', count: 3 }],
      25,
    );
    assert.deepEqual(cap, { shownRunning: 0, shownCompleted: 1 });
  });

  void it('keeps single running tool within termWidth - 1 budget on ultra-narrow widths', () => {
    const tools: TranscriptToolEntry[] = [
      {
        name: 'read_file',
        disp: 'read_file',
        target: 'very-long-filename.ts',
        running: true,
        isSkillRead: false,
      },
    ];
    const line = formatToolsLine(tools, false, 3);
    assert.ok(visibleLen(line) <= 2, `expected <= 2 cols, got ${visibleLen(line)}: ${stripAnsi(line)}`);
  });

  void it('preserves Overflow Indicator on an ultra-narrow 13-column Tools line', () => {
    const uri = 'file:///tmp/agy_hud_snapshot_tools.md';
    const tools: TranscriptToolEntry[] = [
      { name: 'read_file', disp: 'read_file', target: 'alpha.ts', running: true, isSkillRead: false },
      { name: 'edit_file', disp: 'edit_file', target: 'beta.ts', running: true, isSkillRead: false },
      { name: 'run_command', disp: 'run_command', target: 'pnpm test', running: false, isSkillRead: false },
    ];
    const line = formatToolsLine(tools, false, 13, {
      formatOverflow: (hidden) => formatOsc8Overflow(hidden, uri),
    });
    const plain = stripAnsi(line);
    assert.ok(visibleLen(line) <= 12, `expected <= 12 cols, got ${visibleLen(line)}: ${plain}`);
    assert.ok(plain.includes('+2 more'), `expected intact +2 more suffix, got: ${plain}`);
    assert.ok(plain.includes('◐'), `expected running item-0 indicator, got: ${plain}`);
    assert.ok(line.includes(`${ESC}]8;;${uri}${ESC}\\+2 more${ESC}]8;;${ESC}\\`), 'expected intact OSC 8 link');
  });
});
