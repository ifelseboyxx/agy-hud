import { isPlainObject, UNSAFE_OBJECT_KEYS as UNSAFE_KEYS } from '../core/guards.ts';
import { hydrateHudConfig } from '../core/hud-config.ts';
import { DEFAULT_HUD_CONFIG } from '../types.ts';

export const REDACTED_PLACEHOLDER = '<SET_IN_ENV>';
export { UNSAFE_KEYS };

const SECRET_KEY_RE = /token|key|secret|pass|pwd|auth|cred|cookie|session|bearer|private|cert|pat|sig|dsn|webhook/i;
const SENSITIVE_QUERY_KEY_RE = /token|key|secret|pass|pwd|auth|sig|signature|cred|cookie|session/i;
const HEADER_FLAG_RE = /^(?:-H|--header)$/i;
const SECRET_VALUE_RES: readonly RegExp[] = [
  /^(?:bearer|basic)\s+\S+/i,
  /(?:^|[\s=:'"])(?:sk-[A-Za-z0-9_-]{8,}|gh[pous]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{10,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
];
const URL_SCHEME_RE =
  /^(?:git\+)?(?:https?|wss?|git|postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?|amqps?|ftp):\/\//i;

const ALLOWED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'model',
  'orchestrator',
  'theme',
  'agentMode',
  'approvalMode',
  'sandbox',
  'general',
  'ui',
  'tools',
  'context',
  'accessibility',
  'editor',
  'vimMode',
  'preferredEditor',
  'autoAccept',
  'maxSessionTurns',
  'hideTips',
  'hideBanner',
  'showMemoryUsage',
  'language',
  'locale',
  'modelSelection',
  'thinkingLevel',
  'effort',
]);

const ALLOWED_HUD_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_HUD_CONFIG));

const ALLOWED_MCP_SERVER_KEYS: ReadonlySet<string> = new Set([
  'command',
  'args',
  'url',
  'serverUrl',
  'httpUrl',
  'type',
  'transport',
  'disabled',
  'alwaysAllow',
  'autoApprove',
  'timeout',
  'env',
  'headers',
  'httpHeaders',
  'description',
]);

export function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      copy[key] = cloneValue(val);
    }
    return copy;
  }
  return value;
}

export function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return cloneValue(record) as Record<string, unknown>;
}

function looksLikeSecretValue(raw: string): boolean {
  const trimmed = raw.trim();
  return SECRET_VALUE_RES.some((re) => re.test(trimmed));
}

const GIT_SCHEME_PREFIX = 'git+';

function redactSensitiveQueryParams(parsed: URL): void {
  const keys = new Set(parsed.searchParams.keys());
  for (const key of keys) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) {
      parsed.searchParams.set(key, REDACTED_PLACEHOLDER);
    }
  }
}

export function sanitizeUrlString(raw: string, stripAllQuery = false): string {
  const trimmed = raw.trim();
  const hasGitPrefix = trimmed.toLowerCase().startsWith(GIT_SCHEME_PREFIX);
  const candidate = hasGitPrefix ? trimmed.slice(GIT_SCHEME_PREFIX.length) : trimmed;
  try {
    const parsed = new URL(candidate);
    parsed.username = '';
    parsed.password = '';
    if (stripAllQuery) {
      parsed.search = '';
      parsed.hash = '';
    } else if (parsed.search.length > 0) {
      redactSensitiveQueryParams(parsed);
    }
    const serialized = parsed.toString();
    return hasGitPrefix ? `${GIT_SCHEME_PREFIX}${serialized}` : serialized;
  } catch {
    if (candidate.includes('://') && candidate.includes('@')) {
      return REDACTED_PLACEHOLDER;
    }
    return trimmed;
  }
}

export function sanitizeRepoUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (URL_SCHEME_RE.test(trimmed)) {
    const sanitized = sanitizeUrlString(trimmed, true);
    return sanitized === REDACTED_PLACEHOLDER ? undefined : sanitized;
  }
  if (trimmed.includes('://') && trimmed.includes('@')) {
    return undefined;
  }
  return trimmed;
}

export function sanitizeStringValue(raw: string): string {
  if (looksLikeSecretValue(raw)) {
    return REDACTED_PLACEHOLDER;
  }
  if (URL_SCHEME_RE.test(raw.trim())) {
    return sanitizeUrlString(raw, false);
  }
  return raw;
}

function sanitizeDeepValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeStringValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeepValue(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      if (SECRET_KEY_RE.test(key)) {
        out[key] = REDACTED_PLACEHOLDER;
      } else {
        out[key] = sanitizeDeepValue(val);
      }
    }
    return out;
  }
  return value;
}

function sanitizeHeaderArg(raw: string): string {
  const colonIdx = raw.indexOf(':');
  if (colonIdx <= 0) return sanitizeStringValue(raw);
  const headerName = raw.slice(0, colonIdx).trim();
  const headerVal = raw.slice(colonIdx + 1).trim();
  if (SECRET_KEY_RE.test(headerName) || looksLikeSecretValue(headerVal)) {
    return `${headerName}: ${REDACTED_PLACEHOLDER}`;
  }
  return `${headerName}: ${sanitizeStringValue(headerVal)}`;
}

