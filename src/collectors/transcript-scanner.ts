import type { Hash } from 'node:crypto';
import { closeSync, fstatSync, openSync } from 'node:fs';

import { isFiniteNum, isPlainObject, nonEmptyStr, parseIsoTimestampSec } from '../core/guards.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import { readFdRange } from '../fs-utils.ts';
import type { ActivityAgentEntry } from '../types.ts';
import {
  extractToolTarget,
  extractUserInputSkills,
  parseMcpTool,
  resolveSkillName,
  RUNNING_STEP_STATUSES,
  sanitizeFullTarget,
  unwrapArg,
} from './activity-parse.ts';
import {
  computeFdRangeFingerprint,
  computeFileContentHash,
  computeFullFdRangeHash,
  computeFullParsedRangeHash,
  computeParsedRangeFingerprint,
  FULL_HASH_MAX_BYTES,
} from './transcript-fingerprint.ts';

export { computeFileContentHash };

export interface TranscriptCacheMeta {
  path: string;
  ino: number;
  mtimeMs: number;
  mtimeNs: string;
  ctimeNs: string;
  size: number;
  contentHash: string;
  stableOffset: number;
  stablePrefixHash: string;
  stableToolsCount: number;
  stableSkillsCount: number;
  stableMcpsCount: number;
  stableAgentsCount: number;
  stableLastModel: string;
}

export interface ScannedToolCall {
  name: string;
  disp: string;
  fullTarget: string;
  targetLinkable: boolean;
  running: boolean;
  isSkillRead: boolean;
  mcpServer: string | null;
  mcpSubtool: string | null;
}

export interface TranscriptScanSeed<TTool> {
  meta: TranscriptCacheMeta;
  tools: readonly TTool[];
  skills: readonly string[];
  mcps: readonly string[];
  agents: readonly ActivityAgentEntry[];
  lastModel: string;
}

export interface TranscriptScanOptions<TTool> {
  transcriptPath: string;
  skillRootDir: string;
  workspaceDir: string | undefined;
  mcpServers: readonly string[];
  seed?: TranscriptScanSeed<TTool> | null;
  projectToolCall: (call: ScannedToolCall) => TTool;
  onAfterChunkRead?: () => void;
}

export interface TranscriptScanOutcome<TTool> {
  cacheHit: boolean;
  cacheable: boolean;
  meta: TranscriptCacheMeta;
  tools: TTool[];
  skills: string[];
  mcps: string[];
  agents: ActivityAgentEntry[];
  lastModel: string;
}

function appendUniqueItem(seq: string[], seen: Set<string>, value: string): void {
  if (value.length > 0 && !seen.has(value)) {
    seen.add(value);
    seq.push(value);
  }
}

export function parseTranscriptCacheMeta(raw: Record<string, unknown>): TranscriptCacheMeta | null {
  if (
    typeof raw.path !== 'string' ||
    !isFiniteNum(raw.ino) ||
    !isFiniteNum(raw.mtimeMs) ||
    typeof raw.mtimeNs !== 'string' ||
    raw.mtimeNs.length === 0 ||
    typeof raw.ctimeNs !== 'string' ||
    raw.ctimeNs.length === 0 ||
    !isFiniteNum(raw.size) ||
    typeof raw.contentHash !== 'string' ||
    raw.contentHash.length === 0 ||
    !isFiniteNum(raw.stableOffset) ||
    typeof raw.stablePrefixHash !== 'string' ||
    raw.stablePrefixHash.length === 0 ||
    !isFiniteNum(raw.stableToolsCount) ||
    !isFiniteNum(raw.stableSkillsCount) ||
    !isFiniteNum(raw.stableMcpsCount) ||
    !isFiniteNum(raw.stableAgentsCount) ||
    typeof raw.stableLastModel !== 'string'
  ) {
    return null;
  }
  return {
    path: raw.path,
    ino: raw.ino,
    mtimeMs: raw.mtimeMs,
    mtimeNs: raw.mtimeNs,
    ctimeNs: raw.ctimeNs,
    size: raw.size,
    contentHash: raw.contentHash,
    stableOffset: raw.stableOffset,
    stablePrefixHash: raw.stablePrefixHash,
    stableToolsCount: raw.stableToolsCount,
    stableSkillsCount: raw.stableSkillsCount,
    stableMcpsCount: raw.stableMcpsCount,
    stableAgentsCount: raw.stableAgentsCount,
    stableLastModel: raw.stableLastModel,
  };
}

