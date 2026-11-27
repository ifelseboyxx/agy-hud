import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadTranscriptActivity } from '../../collectors/activity.ts';
import { collectAgentsSummary } from '../../collectors/agents.ts';
import { loadActivitySnapshot } from '../../collectors/snapshot-loader.ts';
import { materializeSnapshotMarkdownIfNeeded } from '../../hud-snapshot-publish.ts';
import type { SessionRecord } from '../../snapshot-types.ts';
import type { AgentsSummary, SessionTelemetry, StatusLineData, TranscriptActivity } from '../../types.ts';
import { stripAnsi } from '../ansi.ts';
import { renderSnapshotMarkdown } from '../osc8-markdown.ts';
import { resolveSnapshotMarkdownUri } from '../osc8.ts';

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

void describe('renderSnapshotMarkdown', () => {
  void it('renders untruncated ANSI-free emoji-free GFM snapshot sections with a 1-line footer', () => {
    const data: StatusLineData = {
      conversation_id: 'conv-full-123456',
      conversation_title: 'Audit OSC 8 Hyperlinks',
      cwd: '/repo/agy-hud',
      workspace: { current_dir: '/repo/agy-hud' },
      model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
    };
    const telemetry: SessionTelemetry = {
      genCount: 4,
      tps: 94.5,
      ttft: 1.42,
      cachePct: 88,
      ctxUsed: 120_000,
      ctxMax: 1_000_000,
    };
    const completedList = Array.from({ length: 9 }, (_, i) => ({
      name: `tool_${i + 1}`,
      disp: `tool_${i + 1}`,
      target: `file_${i + 1}.ts`,
      fullTarget: `/repo/agy-hud/src/very/long/untruncated/path/file_${i + 1}.ts`,
      running: false,
      isSkillRead: false,
    }));
    const activity: TranscriptActivity = {
      tools: [
        {
          name: 'run_command',
          disp: 'run_command',
          target: 'pnpm verify',
          fullTarget: 'pnpm verify | tee /tmp/out.log',
          running: true,
          isSkillRead: false,
        },
        {
          name: 'edit_file',
          disp: 'edit_file',
          target: 'osc8.ts',
          fullTarget: '/repo/agy-hud/src/render/osc8.ts',
          running: true,
          isSkillRead: false,
        },
        {
          name: 'read_file',
          disp: 'read_file',
          target: 'lines.ts',
          fullTarget: '/repo/agy-hud/src/render/lines.ts',
          running: true,
          isSkillRead: false,
        },
        {
          name: 'mcp_agy-fast_batch_search',
          disp: 'agy-fast:batch_search',
          target: 'src',
          fullTarget: 'src/render',
          running: false,
          isSkillRead: false,
        },
        {
          name: 'mcp_agy-fast_batch_search',
          disp: 'agy-fast:batch_search',
          target: 'tests',
          fullTarget: 'tests/e2e',
          running: false,
          isSkillRead: false,
        },
        {
          name: 'mcp_agy-fast_apply_edits',
          disp: 'agy-fast:apply_edits',
          target: 'osc8.ts',
          fullTarget: '/repo/agy-hud/src/render/osc8.ts',
          running: false,
          isSkillRead: false,
        },
        ...completedList,
      ],
      skills: ['tdd', 'codebase-design', 'security-and-hardening'],
      mcps: ['agy-fast'],
      agents: [{ name: 'past-scout', type: 'explorer', model: 'gemini-4-hydrogen', running: false, ts: 900 }],
    };
    const agentsSummary: AgentsSummary = {
      kind: 'agents',
      working: 1,
      waiting: 0,
      alive: 1,
      total: 1,
      entries: [{ name: 'live-worker', type: 'implementer', model: 'gemini-4-carbon', state: 'working', ts: 990 }],
    };

    const md = renderSnapshotMarkdown({
      convId: 'conv-full-123456',
      data,
      activity,
      agentsSummary,
      telemetry,
      nowMs: 1_000_000,
    });

    assert.equal(md, stripAnsi(md));
    assert.equal(EMOJI_PATTERN.test(md), false);
    assert.ok(md.includes('# [CLI] Activity Snapshot'));
    assert.ok(md.includes('Audit OSC 8 Hyperlinks'));
    assert.ok(md.includes('94.5 token/s'));
    assert.ok(md.includes('/repo/agy-hud/src/very/long/untruncated/path/file_9.ts'));
    assert.ok(md.includes('pnpm verify \\| tee /tmp/out.log'));
    assert.ok(md.includes('(+more)'));
    assert.ok(md.includes('1. `tdd`'));
    assert.ok(md.includes('2. `codebase-design`'));
    assert.ok(md.includes('3. `security-and-hardening`'));
    assert.ok(md.includes('`agy-fast`'));
    assert.ok(md.includes('`batch_search` ×2'));
    assert.ok(md.includes('`apply_edits` ×1'));
    assert.ok(md.includes('`live-worker`'));
    assert.ok(md.includes('`past-scout`'));
    assert.ok(md.includes('done'));

    const nonEmptyLines = md
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const footerLine = nonEmptyLines[nonEmptyLines.length - 1] ?? '';
    assert.ok(footerLine.includes('!agy-hud'));
    assert.ok(footerLine.includes('agy-hud -p'));
    assert.ok(footerLine.includes('agy-hud snapshot --keybindings'));
  });

  void it('renders empty section placeholders cleanly when session has no recorded activity', () => {
    const md = renderSnapshotMarkdown({
      convId: 'conv-empty-1',
      data: { conversation_id: 'conv-empty-1' },
      activity: null,
      agentsSummary: null,
      nowMs: 500_000,
    });
    assert.equal(md, stripAnsi(md));
    assert.equal(EMOJI_PATTERN.test(md), false);
    assert.ok(md.includes('_No tool activity recorded._'));
    assert.ok(md.includes('_No skills invoked._'));
    assert.ok(md.includes('_No MCP tool calls recorded._'));
    assert.ok(md.includes('_No subagents or swarm workers recorded._'));
  });

  void it('matches CLI Activity Snapshot when duplicate completed agent names appear on a shared fixture', () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-md-parity-'));
    try {
      const cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
      const convId = 'parity-dup-agents';
      const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(
        path.join(logsDir, 'transcript.jsonl'),
        [
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: '2026-06-01T11:58:00Z',
            tool_calls: [
              { name: 'invoke_subagent', args: { Role: 'Reviewer', TypeName: 'research', Model: 'flash' } },
              { name: 'invoke_subagent', args: { Role: 'Reviewer', TypeName: 'research', Model: 'pro' } },
              { name: 'read_file', args: { Path: '/repo/src/index.ts' } },
            ],
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const nowMs = Date.parse('2026-06-01T12:00:00Z');
      const liveSubagents = [{ name: 'Coder', role: 'Coder', type_name: 'self', status: 'running' }];
      const statusData: StatusLineData = {
        conversation_id: convId,
        conversation_title: 'Parity Session',
        cwd: '/repo',
        model: { display_name: 'Gemini 4 Carbon' },
        subagents: liveSubagents,
      };
      const session: SessionRecord = {
        convId,
        shortId: convId.slice(0, 8),
        surface: 'cli',
        title: 'Parity Session',
        workspace: '/repo',
        workspaces: ['/repo'],
        dataRoot: cliHome,
        running: true,
        livePid: 1234,
        hasEnvelope: true,
        envelope: {
          v: 1,
          convId,
          conversationTitle: 'Parity Session',
          agyPid: 1234,
          cwd: '/repo',
          workspaceCurrentDir: '/repo',
          workspaceProjectDir: '/repo',
          subagents: liveSubagents,
          taskCount: null,
          mdDigest: null,
          updatedAtMs: nowMs,
          heartbeatAtMs: nowMs,
        },
        updatedAtMs: nowMs,
        ageLabel: '0s ago',
      };

      const cliSnapshot = loadActivitySnapshot(session, { cacheCliHome: cliHome, nowMs });
      const hudActivity = loadTranscriptActivity(cliHome, statusData);
      const agentsSummary = collectAgentsSummary(cliHome, statusData, hudActivity?.agents);
      const md = renderSnapshotMarkdown({
        convId,
        data: statusData,
        activity: hudActivity,
        agentsSummary,
        nowMs,
      });

      const cliReviewers = cliSnapshot.agents.filter((a) => a.name === 'Reviewer');
      const mdReviewerRows = md.split('\n').filter((line) => line.startsWith('| `Reviewer` |'));
      assert.equal(cliReviewers.length, 2);
      assert.equal(mdReviewerRows.length, cliReviewers.length);
      assert.ok(md.includes('## Agents (1 alive · 2 done)'));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('allows a newer render sharing the same baseline envelope to overwrite an older concurrent publish', () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-md-newer-'));
    try {
      const cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
      const convId = 'conv-newer-wins';
      const target = resolveSnapshotMarkdownUri(cliHome, convId);
      assert.ok(target !== null);
      const t0 = Date.parse('2026-06-01T12:00:00Z');
      const baseOpts = {
        cliHome,
        convId,
        target,
        emittedOsc8Count: 1,
        agyPid: null,
        activity: null,
        agentsSummary: null,
      };
      const initial = materializeSnapshotMarkdownIfNeeded({
        ...baseOpts,
        data: { conversation_id: convId, conversation_title: 'V0', cwd: tmpRoot },
        existingEnvelope: null,
        transcriptStat: { ino: 1, mtimeMs: 100, size: 10 },
        nowMs: t0,
      });
      const older = materializeSnapshotMarkdownIfNeeded({
        ...baseOpts,
        data: { conversation_id: convId, conversation_title: 'Older V1', cwd: tmpRoot },
        existingEnvelope: initial.envelope,
        transcriptStat: { ino: 1, mtimeMs: 200, size: 20 },
        nowMs: t0 + 1000,
      });
      assert.equal(older.written, true);
      const newer = materializeSnapshotMarkdownIfNeeded({
        ...baseOpts,
        data: { conversation_id: convId, conversation_title: 'Newer V2', cwd: tmpRoot },
        existingEnvelope: initial.envelope,
        transcriptStat: { ino: 1, mtimeMs: 300, size: 30 },
        nowMs: t0 + 2000,
      });
      assert.equal(newer.written, true);
      assert.ok(readFileSync(target.absPath, 'utf8').includes('Newer V2'));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('strips CSI, DCS, unterminated OSC, C1, and bidi controls from rendered Markdown cells', () => {
    const md = renderSnapshotMarkdown({
      convId: 'conv-escape-1234',
      data: {
        conversation_id: 'conv-escape-1234',
        conversation_title: 'Clean\x1b[2J\x1bPq#0\x1b\\\u202ETitle\x1b]52;c;unterminated',
        cwd: '/repo/ws\x9b31m',
        model: { display_name: 'Model\x1b]8;;https://evil.test\x07Name' },
      },
      activity: {
        tools: [
          {
            name: 'tool\x1b[2J',
            disp: 'tool\x1b[2J',
            target: 'f.ts',
            fullTarget: '/repo/f\x1b]52;c;abc\x07.ts',
            running: true,
            isSkillRead: false,
          },
        ],
        skills: ['skill\x1b[31m\x1b[2J'],
        mcps: ['srv\x1b]52;c;abc\x07'],
        agents: [],
      },
      agentsSummary: {
        kind: 'agents',
        working: 1,
        waiting: 0,
        alive: 1,
        total: 1,
        entries: [
          { name: 'worker\x1b[2J', type: 'type\x9d52;c;x\x07', model: 'flash\u202E', state: 'working', ts: null },
        ],
      },
      nowMs: 1_000_000,
    });

    assert.equal(md.includes('\x1b'), false);
    assert.equal(md.includes('\x07'), false);
    assert.equal(md.includes('\x9b'), false);
    assert.equal(md.includes('\x9d'), false);
    assert.equal(md.includes('\u202E'), false);
    assert.equal(md.includes('unterminated'), false);
    assert.ok(md.includes('- **Title**: CleanTitle'));
    assert.ok(md.includes('- **Model**: `ModelName`'));
  });

  void it('escapes Markdown image and HTML syntax in snapshot title', () => {
    const md = renderSnapshotMarkdown({
      convId: 'conv-md-title',
      data: {
        conversation_id: 'conv-md-title',
        conversation_title: '![x](https://attacker.example/pixel) <img src=x>',
      },
      activity: null,
      agentsSummary: null,
      nowMs: 1_000_000,
    });
    assert.equal(md.includes('![x](https://attacker.example/pixel)'), false);
    assert.equal(md.includes('<img src=x>'), false);
    assert.ok(md.includes('\\!\\[x\\]\\(https://attacker.example/pixel\\)'));
  });

  void it('escapes Markdown links in agent table cells', () => {
    const md = renderSnapshotMarkdown({
      convId: 'conv-md-agent',
      data: { conversation_id: 'conv-md-agent' },
      activity: null,
      agentsSummary: {
        kind: 'agents',
        working: 1,
        waiting: 0,
        alive: 1,
        total: 1,
        entries: [
          {
            name: 'worker',
            type: '[click](https://evil.test)',
            model: '![px](https://evil.test/p.png)',
            state: 'working',
            ts: 990,
          },
        ],
      },
      nowMs: 1_000_000,
    });
    assert.equal(md.includes('[click](https://evil.test)'), false);
    assert.equal(md.includes('![px](https://evil.test/p.png)'), false);
  });

  void it('expands code-span fence length beyond double backticks in tool targets', () => {
    const payload = 'x`` [click](https://evil.test) ``y';
    const md = renderSnapshotMarkdown({
      convId: 'conv-md-fence',
      data: { conversation_id: 'conv-md-fence' },
      activity: {
        tools: [
          {
            name: 'run_command',
            disp: 'run_command',
            target: payload,
            fullTarget: payload,
            running: true,
            isSkillRead: false,
          },
        ],
        skills: [],
        mcps: [],
        agents: [],
      },
      agentsSummary: null,
      nowMs: 1_000_000,
    });
    assert.ok(md.includes(`\`\`\`${payload}\`\`\``));
  });

  void it('pads code-span fences with spaces when payload starts or ends with a backtick', () => {
    const payload = '``wrapped``';
    const md = renderSnapshotMarkdown({
      convId: 'conv-md-pad',
      data: { conversation_id: 'conv-md-pad', model: { display_name: payload } },
      activity: null,
      agentsSummary: null,
      nowMs: 1_000_000,
    });
    assert.ok(md.includes(`- **Model**: \`\`\` ${payload} \`\`\``));
  });

  void it('keeps literal pipe characters unescaped inside non-table Markdown code spans', () => {
    const md = renderSnapshotMarkdown({
      convId: 'conv-md-pipe',
      data: { conversation_id: 'conv-md-pipe', cwd: '/repo/a|b' },
      activity: null,
      agentsSummary: null,
      nowMs: 1_000_000,
    });
    assert.ok(md.includes('- **Workspace**: `/repo/a|b`'));
  });
});
