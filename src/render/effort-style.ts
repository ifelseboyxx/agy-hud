import { nonEmptyStr } from '../core/guards.ts';
import { resolveEffortPeakFlags } from '../core/model-names.ts';
import { normalizeHostAgentState } from '../core/quota-pace.ts';
import { sanitizeTerminalLabel } from '../core/terminal-text.ts';
import type { StatusLineData } from '../types.ts';
import { BOLD, BRIGHT_CYAN, BRIGHT_WHITE, BRIGHT_YELLOW, CYAN, GRAY, NO_BOLD, RESET, WHITE, YELLOW } from './ansi.ts';

export type ColorLevel = 'none' | 'ansi16' | 'truecolor';

type Rgb = readonly [number, number, number];

interface PeakTone {
  readonly glyphBase: Rgb;
  readonly textBase: Rgb;
  readonly sheenPeak: Rgb;
  readonly ansi16Glyph: string;
  readonly ansi16Base: string;
}

const SHIMMER_FRAME_MS = 300;
const SHEEN_REST_FRAMES = 4;
const SHEEN_SIGMA = 1.05;
const SHEEN_BOLD_THRESHOLD = 0.48;
const WORK_GLYPHS = ['◔', '◑', '◕', '●'] as const;

const TRUECOLOR_TERM_PROGRAMS: ReadonlySet<string> = new Set([
  'iTerm.app',
  'WezTerm',
  'ghostty',
  'vscode',
  'Hyper',
  'Alacritty',
  'kitty',
]);

// Seamless monochrome platinum ice sheen: idle, rest beat, and active sweep share the exact same
// calm brushed-silver base tone and regular weight so the glint enters and exits with zero brightness jump.
const PLATINUM_PEAK_TONE: PeakTone = {
  glyphBase: [148, 188, 228],
  textBase: [172, 184, 200],
  sheenPeak: [250, 253, 255],
  ansi16Glyph: BRIGHT_CYAN,
  ansi16Base: WHITE,
};

// Warm champagne platinum sheen reserved for explicit `max` tier.
const MAX_PEAK_TONE: PeakTone = {
  glyphBase: [216, 188, 134],
  textBase: [198, 186, 166],
  sheenPeak: [255, 251, 240],
  ansi16Glyph: BRIGHT_YELLOW,
  ansi16Base: YELLOW,
};

const TIER_RANK: Readonly<Record<string, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

const ACTIVE_SHIMMER_STATES: ReadonlySet<string> = new Set(['initializing', 'working', 'tool_use']);

export interface ModelSegmentStyleOptions {
  readonly colorLevel: ColorLevel;
  readonly active: boolean;
  readonly nowSec: number;
  readonly peakFlags?: readonly boolean[];
}

export function detectColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  if (env.NO_COLOR !== undefined) {
    return 'none';
  }
  const term = nonEmptyStr(env.TERM)?.toLowerCase() ?? '';
  if (term === 'dumb') {
    return 'none';
  }
  const colorTerm = nonEmptyStr(env.COLORTERM)?.toLowerCase() ?? '';
  if (colorTerm === 'truecolor' || colorTerm === '24bit') {
    return 'truecolor';
  }
  if (term.includes('direct')) {
    return 'truecolor';
  }
  if (nonEmptyStr(env.WT_SESSION) !== undefined) {
    return 'truecolor';
  }
  const termProgram = nonEmptyStr(env.TERM_PROGRAM) ?? '';
  if (TRUECOLOR_TERM_PROGRAMS.has(termProgram)) {
    return 'truecolor';
  }
  return 'ansi16';
}

export function isActiveShimmerState(agentState: StatusLineData['agent_state']): boolean {
  const normalized = normalizeHostAgentState(agentState);
  return normalized !== null && ACTIVE_SHIMMER_STATES.has(normalized);
}

function rgbEscape([r, g, b]: Rgb): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function lerpRgb(base: Rgb, peak: Rgb, t: number): Rgb {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(base[0] + (peak[0] - base[0]) * clamped),
    Math.round(base[1] + (peak[1] - base[1]) * clamped),
    Math.round(base[2] + (peak[2] - base[2]) * clamped),
  ];
}

function resolveTierGlyph(tier: string, isPeak: boolean): string {
  if (tier === 'max') return '✦';
  if (isPeak || tier === 'xhigh') return '●';
  if (tier === 'low') return '◔';
  if (tier === 'medium') return '◑';
  if (tier === 'high') return '◕';
  return '◑';
}

