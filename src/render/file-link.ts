import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isSameOrDescendantPath } from '../core/paths.ts';
import { hasC0C1ControlChars } from '../core/terminal-text.ts';

const MAX_FILE_URI_BYTES = 4096;
const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const TRAILING_LINE_AND_COL_RE = /^(.+):(\d+):(\d+)$/;
const TRAILING_LINE_ONLY_RE = /^(.+):(\d+)$/;

export interface LocalFileUriOptions {
  readonly line?: number;
  readonly col?: number;
  readonly maxBytes?: number;
}

function isUncPath(rawPath: string): boolean {
  return rawPath.startsWith('\\\\') || rawPath.startsWith('//');
}

function hasUnsafeLinkChars(text: string): boolean {
  return hasC0C1ControlChars(text);
}

function encodeMarkdownSafePathChars(segment: string): string {
  return segment
    .replaceAll('&', '%26')
    .replaceAll(':', '%3A')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('[', '%5B')
    .replaceAll(']', '%5D')
    .replaceAll('|', '%7C')
    .replaceAll('<', '%3C')
    .replaceAll('>', '%3E')
    .replaceAll('"', '%22')
    .replaceAll("'", '%27');
}

function encodeMarkdownSafeFileUri(fileUri: string): string {
  const prefix = 'file:///';
  if (!fileUri.startsWith(prefix)) return fileUri;
  const rest = fileUri.slice(prefix.length);
  // Preserve Windows drive colon (e.g. file:///C:/...) while encoding literal POSIX colons and Markdown delimiters.
  if (/^[A-Za-z]:\//.test(rest)) {
    return `${prefix}${rest.slice(0, 3)}${encodeMarkdownSafePathChars(rest.slice(3))}`;
  }
  return `${prefix}${encodeMarkdownSafePathChars(rest)}`;
}

export function toSafeLocalFileUri(absPath: string, options: LocalFileUriOptions = {}): string | null {
  if (absPath.length === 0 || isUncPath(absPath) || hasUnsafeLinkChars(absPath)) {
    return null;
  }
  let baseUri: string;
  try {
    baseUri = pathToFileURL(absPath).href;
  } catch {
    return null;
  }
  if (!baseUri.startsWith('file:///') || baseUri.includes('#') || baseUri.includes('?')) {
    return null;
  }
  const encodedBase = encodeMarkdownSafeFileUri(baseUri);
  let finalUri = encodedBase;
  if (options.line !== undefined && Number.isInteger(options.line) && options.line >= 1) {
    finalUri =
      options.col !== undefined && Number.isInteger(options.col) && options.col >= 1
        ? `${encodedBase}#L${options.line}C${options.col}`
        : `${encodedBase}#L${options.line}`;
  }
  const maxBytes = options.maxBytes ?? MAX_FILE_URI_BYTES;
  if (Buffer.byteLength(finalUri, 'utf8') >= maxBytes) {
    return null;
  }
  return finalUri;
}

function resolveCandidateInsideWorkspace(rawPath: string, workspace: string | undefined): string | null {
  if (
    rawPath.length === 0 ||
    workspace === undefined ||
    workspace.length === 0 ||
    isUncPath(rawPath) ||
    SCHEME_PREFIX_RE.test(rawPath)
  ) {
    return null;
  }
  const resolvedWs = path.resolve(workspace);
  const isAbs = path.isAbsolute(rawPath) || WINDOWS_DRIVE_RE.test(rawPath);
  const candidate = isAbs ? path.resolve(rawPath) : path.resolve(resolvedWs, rawPath);
  return isSameOrDescendantPath(resolvedWs, candidate) ? candidate : null;
}

function tryResolveWithPosition(
  baseRaw: string,
  lineRaw: string,
  colRaw: string | undefined,
  workspace: string | undefined,
  checkExists: (absPath: string) => boolean,
): string | null {
  if (/^[A-Za-z]$/.test(baseRaw)) {
    return null;
  }
  const line = Number.parseInt(lineRaw, 10);
  if (!Number.isSafeInteger(line) || line < 1) {
    return null;
  }
  const col = colRaw !== undefined ? Number.parseInt(colRaw, 10) : undefined;
  if (col !== undefined && (!Number.isSafeInteger(col) || col < 1)) {
    return null;
  }
  const baseCandidate = resolveCandidateInsideWorkspace(baseRaw, workspace);
  if (baseCandidate === null || !checkExists(baseCandidate)) {
    return null;
  }
  return toSafeLocalFileUri(baseCandidate, { line, col });
}

export function resolveMarkdownFileTargetLink(
  rawTarget: string,
  workspace: string | undefined,
  existsRegularFile: (absPath: string) => boolean,
): string | null {
  const trimmed = rawTarget.trim();
  if (trimmed.length === 0 || hasUnsafeLinkChars(trimmed) || isUncPath(trimmed) || SCHEME_PREFIX_RE.test(trimmed)) {
    return null;
  }

  // Always check literal path FIRST so POSIX filenames like `foo:12` are preserved as `foo%3A12`.
  const literalCandidate = resolveCandidateInsideWorkspace(trimmed, workspace);
  if (literalCandidate !== null && existsRegularFile(literalCandidate)) {
    return toSafeLocalFileUri(literalCandidate);
  }

  const lineColMatch = TRAILING_LINE_AND_COL_RE.exec(trimmed);
  if (lineColMatch?.[1] && lineColMatch[2] && lineColMatch[3]) {
    const resolved = tryResolveWithPosition(
      lineColMatch[1],
      lineColMatch[2],
      lineColMatch[3],
      workspace,
      existsRegularFile,
    );
    if (resolved !== null) return resolved;
  }

  const lineOnlyMatch = TRAILING_LINE_ONLY_RE.exec(trimmed);
  if (lineOnlyMatch?.[1] && lineOnlyMatch[2]) {
    return tryResolveWithPosition(lineOnlyMatch[1], lineOnlyMatch[2], undefined, workspace, existsRegularFile);
  }
  return null;
}
