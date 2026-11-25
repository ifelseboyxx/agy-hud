import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALL_SCRIPT: string = path.join(REPO_ROOT, 'scripts', 'install.mjs');
export const DIST_CLI: string = path.join(REPO_ROOT, 'dist', 'cli.mjs');
export const DIST_HUD: string = path.join(REPO_ROOT, 'dist', 'hud.mjs');
export const DIST_INDEX: string = path.join(REPO_ROOT, 'dist', 'index.mjs');
export const DIST_MCP_HUD: string = path.join(REPO_ROOT, 'dist', 'mcp-hud.mjs');

export interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function createTempDirTracker(): {
  makeTempDir: (prefix: string) => string;
  cleanup: () => void;
} {
  const dirs: string[] = [];

  const restoreWritableDirs = (dirPath: string): void => {
    try {
      chmodSync(dirPath, 0o755);
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          restoreWritableDirs(path.join(dirPath, entry.name));
        }
      }
    } catch {
      // Ignore transient cleanup errors before rmSync.
    }
  };

  return {
    makeTempDir(prefix: string): string {
      const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir) {
          restoreWritableDirs(dir);
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  };
}

export function makeIsolatedEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    GEMINI_HOME: path.join(root, '.gemini'),
    GEMINI_CLI_HOME: root,
    ...extra,
  };
}

export function makeFastIsolatedEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  if (process.platform === 'win32' || extra.PATH !== undefined) {
    return makeIsolatedEnv(root, extra);
  }
  const okBin = createFakeAgyBin(root, 'fast-ok', '  exit 0');
  return makeIsolatedEnv(root, {
    PATH: `${okBin}${path.delimiter}${process.env.PATH ?? ''}`,
    ...extra,
  });
}

export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

export function runNodeScript(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string,
  timeoutMs = 20_000,
): ScriptResult {
  const start = Date.now();
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    durationMs: Date.now() - start,
  };
}

export function spawnNodeAsync(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; stdinText?: string; timeoutMs?: number } = {},
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : null;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      if (timer) clearTimeout(timer);
      resolve({
        status: timedOut ? null : status,
        stdout,
        stderr: timedOut ? `TIMED_OUT\n${stderr}` : stderr,
        durationMs: Date.now() - start,
      });
    });
    child.stdin.end(options.stdinText ?? '');
  });
}

export function spawnNodeScriptAsync(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdinText?: string,
): Promise<ScriptResult> {
  return spawnNodeAsync([scriptPath, ...args], env, stdinText !== undefined ? { stdinText } : {});
}

export async function waitForFile(filePath: string, proc: Promise<ScriptResult>, timeoutMs = 10_000): Promise<void> {
  const state: { result: ScriptResult | null } = { result: null };
  void proc.then((res) => {
    state.result = res;
  });
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (state.result !== null) {
      throw new Error(
        `Process exited (${state.result.status}) before creating ${filePath}: ${state.result.stderr || state.result.stdout}`,
      );
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function createFakeAgyBin(
  root: string,
  name: string,
  onValidateBody: string,
  onDisableBody = '  exit 0',
): string {
  const binDir = path.join(root, `fake-bin-${name}`);
  mkdirSync(binDir, { recursive: true });
  const agyBin = path.join(binDir, 'agy');
  writeFileSync(
    agyBin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy 1.5.14"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "validate" ]; then
${onValidateBody}
fi
if [ "$1" = "plugin" ] && [ "$2" = "disable" ]; then
${onDisableBody}
fi
exit 0
`,
    'utf8',
  );
  chmodSync(agyBin, 0o755);
  return binDir;
}
