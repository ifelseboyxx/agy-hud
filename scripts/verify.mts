import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/core/fs-utils.ts';
import { type PnpmSpawnSpec, resolvePnpmSpawnSpec } from './lib/pnpm-spawn.mts';

export { type PnpmSpawnSpec, resolvePnpmSpawnSpec };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NON_ZERO_WARNING_COUNT_RE = /\b([1-9]\d*)\s+warnings?\b/i;
const STDOUT_WARNING_LINE_RE = /^\s*(?:warn(?:ing)?(?:\s*[:[\](]|\s+)|\(!\)\s)/im;
const NODE_RUNTIME_WARNING_RE =
  /^\s*(?:\(node:\d+\)\s+(?:\[[^\]]+\]\s+)?[A-Za-z]*Warning:|\(Use `node --trace-warnings\b)/im;
const ANSI_SGR_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const SPEC_TOP_SUITE_RE = /^[\u2714\u2716]\s+(.+?)\s+\(([0-9]+(?:\.[0-9]+)?)ms\)$/;
const SLOW_TEST_OBSERVATION_MS = 10_000;
const DEFAULT_SLOW_SUITE_LIMIT = 5;

export interface SuiteTiming {
  readonly name: string;
  readonly durationMs: number;
}

export function extractSlowestSuites(testStdout: string, limit: number = DEFAULT_SLOW_SUITE_LIMIT): SuiteTiming[] {
  if (limit <= 0) return [];
  const results: SuiteTiming[] = [];
  for (const rawLine of testStdout.split(/\r?\n/)) {
    const cleanLine = rawLine.replace(ANSI_SGR_RE, '');
    const match = SPEC_TOP_SUITE_RE.exec(cleanLine);
    if (!match?.[1] || !match[2]) continue;
    const durationMs = Number.parseFloat(match[2]);
    if (Number.isFinite(durationMs)) {
      results.push({ name: match[1], durationMs });
    }
  }
  return results.sort((a, b) => b.durationMs - a.durationMs).slice(0, limit);
}

export interface StepOutcome {
  name: string;
  code: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  warningReason: string | null;
}

export type VerifyStepRunner = (name: string, args: readonly string[]) => Promise<StepOutcome>;

export interface RunVerifyOptions {
  stepRunner?: VerifyStepRunner;
  stdout?: { write(chunk: string): boolean };
  stderr?: { write(chunk: string): boolean };
  skipBuild?: boolean;
}

export function detectStepWarning(name: string, stdout: string, stderr: string): string | null {
  if (stderr.trim().length > 0) {
    return 'stderr warning/diagnostic';
  }
  if (NODE_RUNTIME_WARNING_RE.test(stdout)) {
    return 'stdout runtime warning';
  }
  if (name !== 'test' && (NON_ZERO_WARNING_COUNT_RE.test(stdout) || STDOUT_WARNING_LINE_RE.test(stdout))) {
    return 'stdout warning diagnostic';
  }
  return null;
}

export function isStepFailure(outcome: StepOutcome): boolean {
  return outcome.code !== 0 || outcome.warningReason !== null;
}

function runPnpmStep(name: string, args: readonly string[]): Promise<StepOutcome> {
  const start = Date.now();
  const spec = resolvePnpmSpawnSpec(args);
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    child.stdout.on('data', (d: Buffer) => outChunks.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d.toString('utf8')));
    child.on('error', (err) => {
      resolve({
        name,
        code: 1,
        durationMs: Date.now() - start,
        stdout: outChunks.join(''),
        stderr: err.message,
        warningReason: null,
      });
    });
    child.on('close', (code) => {
      const stdout = outChunks.join('');
      const stderr = errChunks.join('');
      const exitCode = code ?? 1;
      resolve({
        name,
        code: exitCode,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        warningReason: exitCode === 0 ? detectStepWarning(name, stdout, stderr) : null,
      });
    });
  });
}

function formatStepDiagnostics(item: StepOutcome): string {
  const parts: string[] = [];
  if (item.stderr.trim().length > 0) {
    parts.push(`[stderr]\n${item.stderr.trim()}`);
  }
  if (item.stdout.trim().length > 0) {
    parts.push(`[stdout]\n${item.stdout.trim()}`);
  }
  return parts.join('\n');
}

export async function runVerify(options: RunVerifyOptions = {}): Promise<number> {
  const runner = options.stepRunner ?? runPnpmStep;
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const totalStart = Date.now();

  const staticSteps = [
    runner('lint', ['run', 'lint']),
    runner('format:check', ['run', 'format:check']),
    runner('typecheck', ['run', 'typecheck']),
    runner('validate', ['run', 'validate']),
  ];
  const buildAndTest =
    options.skipBuild === true
      ? runner('test', ['run', 'test']).then((testRes) => [testRes])
      : runner('build', ['run', 'build']).then(async (buildRes) => {
          if (buildRes.code !== 0) return [buildRes];
          const [distCheckRes, testRes] = await Promise.all([
            runner('dist:check', ['run', 'dist:check']),
            runner('test', ['run', 'test']),
          ]);
          return [buildRes, distCheckRes, testRes];
        });

  const [staticOutcomes, pipelineOutcomes] = await Promise.all([Promise.all(staticSteps), buildAndTest]);
  const all = [...staticOutcomes, ...pipelineOutcomes];
  const failed = all.filter(isStepFailure);

  for (const item of all) {
    const tag = isStepFailure(item) ? 'FAIL' : 'PASS';
    const note = item.warningReason !== null ? ` [${item.warningReason}]` : '';
    out.write(`[${tag}] ${item.name} (${item.durationMs}ms)${note}\n`);
  }

  if (failed.length > 0) {
    for (const item of failed) {
      const detail = formatStepDiagnostics(item);
      err.write(`\n--- ${item.name} output ---\n${detail}\n`);
    }
    return 1;
  }
  const testOutcome = all.find((item) => item.name === 'test');
  if (testOutcome && testOutcome.durationMs > SLOW_TEST_OBSERVATION_MS) {
    const slowest = extractSlowestSuites(testOutcome.stdout);
    if (slowest.length > 0) {
      const summary = slowest.map((s) => `${s.name} (${Math.round(s.durationMs)}ms)`).join(', ');
      out.write(`[INFO] slowest test suites (test > ${SLOW_TEST_OBSERVATION_MS}ms): ${summary}\n`);
    }
  }
  out.write(`[OK] verify passed in ${Date.now() - totalStart}ms\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  const skipBuild = cliArgs.includes('--skip-build');
  void runVerify({ skipBuild }).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
