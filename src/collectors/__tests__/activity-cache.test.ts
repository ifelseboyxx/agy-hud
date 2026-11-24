import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadTranscriptActivity } from '../activity.ts';

void describe('transcript activity v4 cache and target persistence', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-actcache-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('persists fullTarget on TranscriptToolEntry and completedTools with latestTarget in v4 cache', () => {
    const convId = 'act-v4-conv';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    const longPathA = '/workspace/project/src/render/very-long-first-file-name.ts';
    const longPathB = '/workspace/project/src/render/very-long-second-file-name.ts';
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { name: 'read_file', args: { Path: longPathA } },
          { name: 'read_file', args: { Path: longPathB } },
          { name: 'edit_file', args: { Path: longPathA } },
        ],
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm verify --reporter=verbose' } }],
      }),
    ];
    writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8');

    const first = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(first !== null);
    assert.equal(first.tools[0]?.fullTarget, longPathA);
    assert.equal(first.tools[1]?.fullTarget, longPathB);
    assert.equal(first.tools[3]?.fullTarget, 'pnpm verify --reporter=verbose');
    assert.deepEqual(first.completedTools, [
      {
        disp: 'read_file',
        count: 2,
        latestTarget: 'very-long-second-fi…',
        fullTarget: longPathB,
        recentTargets: [longPathB, longPathA],
      },
      {
        disp: 'edit_file',
        count: 1,
        latestTarget: 'very-long-first-fil…',
        fullTarget: longPathA,
        recentTargets: [longPathA],
      },
    ]);

    const cachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    const cachedJson = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    assert.equal(cachedJson.v, 4);

    // Second call hits v4 disk cache and returns identical persisted fullTarget and completedTools.
    const second = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.deepEqual(second, first);
  });

  void it('invalidates legacy v3 activity cache and upgrades disk cache to v4', () => {
    const convId = 'act-v3-upgrade';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    const targetPath = '/workspace/src/render/ansi.ts';
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: targetPath } }],
      })}\n`,
      'utf8',
    );

    const first = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(first !== null);
    const cachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    const v4Record = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;

    // Downgrade on-disk cache to v3 without fullTarget/completedTools.
    writeFileSync(
      cachePath,
      JSON.stringify({
        ...v4Record,
        v: 3,
        data: {
          tools: [{ name: 'read_file', disp: 'read_file', target: 'ansi.ts', running: false, isSkillRead: false }],
          skills: [],
          mcps: [],
          agents: [],
        },
      }),
      'utf8',
    );

    const reloaded = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(reloaded !== null);
    assert.equal(reloaded.tools[0]?.fullTarget, targetPath);
    assert.equal(reloaded.completedTools?.[0]?.fullTarget, targetPath);
    const upgraded = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    assert.equal(upgraded.v, 4);
  });

  void it('falls back to rescanning when v4 cache has invalid fullTarget or completedTools types', () => {
    const convId = 'act-v4-corrupt';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    const targetPath = '/workspace/src/types.ts';
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'edit_file', args: { Path: targetPath } }],
      })}\n`,
      'utf8',
    );

    const first = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(first !== null);
    const cachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;

    writeFileSync(
      cachePath,
      JSON.stringify({
        ...saved,
        data: {
          tools: [
            {
              name: 'edit_file',
              disp: 'edit_file',
              target: 'types.ts',
              fullTarget: 123,
              running: false,
              isSkillRead: false,
            },
          ],
          skills: [],
          mcps: [],
          agents: [],
          completedTools: ['corrupt'],
        },
      }),
      'utf8',
    );

    const recovered = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(recovered !== null);
    assert.equal(recovered.tools[0]?.fullTarget, targetPath);
    assert.equal(recovered.completedTools?.[0]?.latestTarget, 'types.ts');
  });
});