function matchReusablePrefix<TTool>(
  fd: number,
  transcriptPath: string,
  ino: number,
  size: number,
  seed: TranscriptScanSeed<TTool>,
): { seed: TranscriptScanSeed<TTool>; prefixHash: Hash | null } | null {
  const { meta } = seed;
  if (meta.path !== transcriptPath || meta.ino !== ino) return null;
  if (meta.stableOffset <= 0 || meta.stableOffset > size) return null;
  if (
    meta.stableToolsCount < 0 ||
    meta.stableToolsCount > seed.tools.length ||
    meta.stableSkillsCount < 0 ||
    meta.stableSkillsCount > seed.skills.length ||
    meta.stableMcpsCount < 0 ||
    meta.stableMcpsCount > seed.mcps.length ||
    meta.stableAgentsCount < 0 ||
    meta.stableAgentsCount > seed.agents.length
  ) {
    return null;
  }
  if (size === meta.size) return null;
  const { digest, fullHash } = computeFullFdRangeHash(fd, meta.stableOffset);
  return digest === meta.stablePrefixHash ? { seed, prefixHash: fullHash } : null;
}

interface ParsedStepContext<TTool> {
  readonly skillRootDir: string;
  readonly workspaceDir: string | undefined;
  readonly mcpServers: readonly string[];
  readonly projectToolCall: (call: ScannedToolCall) => TTool;
  readonly tools: TTool[];
  readonly skills: string[];
  readonly skillsSeen: Set<string>;
  readonly mcps: string[];
  readonly mcpsSeen: Set<string>;
  readonly agents: ActivityAgentEntry[];
}

function recordScannedToolCall<TTool>(
  tc: unknown,
  ctx: ParsedStepContext<TTool>,
  isRunning: boolean,
  stepTs: number | null,
): void {
  if (!isPlainObject(tc)) return;
  const name = typeof tc.name === 'string' ? sanitizeTerminalLabel(tc.name) : '';
  if (name.length === 0) return;

  const args = isPlainObject(tc.args) ? tc.args : isPlainObject(tc.arguments) ? tc.arguments : undefined;
  const rawTarget = extractToolTarget(name, args);
  const fullTarget = sanitizeFullTarget(rawTarget);
  const targetLinkable = fullTarget.length > 0 && rawTarget === fullTarget;

  const skillName =
    (name === 'read_file' || name === 'view_file') && fullTarget.length > 0
      ? resolveSkillName(fullTarget, ctx.skillRootDir, ctx.workspaceDir)
      : null;
  if (skillName !== null) {
    appendUniqueItem(ctx.skills, ctx.skillsSeen, skillName);
  }

  const mcpInfo = parseMcpTool(name, args, ctx.mcpServers);
  if (mcpInfo !== null) {
    appendUniqueItem(ctx.mcps, ctx.mcpsSeen, mcpInfo[0]);
  }

  if (name === 'invoke_subagent' && args) {
    const cleanRole = sanitizeTerminalLabel(unwrapArg(args.Role));
    const cleanType = sanitizeTerminalLabel(unwrapArg(args.TypeName));
    const cleanModel = sanitizeTerminalLabel(unwrapArg(args.Model));
    const role = nonEmptyStr(cleanRole) ?? nonEmptyStr(cleanType) ?? 'subagent';
    ctx.agents.push({
      name: role,
      type: cleanType,
      model: cleanModel === 'inherit' ? '' : cleanModel,
      running: isRunning,
      ts: stepTs,
    });
  }

  ctx.tools.push(
    ctx.projectToolCall({
      name,
      disp: mcpInfo !== null ? `${mcpInfo[0]}:${mcpInfo[1]}` : name,
      fullTarget,
      targetLinkable,
      running: isRunning,
      isSkillRead: skillName !== null,
      mcpServer: mcpInfo !== null ? mcpInfo[0] : null,
      mcpSubtool: mcpInfo !== null ? mcpInfo[1] : null,
    }),
  );
}

