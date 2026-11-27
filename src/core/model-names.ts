import type { CliSettings, StatusLineData } from '../types.ts';
import { isPlainObject, nonEmptyStr } from './guards.ts';

const VERIFIED_MODEL_BY_ENUM: Readonly<Record<number, string>> = {
  1026: 'Claude Opus 4.6 (Thinking)',
  1035: 'Claude Sonnet 4.6 (Thinking)',
  1318: 'Gemini 3.8 Flash (High)',
  1319: 'Gemini 3.8 Flash (Medium)',
  1320: 'Gemini 3.8 Flash (Low)',
  1417: 'Gemini 4 Argon (High)',
  1418: 'Gemini 4 Argon (Medium)',
  1427: 'Gemini 4 Carbon (High)',
  1437: 'Gemini 4 Carbon (Medium)',
  1525: 'Gemini 4 Hydrogen (High)',
  1526: 'Gemini 4 Hydrogen (Medium)',
  1528: 'Gemini 4 Hydrogen (XHigh)',
  1530: 'Gemini 4 Hydrogen (High)',
  1531: 'Gemini 4 Hydrogen (XHigh)',
  1532: 'Gemini 4 Neon (High)',
  1535: 'Gemini 4 Neon (XHigh)',
  1667: 'Orchestrator (Carbon)',
  1669: 'Gemini 4 Hydrogen (Orchestrator)',
};

const VERIFIED_MODEL_BY_PLACEHOLDER: Readonly<Record<string, string>> = {
  MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6 (Thinking)',
  MODEL_PLACEHOLDER_M35: 'Claude Sonnet 4.6 (Thinking)',
  MODEL_PLACEHOLDER_M318: 'Gemini 3.8 Flash (High)',
  MODEL_PLACEHOLDER_M319: 'Gemini 3.8 Flash (Medium)',
  MODEL_PLACEHOLDER_M320: 'Gemini 3.8 Flash (Low)',
  MODEL_PLACEHOLDER_M417: 'Gemini 4 Argon (High)',
  MODEL_PLACEHOLDER_M418: 'Gemini 4 Argon (Medium)',
  MODEL_PLACEHOLDER_M427: 'Gemini 4 Carbon (High)',
  MODEL_PLACEHOLDER_M437: 'Gemini 4 Carbon (Medium)',
  MODEL_PLACEHOLDER_M525: 'Gemini 4 Hydrogen (High)',
  MODEL_PLACEHOLDER_M526: 'Gemini 4 Hydrogen (Medium)',
  MODEL_PLACEHOLDER_M528: 'Gemini 4 Hydrogen (XHigh)',
  MODEL_PLACEHOLDER_M530: 'Gemini 4 Hydrogen (High)',
  MODEL_PLACEHOLDER_M531: 'Gemini 4 Hydrogen (XHigh)',
  MODEL_PLACEHOLDER_M532: 'Gemini 4 Neon (High)',
  MODEL_PLACEHOLDER_M535: 'Gemini 4 Neon (XHigh)',
  MODEL_PLACEHOLDER_M667: 'Orchestrator (Carbon)',
  MODEL_PLACEHOLDER_M669: 'Gemini 4 Hydrogen (Orchestrator)',
};

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

const GEMINI4_SLUG_RE = /^gemini-4-([a-z]+)(?:-tiered-(low|medium|high|xhigh|max))?$/i;
const GEMINI38_FLASH_RE = /^gemini-3[.-]8-flash(?:-.+)?$/i;
const CLAUDE_SLUG_RE = /^claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)(?:-(thinking))?$/i;
const GPT_OSS_RE = /^gpt-oss-120b(?:-(low|medium|high|xhigh|max))?$/i;

export const LEGACY_ORCHESTRATOR_ENUMS: ReadonlySet<number> = new Set([1667, 1669]);

function capitalizeWord(word: string): string {
  return word.length > 0 ? `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}` : '';
}

