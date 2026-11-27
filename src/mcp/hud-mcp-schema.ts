import { isPlainObject } from '../core/guards.ts';
import type { SessionSourceFilter } from '../snapshot-types.ts';
import { MCP_INSPECTOR_VERSION } from './hud-inspector-script.ts';
import { INSPECTOR_MIME_TYPE, INSPECTOR_RESOURCE_URI } from './hud-inspector-ui.ts';
import type { HudPollArgs } from './hud-mcp-snapshot.ts';

export { MCP_INSPECTOR_VERSION };
export const MAX_SESSION_ID_LENGTH: number = 128;
export const MAX_ETAG_BYTES: number = 64;

const VALID_SOURCES: ReadonlySet<string> = new Set(['auto', 'cli', 'app', 'all']);
const INSPECTOR_ALLOWED_KEYS: ReadonlySet<string> = new Set(['sessionId', 'source']);
const POLL_ALLOWED_KEYS: ReadonlySet<string> = new Set(['sessionId', 'source', 'etag']);

export const MCP_TOOLS: readonly Record<string, unknown>[] = [
  {
    name: 'hud_inspector',
    title: 'HUD Inspector',
    description: 'Open interactive HUD Inspector displaying live session telemetry and Activity Snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SESSION_ID_LENGTH,
          description: 'Optional session ID or prefix.',
        },
        source: {
          type: 'string',
          enum: ['auto', 'cli', 'app', 'all'],
          description: 'Optional session surface filter.',
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: {
        resourceUri: INSPECTOR_RESOURCE_URI,
        visibility: ['app'],
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'HUD Inspector' },
          { type: 'global', title: 'HUD Inspector' },
        ],
      },
    },
  },
  {
    name: 'hud_poll_snapshot',
    title: 'Poll HUD Snapshot',
    description: 'Poll read-only cross-surface Activity Snapshot and telemetry with ETag short-circuiting.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SESSION_ID_LENGTH,
          description: 'Optional session ID or prefix.',
        },
        source: {
          type: 'string',
          enum: ['auto', 'cli', 'app', 'all'],
          description: 'Optional session surface filter.',
        },
        etag: {
          type: 'string',
          maxLength: MAX_ETAG_BYTES,
          description: 'Previous snapshot ETag for unchanged short-circuit.',
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
];

export const MCP_RESOURCES: readonly Record<string, unknown>[] = [
  {
    uri: INSPECTOR_RESOURCE_URI,
    name: 'HUD Inspector',
    description: 'Self-contained HUD Inspector MCP App UI (Variant A - Swarm-Native Tabs).',
    mimeType: INSPECTOR_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
];

export function parsePollToolArgs(
  raw: unknown,
  allowEtag: boolean,
): { ok: true; args: HudPollArgs } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, args: {} };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Tool arguments must be an object.' };
  }
  const allowedKeys = allowEtag ? POLL_ALLOWED_KEYS : INSPECTOR_ALLOWED_KEYS;
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `Unknown argument: ${key}.` };
    }
  }
  const args: HudPollArgs = {};
  if (raw.sessionId !== undefined) {
    if (typeof raw.sessionId !== 'string' || raw.sessionId.trim().length === 0) {
      return { ok: false, error: 'sessionId must be a non-empty string.' };
    }
    const trimmed = raw.sessionId.trim();
    if (trimmed.length > MAX_SESSION_ID_LENGTH) {
      return { ok: false, error: `sessionId must be at most ${MAX_SESSION_ID_LENGTH} characters.` };
    }
    args.sessionId = trimmed;
  }
  if (raw.source !== undefined) {
    if (typeof raw.source !== 'string' || !VALID_SOURCES.has(raw.source)) {
      return { ok: false, error: 'source must be one of: auto, cli, app, all.' };
    }
    args.source = raw.source as SessionSourceFilter;
  }
  if (allowEtag && raw.etag !== undefined) {
    if (typeof raw.etag !== 'string') {
      return { ok: false, error: 'etag must be a string.' };
    }
    if (Buffer.byteLength(raw.etag, 'utf8') > MAX_ETAG_BYTES) {
      return { ok: false, error: `etag must be at most ${MAX_ETAG_BYTES} bytes.` };
    }
    args.etag = raw.etag;
  }
  return { ok: true, args };
}

export function extractErrorCorrelation(raw: unknown): { source?: SessionSourceFilter; sessionId?: string | null } {
  if (!isPlainObject(raw)) {
    return { source: 'auto', sessionId: null };
  }
  const source: SessionSourceFilter | undefined =
    raw.source === undefined
      ? 'auto'
      : typeof raw.source === 'string' && VALID_SOURCES.has(raw.source)
        ? (raw.source as SessionSourceFilter)
        : undefined;
  const sessionId: string | null | undefined =
    raw.sessionId === undefined
      ? null
      : typeof raw.sessionId === 'string' &&
          raw.sessionId.trim().length > 0 &&
          raw.sessionId.trim().length <= MAX_SESSION_ID_LENGTH
        ? raw.sessionId.trim()
        : undefined;
  return {
    ...(source !== undefined ? { source } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