function sanitizeArgs(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  let expectSecretValue = false;
  let expectHeaderValue = false;

  for (const item of args) {
    if (typeof item !== 'string') {
      expectSecretValue = false;
      expectHeaderValue = false;
      out.push(sanitizeDeepValue(item));
      continue;
    }
    if (expectSecretValue) {
      expectSecretValue = false;
      out.push(REDACTED_PLACEHOLDER);
      continue;
    }
    if (expectHeaderValue) {
      expectHeaderValue = false;
      out.push(sanitizeHeaderArg(item));
      continue;
    }

    const eqIdx = item.indexOf('=');
    if (item.startsWith('-') && eqIdx > 1) {
      const flagName = item.slice(0, eqIdx);
      const flagVal = item.slice(eqIdx + 1);
      if (HEADER_FLAG_RE.test(flagName)) {
        out.push(`${flagName}=${sanitizeHeaderArg(flagVal)}`);
      } else if (SECRET_KEY_RE.test(flagName) || looksLikeSecretValue(flagVal)) {
        out.push(`${flagName}=${REDACTED_PLACEHOLDER}`);
      } else {
        out.push(`${flagName}=${sanitizeStringValue(flagVal)}`);
      }
      continue;
    }
    if (HEADER_FLAG_RE.test(item)) {
      expectHeaderValue = true;
      out.push(item);
      continue;
    }
    if (item.startsWith('-') && SECRET_KEY_RE.test(item)) {
      expectSecretValue = true;
      out.push(item);
      continue;
    }
    out.push(sanitizeStringValue(item));
  }
  return out;
}

export function sanitizeSettingsTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (UNSAFE_KEYS.has(key) || !ALLOWED_SETTINGS_KEYS.has(key)) continue;
    out[key] = sanitizeDeepValue(val);
  }
  return out;
}

export function sanitizeHudConfigTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (UNSAFE_KEYS.has(key) || !ALLOWED_HUD_KEYS.has(key)) continue;
    out[key] = cloneValue(val);
  }
  hydrateHudConfig(out);
  return out;
}

function sanitizeInstalledFromMeta(installedFrom: Record<string, unknown>): Record<string, unknown> | null {
  const from: Record<string, unknown> = {};
  for (const field of ['id', 'version', 'marketplace'] as const) {
    const val = installedFrom[field];
    if (typeof val === 'string' && val.trim().length > 0) {
      from[field] = sanitizeStringValue(val.trim());
    }
  }
  return Object.keys(from).length > 0 ? from : null;
}

function sanitizeConfigPlugins(rawPlugins: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(rawPlugins)) {
    if (UNSAFE_KEYS.has(name) || !isPlainObject(entry)) continue;
    const item: Record<string, unknown> = {};
    if (typeof entry.enabled === 'boolean') {
      item.enabled = entry.enabled;
    }
    const from = isPlainObject(entry.installedFrom) ? sanitizeInstalledFromMeta(entry.installedFrom) : null;
    if (from !== null) {
      item.installedFrom = from;
    }
    out[name] = item;
  }
  return out;
}

export function sanitizeConfigTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isPlainObject(raw.userSettings)) {
    const settingsCopy = cloneRecord(raw.userSettings);
    delete settingsCopy.remoteControlHostname;
    out.userSettings = sanitizeDeepValue(settingsCopy);
  }
  if (isPlainObject(raw.sidecars)) {
    const sidecarsOut: Record<string, unknown> = {};
    for (const [name, sidecarVal] of Object.entries(raw.sidecars)) {
      if (UNSAFE_KEYS.has(name) || !isPlainObject(sidecarVal)) continue;
      const sidecarCopy = cloneRecord(sidecarVal);
      delete sidecarCopy.projectId;
      sidecarsOut[name] = sanitizeDeepValue(sidecarCopy);
    }
    out.sidecars = sidecarsOut;
  }
  if (isPlainObject(raw.plugins)) {
    out.plugins = sanitizeConfigPlugins(raw.plugins);
  }
  return out;
}

function sanitizeMcpServerEntry(server: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(server)) {
    if (UNSAFE_KEYS.has(key) || !ALLOWED_MCP_SERVER_KEYS.has(key)) continue;
    if (key === 'env' || key === 'headers' || key === 'httpHeaders') {
      if (isPlainObject(val)) {
        out[key] = sanitizeDeepValue(val);
      }
    } else if (key === 'args' && Array.isArray(val)) {
      out[key] = sanitizeArgs(val);
    } else if ((key === 'url' || key === 'serverUrl' || key === 'httpUrl') && typeof val === 'string') {
      out[key] = sanitizeUrlString(val, false);
    } else {
      out[key] = sanitizeDeepValue(val);
    }
  }
  return out;
}

export function sanitizeMcpConfigTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isPlainObject(raw.mcpServers)) {
    const sanitizedServers: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(raw.mcpServers)) {
      if (UNSAFE_KEYS.has(name)) continue;
      sanitizedServers[name] = isPlainObject(entry) ? sanitizeMcpServerEntry(entry) : sanitizeDeepValue(entry);
    }
    out.mcpServers = sanitizedServers;
  }
  return out;
}
