import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runSnapshotCommand } from '../src/cli/snapshot.ts';
import { loadTranscriptActivity } from '../src/collectors/activity.ts';
import { writeSnapshotEnvelope } from '../src/collectors/snapshot-envelope.ts';
import { runHudRender } from '../src/hud-runner.ts';
import { pollHudSnapshot } from '../src/mcp/hud-mcp-snapshot.ts';
import { stripAnsi } from '../src/render/ansi.ts';
import type { ActivitySnapshot } from '../src/snapshot-types.ts';
import type { StatusLineData } from '../src/types.ts';
import { createTempDirTracker } from './helpers.ts';

const tracker = createTempDirTracker();

afterEach(() => {
  tracker.cleanup();
});

interface ParityFixture {
  geminiRoot: string;
  cliHome: string;
  wsDir: string;
  convId: string;
  transcriptPath: string;
  mdPath: string;
  initialStep: string;
  runningStep: string;
  fixedTime: Date;
  nowMs: number;
  data: StatusLineData;
}

function createParityFixture(convId = 'parity-shared-1234', withRunning = false): ParityFixture {
  const root = tracker.makeTempDir('agy-hud-parity-');
  const geminiRoot = path.join(root, '.gemini');
  const cliHome = path.join(geminiRoot, 'antigravity-cli');
  const wsDir = path.join(root, 'workspace');
  const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });

  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
  const mdPath = path.join(cliHome, 'cache', `agy_hud_snapshot_${convId}.md`);
  const skillPath = path.join(cliHome, 'skills', 'tdd', 'SKILL.md');
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, '---\nname: tdd\n---\n', 'utf8');

  const initialStep = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    model: 'Gemini 4 Carbon',
    created_at: '2026-06-01T11:58:00Z',
    tool_calls: [
      { name: 'read_file', args: { Path: skillPath } },
      { name: 'read_file', args: { Path: path.join(wsDir, 'alpha.ts') } },
      { name: 'mcp_github_get_issue', args: { query: 'issue-1' } },
      { name: 'invoke_subagent', args: { Role: 'Reviewer', TypeName: 'research', Model: 'flash' } },
      { name: 'invoke_subagent', args: { Role: 'Reviewer', TypeName: 'research', Model: 'pro' } },
    ],
  });
  const runningStep = JSON.stringify({
    type: 'PLANNER_RESPONSE',
    status: 'RUNNING',
    model: 'Gemini 4 Carbon',
    created_at: '2026-06-01T11:59:30Z',
    tool_calls: [
      { name: 'grep_search', args: { Query: 'first' } },
      { name: 'edit_file', args: { Path: path.join(wsDir, 'second.ts') } },
      { name: 'run_command', args: { CommandLine: 'pnpm test' } },
    ],
  });
  const body = withRunning ? `${initialStep}\n${runningStep}\n` : `${initialStep}\n`;
  writeFileSync(transcriptPath, body, 'utf8');
  const fixedTime = new Date('2026-06-01T11:59:00Z');
  utimesSync(transcriptPath, fixedTime, fixedTime);

  const nowMs = Date.parse('2026-06-01T12:00:00Z');
  const data: StatusLineData = {
    conversation_id: convId,
    conversation_title: 'Shared Parity Session',
    cwd: wsDir,
    workspace: { current_dir: wsDir, project_dir: wsDir },
    model: { display_name: 'Gemini 4 Carbon' },
    subagents: [{ name: 'Coder', role: 'Coder', type_name: 'self', status: 'running' }],
    terminal_width: 140,
  };
  writeSnapshotEnvelope(cliHome, data, 4242, { nowMs });

  return {
    geminiRoot,
    cliHome,
    wsDir,
    convId,
    transcriptPath,
    mdPath,
    initialStep,
    runningStep,
    fixedTime,
    nowMs,
    data,
  };
}

