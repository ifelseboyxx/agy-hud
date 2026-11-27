import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadTodos, loadTranscriptActivity } from '../src/collectors/activity.ts';
import { collectAgentsSummary } from '../src/collectors/agents.ts';
import { detectAgyFlags } from '../src/collectors/proc.ts';
import { getSessionElapsedSeconds } from '../src/collectors/settings.ts';
import { loadSessionTelemetry } from '../src/collectors/telemetry.ts';

function writeDoneTranscript(
  filePath: string,
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [{ name: 'read_file', args: {} }],
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: toolCalls })}\n`,
    'utf8',
  );
}

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

  void it('blocks traversal conversation_id in loadTodos', () => {
    const escapedTaskDir = path.join(tmpRoot, 'escaped-conv');
    mkdirSync(escapedTaskDir, { recursive: true });
    writeFileSync(path.join(escapedTaskDir, 'task.md'), '- [ ] Leaked task\n', 'utf8');

    assert.equal(loadTodos(cliHome, { conversation_id: '../../../escaped-conv' }), null);
  });

  void it('blocks traversal conversation_id in collectAgentsSummary', () => {
    assert.equal(collectAgentsSummary(cliHome, { conversation_id: '../../../escaped-conv' }).total, 0);
  });

  void it('blocks traversal conversation_id in loadSessionTelemetry', () => {
    assert.equal(loadSessionTelemetry(cliHome, { conversation_id: '../../../escaped-conv' }).genCount, 0);
  });

  void it('blocks traversal session ID in getSessionElapsedSeconds', () => {
    assert.equal(getSessionElapsedSeconds(cliHome, '../../../escaped-conv'), null);
  });

  void it('blocks __proto__ session ID in getSessionElapsedSeconds', () => {
    assert.equal(getSessionElapsedSeconds(cliHome, '__proto__'), null);
  });

  void it('rejects explicit transcript_path outside trusted roots without writing escaped cache', () => {
    const outsideJsonl = path.join(tmpRoot, 'outside.jsonl');
    writeDoneTranscript(outsideJsonl);

    assert.equal(
      loadTranscriptActivity(cliHome, { conversation_id: '../../escaped-cache', transcript_path: outsideJsonl }),
      null,
      'outside transcript_path must be rejected',
    );
    assert.equal(existsSync(path.join(tmpRoot, 'escaped-cache.json')), false);
  });

  void it('allows explicit transcript_path inside sibling antigravity/brain', () => {
    const ideTranscript = path.join(
      tmpRoot,
      '.gemini',
      'antigravity',
      'brain',
      'ide-conv-1',
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    writeDoneTranscript(ideTranscript, [{ name: 'read_file', args: { Path: '/tmp/x.ts' } }]);

    const ideActivity = loadTranscriptActivity(cliHome, {
      conversation_id: 'ide-conv-1',
      transcript_path: ideTranscript,
    });
    assert.ok(ideActivity !== null && ideActivity.tools.length === 1);
  });

  void it('blocks first-time cache writes when cliHome/cache is symlinked outside cliHome', () => {
    const symlinkCliHome = path.join(tmpRoot, '.gemini', 'symlink-cli');
    const outsideCache = path.join(tmpRoot, 'outside-cache');
    mkdirSync(outsideCache, { recursive: true });
    writeDoneTranscript(
      path.join(symlinkCliHome, 'brain', 'sym-conv', '.system_generated', 'logs', 'transcript.jsonl'),
    );
    symlinkSync(outsideCache, path.join(symlinkCliHome, 'cache'), 'dir');

    const symAct = loadTranscriptActivity(symlinkCliHome, { conversation_id: 'sym-conv' });
    assert.ok(symAct !== null && symAct.tools.length === 1);
    assert.equal(existsSync(path.join(outsideCache, 'agy_hud_activity_sym-conv.json')), false);
  });

  void it('rejects explicit transcript_path when brain root itself is a symlink escaping cliHome', () => {
    const outsideBrain = path.join(tmpRoot, 'outside-brain');
    writeDoneTranscript(path.join(outsideBrain, 'conv-1', '.system_generated', 'logs', 'transcript.jsonl'));
    symlinkSync(outsideBrain, path.join(cliHome, 'brain'), 'dir');

    const explicitPath = path.join(cliHome, 'brain', 'conv-1', '.system_generated', 'logs', 'transcript.jsonl');
    assert.equal(
      loadTranscriptActivity(cliHome, { transcript_path: explicitPath }),
      null,
      'symlinked brain directory must not be treated as a trusted root',
    );
  });

  void it('blocks writing activity cache through a dangling symlink', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeDoneTranscript(path.join(cliHome, 'brain', 'dan-conv', '.system_generated', 'logs', 'transcript.jsonl'));

    const escapedActivity = path.join(tmpRoot, 'escaped-activity.json');
    symlinkSync(escapedActivity, path.join(cacheDir, 'agy_hud_activity_dan-conv.json'));

    const act = loadTranscriptActivity(cliHome, { conversation_id: 'dan-conv' });
    assert.ok(act !== null && act.tools.length === 1);
    assert.equal(existsSync(escapedActivity), false, 'dangling activity cache symlink must not be written');
  });

  void it('blocks writing fixed agy_hud_proc.json cache through a dangling symlink', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const escapedProc = path.join(tmpRoot, 'escaped-proc.json');
    symlinkSync(escapedProc, path.join(cacheDir, 'agy_hud_proc.json'));

    detectAgyFlags(cliHome);
    assert.equal(existsSync(escapedProc), false, 'dangling proc cache symlink must not be written');
  });

  void it('blocks writing fixed agy_hud_sessions.json cache through a dangling symlink', () => {
    const cacheDir = path.join(cliHome, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const escapedSessions = path.join(tmpRoot, 'escaped-sessions.json');
    symlinkSync(escapedSessions, path.join(cacheDir, 'agy_hud_sessions.json'));

    getSessionElapsedSeconds(cliHome, 'sess-1');
    assert.equal(existsSync(escapedSessions), false, 'dangling sessions cache symlink must not be written');
  });

  void it('initializes session elapsed cache when cliHome does not exist yet', () => {
    const freshCliHome = path.join(tmpRoot, 'brand-new', '.gemini', 'antigravity-cli');
    const elapsed = getSessionElapsedSeconds(freshCliHome, 'first-run-sess');
    assert.ok(elapsed !== null && elapsed >= 0, 'first-run missing cliHome must return elapsed >= 0');
    assert.equal(existsSync(path.join(freshCliHome, 'cache', 'agy_hud_sessions.json')), true);
  });

  void it('returns null for session elapsed time when cliHome ancestor is a dangling symlink', () => {
    const danglingGem = path.join(tmpRoot, 'broken-gem');
    symlinkSync(path.join(tmpRoot, 'nonexistent-root'), danglingGem);
    assert.equal(getSessionElapsedSeconds(path.join(danglingGem, 'antigravity-cli'), 'sess-2'), null);
  });

  void it('degrades cleanly to null when transcript_path points to a directory', () => {
    const dirJsonl = path.join(cliHome, 'brain', 'dir-conv', 'fake.jsonl');
    mkdirSync(dirJsonl, { recursive: true });
    assert.equal(loadTranscriptActivity(cliHome, { transcript_path: dirJsonl }), null);
  });

  void it('degrades cleanly to null when transcript file is unreadable (0o000)', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const lockedFile = path.join(cliHome, 'brain', 'perm-conv', '.system_generated', 'logs', 'transcript.jsonl');
    writeDoneTranscript(lockedFile, []);
    chmodSync(lockedFile, 0o000);
    try {
      assert.equal(loadTranscriptActivity(cliHome, { conversation_id: 'perm-conv' }), null);
    } finally {
      chmodSync(lockedFile, 0o644);
    }
  });

  void it('expands ~/ transcript_path using process.env.HOME', () => {
    writeDoneTranscript(path.join(cliHome, 'brain', 'tilde-conv', '.system_generated', 'logs', 'transcript.jsonl'));
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

  void it('falls back to folder name for untrusted SKILL.md paths outside trusted roots', () => {
    const outsideSkillDir = path.join(tmpRoot, 'untrusted', 'skills', 'ext-folder');
    mkdirSync(outsideSkillDir, { recursive: true });
    writeFileSync(path.join(outsideSkillDir, 'SKILL.md'), '---\nname: leaked-secret-skill\n---\n', 'utf8');

    writeDoneTranscript(path.join(cliHome, 'brain', 'skill-ext', '.system_generated', 'logs', 'transcript.jsonl'), [
      { name: 'read_file', args: { Path: path.join(outsideSkillDir, 'SKILL.md') } },
    ]);

    const act = loadTranscriptActivity(cliHome, { conversation_id: 'skill-ext' });
    assert.ok(act !== null);
    assert.equal(act.skills.includes('leaked-secret-skill'), false, 'must not read outside SKILL.md frontmatter');
    assert.equal(act.skills.includes('ext-folder'), true, 'falls back to folder name without disk read');
  });

  void it('reads SKILL.md frontmatter from trusted .gemini skill directories', () => {
    const trustedSkillDir = path.join(tmpRoot, '.gemini', 'config', 'skills', 'trusted-folder');
    mkdirSync(trustedSkillDir, { recursive: true });
    writeFileSync(path.join(trustedSkillDir, 'SKILL.md'), '---\nname: verified-skill\n---\n', 'utf8');

    writeDoneTranscript(path.join(cliHome, 'brain', 'skill-trust', '.system_generated', 'logs', 'transcript.jsonl'), [
      { name: 'read_file', args: { Path: path.join(trustedSkillDir, 'SKILL.md') } },
    ]);

    const act = loadTranscriptActivity(cliHome, { conversation_id: 'skill-trust' });
    assert.ok(act !== null);
    assert.equal(act.skills.includes('verified-skill'), true);
  });

  void it('ignores symlinked cliHome/mcp directory escaping cliHome', () => {
    const outsideMcp = path.join(tmpRoot, 'outside-mcp');
    mkdirSync(path.join(outsideMcp, 'escaped_srv'), { recursive: true });
    symlinkSync(outsideMcp, path.join(cliHome, 'mcp'), 'dir');

    writeDoneTranscript(path.join(cliHome, 'brain', 'mcp-sym', '.system_generated', 'logs', 'transcript.jsonl'), [
      { name: 'mcp_escaped_srv_probe_run', args: {} },
    ]);

    const act = loadTranscriptActivity(cliHome, { conversation_id: 'mcp-sym' });
    assert.ok(act !== null);
    assert.equal(act.mcps.includes('escaped_srv'), false, 'symlinked mcp dir must not be listed');
  });

  void it('blocks telemetry DB open when .db-wal is a symlink escaping conversations/', () => {
    const convDir = path.join(cliHome, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = path.join(convDir, 'wal-conv.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
        1,
        Buffer.from([0x0a, 0x04, 0x22, 0x02, 0x10, 0x05]),
      );
    } finally {
      db.close();
    }

    assert.equal(
      loadSessionTelemetry(cliHome, { conversation_id: 'wal-conv' }).genCount,
      1,
      'valid protobuf blob must yield genCount === 1 before adding escaping WAL symlink',
    );

    const outsideWal = path.join(tmpRoot, 'outside.wal');
    const outsideOriginal = 'external-wal-sentinel';
    writeFileSync(outsideWal, outsideOriginal, 'utf8');
    symlinkSync(outsideWal, `${dbPath}-wal`);

    const tel = loadSessionTelemetry(cliHome, { conversation_id: 'wal-conv' });
    assert.equal(tel.genCount, 0, 'escaping .db-wal symlink must block DB read');
    assert.equal(readFileSync(outsideWal, 'utf8'), outsideOriginal, 'external WAL file must remain untouched');
  });
});
