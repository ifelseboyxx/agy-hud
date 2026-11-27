#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_RANGE_LABEL = '^22.20.0 || >=24.0.0';
const NODE_LTS_MAJOR = 22;
const NODE_LTS_MIN_MINOR = 20;
const NODE_CURRENT_MIN_MAJOR = 24;

function assertBootNodeVersion() {
  const [rawMajor = 0, rawMinor = 0] = process.versions.node.split('.').map((p) => Number.parseInt(p, 10));
  const major = Number.isFinite(rawMajor) ? rawMajor : 0;
  const minor = Number.isFinite(rawMinor) ? rawMinor : 0;
  if (!((major === NODE_LTS_MAJOR && minor >= NODE_LTS_MIN_MINOR) || major >= NODE_CURRENT_MIN_MAJOR)) {
    throw new Error(`Node.js ${NODE_RANGE_LABEL} required (current: v${process.versions.node})`);
  }
}

try {
  assertBootNodeVersion();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = path.join(root, 'dist', 'cli.mjs');
  if (!existsSync(cliPath)) {
    throw new Error("Missing required file: dist/cli.mjs. Run 'pnpm build' first.");
  }
  const { runInstallerCli } = await import(pathToFileURL(cliPath).href);
  const code = runInstallerCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