function renderAndMaterializeHud(
  f: ParityFixture,
  nowMs = f.nowMs,
  includeTodos = false,
): { rawHudLines: string[]; hudLines: string[]; markdown: string } {
  const rawHudLines = runHudRender(f.cliHome, f.data, {
    nowSec: nowMs / 1000,
    agyPid: 4242,
    bypass: false,
    cliMode: '',
    branch: 'main',
    telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
    ...(includeTodos ? {} : { todos: null }),
    hudConfig: {
      preset: 'full',
      osc8Links: true,
      lines: includeTodos
        ? ['identity', 'activity', 'tools', 'skills', 'mcps', 'agents', 'todos']
        : ['identity', 'activity', 'tools', 'skills', 'mcps', 'agents'],
    },
    env: { TERM: 'xterm-256color' },
  });
  const hudLines = rawHudLines.map(stripAnsi);
  // Trigger OSC 8 emission on a compact summary frame so Gate 1 + Gate 2 materialize the real .md file on disk.
  runHudRender(f.cliHome, f.data, {
    nowSec: nowMs / 1000,
    agyPid: 4242,
    bypass: false,
    cliMode: '',
    branch: 'main',
    telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
    todos: null,
    hudConfig: {
      preset: 'compact',
      osc8Links: true,
      lines: ['identity', 'activity'],
    },
    env: { TERM: 'xterm-256color' },
  });
  assert.equal(existsSync(f.mdPath), true, 'expected runHudRender Gate 1 + Gate 2 to materialize snapshot Markdown');
  return { rawHudLines, hudLines, markdown: readFileSync(f.mdPath, 'utf8') };
}

