import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../src/core/fs-utils.ts';
import { isPlainObject } from '../src/core/guards.ts';

export interface AgyValidateFinding {
  readonly severity?: string;
  readonly file?: string;
  readonly message?: string;
}

export interface AgyValidateJsonReport {
  readonly name?: string;
  readonly components?: {
    readonly skills?: number;
    readonly mcpServers?: number;
    readonly hooks?: number;
    readonly rules?: number;
  };
  readonly findings?: readonly AgyValidateFinding[];
}

export function isAllowlistedPluginFinding(finding: AgyValidateFinding): boolean {
  return finding.severity === 'warning' && finding.file === 'AGENTS.md';
}

export function evaluateAgyPluginValidationReport(rawJson: string, expectedName = 'agy-hud'): string[] {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`agy plugin validate --json produced invalid JSON: ${msg}`];
  }
  if (!isPlainObject(parsed)) {
    return ['agy plugin validate --json expected top-level JSON object'];
  }
  const report = parsed as AgyValidateJsonReport;
  if (typeof report.name !== 'string' || report.name.trim().length === 0) {
    errors.push('agy plugin validate --json report is missing non-empty plugin name');
  } else if (report.name !== expectedName) {
    errors.push(
      `agy plugin validate --json report plugin name mismatch: expected '${expectedName}', got '${report.name}'`,
    );
  }
  if (!Array.isArray(report.findings)) {
    errors.push('agy plugin validate --json report is missing findings array');
  } else {
    for (const rawFinding of report.findings) {
      if (!isPlainObject(rawFinding)) {
        errors.push('agy plugin validate --json report contains malformed finding entry');
        continue;
      }
      const finding: AgyValidateFinding = {
        severity: typeof rawFinding.severity === 'string' ? rawFinding.severity : undefined,
        file: typeof rawFinding.file === 'string' ? rawFinding.file : undefined,
        message: typeof rawFinding.message === 'string' ? rawFinding.message : undefined,
      };
      if (isAllowlistedPluginFinding(finding)) continue;
      const sev = finding.severity ?? 'unknown';
      const file = finding.file ?? '(manifest)';
      const msg = finding.message ?? 'validation finding';
      errors.push(`[${sev}] ${file}: ${msg}`);
    }
  }
  if (!isPlainObject(report.components)) {
    errors.push('agy plugin validate --json report is missing components summary');
  } else {
    if (report.components.skills !== 1) {
      errors.push(`expected components.skills === 1, got ${String(report.components.skills)}`);
    }
    if (report.components.mcpServers !== 0) {
      errors.push(`expected components.mcpServers === 0, got ${String(report.components.mcpServers)}`);
    }
    if (report.components.hooks !== 0) {
      errors.push(`expected components.hooks === 0, got ${String(report.components.hooks)}`);
    }
    if (report.components.rules !== 0) {
      errors.push(`expected components.rules === 0, got ${String(report.components.rules)}`);
    }
  }
  return errors;
}

export function runOfficialPluginValidate(
  rootDir: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
): number {
  const res = spawnSync('agy', ['plugin', 'validate', '--json', '.'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  if (res.error) {
    process.stderr.write(`validate:plugin failed to invoke agy: ${res.error.message}\n`);
    return 1;
  }
  const stdout = (res.stdout ?? '').trim();
  if (stdout.length === 0) {
    process.stderr.write(
      `validate:plugin received empty output (exit ${String(res.status)}): ${(res.stderr ?? '').trim()}\n`,
    );
    return 1;
  }
  const errors = evaluateAgyPluginValidationReport(stdout);
  if (errors.length > 0 || res.status !== 0) {
    process.stderr.write(`validate:plugin failed (exit ${String(res.status)}):\n`);
    for (const err of errors) process.stderr.write(`  - ${err}\n`);
    if (errors.length === 0 && (res.stderr ?? '').trim().length > 0) {
      process.stderr.write(`  - ${(res.stderr ?? '').trim()}\n`);
    }
    return 1;
  }
  process.stdout.write('[OK] validate:plugin passed (only allowlisted root AGENTS.md warning present)\n');
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exit(runOfficialPluginValidate());
}