export function resolveKnownModelPlaceholder(modelEnumStr?: string, modelEnumNum?: number): string | null {
  const key = nonEmptyStr(modelEnumStr)?.toUpperCase();
  if (key !== undefined && Object.hasOwn(VERIFIED_MODEL_BY_PLACEHOLDER, key)) {
    return VERIFIED_MODEL_BY_PLACEHOLDER[key] ?? null;
  }
  if (
    typeof modelEnumNum === 'number' &&
    Number.isInteger(modelEnumNum) &&
    Object.hasOwn(VERIFIED_MODEL_BY_ENUM, modelEnumNum)
  ) {
    return VERIFIED_MODEL_BY_ENUM[modelEnumNum] ?? null;
  }
  return null;
}

export function normalizeResponseModelSlug(rawSlug: string | undefined): string | null {
  const slug = nonEmptyStr(rawSlug);
  if (slug === undefined) return null;

  const g4 = GEMINI4_SLUG_RE.exec(slug);
  if (g4?.[1]) {
    const element = capitalizeWord(g4[1]);
    const effort = g4[2] ? EFFORT_LABELS[g4[2].toLowerCase()] : undefined;
    return effort !== undefined ? `Gemini 4 ${element} (${effort})` : `Gemini 4 ${element}`;
  }

  if (GEMINI38_FLASH_RE.test(slug)) {
    return 'Gemini 3.8 Flash';
  }

  const claude = CLAUDE_SLUG_RE.exec(slug);
  if (claude?.[1] && claude[2] && claude[3]) {
    const family = capitalizeWord(claude[1]);
    const suffix = claude[4] ? ' (Thinking)' : '';
    return `Claude ${family} ${claude[2]}.${claude[3]}${suffix}`;
  }

  const gptOss = GPT_OSS_RE.exec(slug);
  if (gptOss) {
    const effort = gptOss[1] ? EFFORT_LABELS[gptOss[1].toLowerCase()] : undefined;
    return effort !== undefined ? `GPT-OSS 120B (${effort})` : 'GPT-OSS 120B';
  }

  return null;
}

export interface GenModelNameFields {
  readonly displayName?: string;
  readonly modelEnumStr?: string;
  readonly modelEnum?: number;
  readonly responseModel?: string;
}

export function resolveGenModelDisplayName(fields: GenModelNameFields): string {
  const direct = nonEmptyStr(fields.displayName);
  if (direct !== undefined) return direct;
  const known = resolveKnownModelPlaceholder(fields.modelEnumStr, fields.modelEnum);
  if (known !== null) return known;
  const slug = normalizeResponseModelSlug(fields.responseModel);
  if (slug !== null) return slug;
  const rawEnum = nonEmptyStr(fields.modelEnumStr);
  if (rawEnum !== undefined) return rawEnum;
  if (typeof fields.modelEnum === 'number' && Number.isInteger(fields.modelEnum) && fields.modelEnum > 0) {
    return String(fields.modelEnum);
  }
  return '';
}

const EFFORT_SUFFIX_RE = /\s*\((low|medium|high|xhigh|max)\)\s*$/i;
const ID_EFFORT_SUFFIX_RE = /(?:^|[-_])(low|medium|high|xhigh|max)$/i;
const ORCHESTRATOR_PREFIX = 'Orchestrator';
const ORCHESTRATOR_PAREN_RE = /^Orchestrator\s*\((.+)\)\s*$/i;

const MODEL_PEAK_EFFORT_RULES: ReadonlyArray<readonly [RegExp, 'high' | 'xhigh']> = [
  [/(?:^|[^a-z0-9])(?:neon|hydrogen)(?:$|[^a-z0-9])/i, 'xhigh'],
  [/(?:^|[^a-z0-9])(?:carbon|argon|flash|opus|sonnet|haiku)(?:$|[^a-z0-9])/i, 'high'],
];

const EFFORT_TIER_RANK: Readonly<Record<string, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

export function resolveModelPeakEffort(modelNameOrId: string): 'high' | 'xhigh' | null {
  const text = modelNameOrId.trim();
  if (text.length === 0) return null;
  const resolved = resolveKnownModelPlaceholder(text) ?? normalizeResponseModelSlug(text) ?? text;
  for (const [pattern, peak] of MODEL_PEAK_EFFORT_RULES) {
    if (pattern.test(resolved) || (resolved !== text && pattern.test(text))) return peak;
  }
  return null;
}