void describe('cross-surface activity parity contract', () => {
  void it('matches canonical activity projections across all four surfaces', () => {
    const f = createParityFixture('parity-full-1111', false);
    const { hudLines, markdown } = renderAndMaterializeHud(f);
    const hudActivity = loadTranscriptActivity(f.cliHome, f.data);
    const cliSnap = JSON.parse(
      runSnapshotCommand(['--session', f.convId, '--json'], {
        cliHome: f.cliHome,
        geminiRoot: f.geminiRoot,
        cwd: f.wsDir,
        nowMs: f.nowMs,
        isAlive: (p) => p === 4242,
      }).output,
    ) as ActivitySnapshot;
    const mcpRes = pollHudSnapshot(
      { sessionId: f.convId, source: 'cli' },
      { cliHome: f.cliHome, geminiRoot: f.geminiRoot, cwd: f.wsDir, nowMs: f.nowMs, isAlive: (p) => p === 4242 },
    );
    assert.equal(mcpRes.unchanged, false);

    const expectedTools = [
      { disp: 'invoke_subagent', count: 2, target: 'Reviewer' },
      { disp: 'github:get_issue', count: 1, target: 'issue-1' },
      { disp: 'read_file', count: 1, target: 'alpha.ts' },
    ];
    assert.deepEqual(
      hudActivity?.completedTools?.map((t) => ({ disp: t.disp, count: t.count, target: t.latestTarget })),
      expectedTools,
    );
    assert.deepEqual(
      cliSnap.completedTools.map((t) => ({ disp: t.disp, count: t.count, target: t.latestTarget })),
      expectedTools,
    );
    assert.deepEqual(
      mcpRes.snapshot?.completedTools.map((t) => ({ disp: t.disp, count: t.count, target: t.latestTarget })),
      expectedTools,
    );
    assert.deepEqual(cliSnap.mcps, [{ server: 'github', totalCalls: 1, subtools: [{ name: 'get_issue', count: 1 }] }]);
    assert.deepEqual(mcpRes.snapshot?.mcps, cliSnap.mcps);
    assert.deepEqual(cliSnap.skills, ['tdd']);
    assert.deepEqual(mcpRes.snapshot?.skills, ['tdd']);
    assert.deepEqual(
      cliSnap.agents.map((a) => `${a.name}:${a.state}:${a.model}`),
      ['Coder:working:inherit', 'Reviewer:done:flash', 'Reviewer:done:pro'],
    );
    assert.deepEqual(
      mcpRes.snapshot?.agents.map((a) => `${a.name}:${a.state}:${a.model}`),
      cliSnap.agents.map((a) => `${a.name}:${a.state}:${a.model}`),
    );
    assert.ok(hudLines.some((l) => l.includes('Skills (1): tdd')));
    assert.ok(hudLines.some((l) => l.includes('MCPs (1): github')));
    assert.ok(markdown.includes('1. `tdd`'));
    assert.ok(markdown.includes('| `github` | 1 | `get_issue` ×1 |'));
    assert.ok(markdown.includes('| 1 | `invoke_subagent` | ×2 | `Reviewer` |'));
    assert.ok(markdown.includes('| 3 | `read_file` | ×1 |'));
    assert.equal(markdown.split('\n').filter((line) => line.startsWith('| `Reviewer` |')).length, 2);
  });

  void it('orders 3 running tool calls newest-first identically across HUD, Markdown, CLI, and MCP', () => {
    const f = createParityFixture('parity-running-2222', true);
    const { hudLines, markdown } = renderAndMaterializeHud(f);
    const cliText = stripAnsi(
      runSnapshotCommand(['--session', f.convId, '--no-color'], {
        cliHome: f.cliHome,
        geminiRoot: f.geminiRoot,
        cwd: f.wsDir,
        nowMs: f.nowMs,
        isAlive: (p) => p === 4242,
      }).output,
    );
    const mcpRes = pollHudSnapshot(
      { sessionId: f.convId, source: 'cli' },
      { cliHome: f.cliHome, geminiRoot: f.geminiRoot, cwd: f.wsDir, nowMs: f.nowMs, isAlive: (p) => p === 4242 },
    );
    assert.equal(mcpRes.unchanged, false);

    const toolsLine = hudLines.find((l) => l.includes('◐ run_command')) ?? '';
    assert.ok(toolsLine.indexOf('run_command') < toolsLine.indexOf('edit_file'), `HUD newest-first: ${toolsLine}`);
    assert.ok(toolsLine.includes('+1 more') || toolsLine.includes('+4 more'));

    const mdRunningRows = markdown.split('\n').filter((l) => l.startsWith('| ') && l.includes('running'));
    assert.equal(mdRunningRows.length, 3);
    assert.ok(mdRunningRows[0]?.includes('`run_command`'));
    assert.ok(mdRunningRows[1]?.includes('`edit_file`'));
    assert.ok(mdRunningRows[2]?.includes('`grep_search`') && mdRunningRows[2]?.includes('(+more)'));

    const cliRunningRows = cliText.split('\n').filter((l) => l.includes('◐') && l.includes('running'));
    assert.equal(cliRunningRows.length, 3);
    assert.ok(cliRunningRows[0]?.includes('run_command'));
    assert.ok(cliRunningRows[1]?.includes('edit_file'));
    assert.ok(cliRunningRows[2]?.includes('grep_search') && cliRunningRows[2]?.includes('[+more]'));

    assert.deepEqual(
      mcpRes.snapshot?.runningTools.map((rt) => rt.disp),
      ['run_command', 'edit_file', 'grep_search'],
    );
  });

  void it('replaces old activity completely after same-inode same-length rewrite across all four surfaces', () => {
    const f = createParityFixture('parity-rewrite-4444', false);
    const before = renderAndMaterializeHud(f);
    assert.ok(before.hudLines.some((l) => l.includes('read_file')));
    assert.ok(before.markdown.includes('`read_file`'));
    assert.ok(before.markdown.includes('alpha.ts'));

    const mcpBefore = pollHudSnapshot(
      { sessionId: f.convId, source: 'cli' },
      { cliHome: f.cliHome, geminiRoot: f.geminiRoot, cwd: f.wsDir, nowMs: f.nowMs, isAlive: (p) => p === 4242 },
    );
    assert.equal(mcpBefore.unchanged, false);

    const stBefore = statSync(f.transcriptPath);
    const oldCall = JSON.stringify({ name: 'read_file', args: { Path: path.join(f.wsDir, 'alpha.ts') } });
    const newCall = JSON.stringify({ name: 'edit_file', args: { Path: path.join(f.wsDir, 'bravo.ts') } });
    const rewrittenStep = f.initialStep.replace(oldCall, newCall);
    assert.notEqual(rewrittenStep, f.initialStep);
    assert.equal(Buffer.byteLength(rewrittenStep, 'utf8'), Buffer.byteLength(f.initialStep, 'utf8'));
    writeFileSync(f.transcriptPath, `${rewrittenStep}\n`, 'utf8');
    utimesSync(f.transcriptPath, f.fixedTime, f.fixedTime);
    assert.equal(statSync(f.transcriptPath).ino, stBefore.ino);
    assert.equal(statSync(f.transcriptPath).size, stBefore.size);

    const after = renderAndMaterializeHud(f, f.nowMs + 1000);
    const hudAfter = loadTranscriptActivity(f.cliHome, f.data);
    const cliAfter = JSON.parse(
      runSnapshotCommand(['--session', f.convId, '--json'], {
        cliHome: f.cliHome,
        geminiRoot: f.geminiRoot,
        cwd: f.wsDir,
        nowMs: f.nowMs + 1000,
        isAlive: (p) => p === 4242,
      }).output,
    ) as ActivitySnapshot;
    const mcpAfter = pollHudSnapshot(
      { sessionId: f.convId, source: 'cli', etag: mcpBefore.etag },
      { cliHome: f.cliHome, geminiRoot: f.geminiRoot, cwd: f.wsDir, nowMs: f.nowMs + 1000, isAlive: (p) => p === 4242 },
    );

    const expectedAfter = [
      { disp: 'invoke_subagent', count: 2, target: 'Reviewer' },
      { disp: 'edit_file', count: 1, target: 'bravo.ts' },
      { disp: 'github:get_issue', count: 1, target: 'issue-1' },
    ];
    assert.equal(mcpAfter.unchanged, false);
    assert.notEqual(mcpAfter.etag, mcpBefore.etag);
    assert.deepEqual(
      hudAfter?.completedTools?.map((t) => ({ disp: t.disp, count: t.count, target: t.latestTarget })),
      expectedAfter,
    );
    assert.deepEqual(
      cliAfter.completedTools.map((t) => ({ disp: t.disp, count: t.count, target: t.latestTarget })),
      expectedAfter,
    );
    assert.deepEqual(
      mcpAfter.snapshot?.completedTools.map((t) => ({ disp: t.disp, count: t.count, target: t.latestTarget })),
      expectedAfter,
    );
    assert.ok(after.markdown.includes('`edit_file`') && after.markdown.includes('bravo.ts'));
    assert.equal(after.markdown.includes('`read_file`'), false, 'stale read_file must disappear from Markdown');
    assert.equal(after.markdown.includes('alpha.ts'), false, 'stale alpha.ts must disappear from Markdown');
    assert.equal(
      after.hudLines.some((l) => l.includes('read_file')),
      false,
      'stale read_file must disappear from HUD',
    );
    assert.ok(after.hudLines.some((l) => l.includes('edit_file')));
  });

  void it('renders stopped Swarm members consistently across CLI Inspector, materialized Markdown, and MCP', () => {
    const f = createParityFixture('parity-swarm-5555', false);
    const swarmDir = path.join(f.cliHome, 'brain', f.convId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        members: {
          coordinator: { role: 'coordinator', killed: false },
          activeWorker: { role: 'worker', model: 'Gemini 4 Flash' },
          retiredWorker: { role: 'worker', model: 'Gemini 4 Pro', killed: true },
        },
      }),
      'utf8',
    );

    const { markdown } = renderAndMaterializeHud(f);
    const cliText = stripAnsi(
      runSnapshotCommand(['--session', f.convId, '--no-color'], {
        cliHome: f.cliHome,
        geminiRoot: f.geminiRoot,
        cwd: f.wsDir,
        nowMs: f.nowMs,
        isAlive: (p) => p === 4242,
      }).output,
    );
    const mcpRes = pollHudSnapshot(
      { sessionId: f.convId, source: 'cli' },
      { cliHome: f.cliHome, geminiRoot: f.geminiRoot, cwd: f.wsDir, nowMs: f.nowMs, isAlive: (p) => p === 4242 },
    );

    assert.ok(markdown.includes('## Swarm (1 alive · 3 stopped)'));
    assert.ok(markdown.includes('| `retiredWorker` |'));
    assert.ok(cliText.includes('Swarm (1 alive · 3 stopped)'));
    assert.ok(cliText.includes('retiredWorker'));
    assert.equal(mcpRes.unchanged, false);
    assert.equal(mcpRes.snapshot?.agentsKind, 'swarm');
    assert.ok(mcpRes.snapshot?.agents.some((a) => a.name === 'retiredWorker' && a.state === 'done'));
  });

  void it('sanitizes terminal escapes and bidi controls consistently across HUD, Markdown, CLI, and MCP', () => {
    const osc52 = '\x1b]52;c;SGVsbG8=\x07';
    const osc8Evil = '\x1b]8;;https://evil.test\x07';
    const csiClear = '\x1b[2J';
    const bidi = '\u202E';
    const f = createParityFixture('parity-escape-6666', false);
    const hostileSkillPath = path.join(f.cliHome, 'skills', 'hostile-skill', 'SKILL.md');
    mkdirSync(path.dirname(hostileSkillPath), { recursive: true });
    writeFileSync(hostileSkillPath, `---\nname: safe-skill${osc52}${csiClear}\n---\n`, 'utf8');
    writeFileSync(
      path.join(f.cliHome, 'brain', f.convId, 'task.md'),
      `- [/] Finish${osc52}${csiClear}todo\n- [ ] Next\n`,
      'utf8',
    );

    const hostileStep = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: `Gemini 4 Carbon${csiClear}`,
      created_at: '2026-06-01T11:58:30Z',
      tool_calls: [
        { name: 'read_file', args: { Path: hostileSkillPath } },
        { name: 'edit_file', args: { Path: path.join(f.wsDir, `note${osc8Evil}${csiClear}.ts`) } },
        { name: `custom_tool${osc52}${csiClear}`, args: {} },
        { name: `mcp:empty-sub:${csiClear}`, args: {} },
        {
          name: 'call_mcp_tool',
          args: { ServerName: `srv${osc52}`, ToolName: `sub${csiClear}${bidi}` },
        },
        {
          name: 'invoke_subagent',
          args: { Role: `Agent${osc8Evil}${csiClear}`, TypeName: `type${osc52}`, Model: `flash${csiClear}` },
        },
      ],
    });
    writeFileSync(f.transcriptPath, `${hostileStep}\n`, 'utf8');
    utimesSync(f.transcriptPath, f.fixedTime, f.fixedTime);

    const hostileData: StatusLineData = {
      ...f.data,
      conversation_title: `Title${osc52}${osc8Evil}${csiClear}${bidi}Safe`,
      model: { display_name: `Gemini 4 Carbon${csiClear}` },
      agent: { name: `Lead${osc52}` },
      subagents: [{ name: `Coder${osc52}`, role: `Coder${osc52}`, type_name: 'self', status: 'running' }],
    };
    writeSnapshotEnvelope(f.cliHome, hostileData, 4242, { nowMs: f.nowMs + 1000 });
    const fixture: ParityFixture = { ...f, data: hostileData };

    const { rawHudLines, hudLines, markdown } = renderAndMaterializeHud(fixture, f.nowMs + 2000, true);
    const cliText = runSnapshotCommand(['--session', f.convId, '--no-color'], {
      cliHome: f.cliHome,
      geminiRoot: f.geminiRoot,
      cwd: f.wsDir,
      nowMs: f.nowMs + 2000,
      isAlive: (p) => p === 4242,
    }).output;
    const cliSessions = runSnapshotCommand(['--sessions', '--source', 'cli'], {
      cliHome: f.cliHome,
      geminiRoot: f.geminiRoot,
      cwd: f.wsDir,
      nowMs: f.nowMs + 2000,
      isAlive: (p) => p === 4242,
    }).output;
    const mcpRes = pollHudSnapshot(
      { sessionId: f.convId, source: 'cli' },
      { cliHome: f.cliHome, geminiRoot: f.geminiRoot, cwd: f.wsDir, nowMs: f.nowMs + 2000, isAlive: (p) => p === 4242 },
    );

    // Inspect raw HUD stdout directly (before stripAnsi) so leaked OSC 52/8 or CSI cannot be masked.
    const rawHudJoined = rawHudLines.join('\n');
    assert.equal(rawHudJoined.includes(']52;'), false, 'raw HUD must not emit OSC 52');
    assert.equal(rawHudJoined.includes('https://evil.test'), false, 'raw HUD must not emit injected OSC 8 URL');
    assert.equal(rawHudJoined.includes('\x07'), false, 'raw HUD must not contain raw BEL');
    assert.equal(rawHudJoined.includes(csiClear), false, 'raw HUD must not emit CSI clear screen');
    assert.equal(rawHudJoined.includes(bidi), false, 'raw HUD must not contain bidi override');

    for (const [label, text] of [
      ['Markdown', markdown],
      ['CLI snapshot', cliText],
      ['CLI --sessions', cliSessions],
    ] as const) {
      assert.equal(text.includes('\x1b'), false, `${label} must not contain raw ESC`);
      assert.equal(text.includes('\x07'), false, `${label} must not contain raw BEL`);
      assert.equal(text.includes(bidi), false, `${label} must not contain bidi override`);
      assert.equal(text.includes('https://evil.test'), false, `${label} must not retain OSC 8 payload`);
    }

    const hudJoined = hudLines.join('\n');
    assert.ok(hudJoined.includes('custom_tool'));
    assert.ok(hudJoined.includes('Finishtodo'));
    assert.ok(hudJoined.includes('Skills (1): safe-skill'));
    assert.ok(hudJoined.includes('MCPs (1): srv'));
    assert.ok(markdown.includes('TitleSafe'));
    assert.ok(markdown.includes('note.ts'));
    assert.ok(cliSessions.includes('TitleSafe'));
    assert.equal(mcpRes.unchanged, false);
    assert.equal(mcpRes.snapshot?.title, 'TitleSafe');
    assert.equal(mcpRes.snapshot?.todos?.current, 'Finishtodo');
    assert.ok(mcpRes.snapshot?.completedTools.some((t) => t.disp === 'edit_file' && t.latestTarget === 'note.ts'));
    assert.deepEqual(mcpRes.snapshot?.skills, ['safe-skill']);
    assert.deepEqual(mcpRes.snapshot?.mcps, [{ server: 'srv', totalCalls: 1, subtools: [{ name: 'sub', count: 1 }] }]);
    assert.ok(mcpRes.snapshot?.agents.some((a) => a.name === 'Agent' && a.type === 'type' && a.model === 'flash'));
  });

  void it('sanitizes terminal escapes in ambiguous session prefix error output', () => {
    const f = createParityFixture('ambig-aaaa-1111', false);
    const osc52 = '\x1b]52;c;SGVsbG8=\x07';
    writeSnapshotEnvelope(
      f.cliHome,
      { conversation_id: 'ambig-aaaa-1111', conversation_title: `First${osc52}Title`, cwd: f.wsDir },
      4242,
      { nowMs: f.nowMs },
    );
    writeSnapshotEnvelope(
      f.cliHome,
      { conversation_id: 'ambig-aaaa-2222', conversation_title: `Second\x1b[2JTitle`, cwd: f.wsDir },
      4243,
      { nowMs: f.nowMs },
    );

    assert.throws(
      () =>
        runSnapshotCommand(['--session', 'ambig-aaaa', '--source', 'cli'], {
          cliHome: f.cliHome,
          geminiRoot: f.geminiRoot,
          cwd: f.wsDir,
          nowMs: f.nowMs,
          isAlive: () => true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message.includes('\x1b'), false);
        assert.equal(err.message.includes('\x07'), false);
        assert.ok(err.message.includes('FirstTitle'));
        assert.ok(err.message.includes('SecondTitle'));
        return true;
      },
    );
  });
});
