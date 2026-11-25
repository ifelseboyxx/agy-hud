export { runHudRender as renderHudLines, type HudCollectorOverrides, type RenderHudOptions } from '../hud-runner.ts';
export { type ActivityLineFormatOptions, formatNamesLine, formatTodosLine, formatToolsLine } from './activity-lines.ts';
export { formatHudLines, resolveEffectiveExceeds200k, type FormatHudLinesInput } from './format-hud.ts';
export {
  buildIdentityLine,
  buildModeLine,
  buildUsageLine,
  formatActivitySummaryLine,
  formatQuotaItem,
  hasAnyActivityLine,
  LINE_MODULE_REGISTRY,
  resolveContextPct,
  type ActivitySummaryInput,
  type HudModuleRenderContext,
  type IdentityLineOptions,
  type LineModuleRenderer,
  type ModeLineOptions,
} from './modules.ts';
