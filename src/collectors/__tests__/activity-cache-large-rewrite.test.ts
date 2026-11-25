import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { SessionRecord } from '../../snapshot-types.ts';
import { ACTIVITY_CACHE_SCHEMA_VERSION, writeActivityCache, writeBoundedPrivateJsonCache } from '../activity-cache.ts';
import { loadTranscriptActivity } from '../activity.ts';
import { loadActivitySnapshot } from '../snapshot-loader.ts';

void describe('large (> 512 KiB) transcript with running suffix in-place rewrite', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-large-run-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('rescans > 512 KiB transcript with running suffix after out-of-window same-length rewrite', () => {
    const convId = 'act-large-running-rewrite';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = path.join(logsDir, 'transcript.jsonl');

    const makePadLine = (idx: number): string =>
      JSON.stringify({ type: 'USER_INPUT', content: `pad-${String(idx).padStart(4, '0')}-${'x'.repeat(980)}` });
    const prefixLines = Array.from({ length: 100 }, (_, i) => makePadLine(i));
    const targetBefore = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', args: { Path: '/workspace/src/before_outwin.ts' } }],
    });
    const targetAfter = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'edit_file', args: { Path: '/workspace/src/after__outwin.ts' } }],
    });
    assert.equal(Buffer.byteLength(targetBefore, 'utf8'), Buffer.byteLength(targetAfter, 'utf8'));
    const suffixPadLines = Array.from({ length: 500 }, (_, i) => makePadLine(i + 100));
    const runningTail = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      status: 'RUNNING',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test' } }],
    });

    const beforeContent = `${[...prefixLines, targetBefore, ...suffixPadLines, runningTail].join('\n')}\n`;
    const afterContent = `${[...prefixLines, targetAfter, ...suffixPadLines, runningTail].join('\n')}\n`;
    assert.ok(Buffer.byteLength(beforeContent, 'utf8') > 550 * 1024);
    assert.equal(Buffer.byteLength(beforeContent, 'utf8'), Buffer.byteLength(afterContent, 'utf8'));

    const fixedTime = new Date(1_700_000_000_000);
    writeFileSync(transcriptPath, beforeContent, 'utf8');
    utimesSync(transcriptPath, fixedTime, fixedTime);
    const stBefore = statSync(transcriptPath);

    const session: SessionRecord = {
      convId,
      shortId: convId.slice(0, 8),
      surface: 'cli',
      title: 'Large Running Rewrite',
      workspace: '/workspace',
      workspaces: ['/workspace'],
      dataRoot: cliHome,
      running: true,
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

    writeFileSync(transcriptPath, afterContent, 'utf8');
    utimesSync(transcriptPath, fixedTime, fixedTime);
    assert.equal(statSync(transcriptPath).ino, stBefore.ino);
    assert.equal(statSync(transcriptPath).size, stBefore.size);

    const hudAfter = loadTranscriptActivity(cliHome, { conversation_id: convId });
    const snapAfter = loadActivitySnapshot(session, { cacheCliHome: cliHome, nowMs: 1_700_000_002_000 });
    assert.equal(hudAfter?.completedTools?.[0]?.disp, 'edit_file');
    assert.equal(hudAfter?.completedTools?.[0]?.fullTarget, '/workspace/src/after__outwin.ts');
    assert.equal(snapAfter.completedTools[0]?.disp, 'edit_file');
    assert.equal(snapAfter.completedTools[0]?.fullTarget, '/workspace/src/after__outwin.ts');
  });

  void it('skips persisting activity cache when serialized payload exceeds the byte budget', () => {
    const cachePath = path.join(cliHome, 'cache', 'agy_hud_activity_overbudget.json');
    writeActivityCache(
      cachePath,
      {
        v: ACTIVITY_CACHE_SCHEMA_VERSION,
        path: '/tmp/t.jsonl',
        ino: 1,
        mtimeMs: 1,
        mtimeNs: '1',
        ctimeNs: '1',
        size: 100,
        contentHash: 'full:abc',
        stableOffset: 100,
        stablePrefixHash: 'full:abc',
        stableToolsCount: 0,
        stableSkillsCount: 1,
        stableMcpsCount: 0,
        stableAgentsCount: 0,
        stableLastModel: '',
        data: { tools: [], skills: ['x'.repeat(2048)], mcps: [], agents: [] },
      },
      512,
    );
    assert.equal(existsSync(cachePath), false);
  });

  void it('writes compact single-line JSON for snapshot transcript cache', () => {
    const convId = 'act-snap-compact-json';
    const logsDir = path.join(cliHome, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/workspace/a.ts' } }] })}\n`,
      'utf8',
    );
    const session: SessionRecord = {
      convId,
      shortId: convId.slice(0, 8),
      surface: 'cli',
      title: 'Compact Cache',
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
    loadActivitySnapshot(session, { cacheCliHome: cliHome, nowMs: 1_700_000_001_000 });
    const raw = readFileSync(path.join(cliHome, 'cache', `agy_hud_activity_snapshot_${convId}.json`), 'utf8');
    assert.equal(raw.includes('\n'), false);
    assert.equal((JSON.parse(raw) as { v: number }).v, 4);
  });

  void it('skips persisting snapshot cache payloads exceeding the byte budget', () => {
    const cachePath = path.join(cliHome, 'cache', 'agy_hud_activity_snapshot_overbudget.json');
    const wrote = writeBoundedPrivateJsonCache(cachePath, { v: 4, payload: 'x'.repeat(2048) }, 512);
    assert.equal(wrote, false);
    assert.equal(existsSync(cachePath), false);
  });
});
