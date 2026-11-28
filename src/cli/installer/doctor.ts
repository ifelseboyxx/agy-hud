import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { lstatIfPresentSync, statIfPresentSync } from '../../core/fs-utils.ts';
import { isSupportedNodeVersion, NODE_RANGE_LABEL } from '../../core/guards.ts';
import { resolveCliHome } from '../../core/paths.ts';
import { PLUGIN_NAME, type InstallerOptions } from './args.ts';
import { inspectStatusLineState } from './settings.ts';
import { inspectCliShim, runCliShimSmoke } from './shim.ts';
import { formatCliStorageLine, formatCliStorageNote, inspectCliStorageHealth } from './storage-check.ts';

const HUD_SMOKE_TIMEOUT_MS = 5000;
const AGY_PROBE_TIMEOUT_MS = 10_000;
const AGY_COMMAND_TIMEOUT_MS = 10_000;

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

export interface InstallerRuntimeContext {
  readonly cliHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: { write(chunk: string): boolean };
}

export interface DoctorRunOptions extends InstallerRuntimeContext {
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

export function writeInstallerLine(line = '', stdout?: { write(chunk: string): boolean }): void {
  (stdout ?? process.stdout).write(`${line}\n`);
}

export function hasAgyCli(env: NodeJS.ProcessEnv = process.env): boolean {
  const res = spawnSync('agy', ['--version'], {
    stdio: 'ignore',
    timeout: AGY_PROBE_TIMEOUT_MS,
    windowsHide: true,
    env,
  });
  return !res.error && res.status === 0;
}

export function toggleAgyPlugin(
  opts: InstallerOptions,
  action: 'enable' | 'disable',
  agyAvailable?: boolean,
  runtime?: InstallerRuntimeContext,
): void {
  const env = runtime?.env ?? process.env;
  if (opts.isProject || opts.isCustomTarget || opts.skipEnable || !(agyAvailable ?? hasAgyCli(env))) return;
  const res = spawnSync('agy', ['plugin', action, PLUGIN_NAME], {
    stdio: 'ignore',
    timeout: AGY_COMMAND_TIMEOUT_MS,
    env,
  });
  if (!opts.quiet && (res.error || res.status !== 0)) {
    writeInstallerLine(`Note: ${action} '${PLUGIN_NAME}' in Antigravity Customizations UI if needed.`, runtime?.stdout);
  }
}

export interface HostPluginUninstallResult {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly status: number | null;
  readonly detail: string;
}

export function uninstallAgyPlugin(
  opts: InstallerOptions,
  agyAvailable?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): HostPluginUninstallResult {
  if (opts.isProject || opts.isCustomTarget || opts.skipEnable || !(agyAvailable ?? hasAgyCli(env))) {
    return { attempted: false, ok: false, status: null, detail: '' };
  }
  const res = spawnSync('agy', ['plugin', 'uninstall', PLUGIN_NAME], {
    encoding: 'utf8',
    timeout: AGY_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    env,
  });
  const detail = res.error ? res.error.message : (res.stderr ?? '').trim() || (res.stdout ?? '').trim();
  return {
    attempted: true,
    ok: !res.error && res.status === 0,
    status: res.status,
    detail,
  };
}

export function runAgyPluginValidate(pluginBase: string, _repoRoot: string, timeoutMs: number): AgyValidateResult {
  let res = spawnSync('agy', ['plugin', 'validate', pluginBase, '--strict'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const hasRootAgentsMd = statIfPresentSync(path.join(pluginBase, 'AGENTS.md'))?.isFile() === true;
  if (
    res.status !== 0 &&
    hasRootAgentsMd &&
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

function checkSqliteBuiltin(): boolean {
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

  const smokeRoot = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-doctor-smoke-'));
  const smokeEnv: NodeJS.ProcessEnv = { ...process.env, GEMINI_CLI_HOME: smokeRoot };
  delete smokeEnv.GEMINI_HOME;

  try {
    const res = spawnSync(process.execPath, [hudPath], {
      input: sample,
      encoding: 'utf8',
      timeout: HUD_SMOKE_TIMEOUT_MS,
      windowsHide: true,
      env: smokeEnv,
    });
    const durationMs = Date.now() - start;
    if (res.error) {
      const isTimeout = 'code' in res.error && res.error.code === 'ETIMEDOUT';
      return { ok: false, durationMs, bytes: 0, detail: isTimeout ? 'timed out after 5s' : res.error.message };
    }
    const bytes = Buffer.byteLength((res.stdout ?? '').trim(), 'utf8');
    return { ok: res.status === 0 && bytes > 0, durationMs, bytes, detail: (res.stderr ?? '').trim() };
  } finally {
    try {
      rmSync(smokeRoot, { recursive: true, force: true });
    } catch {
      // Ignore temp smoke directory cleanup failure.
    }
  }
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
  if (statIfPresentSync(info.expectedTarget)?.isFile() !== true) {
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
  const targetLstat = lstatIfPresentSync(resolvedTarget);
  const targetExists = targetLstat !== null;
  const isLinkInstall = targetLstat?.isSymbolicLink() === true;
  const pluginBase = targetExists ? resolvedTarget : opts.packageRoot;
  const hudPath = path.join(pluginBase, 'dist', 'hud.mjs');
  const sqliteOk = checkSqliteBuiltin();
  const hudSmoke =
    statIfPresentSync(hudPath)?.isFile() === true
      ? runHudStdinSmoke(hudPath, opts.packageRoot)
      : { ok: false, durationMs: 0, bytes: 0, detail: 'missing dist/hud.mjs' };
  const env = opts.env ?? process.env;
  const cliHome = resolveCliHome(opts.cliHome, env);
  const slState = inspectStatusLineState(cliHome, resolvedTarget);
  const shimCheck = evaluateCliShimDoctor(
    opts.binDir,
    pluginBase,
    opts.requireShim ?? false,
    opts.noShim ?? false,
    opts.checkMalformedShim ?? false,
  );
  const agyValidate =
    (opts.agyAvailable ?? hasAgyCli(env))
      ? runAgyPluginValidate(pluginBase, opts.packageRoot, AGY_COMMAND_TIMEOUT_MS)
      : null;

  const ok = sqliteOk && hudSmoke.ok && slState.valid && shimCheck.ok && (agyValidate === null || agyValidate.ok);
  if (!opts.quiet) {
    const out = opts.stdout;
    const smokeDesc = hudSmoke.ok
      ? `OK (${hudSmoke.durationMs}ms, ${hudSmoke.bytes} bytes)`
      : `FAILED (${hudSmoke.detail})`;
    writeInstallerLine('agy-hud doctor:', out);
    const baseSuffix = !targetExists
      ? ' (fallback to repo; not installed at target)'
      : isLinkInstall
        ? ` (Link Install -> ${tryRealpath(resolvedTarget)})`
        : '';
    writeInstallerLine(`  - Plugin base  : ${pluginBase}${baseSuffix}`, out);
    writeInstallerLine(`  - Node.js      : v${nodeVer} (OK)`, out);
    writeInstallerLine(`  - node:sqlite  : ${sqliteOk ? 'OK' : 'FAILED'}`, out);
    writeInstallerLine(`  - dist/hud.mjs : ${smokeDesc}`, out);
    writeInstallerLine(`  - statusLine   : ${slState.state} (${slState.settingsPath})`, out);
    writeInstallerLine(`  - CLI shim     : ${shimCheck.label}`, out);
    const storageReport = inspectCliStorageHealth(cliHome, { sqliteOk });
    writeInstallerLine(`  - CLI storage  : ${formatCliStorageLine(storageReport)}`, out);
    const storageNote = formatCliStorageNote(storageReport);
    if (storageNote !== null) {
      writeInstallerLine(`  - Storage note : ${storageNote}`, out);
    }
    if (agyValidate !== null) {
      writeInstallerLine(
        `  - agy validate : ${agyValidate.ok ? 'PASSED (--strict)' : `FAILED (${agyValidate.output})`}`,
        out,
      );
    }
    if (isLinkInstall) {
      writeInstallerLine(
        '  - Link Install : to switch to zero-build Plugin Install, run `agy plugin uninstall agy-hud && agy plugin install https://github.com/ifelseboyxx/agy-hud`',
        out,
      );
    }
  }
  return { ok };
}
