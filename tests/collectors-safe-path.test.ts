import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadTodos, loadTranscriptActivity } from '../src/collectors/activity.ts';
import { collectAgentsSummary } from '../src/collectors/agents.ts';
import { detectAgyFlags, getSessionElapsedSeconds } from '../src/collectors/settings.ts';
import { loadSessionTelemetry } from '../src/collectors/telemetry.ts';

void describe('collector path containment', () => {
  let tmpRoot = '';
  let cliHome = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-safepath-'));
    cliHome = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    mkdirSync(cliHome, { recursive: true });
  });

  afterEach(() => {
    if (tmpRoot.length > 0) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  void it('blocks traversal session IDs and outside transcript paths while allowing sibling antigravity/brain', () => {
    const outsideJsonl = path.join(tmpRoot, 'outside.jsonl');
    writeFileSync(
      outsideJsonl,
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: {} }] })}\n`,
      'utf8',
    );
    const escapedTaskDir = path.join(tmpRoot, 'escaped-conv');
    mkdirSync(escapedTaskDir, { recursive: true });
    writeFileSync(path.join(escapedTaskDir, 'task.md'), '- [ ] Leaked task\n', 'utf8');

    const traversalId = '../../../escaped-conv';
    assert.equal(
      loadTranscriptActivity(cliHome, { conversation_id: '../../escaped-cache', transcript_path: outsideJsonl }),
      null,
      'outside transcript_path must be rejected',
    );
    assert.equal(loadTodos(cliHome, { conversation_id: traversalId }), null);
    assert.equal(collectAgentsSummary(cliHome, { conversation_id: traversalId }).total, 0);
    assert.equal(loadSessionTelemetry(cliHome, { conversation_id: traversalId }).genCount, 0);
    assert.equal(getSessionElapsedSeconds(cliHome, '__proto__'), null);
    assert.equal(getSessionElapsedSeconds(cliHome, traversalId), null);
    assert.equal(existsSync(path.join(tmpRoot, 'escaped-cache.json')), false);

    // Legitimate transcript_path inside sibling antigravity/brain remains allowed.
    const ideLogsDir = path.join(tmpRoot, '.gemini', 'antigravity', 'brain', 'ide-conv-1', '.system_generated', 'logs');
    mkdirSync(ideLogsDir, { recursive: true });
    const ideTranscript = path.join(ideLogsDir, 'transcript.jsonl');
    writeFileSync(
      ideTranscript,
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/tmp/x.ts' } }] })}\n`,
      'utf8',
    );
    const ideActivity = loadTranscriptActivity(cliHome, {
      conversation_id: 'ide-conv-1',
      transcript_path: ideTranscript,
    });
    assert.ok(ideActivity !== null && ideActivity.tools.length === 1);
  });

  void it('blocks first-time cache writes when cliHome/cache is symlinked outside cliHome', () => {
    const symlinkCliHome = path.join(tmpRoot, '.gemini', 'symlink-cli');
    const outsideCache = path.join(tmpRoot, 'outside-cache');
    mkdirSync(path.join(symlinkCliHome, 'brain', 'sym-conv', '.system_generated', 'logs'), { recursive: true });
    mkdirSync(outsideCache, { recursive: true });
    symlinkSync(outsideCache, path.join(symlinkCliHome, 'cache'), 'dir');
    writeFileSync(
      path.join(symlinkCliHome, 'brain', 'sym-conv', '.system_generated', 'logs', 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: {} }] })}\n`,
      'utf8',
    );

    const symAct = loadTranscriptActivity(symlinkCliHome, { conversation_id: 'sym-conv' });
    assert.ok(symAct !== null && symAct.tools.length === 1);
    assert.equal(existsSync(path.join(outsideCache, 'agy_hud_activity_sym-conv.json')), false);
  });

  void it('rejects explicit transcript_path when brain root itself is a symlink escaping cliHome', () => {
    const outsideBrain = path.join(tmpRoot, 'outside-brain');
    const outsideLogs = path.join(outsideBrain, 'conv-1', '.system_generated', 'logs');
    mkdirSync(outsideLogs, { recursive: true });
    writeFileSync(
      path.join(outsideLogs, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: {} }] })}\n`,
      'utf8',
    );
    symlinkSync(outsideBrain, path.join(cliHome, 'brain'), 'dir');

    const explicitPath = path.join(cliHome, 'brain', 'conv-1', '.system_generated', 'logs', 'transcript.jsonl');
    assert.equal(
      loadTranscriptActivity(cliHome, { transcript_path: explicitPath }),
      null,
      'symlinked brain directory must not be treated as a trusted root',
    );
  });

  void it('blocks dangling symlinks and guards fixed agy_hud_proc.json and agy_hud_sessions.json caches', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const logsDir = path.join(cliHome, 'brain', 'dan-conv', '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: {} }] })}\n`,
      'utf8',
    );

    const escapedActivity = path.join(tmpRoot, 'escaped-activity.json');
    const escapedProc = path.join(tmpRoot, 'escaped-proc.json');
    const escapedSessions = path.join(tmpRoot, 'escaped-sessions.json');
    symlinkSync(escapedActivity, path.join(cacheDir, 'agy_hud_activity_dan-conv.json'));
    symlinkSync(escapedProc, path.join(cacheDir, 'agy_hud_proc.json'));
    symlinkSync(escapedSessions, path.join(cacheDir, 'agy_hud_sessions.json'));

    const act = loadTranscriptActivity(cliHome, { conversation_id: 'dan-conv' });
    assert.ok(act !== null && act.tools.length === 1);
    assert.equal(existsSync(escapedActivity), false, 'dangling activity cache symlink must not be written');

    detectAgyFlags(cliHome);
    assert.equal(existsSync(escapedProc), false, 'dangling proc cache symlink must not be written');

    getSessionElapsedSeconds(cliHome, 'sess-1');
    assert.equal(existsSync(escapedSessions), false, 'dangling sessions cache symlink must not be written');
  });

  void it('initializes session elapsed cache when cliHome does not exist yet unless ancestor is unsafe', () => {
    const freshCliHome = path.join(tmpRoot, 'brand-new', '.gemini', 'antigravity-cli');
    const elapsed = getSessionElapsedSeconds(freshCliHome, 'first-run-sess');
    assert.ok(elapsed !== null && elapsed >= 0, 'first-run missing cliHome must return elapsed >= 0');
    assert.equal(existsSync(path.join(freshCliHome, 'cache', 'agy_hud_sessions.json')), true);

    const danglingGem = path.join(tmpRoot, 'broken-gem');
    symlinkSync(path.join(tmpRoot, 'nonexistent-root'), danglingGem);
    assert.equal(getSessionElapsedSeconds(path.join(danglingGem, 'antigravity-cli'), 'sess-2'), null);
  });

  void it('degrades cleanly on .jsonl directories and 0o000 transcripts and honors HOME for ~/ paths', () => {
    const dirJsonl = path.join(cliHome, 'brain', 'dir-conv', 'fake.jsonl');
    mkdirSync(dirJsonl, { recursive: true });
    assert.equal(loadTranscriptActivity(cliHome, { transcript_path: dirJsonl }), null);

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const lockedLogs = path.join(cliHome, 'brain', 'perm-conv', '.system_generated', 'logs');
      mkdirSync(lockedLogs, { recursive: true });
      const lockedFile = path.join(lockedLogs, 'transcript.jsonl');
      writeFileSync(lockedFile, '{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[]}\n', 'utf8');
      chmodSync(lockedFile, 0o000);
      try {
        assert.equal(loadTranscriptActivity(cliHome, { conversation_id: 'perm-conv' }), null);
      } finally {
        chmodSync(lockedFile, 0o644);
      }
    }

    const homeLogs = path.join(cliHome, 'brain', 'tilde-conv', '.system_generated', 'logs');
    mkdirSync(homeLogs, { recursive: true });
    writeFileSync(
      path.join(homeLogs, 'transcript.jsonl'),
      `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: {} }] })}\n`,
      'utf8',
    );
    const prevHome = process.env.HOME;
    process.env.HOME = tmpRoot;
    try {
      const tildeAct = loadTranscriptActivity(cliHome, {
        transcript_path: '~/.gemini/antigravity-cli/brain/tilde-conv/.system_generated/logs/transcript.jsonl',
      });
      assert.ok(tildeAct !== null && tildeAct.tools.length === 1);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  void it('guards resolveSkillName, listMcpServers, and SQLite WAL against symlink/outside escapes', () => {
    // 1. Outside skill path in transcript must not read SKILL.md outside trusted roots; trusted gemini skill works.
    const outsideSkillDir = path.join(tmpRoot, 'untrusted', 'skills', 'ext-folder');
    mkdirSync(outsideSkillDir, { recursive: true });
    writeFileSync(path.join(outsideSkillDir, 'SKILL.md'), '---\nname: leaked-secret-skill\n---\n', 'utf8');

    const trustedSkillDir = path.join(tmpRoot, '.gemini', 'config', 'skills', 'trusted-folder');
    mkdirSync(trustedSkillDir, { recursive: true });
    writeFileSync(path.join(trustedSkillDir, 'SKILL.md'), '---\nname: verified-skill\n---\n', 'utf8');

    // 2. Symlinked cliHome/mcp escaping cliHome must be ignored.
    const outsideMcp = path.join(tmpRoot, 'outside-mcp');
    mkdirSync(path.join(outsideMcp, 'escaped_srv'), { recursive: true });
    symlinkSync(outsideMcp, path.join(cliHome, 'mcp'), 'dir');

    const logsDir = path.join(cliHome, 'brain', 'guard-conv', '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { name: 'read_file', args: { Path: path.join(outsideSkillDir, 'SKILL.md') } },
            { name: 'read_file', args: { Path: path.join(trustedSkillDir, 'SKILL.md') } },
            { name: 'mcp_escaped_srv_probe_run', args: {} },
          ],
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const act = loadTranscriptActivity(cliHome, { conversation_id: 'guard-conv' });
    assert.ok(act !== null);
    assert.equal(act.skills.includes('leaked-secret-skill'), false, 'must not read outside SKILL.md frontmatter');
    assert.equal(act.skills.includes('ext-folder'), true, 'falls back to folder name without disk read');
    assert.equal(act.skills.includes('verified-skill'), true, 'reads frontmatter from trusted .gemini skill root');
    assert.equal(act.mcps.includes('escaped_srv'), false, 'symlinked mcp dir must not be listed');

    // 3. Symlinked .db-wal escaping conversations/ must block telemetry DB open.
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, 'wal-conv.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, Buffer.from([0x08, 0x05]));
    } finally {
      db.close();
    }

    const outsideWal = path.join(tmpRoot, 'outside.wal');
    writeFileSync(outsideWal, '', 'utf8');
    symlinkSync(outsideWal, `${dbPath}-wal`);

    const tel = loadSessionTelemetry(cliHome, { conversation_id: 'wal-conv' });
    assert.equal(tel.genCount, 0, 'escaping .db-wal symlink must block DB read');
  });
});
