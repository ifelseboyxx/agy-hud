import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainEntry } from '../src/core/fs-utils.ts';
import { DEFAULT_HUD_CONFIG } from '../src/core/hud-config.ts';
import { formatHudLines } from '../src/render/format-hud.ts';
import { formatActivitySummarySnapshotTail, formatOsc8Overflow } from '../src/render/osc8.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT_PNG = path.join(REPO_ROOT, 'assets', 'preview.png');
const PREVIEW_TERM_WIDTH = 140;
const PREVIEW_OSC8_URI = 'file:///preview/agy-hud-snapshot.md';
const PREVIEW_BASE_SEC = 1_780_000_000.0;
const VIEWPORT_WIDTH = 980;
const VIEWPORT_HEIGHT = 504;
const ANSI_TOKEN_RE = new RegExp(
  `${String.fromCharCode(0x1b)}\\]8;;([^\\x07\\x1b]*)(?:\\x07|${String.fromCharCode(0x1b)}\\\\)|${String.fromCharCode(0x1b)}\\[([0-9;]*)m|([^${String.fromCharCode(0x1b)}]+)`,
  'g',
);

const ANSI_PALETTE: Readonly<Record<number, string>> = {
  30: '#484f58',
  31: '#ff7b72',
  32: '#3fb950',
  33: '#d29922',
  34: '#58a6ff',
  35: '#bc8cff',
  36: '#39c5cf',
  37: '#c9d1d9',
  90: '#7d8590',
  91: '#ff7b72',
  92: '#56d364',
  93: '#e3b341',
  94: '#79c0ff',
  95: '#d2a8ff',
  96: '#56d4dd',
  97: '#f0f6fc',
};

