import type { ConfigureHudOptions, ConfigureHudResult, ExportProfileOptions, ExportProfileResult, HudConfig, ImportProfileOptions, ImportProfileResult, RenderHudOptions, StatusLineData } from "./types.mjs";
export declare function configureHud(options?: ConfigureHudOptions): ConfigureHudResult;
export declare function exportProfile(options: ExportProfileOptions): ExportProfileResult;
export declare function importProfile(options: ImportProfileOptions): ImportProfileResult;
export declare const DEFAULT_HUD_CONFIG: HudConfig;
export declare function renderHudFromData(data: StatusLineData, options?: RenderHudOptions): string;
export * from "./types.mjs";
