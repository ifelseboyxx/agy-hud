import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import path from 'node:path';

import { resolveSafeSkillFile, resolveTrustedCliDir } from '../core/safe-path.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';

const SKILL_HEAD_MAX_BYTES = 512;

const SKILL_PATH_RE = /^(.*?\/skills\/([^/]+))\/(?:SKILL\.md$|references\/)/;
const INVOKED_SKILL_RE = /<SKILL>The user has explicitly invoked the \(([^)\n]+)\) skill/g;
const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const FRONTMATTER_NAME_RE = /^name:\s*['"]?([^'"\n]+)['"]?\s*$/m;
const SLASH_CMD_NAME_RE = /^[a-z0-9_-]+$/;

export const RUNNING_STEP_STATUSES: ReadonlySet<string> = new Set([
  'RUNNING',
  'PENDING',
  'IN_PROGRESS',
  'GENERATING',
  'WAITING',
]);

export const BUILTIN_SLASH_CMDS: ReadonlySet<string> = new Set([
  'agent',
  'agents',
  'boost',
  'branch',
  'browser',
  'clear',
  'compact',
  'config',
  'context',
  'conversation',
  'cost',
  'credits',
  'diff',
  'effort',
  'exit',
  'feedback',
  'fork',
  'goal',
  'grill-me',
  'help',
  'hooks',
  'init',
  'keybindings',
  'learn',
  'login',
  'logout',
  'mcp',
  'model',
  'models',
  'open',
  'permissions',
  'plan',
  'plugin',
  'plugins',
  'quit',
  'quota',
  'remote-control',
  'rename',
  'resume',
  'review',
  'rewind',
  'schedule',
  'settings',
  'skills',
  'statusline',
  'swarm',
  'switch',
  'tasks',
  'teamwork',
  'undo',
  'usage',
  'vim',
]);

const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'view_file',
  'write_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'view_file_outline',
  'view_code_item',
]);

export function sanitizeFullTarget(text: string): string {
  return sanitizeTerminalLabel(text);
}

export function unwrapArg(val: unknown): string {
  if (typeof val === 'string') {
    const stripped = val.trim();
    if (stripped.length >= 2 && stripped.startsWith('"') && stripped.endsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(stripped);
        if (typeof decoded === 'string') {
          return decoded;
        }
      } catch {
        return stripped.slice(1, -1);
      }
    }
    return val;
  }
  if (val === null || val === undefined) {
    return '';
  }
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return String(val);
  }
  return JSON.stringify(val);
}

function cleanMcpServerName(raw: string): string {
  const clean = sanitizeTerminalLabel(raw);
  const idx = clean.lastIndexOf('_');
  if (idx > 0) {
    const prefix = clean.slice(0, idx);
    const suffix = clean.slice(idx + 1);
    if (prefix === suffix || prefix.endsWith(`-${suffix}`)) {
      return prefix;
    }
  }
  return clean;
}

export function listMcpServers(cliHome: string): string[] {
  const mcpDir = resolveTrustedCliDir(cliHome, 'mcp');
  if (mcpDir === null) {
    return [];
  }
  try {
    const entries = readdirSync(mcpDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

function buildMcpToolPair(rawServer: string, rawSubtool: string): [string, string] | null {
  const srv = cleanMcpServerName(rawServer);
  const sub = sanitizeTerminalLabel(rawSubtool);
  return srv.length > 0 && sub.length > 0 ? [srv, sub] : null;
}

export function parseMcpTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  mcpServers: readonly string[] = [],
): [string, string] | null {
  if ((toolName === 'call_mcp_tool' || toolName === 'list_resources' || toolName === 'read_resource') && args) {
    const rawSrv = unwrapArg(args.ServerName ?? args.server_name);
    const rawSub = sanitizeTerminalLabel(unwrapArg(args.ToolName ?? args.tool_name ?? args.Uri ?? toolName));
    return buildMcpToolPair(rawSrv, rawSub.length > 0 ? rawSub : toolName);
  }
  if (toolName.startsWith('mcp:')) {
    const parts = toolName.split(':', 3);
    if (parts.length === 3 && parts[1] && parts[2] !== undefined) {
      return buildMcpToolPair(parts[1], parts[2]);
    }
  }
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__', 3);
    if (parts.length === 3 && parts[1] && parts[2] !== undefined) {
      return buildMcpToolPair(parts[1], parts[2]);
    }
  }
  if (toolName.startsWith('mcp_')) {
    const rest = toolName.slice(4);
    for (const srv of mcpServers) {
      if (rest.startsWith(`${srv}_`) && rest.length > srv.length + 1) {
        return buildMcpToolPair(srv, rest.slice(srv.length + 1));
      }
    }
    const idx = rest.indexOf('_');
    if (idx > 0 && idx + 1 < rest.length) {
      return buildMcpToolPair(rest.slice(0, idx), rest.slice(idx + 1));
    }
  }
  return null;
}

function readFileHeadUtf8(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return bytesRead > 0 ? buf.subarray(0, bytesRead).toString('utf8') : '';
  } finally {
    closeSync(fd);
  }
}