function renderPreviewHudLines(nowSec: number): string[] {
  const reset5h = new Date((nowSec + (3 * 3600 + 14 * 60)) * 1000).toISOString();
  const reset7d = new Date((nowSec + (4 * 86400 + 6 * 3600)) * 1000).toISOString();
  const reset3p7d = new Date((nowSec + (3 * 86400 + 12 * 3600)) * 1000).toISOString();

  return formatHudLines({
    data: {
      model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', effort: 'high' },
      workspace: { current_dir: '/Users/dev/agy-hud', project_dir: '/Users/dev/agy-hud' },
      context_window: { used_percentage: 48, context_window_size: 1_048_576 },
      agent_state: 'working',
      cost: { total_usd: 0.185, estimated: true },
      task_count: 1,
      quota: {
        'gemini-5h': { remaining_fraction: 0.92, reset_time: reset5h },
        'gemini-weekly': { remaining_fraction: 0.88, reset_time: reset7d },
        '3p-5h': { remaining_fraction: 1.0 },
        '3p-weekly': { remaining_fraction: 0.96, reset_time: reset3p7d },
      },
      terminal_width: PREVIEW_TERM_WIDTH,
    },
    config: {
      ...DEFAULT_HUD_CONFIG,
      costCurrency: 'both',
      osc8Links: true,
    },
    cliSettings: {},
    telemetry: {
      genCount: 14,
      tps: 86.4,
      ttft: 1.6,
      cachePct: 94,
      ctxUsed: 245_760,
      ctxMax: 512_000,
    },
    activity: {
      tools: [
        { name: 'Edit', disp: 'Edit', target: 'lines.ts', running: true, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'hud-config.ts', running: false, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'modules.ts', running: false, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'quota.ts', running: false, isSkillRead: false },
        { name: 'Read', disp: 'Read', target: 'ansi.ts', running: false, isSkillRead: false },
        { name: 'Grep', disp: 'Grep', target: 'statusLine', running: false, isSkillRead: false },
        { name: 'Grep', disp: 'Grep', target: 'osc8', running: false, isSkillRead: false },
        { name: 'RunChecks', disp: 'RunChecks', target: 'verify', running: false, isSkillRead: false },
        { name: 'RunChecks', disp: 'RunChecks', target: 'dist:check', running: false, isSkillRead: false },
        { name: 'BatchSearch', disp: 'BatchSearch', target: 'src/render', running: false, isSkillRead: false },
        { name: 'WriteFile', disp: 'WriteFile', target: 'cache-registry.ts', running: false, isSkillRead: false },
        { name: 'GitStatus', disp: 'GitStatus', target: 'main', running: false, isSkillRead: false },
        { name: 'ValidateAst', disp: 'ValidateAst', target: 'architecture', running: false, isSkillRead: false },
        { name: 'CheckEnv', disp: 'CheckEnv', target: 'node', running: false, isSkillRead: false },
      ],
      skills: ['hud'],
      mcps: ['filesystem'],
      agents: [],
    },
    agentsSummary: {
      kind: 'swarm',
      working: 1,
      waiting: 1,
      alive: 2,
      total: 2,
      entries: [
        { name: 'coder', type: 'code', model: 'Gemini 4 Carbon', state: 'working', ts: nowSec - 12 },
        { name: 'reviewer', type: 'review', model: 'Gemini 4 Flash', state: 'waiting', ts: nowSec - 30 },
      ],
    },
    todos: {
      total: 4,
      completed: 2,
      current: 'Verify statusLine rollback guards',
      taskCount: 1,
    },
    termWidth: PREVIEW_TERM_WIDTH,
    nowSec,
    colorLevel: 'truecolor',
    modeOptions: { bypass: false, cliMode: 'accept-edits' },
    identityOptions: {
      gitInfo: {
        branch: 'main',
        dirty: true,
        staged: 2,
        modified: 3,
        untracked: 1,
        ahead: 1,
        diffAdded: 48,
        diffDeleted: 12,
      },
      branch: 'main',
      dirty: true,
      elapsedSeconds: 720,
      nowSec,
    },
    activityLineOptions: {
      formatOverflow: (hiddenCount: number) => formatOsc8Overflow(hiddenCount, PREVIEW_OSC8_URI),
    },
    formatActivitySummaryTail: (remainingCols: number) =>
      formatActivitySummarySnapshotTail(remainingCols, PREVIEW_OSC8_URI),
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function ansiToHtml(input: string): string {
  let color: string | null = null;
  let bold = false;
  let inLink = false;
  let out = '';

  ANSI_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_TOKEN_RE.exec(input)) !== null) {
    if (match[1] !== undefined) {
      inLink = match[1].length > 0;
    } else if (match[2] !== undefined) {
      const codes = match[2] === '' ? [0] : match[2].split(';').map((n) => Number.parseInt(n, 10));
      for (let i = 0; i < codes.length; i += 1) {
        const c = codes[i];
        if (c === undefined || c === 0) {
          color = null;
          bold = false;
        } else if (c === 1) {
          bold = true;
        } else if (c === 22) {
          bold = false;
        } else if (c === 38 && codes[i + 1] === 2 && i + 4 < codes.length) {
          color = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
          i += 4;
        } else if (ANSI_PALETTE[c] !== undefined) {
          color = ANSI_PALETTE[c];
        }
      }
    } else if (match[3] !== undefined) {
      const text = escapeHtml(match[3]);
      const styles: string[] = [];
      if (color !== null) styles.push(`color:${color}`);
      if (bold) styles.push('font-weight:700');
      if (inLink) {
        styles.push('text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgba(125,133,144,0.7)');
      }
      out += styles.length > 0 ? `<span style="${styles.join(';')}">${text}</span>` : text;
    }
  }
  return out;
}

export function buildPreviewHtml(): string {
  const lines = renderPreviewHudLines(PREVIEW_BASE_SEC);
  const hudHtml = lines.map((line) => `<div class="hud-line">${ansiToHtml(line)}</div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${VIEWPORT_WIDTH}px;
    height: ${VIEWPORT_HEIGHT}px;
    overflow: hidden;
    background: #0d1117;
    color: #e6edf3;
    font-family: "SF Mono", "JetBrains Mono", Menlo, Monaco, "Cascadia Mono", Consolas, monospace;
    -webkit-font-smoothing: antialiased;
  }
  .window {
    width: ${VIEWPORT_WIDTH}px;
    height: ${VIEWPORT_HEIGHT}px;
    display: flex;
    flex-direction: column;
    background: #0d1117;
    border: 1px solid #30363d;
  }
  .titlebar {
    height: 35px;
    background: #161b22;
    border-bottom: 1px solid #21262d;
    display: flex;
    align-items: center;
    padding: 0 14px;
    position: relative;
    flex-shrink: 0;
  }
  .dots { display: flex; gap: 8px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .dot.red { background: #ff5f56; }
  .dot.yellow { background: #ffbd2e; }
  .dot.green { background: #27c93f; }
  .title {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    font-size: 12px;
    color: #7d8590;
    letter-spacing: 0.2px;
  }
  .body {
    flex: 1;
    padding: 22px 24px 20px 24px;
    display: flex;
    flex-direction: column;
  }
  .cli-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
  .logo-svg { width: 52px; height: 47px; flex-shrink: 0; }
  .cli-meta { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.48; }
  .cli-title { color: #f0f6fc; font-weight: 700; font-size: 13px; }
  .cli-model { color: #c9d1d9; }
  .cli-dir { color: #7d8590; }
  .convo { display: flex; flex-direction: column; gap: 9px; font-size: 12px; line-height: 1.52; margin-bottom: 22px; }
  .user-msg { color: #f0f6fc; }
  .chevron { color: #56d4dd; font-weight: 700; margin-right: 6px; }
  .thought { color: #7d8590; font-size: 11.5px; }
  .reply { color: #c9d1d9; display: flex; flex-direction: column; gap: 4px; }
  .ok { color: #56d364; font-weight: 700; }
  .code { color: #79c0ff; }
  .bullet { color: #7d8590; margin-right: 6px; }
  .prompt-area { margin-top: auto; }
  .prompt-box {
    border-top: 1px solid #262c36;
    border-bottom: 1px solid #262c36;
    padding: 9px 2px;
    font-size: 12.5px;
    display: flex;
    align-items: center;
    margin-bottom: 10px;
  }
  .cursor { display: inline-block; width: 7px; height: 14px; background: #8b949e; vertical-align: middle; }
  .hud { font-size: 11px; line-height: 1.72; letter-spacing: -0.05px; }
  .hud-line { white-space: pre; overflow: hidden; text-overflow: clip; }
</style>
</head>
<body>
  <div class="window">
    <div class="titlebar">
      <div class="dots"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></div>
      <div class="title">agy – ~/agy-hud</div>
    </div>
    <div class="body">
      <div>
        <div class="cli-header">
          <svg class="logo-svg" viewBox="0 0 11 9" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
            <rect x="4" y="0" width="3" height="1" fill="#4285F4"/>
            <rect x="3" y="1" width="5" height="1" fill="#4285F4"/>
            <rect x="2" y="2" width="3" height="1" fill="#4285F4"/>
            <rect x="6" y="2" width="3" height="1" fill="#34A853"/>
            <rect x="2" y="3" width="2" height="1" fill="#4285F4"/>
            <rect x="7" y="3" width="2" height="1" fill="#34A853"/>
            <rect x="1" y="4" width="3" height="1" fill="#EA4335"/>
            <rect x="7" y="4" width="3" height="1" fill="#34A853"/>
            <rect x="1" y="5" width="9" height="1" fill="#FBBC05"/>
            <rect x="1" y="6" width="2" height="1" fill="#EA4335"/>
            <rect x="8" y="6" width="2" height="1" fill="#34A853"/>
            <rect x="0" y="7" width="3" height="1" fill="#EA4335"/>
            <rect x="8" y="7" width="3" height="1" fill="#34A853"/>
            <rect x="0" y="8" width="2" height="1" fill="#EA4335"/>
            <rect x="9" y="8" width="2" height="1" fill="#34A853"/>
          </svg>
          <div class="cli-meta">
            <div class="cli-title">Antigravity CLI</div>
            <div class="cli-model">Gemini 4 Carbon (High)</div>
            <div class="cli-dir">~/agy-hud</div>
          </div>
        </div>
        <div class="convo">
          <div class="user-msg"><span class="chevron">&gt;</span>Verify statusLine rollback guards and summarize the HUD checks</div>
          <div class="thought">&#x25B8; Thought for 4s &middot; ran pnpm verify</div>
          <div class="reply">
            <div><span class="ok">All checks passed</span> (<span class="code">oxlint</span>, <span class="code">oxfmt</span>, <span class="code">tsc</span>, <span class="code">vite build</span>, <span class="code">dist:check</span>, <span class="code">node --test</span>, <span class="code">architecture guardrails</span>).</div>
            <div><span class="bullet">&bull;</span>Ownership guard verified for <span class="code">off</span> and <span class="code">uninstall --restore-statusline</span></div>
            <div><span class="bullet">&bull;</span>Atomic rollback, pure render closure, and read-only SQLite isolation verified</div>
          </div>
        </div>
      </div>
      <div class="prompt-area">
        <div class="prompt-box"><span class="chevron">&gt;</span><span class="cursor"></span></div>
        <div class="hud">${hudHtml}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function resolveChromeBinary(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find Chrome/Chromium binary. Set CHROME_PATH to your Chrome executable.');
}

function runRenderPreviewPng(outputPath: string = DEFAULT_OUTPUT_PNG): void {
  const chromeBin = resolveChromeBinary();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agy-hud-preview-'));
  try {
    const htmlPath = path.join(tmpDir, 'preview.html');
    writeFileSync(htmlPath, buildPreviewHtml(), 'utf8');
    execFileSync(
      chromeBin,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
        `--screenshot=${outputPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { stdio: 'pipe', windowsHide: true },
    );
    process.stdout.write(`[OK] Rendered ${path.relative(REPO_ROOT, outputPath)}\n`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const outArg = process.argv.slice(2).filter((arg) => arg !== '--')[0];
  runRenderPreviewPng(outArg ? path.resolve(outArg) : DEFAULT_OUTPUT_PNG);
}
