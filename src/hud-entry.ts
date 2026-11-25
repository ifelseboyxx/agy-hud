#!/usr/bin/env node
import { isPlainObject, UNSAFE_OBJECT_KEYS } from './core/guards.ts';
import { isMainEntry, resolveCliHome } from './core/paths.ts';
import { runHudRender, type RenderHudOptions } from './hud-runner.ts';
import type { StatusLineData } from './types.ts';

export type { RenderHudOptions } from './hud-runner.ts';

function stripUnsafeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    clean[key] = val;
  }
  return clean;
}

export function parseStatusLineData(raw: unknown): StatusLineData | null {
  if (!isPlainObject(raw)) return null;
  const clean = stripUnsafeKeys(raw);
  const objectFields = [
    'model',
    'workspace',
    'context_window',
    'agent',
    'quota',
    'vcs',
    'battle',
    'vim',
    'cost',
  ] as const;
  for (const field of objectFields) {
    if (clean[field] !== undefined && !isPlainObject(clean[field])) {
      delete clean[field];
    }
  }
  if (clean.subagents !== undefined && !Array.isArray(clean.subagents)) {
    delete clean.subagents;
  }
  return clean as StatusLineData;
}

export function renderHudFromData(data: StatusLineData, options?: RenderHudOptions): string {
  const cliHome = options?.cliHome ?? resolveCliHome();
  return runHudRender(cliHome, data, options).join('\n');
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      resolve(raw);
    });
    process.stdin.on('error', () => {
      resolve('');
    });
  });
}

async function runHudCli(): Promise<void> {
  const raw = await readAllStdin();
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  const data = parseStatusLineData(parsed);
  if (!data) {
    return;
  }
  const output = renderHudFromData(data);
  if (output.length > 0) {
    process.stdout.write(`${output}\n`);
  }
}

if (isMainEntry(import.meta.url)) {
  runHudCli().catch(() => {
    // Degrade gracefully on unexpected runtime errors.
  });
}