export function isPeakEffortForModel(modelNameOrId: string, effort: string): boolean {
  const tier = effort.trim().toLowerCase();
  if (tier === 'max' || tier === 'xhigh') return true;
  const rank = EFFORT_TIER_RANK[tier];
  if (rank === undefined) return false;
  const peak = resolveModelPeakEffort(modelNameOrId);
  if (peak === null) return false;
  return rank >= (EFFORT_TIER_RANK[peak] ?? 4);
}

export function resolveEffortPeakFlags(modelName: string, effortParts: readonly string[]): boolean[] {
  if (effortParts.length === 0) return [];
  const orchMatch = ORCHESTRATOR_PAREN_RE.exec(modelName.trim());
  const roleNames =
    orchMatch?.[1] !== undefined
      ? orchMatch[1]
          .split('/')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [modelName];

  if (effortParts.length === 1) {
    const tier = effortParts[0] ?? '';
    if (roleNames.length === 0) return [isPeakEffortForModel(modelName, tier)];
    return [roleNames.every((role) => isPeakEffortForModel(role, tier))];
  }
  return effortParts.map((part, idx) => isPeakEffortForModel(roleNames[idx] ?? roleNames[0] ?? modelName, part));
}

const MODEL_PREFIX_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['Claude Opus ', 'Opus '],
  ['Claude Sonnet ', 'Sonnet '],
  ['Claude Haiku ', 'Haiku '],
  ['Gemini 4 ', 'G4 '],
  ['Gemini 3.8 ', 'G3.8 '],
];

const ORCH_ROLE_PREFIX_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['Gemini 4 ', ''],
  ['Gemini 3.8 ', 'G3.8 '],
  ['Claude Opus ', 'Opus '],
  ['Claude Sonnet ', 'Sonnet '],
  ['Claude Haiku ', 'Haiku '],
];

export interface ResolvedModelDisplay {
  name: string;
  effort: string;
  peakFlags?: readonly boolean[];
}

function shortenOrchRole(rawRole: unknown): readonly [string, string] {
  let name = typeof rawRole === 'string' ? rawRole.trim() : '';
  if (name.length === 0) return ['', ''];
  let effort = '';
  const match = EFFORT_SUFFIX_RE.exec(name);
  if (match?.[1]) {
    effort = match[1].toLowerCase();
    name = name.replace(EFFORT_SUFFIX_RE, '').trim();
  }
  for (const [prefix, short] of ORCH_ROLE_PREFIX_ALIASES) {
    if (name.startsWith(prefix)) {
      name = short + name.slice(prefix.length);
      break;
    }
  }
  return [name, effort];
}