export function scanTranscriptWithCache<TTool>(
  options: TranscriptScanOptions<TTool>,
): TranscriptScanOutcome<TTool> | null {
  const { transcriptPath, seed } = options;
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }

  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;

    const ino = Number(st.ino);
    const size = Number(st.size);
    const mtimeMs = Number(st.mtimeMs);
    const mtimeNs = st.mtimeNs.toString();
    const ctimeNs = st.ctimeNs.toString();

    if (
      seed !== undefined &&
      seed !== null &&
      seed.meta.path === transcriptPath &&
      seed.meta.ino === ino &&
      seed.meta.size === size &&
      seed.meta.mtimeNs === mtimeNs &&
      seed.meta.ctimeNs === ctimeNs
    ) {
      const currentDigest = computeFdRangeFingerprint(fd, size).digest;
      if (currentDigest === seed.meta.contentHash) {
        return {
          cacheHit: true,
          cacheable: false,
          meta: seed.meta,
          tools: [...seed.tools],
          skills: [...seed.skills],
          mcps: [...seed.mcps],
          agents: [...seed.agents],
          lastModel: seed.lastModel,
        };
      }
    }

    const reusable =
      seed !== undefined && seed !== null ? matchReusablePrefix(fd, transcriptPath, ino, size, seed) : null;
    const resumeSeed = reusable?.seed ?? null;
    const prefixHash = reusable?.prefixHash ?? null;

    const startOffset = resumeSeed !== null ? resumeSeed.meta.stableOffset : 0;
    const tools: TTool[] = resumeSeed !== null ? resumeSeed.tools.slice(0, resumeSeed.meta.stableToolsCount) : [];
    const skills: string[] = resumeSeed !== null ? resumeSeed.skills.slice(0, resumeSeed.meta.stableSkillsCount) : [];
    const skillsSeen = new Set<string>(skills);
    const mcps: string[] = resumeSeed !== null ? resumeSeed.mcps.slice(0, resumeSeed.meta.stableMcpsCount) : [];
    const mcpsSeen = new Set<string>(mcps);
    const agents: ActivityAgentEntry[] =
      resumeSeed !== null ? resumeSeed.agents.slice(0, resumeSeed.meta.stableAgentsCount) : [];
    let lastModel = resumeSeed !== null ? resumeSeed.meta.stableLastModel : '';

    const ctx: ParsedStepContext<TTool> = {
      skillRootDir: options.skillRootDir,
      workspaceDir: options.workspaceDir,
      mcpServers: options.mcpServers,
      projectToolCall: options.projectToolCall,
      tools,
      skills,
      skillsSeen,
      mcps,
      mcpsSeen,
      agents,
    };

    let stableOffset = startOffset;
    let stableToolsCount = tools.length;
    let stableSkillsCount = skills.length;
    let stableMcpsCount = mcps.length;
    let stableAgentsCount = agents.length;
    let stableLastModel = lastModel;
    let sawRunningStep = false;

    const markStable = (offset: number): void => {
      stableOffset = offset;
      stableToolsCount = tools.length;
      stableSkillsCount = skills.length;
      stableMcpsCount = mcps.length;
      stableAgentsCount = agents.length;
      stableLastModel = lastModel;
    };

    const chunkBuf = readFdRange(fd, startOffset, size - startOffset);
    options.onAfterChunkRead?.();
    let cursor = 0;

    while (cursor < chunkBuf.length) {
      const nlIdx = chunkBuf.indexOf(0x0a, cursor);
      if (nlIdx === -1) break;
      const lineStart = startOffset + cursor;
      const lineEnd = startOffset + nlIdx + 1;
      const rawLine = chunkBuf.subarray(cursor, nlIdx).toString('utf8').trim();
      cursor = nlIdx + 1;

      if (rawLine.length === 0) {
        if (!sawRunningStep) stableOffset = lineEnd;
        continue;
      }

      let step: unknown;
      try {
        step = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (!isPlainObject(step)) continue;

      if (step.type === 'USER_INPUT') {
        const rawContent = typeof step.content === 'string' ? step.content : '';
        for (const sk of extractUserInputSkills(rawContent)) {
          appendUniqueItem(skills, skillsSeen, sk);
        }
        if (!sawRunningStep) markStable(lineEnd);
        continue;
      }

      if (step.type !== 'PLANNER_RESPONSE') {
        if (!sawRunningStep) markStable(lineEnd);
        continue;
      }

      const status = typeof step.status === 'string' ? step.status.toUpperCase() : '';
      const isRunning = RUNNING_STEP_STATUSES.has(status);
      if (isRunning && !sawRunningStep) {
        sawRunningStep = true;
        markStable(lineStart);
      }

      if (typeof step.model === 'string') {
        const cleanModel = sanitizeTerminalLabel(step.model);
        if (cleanModel.length > 0) {
          lastModel = cleanModel;
        }
      }

      const stepTs = parseIsoTimestampSec(step.created_at);
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (const tc of toolCalls) {
        recordScannedToolCall(tc, ctx, isRunning, stepTs);
      }

      if (!sawRunningStep) markStable(lineEnd);
    }

    const parsedSize = startOffset + chunkBuf.length;
    const contentHash = computeParsedRangeFingerprint(fd, startOffset, chunkBuf, parsedSize, prefixHash);
    const stablePrefixHash =
      stableOffset === parsedSize && parsedSize <= FULL_HASH_MAX_BYTES
        ? contentHash
        : stableOffset === startOffset && resumeSeed !== null
          ? resumeSeed.meta.stablePrefixHash
          : computeFullParsedRangeHash(fd, startOffset, chunkBuf, stableOffset, prefixHash);
    const stAfter = fstatSync(fd, { bigint: true });
    const cacheable =
      chunkBuf.length === size - startOffset &&
      stAfter.ino === st.ino &&
      stAfter.size === st.size &&
      stAfter.mtimeNs === st.mtimeNs &&
      stAfter.ctimeNs === st.ctimeNs;
    return {
      cacheHit: false,
      cacheable,
      meta: {
        path: transcriptPath,
        ino,
        mtimeMs,
        mtimeNs,
        ctimeNs,
        size: parsedSize,
        contentHash,
        stableOffset,
        stablePrefixHash,
        stableToolsCount,
        stableSkillsCount,
        stableMcpsCount,
        stableAgentsCount,
        stableLastModel,
      },
      tools,
      skills,
      mcps,
      agents,
      lastModel,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
