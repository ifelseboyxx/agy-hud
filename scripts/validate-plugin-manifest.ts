import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isPlainObject } from '../src/core/guards.ts';
import { statIfPresentSync } from '../src/fs-utils.ts';

const EXPECTED_PLUGIN_SCHEMA = 'https://antigravity.google/schemas/v1/plugin.json';
const ALLOWED_PLUGIN_KEYS = new Set([
  '$schema',
  'name',
  'displayName',
  'version',
  'description',
  'logo',
  'suggestedPrompts',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]);
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FORBIDDEN_BRAND_PREFIX_RE = /^(?:antigravity|gemini|claude|cursor)\b/i;
const FORBIDDEN_BRAND_SUFFIX_RE = /\b(?:plugin|mcp)$/i;
const LOWERCASE_KEYWORD_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_DESC_LEN = 120;
const MAX_DESC_LEN = 160;
const MIN_LOGO_DIM = 128;

const FORBIDDEN_ROOT_PATHS: readonly string[] = [
  'GEMINI.md',
  '.mcp.json',
  'mcp.json',
  'mcp_config.json',
  'hooks/hooks.json',
  'commands',
  '.antigravity-plugin',
  'rules',
];

function readJsonStrict(absPath: string, relLabel: string, errors: string[]): Record<string, unknown> | null {
  if (!existsSync(absPath)) {
    errors.push(`${relLabel}: missing required file`);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(absPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      errors.push(`${relLabel}: expected top-level JSON object`);
      return null;
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${relLabel}: invalid JSON (${msg})`);
    return null;
  }
}

function validateLogoSvg(rootDir: string, logoRel: string, errors: string[]): void {
  if (!logoRel.endsWith('.svg')) {
    errors.push(`plugin.json: 'logo' must reference an .svg file (got '${logoRel}')`);
    return;
  }
  const resolvedRoot = path.resolve(rootDir);
  const logoAbs = path.resolve(resolvedRoot, logoRel);
  const relFromRoot = path.relative(resolvedRoot, logoAbs);
  if (
    relFromRoot === '' ||
    relFromRoot === '..' ||
    relFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relFromRoot)
  ) {
    errors.push(`plugin.json: 'logo' path '${logoRel}' must stay inside repository root`);
    return;
  }
  if (statIfPresentSync(logoAbs)?.isFile() !== true) {
    errors.push(`plugin.json: 'logo' file does not exist at '${logoRel}'`);
    return;
  }
  const svg = readFileSync(logoAbs, 'utf8');
  const vbMatch = /viewBox=["']\s*0\s+0\s+(\d+)\s+(\d+)\s*["']/.exec(svg);
  if (!vbMatch?.[1] || !vbMatch[2]) {
    errors.push(`${logoRel}: missing square numeric viewBox="0 0 N N"`);
  } else {
    const vbW = Number.parseInt(vbMatch[1], 10);
    const vbH = Number.parseInt(vbMatch[2], 10);
    if (vbW !== vbH || vbW < MIN_LOGO_DIM) {
      errors.push(`${logoRel}: viewBox must be 1:1 and >= ${MIN_LOGO_DIM}x${MIN_LOGO_DIM} (got ${vbW}x${vbH})`);
    }
  }
  const wMatch = /\bwidth=["'](\d+)["']/.exec(svg);
  const hMatch = /\bheight=["'](\d+)["']/.exec(svg);
  if (!wMatch?.[1] || !hMatch?.[1]) {
    errors.push(`${logoRel}: missing explicit numeric width and height attributes`);
  } else {
    const w = Number.parseInt(wMatch[1], 10);
    const h = Number.parseInt(hMatch[1], 10);
    if (w !== h || w < MIN_LOGO_DIM) {
      errors.push(`${logoRel}: width/height must be 1:1 and >= ${MIN_LOGO_DIM} (got ${w}x${h})`);
    }
  }
}

function validatePluginJsonFields(
  rootDir: string,
  manifest: Record<string, unknown>,
  pkg: Record<string, unknown> | null,
  errors: string[],
): void {
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_PLUGIN_KEYS.has(key)) {
      errors.push(`plugin.json: unknown property '${key}' (additionalProperties: false)`);
    }
  }
  if (manifest.$schema !== EXPECTED_PLUGIN_SCHEMA) {
    errors.push(`plugin.json: '$schema' must equal '${EXPECTED_PLUGIN_SCHEMA}'`);
  }
  const name = typeof manifest.name === 'string' ? manifest.name : '';
  if (!KEBAB_CASE_RE.test(name)) {
    errors.push(`plugin.json: 'name' must be strict kebab-case (got '${name}')`);
  } else if (FORBIDDEN_BRAND_PREFIX_RE.test(name) || FORBIDDEN_BRAND_SUFFIX_RE.test(name)) {
    errors.push(`plugin.json: 'name' violates Marketplace brand prefix/suffix policy ('${name}')`);
  }
  const displayName = typeof manifest.displayName === 'string' ? manifest.displayName.trim() : '';
  if (displayName.length === 0) {
    errors.push("plugin.json: 'displayName' is required");
  } else if (FORBIDDEN_BRAND_PREFIX_RE.test(displayName) || FORBIDDEN_BRAND_SUFFIX_RE.test(displayName)) {
    errors.push(`plugin.json: 'displayName' violates Marketplace brand prefix/suffix policy ('${displayName}')`);
  }
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!SEMVER_RE.test(version)) {
    errors.push(`plugin.json: 'version' must be valid semver (got '${version}')`);
  } else if (pkg !== null && typeof pkg.version === 'string' && pkg.version !== version) {
    errors.push(`plugin.json: 'version' (${version}) must match package.json version (${pkg.version})`);
  }
  const desc = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  if (desc.length < MIN_DESC_LEN || desc.length > MAX_DESC_LEN) {
    errors.push(`plugin.json: 'description' length ${desc.length} must be ${MIN_DESC_LEN}..${MAX_DESC_LEN} chars`);
  }
  if (
    !Array.isArray(manifest.suggestedPrompts) ||
    manifest.suggestedPrompts.length < 1 ||
    manifest.suggestedPrompts.length > 3
  ) {
    errors.push("plugin.json: 'suggestedPrompts' must be an array of 1..3 non-blank strings");
  } else if (manifest.suggestedPrompts.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
    errors.push("plugin.json: 'suggestedPrompts' must contain only non-blank strings");
  }
  const author = isPlainObject(manifest.author) ? manifest.author : null;
  if (author === null || typeof author.name !== 'string' || author.name.trim().length === 0) {
    errors.push("plugin.json: 'author.name' is required");
  }
  if (author === null || typeof author.url !== 'string' || !author.url.startsWith('https://')) {
    errors.push("plugin.json: 'author.url' must be an https:// URL");
  }
  if (typeof manifest.homepage !== 'string' || !manifest.homepage.startsWith('https://')) {
    errors.push("plugin.json: 'homepage' must be an https:// URL");
  }
  if (typeof manifest.repository !== 'string' || !manifest.repository.startsWith('https://')) {
    errors.push("plugin.json: 'repository' must be a string https:// URL");
  }
  if (typeof manifest.license !== 'string' || manifest.license.trim().length === 0) {
    errors.push("plugin.json: 'license' must be a non-empty SPDX identifier");
  }
  if (
    !Array.isArray(manifest.keywords) ||
    manifest.keywords.length === 0 ||
    manifest.keywords.some((k) => typeof k !== 'string' || !LOWERCASE_KEYWORD_RE.test(k))
  ) {
    errors.push("plugin.json: 'keywords' must be a non-empty array of lowercase kebab-case tags");
  }
  if (typeof manifest.logo !== 'string' || manifest.logo.trim().length === 0) {
    errors.push("plugin.json: 'logo' is required");
  } else {
    validateLogoSvg(rootDir, manifest.logo, errors);
  }
}

export function validatePluginPackageHygiene(rootDir: string): string[] {
  const errors: string[] = [];
  const manifest = readJsonStrict(path.join(rootDir, 'plugin.json'), 'plugin.json', errors);
  const pkg = readJsonStrict(path.join(rootDir, 'package.json'), 'package.json', errors);
  if (manifest !== null) {
    validatePluginJsonFields(rootDir, manifest, pkg, errors);
  }

  const readmePath = path.join(rootDir, 'README.md');
  if (statIfPresentSync(readmePath)?.isFile() !== true || readFileSync(readmePath, 'utf8').trim().length === 0) {
    errors.push('README.md: missing or empty Marketplace pre-install documentation');
  }
  for (const forbidden of FORBIDDEN_ROOT_PATHS) {
    if (existsSync(path.join(rootDir, forbidden))) {
      errors.push(`${forbidden}: forbidden/shadowed plugin path at repository root`);
    }
  }
  return errors;
}