export function resolveOrchestratorDisplay(
  rawName: string,
  rawEffort: string,
  cliSettings?: CliSettings,
): ResolvedModelDisplay | null {
  if (rawName !== ORCHESTRATOR_PREFIX && !rawName.startsWith(`${ORCHESTRATOR_PREFIX} (`)) return null;
  const orch = cliSettings?.orchestrator;
  if (!isPlainObject(orch)) return null;

  let [plannerName, plannerEff] = shortenOrchRole(orch.planner);
  const [executorName, executorEff] = shortenOrchRole(orch.executor);
  if (plannerName.length === 0 && executorName.length === 0) return null;
  if (plannerName.length === 0) {
    const parenMatch = ORCHESTRATOR_PAREN_RE.exec(rawName);
    plannerName = parenMatch?.[1] ? parenMatch[1].trim() : '';
  }

  const roles = [plannerName, executorName].filter((r) => r.length > 0);
  const name = roles.length > 0 ? `${ORCHESTRATOR_PREFIX} (${roles.join('/')})` : ORCHESTRATOR_PREFIX;

  const trimmedRawEffort = rawEffort.trim().toLowerCase();
  if (trimmedRawEffort.length > 0) {
    const rawParts = trimmedRawEffort.split('/');
    return {
      name,
      effort: trimmedRawEffort,
      peakFlags: resolveEffortPeakFlags(name, rawParts),
    };
  }

  const roleEffortPairs: Array<{ readonly role: string; readonly eff: string }> = [];
  if (plannerEff.length > 0) roleEffortPairs.push({ role: plannerName || name, eff: plannerEff });
  if (executorEff.length > 0) roleEffortPairs.push({ role: executorName || name, eff: executorEff });
  if (roleEffortPairs.length === 0) return { name, effort: '' };

  if (roleEffortPairs.length === 2) {
    const first = roleEffortPairs[0]!;
    const second = roleEffortPairs[1]!;
    const firstPeak = isPeakEffortForModel(first.role, first.eff);
    const secondPeak = isPeakEffortForModel(second.role, second.eff);
    // Only fold identical effort strings when both roles share the same peak status (e.g. Carbon/Argon high -> high,
    // while Neon high / Carbon high keeps high/high so Carbon's peak thinking stays highlighted).
    if (first.eff === second.eff && firstPeak === secondPeak) {
      return { name, effort: first.eff, peakFlags: [firstPeak] };
    }
    return { name, effort: `${first.eff}/${second.eff}`, peakFlags: [firstPeak, secondPeak] };
  }

  const only = roleEffortPairs[0]!;
  return { name, effort: only.eff, peakFlags: [isPeakEffortForModel(only.role, only.eff)] };
}

function extractEffortFromModelId(rawId: string): string {
  if (rawId.length === 0) return '';
  const resolved = resolveKnownModelPlaceholder(rawId) ?? normalizeResponseModelSlug(rawId);
  if (resolved !== null) {
    const parenMatch = EFFORT_SUFFIX_RE.exec(resolved);
    if (parenMatch?.[1]) return parenMatch[1].toLowerCase();
  }
  const suffixMatch = ID_EFFORT_SUFFIX_RE.exec(rawId);
  return suffixMatch?.[1] ? suffixMatch[1].toLowerCase() : '';
}

export function parseModelAndEffort(data: StatusLineData, cliSettings?: CliSettings): ResolvedModelDisplay {
  const modelObj = data.model;
  const rawDisplay = nonEmptyStr(modelObj?.display_name) ?? '';
  const rawId = nonEmptyStr(modelObj?.id) ?? '';
  let rawName =
    rawDisplay.length > 0
      ? rawDisplay
      : rawId.length > 0
        ? (resolveKnownModelPlaceholder(rawId) ?? normalizeResponseModelSlug(rawId) ?? rawId)
        : '';
  let effort = nonEmptyStr(modelObj?.effort) ?? '';

  const orch = resolveOrchestratorDisplay(rawName, effort, cliSettings);
  if (orch !== null) return orch;

  const match = EFFORT_SUFFIX_RE.exec(rawName);
  if (match?.[1]) {
    if (effort.length === 0) effort = match[1].toLowerCase();
    rawName = rawName.replace(EFFORT_SUFFIX_RE, '').trim();
  }
  if (effort.length === 0 && rawId.length > 0) {
    effort = extractEffortFromModelId(rawId);
  }

  for (const [prefix, short] of MODEL_PREFIX_ALIASES) {
    if (rawName.startsWith(prefix)) {
      rawName = short + rawName.slice(prefix.length);
      break;
    }
  }

  const finalName = rawName.length > 0 ? rawName : 'agy';
  const finalEffort = effort.toLowerCase();
  if (finalEffort.length === 0) {
    return { name: finalName, effort: '' };
  }
  const effortParts = finalEffort.split('/');
  const baseFlags = resolveEffortPeakFlags(finalName, effortParts);
  const peakFlags =
    rawId.length > 0 && effortParts.length === 1
      ? [baseFlags[0] === true || isPeakEffortForModel(rawId, effortParts[0] ?? '')]
      : baseFlags;
  return {
    name: finalName,
    effort: finalEffort,
    peakFlags,
  };
}
