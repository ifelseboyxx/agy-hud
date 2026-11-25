import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadTranscriptActivity } from '../../collectors/activity.ts';
import { collectAgentsSummary } from '../../collectors/agents.ts';
import { loadActivitySnapshot } from '../../collectors/snapshot-loader.ts';
import type { SessionRecord } from '../../snapshot-types.ts';
import type { AgentsSummary, SessionTelemetry, StatusLineData, TranscriptActivity } from '../../types.ts';
import { stripAnsi } from '../ansi.ts';
import { renderSnapshotMarkdown } from '../osc8-markdown.ts';

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
});
