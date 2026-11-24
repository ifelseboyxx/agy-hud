import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { resolveCliHome, toComparePath } from '../../core/paths.ts';
import { lstatIfPresentSync } from '../../fs-utils.ts';
import { PLUGIN_NAME, type InstallerOptions } from './args.ts';
import { inspectStatusLineState, isSupportedNodeVersion, NODE_RANGE_LABEL } from './settings.ts';
import { inspectCliShim, runCliShimSmoke } from './shim.ts';

const HUD_SMOKE_TIMEOUT_MS = 5000;
const AGY_PROBE_TIMEOUT_MS = 10_000;
export const AGY_COMMAND_TIMEOUT_MS = 10_000;

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

export interface DoctorRunOptions {
  targetDir: string;
  quiet: boolean;
  packageRoot: string;
  binDir: string;
  requireShim?: boolean;
  noShim?: boolean;
  checkMalformedShim?: boolean;
  agyAvailable?: boolean;
}

interface ShimDoctorCheck {
  ok: boolean;
  label: string;
}

function tryRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

export function writeInstallerLine(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function hasAgyCli(): boolean {
  const res = spawnSync('agy', ['--version'], { stdio: 'ignore', timeout: AGY_PROBE_TIMEOUT_MS, windowsHide: true });
  return !res.error && res.status === 0;
}

export function toggleAgyPlugin(opts: InstallerOptions, action: 'enable' | 'disable', agyAvailable?: boolean): void {
  if (opts.isProject || opts.isCustomTarget || opts.skipEnable || !(agyAvailable ?? hasAgyCli())) return;
  const res = spawnSync('agy', ['plugin', action, PLUGIN_NAME], { stdio: 'ignore', timeout: AGY_COMMAND_TIMEOUT_MS });
  if (action === 'enable' && !opts.quiet && (res.error || res.status !== 0)) {
    writeInstallerLine(`Note: enable '${PLUGIN_NAME}' in Antigravity Customizations UI if needed.`);
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

function evaluateCliShimDoctor(
  binDir: string,
  resolvedTarget: string,
  requireShim: boolean,
  noShim: boolean,
  checkMalformedShim: boolean,
): ShimDoctorCheck {
  const info = inspectCliShim(binDir, resolvedTarget);
  if (noShim) {
    if (info.status === 'missing') return { ok: true, label: 'not installed (--no-shim)' };
    if (info.status === 'foreign') return { ok: true, label: `foreign (${info.detail})` };
    if (info.status === 'owned-other')
      return { ok: true, label: `owned by other install (${info.target ?? info.detail})` };
    const suffix = info.onPath ? '' : `; note: ${binDir} not on PATH`;
    return { ok: true, label: `${info.primaryPath} (skipped by --no-shim${suffix})` };
  }

  if (info.status === 'missing') {
    return requireShim
      ? { ok: false, label: `FAILED (missing ${info.primaryPath})` }
      : { ok: true, label: 'not installed' };
  }
  if (info.status === 'foreign') {
    return requireShim
      ? { ok: false, label: `FAILED (foreign entry at ${info.detail})` }
      : { ok: true, label: `foreign (${info.detail})` };
  }
  if (info.status === 'owned-other') {
    const target = info.target ?? info.detail;
    return requireShim
      ? { ok: false, label: `FAILED (owned by other install: ${target})` }
      : { ok: true, label: `owned by other install (${target})` };
  }
  if (info.status === 'malformed') {
    const blocking = requireShim || info.claimsSelf || checkMalformedShim;
    return blocking
      ? { ok: false, label: `FAILED (malformed header at ${info.detail})` }
      : { ok: true, label: `malformed (${info.detail})` };
  }
  if (info.status === 'incomplete-win-pair') {
    const blocking = requireShim || info.claimsSelf;
    return blocking
      ? { ok: false, label: `FAILED (incomplete Windows shim pair: ${info.detail})` }
      : { ok: true, label: `incomplete Windows shim pair (${info.detail})` };
  }
  if (lstatIfPresentSync(info.expectedTarget) === null) {
    return { ok: false, label: `FAILED (missing ${info.expectedTarget})` };
  }
  if (!info.executable) {
    return { ok: false, label: `FAILED (missing execute permissions on ${info.primaryPath})` };
  }
  const smoke = runCliShimSmoke(info.primaryPath);
  if (!smoke.ok) {
    return { ok: false, label: `FAILED (smoke check: ${smoke.detail})` };
  }
  const pathNote = info.onPath ? '' : `; note: ${binDir} not on PATH`;
  return { ok: true, label: `OK (${info.primaryPath}, ${smoke.durationMs}ms${pathNote})` };
}

export function runDoctor(opts: DoctorRunOptions): { ok: boolean } {
  const nodeVer = process.versions.node;
  if (!isSupportedNodeVersion(nodeVer)) {
    throw new Error(`Node.js ${NODE_RANGE_LABEL} required (current: v${nodeVer})`);
  }
  const resolvedTarget = path.resolve(opts.targetDir);
  const targetExists = lstatIfPresentSync(resolvedTarget) !== null;
  const pluginBase = targetExists ? resolvedTarget : opts.packageRoot;
  const hudPath = path.join(pluginBase, 'dist', 'hud.mjs');
  const sqliteOk = checkSqliteBuiltin();
  const hudSmoke =
    lstatIfPresentSync(hudPath) !== null
      ? runHudStdinSmoke(hudPath, opts.packageRoot)
      : { ok: false, durationMs: 0, bytes: 0, detail: 'missing dist/hud.mjs' };
  const slState = inspectStatusLineState(resolveCliHome(), resolvedTarget);
  const shimCheck = evaluateCliShimDoctor(
    opts.binDir,
    pluginBase,
    opts.requireShim ?? false,
    opts.noShim ?? false,
    opts.checkMalformedShim ?? false,
  );
  const agyValidate =
    (opts.agyAvailable ?? hasAgyCli())
      ? runAgyPluginValidate(pluginBase, opts.packageRoot, AGY_COMMAND_TIMEOUT_MS)
      : null;

  const ok = sqliteOk && hudSmoke.ok && slState.valid && shimCheck.ok && (agyValidate === null || agyValidate.ok);
  if (!opts.quiet) {
    const smokeDesc = hudSmoke.ok
      ? `OK (${hudSmoke.durationMs}ms, ${hudSmoke.bytes} bytes)`
      : `FAILED (${hudSmoke.detail})`;
    writeInstallerLine('agy-hud doctor:');
    writeInstallerLine(
      `  - Plugin base  : ${pluginBase}${targetExists ? '' : ' (fallback to repo; not installed at target)'}`,
    );
    writeInstallerLine(`  - Node.js      : v${nodeVer} (OK)`);
    writeInstallerLine(`  - node:sqlite  : ${sqliteOk ? 'OK' : 'FAILED'}`);
    writeInstallerLine(`  - dist/hud.mjs : ${smokeDesc}`);
    writeInstallerLine(`  - statusLine   : ${slState.state} (${slState.settingsPath})`);
    writeInstallerLine(`  - CLI shim     : ${shimCheck.label}`);
    if (agyValidate !== null) {
      writeInstallerLine(
        `  - agy validate : ${agyValidate.ok ? 'PASSED (--strict)' : `FAILED (${agyValidate.output})`}`,
      );
    }
  }
  return { ok };
}