function resolveTopEffortTier(parts: readonly string[]): string {
  let best = parts[0] ?? '';
  let bestRank = TIER_RANK[best] ?? 2;
  for (let i = 1; i < parts.length; i += 1) {
    const candidate = parts[i] ?? '';
    const rank = TIER_RANK[candidate] ?? 2;
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

function resolveBeamPosition(frame: number, activeGlyphCount: number, colorLevel: ColorLevel): number | null {
  if (activeGlyphCount <= 0) return null;
  if (colorLevel === 'ansi16') {
    // Sweep tightly over visible peak character indices [0 .. activeGlyphCount - 1] with zero dark dead frames.
    const cycleLen = activeGlyphCount + SHEEN_REST_FRAMES;
    const phase = ((frame % cycleLen) + cycleLen) % cycleLen;
    return phase < activeGlyphCount ? phase : null;
  }
  // TrueColor Gaussian sweep enters cleanly on index 0 and exits smoothly past activeGlyphCount - 1 before resting.
  const sweepFrames = activeGlyphCount + 2;
  const cycleLen = sweepFrames + SHEEN_REST_FRAMES;
  const phase = ((frame % cycleLen) + cycleLen) % cycleLen;
  if (phase >= sweepFrames) {
    return null;
  }
  return -0.5 + phase;
}

function renderPeakSpan(
  text: string,
  startPos: number,
  beamPos: number | null,
  tone: PeakTone,
  colorLevel: ColorLevel,
  isGlyph: boolean,
): string {
  if (colorLevel === 'none') {
    return text;
  }
  const baseRgb = isGlyph ? tone.glyphBase : tone.textBase;
  const ansiBase = isGlyph ? tone.ansi16Glyph : tone.ansi16Base;
  if (beamPos === null) {
    return colorLevel === 'truecolor' ? `${rgbEscape(baseRgb)}${text}${RESET}` : `${ansiBase}${text}${RESET}`;
  }

  let out = '';
  let pos = startPos;
  let prevBold = false;
  let prevColor = '';
  for (const ch of text) {
    const dist = pos - beamPos;
    let nextBold = false;
    let nextColor = ansiBase;
    if (colorLevel === 'truecolor') {
      const intensity = Math.exp(-(dist * dist) / (2 * SHEEN_SIGMA * SHEEN_SIGMA));
      const rgb = lerpRgb(baseRgb, tone.sheenPeak, intensity);
      nextBold = intensity >= SHEEN_BOLD_THRESHOLD;
      nextColor = rgbEscape(rgb);
    } else if (Math.abs(dist) <= 0.5) {
      nextBold = true;
      nextColor = BRIGHT_WHITE;
    }

    if (nextBold !== prevBold) {
      out += nextBold ? BOLD : NO_BOLD;
      prevBold = nextBold;
    }
    if (nextColor !== prevColor) {
      out += nextColor;
      prevColor = nextColor;
    }
    out += ch;
    pos += 1;
  }
  return `${out}${RESET}`;
}

function styleRegularTierText(text: string, tier: string, colorLevel: ColorLevel): string {
  if (colorLevel === 'none') {
    return text;
  }
  if (tier === 'high') return `${YELLOW}${text}${RESET}`;
  if (tier === 'medium') return `${CYAN}${text}${RESET}`;
  return `${GRAY}${text}${RESET}`;
}

export function formatModelSegment(modelName: string, effort: string, options: ModelSegmentStyleOptions): string {
  const { colorLevel, active, nowSec } = options;
  const cleanName = sanitizeTerminalLabel(modelName);
  const cleanEffort = sanitizeTerminalLabel(effort).toLowerCase();
  if (cleanEffort.length === 0) {
    return colorLevel === 'none'
      ? `[${cleanName}]`
      : `${GRAY}[${BRIGHT_CYAN}${BOLD}${cleanName}${RESET}${GRAY}]${RESET}`;
  }

  const parts = cleanEffort.split('/');
  const peakFlags =
    options.peakFlags !== undefined && options.peakFlags.length === parts.length
      ? options.peakFlags
      : resolveEffortPeakFlags(cleanName, parts);
  const hasPeak = peakFlags.some(Boolean);
  const topTier = resolveTopEffortTier(parts);
  const hasMaxTier = parts.includes('max');
  const frame = active && Number.isFinite(nowSec) ? Math.floor((nowSec * 1000) / SHIMMER_FRAME_MS) : 0;
  const glyphIdx = ((frame % WORK_GLYPHS.length) + WORK_GLYPHS.length) % WORK_GLYPHS.length;
  const rawGlyph = active && !hasPeak ? (WORK_GLYPHS[glyphIdx] ?? '◑') : resolveTierGlyph(topTier, hasPeak);

  if (colorLevel === 'none') {
    return `[${cleanName} ${rawGlyph} ${cleanEffort}]`;
  }

  // Compact active coordinate space over visible peak tokens (glyph + peak effort parts only, skipping non-peak halves).
  let peakCharCount = hasPeak ? 1 : 0;
  const partStartPos: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (peakFlags[i] === true) {
      partStartPos.push(peakCharCount);
      peakCharCount += Array.from(part).length;
    } else {
      partStartPos.push(-1);
    }
  }

  const beamPos = active && hasPeak ? resolveBeamPosition(frame, peakCharCount, colorLevel) : null;
  const glyphTone = hasMaxTier ? MAX_PEAK_TONE : PLATINUM_PEAK_TONE;

  const styledGlyph = hasPeak
    ? renderPeakSpan(rawGlyph, 0, beamPos, glyphTone, colorLevel, true)
    : styleRegularTierText(rawGlyph, topTier, colorLevel);

  const styledParts: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    const startPos = partStartPos[i] ?? -1;
    if (startPos >= 0) {
      const partTone = part === 'max' ? MAX_PEAK_TONE : PLATINUM_PEAK_TONE;
      styledParts.push(renderPeakSpan(part, startPos, beamPos, partTone, colorLevel, false));
    } else {
      styledParts.push(styleRegularTierText(part, part, colorLevel));
    }
  }

  const styledEffort = styledParts.join(`${GRAY}/${RESET}`);
  return `${GRAY}[${BRIGHT_CYAN}${BOLD}${cleanName}${RESET} ${styledGlyph} ${styledEffort}${GRAY}]${RESET}`;
}