export function resolveSkillName(pathStr: string, cliHome?: string, workspaceDir?: string): string | null {
  const match = SKILL_PATH_RE.exec(pathStr.replaceAll('\\', '/'));
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const skillDir = match[1];
  const folderName = sanitizeTerminalLabel(match[2]);
  const fallback = folderName.length > 0 ? folderName : null;
  if (cliHome === undefined) {
    return fallback;
  }
  const safeSkillFile = resolveSafeSkillFile(cliHome, path.join(skillDir, 'SKILL.md'), workspaceDir);
  if (safeSkillFile === null) {
    return fallback;
  }
  try {
    const head = readFileHeadUtf8(safeSkillFile, SKILL_HEAD_MAX_BYTES);
    if (head.startsWith('---')) {
      const endIdx = head.indexOf('\n---', 3);
      const block = endIdx !== -1 ? head.slice(0, endIdx) : head;
      const nameMatch = FRONTMATTER_NAME_RE.exec(block);
      if (nameMatch?.[1]) {
        const cleanName = sanitizeTerminalLabel(nameMatch[1]);
        if (cleanName.length > 0) {
          return cleanName;
        }
      }
    }
  } catch {
    // Fall back to skill folder name if SKILL.md cannot be read.
  }
  return fallback;
}

export function extractToolTarget(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return '';
  }
  if (FILE_TOOL_NAMES.has(name)) {
    for (const key of ['Path', 'AbsolutePath', 'TargetFile', 'path'] as const) {
      const val = unwrapArg(args[key]);
      if (val.length > 0) {
        return val;
      }
    }
  }
  if (name === 'run_command') {
    const cmd = unwrapArg(args.CommandLine ?? args.command);
    const summary = unwrapArg(args.toolSummary);
    if (cmd.includes('\n') && summary.length > 0) {
      return summary;
    }
    const firstLine = cmd.split(/\r?\n/, 1)[0] ?? '';
    return firstLine.length > 0 ? firstLine : summary;
  }
  if (name === 'search_web') {
    return unwrapArg(args.query);
  }
  if (name === 'invoke_subagent' || name === 'define_subagent') {
    return unwrapArg(args.Role ?? args.TypeName ?? args.Name);
  }
  if (name.startsWith('mcp') || name === 'call_mcp_tool' || name === 'read_resource') {
    for (const key of ['toolSummary', 'Path', 'path', 'url', 'Uri', 'query'] as const) {
      const val = unwrapArg(args[key]);
      if (val.length > 0) {
        return val;
      }
    }
  }
  return '';
}

export function extractUserInputSkills(content: string): string[] {
  const found: string[] = [];
  INVOKED_SKILL_RE.lastIndex = 0;
  let match = INVOKED_SKILL_RE.exec(content);
  while (match !== null) {
    if (match[1]) {
      const cleaned = sanitizeTerminalLabel(match[1]);
      if (cleaned.length > 0) {
        found.push(cleaned);
      }
    }
    match = INVOKED_SKILL_RE.exec(content);
  }

  const reqMatch = USER_REQ_RE.exec(content);
  const body = (reqMatch?.[1] ?? content).trim();
  if (body.startsWith('/')) {
    const cmd = (body.slice(1).split(/\s+/, 1)[0] ?? '').trim().toLowerCase();
    if (cmd.length > 0 && !BUILTIN_SLASH_CMDS.has(cmd) && SLASH_CMD_NAME_RE.test(cmd)) {
      found.push(cmd);
    }
  }
  return found;
}
