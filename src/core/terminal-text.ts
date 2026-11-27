// Construct control characters dynamically so oxlint no-control-regex stays clean.
const ESC_CHAR = String.fromCharCode(0x1b);
const BEL_CHAR = String.fromCharCode(0x07);
const C1_DCS_CHAR = String.fromCharCode(0x90);
const C1_SOS_CHAR = String.fromCharCode(0x98);
const C1_CSI_CHAR = String.fromCharCode(0x9b);
const C1_ST_CHAR = String.fromCharCode(0x9c);
const C1_OSC_CHAR = String.fromCharCode(0x9d);
const C1_PM_CHAR = String.fromCharCode(0x9e);
const C1_APC_CHAR = String.fromCharCode(0x9f);

const OSC_TERMINATOR = `(?:${BEL_CHAR}|${ESC_CHAR}\\\\|${C1_ST_CHAR}|$)`;
const STRING_TERMINATOR = `(?:${ESC_CHAR}\\\\|${C1_ST_CHAR}|$)`;
const C1_STRING_INTRO = `[${C1_DCS_CHAR}${C1_SOS_CHAR}${C1_PM_CHAR}${C1_APC_CHAR}]`;

const TERMINAL_ESCAPE_RE = new RegExp(
  `(?:${ESC_CHAR}(?:\\[[0-?]*[ -/]*[@-~]?|\\][\\s\\S]*?${OSC_TERMINATOR}|[PX^_][\\s\\S]*?${STRING_TERMINATOR}|[@-Z\\\\-_])|${C1_CSI_CHAR}[0-?]*[ -/]*[@-~]?|${C1_OSC_CHAR}[\\s\\S]*?${OSC_TERMINATOR}|${C1_STRING_INTRO}[\\s\\S]*?${STRING_TERMINATOR})`,
  'g',
);

function isBidiFormatControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x206f)
  );
}

export function hasAsciiControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function hasC0C1ControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export function hasTerminalControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      isBidiFormatControl(code)
    ) {
      return true;
    }
  }
  return false;
}

export function isColorDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined) return true;
  if (env.TERM?.trim().toLowerCase() === 'dumb') return true;
  return false;
}

export function shouldUseTerminalColor(noColorFlag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !noColorFlag && !isColorDisabledByEnv(env);
}

export function sanitizeTerminalText(text: string): string {
  const stripped = text.replace(TERMINAL_ESCAPE_RE, '');
  let out = '';
  let prevSpace = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const code = stripped.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      if (!prevSpace) {
        out += ' ';
        prevSpace = true;
      }
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || isBidiFormatControl(code)) {
      continue;
    }
    out += stripped[i] ?? '';
    prevSpace = code === 0x20;
  }
  return out;
}

export function sanitizeTerminalLabel(text: string): string {
  return sanitizeTerminalText(text).trim();
}
