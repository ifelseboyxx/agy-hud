import assert from 'node:assert/strict';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runSnapshotCommand } from '../src/cli/snapshot.ts';
import { loadTranscriptActivity } from '../src/collectors/activity.ts';
import { collectAgentsSummary } from '../src/collectors/agents.ts';
import { writeSnapshotEnvelope } from '../src/collectors/snapshot-envelope.ts';
import { pollHudSnapshot } from '../src/mcp/hud-mcp-snapshot.ts';
import { stripAnsi } from '../src/render/ansi.ts';
import { renderHudLines } from '../src/render/lines.ts';
import { renderSnapshotMarkdown } from '../src/render/osc8-markdown.ts';
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
  initialStep: string;
  fixedTime: Date;
  nowMs: number;
  data: StatusLineData;
}

function createParityFixture(convId = 'parity-shared-1234'): ParityFixture {
  const root = tracker.makeTempDir('agy-hud-parity-');
  const geminiRoot = path.join(root, '.gemini');
  const cliHome = path.join(geminiRoot, 'antigravity-cli');
  const wsDir = path.join(root, 'workspace');
  const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });

  const transcriptPath = path.join(logsDir, 'transcript.jsonl');
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
  writeFileSync(transcriptPath, `${initialStep}\n`, 'utf8');
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

  return { geminiRoot, cliHome, wsDir, convId, transcriptPath, initialStep, fixedTime, nowMs, data };
}

