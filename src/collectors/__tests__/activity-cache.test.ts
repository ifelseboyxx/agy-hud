import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { SessionRecord } from '../../snapshot-types.ts';
import { loadTranscriptActivity } from '../activity.ts';
import { loadActivitySnapshot } from '../snapshot-loader.ts';
import { scanTranscriptWithCache } from '../transcript-scanner.ts';

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
    assert.equal(cachedJson.v, 6);

    // Second call hits v6 disk cache and returns identical persisted fullTarget and completedTools.
    const second = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.deepEqual(second, first);
  });

  void it('invalidates mismatched schema version activity cache and rescans from transcript', () => {
    const convId = 'act-schema-mismatch';
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

    // Downgrade on-disk cache to v5 without unified v6 canonical schema.
    writeFileSync(
      cachePath,
      JSON.stringify({
        ...v4Record,
        v: 5,
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
    assert.equal(upgraded.v, 6);
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

  void it('reloads HUD and Snapshot activity after same-inode same-length transcript rewrite', () => {
    const convId = 'act-same-ino-len';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    const lineBefore = `${JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', args: { Path: '/workspace/src/alpha.ts' } }],
    })}\n`;
    const lineAfter = `${JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'edit_file', args: { Path: '/workspace/src/bravo.ts' } }],
    })}\n`;
    assert.equal(Buffer.byteLength(lineBefore, 'utf8'), Buffer.byteLength(lineAfter, 'utf8'));

    writeFileSync(transcriptPath, lineBefore, 'utf8');
    const stBefore = statSync(transcriptPath);
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(transcriptPath, fixedTime, fixedTime);

    const session: SessionRecord = {
      convId,
      shortId: convId.slice(0, 8),
      title: 'Rewrite Test',
      workspace: '/workspace',
      workspaces: ['/workspace'],
      dataRoot: cliHome,
      running: false,
      livePid: null,
      hasEnvelope: false,
      envelope: null,
      updatedAtMs: 1_700_000_000_000,
      ageLabel: '1s ago',
    };

    const hudBefore = loadTranscriptActivity(cliHome, { conversation_id: convId });
    const snapBefore = loadActivitySnapshot(session, { cacheCliHome: cliHome, nowMs: 1_700_000_001_000 });
    assert.equal(hudBefore?.completedTools?.[0]?.disp, 'read_file');
    assert.equal(snapBefore.completedTools[0]?.disp, 'read_file');

    // In-place rewrite keeping exact same inode, byte length, and mtime.
    writeFileSync(transcriptPath, lineAfter, 'utf8');
    utimesSync(transcriptPath, fixedTime, fixedTime);
    const stAfter = statSync(transcriptPath);
    assert.equal(stAfter.ino, stBefore.ino);
    assert.equal(stAfter.size, stBefore.size);

    const hudAfter = loadTranscriptActivity(cliHome, { conversation_id: convId });
    const snapAfter = loadActivitySnapshot(session, { cacheCliHome: cliHome, nowMs: 1_700_000_002_000 });
    assert.equal(hudAfter?.completedTools?.[0]?.disp, 'edit_file');
    assert.equal(hudAfter?.completedTools?.[0]?.fullTarget, '/workspace/src/bravo.ts');
    assert.equal(snapAfter.completedTools[0]?.disp, 'edit_file');
    assert.equal(snapAfter.completedTools[0]?.fullTarget, '/workspace/src/bravo.ts');
  });

  void it('matches cold scan after running-suffix rewrite drops transient state', () => {
    const convId = 'act-running-suffix';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const skillStable = path.join(cliHome, 'skills', 'stable-skill', 'SKILL.md');
    const skillTransient = path.join(cliHome, 'skills', 'transient-skill', 'SKILL.md');
    mkdirSync(path.dirname(skillStable), { recursive: true });
    mkdirSync(path.dirname(skillTransient), { recursive: true });
    writeFileSync(skillStable, '---\nname: stable-skill\n---\n', 'utf8');
    writeFileSync(skillTransient, '---\nname: transient-skill\n---\n', 'utf8');

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    const stableLine = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'Model-Stable',
      tool_calls: [
        { name: 'read_file', args: { Path: skillStable } },
        { name: 'mcp_stableSrv_ping', args: {} },
      ],
    });
    const runningLine = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'RUNNING',
      model: 'Model-Transient',
      tool_calls: [
        { name: 'read_file', args: { Path: skillTransient } },
        { name: 'mcp_transientSrv_run', args: {} },
      ],
    });
    writeFileSync(transcriptPath, `${stableLine}\n${runningLine}\n`, 'utf8');

    const session: SessionRecord = {
      convId,
      shortId: convId.slice(0, 8),
      title: 'Running Suffix',
      workspace: '/workspace',
      workspaces: ['/workspace'],
      dataRoot: cliHome,
      running: false,
      livePid: null,
      hasEnvelope: false,
      envelope: null,
      updatedAtMs: 1_700_000_000_000,
      ageLabel: '1s ago',
    };

    const hudWarm1 = loadTranscriptActivity(cliHome, { conversation_id: convId });
    const snapWarm1 = loadActivitySnapshot(session, { cacheCliHome: cliHome, nowMs: 1_700_000_001_000 });
    assert.deepEqual(hudWarm1?.skills, ['stable-skill', 'transient-skill']);
    assert.deepEqual(hudWarm1?.mcps, ['stableSrv', 'transientSrv']);
    assert.equal(snapWarm1.model, 'Model-Transient');

    // Rewrite running suffix without transient skill, transient MCP, or transient model.
    const replacedSuffix = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'edit_file', args: { Path: '/workspace/final.ts' } }],
    });
    writeFileSync(transcriptPath, `${stableLine}\n${replacedSuffix}\n`, 'utf8');

    const hudResumed = loadTranscriptActivity(cliHome, { conversation_id: convId });
    const snapResumed = loadActivitySnapshot(session, { cacheCliHome: cliHome, nowMs: 1_700_000_002_000 });

    // Cold scan using fresh cache directory must match incremental resume identically.
    const coldCacheHome = path.join(tmpRoot, 'cold-cache');
    mkdirSync(coldCacheHome, { recursive: true });
    rmSync(path.join(cliHome, 'cache'), { recursive: true, force: true });
    const hudCold = loadTranscriptActivity(cliHome, { conversation_id: convId });
    const snapCold = loadActivitySnapshot(session, { cacheCliHome: coldCacheHome, nowMs: 1_700_000_002_000 });

    assert.deepEqual(hudResumed, hudCold);
    assert.deepEqual(hudResumed?.skills, ['stable-skill']);
    assert.deepEqual(hudResumed?.mcps, ['stableSrv']);
    assert.equal(snapResumed.model, 'Model-Stable');
    assert.deepEqual(snapResumed.skills, snapCold.skills);
    assert.deepEqual(snapResumed.mcps, snapCold.mcps);
    assert.equal(snapResumed.model, snapCold.model);
    assert.deepEqual(snapResumed.completedTools, snapCold.completedTools);
  });

  void it('rescans transcripts larger than 256 KiB when bytes outside sample windows change', () => {
    const convId = 'act-large-rewrite';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    const makePadLine = (idx: number): string =>
      JSON.stringify({
        type: 'USER_INPUT',
        content: `pad-${String(idx).padStart(4, '0')}-${'x'.repeat(980)}`,
      });
    const prefixLines = Array.from({ length: 40 }, (_, i) => makePadLine(i));
    const targetBefore = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', args: { Path: '/workspace/src/before_mid_target.ts' } }],
    });
    const targetAfter = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'edit_file', args: { Path: '/workspace/src/after__mid_target.ts' } }],
    });
    assert.equal(Buffer.byteLength(targetBefore, 'utf8'), Buffer.byteLength(targetAfter, 'utf8'));
    const suffixLines = Array.from({ length: 280 }, (_, i) => makePadLine(i + 40));

    const contentBefore = `${[...prefixLines, targetBefore, ...suffixLines].join('\n')}\n`;
    const contentAfter = `${[...prefixLines, targetAfter, ...suffixLines].join('\n')}\n`;
    assert.ok(Buffer.byteLength(contentBefore, 'utf8') > 300_000);
    assert.equal(Buffer.byteLength(contentBefore, 'utf8'), Buffer.byteLength(contentAfter, 'utf8'));

    writeFileSync(transcriptPath, contentBefore, 'utf8');
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(transcriptPath, fixedTime, fixedTime);
    const stBefore = statSync(transcriptPath);

    const hudBefore = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.equal(hudBefore?.completedTools?.[0]?.disp, 'read_file');

    // Rewrite line at ~40 KiB (outside head/mid/tail 8 KiB windows) keeping inode, length, and mtime identical.
    writeFileSync(transcriptPath, contentAfter, 'utf8');
    utimesSync(transcriptPath, fixedTime, fixedTime);
    assert.equal(statSync(transcriptPath).ino, stBefore.ino);
    assert.equal(statSync(transcriptPath).size, stBefore.size);

    const hudAfter = loadTranscriptActivity(cliHome, { conversation_id: convId });
    rmSync(path.join(cliHome, 'cache'), { recursive: true, force: true });
    const hudCold = loadTranscriptActivity(cliHome, { conversation_id: convId });

    assert.deepEqual(hudAfter, hudCold);
    assert.equal(hudAfter?.completedTools?.[0]?.disp, 'edit_file');
    assert.equal(hudAfter?.completedTools?.[0]?.fullTarget, '/workspace/src/after__mid_target.ts');
  });

  void it('keeps prefix hash bound to parsed bytes on mid-scan concurrent rewrite', () => {
    const convId = 'act-concurrent-rewrite';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    const doneBefore = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', args: { Path: '/workspace/alpha.ts' } }],
    });
    const doneAfter = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'edit_file', args: { Path: '/workspace/bravo.ts' } }],
    });
    const runningLine = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'RUNNING',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test' } }],
    });
    assert.equal(Buffer.byteLength(doneBefore, 'utf8'), Buffer.byteLength(doneAfter, 'utf8'));

    const fixedTime = new Date(1_700_000_000_000);
    writeFileSync(transcriptPath, `${doneBefore}\n${runningLine}\n`, 'utf8');
    utimesSync(transcriptPath, fixedTime, fixedTime);

    const first = scanTranscriptWithCache({
      transcriptPath,
      skillRootDir: cliHome,
      workspaceDir: '/workspace',
      mcpServers: [],
      projectToolCall: (c) => c,
      onAfterChunkRead: () => {
        writeFileSync(transcriptPath, `${doneAfter}\n${runningLine}\n`, 'utf8');
        utimesSync(transcriptPath, fixedTime, fixedTime);
      },
    });
    assert.ok(first !== null);
    assert.equal(first.tools[0]?.name, 'read_file');
    // On POSIX, utimes() advances ctime immediately; on Windows NTFS, ChangeTime shares a ~15.6ms tick so
    // same-tick spoofed-mtime rewrites are instead caught by the byte-bound stablePrefixHash check below.
    if (process.platform !== 'win32') {
      assert.equal(first.cacheable, false);
    }

    // Even if a caller passed first.meta as a seed, stablePrefixHash reflects parsed bytes so next scan catches edit_file.
    const next = scanTranscriptWithCache({
      transcriptPath,
      skillRootDir: cliHome,
      workspaceDir: '/workspace',
      mcpServers: [],
      seed: {
        meta: first.meta,
        tools: first.tools,
        skills: first.skills,
        mcps: first.mcps,
        agents: first.agents,
        lastModel: first.lastModel,
      },
      projectToolCall: (c) => c,
    });
    assert.ok(next !== null);
    assert.equal(next.cacheHit, false);
    assert.equal(next.tools[0]?.name, 'edit_file');
  });

  void it('keeps hot cache hits sub-frame on a 64 MiB synthetic transcript', () => {
    const convId = 'act-64mib-hot-hit';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    const padBlock = `${JSON.stringify({ type: 'USER_INPUT', content: 'x'.repeat(8 * 1024 * 1024) })}\n`;
    const toolLine = `${JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', args: { Path: '/workspace/src/large.ts' } }],
    })}\n`;
    const buf = Buffer.concat([Buffer.from(padBlock.repeat(8), 'utf8'), Buffer.from(toolLine, 'utf8')]);
    assert.ok(buf.byteLength >= 64 * 1024 * 1024);
    writeFileSync(transcriptPath, buf);

    const warm = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.equal(warm?.completedTools?.[0]?.disp, 'read_file');

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      const hit = loadTranscriptActivity(cliHome, { conversation_id: convId });
      samples.push(performance.now() - start);
      assert.equal(hit?.completedTools?.[0]?.disp, 'read_file');
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[2] ?? 999;
    assert.ok(medianMs < 15, `expected 64 MiB hot-hit median < 15 ms, got ${medianMs.toFixed(2)} ms`);
  });

  void it('drops control-only skill and MCP names from cached v4 activity', () => {
    const convId = 'act-ctrl-only-cache';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }] })}\n`,
      'utf8',
    );
    const warm = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.ok(warm !== null);
    const cachePath = path.join(cliHome, 'cache', `agy_hud_activity_${convId}.json`);
    const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as { data: Record<string, unknown> };
    saved.data.skills = ['\x1b[31m', 'valid-skill'];
    saved.data.mcps = ['\x1b]52;c;x\x07'];
    writeFileSync(cachePath, JSON.stringify(saved), 'utf8');

    const reloaded = loadTranscriptActivity(cliHome, { conversation_id: convId });
    assert.deepEqual(reloaded?.skills, ['valid-skill']);
    assert.deepEqual(reloaded?.mcps, []);
  });
});
