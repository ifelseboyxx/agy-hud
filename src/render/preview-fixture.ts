import type {
  AgentsSummary,
  GitStatusInfo,
  HudConfig,
  SessionTelemetry,
  StatusLineData,
  TodoSummary,
  TranscriptActivity,
} from '../types.ts';
import { stripAnsi } from './ansi.ts';
import { detectColorLevel } from './effort-style.ts';
import { formatHudLines } from './format-hud.ts';
import { formatActivitySummarySnapshotTail, formatOsc8Overflow } from './osc8.ts';

const PREVIEW_NOW_SEC: number = 1_780_000_000;
const PREVIEW_OSC8_URI = 'file:///preview/agy-hud-snapshot.md';
const MIN_PREVIEW_WIDTH = 40;

export interface HudPreviewFixture {
  readonly data: StatusLineData;
  readonly telemetry: SessionTelemetry;
  readonly activity: TranscriptActivity;
  readonly agentsSummary: AgentsSummary;
  readonly todos: TodoSummary;
  readonly gitInfo: GitStatusInfo;
}

export interface RenderHudPreviewOptions {
  readonly width: number;
  readonly color: boolean;
}

function createHudPreviewFixture(termWidth: number): HudPreviewFixture {
  const reset5hIso = new Date((PREVIEW_NOW_SEC + 8_100) * 1000).toISOString();
  const reset7dIso = new Date((PREVIEW_NOW_SEC + 367_200) * 1000).toISOString();
  const reset3p7dIso = new Date((PREVIEW_NOW_SEC + 302_400) * 1000).toISOString();

  const data: StatusLineData = {
    model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', effort: 'high' },
    workspace: { current_dir: '/workspace/agy-hud', project_dir: '/workspace/agy-hud' },
    context_window: { used_percentage: 38, context_window_size: 1_048_576 },
    agent_state: 'idle',
    cost: { total_usd: 0.42, subagent_usd: 0.11, estimated: true },
    quota: {
      'gemini-5h': { remaining_fraction: 0.82, reset_time: reset5hIso },
      'gemini-weekly': { remaining_fraction: 0.91, reset_time: reset7dIso },
      '3p-5h': { remaining_fraction: 1.0 },
      '3p-weekly': { remaining_fraction: 0.96, reset_time: reset3p7dIso },
    },
    terminal_width: termWidth,
  };

  const telemetry: SessionTelemetry = {
    genCount: 12,
    tps: 94.2,
    ttft: 1.4,
    cachePct: 87,
    ctxUsed: 194_560,
    ctxMax: 512_000,
  };

  const activity: TranscriptActivity = {
    tools: [
      {
        name: 'read_file',
        disp: 'read_file',
        target: 'configure-tui.ts',
        fullTarget: 'src/cli/configure-tui.ts',
        running: true,
        isSkillRead: false,
      },
      { name: 'run_checks', disp: 'run_checks', target: 'test', running: false, isSkillRead: false },
      { name: 'run_checks', disp: 'run_checks', target: 'lint', running: false, isSkillRead: false },
      { name: 'edit_file', disp: 'edit_file', target: 'cli-entry.ts', running: false, isSkillRead: false },
      { name: 'batch_search', disp: 'batch_search', target: 'src/cli', running: false, isSkillRead: false },
    ],
    skills: ['tdd', 'codebase-design'],
    mcps: ['agy-fast', 'chrome-devtools'],
    agents: [],
  };

  const agentsSummary: AgentsSummary = {
    kind: 'swarm',
    working: 2,
    waiting: 0,
    alive: 2,
    total: 2,
    entries: [
      { name: 'Reviewer', type: 'review', model: 'Gemini 4 Flash', state: 'working', ts: PREVIEW_NOW_SEC - 15 },
      { name: 'Tester', type: 'test', model: 'Gemini 4 Flash', state: 'working', ts: PREVIEW_NOW_SEC - 8 },
      { name: 'Planner', type: 'plan', model: 'Gemini 4 Carbon', state: 'done', ts: PREVIEW_NOW_SEC - 25 },
    ],
  };

  const todos: TodoSummary = {
    total: 5,
    completed: 3,
    current: 'Wire configure -i TUI',
  };

  const gitInfo: GitStatusInfo = {
    branch: 'main',
    dirty: true,
    staged: 2,
    modified: 3,
    untracked: 1,
    ahead: 1,
    diffAdded: 48,
    diffDeleted: 12,
  };

  return { data, telemetry, activity, agentsSummary, todos, gitInfo };
}

export function renderHudPreviewLines(config: HudConfig, options: RenderHudPreviewOptions): string[] {
  const width = Math.max(MIN_PREVIEW_WIDTH, Math.floor(options.width));
  const fixture = createHudPreviewFixture(width);
  const lines = formatHudLines({
    data: fixture.data,
    config,
    cliSettings: {},
    telemetry: fixture.telemetry,
    activity: fixture.activity,
    agentsSummary: fixture.agentsSummary,
    todos: fixture.todos,
    termWidth: width,
    nowSec: PREVIEW_NOW_SEC,
    colorLevel: options.color ? detectColorLevel(process.env) : 'none',
    modeOptions: { bypass: false, cliMode: 'plan' },
    identityOptions: {
      gitInfo: fixture.gitInfo,
      branch: fixture.gitInfo.branch,
      dirty: fixture.gitInfo.dirty,
      elapsedSeconds: 754,
      nowSec: PREVIEW_NOW_SEC,
    },
    ...(config.osc8Links
      ? {
          activityLineOptions: {
            formatOverflow: (hiddenCount) => formatOsc8Overflow(hiddenCount, PREVIEW_OSC8_URI),
          },
          formatActivitySummaryTail: (remainingCols) =>
            formatActivitySummarySnapshotTail(remainingCols, PREVIEW_OSC8_URI),
        }
      : {}),
  });
  return options.color ? lines : lines.map((line) => stripAnsi(line));
}