void describe('cross-surface activity parity contract', () => {
  void it('reports identical skills across all four surfaces', () => {
    const f = createParityFixture('parity-skills-1111');
    const hudLines = renderHudLines(f.cliHome, f.data, {
      nowSec: f.nowMs / 1000,
      agyPid: 4242,
      bypass: false,
      cliMode: '',
      branch: 'main',
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      todos: null,
    }).map(stripAnsi);
    const hudActivity = loadTranscriptActivity(f.cliHome, f.data);
    const agentsSummary = collectAgentsSummary(f.cliHome, f.data, hudActivity?.agents);
    const markdown = renderSnapshotMarkdown({
      convId: f.convId,
      data: f.data,
      activity: hudActivity,
      agentsSummary,
      nowMs: f.nowMs,
    });
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
    assert.deepEqual(cliSnap.skills, ['tdd']);
    assert.deepEqual(mcpRes.snapshot?.skills, ['tdd']);
    assert.ok(hudLines.some((l) => l.includes('Skills (1): tdd')));
    assert.ok(markdown.includes('1. `tdd`'));
  });

  void it('reports identical tools and MCP breakdowns across all four surfaces', () => {
    const f = createParityFixture('parity-tools-2222');
    const hudLines = renderHudLines(f.cliHome, f.data, {
      nowSec: f.nowMs / 1000,
      agyPid: 4242,
      bypass: false,
      cliMode: '',
      branch: 'main',
      telemetry: { genCount: 0, tps: null, ttft: null, cachePct: null, ctxUsed: null, ctxMax: null },
      todos: null,
    }).map(stripAnsi);
    const hudActivity = loadTranscriptActivity(f.cliHome, f.data);
    const agentsSummary = collectAgentsSummary(f.cliHome, f.data, hudActivity?.agents);
    const markdown = renderSnapshotMarkdown({
      convId: f.convId,
      data: f.data,
      activity: hudActivity,
      agentsSummary,
      nowMs: f.nowMs,
    });
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
    assert.equal(hudActivity?.completedTools?.length, 3);
    assert.equal(cliSnap.completedTools.length, 3);
    assert.equal(mcpRes.snapshot?.completedTools.length, 3);
    assert.equal(cliSnap.mcps[0]?.server, 'github');
    assert.equal(mcpRes.snapshot?.mcps[0]?.server, 'github');
    assert.ok(hudLines.some((l) => l.includes('MCPs (1): github')));
    assert.ok(markdown.includes('| `github` | 1 | `get_issue` ×1 |'));
  });

  void it('preserves duplicate completed agents identically across snapshot surfaces', () => {
    const f = createParityFixture('parity-agents-3333');
    const hudActivity = loadTranscriptActivity(f.cliHome, f.data);
    const agentsSummary = collectAgentsSummary(f.cliHome, f.data, hudActivity?.agents);
    const markdown = renderSnapshotMarkdown({
      convId: f.convId,
      data: f.data,
      activity: hudActivity,
      agentsSummary,
      nowMs: f.nowMs,
    });
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
    assert.equal(cliSnap.agents.filter((a) => a.name === 'Reviewer').length, 2);
    assert.equal(mcpRes.snapshot?.agents.filter((a) => a.name === 'Reviewer').length, 2);
    assert.equal(markdown.split('\n').filter((line) => line.startsWith('| `Reviewer` |')).length, 2);
  });

  void it('propagates same-inode same-length rewrites identically to HUD, Markdown, CLI, and MCP', () => {
    const f = createParityFixture('parity-rewrite-4444');
    loadTranscriptActivity(f.cliHome, f.data);
    const mcpBefore = pollHudSnapshot(
      { sessionId: f.convId, source: 'cli' },
      { cliHome: f.cliHome, geminiRoot: f.geminiRoot, cwd: f.wsDir, nowMs: f.nowMs, isAlive: (p) => p === 4242 },
    );
    assert.equal(mcpBefore.unchanged, false);

    const stBefore = statSync(f.transcriptPath);
    const rewrittenStep = f.initialStep.replace('"read_file"', '"edit_file"').replace('alpha.ts', 'bravo.ts');
    assert.equal(Buffer.byteLength(rewrittenStep, 'utf8'), Buffer.byteLength(f.initialStep, 'utf8'));
    writeFileSync(f.transcriptPath, `${rewrittenStep}\n`, 'utf8');
    utimesSync(f.transcriptPath, f.fixedTime, f.fixedTime);
    assert.equal(statSync(f.transcriptPath).ino, stBefore.ino);
    assert.equal(statSync(f.transcriptPath).size, stBefore.size);

    const hudAfter = loadTranscriptActivity(f.cliHome, f.data);
    const agentsAfter = collectAgentsSummary(f.cliHome, f.data, hudAfter?.agents);
    const mdAfter = renderSnapshotMarkdown({
      convId: f.convId,
      data: f.data,
      activity: hudAfter,
      agentsSummary: agentsAfter,
      nowMs: f.nowMs + 1000,
    });
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

    assert.equal(mcpAfter.unchanged, false);
    assert.notEqual(mcpAfter.etag, mcpBefore.etag);
    assert.ok(hudAfter?.completedTools?.some((t) => t.disp === 'edit_file'));
    assert.ok(mdAfter.includes('`edit_file`'));
    assert.ok(cliAfter.completedTools.some((t) => t.disp === 'edit_file'));
    assert.ok(mcpAfter.snapshot?.completedTools.some((t) => t.disp === 'edit_file'));
  });

  void it('renders stopped Swarm members consistently across CLI Inspector, Markdown, and MCP', () => {
    const f = createParityFixture('parity-swarm-5555');
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

    const hudActivity = loadTranscriptActivity(f.cliHome, f.data);
    const agentsSummary = collectAgentsSummary(f.cliHome, f.data, hudActivity?.agents);
    const md = renderSnapshotMarkdown({
      convId: f.convId,
      data: f.data,
      activity: hudActivity,
      agentsSummary,
      nowMs: f.nowMs,
    });
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

    assert.ok(md.includes('## Swarm (1 alive · 3 stopped)'));
    assert.ok(md.includes('| `retiredWorker` |'));
    assert.ok(cliText.includes('Swarm (1 alive · 3 stopped)'));
    assert.ok(cliText.includes('retiredWorker'));
    assert.equal(mcpRes.unchanged, false);
    assert.equal(mcpRes.snapshot?.agentsKind, 'swarm');
    assert.ok(mcpRes.snapshot?.agents.some((a) => a.name === 'retiredWorker' && a.state === 'done'));
  });
});
