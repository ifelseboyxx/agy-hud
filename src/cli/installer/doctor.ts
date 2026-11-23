import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

import { toComparePath } from '../../core/paths.ts';

const HUD_SMOKE_TIMEOUT_MS = 5000;
const requireModule = createRequire(import.meta.url);

export interface HudSmokeResult {
  ok: boolean;
  durationMs: number;
  bytes: number;
  detail: string;
}

export interface AgyValidateResult {
  ok: boolean;
  output: string;
}

function tryRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

export function runAgyPluginValidate(pluginBase: string, repoRoot: string, timeoutMs: number): AgyValidateResult {
  let res = spawnSync('agy', ['plugin', 'validate', pluginBase, '--strict'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  if (
    res.status !== 0 &&
    toComparePath(tryRealpath(pluginBase)) === toComparePath(tryRealpath(repoRoot)) &&
    combined.includes('AGENTS.md: never loaded') &&
    combined.includes('1 warning')
  ) {
    res = spawnSync('agy', ['plugin', 'validate', pluginBase], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  }
  const stderr = (res.stderr ?? '').trim();
  const stdout = (res.stdout ?? '').trim();
  return { ok: !res.error && res.status === 0, output: stderr.length > 0 ? stderr : stdout };
}

export function checkSqliteBuiltin(): boolean {
  try {
    const sqlite = requireModule('node:sqlite') as typeof import('node:sqlite');
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
      return row?.ok === 1;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function runHudStdinSmoke(hudPath: string, repoRoot: string): HudSmokeResult {
  const start = Date.now();
  const sample = JSON.stringify({
    cwd: repoRoot,
    session_id: 'doctor-smoke',
    model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', effort: 'high' },
    workspace: { current_dir: repoRoot },
    context_window: { used_percentage: 25, context_window_size: 1_000_000 },
    terminal_width: 120,
  });

  const res = spawnSync(process.execPath, [hudPath], {
    input: sample,
    encoding: 'utf8',
    timeout: HUD_SMOKE_TIMEOUT_MS,
    windowsHide: true,
  });
  const durationMs = Date.now() - start;
  if (res.error) {
    const isTimeout = 'code' in res.error && res.error.code === 'ETIMEDOUT';
    return { ok: false, durationMs, bytes: 0, detail: isTimeout ? 'timed out after 5s' : res.error.message };
  }
  const bytes = Buffer.byteLength((res.stdout ?? '').trim(), 'utf8');
  return { ok: res.status === 0 && bytes > 0, durationMs, bytes, detail: (res.stderr ?? '').trim() };
}
